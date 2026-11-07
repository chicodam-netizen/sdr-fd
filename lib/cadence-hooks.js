// Ganchos de estado das cadências, chamados pela conversa (envio, descarte, resposta) e pelo funil.
// Só operações de banco: sem IA e sem envio, para não criar dependência circular.

const DEFAULT_STEPS = [
  { delayDays: 0, instruction: "Primeiro contato." },
  { delayDays: 3, instruction: "Follow-up curto retomando o primeiro e-mail com um ângulo novo; não repita o texto anterior." },
  { delayDays: 7, instruction: "Compartilhe um insight útil e concreto ligado ao segmento do lead e renove o convite." },
  { delayDays: 14, instruction: "E-mail de encerramento cordial: pergunte se faz sentido seguir conversando ou se deve encerrar o contato por ora." },
];

const BRT_OFFSET_H = -3; // Brasília (sem horário de verão desde 2019)
const START_H = 8;
const END_H = 18;

// Próximo instante permitido para envio: dias úteis, 8h-18h de Brasília (com pequena dispersão
// para não disparar tudo no mesmo minuto). Sem restrição, devolve a própria data.
function nextAllowed(date, businessOnly) {
  if (!businessOnly) return date;
  const local = new Date(date.getTime() + BRT_OFFSET_H * 3600_000); // "relógio" de Brasília em UTC
  const day = local.getUTCDay();
  const hour = local.getUTCHours();
  const inWindow = day >= 1 && day <= 5 && hour >= START_H && hour < END_H;
  if (inWindow) return date;
  const next = new Date(local);
  if (day >= 1 && day <= 5 && hour < START_H) {
    // mesmo dia, às 8h
  } else {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  while (next.getUTCDay() === 0 || next.getUTCDay() === 6) next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCHours(START_H, Math.floor(Math.random() * 90), 0, 0);
  return new Date(next.getTime() - BRT_OFFSET_H * 3600_000);
}

function scheduleAfter(base, delayDays, businessOnly) {
  return nextAllowed(new Date(base.getTime() + delayDays * 86_400_000), businessOnly);
}

async function createDefaultCadence(db, orgId, agentId) {
  for (const [i, s] of DEFAULT_STEPS.entries()) {
    await db.query(
      `INSERT INTO cadence_steps (organization_id, agent_id, position, delay_days, instruction) VALUES ($1, $2, $3, $4, $5)`,
      [orgId, agentId, i + 1, s.delayDays, s.instruction]
    );
  }
}

// Mensagem de cadência enviada -> agenda o próximo passo ou conclui a sequência.
async function onMessageSent(db, messageId) {
  const { rows } = await db.query(
    `SELECT e.id, e.agent_id, e.current_step, m.step, a.business_hours_only
     FROM messages m JOIN enrollments e ON e.id = m.enrollment_id JOIN agents a ON a.id = e.agent_id
     WHERE m.id = $1 AND e.status IN ('active', 'waiting_approval', 'paused')`,
    [messageId]
  );
  if (!rows.length) return;
  const e = rows[0];
  const { rows: next } = await db.query(`SELECT delay_days FROM cadence_steps WHERE agent_id = $1 AND position = $2`, [e.agent_id, e.step + 1]);
  if (!next.length) {
    await db.query(`UPDATE enrollments SET status = 'finished', stop_reason = 'sequence_completed', next_run_at = NULL, updated_at = now() WHERE id = $1`, [e.id]);
    return;
  }
  await db.query(
    `UPDATE enrollments SET status = 'active', current_step = $2, next_run_at = $3, stop_reason = NULL, updated_at = now() WHERE id = $1`,
    [e.id, e.step + 1, scheduleAfter(new Date(), next[0].delay_days, e.business_hours_only)]
  );
}

// Rascunho de cadência descartado -> cadência pausada (alguém precisa decidir o que fazer).
async function onDraftDiscarded(db, messageId) {
  await db.query(
    `UPDATE enrollments SET status = 'paused', stop_reason = 'draft_discarded', updated_at = now()
     WHERE id = (SELECT enrollment_id FROM messages WHERE id = $1) AND status = 'waiting_approval'`,
    [messageId]
  );
}

async function stopForDeal(db, dealId, status, reason) {
  await db.query(
    `UPDATE enrollments SET status = $2, stop_reason = $3, next_run_at = NULL, updated_at = now()
     WHERE deal_id = $1 AND status IN ('active', 'waiting_approval', 'paused')`,
    [dealId, status, reason]
  );
  // Rascunhos pendentes da cadência deixam de fazer sentido.
  await db.query(`UPDATE messages SET status = 'discarded', updated_at = now() WHERE deal_id = $1 AND status = 'draft' AND enrollment_id IS NOT NULL`, [dealId]);
}

const onReply = (db, dealId) => stopForDeal(db, dealId, "replied", "lead_replied");
const onOptOut = (db, dealId) => stopForDeal(db, dealId, "stopped", "opt_out");
const onStageClosed = (db, dealId, kind) => stopForDeal(db, dealId, "finished", kind);

module.exports = { DEFAULT_STEPS, nextAllowed, scheduleAfter, createDefaultCadence, onMessageSent, onDraftDiscarded, onReply, onOptOut, onStageClosed, stopForDeal };
