// Testes da Fase 3 (agentes, rascunhos, envio aprovado, respostas) com IA simulada (AI_FAKE=1).
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
const { processParsed, extractReplyText } = require("../lib/inbox");

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || "")) {
  throw new Error("Os testes só rodam contra banco local.");
}

const suffix = crypto.randomBytes(4).toString("hex");
const GESTOR = { email: `g3-${suffix}@teste.local`, password: "SenhaGestor123" };
const SDR = { email: `s3-${suffix}@teste.local`, password: "SenhaSdr12345" };
let server, base, orgId, gestor, sdr, pipeline, agent;

function client() {
  let cookie = "";
  return async (method, path, body) => {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: res.status, data: await res.json() };
  };
}

async function newDeal(name, email) {
  const r = await gestor("POST", "/deals", {
    pipelineId: pipeline.id,
    company: { name, segment: "Indústria", city: "Contagem", uf: "MG" },
    contact: { name: "Contato " + name, email },
  });
  return r.data.deal;
}

before(async () => {
  const pool = getPool();
  orgId = (await pool.query(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [`Agentes ${suffix}`])).rows[0].id;
  await createDefaultPipeline(pool, orgId);
  for (const [u, role] of [[GESTOR, "gestor"], [SDR, "sdr"]]) {
    await pool.query(
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
  await getPool().query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
  server.close();
  await getPool().end();
});

test("só gestor/admin cria agente; autonomia só em modo rascunho", async () => {
  const payload = { name: "Ana SDR", senderName: "Ana", senderTitle: "Consultora", objective: "Agendar diagnóstico", dailyLimit: 2 };
  assert.equal((await sdr("POST", "/agents", payload)).status, 403);
  const r = await gestor("POST", "/agents", payload);
  assert.equal(r.status, 201);
  agent = r.data.agent;
  assert.equal(agent.autonomy, "draft");
  assert.equal((await gestor("PATCH", `/agents/${agent.id}`, { autonomy: "auto" })).data.error, "autonomy_not_available");
});

test("base de conhecimento: compartilhada + do agente aparecem na ficha do agente", async () => {
  await gestor("POST", "/knowledge", { title: "Sobre a empresa", content: "Consultoria em dados." });
  await gestor("POST", "/knowledge", { agentId: agent.id, title: "Oferta", content: "Diagnóstico gratuito de 30 min." });
  const r = await sdr("GET", `/agents/${agent.id}`);
  assert.deepEqual(r.data.knowledge.map((k) => k.title), ["Sobre a empresa", "Oferta"]);
  assert.equal((await sdr("POST", "/knowledge", { title: "X", content: "Y" })).status, 403);
});

test("rascunho com IA -> edição -> aprovação e envio desviado para o e-mail de teste", async () => {
  const deal = await newDeal("Fundição Alfa", `compras-${suffix}@alfa-teste.com.br`);
  assert.equal((await sdr("POST", `/deals/${deal.id}/messages/draft`, {})).data.error, "missing_agent");

  const d = await sdr("POST", `/deals/${deal.id}/messages/draft`, { agentId: agent.id });
  assert.equal(d.status, 201);
  assert.equal(d.data.message.status, "draft");
  assert.equal(d.data.message.ai.kind, "first");
  assert.match(d.data.message.subject, /Fundição Alfa/);

  // card passa a ter o agente
  assert.equal((await sdr("GET", `/deals/${deal.id}`)).data.deal.agent.id, agent.id);

  const edited = await sdr("PATCH", `/messages/${d.data.message.id}`, { subject: "Assunto revisado", body: "Corpo revisado" });
  assert.equal(edited.data.message.ai.edited, true);

  const pending = (await gestor("GET", "/messages/pending")).data.messages;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].company, "Fundição Alfa");

  const sent = await sdr("POST", `/messages/${d.data.message.id}/send`, {});
  assert.equal(sent.status, 200);
  assert.equal(sent.data.simulated, true);
  assert.equal(sent.data.deliveredTo, "teste-redirect@teste.local");
  assert.equal(sent.data.message.status, "sent");
  assert.equal(sent.data.message.toEmail, `compras-${suffix}@alfa-teste.com.br`);
  assert.equal((await sdr("POST", `/messages/${d.data.message.id}/send`, {})).data.error, "message_not_draft");

  // próximo rascunho é follow-up
  const f = await sdr("POST", `/deals/${deal.id}/messages/draft`, {});
  assert.equal(f.data.message.ai.kind, "followup");
  await sdr("POST", `/messages/${f.data.message.id}/discard`, {});
});

test("resposta recebida (manual) é classificada; reunião sugere qualificado", async () => {
  const deal = (await gestor("GET", `/deals?pipelineId=${pipeline.id}&q=alfa`)).data.deals[0];
  const r = await sdr("POST", `/deals/${deal.id}/messages/inbound`, { body: "Oi, podemos agendar uma reunião na quinta?" });
  assert.equal(r.status, 201);
  assert.equal(r.data.classification.category, "meeting_request");
  assert.equal(r.data.classification.suggested_stage_kind, "qualified");

  const d = await sdr("POST", `/deals/${deal.id}/messages/draft`, {});
  assert.equal(d.data.message.ai.kind, "reply");
  assert.match(d.data.message.subject, /^Re: /);
});

test("e-mail recebido via caixa: casa pelo In-Reply-To; SAIR marca opt-out e bloqueia novos envios", async () => {
  const deal = (await gestor("GET", `/deals?pipelineId=${pipeline.id}&q=alfa`)).data.deals[0];
  const { rows } = await getPool().query(`SELECT message_id FROM messages WHERE deal_id = $1 AND status = 'sent'`, [deal.id]);
  const r = await processParsed({
    from: { value: [{ address: "qualquer@gmail.com" }] },
    subject: "Re: Assunto revisado",
    text: "SAIR\n\nEm 07/11/2026, Ana escreveu:\n> Corpo revisado",
    messageId: `<in-${suffix}@gmail.com>`,
    inReplyTo: rows[0].message_id,
  });
  assert.equal(r.matched, true);
  assert.equal(r.category, "unsubscribe");

  const detail = (await sdr("GET", `/deals/${deal.id}`)).data;
  assert.equal(detail.deal.contact.optOut, true);
  assert.equal((await sdr("GET", "/messages/pending")).data.messages.length, 0); // rascunho pendente descartado
  assert.equal((await sdr("POST", `/deals/${deal.id}/messages/draft`, {})).data.error, "contact_opted_out");

  const again = await processParsed({ from: { value: [{ address: "x@y.com" }] }, subject: "s", text: "t", messageId: `<in-${suffix}@gmail.com>`, inReplyTo: rows[0].message_id });
  assert.equal(again.duplicate, true);

  const none = await processParsed({ from: { value: [{ address: `ninguem-${suffix}@x.com` }] }, subject: "s", text: "t" });
  assert.equal(none.matched, false);
});

test("limite diário do agente e contato sem e-mail", async () => {
  const d1 = await newDeal("Beta Ltda", `b-${suffix}@beta-teste.com.br`);
  const m1 = (await sdr("POST", `/deals/${d1.id}/messages/draft`, { agentId: agent.id })).data.message;
  assert.equal((await sdr("POST", `/messages/${m1.id}/send`, {})).status, 200); // 2º envio do dia (limite 2)

  const d2 = await newDeal("Gama Ltda", `g-${suffix}@gama-teste.com.br`);
  const m2 = (await sdr("POST", `/deals/${d2.id}/messages/draft`, { agentId: agent.id })).data.message;
  assert.equal((await sdr("POST", `/messages/${m2.id}/send`, {})).data.error, "daily_limit_reached");

  const d3 = (await gestor("POST", "/deals", { pipelineId: pipeline.id, company: { name: "Sem Email SA" } })).data.deal;
  const m3 = (await sdr("POST", `/deals/${d3.id}/messages/draft`, { agentId: agent.id })).data.message;
  assert.equal((await sdr("POST", `/messages/${m3.id}/send`, {})).data.error, "contact_without_email");

  const list = (await sdr("GET", "/agents")).data.agents[0];
  assert.equal(list.sentToday, 2);
});

test("remoção do texto citado nas respostas", () => {
  assert.equal(extractReplyText("Tenho interesse.\n\nOn Mon, Nov 9, 2026 at 10:00 AM Ana wrote:\n> Olá"), "Tenho interesse.");
  assert.equal(extractReplyText("> só citação"), "> só citação");
});
