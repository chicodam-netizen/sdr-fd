// Carga do recorte dos dados abertos de CNPJ da Receita Federal (arquivos .zip oficiais,
// CSV com ";" em Latin-1, sem cabeçalho). Lê em streaming e grava só o que passa nos filtros.
//  1) Cnaes*.zip e Municipios*.zip  -> tabelas auxiliares
//  2) Estabelecimentos*.zip          -> filtra por UF, prefixo de CNAE e situação ativa
//  3) Empresas*.zip                  -> razão social, porte e capital dos CNPJs carregados
// Dados de sócios (Socios*.zip) não são lidos (dados pessoais; minimização - LGPD).
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const yauzl = require("yauzl");

const SITUACAO = { "01": "nula", "02": "ativa", "03": "suspensa", "04": "inapta", "08": "baixada" };
const PORTE = { "00": "nao_informado", "01": "micro", "03": "pequeno", "05": "demais" };
const BATCH = 1000;

// Divide uma linha do CSV da Receita (";" com aspas duplas).
function splitLine(line) {
  const out = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ";") {
      out.push(field);
      field = "";
    } else field += ch;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

function toDate(yyyymmdd) {
  return /^\d{8}$/.test(yyyymmdd) && yyyymmdd !== "00000000"
    ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
    : null;
}

function toMoney(v) {
  const n = Number(String(v || "").replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function phone(ddd, tel) {
  const d = (ddd || "").replace(/\D/g, "");
  const t = (tel || "").replace(/\D/g, "");
  return t ? `(${d}) ${t}` : null;
}

// Itera as linhas de todos os arquivos dentro de um .zip (Latin-1).
function zipLines(zipPath, onLine) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry) => {
        if (/\/$/.test(entry.fileName)) return zip.readEntry();
        zip.openReadStream(entry, async (e2, stream) => {
          if (e2) return reject(e2);
          stream.setEncoding("latin1");
          const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
          try {
            for await (const line of rl) if (line) await onLine(line);
            zip.readEntry();
          } catch (e3) {
            reject(e3);
          }
        });
      });
      zip.readEntry();
    });
  });
}

function filesMatching(dir, prefix) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().startsWith(prefix.toLowerCase()) && f.toLowerCase().endsWith(".zip"))
    .sort()
    .map((f) => path.join(dir, f));
}

// filters: { ufs: ["MG"], cnaePrefixes: ["10", "4711"], onlyActive: true }
async function loadCnpj(pool, dir, filters, log = console.log) {
  const ufs = new Set((filters.ufs || []).map((u) => u.toUpperCase()));
  const prefixes = (filters.cnaePrefixes || []).map((p) => p.replace(/\D/g, "")).filter(Boolean);
  const onlyActive = filters.onlyActive !== false;
  const portes = (filters.portes || []).filter((p) => Object.values(PORTE).includes(p));
  if (!ufs.size && !prefixes.length) throw new Error("Informe ao menos um filtro (UF ou CNAE): a base completa tem dezenas de milhões de linhas.");

  const { rows: loadRows } = await pool.query(`INSERT INTO cnpj_loads (reference, filters) VALUES ($1, $2) RETURNING id`, [
    path.basename(dir),
    { ufs: [...ufs], cnaePrefixes: prefixes, onlyActive, portes },
  ]);
  const loadId = loadRows[0].id;

  // 1) CNAEs e municípios
  let cnaeCount = 0;
  for (const file of filesMatching(dir, "Cnaes")) {
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      const vals = batch.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(",");
      await pool.query(`INSERT INTO cnaes (code, description) VALUES ${vals} ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description`, batch.flat());
      cnaeCount += batch.length;
      batch = [];
    };
    await zipLines(file, async (line) => {
      const [code, desc] = splitLine(line);
      if (code && desc) batch.push([code, desc]);
      if (batch.length >= BATCH) await flush();
    });
    await flush();
  }
  const municipios = new Map();
  for (const file of filesMatching(dir, "Municipios")) {
    await zipLines(file, (line) => {
      const [code, name] = splitLine(line);
      if (code) municipios.set(code, name);
    });
  }
  log(`CNAEs: ${cnaeCount} · municípios: ${municipios.size}`);

  if (portes.length) {
    const r = await loadByPorte(pool, dir, { ufs, prefixes, onlyActive, portes, municipios }, log);
    await pool.query(`UPDATE cnpj_loads SET rows = $2, finished_at = now() WHERE id = $1`, [loadId, r.kept]);
    return { ...r, cnaes: cnaeCount, municipios: municipios.size };
  }

  // 2) Estabelecimentos filtrados
  const basicos = new Set();
  let scanned = 0;
  let kept = 0;
  let batch = [];
  const COLS = ["cnpj", "cnpj_basico", "is_matriz", "nome_fantasia", "situacao", "data_inicio", "cnae_principal", "cnaes_secundarios",
    "logradouro", "numero", "bairro", "cep", "uf", "municipio_codigo", "municipio", "telefone", "email"];
  const flush = async () => {
    if (!batch.length) return;
    const vals = batch.map((_, i) => `(${COLS.map((__, j) => `$${i * COLS.length + j + 1}`).join(",")})`).join(",");
    await pool.query(
      `INSERT INTO cnpj_establishments (${COLS.join(",")}) VALUES ${vals}
       ON CONFLICT (cnpj) DO UPDATE SET ${COLS.filter((c) => c !== "cnpj").map((c) => `${c} = EXCLUDED.${c}`).join(", ")}, loaded_at = now()`,
      batch.flat()
    );
    batch = [];
  };
  for (const file of filesMatching(dir, "Estabelecimentos")) {
    log(`Lendo ${path.basename(file)}...`);
    await zipLines(file, async (line) => {
      scanned++;
      const f = splitLine(line);
      const uf = f[19];
      const cnae = f[11];
      const situacao = f[5];
      if (ufs.size && !ufs.has(uf)) return;
      if (prefixes.length && !prefixes.some((p) => cnae.startsWith(p))) return;
      if (onlyActive && situacao !== "02") return;
      const logradouro = [f[13], f[14]].filter(Boolean).join(" ") || null;
      batch.push([
        `${f[0]}${f[1]}${f[2]}`, f[0], f[3] === "1", f[4] || null, SITUACAO[situacao] || situacao, toDate(f[10]), cnae, f[12] || null,
        logradouro, f[15] || null, f[17] || null, f[18] || null, uf, f[20] || null, municipios.get(f[20]) || null,
        phone(f[21], f[22]), (f[27] || "").toLowerCase() || null,
      ]);
      basicos.add(f[0]);
      kept++;
      if (batch.length >= BATCH) await flush();
    });
    await flush();
    log(`  ${scanned.toLocaleString("pt-BR")} lidos · ${kept.toLocaleString("pt-BR")} no recorte`);
  }

  // 3) Empresas: razão social, porte, capital
  let updated = 0;
  let eb = [];
  const flushE = async () => {
    if (!eb.length) return;
    const vals = eb.map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4}::numeric)`).join(",");
    const r = await pool.query(
      `UPDATE cnpj_establishments e SET razao_social = v.rs, porte = v.p, capital_social = v.c
       FROM (VALUES ${vals}) AS v(b, rs, p, c) WHERE e.cnpj_basico = v.b`,
      eb.flat()
    );
    updated += r.rowCount;
    eb = [];
  };
  for (const file of filesMatching(dir, "Empresas")) {
    log(`Lendo ${path.basename(file)}...`);
    await zipLines(file, async (line) => {
      const f = splitLine(line);
      if (!basicos.has(f[0])) return;
      eb.push([f[0], f[1] || null, PORTE[f[5]] || null, toMoney(f[4])]);
      if (eb.length >= BATCH) await flushE();
    });
    await flushE();
  }

  await pool.query(`UPDATE cnpj_loads SET rows = $2, finished_at = now() WHERE id = $1`, [loadId, kept]);
  log(`Concluído: ${kept.toLocaleString("pt-BR")} estabelecimentos no recorte, ${updated.toLocaleString("pt-BR")} com dados da empresa.`);
  return { scanned, kept, updated, cnaes: cnaeCount, municipios: municipios.size };
}

// Com filtro de porte, o porte só é conhecido no arquivo de Empresas. Para não gravar milhões de
// estabelecimentos fora do recorte, a leitura é em três passos:
//   A) Estabelecimentos -> CNPJs-base que passam em UF/CNAE/situação (só em memória)
//   B) Empresas         -> dados (razão social, porte, capital) dos que têm o porte pedido
//   C) Estabelecimentos -> grava apenas os estabelecimentos dessas empresas, já completos
function estabMatches(f, { ufs, prefixes, onlyActive }) {
  if (ufs.size && !ufs.has(f[19])) return false;
  if (prefixes.length && !prefixes.some((p) => f[11].startsWith(p))) return false;
  if (onlyActive && f[5] !== "02") return false;
  return true;
}

async function loadByPorte(pool, dir, opts, log) {
  const { portes, municipios } = opts;
  const estabFiles = filesMatching(dir, "Estabelecimentos");

  // A
  const basicos = new Set();
  let scanned = 0;
  for (const file of estabFiles) {
    log(`[1/3] ${path.basename(file)}...`);
    await zipLines(file, (line) => {
      scanned++;
      const f = splitLine(line);
      if (estabMatches(f, opts)) basicos.add(f[0]);
    });
  }
  log(`  ${scanned.toLocaleString("pt-BR")} estabelecimentos lidos · ${basicos.size.toLocaleString("pt-BR")} empresas na UF/CNAE`);

  // B
  const empresas = new Map();
  for (const file of filesMatching(dir, "Empresas")) {
    log(`[2/3] ${path.basename(file)}...`);
    await zipLines(file, (line) => {
      const f = splitLine(line);
      if (!basicos.has(f[0])) return;
      const porte = PORTE[f[5]] || null;
      if (portes.includes(porte)) empresas.set(f[0], [f[1] || null, porte, toMoney(f[4])]);
    });
  }
  basicos.clear();
  log(`  ${empresas.size.toLocaleString("pt-BR")} empresas com porte ${portes.join("/")}`);

  // C
  const COLS = ["cnpj", "cnpj_basico", "is_matriz", "nome_fantasia", "situacao", "data_inicio", "cnae_principal", "cnaes_secundarios",
    "logradouro", "numero", "bairro", "cep", "uf", "municipio_codigo", "municipio", "telefone", "email", "razao_social", "porte", "capital_social"];
  let kept = 0;
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const vals = batch.map((_, i) => `(${COLS.map((__, j) => `$${i * COLS.length + j + 1}`).join(",")})`).join(",");
    await pool.query(
      `INSERT INTO cnpj_establishments (${COLS.join(",")}) VALUES ${vals}
       ON CONFLICT (cnpj) DO UPDATE SET ${COLS.filter((c) => c !== "cnpj").map((c) => `${c} = EXCLUDED.${c}`).join(", ")}, loaded_at = now()`,
      batch.flat()
    );
    batch = [];
  };
  for (const file of estabFiles) {
    log(`[3/3] ${path.basename(file)}...`);
    await zipLines(file, async (line) => {
      const f = splitLine(line);
      const emp = empresas.get(f[0]);
      if (!emp || !estabMatches(f, opts)) return;
      batch.push([
        `${f[0]}${f[1]}${f[2]}`, f[0], f[3] === "1", f[4] || null, SITUACAO[f[5]] || f[5], toDate(f[10]), f[11], f[12] || null,
        [f[13], f[14]].filter(Boolean).join(" ") || null, f[15] || null, f[17] || null, f[18] || null, f[19], f[20] || null,
        municipios.get(f[20]) || null, phone(f[21], f[22]), (f[27] || "").toLowerCase() || null, ...emp,
      ]);
      kept++;
      if (batch.length >= BATCH) await flush();
    });
    await flush();
    log(`  ${kept.toLocaleString("pt-BR")} gravados até aqui`);
  }
  log(`Concluído: ${kept.toLocaleString("pt-BR")} estabelecimentos gravados.`);
  return { scanned, kept, updated: kept };
}

module.exports = { loadCnpj, splitLine, SITUACAO, PORTE };
