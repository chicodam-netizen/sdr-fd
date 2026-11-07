// Cria a primeira organização (com o funil padrão) e o primeiro admin, se ainda não existir nenhum usuário.
// Idempotente: se já houver usuários, não faz nada.
const { getPool } = require("../lib/db");
const { hashPassword } = require("../lib/auth");
const { createDefaultPipeline } = require("../lib/default-pipeline");

async function main() {
  const { SEED_ORG_NAME, SEED_ADMIN_NAME, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD } = process.env;
  if (!SEED_ORG_NAME || !SEED_ADMIN_NAME || !SEED_ADMIN_EMAIL || !SEED_ADMIN_PASSWORD) {
    throw new Error("Defina SEED_ORG_NAME, SEED_ADMIN_NAME, SEED_ADMIN_EMAIL e SEED_ADMIN_PASSWORD no .env.local");
  }

  const pool = getPool();
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM users`);
  if (rows[0].n > 0) {
    console.log("Já existem usuários - seed ignorado.");
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const org = await client.query(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [SEED_ORG_NAME]);
    await client.query(
      `INSERT INTO users (organization_id, name, email, password_hash, role, must_change_password)
       VALUES ($1, $2, $3, $4, 'admin', true)`,
      [org.rows[0].id, SEED_ADMIN_NAME, SEED_ADMIN_EMAIL.toLowerCase(), await hashPassword(SEED_ADMIN_PASSWORD)]
    );
    await createDefaultPipeline(client, org.rows[0].id);
    await client.query("COMMIT");
    console.log(`Organização "${SEED_ORG_NAME}" e admin ${SEED_ADMIN_EMAIL} criados (senha = SEED_ADMIN_PASSWORD do .env.local).`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
