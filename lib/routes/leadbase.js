// Base de leads em escala (planilhas importadas): filtros paginados, busca de contatos na web
// e envio em lote ao funil.
const { query, withTransaction } = require("../db");
const { HttpError } = require("../http");
const { audit } = require("../audit");
const { findPipeline, findStage } = require("./pipelines");
const { optText, reqUuid, optUuid } = require("../validate");
const { nextPosition, logActivity } = require("../crm");
const { discoverCompany } = require("../discovery");
const { enrollCreated } = require("../cadence-bulk");

const PAGE_SIZE = 50;
const MAX_BATCH = 200;
const MANAGERS = ["admin", "gestor"];

// Monta WHERE a partir dos filtros da tela de Leads.
function buildFilter(user, qs) {
  const params = [user.organizationId];
  const where = ["c.organization_id = $1"];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replaceAll("?", `$${params.length}`));
  };
  const q = optText(qs.get("q"), "q", 100);
  if (q) add("(lower(c.name) LIKE ? OR coalesce(c.cnpj, '') LIKE ? OR lower(coalesce(c.segment, '')) LIKE ?)", `%${q.toLowerCase()}%`);
  const city = optText(qs.get("city"), "city", 120);
  if (city) add("c.city = ?", city);
  const size = qs.get("size");
  if (["micro", "pequeno", "demais"].includes(size)) add("c.size = ?", size);
  const minEmp = Number(qs.get("minEmployees"));
  if (Number.isFinite(minEmp) && minEmp > 0) add("c.employees >= ?", minEmp);
  const maxEmp = Number(qs.get("maxEmployees"));
  if (Number.isFinite(maxEmp) && maxEmp > 0) add("c.employees <= ?", maxEmp);
  const list = optText(qs.get("list"), "list", 120);
  if (list) add("? = ANY(c.lists)", list);
  const contact = qs.get("contact");
  if (contact === "with") where.push("EXISTS (SELECT 1 FROM contacts x WHERE x.company_id = c.id AND x.email IS NOT NULL AND NOT x.opt_out)");
  if (contact === "without") where.push("NOT EXISTS (SELECT 1 FROM contacts x WHERE x.company_id = c.id AND x.email IS NOT NULL)");
  const disc = qs.get("discovered");
  if (disc === "yes") where.push("c.discovered_at IS NOT NULL");
  if (disc === "no") where.push("c.discovered_at IS NULL");
  const inPipe = qs.get("inPipeline");
  if (inPipe === "yes") where.push("EXISTS (SELECT 1 FROM deals d WHERE d.company_id = c.id)");
  if (inPipe === "no") where.push("NOT EXISTS (SELECT 1 FROM deals d WHERE d.company_id = c.id)");
  return { where: where.join(" AND "), params };
}

const ORDERS = {
  recent: "c.created_at DESC",
  priority: "c.priority DESC NULLS LAST, c.employees DESC NULLS LAST",
  employees: "c.employees DESC NULLS LAST",
  name: "c.name",
};

async function list({ user, query: qs }) {
  const { where, params } = buildFilter(user, qs);
  const page = Math.max(1, Math.min(1000, Number(qs.get("page")) || 1));
  const order = ORDERS[qs.get("order")] || ORDERS.recent;
  const [{ rows }, { rows: count }] = await Promise.all([
    query(
      `SELECT c.id, c.name, c.cnpj, c.segment, c.city, c.uf, c.source, c.source_detail, c.created_at, c.enriched_at,
              c.registration_status, c.employees, c.priority, c.lists, c.size, c.website, c.discovered_at,
              (c.discovery->>'costUsd')::numeric AS discovery_cost, c.discovery->'findings'->>'confidence' AS confidence,
              (SELECT count(*)::int FROM contacts ct WHERE ct.company_id = c.id) AS contacts,
              (SELECT count(*)::int FROM contacts ct WHERE ct.company_id = c.id AND ct.email IS NOT NULL AND NOT ct.opt_out) AS emails,
              (SELECT count(*)::int FROM deals d WHERE d.company_id = c.id) AS deals
       FROM companies c WHERE ${where} ORDER BY ${order} LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
      params
    ),
    query(`SELECT count(*)::int AS n FROM companies c WHERE ${where}`, params),
  ]);
  return {
    ok: true,
    total: count[0].n,
    page,
    pageSize: PAGE_SIZE,
    companies: rows.map((r) => ({
      id: r.id, name: r.name, cnpj: r.cnpj, segment: r.segment, city: r.city, uf: r.uf, source: r.source, sourceDetail: r.source_detail,
      createdAt: r.created_at, enrichedAt: r.enriched_at, registrationStatus: r.registration_status, employees: r.employees,
      priority: r.priority === null ? null : Number(r.priority), lists: r.lists, size: r.size, website: r.website,
      discoveredAt: r.discovered_at, confidence: r.confidence, discoveryCost: r.discovery_cost === null ? null : Number(r.discovery_cost),
      contacts: r.contacts, emails: r.emails, deals: r.deals,
    })),
  };
}

async function facets({ user }) {
  const [{ rows: cities }, { rows: lists }] = await Promise.all([
    query(`SELECT city, count(*)::int AS n FROM companies WHERE organization_id = $1 AND city IS NOT NULL GROUP BY city ORDER BY n DESC LIMIT 200`, [user.organizationId]),
    query(`SELECT l AS list, count(*)::int AS n FROM companies, unnest(lists) AS l WHERE organization_id = $1 GROUP BY l ORDER BY l`, [user.organizationId]),
  ]);
  return { ok: true, cities, lists };
}

async function discoverOne({ user, params, ip }) {
  const r = await discoverCompany(user.organizationId, params.id);
  await audit({ organizationId: user.organizationId, userId: user.id, action: "company_discovered", entity: "company", entityId: params.id, details: r, ip });
  return { ok: true, result: r };
}

// Ids explícitos (seleção na tela). Valida que pertencem à organização.
async function idsFrom(user, body) {
  const ids = (Array.isArray(body.companyIds) ? body.companyIds : []).map((id) => reqUuid(id, "company_id"));
  if (!ids.length) throw new HttpError(400, "missing_rows");
  if (ids.length > MAX_BATCH) throw new HttpError(400, "too_many_rows");
  const { rows } = await query(`SELECT id, name FROM companies WHERE organization_id = $1 AND id = ANY($2)`, [user.organizationId, ids]);
  return rows;
}

async function toPipeline({ user, body, ip }) {
  const pipelineId = reqUuid(body.pipelineId, "pipeline_id");
  const stageId = reqUuid(body.stageId, "stage_id");
  await findPipeline(user, pipelineId);
  const stage = await findStage(user, stageId);
  if (stage.pipeline_id !== pipelineId) throw new HttpError(400, "invalid_stage_id");
  const agentId = optUuid(body.agentId, "agent_id");
  if (agentId) {
    const a = await query(`SELECT 1 FROM agents WHERE id = $1 AND organization_id = $2`, [agentId, user.organizationId]);
    if (!a.rowCount) throw new HttpError(400, "invalid_agent");
  }
  const companies = await idsFrom(user, body);
  const result = { created: 0, alreadyInPipeline: 0 };
  const createdDeals = [];
  await withTransaction(async (db) => {
    let position = await nextPosition(db, stageId);
    for (const c of companies) {
      const exists = await db.query(`SELECT 1 FROM deals WHERE pipeline_id = $1 AND company_id = $2`, [pipelineId, c.id]);
      if (exists.rowCount) {
        result.alreadyInPipeline++;
        continue;
      }
      const best = await db.query(
        `SELECT id FROM contacts WHERE company_id = $1 AND email IS NOT NULL AND NOT opt_out ORDER BY (kind = 'person') DESC, created_at LIMIT 1`,
        [c.id]
      );
      const { rows } = await db.query(
        `INSERT INTO deals (organization_id, pipeline_id, stage_id, company_id, contact_id, owner_id, agent_id, title, position, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $6) RETURNING id`,
        [user.organizationId, pipelineId, stageId, c.id, best.rows[0]?.id || null, user.id, agentId, c.name, position]
      );
      position += 1024;
      await logActivity(db, { orgId: user.organizationId, dealId: rows[0].id, companyId: c.id, userId: user.id, type: "sourced", meta: { source: "base", detail: "Base de leads" } });
      createdDeals.push(rows[0].id);
      result.created++;
    }
  });
  if (body.startCadence && agentId) result.cadence = await enrollCreated(user, createdDeals);
  await audit({ organizationId: user.organizationId, userId: user.id, action: "companies_to_pipeline", entity: "pipeline", entityId: pipelineId, details: result, ip });
  return { ok: true, ...result };
}

module.exports = [
  { method: "GET", path: "/leadbase", handler: list },
  { method: "GET", path: "/leadbase/facets", handler: facets },
  { method: "POST", path: "/leadbase/to-pipeline", handler: toPipeline, roles: MANAGERS },
  { method: "POST", path: "/companies/:id/discover", handler: discoverOne, roles: MANAGERS },
];
