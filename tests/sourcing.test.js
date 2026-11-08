// Testes da Fase 4 (captação): carga da base da Receita a partir de ZIPs sintéticos no formato
// oficial, busca, envio ao funil, enriquecimento (BrasilAPI simulada) e Google Places simulado.
process.env.GOOGLE_PLACES_API_KEY = "chave-de-teste";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const yazl = require("yazl");
const { createServer } = require("../scripts/dev-server");
const { getPool } = require("../lib/db");
const { hashPassword } = require("../lib/auth");
const { createDefaultPipeline } = require("../lib/default-pipeline");
const { loadCnpj, splitLine } = require("../lib/cnpj-loader");
const enrich = require("../lib/enrich");
const places = require("../lib/places");

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || "")) {
  throw new Error("Os testes só rodam contra banco local.");
}

const suffix = crypto.randomBytes(4).toString("hex");
const GESTOR = { email: `g4-${suffix}@teste.local`, password: "SenhaGestor123" };
const SDR = { email: `s4-${suffix}@teste.local`, password: "SenhaSdr12345" };
// CNPJs e CNAEs fictícios (prefixo 99) para não colidir com dados reais.
const C1 = "99000001000191"; // MG, CNAE 9900101, ativa, matriz, com e-mail
const C2 = "99000002000182"; // MG, CNAE 9900101, baixada
const C3 = "99000003000173"; // SP, CNAE 9900101, ativa
const C4 = "99000004000164"; // MG, CNAE 9900201, ativa
const CE = "99000009000119"; // fora da base local (enriquecimento via "BrasilAPI")
let server, base, orgId, gestor, sdr, pipeline, dir;

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

function writeZip(file, lines) {
  return new Promise((resolve) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(lines.join("\r\n") + "\r\n", "latin1"), path.basename(file).replace(".zip", ".CSV"));
    zip.outputStream.pipe(fs.createWriteStream(file)).on("close", resolve);
    zip.end();
  });
}

const est = (cnpj, situacao, cnae, uf, mun, email) =>
  [cnpj.slice(0, 8), cnpj.slice(8, 12), cnpj.slice(12), "1", `FANTASIA ${cnpj.slice(6, 8)}`, situacao, "20200101", "00", "", "", "20150310", cnae, "", "RUA", "DAS FLORES", "100", "", "CENTRO", "30000000", uf, mun, "31", "33334444", "", "", "", "", email, "", ""]
    .map((f) => `"${f}"`)
    .join(";");

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cnpj-"));
  await writeZip(path.join(dir, "Cnaes.zip"), ['"9900101";"Fabricação de laticínios de teste"', '"9900201";"Comércio de teste"']);
  await writeZip(path.join(dir, "Municipios.zip"), ['"99991";"JUIZ DE FORA"', '"99992";"SAO PAULO"']);
  await writeZip(path.join(dir, "Estabelecimentos0.zip"), [
    est(C1, "02", "9900101", "MG", "99991", "CONTATO@LATICINIO-TESTE.COM.BR"),
    est(C2, "08", "9900101", "MG", "99991", ""),
    est(C3, "02", "9900101", "SP", "99992", ""),
    est(C4, "02", "9900201", "MG", "99991", ""),
  ]);
  await writeZip(path.join(dir, "Empresas0.zip"), [
    `"99000001";"LATICINIOS SERRA TESTE LTDA";"2062";"49";"1500000,00";"05";""`,
    `"99000004";"OUTRA EMPRESA LTDA";"2062";"49";"1000,00";"01";""`,
  ]);

  const pool = getPool();
  orgId = (await pool.query(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [`Captacao ${suffix}`])).rows[0].id;
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
  const pool = getPool();
  await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
  await pool.query(`DELETE FROM cnpj_establishments WHERE cnpj LIKE '9900000%'`);
  await pool.query(`DELETE FROM cnaes WHERE code LIKE '99002%' OR code LIKE '99001%'`);
  await pool.query(`DELETE FROM cnpj_loads WHERE reference = $1`, [path.basename(dir)]);
  fs.rmSync(dir, { recursive: true, force: true });
  server.close();
  await pool.end();
});

test("parser de linha da Receita respeita aspas e ponto e vírgula", () => {
  assert.deepEqual(splitLine(`"1";"A; B";"C ""x"""`), ["1", "A; B", 'C "x"']);
});

test("carga filtra por UF, CNAE e situação ativa e completa com dados da empresa", async () => {
  const r = await loadCnpj(getPool(), dir, { ufs: ["MG"], cnaePrefixes: ["99001"] }, () => {});
  assert.equal(r.scanned, 4);
  assert.equal(r.kept, 1);
  const { rows } = await getPool().query(`SELECT * FROM cnpj_establishments WHERE cnpj = $1`, [C1]);
  assert.equal(rows[0].razao_social, "LATICINIOS SERRA TESTE LTDA");
  assert.equal(rows[0].porte, "demais");
  assert.equal(Number(rows[0].capital_social), 1500000);
  assert.equal(rows[0].municipio, "JUIZ DE FORA");
  assert.equal(rows[0].email, "contato@laticinio-teste.com.br");
  await assert.rejects(loadCnpj(getPool(), dir, {}, () => {}), /filtro/);
});

test("carga com filtro de porte grava só as empresas do porte pedido, já completas", async () => {
  await getPool().query(`DELETE FROM cnpj_establishments WHERE cnpj LIKE '9900000%'`);
  const r = await loadCnpj(getPool(), dir, { ufs: ["MG"], portes: ["pequeno", "demais"] }, () => {});
  assert.equal(r.kept, 1); // C1 (demais); C4 é micro; C2 baixada; C3 é SP
  const { rows } = await getPool().query(`SELECT cnpj, razao_social, porte FROM cnpj_establishments WHERE cnpj LIKE '9900000%'`);
  assert.deepEqual(rows.map((x) => x.cnpj), [C1]);
  assert.equal(rows[0].razao_social, "LATICINIOS SERRA TESTE LTDA");
  assert.equal(rows[0].porte, "demais");
});

test("busca na base: filtros, CNAE por texto, municípios e exigência de filtro", async () => {
  assert.equal((await sdr("GET", "/sourcing/cnpj")).data.error, "missing_filters");
  const r = await sdr("GET", "/sourcing/cnpj?uf=MG&cnae=99001&hasEmail=1&porte=demais");
  assert.equal(r.data.total, 1);
  const item = r.data.results[0];
  assert.equal(item.cnpj, C1);
  assert.equal(item.city, "Juiz de Fora");
  assert.equal(item.sizeLabel, "Médio/grande porte");
  assert.equal(item.inBase, false);
  assert.equal((await sdr("GET", "/sourcing/cnpj?uf=MG&porte=micro&cnae=99001")).data.total, 0);
  assert.equal((await sdr("GET", "/sourcing/cnaes?q=laticínios de teste")).data.cnaes[0].code, "9900101");
  assert.equal((await sdr("GET", "/sourcing/cnaes?q=99002")).data.cnaes[0].code, "9900201");
  const mun = (await sdr("GET", "/sourcing/municipios?uf=MG")).data.municipios;
  assert.ok(mun.some((m) => m.value === "JUIZ DE FORA"));
});

test("envio da base CNPJ ao funil: cria empresa, contato geral e card; não duplica", async () => {
  const payload = { source: "cnpj", cnpjs: [C1], pipelineId: pipeline.id, stageId: pipeline.stages[0].id };
  assert.equal((await sdr("POST", "/sourcing/import", payload)).status, 403);
  const r = await gestor("POST", "/sourcing/import", payload);
  assert.equal(r.data.created, 1);
  assert.equal((await gestor("POST", "/sourcing/import", payload)).data.alreadyInPipeline, 1);

  const deals = (await gestor("GET", `/deals?pipelineId=${pipeline.id}`)).data.deals;
  const d = deals.find((x) => x.company.cnpj === C1);
  assert.equal(d.company.name, "FANTASIA 01");
  assert.equal(d.contact.email, "contato@laticinio-teste.com.br");
  const co = (await gestor("GET", `/companies/${d.company.id}`)).data.company;
  assert.equal(co.legalName, "LATICINIOS SERRA TESTE LTDA");
  assert.equal(co.source, "receita_cnpj");
  assert.equal(co.size, "demais");
  assert.equal((await sdr("GET", "/sourcing/cnpj?uf=MG&cnae=99001")).data.results[0].inBase, true);
});

test("enriquecimento: base local primeiro, BrasilAPI depois, só preenche vazios e descarta sócios", async () => {
  let calls = 0;
  enrich.setFetch(async (url) => {
    calls++;
    assert.match(url, new RegExp(CE));
    return new Response(JSON.stringify({
      razao_social: "EMPRESA ENRIQUECIDA SA", nome_fantasia: "ENRIQUECIDA", cnae_fiscal: 6201501, cnae_fiscal_descricao: "Desenvolvimento de software",
      porte: "DEMAIS", descricao_situacao_cadastral: "ATIVA", data_inicio_atividade: "2010-05-20", municipio: "BELO HORIZONTE", uf: "MG",
      ddd_telefone_1: "3132221111", capital_social: 50000, qsa: [{ nome_socio: "FULANO DE TAL" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const created = await gestor("POST", "/deals", { pipelineId: pipeline.id, company: { name: "Minha Empresa X", cnpj: CE, segment: "Segmento do usuário" } });
  const companyId = created.data.deal.company.id;
  assert.equal((await sdr("POST", `/companies/${companyId}/enrich`, {})).data.source, "brasilapi");
  const co = (await gestor("GET", `/companies/${companyId}`)).data.company;
  assert.equal(co.name, "Minha Empresa X");
  assert.equal(co.segment, "Segmento do usuário"); // não sobrescreve
  assert.equal(co.city, "Belo Horizonte");
  assert.equal(co.legalName, "EMPRESA ENRIQUECIDA SA");
  assert.equal(co.registrationStatus, "ativa");
  assert.equal(JSON.stringify(co.enrichment).includes("FULANO"), false);
  assert.equal(calls, 1);

  // Empresa da base local não chama a API externa
  const local = (await gestor("GET", `/deals?pipelineId=${pipeline.id}`)).data.deals.find((x) => x.company.cnpj === C1);
  assert.equal((await sdr("POST", `/companies/${local.company.id}/enrich`, {})).data.source, "receita_local");
  assert.equal(calls, 1);

  enrich.setFetch(async () => new Response("{}", { status: 404 }));
  await gestor("POST", "/deals", { pipelineId: pipeline.id, company: { name: "Inexistente", cnpj: "99000008000128" } });
  const pending = await gestor("POST", "/companies/enrich-pending", {});
  assert.equal(pending.data.remaining, 0);
  assert.equal(pending.data.errors[0].error, "cnpj_not_found");
});

test("Google Maps: busca, marcação de já cadastrados e envio ao funil sem duplicar", async () => {
  places.setFetch(async (url, opts) => {
    assert.equal(opts.headers["X-Goog-Api-Key"], "chave-de-teste");
    assert.equal(JSON.parse(opts.body).textQuery, "laticínios em Juiz de Fora");
    return new Response(JSON.stringify({
      places: [
        {
          id: `place-${suffix}`, displayName: { text: "Laticínio do Vale" }, formattedAddress: "Rua A, 10 - Juiz de Fora - MG",
          addressComponents: [{ longText: "Juiz de Fora", shortText: "Juiz de Fora", types: ["administrative_area_level_2"] }, { longText: "Minas Gerais", shortText: "MG", types: ["administrative_area_level_1"] }],
          nationalPhoneNumber: "(32) 3215-0000", websiteUri: "https://vale-teste.com.br", primaryTypeDisplayName: { text: "Fábrica" }, businessStatus: "OPERATIONAL",
        },
        { id: "fechado", displayName: { text: "Fechado" }, businessStatus: "CLOSED_PERMANENTLY" },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const r = await sdr("GET", `/sourcing/places?q=${encodeURIComponent("laticínios em Juiz de Fora")}`);
  assert.equal(r.data.results.length, 1);
  const p = r.data.results[0];
  assert.equal(p.uf, "MG");
  assert.equal(p.city, "Juiz de Fora");
  assert.equal(p.inBase, false);

  const payload = { source: "places", places: [p], searchQuery: "laticínios em Juiz de Fora", pipelineId: pipeline.id, stageId: pipeline.stages[0].id };
  assert.equal((await gestor("POST", "/sourcing/import", payload)).data.created, 1);
  assert.equal((await gestor("POST", "/sourcing/import", payload)).data.alreadyInPipeline, 1);
  assert.equal((await sdr("GET", `/sourcing/places?q=${encodeURIComponent("laticínios em Juiz de Fora")}`)).data.results[0].inBase, true);
  const companies = (await gestor("GET", "/companies?q=vale")).data.companies;
  assert.equal(companies[0].sourceDetail, "Google Maps: laticínios em Juiz de Fora");
});
