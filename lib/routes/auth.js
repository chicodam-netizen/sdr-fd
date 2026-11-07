const { query } = require("../db");
const { HttpError } = require("../http");
const { audit } = require("../audit");
const { sendBatch } = require("../mailer");
const { resetLinkEmail } = require("../email-templates");
const {
  sha256,
  randomToken,
  validatePasswordPolicy,
  hashPassword,
  verifyPassword,
  createSession,
  clearSessionCookie,
  publicUser,
} = require("../auth");

const LOGIN_WINDOW_MINUTES = 15;
const LOGIN_MAX_FAILURES = 5;
const RESET_TOKEN_HOURS = 1;

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

async function tooManyFailures(email) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM audit_log
     WHERE action = 'login_failed' AND details->>'email' = $1
       AND created_at > now() - make_interval(mins => $2)`,
    [email, LOGIN_WINDOW_MINUTES]
  );
  return rows[0].n >= LOGIN_MAX_FAILURES;
}

async function login({ req, res, body, ip }) {
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) throw new HttpError(400, "missing_credentials");

  if (await tooManyFailures(email)) throw new HttpError(429, "too_many_attempts");

  const { rows } = await query(
    `SELECT id, organization_id, password_hash, active FROM users WHERE lower(email) = $1`,
    [email]
  );
  const user = rows[0];
  const ok = user && user.active && (await verifyPassword(password, user.password_hash));

  if (!ok) {
    await audit({ organizationId: user?.organization_id, userId: user?.id, action: "login_failed", details: { email }, ip });
    throw new HttpError(401, "invalid_credentials");
  }

  await createSession(res, user.id, { ip, userAgent: req.headers["user-agent"] });
  await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
  await audit({ organizationId: user.organization_id, userId: user.id, action: "login", ip });
  return { ok: true };
}

async function logout({ res, user, ip }) {
  if (user) {
    await query(`DELETE FROM sessions WHERE token_hash = $1`, [user.sessionTokenHash]);
    await audit({ organizationId: user.organizationId, userId: user.id, action: "logout", ip });
  }
  clearSessionCookie(res);
  return { ok: true };
}

async function me({ user }) {
  if (!user) throw new HttpError(401, "unauthorized");
  return { ok: true, user: publicUser(user) };
}

async function changePassword({ user, body, ip }) {
  const { currentPassword, newPassword } = body;
  const policyError = validatePasswordPolicy(newPassword);
  if (policyError) throw new HttpError(400, policyError);

  const { rows } = await query(`SELECT password_hash FROM users WHERE id = $1`, [user.id]);
  if (!(await verifyPassword(currentPassword || "", rows[0].password_hash))) {
    throw new HttpError(400, "wrong_current_password");
  }
  if (await verifyPassword(newPassword, rows[0].password_hash)) {
    throw new HttpError(400, "password_unchanged");
  }

  await query(
    `UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1`,
    [user.id, await hashPassword(newPassword)]
  );
  // Encerra as outras sessões do usuário; mantém a atual.
  await query(`DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2`, [user.id, user.sessionTokenHash]);
  await audit({ organizationId: user.organizationId, userId: user.id, action: "password_changed", ip });
  return { ok: true };
}

// Sempre responde ok - não revela se o e-mail existe.
async function forgotPassword({ body, ip }) {
  const email = normalizeEmail(body.email);
  if (!email) throw new HttpError(400, "missing_email");

  const { rows } = await query(
    `SELECT id, organization_id, name, email FROM users WHERE lower(email) = $1 AND active`,
    [email]
  );
  const user = rows[0];
  if (user) {
    const token = randomToken();
    await query(
      `INSERT INTO password_resets (token_hash, user_id, expires_at)
       VALUES ($1, $2, now() + make_interval(hours => $3))`,
      [sha256(token), user.id, RESET_TOKEN_HOURS]
    );
    const appUrl = process.env.APP_URL || "";
    const resetUrl = `${appUrl}/#/redefinir-senha?token=${encodeURIComponent(token)}`;
    const mail = await sendBatch([resetLinkEmail({ to: user.email, name: user.name, resetUrl })]);
    await audit({
      organizationId: user.organization_id,
      userId: user.id,
      action: "password_reset_requested",
      details: { mail },
      ip,
    });
  }
  return { ok: true };
}

async function resetPassword({ body, ip }) {
  const { token, newPassword } = body;
  if (!token) throw new HttpError(400, "missing_token");
  const policyError = validatePasswordPolicy(newPassword);
  if (policyError) throw new HttpError(400, policyError);

  const { rows } = await query(
    `SELECT r.user_id, u.organization_id FROM password_resets r
     JOIN users u ON u.id = r.user_id
     WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > now() AND u.active`,
    [sha256(String(token))]
  );
  if (!rows.length) throw new HttpError(400, "invalid_or_expired_token");
  const { user_id: userId, organization_id: organizationId } = rows[0];

  await query(
    `UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1`,
    [userId, await hashPassword(newPassword)]
  );
  await query(`UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
  await query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  await audit({ organizationId, userId, action: "password_reset_completed", ip });
  return { ok: true };
}

module.exports = [
  { method: "POST", path: "/auth/login", handler: login, public: true },
  { method: "POST", path: "/auth/logout", handler: logout, public: true },
  { method: "GET", path: "/auth/me", handler: me, public: true },
  { method: "POST", path: "/auth/change-password", handler: changePassword, allowPendingPasswordChange: true },
  { method: "POST", path: "/auth/forgot-password", handler: forgotPassword, public: true },
  { method: "POST", path: "/auth/reset-password", handler: resetPassword, public: true },
];
