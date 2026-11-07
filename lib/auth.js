const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { query } = require("./db");
const { HttpError, parseCookies } = require("./http");

const COOKIE_NAME = "sdr_session";
const SESSION_HOURS = 12;
// Sessão é renovada (janela deslizante) quando falta menos que isso para expirar.
const RENEW_BELOW_HOURS = 6;
const BCRYPT_ROUNDS = 11;

const ROLES = ["admin", "gestor", "sdr"];

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

// Senha temporária legível (sem caracteres ambíguos como 0/O, 1/l).
function generateTempPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(12);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}

function validatePasswordPolicy(password) {
  if (typeof password !== "string" || password.length < 10) return "password_too_short";
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "password_needs_letters_and_numbers";
  return null;
}

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

async function verifyPassword(password, hash) {
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}

function isSecureCookie() {
  return (process.env.APP_URL || "").startsWith("https://");
}

function sessionCookie(token, maxAgeSeconds) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isSecureCookie()) parts.push("Secure");
  return parts.join("; ");
}

async function createSession(res, userId, { ip, userAgent }) {
  const token = randomToken();
  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent)
     VALUES ($1, $2, now() + make_interval(hours => $3), $4, $5)`,
    [sha256(token), userId, SESSION_HOURS, ip, (userAgent || "").slice(0, 300)]
  );
  res.setHeader("Set-Cookie", sessionCookie(token, SESSION_HOURS * 3600));
  return token;
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", sessionCookie("", 0));
}

function sessionTokenFrom(req) {
  return parseCookies(req)[COOKIE_NAME] || null;
}

// Retorna o usuário da sessão (ou null). Renova a sessão se estiver perto de expirar.
async function loadSessionUser(req, res) {
  const token = sessionTokenFrom(req);
  if (!token) return null;
  const tokenHash = sha256(token);

  const { rows } = await query(
    `SELECT s.expires_at, u.id, u.organization_id, u.name, u.email, u.role,
            u.must_change_password, o.name AS organization_name
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     JOIN organizations o ON o.id = u.organization_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`,
    [tokenHash]
  );
  if (!rows.length) return null;

  const row = rows[0];
  const hoursLeft = (new Date(row.expires_at) - Date.now()) / 3_600_000;
  if (hoursLeft < RENEW_BELOW_HOURS) {
    await query(
      `UPDATE sessions SET expires_at = now() + make_interval(hours => $2) WHERE token_hash = $1`,
      [tokenHash, SESSION_HOURS]
    );
    res.setHeader("Set-Cookie", sessionCookie(token, SESSION_HOURS * 3600));
  }

  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    name: row.name,
    email: row.email,
    role: row.role,
    mustChangePassword: row.must_change_password,
    sessionTokenHash: tokenHash,
  };
}

function requireRole(user, roles) {
  if (!user) throw new HttpError(401, "unauthorized");
  if (roles && !roles.includes(user.role)) throw new HttpError(403, "forbidden");
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    organization: { id: user.organizationId, name: user.organizationName },
  };
}

module.exports = {
  ROLES,
  sha256,
  randomToken,
  generateTempPassword,
  validatePasswordPolicy,
  hashPassword,
  verifyPassword,
  createSession,
  clearSessionCookie,
  loadSessionUser,
  requireRole,
  publicUser,
};
