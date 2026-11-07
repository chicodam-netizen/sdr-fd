// Aplica os arquivos SQL de db/ em ordem, cada um numa transação, registrando
// em schema_migrations (não reaplica o que já rodou).
// Por padrão só roda contra localhost. Para um banco remoto (Neon) é preciso
// --allow-remote E CONFIRM_REMOTE_MIGRATION=sim - e só depois de o plano
// exato ter sido aprovado.
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const databaseUrl = process.env.DATABASE_URL || "";
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(databaseUrl);
const allowRemote = process.argv.includes("--allow-remote") && process.env.CONFIRM_REMOTE_MIGRATION === "sim";
const dryRun = process.argv.includes("--dry-run");

if (!isLocal && !allowRemote) {
  console.error(
    "ABORTADO: DATABASE_URL não aponta para localhost. Para banco remoto use --allow-remote com CONFIRM_REMOTE_MIGRATION=sim."
  );
  process.exit(1);
}

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  console.log(`Banco: ${new URL(databaseUrl).host}${new URL(databaseUrl).pathname}${dryRun ? " (dry-run)" : ""}`);

  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const applied = new Set((await client.query(`SELECT filename FROM schema_migrations`)).rows.map((r) => r.filename));

  const dir = path.join(__dirname, "..", "db");
  const pending = fs.readdirSync(dir).filter((f) => f.endsWith(".sql") && !applied.has(f)).sort();

  if (!pending.length) console.log("Nenhuma migração pendente.");

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    if (/\bDROP\s+(TABLE|COLUMN)\b/i.test(sql)) {
      console.warn(`ATENÇÃO: ${file} contém DROP TABLE/COLUMN.`);
    }
    if (dryRun) {
      console.log(`[pendente] ${file}`);
      continue;
    }
    console.log(`Aplicando ${file}...`);
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [file]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Falha em ${file}: ${err.message}`);
    }
  }

  console.log("Migração concluída.");
  await client.end();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
