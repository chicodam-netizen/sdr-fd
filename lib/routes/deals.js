// Negócios (cards do funil): listar, criar, editar, mover entre etapas, anotações e histórico.
const { query, withTransaction } = require("../db");
const { HttpError } = require("../http");
const { audit } = require("../audit");
const { findPipeline, findStage } = require("./pipelines");
const { optText, reqText, optUuid, reqUuid, optMoney, optDate } = require("../validate");
const { cleanCompany, cleanContact, findOrCreateCompany, findOrCreateContact, nextPosition, logActivity } = require("../crm");
const hooks = require("../cadence-hooks");

const DEAL_SELECT = `
  SELECT d.id, d.title, d.pipeline_id, d.stage_id, d.position, d.value, d.next_action_at,
         d.stage_changed_at, d.created_at, d.updated_at, d.owner_id, u.name AS owner_name, d.agent_id, ag.name AS agent_name,
         (SELECT e.status FROM enrollments e WHERE e.deal_id = d.id AND e.status IN ('active', 'waiting_approval', 'paused') LIMIT 1) AS cadence_status,
         (SELECT m.ai_meta->'classification'->>'suggested_stage_kind' FROM messages m
           WHERE m.deal_id = d.id AND m.direction = 'in' ORDER BY m.created_at DESC LIMIT 1) AS ai_suggestion,
         (SELECT s.kind FROM stages s WHERE s.id = d.stage_id) AS stage_kind,
         c.id AS company_id, c.name AS company_name, c.cnpj, c.city, c.uf, c.segment,
         ct.id AS contact_id, ct.name AS contact_name, ct.email AS contact_email, ct.phone AS contact_phone,
         ct.job_title AS contact_job_title, ct.opt_out AS contact_opt_out
  FROM deals d
  JOIN companies c ON c.id = d.company_id
  LEFT JOIN contacts ct ON ct.id = d.contact_id
  LEFT JOIN users u ON u.id = d.owner_id
  LEFT JOIN agents ag ON ag.id = d.agent_id`;

function dealDto(r) {
  return {
    id: r.id,
    title: r.title,
    pipelineId: r.pipeline_id,
    stageId: r.stage_id,
    position: r.position,
    value: r.value === null ? null : Number(r.value),
    nextActionAt: r.next_action_at,
    stageChangedAt: r.stage_changed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    owner: r.owner_id ? { id: r.owner_id, name: r.owner_name } : null,
    agent: r.agent_id ? { id: r.agent_id, name: r.agent_name } : null,
    cadenceStatus: r.cadence_status || null,
    // Sugestão da IA (Qualificado/Desqualificado) pela última resposta do lead, se o card ainda não foi decidido.
    aiSuggestion: ["qualified", "disqualified"].includes(r.ai_suggestion) && r.stage_kind === "open" ? r.ai_suggestion : null,
    company: { id: r.company_id, name: r.company_name, cnpj: r.cnpj, city: r.city, uf: r.uf, segment: r.segment },
    contact: r.contact_id
      ? { id: r.contact_id, name: r.contact_name, email: r.contact_email, phone: r.contact_phone, jobTitle: r.contact_job_title, optOut: r.contact_opt_out }
      : null,
  };
}

async function loadDeal(user, id) {
  const { rows } = await query(`${DEAL_SELECT} WHERE d.id = $1 AND d.organization_id = $2`, [id, user.organizationId]);
  if (!rows.length) throw new HttpError(404, "not_found");
  return rows[0];
}

async function checkOwner(user, ownerId) {
  if (!ownerId) return;
  const { rowCount } = await query(
    `SELECT 1 FROM users WHERE id = $1 AND organization_id = $2 AND active`,
    [ownerId, user.organizationId]
  );
  if (!rowCount) throw new HttpError(400, "invalid_owner");
}

async function list({ user, query: qs }) {
  const pipelineId = reqUuid(qs.get("pipelineId"), "pipeline_id");
  await findPipeline(user, pipelineId);
  const params = [user.organizationId, pipelineId];
  let where = `d.organization_id = $1 AND d.pipeline_id = $2`;

  const q = optText(qs.get("q"), "q", 100);
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where += ` AND (lower(d.title) LIKE $${params.length} OR lower(c.name) LIKE $${params.length}
               OR lower(coalesce(ct.name, '')) LIKE $${params.length} OR lower(coalesce(ct.email, '')) LIKE $${params.length}
               OR coalesce(c.cnpj, '') LIKE $${params.length})`;
  }
  const ownerId = optUuid(qs.get("ownerId"), "owner_id");
  if (ownerId) {
    params.push(ownerId);
    where += ` AND d.owner_id = $${params.length}`;
  }

  const { rows } = await query(`${DEAL_SELECT} WHERE ${where} ORDER BY d.position LIMIT 5000`, params);
  return { ok: true, deals: rows.map(dealDto) };
}

async function create({ user, body, ip }) {
  const pipelineId = reqUuid(body.pipelineId, "pipeline_id");
  await findPipeline(user, pipelineId);
  let stageId = optUuid(body.stageId, "stage_id");
  if (stageId) {
    const stage = await findStage(user, stageId);
    if (stage.pipeline_id !== pipelineId) throw new HttpError(400, "invalid_stage_id");
  } else {
    const { rows } = await query(`SELECT id FROM stages WHERE pipeline_id = $1 ORDER BY position LIMIT 1`, [pipelineId]);
    stageId = rows[0].id;
  }
  const ownerId = body.ownerId === undefined ? user.id : optUuid(body.ownerId, "owner_id");
  await checkOwner(user, ownerId);

  const company = cleanCompany(body.company || {});
  const contact = cleanContact(body.contact);
  const value = optMoney(body.value);
  const title = optText(body.title, "title", 200) || company.name;

  const dealId = await withTransaction(async (db) => {
    const co = await findOrCreateCompany(db, user.organizationId, user.id, company, "manual", null);
    const ct = await findOrCreateContact(db, user.organizationId, co.id, contact, "manual", null);
    const { rows } = await db.query(
      `INSERT INTO deals (organization_id, pipeline_id, stage_id, company_id, contact_id, owner_id, title, value, position, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [user.organizationId, pipelineId, stageId, co.id, ct?.id || null, ownerId, title, value, await nextPosition(db, stageId), user.id]
    );
    await logActivity(db, { orgId: user.organizationId, dealId: rows[0].id, companyId: co.id, userId: user.id, type: "created" });
    return rows[0].id;
  });

  await audit({ organizationId: user.organizationId, userId: user.id, action: "deal_created", entity: "deal", entityId: dealId, ip });
  return { status: 201, body: { ok: true, deal: dealDto(await loadDeal(user, dealId)) } };
}

async function get({ user, params }) {
  const deal = dealDto(await loadDeal(user, params.id));
  const [{ rows: company }, { rows: activities }] = await Promise.all([
    query(
      `SELECT id, name, cnpj, website, segment, city, uf, phone, linkedin_url, notes, source, source_detail, created_at
       FROM companies WHERE id = $1`,
      [deal.company.id]
    ),
    query(
      `SELECT a.id, a.type, a.body, a.meta, a.created_at, u.name AS user_name
       FROM activities a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.deal_id = $1 ORDER BY a.created_at DESC, a.id DESC LIMIT 200`,
      [params.id]
    ),
  ]);
  const c = company[0];
  deal.company = {
    ...deal.company,
    website: c.website,
    phone: c.phone,
    linkedinUrl: c.linkedin_url,
    notes: c.notes,
    source: c.source,
    sourceDetail: c.source_detail,
  };
  return {
    ok: true,
    deal,
    activities: activities.map((a) => ({
      id: a.id,
      type: a.type,
      body: a.body,
      meta: a.meta,
      createdAt: a.created_at,
      userName: a.user_name,
    })),
  };
}

async function update({ user, params, body, ip }) {
  const current = await loadDeal(user, params.id);
  const changes = {};
  if (body.title !== undefined) changes.title = reqText(body.title, "title", 200);
  if (body.value !== undefined) changes.value = optMoney(body.value);
  if (body.nextActionAt !== undefined) changes.next_action_at = optDate(body.nextActionAt, "next_action_at");
  if (body.ownerId !== undefined) {
    changes.owner_id = optUuid(body.ownerId, "owner_id");
    await checkOwner(user, changes.owner_id);
  }
  if (body.agentId !== undefined) {
    changes.agent_id = optUuid(body.agentId, "agent_id");
    if (changes.agent_id) {
      const { rowCount } = await query(`SELECT 1 FROM agents WHERE id = $1 AND organization_id = $2`, [changes.agent_id, user.organizationId]);
      if (!rowCount) throw new HttpError(400, "invalid_agent");
    }
  }
  const keys = Object.keys(changes);
  if (!keys.length) throw new HttpError(400, "nothing_to_update");

  await query(
    `UPDATE deals SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`,
    [params.id, ...keys.map((k) => changes[k])]
  );
  if (changes.owner_id !== undefined && changes.owner_id !== current.owner_id) {
    await logActivity({ query }, {
      orgId: user.organizationId, dealId: params.id, companyId: current.company_id, userId: user.id,
      type: "owner_change", meta: { from: current.owner_name, toId: changes.owner_id },
    });
  }
  await audit({ organizationId: user.organizationId, userId: user.id, action: "deal_updated", entity: "deal", entityId: params.id, details: changes, ip });
  return { ok: true, deal: dealDto(await loadDeal(user, params.id)) };
}

// Move o card para outra etapa (ou reordena na mesma), entre os cards beforeId (acima) e afterId (abaixo).
async function move({ user, params, body }) {
  const deal = await loadDeal(user, params.id);
  const stageId = reqUuid(body.stageId, "stage_id");
  const stage = await findStage(user, stageId);
  if (stage.pipeline_id !== deal.pipeline_id) throw new HttpError(400, "invalid_stage_id");

  const neighbors = [optUuid(body.beforeId, "before_id"), optUuid(body.afterId, "after_id")];
  const pos = {};
  for (const [i, id] of neighbors.entries()) {
    if (!id) continue;
    const { rows } = await query(`SELECT position FROM deals WHERE id = $1 AND stage_id = $2`, [id, stageId]);
    if (rows.length) pos[i === 0 ? "before" : "after"] = rows[0].position;
  }
  let position;
  if (pos.before !== undefined && pos.after !== undefined) position = (pos.before + pos.after) / 2;
  else if (pos.before !== undefined) position = pos.before + 1024;
  else if (pos.after !== undefined) position = pos.after - 1024;
  else position = await nextPosition({ query }, stageId);

  const stageChanged = stageId !== deal.stage_id;
  await withTransaction(async (db) => {
    await db.query(
      `UPDATE deals SET stage_id = $2, position = $3, updated_at = now()
       ${stageChanged ? ", stage_changed_at = now()" : ""} WHERE id = $1`,
      [deal.id, stageId, position]
    );
    if (stageChanged) {
      const { rows } = await db.query(`SELECT name FROM stages WHERE id = $1`, [deal.stage_id]);
      await logActivity(db, {
        orgId: user.organizationId, dealId: deal.id, companyId: deal.company_id, userId: user.id,
        type: "stage_change", meta: { from: rows[0]?.name, to: stage.name, toKind: stage.kind },
      });
      // Qualificado/desqualificado encerra a cadência do card.
      if (stage.kind !== "open") await hooks.onStageClosed(db, deal.id, stage.kind);
    }
  });
  return { ok: true, deal: dealDto(await loadDeal(user, deal.id)) };
}

async function addNote({ user, params, body }) {
  const deal = await loadDeal(user, params.id);
  const text = reqText(body.body, "body", 5000);
  await logActivity({ query }, { orgId: user.organizationId, dealId: deal.id, companyId: deal.company_id, userId: user.id, type: "note", body: text });
  await query(`UPDATE deals SET updated_at = now() WHERE id = $1`, [deal.id]);
  return { status: 201, body: { ok: true } };
}

async function remove({ user, params, ip }) {
  const deal = await loadDeal(user, params.id);
  await query(`DELETE FROM deals WHERE id = $1`, [deal.id]);
  await audit({
    organizationId: user.organizationId, userId: user.id, action: "deal_deleted", entity: "deal", entityId: deal.id,
    details: { title: deal.title, company: deal.company_name }, ip,
  });
  return { ok: true };
}

module.exports = [
  { method: "GET", path: "/deals", handler: list },
  { method: "POST", path: "/deals", handler: create },
  { method: "GET", path: "/deals/:id", handler: get },
  { method: "PATCH", path: "/deals/:id", handler: update },
  { method: "POST", path: "/deals/:id/move", handler: move },
  { method: "POST", path: "/deals/:id/notes", handler: addNote },
  { method: "DELETE", path: "/deals/:id", handler: remove, roles: ["admin", "gestor"] },
];
