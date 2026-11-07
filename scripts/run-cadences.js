// Processa as cadências vencidas. Com --watch, repete a cada N minutos (padrão 5) - uso local/servidor próprio.
// Uso: node --env-file=.env.local scripts/run-cadences.js [--watch] [--every 5] [--limit 10]
const { processDue } = require("../lib/cadence");
const { getPool } = require("../lib/db");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const WATCH = process.argv.includes("--watch");
const EVERY = Number(arg("--every", 5));
const LIMIT = Number(arg("--limit", 10));

async function once() {
  let total = 0;
  for (;;) {
    const r = await processDue({ limit: LIMIT });
    total += r.processed;
    if (r.processed) console.log(new Date().toLocaleString("pt-BR"), JSON.stringify(r));
    if (!r.remainingDue || !r.processed) break;
  }
  return total;
}

(async () => {
  if (!WATCH) {
    console.log(`Passos processados: ${await once()}`);
    await getPool().end();
    return;
  }
  console.log(`Processando cadências a cada ${EVERY} min (Ctrl+C para parar)...`);
  for (;;) {
    try {
      await once();
    } catch (err) {
      console.error(err.message || err);
    }
    await new Promise((r) => setTimeout(r, EVERY * 60_000));
  }
})();
