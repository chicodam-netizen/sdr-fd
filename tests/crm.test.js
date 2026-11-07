// Testes de integração do CRM (funis, cards, empresas, importação) contra o banco LOCAL.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { createServer } = require("../scripts/dev-server");
const { getPool } = require("../lib/db");
const { hashPassword } = require("../lib/auth");
const { createDefaultPipeline } = require("../lib/default-pipeline");

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || "")) {
  throw new Error("Os testes só rodam contra banco local.");
}

const suffix = crypto.randomBytes(4).toString("hex");
const GESTOR = { email: `gestor-${suffix}@teste.local`, password: "SenhaGestor123" };
const SDR = { email: `sdr2-${suffix}@teste.local`, password: "SenhaSdr12345" };
let server, base, orgId, otherOrgId, gestor, sdr, pipeline;

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

before(async () => {
  const pool = getPool();
  orgId = (await pool.query(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [`CRM ${suffix}`])).rows[0].id;
  otherOrgId = (await pool.query(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [`Outra ${suffix}`])).rows[0].id;
  await createDefaultPipeline(pool, orgId);
  await createDefaultPipeline(pool, otherOrgId);
  for (const [u, role] of [[GESTOR, "gestor"], [SDR, "sdr"]]) {
    await pool.query(
      `INSERT INTO users (organization_id, name, email, password_hash, role, must_change_password)
       VALUES ($1, $2, $3, $4, $5, false)`,
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
  await getPool().query(`DELETE FROM organizations WHERE id = ANY($1)`, [[orgId, otherOrgId]]);
  server.close();
  await getPool().end();
});

test("funil padrão vem com 6 etapas ordenadas", () => {
  assert.equal(pipeline.name, "Prospecção");
  assert.deepEqual(pipeline.stages.map((s) => s.position), [1, 2, 3, 4, 5, 6]);
  assert.equal(pipeline.stages[4].kind, "qualified");
});

test("SDR cria card com empresa e contato; CNPJ é normalizado", async () => {
  const res = await sdr("POST", "/deals", {
    pipelineId: pipeline.id,
    company: { name: "Acme Ltda", cnpj: "12.345.678/0001-90", uf: "mg" },
    contact: { name: "Ana", email: "Ana@Acme.com.br" },
    value: "1.500,50",
  });
  assert.equal(res.status, 201);
  const d = res.data.deal;
  assert.equal(d.stageId, pipeline.stages[0].id);
  assert.equal(d.company.cnpj, "12345678000190");
  assert.equal(d.company.uf, "MG");
  assert.equal(d.contact.email, "ana@acme.com.br");
  assert.equal(d.value, 1500.5);
  assert.equal(d.owner.name, "SDR");

  const bad = await sdr("POST", "/deals", { pipelineId: pipeline.id, company: { name: "X", cnpj: "123" } });
  assert.equal(bad.data.error, "invalid_cnpj");
});

test("mover card entre etapas registra histórico e respeita a ordem", async () => {
  const mk = async (name) =>
    (await gestor("POST", "/deals", { pipelineId: pipeline.id, company: { name } })).data.deal;
  const a = await mk("Alfa");
  const b = await mk("Beta");
  const c = await mk("Gama");
  const target = pipeline.stages[2].id;

  await gestor("POST", `/deals/${a.id}/move`, { stageId: target });
  await gestor("POST", `/deals/${b.id}/move`, { stageId: target, beforeId: a.id });
  // Gama entra entre Alfa e Beta
  const moved = await gestor("POST", `/deals/${c.id}/move`, { stageId: target, beforeId: a.id, afterId: b.id });
  assert.equal(moved.status, 200);

  const list = (await gestor("GET", `/deals?pipelineId=${pipeline.id}`)).data.deals.filter((d) => d.stageId === target);
  assert.deepEqual(list.map((d) => d.company.name), ["Alfa", "Gama", "Beta"]);

  const detail = (await gestor("GET", `/deals/${c.id}`)).data;
  const change = detail.activities.find((x) => x.type === "stage_change");
  assert.equal(change.meta.from, "Novo lead");
  assert.equal(change.meta.to, "Primeiro contato");

  const otherPipeline = (await getPool().query(`SELECT id FROM stages WHERE organization_id = $1 LIMIT 1`, [otherOrgId])).rows[0].id;
  assert.equal((await gestor("POST", `/deals/${a.id}/move`, { stageId: otherPipeline })).status, 404);
});

test("anotação aparece no histórico; busca encontra por contato", async () => {
  const deal = (await gestor("GET", `/deals?pipelineId=${pipeline.id}&q=ana@acme`)).data.deals;
  assert.equal(deal.length, 1);
  await sdr("POST", `/deals/${deal[0].id}/notes`, { body: "Ligar na terça" });
  const acts = (await sdr("GET", `/deals/${deal[0].id}`)).data.activities;
  assert.equal(acts[0].type, "note");
  assert.equal(acts[0].body, "Ligar na terça");
});

test("configuração do funil: só gestor/admin; etapa com cards não pode ser apagada", async () => {
  assert.equal((await sdr("POST", `/pipelines/${pipeline.id}/stages`, { name: "X" })).status, 403);

  const added = await gestor("POST", `/pipelines/${pipeline.id}/stages`, { name: "Reunião agendada", color: "#123abc" });
  assert.equal(added.status, 201);
  assert.equal(added.data.stage.position, 7);

  const ids = [added.data.stage.id, ...pipeline.stages.map((s) => s.id)];
  assert.equal((await gestor("POST", `/pipelines/${pipeline.id}/stages/reorder`, { order: ids })).status, 200);
  const reloaded = (await gestor("GET", "/pipelines")).data.pipelines[0];
  assert.equal(reloaded.stages[0].name, "Reunião agendada");

  assert.equal((await gestor("DELETE", `/stages/${pipeline.stages[0].id}`, {})).data.error, "stage_not_empty");
  assert.equal((await gestor("DELETE", `/stages/${added.data.stage.id}`, {})).status, 200);
  assert.equal((await gestor("POST", `/pipelines/${pipeline.id}/archive`, {})).data.error, "last_pipeline");
});

test("importação: cria, deduplica por CNPJ e relata linhas inválidas", async () => {
  const stageId = pipeline.stages[0].id;
  const res = await gestor("POST", "/import/deals", {
    pipelineId: pipeline.id,
    stageId,
    fileName: "leads.csv",
    rows: [
      { company: { name: "Nova SA", cnpj: "11222333000144" }, contact: { name: "Bia", email: "bia@nova.com" } },
      { company: { name: "Nova S/A (dup)", cnpj: "11.222.333/0001-44" } },
      { company: { name: "Acme Ltda", cnpj: "12345678000190" } },
      { company: { name: "" } },
      { company: { name: "Sem CNPJ" }, contact: { email: "invalido" } },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.created, 1);
  assert.equal(res.data.alreadyInPipeline, 2); // dup no próprio arquivo + Acme já no funil
  assert.deepEqual(res.data.errors.map((e) => e.line), [4, 5]);

  assert.equal((await sdr("POST", "/import/deals", { pipelineId: pipeline.id, stageId, rows: [{ company: { name: "Z" } }] })).status, 403);

  const companies = (await sdr("GET", "/companies?q=nova")).data.companies;
  assert.equal(companies.length, 1);
  assert.equal(companies[0].source, "csv");
  assert.equal(companies[0].sourceDetail, "leads.csv");
});

test("opt-out de contato e dashboard", async () => {
  const co = (await gestor("GET", "/companies?q=acme")).data.companies[0];
  const detail = (await gestor("GET", `/companies/${co.id}`)).data;
  const ct = detail.contacts[0];
  assert.equal((await gestor("PATCH", `/contacts/${ct.id}`, { name: ct.name, email: ct.email, optOut: true })).status, 200);
  assert.equal((await gestor("GET", `/companies/${co.id}`)).data.contacts[0].optOut, true);

  const deal = (await gestor("GET", `/deals?pipelineId=${pipeline.id}&q=acme`)).data.deals[0];
  const qualified = pipeline.stages.find((s) => s.kind === "qualified").id;
  await gestor("POST", `/deals/${deal.id}/move`, { stageId: qualified });
  const s = (await sdr("GET", "/dashboard")).data.summary;
  assert.equal(s.qualified, 1);
  assert.equal(s.open, 4);
});

test("SDR não exclui card; gestor exclui", async () => {
  const deal = (await gestor("GET", `/deals?pipelineId=${pipeline.id}&q=gama`)).data.deals[0];
  assert.equal((await sdr("DELETE", `/deals/${deal.id}`, {})).status, 403);
  assert.equal((await gestor("DELETE", `/deals/${deal.id}`, {})).status, 200);
  assert.equal((await gestor("GET", `/deals/${deal.id}`)).status, 404);
});
