// Regras da conversa por e-mail de um card: contexto para a IA, envio aprovado e respostas recebidas.
// Usado pelas rotas da API e pela leitura da caixa de entrada (IMAP).
const { query, withTransaction } = require("./db");
const { HttpError } = require("./http");
const { logActivity } = require("./crm");
const { draftEmail, classifyReply } = require("./ai");
const { sendProspectEmail } = require("./prospect-mailer");
const hooks = require("./cadence-hooks");

async function loadDealContext(orgId, dealId) {
  const { rows } = await query(
    `SELECT d.id, d.organization_id, d.agent_id, d.stage_id, d.pipeline_id, d.company_id, d.contact_id,
            s.name AS stage_name, o.name AS org_name,
            c.name AS company_name, c.sector, c.segment, c.city, c.uf, c.website, c.notes,
            ct.name AS contact_name, ct.email AS contact_email, ct.job_title, ct.opt_out
     FROM deals d
     JOIN stages s ON s.id = d.stage_id
     JOIN organizations o ON o.id = d.organization_id
     JOIN companies c ON c.id = d.company_id
     LEFT JOIN contacts ct ON ct.id = d.contact_id
     WHERE d.id = $1 AND d.organization_id = $2`,
    [dealId, orgId]
  );
  if (!rows.length) throw new HttpError(404, "not_found");
  return rows[0];
}

async function loadAgentWithKnowledge(orgId, agentId) {
  const { rows } = await query(`SELECT * FROM agents WHERE id = $1 AND organization_id = $2`, [agentId, orgId]);
  if (!rows.length) throw new HttpError(400, "invalid_agent");
  const { rows: knowledge } = await query(
    `SELECT title, content, agent_id FROM knowledge_items
     WHERE organization_id = $1 AND (agent_id = $2 OR agent_id IS NULL)
     ORDER BY agent_id NULLS FIRST, title`,
    [orgId, agentId]
  );
  return { agent: rows[0], knowledge };
}

async function loadThread(dealId) {
  const { rows } = await query(
    `SELECT m.direction, m.subject, m.body, m.sent_at, m.created_at, m.agent_id, a.sender_name AS agent_name
     FROM messages m LEFT JOIN agents a ON a.id = m.agent_id
     WHERE m.deal_id = $1 AND m.status IN ('sent', 'received') ORDER BY coalesce(m.sent_at, m.created_at)`,
    [dealId]
  );
  const { rows: notes } = await query(
    `SELECT body FROM activities WHERE deal_id = $1 AND type = 'note' ORDER BY created_at DESC LIMIT 10`,
    [dealId]
  );
  return { thread: rows, notes: notes.map((n) => n.body) };
}

function leadFrom(ctx) {
  return {
    company: { name: ctx.company_name, sector: ctx.sector, segment: ctx.segment, city: ctx.city, uf: ctx.uf, website: ctx.website, notes: ctx.notes },
    contact: ctx.contact_name ? { name: ctx.contact_name, job_title: ctx.job_title } : null,
    stageName: ctx.stage_name,
  };
}

// Escolhe o tipo de mensagem pelo histórico: nada enviado -> first; última foi recebida -> reply; senão follow-up.
function inferKind(thread) {
  if (!thread.length) return "first";
  return thread[thread.length - 1].direction === "in" ? "reply" : "followup";
}

// enrollment: { id, step } quando o rascunho é um passo de cadência.
async function generateDraft({ user, dealId, agentId, kind, instruction, enrollment }) {
  const ctx = await loadDealContext(user.organizationId, dealId);
  const useAgentId = agentId || ctx.agent_id;
  if (!useAgentId) throw new HttpError(400, "missing_agent");
  const { agent, knowledge } = await loadAgentWithKnowledge(user.organizationId, useAgentId);
  if (!agent.active) throw new HttpError(400, "agent_inactive");
  if (ctx.opt_out) throw new HttpError(409, "contact_opted_out");

  const { thread, notes } = await loadThread(dealId);
  const finalKind = ["first", "followup", "reply"].includes(kind) ? kind : inferKind(thread);
  const draft = await draftEmail({
    agent, knowledge, orgName: ctx.org_name, lead: leadFrom(ctx), thread, notes, kind: finalKind, instruction,
  });

  // Resposta mantém o assunto da conversa ("Re: ...").
  const lastSubject = [...thread].reverse().find((m) => m.subject)?.subject || null;
  const subject = finalKind === "reply" && lastSubject ? (/^re:/i.test(lastSubject) ? lastSubject : `Re: ${lastSubject}`) : draft.subject;

  return withTransaction(async (db) => {
    if (!ctx.agent_id) await db.query(`UPDATE deals SET agent_id = $2 WHERE id = $1`, [dealId, useAgentId]);
    const { rows } = await db.query(
      `INSERT INTO messages (organization_id, deal_id, contact_id, agent_id, direction, status, subject, body, to_email, ai_meta, created_by, enrollment_id, step)
       VALUES ($1, $2, $3, $4, 'out', 'draft', $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [user.organizationId, dealId, ctx.contact_id, useAgentId, subject, draft.body, ctx.contact_email,
        { kind: finalKind, rationale: draft.rationale, instruction: instruction || null, ...draft.meta }, user.id || null,
        enrollment?.id || null, enrollment?.step || null]
    );
    await logActivity(db, { orgId: user.organizationId, dealId, companyId: ctx.company_id, userId: user.id || null, type: "message_draft", meta: { kind: finalKind, agent: agent.name, step: enrollment?.step || null } });
    return rows[0].id;
  });
}

async function sentTodayByAgent(agentId) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM messages WHERE agent_id = $1 AND direction = 'out' AND status = 'sent'
       AND sent_at >= date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`,
    [agentId]
  );
  return rows[0].n;
}

// Aprovação humana + envio. Bloqueia opt-out, sem e-mail e limite diário do agente.
async function approveAndSend({ user, messageId }) {
  const { rows } = await query(`SELECT * FROM messages WHERE id = $1 AND organization_id = $2`, [messageId, user.organizationId]);
  const msg = rows[0];
  if (!msg) throw new HttpError(404, "not_found");
  if (msg.status !== "draft") throw new HttpError(409, "message_not_draft");

  const ctx = await loadDealContext(user.organizationId, msg.deal_id);
  if (!ctx.contact_email) throw new HttpError(400, "contact_without_email");
  if (ctx.opt_out) throw new HttpError(409, "contact_opted_out");

  const { rows: agentRows } = await query(`SELECT * FROM agents WHERE id = $1`, [msg.agent_id]);
  const agent = agentRows[0];
  if (agent && (await sentTodayByAgent(agent.id)) >= agent.daily_limit) throw new HttpError(429, "daily_limit_reached");

  // Encadeia com a última mensagem da conversa (enviada ou recebida).
  const { rows: last } = await query(
    `SELECT message_id FROM messages WHERE deal_id = $1 AND message_id IS NOT NULL AND status IN ('sent', 'received')
     ORDER BY coalesce(sent_at, created_at) DESC LIMIT 5`,
    [msg.deal_id]
  );
  const inReplyTo = last[0]?.message_id || null;
  const references = last.map((l) => l.message_id).reverse().join(" ") || null;

  const result = await sendProspectEmail({
    to: ctx.contact_email,
    subject: msg.subject,
    body: msg.body,
    fromName: agent ? `${agent.sender_name}${ctx.org_name ? ` | ${ctx.org_name}` : ""}` : ctx.org_name,
    inReplyTo,
    references,
  });

  const ok = result.sent || result.simulated;
  await withTransaction(async (db) => {
    await db.query(
      `UPDATE messages SET status = $2, to_email = $3, delivered_to = $4, from_email = $5, message_id = $6, in_reply_to = $7,
              error = $8, approved_by = $9, sent_at = CASE WHEN $10 THEN now() ELSE NULL END,
              ai_meta = ai_meta || $11::jsonb, updated_at = now()
       WHERE id = $1`,
      [msg.id, ok ? "sent" : "failed", ctx.contact_email, result.deliveredTo, result.from || null, result.messageId, inReplyTo,
        result.error || null, user.id || null, ok, JSON.stringify({ simulated: !!result.simulated, redirected: result.deliveredTo !== ctx.contact_email, autoSent: !user.id })]
    );
    if (ok) {
      await hooks.onMessageSent(db, msg.id);
      await db.query(`UPDATE deals SET updated_at = now() WHERE id = $1`, [msg.deal_id]);
      await logActivity(db, {
        orgId: user.organizationId, dealId: msg.deal_id, companyId: ctx.company_id, userId: user.id || null, type: "message_sent",
        meta: { subject: msg.subject, to: ctx.contact_email, deliveredTo: result.deliveredTo, simulated: !!result.simulated, auto: !user.id, step: msg.step },
      });
    }
  });
  if (!ok) throw new HttpError(502, result.error || "send_failed");
  return { simulated: !!result.simulated, deliveredTo: result.deliveredTo };
}

// Registra uma resposta do lead e classifica com a IA. Pedido de descadastro marca opt-out na hora.
async function recordInbound({ orgId, userId, dealId, subject, body, fromEmail, messageId, inReplyTo }) {
  const ctx = await loadDealContext(orgId, dealId);
  if (messageId) {
    const dup = await query(`SELECT id FROM messages WHERE message_id = $1`, [messageId]);
    if (dup.rowCount) return { duplicate: true, id: dup.rows[0].id };
  }
  const { rows: ins } = await query(
    `INSERT INTO messages (organization_id, deal_id, contact_id, agent_id, direction, status, subject, body, from_email, message_id, in_reply_to, sent_at, created_by)
     VALUES ($1, $2, $3, $4, 'in', 'received', $5, $6, $7, $8, $9, now(), $10) RETURNING id`,
    [orgId, dealId, ctx.contact_id, ctx.agent_id, subject || null, body, fromEmail || null, messageId || null, inReplyTo || null, userId || null]
  );
  const id = ins[0].id;
  await logActivity({ query }, { orgId, dealId, companyId: ctx.company_id, userId, type: "message_received", meta: { subject, from: fromEmail } });
  // Lead respondeu: a cadência para e a conversa passa para um humano.
  await hooks.onReply({ query }, dealId);
  await query(`UPDATE deals SET updated_at = now() WHERE id = $1`, [dealId]);

  let classification = null;
  if (ctx.agent_id) {
    try {
      const { agent, knowledge } = await loadAgentWithKnowledge(orgId, ctx.agent_id);
      const { thread, notes } = await loadThread(dealId);
      // A própria resposta já está no histórico; a IA a recebe também em destaque.
      classification = await classifyReply({
        agent, knowledge, orgName: ctx.org_name, lead: leadFrom(ctx), thread: thread.slice(0, -1), notes, reply: { subject, body },
      });
    } catch (err) {
      console.error("classificação falhou:", err.code || err);
    }
  }

  if (classification) {
    await query(`UPDATE messages SET ai_meta = $2 WHERE id = $1`, [id, { classification }]);
    await logActivity({ query }, {
      orgId, dealId, companyId: ctx.company_id, userId: null, type: "ai_classification",
      meta: { category: classification.category, summary: classification.summary, next: classification.next_step },
    });
    if (classification.category === "unsubscribe" && ctx.contact_id && !ctx.opt_out) {
      await query(`UPDATE contacts SET opt_out = true, updated_at = now() WHERE id = $1`, [ctx.contact_id]);
      // Rascunhos pendentes para este contato são descartados.
      await query(`UPDATE messages SET status = 'discarded', updated_at = now() WHERE deal_id = $1 AND status = 'draft'`, [dealId]);
      await logActivity({ query }, { orgId, dealId, companyId: ctx.company_id, type: "opt_out", meta: { reason: "Pediu para não ser contatado" } });
      await hooks.onOptOut({ query }, dealId);
    }
  }
  return { id, classification };
}

// Associa um e-mail recebido a um card: primeiro pelo encadeamento (In-Reply-To/References),
// depois pelo remetente (contato com esse e-mail -> card mais recente).
async function matchInbound({ inReplyTo, references, fromEmail }) {
  const ids = [inReplyTo, ...(references || "").split(/\s+/)].filter(Boolean);
  if (ids.length) {
    const { rows } = await query(
      `SELECT organization_id, deal_id FROM messages WHERE message_id = ANY($1) ORDER BY created_at DESC LIMIT 1`,
      [ids]
    );
    if (rows.length) return { orgId: rows[0].organization_id, dealId: rows[0].deal_id };
  }
  if (fromEmail) {
    const { rows } = await query(
      `SELECT d.organization_id, d.id AS deal_id FROM contacts ct JOIN deals d ON d.contact_id = ct.id
       WHERE lower(ct.email) = lower($1) ORDER BY d.updated_at DESC LIMIT 1`,
      [fromEmail]
    );
    if (rows.length) return { orgId: rows[0].organization_id, dealId: rows[0].deal_id };
  }
  return null;
}

module.exports = { generateDraft, approveAndSend, recordInbound, matchInbound, loadDealContext };
