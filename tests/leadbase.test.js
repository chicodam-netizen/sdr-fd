// Testes da base de leads em escala e da busca de contatos na web (IA simulada, sem custo).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { createServer } = require("../scripts/dev-server");
const { getPool } = require("../lib/db");
const { hashPassword } = require("../lib/auth");
const { createDefaultPipeline } = require("../lib/default-pipeline");
const discovery = require("../lib/discovery");
const enrich = require("../lib/enrich");

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || "")) {
  throw new Error("Os testes só rodam contra banco local.");
}

const suffix = crypto.randomBytes(4).toString("hex");
const GESTOR = { email: `g5-${suffix}@teste.local`, password: "SenhaGestor123" };
const SDR = { email: `s5-${suffix}@teste.local`, password: "SenhaSdr12345" };
let server, base, orgId, gestor, sdr, pipeline, ids;

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

// Simula a API da Anthropic: 1ª chamada pausa (pause_turn), 2ª devolve save_findings.
function fakeClaude(findings) {
  const calls = [];
  discovery.setCreate(async (params) => {
    calls.push(params);
    const usage = { input_tokens: 10000, output_tokens: 1000, server_tool_use: { web_search_requests: 1 } };
    if (calls.length % 2 === 1) return { stop_reason: "pause_turn", content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: {} }], usage };
    return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "save_findings", input: findings }], usage };
  });
  return calls;
}

before(async () => {
  const pool = getPool();
  orgId = (await pool.query(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [`Base ${suffix}`])).rows[0].id;
  await createDefaultPipeline(pool, orgId);
  for (const [u, role] of [[GESTOR, "gestor"], [SDR, "sdr"]]) {
    await pool.query(
      `INSERT INTO users (organization_id, name, email, password_hash, role, must_change_password) VALUES ($1, $2, $3, $4, $5, false)`,
      [orgId, role.toUpperCase(), u.email, await hashPassword(u.password), role]
    );
  }
  const rows = [
    ["Metalurgica Um", "Contagem", 80, 24, ["Mercado RMBH", "Lista de trabalho RMBH"]],
    ["Padaria Dois", "Belo Horizonte", 5, null, ["Mercado RMBH"]],
    ["Fundicao Tres", "Betim", 45, 7.3, ["Mercado RMBH", "Lista de trabalho RMBH"]],
  ];
  ids = [];
  for (const [i, [name, city, emp, pri, lists]] of rows.entries()) {
    const r = await pool.query(
      `INSERT INTO companies (organization_id, name, cnpj, city, uf, employees, priority, lists, source, enriched_at, enrichment)
       VALUES ($1, $2, $3, $4, 'MG', $5, $6, $7, 'planilha', now(), $8) RETURNING id`,
      [orgId, name, `880000${i}0000100`.slice(0, 14), city, emp, pri, lists, { source: "receita_local", email: i === 0 ? `fiscal-${suffix}@contabil-teste.com.br` : null }]
    );
    ids.push(r.rows[0].id);
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
  discovery.setCreate(null);
  enrich.setFetch((...a) => fetch(...a));
  await getPool().query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
  server.close();
  await getPool().end();
});

test("filtros da base: lista, cidade, funcionários, ordem por prioridade e facetas", async () => {
  const all = (await sdr("GET", "/leadbase?order=priority")).data;
  assert.equal(all.total, 3);
  assert.deepEqual(all.companies.map((c) => c.name), ["Metalurgica Um", "Fundicao Tres", "Padaria Dois"]);
  assert.equal((await sdr("GET", `/leadbase?list=${encodeURIComponent("Lista de trabalho RMBH")}`)).data.total, 2);
  assert.equal((await sdr("GET", "/leadbase?minEmployees=40&maxEmployees=60")).data.companies[0].name, "Fundicao Tres");
  assert.equal((await sdr("GET", "/leadbase?city=Betim")).data.total, 1);
  assert.equal((await sdr("GET", "/leadbase?discovered=no")).data.total, 3);
  const f = (await sdr("GET", "/leadbase/facets")).data;
  assert.ok(f.lists.some((l) => l.list === "Lista de trabalho RMBH" && l.n === 2));
});

test("segmento: filtro, facetas e edição pela ficha preservam o valor", async () => {
  await getPool().query(`UPDATE companies SET sector = 'Metalurgia' WHERE id = ANY($1)`, [[ids[0], ids[2]]]);
  await getPool().query(`UPDATE companies SET sector = 'Fabricação de Produtos Alimentícios' WHERE id = $1`, [ids[1]]);
  const r = (await sdr("GET", `/leadbase?sector=${encodeURIComponent("Metalurgia")}`)).data;
  assert.equal(r.total, 2);
  assert.ok(r.companies.every((c) => c.sector === "Metalurgia"));
  const f = (await sdr("GET", "/leadbase/facets")).data;
  assert.deepEqual(f.sectors.map((s) => [s.sector, s.n]), [["Fabricação de Produtos Alimentícios", 1], ["Metalurgia", 2]]);
  // a ficha envia o segmento junto; trocar só o nome mantém o segmento
  const co = (await gestor("GET", `/companies/${ids[1]}`)).data.company;
  assert.equal(co.sector, "Fabricação de Produtos Alimentícios");
  await gestor("PATCH", `/companies/${ids[1]}`, { name: co.name, sector: co.sector, city: co.city, uf: co.uf });
  assert.equal((await gestor("GET", `/companies/${ids[1]}`)).data.company.sector, "Fabricação de Produtos Alimentícios");
});

test("busca de contatos: retoma pause_turn, grava canais e decisores com fonte e calcula custo", async () => {
  const calls = fakeClaude({
    website: "https://metalurgicaum-teste.com.br",
    emails: [
      { email: "Comercial@MetalurgicaUm-teste.com.br", label: "comercial", source_url: "https://metalurgicaum-teste.com.br/contato" },
      { email: "invalido", label: "x", source_url: "https://x.com" },
      { email: "sem-fonte@x.com", label: "x", source_url: "nao-e-url" },
    ],
    phones: [{ phone: "(31) 3333-4444", label: "geral", source_url: "https://metalurgicaum-teste.com.br/contato" }],
    linkedin_company_url: "https://www.linkedin.com/company/metalurgica-um-teste",
    instagram_url: null,
    people: [{ name: "Maria Silva", role: "Diretora Industrial", email: null, linkedin_url: "https://www.linkedin.com/in/maria-teste", source_url: "https://metalurgicaum-teste.com.br/quem-somos" }],
    confidence: "alta",
    notes: "ok",
  });
  assert.equal((await sdr("POST", `/companies/${ids[0]}/discover`, {})).status, 403);
  const r = await gestor("POST", `/companies/${ids[0]}/discover`, {});
  assert.equal(r.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].messages.at(-1).role, "assistant"); // retomada sem "continue" extra
  const x = r.data.result;
  assert.equal(x.confidence, "alta");
  assert.equal(x.emails, 1);
  assert.equal(x.people, 1);
  assert.equal(x.contactsCreated, 3); // e-mail cadastral (Receita) + comercial (site) + decisora
  assert.equal(x.costUsd, Math.round((2 * (10000 / 1e6) * 0.1 + 2 * (1000 / 1e6) * 0.5 + 2 * 0.01) * 10000) / 10000);

  const d = (await gestor("GET", `/companies/${ids[0]}`)).data;
  assert.equal(d.company.website, "https://metalurgicaum-teste.com.br");
  assert.equal(d.company.linkedinUrl, "https://www.linkedin.com/company/metalurgica-um-teste");
  const maria = d.contacts.find((c) => c.name === "Maria Silva");
  assert.equal(maria.kind, "person");
  assert.equal(maria.jobTitle, "Diretora Industrial");
  assert.equal(maria.sourceUrl, "https://metalurgicaum-teste.com.br/quem-somos");
  const comercial = d.contacts.find((c) => c.email === "comercial@metalurgicaum-teste.com.br");
  assert.equal(comercial.kind, "generic");
  assert.equal((await sdr("GET", "/leadbase?contact=with")).data.total, 1);
});

test("confiança baixa não grava contatos nem dados da empresa", async () => {
  fakeClaude({
    website: "https://homonima.com.br", emails: [{ email: "x@homonima.com.br", label: "x", source_url: "https://homonima.com.br" }],
    phones: [], linkedin_company_url: null, instagram_url: null, people: [], confidence: "baixa", notes: "homônima",
  });
  const r = await gestor("POST", `/companies/${ids[2]}/discover`, {});
  assert.equal(r.data.result.contactsCreated, 0);
  const d = (await gestor("GET", `/companies/${ids[2]}`)).data;
  assert.equal(d.company.website, null);
  assert.equal(d.contacts.length, 0);
  assert.equal(d.company.discovery.findings.confidence, "baixa");
});

test("envio em lote ao funil usa o melhor contato (pessoa com e-mail > canal)", async () => {
  const payload = { companyIds: ids, pipelineId: pipeline.id, stageId: pipeline.stages[0].id };
  assert.equal((await sdr("POST", "/leadbase/to-pipeline", payload)).status, 403);
  const r = await gestor("POST", "/leadbase/to-pipeline", payload);
  assert.equal(r.data.created, 3);
  assert.equal((await gestor("POST", "/leadbase/to-pipeline", payload)).data.alreadyInPipeline, 3);
  const deals = (await gestor("GET", `/deals?pipelineId=${pipeline.id}`)).data.deals;
  const um = deals.find((d) => d.company.name === "Metalurgica Um");
  // Maria não tem e-mail publicado -> usa um canal com e-mail
  assert.ok(um.contact.email);
  assert.equal(deals.find((d) => d.company.name === "Padaria Dois").contact, null);
  assert.equal((await sdr("GET", "/leadbase?inPipeline=no")).data.total, 0);
});

test("e-mails de diretórios só valem se forem do domínio da empresa ou achados no site dela", () => {
  const f = discovery.clean({
    website: "https://www.empresa-teste.com.br",
    emails: [
      { email: "contato@empresa-teste.com.br", label: "contato", source_url: "https://diretorio.com/x" },
      { email: "vendas@grupo-teste.com.br", label: "vendas", source_url: "https://empresa-teste.com.br/contato" },
      { email: "empresa@provedorvelho.com.br", label: "antigo", source_url: "https://diretorio.com/x" },
      { email: "export@empresa-teste.com", label: "exportação", source_url: "https://diretorio.com/z" },
      { email: "nfe@empresa-teste.com.br", label: "fiscal", source_url: "https://empresa-teste.com.br/contato" },
    ],
    phones: [], linkedin_company_url: null, instagram_url: null,
    people: [{ name: "Ana", role: "Diretora", email: "ana@provedorvelho.com.br", linkedin_url: null, source_url: "https://diretorio.com/y" }],
    confidence: "media", notes: "",
  });
  assert.deepEqual(f.emails.map((e) => e.email), ["contato@empresa-teste.com.br", "vendas@grupo-teste.com.br", "export@empresa-teste.com"]);
  assert.equal(f.people[0].email, null);
  // Sem site conhecido, não há como comparar: mantém (a confiança da pesquisa decide).
  assert.equal(discovery.clean({ website: null, emails: [{ email: "a@b.com", label: "x", source_url: "https://b.com" }], phones: [], people: [], confidence: "media" }).emails.length, 1);
});
