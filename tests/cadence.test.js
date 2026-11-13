// Testes da Fase 5: cadências, modos de autonomia, paradas automáticas e relatórios (IA simulada).
process.env.AI_FAKE = "1";
process.env.MAIL_ENABLED = "false";
process.env.MAIL_REDIRECT_TO = "teste-redirect@teste.local";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { createServer } = require("../scripts/dev-server");
const { getPool } = require("../lib/db");
const { hashPassword } = require("../lib/auth");
const { createDefaultPipeline } = require("../lib/default-pipeline");
const { nextAllowed } = require("../lib/cadence-hooks");

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || "")) {
  throw new Error("Os testes só rodam contra banco local.");
}

const suffix = crypto.randomBytes(4).toString("hex");
const GESTOR = { email: `g6-${suffix}@teste.local`, password: "SenhaGestor123" };
const SDR = { email: `s6-${suffix}@teste.local`, password: "SenhaSdr12345" };
let server, base, orgId, gestor, sdr, pipeline;

function client() {
  let cookie = "";
  return async (method, p, body) => {
    const res = await fetch(`${base}/api${p}`, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return { status: res.status, data: await res.json() };
  };
}

const pool = () => getPool();
const run = () => gestor("POST", "/cadences/run", { limit: 20 });
// Faz o próximo passo de uma cadência vencer agora (simula a passagem dos dias).
const makeDue = (dealId) => pool().query(`UPDATE enrollments SET next_run_at = now() - interval '1 minute' WHERE deal_id = $1 AND status = 'active'`, [dealId]);
const enrollmentOf = async (dealId) => (await gestor("GET", `/deals/${dealId}/enrollment`)).data.enrollment;

async function newAgent(name, autonomy) {
  const r = await gestor("POST", "/agents", { name, senderName: "Ana", autonomy, businessHoursOnly: false, dailyLimit: 50 });
  return r.data.agent;
}
async function newDeal(name, agentId, email = `c-${crypto.randomBytes(3).toString("hex")}@lead-teste.com.br`) {
  const r = await gestor("POST", "/deals", { pipelineId: pipeline.id, company: { name }, contact: email ? { name: "Contato", email } : undefined });
  if (agentId) await gestor("PATCH", `/deals/${r.data.deal.id}`, { agentId });
  return r.data.deal;
}

before(async () => {
  orgId = (await pool().query(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [`Cadencia ${suffix}`])).rows[0].id;
  await createDefaultPipeline(pool(), orgId);
  for (const [u, role] of [[GESTOR, "gestor"], [SDR, "sdr"]]) {
    await pool().query(
      `INSERT INTO users (organization_id, name, email, password_hash, role, must_change_password) VALUES ($1, $2, $3, $4, $5, false)`,
      [orgId, role.toUpperCase(), u.email, await hashPassword(u.password), role]
    );
  }
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  gestor = client();
  sdr = client();
  await gestor("POST", "/auth/login", GESTOR);
  await sdr("POST", "/auth/login", SDR);
  pipeline = (await gestor("GET", "/pipelines")).data.pipelines[0];
});

after(async () => {
  await pool().query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
  server.close();
  await pool().end();
});

test("horário comercial: fim de semana e fora do expediente vão para o próximo dia útil 8h-9h30 (Brasília)", () => {
  const brt = (iso) => new Date(`${iso}-03:00`);
  const check = (input, expectedDay) => {
    const out = nextAllowed(brt(input), true);
    const local = new Date(out.getTime() - 3 * 3600_000);
    assert.equal(local.toISOString().slice(0, 10), expectedDay);
    assert.ok(local.getUTCHours() >= 8 && local.getUTCHours() < 10, `hora ${local.getUTCHours()}`);
  };
  check("2026-11-07T10:00:00", "2026-11-09"); // sábado -> segunda
  check("2026-11-09T19:30:00", "2026-11-10"); // segunda à noite -> terça
  check("2026-11-10T06:00:00", "2026-11-10"); // terça cedo -> mesma terça 8h
  assert.equal(nextAllowed(brt("2026-11-11T10:00:00"), true).getTime(), brt("2026-11-11T10:00:00").getTime()); // dentro do horário
  assert.equal(nextAllowed(brt("2026-11-07T10:00:00"), false).getTime(), brt("2026-11-07T10:00:00").getTime()); // sem restrição
});

test("agente novo nasce com cadência de 4 passos; edição valida e substitui os passos", async () => {
  const a = await newAgent("Agente cadência", "draft");
  const steps = (await sdr("GET", `/agents/${a.id}/cadence`)).data.steps;
  assert.deepEqual(steps.map((s) => s.delayDays), [0, 3, 7, 14]);
  assert.equal((await sdr("PUT", `/agents/${a.id}/cadence`, { steps: [{ delayDays: 0 }] })).status, 403);
  assert.equal((await gestor("PUT", `/agents/${a.id}/cadence`, { steps: [{ delayDays: -1 }] })).data.error, "invalid_delay");
  assert.equal((await gestor("PUT", `/agents/${a.id}/cadence`, { steps: [] })).data.error, "cadence_empty");
  await gestor("PUT", `/agents/${a.id}/cadence`, { steps: [{ delayDays: 0, instruction: "Abertura" }, { delayDays: 2, instruction: "Lembrete" }] });
  assert.deepEqual((await sdr("GET", `/agents/${a.id}/cadence`)).data.steps.map((s) => s.delayDays), [0, 2]);
});

test("modo rascunho: cada passo vira rascunho; aprovar agenda o próximo; sequência termina", async () => {
  const a = await newAgent("Rascunho", "draft");
  await gestor("PUT", `/agents/${a.id}/cadence`, { steps: [{ delayDays: 0 }, { delayDays: 3 }] });
  const d = await newDeal("Empresa Rascunho", a.id);
  assert.equal((await sdr("POST", `/deals/${d.id}/enroll`, {})).data.enrollment.status, "active");
  assert.equal((await sdr("POST", `/deals/${d.id}/enroll`, {})).data.error, "already_enrolled");

  const r1 = await run();
  assert.equal(r1.data.drafted, 1);
  assert.equal((await enrollmentOf(d.id)).status, "waiting_approval");
  const draft = (await gestor("GET", "/messages/pending")).data.messages.find((m) => m.dealId === d.id);
  assert.equal(draft.step, 1);
  assert.equal(draft.ai.kind, "first");

  await sdr("POST", `/messages/${draft.id}/send`, {});
  const e2 = await enrollmentOf(d.id);
  assert.equal(e2.status, "active");
  assert.equal(e2.currentStep, 2);
  const daysAhead = (new Date(e2.nextRunAt) - Date.now()) / 86_400_000;
  assert.ok(daysAhead > 2.9 && daysAhead < 3.1, `próximo passo em ${daysAhead} dias`);

  assert.equal((await run()).data.processed, 0); // ainda não venceu
  await makeDue(d.id);
  await run();
  const draft2 = (await gestor("GET", "/messages/pending")).data.messages.find((m) => m.dealId === d.id);
  assert.equal(draft2.ai.kind, "followup");
  await sdr("POST", `/messages/${draft2.id}/send`, {});
  const done = await enrollmentOf(d.id);
  assert.equal(done.status, "finished");
  assert.equal(done.stopReason, "sequence_completed");
});

test("semiautônomo: 1º passo aprovado por humano, follow-up enviado sozinho", async () => {
  const a = await newAgent("Semi", "semi");
  const d = await newDeal("Empresa Semi", a.id);
  await sdr("POST", `/deals/${d.id}/enroll`, {});
  await run();
  const first = (await gestor("GET", "/messages/pending")).data.messages.find((m) => m.dealId === d.id);
  assert.ok(first, "1º passo aguarda aprovação");
  await sdr("POST", `/messages/${first.id}/send`, {});
  await makeDue(d.id);
  const r = await run();
  assert.equal(r.data.sent, 1);
  const msgs = (await sdr("GET", `/deals/${d.id}/messages`)).data.messages.filter((m) => m.status === "sent");
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].approvedByName, null); // enviado pelo sistema
  assert.equal(msgs[1].ai.autoSent, true);
  assert.equal((await enrollmentOf(d.id)).currentStep, 3);
});

test("autônomo: envia já no 1º passo; resposta do lead para a cadência e descarta pendências", async () => {
  const a = await newAgent("Auto", "auto");
  const d = await newDeal("Empresa Auto", a.id);
  await sdr("POST", `/deals/${d.id}/enroll`, {});
  assert.equal((await run()).data.sent, 1);
  await sdr("POST", `/deals/${d.id}/messages/inbound`, { body: "Pode me ligar semana que vem para agendarmos uma reunião." });
  const e = await enrollmentOf(d.id);
  assert.equal(e.status, "replied");
  await makeDue(d.id);
  assert.equal((await run()).data.processed, 0);
});

test("resposta do lead: rascunho de resposta automático com a mensagem do lead; ausência não para a cadência", async () => {
  const a = await newAgent("Resposta", "draft");
  const d = await newDeal("Empresa Resposta", a.id);
  await sdr("POST", `/deals/${d.id}/enroll`, {});
  await run();
  const first = (await gestor("GET", "/messages/pending")).data.messages.find((m) => m.dealId === d.id);
  await sdr("POST", `/messages/${first.id}/send`, {});
  // ausência: cadência segue ativa e não gera resposta
  const ooo = await sdr("POST", `/deals/${d.id}/messages/inbound`, { body: "Estou de férias até dia 20." });
  assert.equal(ooo.data.classification.category, "out_of_office");
  assert.equal(ooo.data.replyDraftId, null);
  assert.equal((await enrollmentOf(d.id)).status, "active");
  // resposta real: cadência para e a IA deixa um rascunho de resposta em Aprovações
  const r = await sdr("POST", `/deals/${d.id}/messages/inbound`, { subject: "Re: ideia", body: "Podemos agendar uma reunião na quinta?" });
  assert.ok(r.data.replyDraftId);
  assert.equal((await enrollmentOf(d.id)).status, "replied");
  const pend = (await gestor("GET", "/messages/pending")).data.messages.filter((m) => m.dealId === d.id);
  assert.equal(pend.length, 1);
  assert.equal(pend[0].ai.kind, "reply");
  assert.match(pend[0].subject, /^Re: /);
  assert.equal(pend[0].lastInbound.category, "meeting_request");
  assert.match(pend[0].lastInbound.body, /reunião na quinta/);
  // nova resposta substitui o rascunho anterior (um pendente por card)
  await sdr("POST", `/deals/${d.id}/messages/inbound`, { body: "Pode ser às 10h?" });
  assert.equal((await gestor("GET", "/messages/pending")).data.messages.filter((m) => m.dealId === d.id).length, 1);
  // pedido de saída: sem rascunho
  const out = await sdr("POST", `/deals/${d.id}/messages/inbound`, { body: "Por favor, me remover da lista." });
  assert.equal(out.data.replyDraftId, null);
  assert.equal((await gestor("GET", "/messages/pending")).data.messages.filter((m) => m.dealId === d.id).length, 0);
  // status da automação (desligada nos testes, sem IMAP)
  const auto = await gestor("GET", "/automation");
  assert.equal(auto.data.enabled, false);
  assert.equal(auto.data.imap, false);
  assert.equal((await sdr("GET", "/automation")).status, 403);
});

test("mover para Qualificado encerra; pausar/retomar/encerrar; bloqueios de inscrição", async () => {
  const a = await newAgent("Paradas", "draft");
  const d = await newDeal("Empresa Paradas", a.id);
  await sdr("POST", `/deals/${d.id}/enroll`, {});
  const id = (await enrollmentOf(d.id)).id;
  await sdr("POST", `/enrollments/${id}/pause`, {});
  assert.equal((await enrollmentOf(d.id)).status, "paused");
  await makeDue(d.id);
  assert.equal((await run()).data.processed, 0); // pausada não roda
  await sdr("POST", `/enrollments/${id}/resume`, {});
  assert.equal((await enrollmentOf(d.id)).status, "active");
  const qualified = pipeline.stages.find((s) => s.kind === "qualified");
  await sdr("POST", `/deals/${d.id}/move`, { stageId: qualified.id });
  const e = await enrollmentOf(d.id);
  assert.equal(e.status, "finished");
  assert.equal(e.stopReason, "qualified");
  assert.equal((await sdr("POST", `/deals/${d.id}/enroll`, {})).data.error, "deal_closed");

  const noEmail = await newDeal("Sem Email", a.id, null);
  assert.equal((await sdr("POST", `/deals/${noEmail.id}/enroll`, {})).data.error, "contact_without_email");
  const noAgent = await newDeal("Sem Agente", null);
  assert.equal((await sdr("POST", `/deals/${noAgent.id}/enroll`, {})).data.error, "missing_agent");

  const d2 = await newDeal("Empresa Encerrar", a.id);
  await sdr("POST", `/deals/${d2.id}/enroll`, {});
  await run();
  await sdr("POST", `/enrollments/${(await enrollmentOf(d2.id)).id}/stop`, {});
  assert.equal((await enrollmentOf(d2.id)).status, "stopped");
  assert.equal((await gestor("GET", "/messages/pending")).data.messages.filter((m) => m.dealId === d2.id).length, 0);
});

test("descartar rascunho da cadência pausa a sequência; inscrição em lote conta os motivos", async () => {
  const a = await newAgent("Lote", "draft");
  const d = await newDeal("Empresa Descarte", a.id);
  await sdr("POST", `/deals/${d.id}/enroll`, {});
  await run();
  const draft = (await gestor("GET", "/messages/pending")).data.messages.find((m) => m.dealId === d.id);
  await sdr("POST", `/messages/${draft.id}/discard`, {});
  const e = await enrollmentOf(d.id);
  assert.equal(e.status, "paused");
  assert.equal(e.stopReason, "draft_discarded");

  const ok = await newDeal("Lote Ok", a.id);
  const sem = await newDeal("Lote Sem Email", a.id, null);
  const r = await gestor("POST", "/enrollments/bulk", { dealIds: [ok.id, sem.id, d.id] });
  assert.equal(r.data.enrolled, 1);
  assert.deepEqual(r.data.skipped, { contact_without_email: 1, already_enrolled: 1 });
});

test("relatório: funil, agentes e série diária", async () => {
  const r = (await sdr("GET", "/reports?days=7")).data;
  assert.equal(r.days, 7);
  assert.equal(r.daily.length, 7);
  assert.ok(r.funnel.created >= 8);
  assert.ok(r.funnel.contacted >= 3);
  assert.ok(r.funnel.replied >= 1);
  const auto = r.agents.find((a) => a.name === "Auto");
  assert.equal(auto.sent, 1);
  assert.equal(auto.autoSent, 1);
  assert.equal(auto.replyRate, 100);
  assert.ok(r.daily.at(-1).sent >= 4);
  assert.ok(r.categories.length >= 1);
  assert.equal(r.stages.length, pipeline.stages.length);
});
