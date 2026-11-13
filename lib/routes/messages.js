// Conversa por e-mail de cada card: rascunho com IA, edição, aprovação/envio, respostas recebidas.
const { query } = require("../db");
const { HttpError } = require("../http");
const { audit } = require("../audit");
const { reqText, optText, optUuid } = require("../validate");
const { generateDraft, approveAndSend, recordInbound, loadDealContext } = require("../conversation");
const hooks = require("../cadence-hooks");

function messageDto(m) {
  return {
    id: m.id,
    dealId: m.deal_id,
    direction: m.direction,
    status: m.status,
    subject: m.subject,
    body: m.body,
    toEmail: m.to_email,
    deliveredTo: m.delivered_to,
    fromEmail: m.from_email,
    error: m.error,
    ai: m.ai_meta,
    agentId: m.agent_id,
    enrollmentId: m.enrollment_id,
    step: m.step,
    agentName: m.agent_name || null,
    createdByName: m.created_by_name || null,
    approvedByName: m.approved_by_name || null,
    sentAt: m.sent_at,
    createdAt: m.created_at,
  };
}

const MESSAGE_SELECT = `
  SELECT m.*, a.name AS agent_name, cu.name AS created_by_name, au.name AS approved_by_name
  FROM messages m
  LEFT JOIN agents a ON a.id = m.agent_id
  LEFT JOIN users cu ON cu.id = m.created_by
  LEFT JOIN users au ON au.id = m.approved_by`;

async function loadMessage(user, id) {
  const { rows } = await query(`${MESSAGE_SELECT} WHERE m.id = $1 AND m.organization_id = $2`, [id, user.organizationId]);
  if (!rows.length) throw new HttpError(404, "not_found");
  return rows[0];
}

async function listForDeal({ user, params }) {
  await loadDealContext(user.organizationId, params.id);
  const { rows } = await query(
    `${MESSAGE_SELECT} WHERE m.deal_id = $1 AND m.status <> 'discarded' ORDER BY coalesce(m.sent_at, m.created_at)`,
    [params.id]
  );
  return { ok: true, messages: rows.map(messageDto) };
}

async function draft({ user, params, body, ip }) {
  const instruction = optText(body.instruction, "instruction", 1000);
  const id = await generateDraft({
    user,
    dealId: params.id,
    agentId: optUuid(body.agentId, "agent_id"),
    kind: body.kind,
    instruction,
  });
  await audit({ organizationId: user.organizationId, userId: user.id, action: "message_drafted", entity: "message", entityId: id, ip });
  return { status: 201, body: { ok: true, message: messageDto(await loadMessage(user, id)) } };
}

async function update({ user, params, body }) {
  const m = await loadMessage(user, params.id);
  if (m.status !== "draft") throw new HttpError(409, "message_not_draft");
  const subject = reqText(body.subject, "subject", 200);
  const text = reqText(body.body, "body", 10000);
  await query(
    `UPDATE messages SET subject = $2, body = $3, ai_meta = ai_meta || '{"edited": true}'::jsonb, updated_at = now() WHERE id = $1`,
    [m.id, subject, text]
  );
  return { ok: true, message: messageDto(await loadMessage(user, m.id)) };
}

async function send({ user, params, ip }) {
  const result = await approveAndSend({ user, messageId: params.id });
  await audit({ organizationId: user.organizationId, userId: user.id, action: "message_sent", entity: "message", entityId: params.id, details: result, ip });
  return { ok: true, ...result, message: messageDto(await loadMessage(user, params.id)) };
}

async function discard({ user, params, ip }) {
  const m = await loadMessage(user, params.id);
  if (m.status !== "draft") throw new HttpError(409, "message_not_draft");
  await query(`UPDATE messages SET status = 'discarded', updated_at = now() WHERE id = $1`, [m.id]);
  await hooks.onDraftDiscarded({ query }, m.id);
  await audit({ organizationId: user.organizationId, userId: user.id, action: "message_discarded", entity: "message", entityId: m.id, ip });
  return { ok: true };
}

// Registro manual de resposta (colar o e-mail recebido) - útil enquanto a leitura automática da caixa não está ligada.
async function inbound({ user, params, body, ip }) {
  const text = reqText(body.body, "body", 20000);
  const subject = optText(body.subject, "subject", 300);
  const result = await recordInbound({ orgId: user.organizationId, userId: user.id, dealId: params.id, subject, body: text, autoReply: true });
  await audit({ organizationId: user.organizationId, userId: user.id, action: "message_received_manual", entity: "message", entityId: result.id, ip });
  return { status: 201, body: { ok: true, classification: result.classification, replyDraftId: result.replyDraftId, message: messageDto(await loadMessage(user, result.id)) } };
}

// Fila de aprovação: todos os rascunhos da organização.
// Última mensagem recebida do lead (para revisar rascunhos de resposta com contexto).
const LAST_INBOUND = `(SELECT json_build_object('subject', i.subject, 'body', left(i.body, 2000), 'at', i.sent_at, 'fromEmail', i.from_email,
         'category', i.ai_meta->'classification'->>'category', 'summary', i.ai_meta->'classification'->>'summary',
         'suggested', i.ai_meta->'classification'->>'suggested_stage_kind')
   FROM messages i WHERE i.deal_id = m.deal_id AND i.direction = 'in' ORDER BY i.created_at DESC LIMIT 1) AS last_in`;

async function pending({ user }) {
  const { rows } = await query(
    `${MESSAGE_SELECT.replace("FROM messages m", `, c.name AS company_name, ct.name AS contact_name, ct.email AS contact_email, ct.opt_out, d.pipeline_id AS deal_pipeline_id, ds.kind AS deal_stage_kind, ${LAST_INBOUND} FROM messages m`)}
     JOIN deals d ON d.id = m.deal_id
     JOIN companies c ON c.id = d.company_id
     JOIN stages ds ON ds.id = d.stage_id
     LEFT JOIN contacts ct ON ct.id = d.contact_id
     WHERE m.organization_id = $1 AND m.status = 'draft'
     ORDER BY m.created_at`,
    [user.organizationId]
  );
  return {
    ok: true,
    messages: rows.map((r) => ({
      ...messageDto(r),
      company: r.company_name,
      contact: r.contact_name ? { name: r.contact_name, email: r.contact_email, optOut: r.opt_out } : null,
      lastInbound: r.last_in || null,
      pipelineId: r.deal_pipeline_id,
      stageKind: r.deal_stage_kind,
    })),
  };
}

module.exports = [
  { method: "GET", path: "/deals/:id/messages", handler: listForDeal },
  { method: "POST", path: "/deals/:id/messages/draft", handler: draft },
  { method: "POST", path: "/deals/:id/messages/inbound", handler: inbound },
  { method: "GET", path: "/messages/pending", handler: pending },
  { method: "PATCH", path: "/messages/:id", handler: update },
  { method: "POST", path: "/messages/:id/send", handler: send },
  { method: "POST", path: "/messages/:id/discard", handler: discard },
];
