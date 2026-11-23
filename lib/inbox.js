// Leitura da caixa de prospecção (IMAP): olha os e-mails dos últimos IMAP_LOOKBACK_DAYS dias (padrão 7),
// associa ao card pela conversa (In-Reply-To/References) ou pelo remetente, registra, classifica com a IA
// e gera o rascunho de resposta. Não altera nada na caixa (lido/não lido fica como o usuário deixou);
// a repetição é evitada pelo Message-ID já registrado. Sem IMAP_* configurado, não faz nada.
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const { query } = require("./db");
const { matchInbound, recordInbound } = require("./conversation");

const MAX_PER_RUN = 30;
const lookbackDays = () => Math.min(60, Math.max(1, Number(process.env.IMAP_LOOKBACK_DAYS) || 7));

function imapConfigured() {
  return Boolean(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASS);
}

// Remove o texto citado da mensagem anterior (">" e "Em ..., Fulano escreveu:" / "On ... wrote:").
function extractReplyText(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  for (const line of lines) {
    if (/^\s*(Em .+escreveu:|On .+wrote:|-----\s*Original Message|De: .+|From: .+)\s*$/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").trim() || String(text || "").trim();
}

async function processParsed(parsed) {
  const fromEmail = parsed.from?.value?.[0]?.address || null;
  const references = Array.isArray(parsed.references) ? parsed.references.join(" ") : parsed.references || "";
  const match = await matchInbound({ inReplyTo: parsed.inReplyTo, references, fromEmail });
  if (!match) return { matched: false, fromEmail, subject: parsed.subject };
  const result = await recordInbound({
    orgId: match.orgId,
    userId: null,
    dealId: match.dealId,
    subject: parsed.subject,
    body: extractReplyText(parsed.text),
    fromEmail,
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    autoReply: true,
  });
  return { matched: true, dealId: match.dealId, duplicate: !!result.duplicate, category: result.classification?.category, drafted: !!result.replyDraftId };
}

async function alreadyRecorded(messageIds) {
  if (!messageIds.length) return new Set();
  const { rows } = await query(`SELECT message_id FROM messages WHERE message_id = ANY($1)`, [messageIds]);
  return new Set(rows.map((r) => r.message_id));
}

// budgetMs: tempo máximo para começar a processar respostas (funções serverless têm limite
// de duração). O que sobrar fica para a próxima execução (não é marcado como registrado).
async function pollInbox({ budgetMs = 0 } = {}) {
  if (!imapConfigured()) return { ok: false, error: "imap_not_configured" };
  const deadline = budgetMs ? Date.now() + budgetMs : Infinity;
  const own = String(process.env.IMAP_USER || "").toLowerCase();
  const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: Number(process.env.IMAP_PORT) || 993,
    secure: true,
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS },
    logger: false,
  });
  const summary = { ok: true, scanned: 0, fetched: 0, matched: 0, drafted: 0, ignored: 0 };
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const since = new Date(Date.now() - lookbackDays() * 86400000);
    const uids = (await client.search({ since }, { uid: true })) || [];
    // 1ª passada: só cabeçalhos, para descobrir quais são de leads e ainda não foram registrados.
    const heads = [];
    if (uids.length) {
      for await (const m of client.fetch(uids, { envelope: true, headers: ["references"] }, { uid: true })) {
        heads.push({
          uid: m.uid,
          messageId: m.envelope?.messageId || null,
          inReplyTo: m.envelope?.inReplyTo || null,
          references: m.headers ? m.headers.toString().replace(/^references:s*/i, "").replace(/s+/g, " ").trim() : "",
          fromEmail: m.envelope?.from?.[0]?.address || null,
        });
      }
    }
    summary.scanned = heads.length;
    const known = await alreadyRecorded(heads.map((h) => h.messageId).filter(Boolean));
    const todo = [];
    for (const h of heads) {
      if (h.messageId && known.has(h.messageId)) continue;
      if (!h.fromEmail || h.fromEmail.toLowerCase() === own) continue;
      if (await matchInbound({ inReplyTo: h.inReplyTo, references: h.references, fromEmail: h.fromEmail })) todo.push(h);
      else summary.ignored++;
    }
    // 2ª passada: baixa e processa só as respostas de leads (mais antigas primeiro).
    let done = 0;
    for (const h of todo.slice(0, MAX_PER_RUN)) {
      if (Date.now() > deadline) break;
      done++;
      const msg = await client.fetchOne(h.uid, { source: true }, { uid: true });
      const parsed = await simpleParser(msg.source);
      summary.fetched++;
      const r = await processParsed(parsed);
      if (r.matched && !r.duplicate) summary.matched++;
      if (r.drafted) summary.drafted++;
    }
    summary.remaining = Math.max(0, todo.length - done);
  } finally {
    lock.release();
    await client.logout();
  }
  return summary;
}

module.exports = { pollInbox, processParsed, extractReplyText, imapConfigured };
