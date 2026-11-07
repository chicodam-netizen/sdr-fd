// Agentes SDR (configuração da IA) e base de conhecimento.
const { query } = require("../db");
const { HttpError } = require("../http");
const { audit } = require("../audit");
const { reqText, optText, optUuid } = require("../validate");
const { withTransaction } = require("../db");
const { createDefaultCadence } = require("../cadence-hooks");

const MANAGERS = ["admin", "gestor"];
const TEXT_FIELDS = {
  persona: 4000,
  objective: 2000,
  tone: 1000,
  rules: 8000,
  qualification_criteria: 4000,
  forbidden: 4000,
  signature: 1000,
};
const KB_MAX = 60_000;

function agentDto(a) {
  return {
    id: a.id,
    name: a.name,
    active: a.active,
    senderName: a.sender_name,
    senderTitle: a.sender_title,
    persona: a.persona,
    objective: a.objective,
    tone: a.tone,
    rules: a.rules,
    qualificationCriteria: a.qualification_criteria,
    forbidden: a.forbidden,
    signature: a.signature,
    autonomy: a.autonomy,
    businessHoursOnly: a.business_hours_only,
    dailyLimit: a.daily_limit,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
    ...(a.deals !== undefined ? { deals: a.deals, sentToday: a.sent_today, pending: a.pending } : {}),
  };
}

function knowledgeDto(k) {
  return { id: k.id, agentId: k.agent_id, title: k.title, content: k.content, updatedAt: k.updated_at };
}

// Converte o corpo da requisição (camelCase) em colunas validadas.
function cleanAgent(body, partial) {
  const out = {};
  if (!partial || body.name !== undefined) out.name = reqText(body.name, "name", 80);
  if (!partial || body.senderName !== undefined) out.sender_name = reqText(body.senderName, "sender_name", 80);
  if (body.senderTitle !== undefined) out.sender_title = optText(body.senderTitle, "sender_title", 120);
  const map = { persona: "persona", objective: "objective", tone: "tone", rules: "rules", qualificationCriteria: "qualification_criteria", forbidden: "forbidden", signature: "signature" };
  for (const [k, col] of Object.entries(map)) {
    if (body[k] !== undefined) out[col] = optText(body[k], col, TEXT_FIELDS[col]);
  }
  if (body.active !== undefined) out.active = Boolean(body.active);
  if (body.dailyLimit !== undefined) {
    const n = Number(body.dailyLimit);
    if (!Number.isInteger(n) || n < 1 || n > 500) throw new HttpError(400, "invalid_daily_limit");
    out.daily_limit = n;
  }
  if (body.autonomy !== undefined) {
    if (!["draft", "semi", "auto"].includes(body.autonomy)) throw new HttpError(400, "invalid_autonomy");
    out.autonomy = body.autonomy;
  }
  if (body.businessHoursOnly !== undefined) out.business_hours_only = Boolean(body.businessHoursOnly);
  return out;
}

async function findAgent(user, id) {
  const { rows } = await query(`SELECT * FROM agents WHERE id = $1 AND organization_id = $2`, [id, user.organizationId]);
  if (!rows.length) throw new HttpError(404, "not_found");
  return rows[0];
}

async function list({ user }) {
  const { rows } = await query(
    `SELECT a.*,
       (SELECT count(*)::int FROM deals d WHERE d.agent_id = a.id) AS deals,
       (SELECT count(*)::int FROM messages m WHERE m.agent_id = a.id AND m.direction = 'out' AND m.status = 'sent'
          AND m.sent_at >= date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo') AS sent_today,
       (SELECT count(*)::int FROM messages m WHERE m.agent_id = a.id AND m.status = 'draft') AS pending
     FROM agents a WHERE a.organization_id = $1 ORDER BY a.active DESC, a.name`,
    [user.organizationId]
  );
  return { ok: true, agents: rows.map(agentDto) };
}

async function get({ user, params }) {
  const a = await findAgent(user, params.id);
  const { rows } = await query(
    `SELECT * FROM knowledge_items WHERE organization_id = $1 AND (agent_id = $2 OR agent_id IS NULL) ORDER BY agent_id NULLS FIRST, title`,
    [user.organizationId, a.id]
  );
  return { ok: true, agent: agentDto(a), knowledge: rows.map(knowledgeDto) };
}

async function create({ user, body, ip }) {
  const a = cleanAgent(body, false);
  const keys = Object.keys(a);
  const rows = await withTransaction(async (db) => {
    const r = await db.query(
      `INSERT INTO agents (organization_id, created_by, ${keys.join(", ")})
       VALUES ($1, $2, ${keys.map((_, i) => `$${i + 3}`).join(", ")}) RETURNING *`,
      [user.organizationId, user.id, ...keys.map((k) => a[k])]
    );
    await createDefaultCadence(db, user.organizationId, r.rows[0].id);
    return r.rows;
  });
  await audit({ organizationId: user.organizationId, userId: user.id, action: "agent_created", entity: "agent", entityId: rows[0].id, details: { name: a.name }, ip });
  return { status: 201, body: { ok: true, agent: agentDto(rows[0]) } };
}

async function update({ user, params, body, ip }) {
  await findAgent(user, params.id);
  const a = cleanAgent(body, true);
  const keys = Object.keys(a);
  if (!keys.length) throw new HttpError(400, "nothing_to_update");
  const { rows } = await query(
    `UPDATE agents SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`,
    [params.id, ...keys.map((k) => a[k])]
  );
  await audit({ organizationId: user.organizationId, userId: user.id, action: "agent_updated", entity: "agent", entityId: params.id, details: { fields: keys }, ip });
  return { ok: true, agent: agentDto(rows[0]) };
}

// ---------- Base de conhecimento ----------

async function listKnowledge({ user, query: qs }) {
  const agentId = optUuid(qs.get("agentId"), "agent_id");
  const { rows } = await query(
    `SELECT * FROM knowledge_items WHERE organization_id = $1 AND ${agentId ? "agent_id = $2" : "agent_id IS NULL"} ORDER BY title`,
    agentId ? [user.organizationId, agentId] : [user.organizationId]
  );
  return { ok: true, knowledge: rows.map(knowledgeDto) };
}

async function createKnowledge({ user, body, ip }) {
  const agentId = optUuid(body.agentId, "agent_id");
  if (agentId) await findAgent(user, agentId);
  const title = reqText(body.title, "title", 150);
  const content = reqText(body.content, "content", KB_MAX);
  const { rows } = await query(
    `INSERT INTO knowledge_items (organization_id, agent_id, title, content) VALUES ($1, $2, $3, $4) RETURNING *`,
    [user.organizationId, agentId, title, content]
  );
  await audit({ organizationId: user.organizationId, userId: user.id, action: "knowledge_created", entity: "knowledge", entityId: rows[0].id, details: { title }, ip });
  return { status: 201, body: { ok: true, item: knowledgeDto(rows[0]) } };
}

async function findKnowledge(user, id) {
  const { rows } = await query(`SELECT * FROM knowledge_items WHERE id = $1 AND organization_id = $2`, [id, user.organizationId]);
  if (!rows.length) throw new HttpError(404, "not_found");
  return rows[0];
}

async function updateKnowledge({ user, params, body, ip }) {
  await findKnowledge(user, params.id);
  const title = reqText(body.title, "title", 150);
  const content = reqText(body.content, "content", KB_MAX);
  const { rows } = await query(
    `UPDATE knowledge_items SET title = $2, content = $3, updated_at = now() WHERE id = $1 RETURNING *`,
    [params.id, title, content]
  );
  await audit({ organizationId: user.organizationId, userId: user.id, action: "knowledge_updated", entity: "knowledge", entityId: params.id, ip });
  return { ok: true, item: knowledgeDto(rows[0]) };
}

async function deleteKnowledge({ user, params, ip }) {
  const k = await findKnowledge(user, params.id);
  await query(`DELETE FROM knowledge_items WHERE id = $1`, [k.id]);
  await audit({ organizationId: user.organizationId, userId: user.id, action: "knowledge_deleted", entity: "knowledge", entityId: k.id, details: { title: k.title }, ip });
  return { ok: true };
}

module.exports = {
  routes: [
    { method: "GET", path: "/agents", handler: list },
    { method: "POST", path: "/agents", handler: create, roles: MANAGERS },
    { method: "GET", path: "/agents/:id", handler: get },
    { method: "PATCH", path: "/agents/:id", handler: update, roles: MANAGERS },
    { method: "GET", path: "/knowledge", handler: listKnowledge },
    { method: "POST", path: "/knowledge", handler: createKnowledge, roles: MANAGERS },
    { method: "PATCH", path: "/knowledge/:id", handler: updateKnowledge, roles: MANAGERS },
    { method: "DELETE", path: "/knowledge/:id", handler: deleteKnowledge, roles: MANAGERS },
  ],
  findAgent,
};
