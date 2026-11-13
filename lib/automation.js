// Automação contínua (servidor local / servidor sempre ligado): a cada AUTOMATION_INTERVAL_MIN minutos
// (padrão 10) lê a caixa de entrada e processa os passos de cadência vencidos.
// Liga com AUTOMATION_ENABLED=true. Na Vercel o equivalente são as rotas /api/cron/* chamadas pelo agendador.
// Nada é enviado sem passar pela autonomia de cada agente: em "Rascunho", tudo para em Aprovações.
const { pollInbox, imapConfigured } = require("./inbox");
const { processDue } = require("./cadence");

const status = { enabled: false, intervalMin: null, running: false, lastRunAt: null, nextRunAt: null, lastInbox: null, lastCadence: null, lastError: null };
let timer = null;

function automationEnabled() {
  return process.env.AUTOMATION_ENABLED === "true";
}

async function runOnce() {
  if (status.running) return status;
  status.running = true;
  status.lastError = null;
  try {
    if (imapConfigured()) {
      try {
        status.lastInbox = await pollInbox();
      } catch (err) {
        status.lastInbox = { ok: false, error: err.code || err.message };
        console.error("automação: caixa de entrada", err.message || err);
      }
    } else {
      status.lastInbox = { ok: false, error: "imap_not_configured" };
    }
    // Cadência: em lotes pequenos (cada passo usa a IA) até esvaziar o que venceu, com teto por rodada.
    const total = { processed: 0, sent: 0, drafted: 0, errors: 0 };
    for (let i = 0; i < 10; i++) {
      const r = await processDue({ limit: 5 });
      for (const k of Object.keys(total)) total[k] += r[k] || 0;
      if (!r.processed || !r.remainingDue) break;
    }
    status.lastCadence = total;
  } catch (err) {
    status.lastError = err.code || err.message || String(err);
    console.error("automação:", err);
  } finally {
    status.running = false;
    status.lastRunAt = new Date().toISOString();
    if (status.enabled) status.nextRunAt = new Date(Date.now() + status.intervalMin * 60000).toISOString();
  }
  const ib = status.lastInbox;
  const cd = status.lastCadence;
  console.log(
    `[automação ${status.lastRunAt}] caixa: ${ib?.ok ? `${ib.scanned} lidos, ${ib.matched} respostas de leads, ${ib.drafted} rascunhos` : ib?.error}` +
      ` | cadência: ${cd ? `${cd.processed} passos (${cd.drafted} rascunhos, ${cd.sent} enviados)` : "-"}`
  );
  return status;
}

function startAutomation() {
  if (!automationEnabled() || timer) return false;
  status.enabled = true;
  status.intervalMin = Math.min(120, Math.max(2, Number(process.env.AUTOMATION_INTERVAL_MIN) || 10));
  // Primeira rodada 30 s após subir (dá tempo do banco/servidor estabilizarem).
  status.nextRunAt = new Date(Date.now() + 30000).toISOString();
  setTimeout(runOnce, 30000).unref?.();
  timer = setInterval(runOnce, status.intervalMin * 60000);
  timer.unref?.();
  return true;
}

function automationStatus() {
  return { ...status };
}

module.exports = { startAutomation, runOnce, automationStatus, automationEnabled };
