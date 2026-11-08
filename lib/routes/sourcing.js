// Captação de leads: busca na base pública de CNPJ e no Google Maps, envio ao funil e enriquecimento.
const { query, withTransaction } = require("../db");
const { HttpError } = require("../http");
const { audit } = require("../audit");
const { findPipeline, findStage } = require("./pipelines");
const { optText, reqText, reqUuid, optUuid, optUf } = require("../validate");
const { cleanCompany, nextPosition, logActivity } = require("../crm");
const { searchPlaces, placesConfigured } = require("../places");
const { enrichCompany, titleCase, PORTE_LABEL } = require("../enrich");
const { enrollCreated } = require("../cadence-bulk");
const { sectorFromCnae } = require("../sector");

const PAGE_SIZE = 50;
const MAX_IMPORT = 200;
const PORTES = ["micro", "pequeno", "demais", "nao_informado"];

async function status() {
  const { rows } = await query(
    `SELECT (SELECT count(*)::int FROM cnpj_establishments) AS rows,
            (SELECT coalesce(array_agg(DISTINCT uf ORDER BY uf), '{}') FROM cnpj_establishments) AS ufs,
            (SELECT count(*)::int FROM cnaes) AS cnaes,
            (SELECT max(finished_at) FROM cnpj_loads) AS last_load`
  );
  const r = rows[0];
  return { ok: true, cnpjBase: { rows: r.rows, ufs: r.ufs, cnaes: r.cnaes, lastLoad: r.last_load }, placesConfigured: placesConfigured() };
}

async function cnaes({ query: qs }) {
  const q = optText(qs.get("q"), "q", 80);
  if (!q) return { ok: true, cnaes: [] };
  const digits = q.replace(/\D/g, "");
  const { rows } = await query(
    `SELECT code, description FROM cnaes
     WHERE ${digits.length >= 2 ? "code LIKE $1 || '%'" : "description ILIKE '%' || $1 || '%'"}
     ORDER BY code LIMIT 30`,
    [digits.length >= 2 ? digits : q]
  );
  return { ok: true, cnaes: rows };
}

async function municipios({ query: qs }) {
  const uf = optUf(qs.get("uf"));
  if (!uf) return { ok: true, municipios: [] };
  const { rows } = await query(
    `SELECT municipio, count(*)::int AS n FROM cnpj_establishments WHERE uf = $1 AND municipio IS NOT NULL
     GROUP BY municipio ORDER BY municipio`,
    [uf]
  );
  return { ok: true, municipios: rows.map((r) => ({ name: titleCase(r.municipio), value: r.municipio, count: r.n })) };
}

function list(qs, key) {
  return (qs.get(key) || "").split(",").map((s) => s.trim()).filter(Boolean);
}

async function searchCnpj({ user, query: qs }) {
  const where = [];
  const params = [user.organizationId];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  const uf = optUf(qs.get("uf"));
  if (uf) add("e.uf = ?", uf);
  const mun = optText(qs.get("municipio"), "municipio", 120);
  if (mun) add("e.municipio = ?", mun.toUpperCase());
  const prefixes = list(qs, "cnae").map((c) => c.replace(/\D/g, "")).filter(Boolean);
  if (prefixes.length) add("e.cnae_principal LIKE ANY(?)", prefixes.map((p) => `${p}%`));
  const portes = list(qs, "porte").filter((p) => PORTES.includes(p));
  if (portes.length) add("e.porte = ANY(?)", portes);
  const q = optText(qs.get("q"), "q", 100);
  if (q) {
    params.push(`%${q}%`);
    where.push(`(e.nome_fantasia ILIKE $${params.length} OR e.razao_social ILIKE $${params.length})`);
  }
  if (qs.get("hasEmail") === "1") where.push("e.email IS NOT NULL");
  if (qs.get("hasPhone") === "1") where.push("e.telefone IS NOT NULL");
  if (qs.get("matriz") === "1") where.push("e.is_matriz");
  if (qs.get("notInBase") === "1") where.push("co.id IS NULL");
  if (!uf && !prefixes.length && !q) throw new HttpError(400, "missing_filters");

  const page = Math.max(1, Math.min(200, Number(qs.get("page")) || 1));
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const from = `FROM cnpj_establishments e
     LEFT JOIN cnaes cn ON cn.code = e.cnae_principal
     LEFT JOIN companies co ON co.organization_id = $1 AND co.cnpj = e.cnpj`;
  const [{ rows }, { rows: count }] = await Promise.all([
    query(
      `SELECT e.cnpj, e.razao_social, e.nome_fantasia, e.cnae_principal, cn.description AS cnae_description, e.porte,
              e.municipio, e.uf, e.telefone, e.email, e.data_inicio, e.capital_social, e.is_matriz, co.id AS company_id
       ${from} ${whereSql}
       ORDER BY e.capital_social DESC NULLS LAST, e.cnpj
       LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
      params
    ),
    query(`SELECT count(*)::int AS n ${from} ${whereSql}`, params),
  ]);
  return {
    ok: true,
    total: count[0].n,
    page,
    pageSize: PAGE_SIZE,
    results: rows.map((r) => ({
      cnpj: r.cnpj,
      name: r.nome_fantasia || r.razao_social,
      legalName: r.razao_social,
      cnae: r.cnae_principal,
      cnaeDescription: r.cnae_description,
      size: r.porte,
      sizeLabel: PORTE_LABEL[r.porte] || null,
      city: r.municipio ? titleCase(r.municipio) : null,
      uf: r.uf,
      phone: r.telefone,
      email: r.email,
      openedAt: r.data_inicio,
      capital: r.capital_social === null ? null : Number(r.capital_social),
      isMatriz: r.is_matriz,
      inBase: Boolean(r.company_id),
    })),
  };
}

async function places({ user, query: qs, ip }) {
  const q = reqText(qs.get("q"), "q", 200);
  const r = await searchPlaces(q, optText(qs.get("pageToken"), "page_token", 2000));
  const ids = r.results.map((p) => p.placeId);
  const { rows } = await query(
    `SELECT external_ids->>'places' AS pid FROM companies WHERE organization_id = $1 AND external_ids->>'places' = ANY($2)`,
    [user.organizationId, ids]
  );
  const inBase = new Set(rows.map((x) => x.pid));
  await audit({ organizationId: user.organizationId, userId: user.id, action: "places_search", details: { q, results: r.results.length }, ip });
  return { ok: true, ...r, results: r.results.map((p) => ({ ...p, inBase: inBase.has(p.placeId) })) };
}

// Cria empresa (+ contato geral, se houver e-mail) e card. Retorna "created" | "exists".
async function addToPipeline(db, user, { company, extra, externalIds, contactEmail, source, sourceDetail }, pipelineId, stageId, agentId, position) {
  let existing = null;
  if (company.cnpj) {
    existing = (await db.query(`SELECT id FROM companies WHERE organization_id = $1 AND cnpj = $2`, [user.organizationId, company.cnpj])).rows[0];
  } else if (externalIds.places) {
    existing = (await db.query(`SELECT id FROM companies WHERE organization_id = $1 AND external_ids->>'places' = $2`, [user.organizationId, externalIds.places])).rows[0];
  }
  let companyId = existing?.id;
  if (!companyId) {
    const { rows } = await db.query(
      `INSERT INTO companies (organization_id, name, cnpj, website, segment, city, uf, phone, source, source_detail, created_by,
                              legal_name, cnae_code, size, registration_status, opened_at, external_ids, enrichment, enriched_at, sector)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, CASE WHEN $18::jsonb IS NULL THEN NULL ELSE now() END, $19)
       RETURNING id`,
      [user.organizationId, company.name, company.cnpj, company.website, company.segment, company.city, company.uf, company.phone,
        source, sourceDetail, user.id, extra.legalName || null, extra.cnaeCode || null, extra.size || null, extra.status || null,
        extra.openedAt || null, externalIds, extra.enrichment || null,
        extra.cnaeCode ? await sectorFromCnae(db, extra.cnaeCode) : company.sector || null]
    );
    companyId = rows[0].id;
  }
  const inPipeline = await db.query(`SELECT 1 FROM deals WHERE pipeline_id = $1 AND company_id = $2`, [pipelineId, companyId]);
  if (inPipeline.rowCount) return "exists";

  let contactId = null;
  if (contactEmail) {
    const ct = await db.query(`SELECT id FROM contacts WHERE organization_id = $1 AND lower(email) = $2`, [user.organizationId, contactEmail]);
    contactId = ct.rows[0]?.id;
    if (!contactId) {
      const ins = await db.query(
        `INSERT INTO contacts (organization_id, company_id, name, email, source, source_detail)
         VALUES ($1, $2, 'Contato geral', $3, $4, $5) RETURNING id`,
        [user.organizationId, companyId, contactEmail, source, sourceDetail]
      );
      contactId = ins.rows[0].id;
    }
  }
  const { rows: deal } = await db.query(
    `INSERT INTO deals (organization_id, pipeline_id, stage_id, company_id, contact_id, owner_id, agent_id, title, position, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $6) RETURNING id`,
    [user.organizationId, pipelineId, stageId, companyId, contactId, user.id, agentId, company.name, position]
  );
  await logActivity(db, { orgId: user.organizationId, dealId: deal[0].id, companyId, userId: user.id, type: "sourced", meta: { source, detail: sourceDetail } });
  return deal[0].id;
}

async function importLeads({ user, body, ip }) {
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

  let items = [];
  if (body.source === "cnpj") {
    const cnpjs = (Array.isArray(body.cnpjs) ? body.cnpjs : []).map((c) => String(c).replace(/\D/g, "")).filter((c) => c.length === 14);
    if (!cnpjs.length) throw new HttpError(400, "missing_rows");
    if (cnpjs.length > MAX_IMPORT) throw new HttpError(400, "too_many_rows");
    const { rows } = await query(
      `SELECT e.*, cn.description AS cnae_description FROM cnpj_establishments e LEFT JOIN cnaes cn ON cn.code = e.cnae_principal WHERE e.cnpj = ANY($1)`,
      [cnpjs]
    );
    items = rows.map((r) => ({
      company: cleanCompany({
        name: (r.nome_fantasia || r.razao_social || r.cnpj).slice(0, 200),
        cnpj: r.cnpj,
        segment: r.cnae_description?.slice(0, 120),
        city: r.municipio ? titleCase(r.municipio) : null,
        uf: r.uf,
        phone: r.telefone,
      }),
      extra: {
        legalName: r.razao_social, cnaeCode: r.cnae_principal, size: r.porte, status: r.situacao, openedAt: r.data_inicio,
        enrichment: { source: "receita_local", capital: r.capital_social === null ? null : Number(r.capital_social), cnaeDescription: r.cnae_description },
      },
      externalIds: {},
      contactEmail: r.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email) ? r.email : null,
      source: "receita_cnpj",
      sourceDetail: "Base CNPJ (Receita Federal)",
    }));
  } else if (body.source === "places") {
    const list = Array.isArray(body.places) ? body.places : [];
    if (!list.length) throw new HttpError(400, "missing_rows");
    if (list.length > MAX_IMPORT) throw new HttpError(400, "too_many_rows");
    const detail = optText(body.searchQuery, "search_query", 200);
    items = list.map((p) => ({
      company: cleanCompany({ name: p.name, website: p.website, segment: p.category, city: p.city, uf: p.uf, phone: p.phone, notes: p.address }),
      extra: {},
      externalIds: { places: reqText(p.placeId, "place_id", 300) },
      contactEmail: null,
      source: "google_places",
      sourceDetail: detail ? `Google Maps: ${detail}` : "Google Maps",
    }));
  } else {
    throw new HttpError(400, "invalid_source");
  }

  const result = { created: 0, alreadyInPipeline: 0 };
  const createdDeals = [];
  await withTransaction(async (db) => {
    let position = await nextPosition(db, stageId);
    for (const item of items) {
      const r = await addToPipeline(db, user, item, pipelineId, stageId, agentId, position);
      if (r !== "exists") {
        createdDeals.push(r);
        result.created++;
        position += 1024;
      } else result.alreadyInPipeline++;
    }
  });
  if (body.startCadence && agentId) result.cadence = await enrollCreated(user, createdDeals);
  await audit({ organizationId: user.organizationId, userId: user.id, action: "leads_sourced", entity: "pipeline", entityId: pipelineId, details: { source: body.source, ...result }, ip });
  return { ok: true, ...result };
}

async function enrichOne({ user, params, ip }) {
  const { rows } = await query(`SELECT id, cnpj FROM companies WHERE id = $1 AND organization_id = $2`, [params.id, user.organizationId]);
  if (!rows.length) throw new HttpError(404, "not_found");
  const r = await enrichCompany(rows[0]);
  if (r.error) throw new HttpError(r.error === "cnpj_not_found" ? 404 : r.error === "missing_cnpj" ? 400 : 502, r.error);
  await audit({ organizationId: user.organizationId, userId: user.id, action: "company_enriched", entity: "company", entityId: params.id, details: { source: r.data.source }, ip });
  return { ok: true, source: r.data.source };
}

// Enriquece em lote (até 10 por chamada; a interface chama de novo enquanto houver pendentes).
async function enrichPending({ user, ip }) {
  const { rows } = await query(
    `SELECT id, cnpj FROM companies WHERE organization_id = $1 AND cnpj IS NOT NULL AND enriched_at IS NULL
     ORDER BY created_at LIMIT 10`,
    [user.organizationId]
  );
  let done = 0;
  const errors = [];
  for (const c of rows) {
    const r = await enrichCompany(c);
    if (r.error) {
      errors.push({ id: c.id, error: r.error });
      // Marca a tentativa para não travar o lote em CNPJs inexistentes.
      if (r.error === "cnpj_not_found") await query(`UPDATE companies SET enriched_at = now(), enrichment = '{"error":"cnpj_not_found"}' WHERE id = $1`, [c.id]);
      if (r.error === "lookup_rate_limited") break;
    } else done++;
  }
  const { rows: rem } = await query(
    `SELECT count(*)::int AS n FROM companies WHERE organization_id = $1 AND cnpj IS NOT NULL AND enriched_at IS NULL`,
    [user.organizationId]
  );
  if (done) await audit({ organizationId: user.organizationId, userId: user.id, action: "companies_enriched", details: { done }, ip });
  return { ok: true, done, errors, remaining: rem[0].n };
}

module.exports = [
  { method: "GET", path: "/sourcing/status", handler: status },
  { method: "GET", path: "/sourcing/cnaes", handler: cnaes },
  { method: "GET", path: "/sourcing/municipios", handler: municipios },
  { method: "GET", path: "/sourcing/cnpj", handler: searchCnpj },
  { method: "GET", path: "/sourcing/places", handler: places },
  { method: "POST", path: "/sourcing/import", handler: importLeads, roles: ["admin", "gestor"] },
  { method: "POST", path: "/companies/:id/enrich", handler: enrichOne },
  { method: "POST", path: "/companies/enrich-pending", handler: enrichPending, roles: ["admin", "gestor"] },
];
