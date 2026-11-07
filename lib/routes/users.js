const { query } = require("../db");
const { HttpError } = require("../http");
const { audit } = require("../audit");
const { sendBatch } = require("../mailer");
const { inviteEmail, tempPasswordEmail } = require("../email-templates");
const { ROLES, generateTempPassword, hashPassword } = require("../auth");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function toDto(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    active: row.active,
    mustChangePassword: row.must_change_password,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

const USER_COLUMNS = `id, name, email, role, active, must_change_password, last_login_at, created_at`;

async function findInOrg(user, id) {
  const { rows } = await query(
    `SELECT ${USER_COLUMNS} FROM users WHERE id = $1 AND organization_id = $2`,
    [id, user.organizationId]
  );
  if (!rows.length) throw new HttpError(404, "not_found");
  return rows[0];
}

// Se o e-mail não saiu de fato, a senha temporária volta para o admin repassar manualmente.
function mailOutcome(mail, tempPassword) {
  return mail.sent ? { mail } : { mail, tempPassword };
}

async function list({ user }) {
  const { rows } = await query(
    `SELECT ${USER_COLUMNS} FROM users WHERE organization_id = $1 ORDER BY active DESC, name`,
    [user.organizationId]
  );
  return { ok: true, users: rows.map(toDto) };
}

async function create({ user, body, ip }) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const role = body.role;
  if (!name) throw new HttpError(400, "missing_name");
  if (!EMAIL_RE.test(email)) throw new HttpError(400, "invalid_email");
  if (!ROLES.includes(role)) throw new HttpError(400, "invalid_role");

  const exists = await query(`SELECT 1 FROM users WHERE lower(email) = $1`, [email]);
  if (exists.rowCount) throw new HttpError(409, "email_in_use");

  const tempPassword = generateTempPassword();
  const { rows } = await query(
    `INSERT INTO users (organization_id, name, email, password_hash, role, must_change_password)
     VALUES ($1, $2, $3, $4, $5, true)
     RETURNING ${USER_COLUMNS}`,
    [user.organizationId, name, email, await hashPassword(tempPassword), role]
  );
  const created = rows[0];

  const mail = await sendBatch([
    inviteEmail({ to: email, name, orgName: user.organizationName, tempPassword, appUrl: process.env.APP_URL || "" }),
  ]);
  await audit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "user_created",
    entity: "user",
    entityId: created.id,
    details: { email, role, mail },
    ip,
  });
  return { status: 201, body: { ok: true, user: toDto(created), ...mailOutcome(mail, tempPassword) } };
}

async function update({ user, params, body, ip }) {
  const target = await findInOrg(user, params.id);
  const changes = {};

  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw new HttpError(400, "missing_name");
    changes.name = name;
  }
  if (body.role !== undefined) {
    if (!ROLES.includes(body.role)) throw new HttpError(400, "invalid_role");
    if (target.id === user.id && body.role !== target.role) throw new HttpError(400, "cannot_change_own_role");
    changes.role = body.role;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") throw new HttpError(400, "invalid_active");
    if (target.id === user.id && body.active === false) throw new HttpError(400, "cannot_deactivate_self");
    changes.active = body.active;
  }
  if (!Object.keys(changes).length) throw new HttpError(400, "nothing_to_update");

  const keys = Object.keys(changes);
  const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(", ");
  const { rows } = await query(
    `UPDATE users SET ${sets}, updated_at = now() WHERE id = $1 AND organization_id = $2 RETURNING ${USER_COLUMNS}`,
    [target.id, user.organizationId, ...keys.map((k) => changes[k])]
  );

  if (changes.active === false) {
    await query(`DELETE FROM sessions WHERE user_id = $1`, [target.id]);
  }
  await audit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "user_updated",
    entity: "user",
    entityId: target.id,
    details: changes,
    ip,
  });
  return { ok: true, user: toDto(rows[0]) };
}

async function resetPassword({ user, params, ip }) {
  const target = await findInOrg(user, params.id);
  if (!target.active) throw new HttpError(400, "user_inactive");

  const tempPassword = generateTempPassword();
  await query(
    `UPDATE users SET password_hash = $2, must_change_password = true, updated_at = now() WHERE id = $1`,
    [target.id, await hashPassword(tempPassword)]
  );
  await query(`DELETE FROM sessions WHERE user_id = $1`, [target.id]);

  const mail = await sendBatch([
    tempPasswordEmail({ to: target.email, name: target.name, tempPassword, appUrl: process.env.APP_URL || "" }),
  ]);
  await audit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "user_password_reset_by_admin",
    entity: "user",
    entityId: target.id,
    details: { mail },
    ip,
  });
  return { ok: true, ...mailOutcome(mail, tempPassword) };
}

// Lista enxuta (id, nome) para escolher responsável - disponível a todos os perfis.
async function options({ user }) {
  const { rows } = await query(
    `SELECT id, name FROM users WHERE organization_id = $1 AND active ORDER BY name`,
    [user.organizationId]
  );
  return { ok: true, users: rows };
}

module.exports = [
  { method: "GET", path: "/users/options", handler: options },
  { method: "GET", path: "/users", handler: list, roles: ["admin", "gestor"] },
  { method: "POST", path: "/users", handler: create, roles: ["admin"] },
  { method: "PATCH", path: "/users/:id", handler: update, roles: ["admin"] },
  { method: "POST", path: "/users/:id/reset-password", handler: resetPassword, roles: ["admin"] },
];
