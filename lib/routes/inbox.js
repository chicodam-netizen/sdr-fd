// Leitura da caixa de prospecção: manual (botão, admin/gestor) ou agendada (Vercel Cron com CRON_SECRET).
const { HttpError } = require("../http");
const { audit } = require("../audit");
const { pollInbox, imapConfigured } = require("../inbox");
const { automationStatus, runOnce } = require("../automation");

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
  return pollInbox({ budgetMs: 25_000 });
}

async function automation() {
  return { ok: true, imap: imapConfigured(), ...automationStatus() };
}

async function automationRun({ user, ip }) {
  const r = await runOnce();
  await audit({ organizationId: user.organizationId, userId: user.id, action: "automation_run", details: { inbox: r.lastInbox, cadence: r.lastCadence }, ip });
  return { ok: true, imap: imapConfigured(), ...automationStatus() };
}

module.exports = [
  { method: "GET", path: "/automation", handler: automation, roles: ["admin", "gestor"] },
  { method: "POST", path: "/automation/run", handler: automationRun, roles: ["admin", "gestor"] },
  { method: "POST", path: "/inbox/poll", handler: pollManual, roles: ["admin", "gestor"] },
  { method: "GET", path: "/cron/inbox", handler: pollCron, public: true },
];
