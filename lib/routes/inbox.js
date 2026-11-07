// Leitura da caixa de prospecção: manual (botão, admin/gestor) ou agendada (Vercel Cron com CRON_SECRET).
const { HttpError } = require("../http");
const { audit } = require("../audit");
const { pollInbox, imapConfigured } = require("../inbox");

async function pollManual({ user, ip }) {
  if (!imapConfigured()) throw new HttpError(503, "imap_not_configured");
  const result = await pollInbox();
  await audit({ organizationId: user.organizationId, userId: user.id, action: "inbox_polled", details: { fetched: result.fetched, matched: result.matched }, ip });
  return result;
}

async function pollCron({ req }) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) throw new HttpError(401, "unauthorized");
  if (!imapConfigured()) return { ok: true, skipped: "imap_not_configured" };
  return pollInbox();
}

module.exports = [
  { method: "POST", path: "/inbox/poll", handler: pollManual, roles: ["admin", "gestor"] },
  { method: "GET", path: "/cron/inbox", handler: pollCron, public: true },
];
