// Leitura da caixa de prospecção (IMAP): busca e-mails não lidos, associa ao card pela
// conversa (In-Reply-To/References) ou pelo remetente, registra e classifica com a IA.
// Sem IMAP_* configurado, não faz nada.
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const { matchInbound, recordInbound } = require("./conversation");

const MAX_PER_RUN = 50;

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
  });
  return { matched: true, dealId: match.dealId, duplicate: !!result.duplicate, category: result.classification?.category };
}

async function pollInbox() {
  if (!imapConfigured()) return { ok: false, error: "imap_not_configured" };
  const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: Number(process.env.IMAP_PORT) || 993,
    secure: true,
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS },
    logger: false,
  });
  const summary = { ok: true, fetched: 0, matched: 0, unmatched: [] };
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const uids = (await client.search({ seen: false }, { uid: true })) || [];
    for (const uid of uids.slice(0, MAX_PER_RUN)) {
      const msg = await client.fetchOne(uid, { source: true }, { uid: true });
      const parsed = await simpleParser(msg.source);
      summary.fetched++;
      const r = await processParsed(parsed);
      if (r.matched) {
        summary.matched++;
        // Só marca como lido o que foi associado a um card; o resto fica para um humano olhar.
        await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
      } else {
        summary.unmatched.push({ from: r.fromEmail, subject: r.subject });
      }
    }
  } finally {
    lock.release();
    await client.logout();
  }
  return summary;
}

module.exports = { pollInbox, processParsed, extractReplyText, imapConfigured };
