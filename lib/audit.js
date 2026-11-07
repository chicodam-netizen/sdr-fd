const { query } = require("./db");

// Registro de auditoria. Falha de auditoria nunca derruba a operação principal.
async function audit({ organizationId = null, userId = null, action, entity = null, entityId = null, details = {}, ip = null }) {
  try {
    await query(
      `INSERT INTO audit_log (organization_id, user_id, action, entity, entity_id, details, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [organizationId, userId, action, entity, entityId ? String(entityId) : null, details, ip]
    );
  } catch (err) {
    console.error("audit error:", err);
  }
}

module.exports = { audit };
