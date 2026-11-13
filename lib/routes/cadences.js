// Cadências: passos por agente, inscrição de cards e processamento (manual ou agendado).
const { query, withTransaction } = require("../db");
const { HttpError } = require("../http");
const { audit } = require("../audit");
const { optText, optUuid } = require("../validate");
const { findAgent } = require("./agents");
const cadence = require("../cadence");

const MANAGERS = ["admin", "gestor"];

async function getSteps({ user, params }) {
  await findAgent(user, params.id);
  const steps = await cadence.loadSteps(params.id);
  return { ok: true, steps: steps.map((s) => ({ position: s.position, delayDays: s.delay_days, instruction: s.instruction, channel: s.channel })) };
}

// Substitui todos os passos da cadência do agente.
async function putSteps({ user, params, body, ip }) {
  await findAgent(user, params.id);
  const list = Array.isArray(body.steps) ? body.steps : [];
  if (!list.length) throw new HttpError(400, "cadence_empty");
  if (list.length > 10) throw new HttpError(400, "too_many_steps");
  const steps = list.map((s, i) => {
    const d = Number(s.delayDays);
    if (!Number.isInteger(d) || d < 0 || d > 90) throw new HttpError(400, "invalid_delay");
    const channel = s.channel || "email";
    if (!["email", "linkedin_connect", "linkedin_message"].includes(channel)) throw new HttpError(400, "invalid_channel");
    return { position: i + 1, delayDays: d, instruction: optText(s.instruction, "instruction", 1000), channel };
  });
  await withTransaction(async (db) => {
    await db.query(`DELETE FROM cadence_steps WHERE agent_id = $1`, [params.id]);
    for (const s of steps) {
      await db.query(
        `INSERT INTO cadence_steps (organization_id, agent_id, position, delay_days, instruction, channel) VALUES ($1, $2, $3, $4, $5, $6)`,
        [user.organizationId, params.id, s.position, s.delayDays, s.instruction, s.channel]
      );
    }
  });
  await audit({ organizationId: user.organizationId, userId: user.id, action: "cadence_updated", entity: "agent", entityId: params.id, details: { steps: steps.length }, ip });
  return { ok: true };
}

function enrollmentDto(e, total) {
  return {
    id: e.id,
    agentId: e.agent_id,
    agentName: e.agent_name,
    currentStep: e.current_step,
    totalSteps: total,
    status: e.status,
    nextRunAt: e.next_run_at,
    stopReason: e.stop_reason,
    createdAt: e.created_at,
    updatedAt: e.updated_at,
  };
}

async function dealEnrollment({ user, params }) {
  const { rows } = await query(
    `SELECT e.*, a.name AS agent_name, (SELECT count(*)::int FROM cadence_steps s WHERE s.agent_id = e.agent_id) AS total
     FROM enrollments e JOIN agents a ON a.id = e.agent_id
     WHERE e.deal_id = $1 AND e.organization_id = $2 ORDER BY e.created_at DESC LIMIT 1`,
    [params.id, user.organizationId]
  );
  return { ok: true, enrollment: rows[0] ? enrollmentDto(rows[0], rows[0].total) : null };
}

async function enrollDeal({ user, params, body, ip }) {
  const id = await cadence.enroll({ user, dealId: params.id, agentId: optUuid(body.agentId, "agent_id") });
  await audit({ organizationId: user.organizationId, userId: user.id, action: "cadence_enrolled", entity: "deal", entityId: params.id, details: { enrollmentId: id }, ip });
  return dealEnrollment({ user, params });
}

// Inscrição em lote (cards selecionados): pula os que não podem entrar e conta os motivos.
async function enrollMany({ user, body, ip }) {
  const ids = (Array.isArray(body.dealIds) ? body.dealIds : []).map((d) => optUuid(d, "deal_id")).filter(Boolean);
  if (!ids.length) throw new HttpError(400, "missing_rows");
  if (ids.length > 200) throw new HttpError(400, "too_many_rows");
  const result = { enrolled: 0, skipped: {} };
  for (const dealId of ids) {
    try {
      await cadence.enroll({ user, dealId, agentId: optUuid(body.agentId, "agent_id") });
      result.enrolled++;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      result.skipped[err.code] = (result.skipped[err.code] || 0) + 1;
    }
  }
  await audit({ organizationId: user.organizationId, userId: user.id, action: "cadence_enrolled_bulk", details: result, ip });
  return { ok: true, ...result };
}

const action = (fn, name) => async ({ user, params, ip }) => {
  await fn(user, params.id);
  await audit({ organizationId: user.organizationId, userId: user.id, action: `cadence_${name}`, entity: "enrollment", entityId: params.id, ip });
  return { ok: true };
};

async function runNow({ user, body }) {
  const limit = Math.min(20, Math.max(1, Number(body.limit) || 5));
  return { ok: true, ...(await cadence.processDue({ limit, organizationId: user.organizationId })) };
}

// Agendador externo (Vercel Cron ou similar). Poucos por chamada: cada passo usa a IA (~10s).
async function cron({ req }) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) throw new HttpError(401, "unauthorized");
  return { ok: true, ...(await cadence.processDue({ limit: 4 })) };
}

async function overview({ user }) {
  const { rows } = await query(
    `SELECT status, count(*)::int AS n,
            count(*) FILTER (WHERE status = 'active' AND next_run_at <= now())::int AS due
     FROM enrollments WHERE organization_id = $1 GROUP BY status`,
    [user.organizationId]
  );
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  const due = rows.reduce((s, r) => s + r.due, 0);
  return { ok: true, byStatus: by, due };
}

module.exports = [
  { method: "GET", path: "/agents/:id/cadence", handler: getSteps },
  { method: "PUT", path: "/agents/:id/cadence", handler: putSteps, roles: MANAGERS },
  { method: "GET", path: "/deals/:id/enrollment", handler: dealEnrollment },
  { method: "POST", path: "/deals/:id/enroll", handler: enrollDeal },
  { method: "POST", path: "/enrollments/bulk", handler: enrollMany, roles: MANAGERS },
  { method: "POST", path: "/enrollments/:id/pause", handler: action(cadence.pause, "paused") },
  { method: "POST", path: "/enrollments/:id/resume", handler: action(cadence.resume, "resumed") },
  { method: "POST", path: "/enrollments/:id/stop", handler: action(cadence.stop, "stopped") },
  { method: "GET", path: "/cadences/overview", handler: overview },
  { method: "POST", path: "/cadences/run", handler: runNow, roles: MANAGERS },
  { method: "GET", path: "/cron/cadence", handler: cron, public: true },
];
