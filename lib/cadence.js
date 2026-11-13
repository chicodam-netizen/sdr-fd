// Cadências: inscrição de cards e execução dos passos vencidos.
// Autonomia do agente:
//   draft -> todo passo vira rascunho na fila de Aprovações
//   semi  -> o 1º passo vai para aprovação; os follow-ups são enviados automaticamente
//   auto  -> todos os passos são enviados automaticamente
// Respostas de leads nunca são respondidas automaticamente: a cadência para e um humano assume.
const { query, withTransaction } = require("./db");
const { HttpError } = require("./http");
const { logActivity } = require("./crm");
const { generateDraft, approveAndSend } = require("./conversation");
const { scheduleAfter, nextAllowed } = require("./cadence-hooks");

const LEASE_MINUTES = 10;

async function loadSteps(agentId) {
  const { rows } = await query(`SELECT position, delay_days, instruction, channel FROM cadence_steps WHERE agent_id = $1 ORDER BY position`, [agentId]);
  return rows;
}

async function openEnrollment(dealId) {
  const { rows } = await query(`SELECT * FROM enrollments WHERE deal_id = $1 AND status IN ('active', 'waiting_approval', 'paused')`, [dealId]);
  return rows[0] || null;
}

// Inscreve o card na cadência do agente (do card ou informado).
async function enroll({ user, dealId, agentId }) {
  const { rows } = await query(
    `SELECT d.id, d.agent_id, d.company_id, s.kind, ct.email, ct.opt_out
     FROM deals d JOIN stages s ON s.id = d.stage_id LEFT JOIN contacts ct ON ct.id = d.contact_id
     WHERE d.id = $1 AND d.organization_id = $2`,
    [dealId, user.organizationId]
  );
  const deal = rows[0];
  if (!deal) throw new HttpError(404, "not_found");
  const useAgent = agentId || deal.agent_id;
  if (!useAgent) throw new HttpError(400, "missing_agent");
  const { rows: ag } = await query(`SELECT id, active, business_hours_only FROM agents WHERE id = $1 AND organization_id = $2`, [useAgent, user.organizationId]);
  if (!ag.length) throw new HttpError(400, "invalid_agent");
  if (!ag[0].active) throw new HttpError(400, "agent_inactive");
  if (deal.kind !== "open") throw new HttpError(409, "deal_closed");
  if (!deal.email) throw new HttpError(400, "contact_without_email");
  if (deal.opt_out) throw new HttpError(409, "contact_opted_out");
  if (await openEnrollment(dealId)) throw new HttpError(409, "already_enrolled");
  const steps = await loadSteps(useAgent);
  if (!steps.length) throw new HttpError(400, "cadence_empty");

  // Evita duplicar o 1º contato quando o card já teve e-mail fora da cadência:
  //  - já houve e-mail ENVIADO: o 1º passo conta como feito; começa no 2º, contado a partir do último envio;
  //  - há RASCUNHO avulso pendente: ele vira o 1º passo (aprovar/enviar segue a cadência normalmente).
  const { rows: lastSent } = await query(
    `SELECT max(sent_at) AS at FROM messages WHERE deal_id = $1 AND direction = 'out' AND status = 'sent'`, [dealId]
  );
  const sentAt = lastSent[0].at;
  const { rows: loose } = sentAt ? { rows: [] } : await query(
    `SELECT id FROM messages WHERE deal_id = $1 AND direction = 'out' AND status = 'draft' AND enrollment_id IS NULL AND coalesce(ai_meta->>'kind', '') <> 'reply' ORDER BY created_at DESC LIMIT 1`, [dealId]
  );
  const bh = ag[0].business_hours_only;
  const start = sentAt
    ? { step: 2, status: "active", next: steps[1] ? scheduleAfter(new Date(sentAt), steps[1].delay_days, bh) : new Date(), mode: "after_sent" }
    : loose.length
      ? { step: 1, status: "waiting_approval", next: null, mode: "adopted_draft" }
      : { step: 1, status: "active", next: scheduleAfter(new Date(), steps[0].delay_days, bh), mode: "new" };

  return withTransaction(async (db) => {
    if (deal.agent_id !== useAgent) await db.query(`UPDATE deals SET agent_id = $2 WHERE id = $1`, [dealId, useAgent]);
    const { rows: e } = await db.query(
      `INSERT INTO enrollments (organization_id, deal_id, agent_id, current_step, status, next_run_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [user.organizationId, dealId, useAgent, start.step, start.status, start.next, user.id || null]
    );
    if (start.mode === "adopted_draft") {
      await db.query(`UPDATE messages SET enrollment_id = $2, step = 1, agent_id = $3, updated_at = now() WHERE id = $1`, [loose[0].id, e[0].id, useAgent]);
    }
    await logActivity(db, { orgId: user.organizationId, dealId, companyId: deal.company_id, userId: user.id || null, type: "cadence_started", meta: { steps: steps.length, start: start.mode } });
    return e[0].id;
  });
}

async function findEnrollment(user, id) {
  const { rows } = await query(`SELECT e.*, a.business_hours_only FROM enrollments e JOIN agents a ON a.id = e.agent_id WHERE e.id = $1 AND e.organization_id = $2`, [id, user.organizationId]);
  if (!rows.length) throw new HttpError(404, "not_found");
  return rows[0];
}

async function pause(user, id) {
  const e = await findEnrollment(user, id);
  if (!["active", "waiting_approval"].includes(e.status)) throw new HttpError(409, "enrollment_not_running");
  await query(`UPDATE enrollments SET status = 'paused', stop_reason = 'paused_by_user', updated_at = now() WHERE id = $1`, [id]);
}

async function resume(user, id) {
  const e = await findEnrollment(user, id);
  if (e.status !== "paused") throw new HttpError(409, "enrollment_not_paused");
  // Se o rascunho do passo atual ainda está na fila, volta a aguardar aprovação; senão, roda o passo.
  const { rowCount } = await query(`SELECT 1 FROM messages WHERE enrollment_id = $1 AND status = 'draft'`, [id]);
  await query(
    `UPDATE enrollments SET status = $2, stop_reason = NULL, next_run_at = $3, updated_at = now() WHERE id = $1`,
    [id, rowCount ? "waiting_approval" : "active", rowCount ? null : nextAllowed(new Date(), e.business_hours_only)]
  );
}

async function stop(user, id) {
  const e = await findEnrollment(user, id);
  if (!["active", "waiting_approval", "paused"].includes(e.status)) throw new HttpError(409, "enrollment_not_running");
  await query(`UPDATE enrollments SET status = 'stopped', stop_reason = 'stopped_by_user', next_run_at = NULL, updated_at = now() WHERE id = $1`, [id]);
  await query(`UPDATE messages SET status = 'discarded', updated_at = now() WHERE enrollment_id = $1 AND status = 'draft'`, [id]);
}

async function sentToday(agentId) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM messages WHERE agent_id = $1 AND direction = 'out' AND status = 'sent' AND channel = 'email'
       AND sent_at >= date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`,
    [agentId]
  );
  return rows[0].n;
}

async function setState(id, status, reason, nextRunAt = null) {
  await query(`UPDATE enrollments SET status = $2, stop_reason = $3, next_run_at = $4, updated_at = now() WHERE id = $1`, [id, status, reason, nextRunAt]);
}

// Executa um passo vencido. Retorna o que aconteceu (para o resumo do processamento).
async function runStep(e) {
  const { rows } = await query(
    `SELECT d.id, s.kind AS stage_kind, ct.email, ct.opt_out, a.active, a.autonomy, a.daily_limit, a.business_hours_only
     FROM deals d JOIN stages s ON s.id = d.stage_id JOIN agents a ON a.id = $2
     LEFT JOIN contacts ct ON ct.id = d.contact_id WHERE d.id = $1`,
    [e.deal_id, e.agent_id]
  );
  const ctx = rows[0];
  if (!ctx) return "missing";
  if (ctx.stage_kind !== "open") return setState(e.id, "finished", ctx.stage_kind).then(() => "finished");
  if (ctx.opt_out) return setState(e.id, "stopped", "opt_out").then(() => "stopped");
  if (!ctx.email) return setState(e.id, "stopped", "contact_without_email").then(() => "stopped");
  if (!ctx.active) return setState(e.id, "paused", "agent_inactive").then(() => "paused");

  const steps = await loadSteps(e.agent_id);
  const step = steps.find((s) => s.position === e.current_step);
  if (!step) return setState(e.id, "finished", "sequence_completed").then(() => "finished");

  const linkedinStep = step.channel === "linkedin_connect" || step.channel === "linkedin_message";
  // Limite diário do agente (só e-mail): tenta de novo no próximo horário permitido do dia seguinte.
  if (!linkedinStep && (await sentToday(e.agent_id)) >= ctx.daily_limit) {
    const tomorrow = new Date(Date.now() + 86_400_000);
    tomorrow.setUTCHours(11, 0, 0, 0); // 8h de Brasília
    await setState(e.id, "active", "daily_limit_reached", nextAllowed(tomorrow, ctx.business_hours_only));
    return "deferred";
  }

  const system = { organizationId: e.organization_id, id: null };
  const { rowCount: sentBefore } = await query(`SELECT 1 FROM messages WHERE deal_id = $1 AND direction = 'out' AND status = 'sent' LIMIT 1`, [e.deal_id]);
  const messageId = await generateDraft({
    user: system,
    dealId: e.deal_id,
    agentId: e.agent_id,
    kind: sentBefore ? "followup" : "first",
    instruction: step.instruction,
    enrollment: { id: e.id, step: step.position },
    channel: linkedinStep ? step.channel : "email",
  });

  // LinkedIn é sempre manual: vira tarefa na tela LinkedIn, qualquer que seja a autonomia do agente.
  if (linkedinStep) {
    await setState(e.id, "waiting_approval", null);
    return "drafted";
  }

  const autoSend = ctx.autonomy === "auto" || (ctx.autonomy === "semi" && step.position > 1);
  if (!autoSend) {
    await setState(e.id, "waiting_approval", null);
    return "drafted";
  }
  try {
    await approveAndSend({ user: system, messageId }); // o gancho agenda o próximo passo
    return "sent";
  } catch (err) {
    await setState(e.id, "waiting_approval", err.code || "send_failed");
    return "drafted";
  }
}

// Processa os passos vencidos. Cada cadência é "reservada" por alguns minutos para que duas
// execuções simultâneas (cron + botão) não gerem o mesmo passo duas vezes.
async function processDue({ limit = 5, organizationId = null } = {}) {
  const due = await withTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM enrollments WHERE status = 'active' AND next_run_at <= now() ${organizationId ? "AND organization_id = $2" : ""}
       ORDER BY next_run_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
      organizationId ? [limit, organizationId] : [limit]
    );
    if (rows.length) {
      await db.query(`UPDATE enrollments SET next_run_at = now() + make_interval(mins => $2) WHERE id = ANY($1)`, [rows.map((r) => r.id), LEASE_MINUTES]);
    }
    return rows;
  });
  const summary = { processed: 0, sent: 0, drafted: 0, deferred: 0, finished: 0, stopped: 0, paused: 0, errors: 0 };
  for (const e of due) {
    try {
      const r = await runStep(e);
      summary.processed++;
      if (summary[r] !== undefined) summary[r]++;
    } catch (err) {
      summary.errors++;
      console.error("cadência", e.id, err.code || err);
      // Erro de IA: tenta de novo em 1 hora.
      await query(`UPDATE enrollments SET next_run_at = now() + interval '1 hour', stop_reason = $2 WHERE id = $1`, [e.id, err.code || "error"]);
    }
  }
  const { rows: left } = await query(
    `SELECT count(*)::int AS n FROM enrollments WHERE status = 'active' AND next_run_at <= now() ${organizationId ? "AND organization_id = $1" : ""}`,
    organizationId ? [organizationId] : []
  );
  return { ...summary, remainingDue: left[0].n };
}

module.exports = { enroll, pause, resume, stop, processDue, loadSteps, openEnrollment };
