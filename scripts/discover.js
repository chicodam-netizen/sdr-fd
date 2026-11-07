// Busca de contatos na web em lote (piloto / execução em segundo plano).
// Uso: node --env-file=.env.local scripts/discover.js --list "Lista de trabalho RMBH" --limit 50 [--min-employees 40] [--order priority]
// Processa só empresas ainda não pesquisadas; imprime o resultado de cada uma e o custo total.
const { getPool } = require("../lib/db");
const { discoverCompany } = require("../lib/discovery");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const ORG = arg("--org", "FD Consultoria");
const LIST = arg("--list", null);
const LIMIT = Math.min(500, Number(arg("--limit", 10)));
const MIN_EMP = Number(arg("--min-employees", 0));
const ORDER = arg("--order", "priority") === "employees" ? "employees DESC NULLS LAST" : "priority DESC NULLS LAST, employees DESC NULLS LAST";

async function main() {
  const pool = getPool();
  const { rows: orgs } = await pool.query(`SELECT id FROM organizations WHERE name = $1`, [ORG]);
  if (!orgs.length) throw new Error(`Organização "${ORG}" não encontrada.`);
  const orgId = orgs[0].id;
  const params = [orgId];
  let where = "organization_id = $1 AND discovered_at IS NULL";
  if (LIST) {
    params.push(LIST);
    where += ` AND $${params.length} = ANY(lists)`;
  }
  if (MIN_EMP) {
    params.push(MIN_EMP);
    where += ` AND employees >= $${params.length}`;
  }
  const { rows } = await pool.query(`SELECT id, name, city, employees FROM companies WHERE ${where} ORDER BY ${ORDER} LIMIT ${LIMIT}`, params);
  console.log(`${rows.length} empresa(s) a pesquisar.`);

  const totals = { done: 0, failed: 0, cost: 0, withEmail: 0, withPeople: 0, withSite: 0, low: 0, contacts: 0 };
  const t0 = Date.now();
  for (const [i, c] of rows.entries()) {
    try {
      const r = await discoverCompany(orgId, c.id);
      totals.done++;
      totals.cost += r.costUsd;
      totals.contacts += r.contactsCreated;
      if (r.confidence === "baixa") totals.low++;
      if (r.emails || r.receitaEmail) totals.withEmail++;
      if (r.people) totals.withPeople++;
      if (r.website) totals.withSite++;
      console.log(`[${i + 1}/${rows.length}] ${c.name} (${c.city}, ${c.employees} func.) · conf=${r.confidence} site=${r.website ? "sim" : "não"} e-mails=${r.emails}${r.receitaEmail ? "+receita" : ""} pessoas=${r.people} contatos novos=${r.contactsCreated} · US$ ${r.costUsd}`);
    } catch (err) {
      totals.failed++;
      console.log(`[${i + 1}/${rows.length}] ${c.name}: ERRO ${err.code || err.message}`);
      if (err.code === "ai_rate_limited") await new Promise((r) => setTimeout(r, 30_000));
    }
  }
  const n = totals.done || 1;
  console.log("\n=== Resumo ===");
  console.log(`Pesquisadas: ${totals.done} · falhas: ${totals.failed} · tempo: ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`Com site: ${totals.withSite} (${Math.round((totals.withSite / n) * 100)}%) · com e-mail (web ou Receita): ${totals.withEmail} (${Math.round((totals.withEmail / n) * 100)}%) · com decisor: ${totals.withPeople} (${Math.round((totals.withPeople / n) * 100)}%) · confiança baixa: ${totals.low}`);
  console.log(`Contatos criados: ${totals.contacts} · custo total: US$ ${totals.cost.toFixed(2)} · média US$ ${(totals.cost / n).toFixed(4)} por empresa`);
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
