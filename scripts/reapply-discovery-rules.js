// Reaplica as regras de limpeza atuais (lib/discovery.js -> clean) a pesquisas já gravadas:
// remove contatos de e-mail vindos da web que hoje seriam rejeitados e tira o e-mail de pessoas
// quando ele não passa na regra. Não chama a IA (sem custo).
// Uso: node --env-file=.env.local scripts/reapply-discovery-rules.js [--dry-run]
const { getPool } = require("../lib/db");
const { clean } = require("../lib/discovery");

const DRY = process.argv.includes("--dry-run");

async function main() {
  const pool = getPool();
  const { rows } = await pool.query(`SELECT id, name, discovery FROM companies WHERE discovery->'findings' IS NOT NULL AND discovery->'findings' <> 'null'::jsonb`);
  let removed = 0;
  let cleared = 0;
  for (const c of rows) {
    const raw = c.discovery.findings;
    const f = clean(raw);
    const allowed = new Set([...f.emails.map((e) => e.email), ...f.people.map((p) => p.email).filter(Boolean)]);
    const { rows: contacts } = await pool.query(
      `SELECT id, name, email, kind FROM contacts WHERE company_id = $1 AND source = 'web' AND email IS NOT NULL`,
      [c.id]
    );
    for (const ct of contacts) {
      if (allowed.has(ct.email.toLowerCase())) continue;
      if (ct.kind === "generic") {
        console.log(`${c.name}: remove canal ${ct.email}`);
        removed++;
        if (!DRY) {
          await pool.query(`UPDATE deals SET contact_id = NULL WHERE contact_id = $1`, [ct.id]);
          await pool.query(`DELETE FROM contacts WHERE id = $1`, [ct.id]);
        }
      } else {
        console.log(`${c.name}: tira e-mail de ${ct.name} (${ct.email})`);
        cleared++;
        if (!DRY) await pool.query(`UPDATE contacts SET email = NULL, updated_at = now() WHERE id = $1`, [ct.id]);
      }
    }
    if (!DRY) await pool.query(`UPDATE companies SET discovery = jsonb_set(discovery, '{findings}', $2::jsonb) WHERE id = $1`, [c.id, JSON.stringify(f)]);
  }
  console.log(`${rows.length} pesquisa(s) revisadas · canais removidos: ${removed} · e-mails de pessoas retirados: ${cleared}${DRY ? " (simulação)" : ""}`);
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
