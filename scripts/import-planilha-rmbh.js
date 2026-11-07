// Importa a planilha "Mercado RMBH" para a base de Leads (empresas), SEM criar cards no funil.
// - Aba "28-12-24": base completa (CNPJ, CNAE, cidade, porte, nº de funcionários, prioridade PRI)
// - Aba "MAIOR QUE 10 COLAB.": marca essas empresas com a lista "Lista de trabalho RMBH"
// Filtro: só portes até 99 funcionários (5-Micro, 4-Pequena 20-39, 3-Pequena 40-99).
// Uso: node --env-file=.env.local scripts/import-planilha-rmbh.js --file "mercado RMBH.xlsx" [--dry-run]
const ExcelJS = require("exceljs");
const { getPool } = require("../lib/db");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const FILE = arg("--file", "mercado RMBH.xlsx");
const ORG = arg("--org", "FD Consultoria");
const DRY = process.argv.includes("--dry-run");
const SOURCE_DETAIL = "Planilha Mercado RMBH (aba 28-12-24)";
const LIST_BASE = "Mercado RMBH";
const LIST_WORK = "Lista de trabalho RMBH";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || "") && !process.argv.includes("--allow-remote")) {
  console.error("ABORTADO: banco não é local (use --allow-remote só com aprovação).");
  process.exit(1);
}

// Valor da célula como texto (fórmulas, rich text e hiperlinks incluídos).
function text(cell) {
  const v = cell?.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && !(v instanceof Date)) {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join("").trim();
    if ("result" in v) return v.result === null || v.result === undefined ? "" : String(v.result).trim();
    if (v.text !== undefined) return String(v.text).trim();
    if (v.error) return "";
  }
  return String(v).trim();
}
const digits = (s) => String(s || "").replace(/\D/g, "");
const num = (s) => {
  const n = Number(String(s || "").replace(",", "."));
  return Number.isFinite(n) && String(s).trim() !== "" ? n : null;
};

// "1053800 - Fabricação De Sorvetes..." -> { code: "1053800", desc: "Fabricação De Sorvetes..." }
function splitCode(s) {
  const m = /^(\d[\d.\-/]*)\s*-\s*(.+)$/.exec(s);
  return m ? { code: digits(m[1]), desc: m[2].trim() } : { code: null, desc: s || null };
}

const PORTE_SIZE = { 5: "micro", 4: "pequeno", 3: "pequeno" };

function headerIndex(row) {
  const map = {};
  row.eachCell({ includeEmpty: false }, (cell, col) => {
    map[text(cell)] = col;
  });
  return map;
}

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);

  // CNPJs da lista de trabalho (cabeçalho na 3ª linha)
  const work = wb.getWorksheet("MAIOR QUE 10 COLAB.");
  const wh = headerIndex(work.getRow(3));
  const workSet = new Set();
  work.eachRow((row, n) => {
    if (n <= 3) return;
    const c = digits(text(row.getCell(wh.CNPJ)));
    if (c.length === 14) workSet.add(c);
  });

  const base = wb.getWorksheet("28-12-24");
  const h = headerIndex(base.getRow(1));
  const col = (name) => {
    const key = Object.keys(h).find((k) => k.toLowerCase().startsWith(name.toLowerCase()));
    if (!key) throw new Error(`Coluna "${name}" não encontrada na aba 28-12-24`);
    return h[key];
  };
  const C = { cnpj: col("CNPJ"), name: col("Cliente"), city: col("Cidade"), porte: col("Porte"), cnae: col("Cnae"), func: col("Nº F"), pri: col("PRI") };

  const rows = [];
  const skipped = { porte: 0, cnpj: 0 };
  base.eachRow((row, n) => {
    if (n === 1) return;
    const porte = text(row.getCell(C.porte));
    const porteNum = Number(porte.charAt(0));
    if (![3, 4, 5].includes(porteNum)) {
      skipped.porte++;
      return;
    }
    const cnpj = digits(text(row.getCell(C.cnpj)));
    const name = text(row.getCell(C.name));
    if (cnpj.length !== 14 || !name) {
      skipped.cnpj++;
      return;
    }
    const cnae = splitCode(text(row.getCell(C.cnae)));
    const lists = [LIST_BASE, ...(workSet.has(cnpj) ? [LIST_WORK] : [])];
    rows.push({
      cnpj,
      name: name.slice(0, 200),
      city: text(row.getCell(C.city)) || null,
      segment: cnae.desc ? cnae.desc.slice(0, 120) : null,
      cnaeCode: cnae.code,
      size: PORTE_SIZE[porteNum],
      employees: num(text(row.getCell(C.func))),
      priority: num(text(row.getCell(C.pri))),
      lists,
    });
  });

  // O mesmo CNPJ pode aparecer mais de uma vez (formatações diferentes): mantém a 1ª ocorrência.
  const seen = new Map();
  for (const r of rows) {
    const prev = seen.get(r.cnpj);
    if (prev) prev.lists = [...new Set([...prev.lists, ...r.lists])];
    else seen.set(r.cnpj, r);
  }
  const duplicates = rows.length - seen.size;
  rows.length = 0;
  rows.push(...seen.values());
  if (duplicates) console.log(`CNPJs repetidos na planilha (mantida a 1ª ocorrência): ${duplicates}`);

  const inWork = rows.filter((r) => r.lists.includes(LIST_WORK)).length;
  console.log(`Linhas aceitas: ${rows.length} (lista de trabalho: ${inWork}) · fora do filtro de porte: ${skipped.porte} · sem CNPJ/nome: ${skipped.cnpj}`);
  const bySize = rows.reduce((acc, r) => ((acc[`${r.size}${r.employees >= 40 ? " 40-99" : ""}`] = (acc[`${r.size}${r.employees >= 40 ? " 40-99" : ""}`] || 0) + 1), acc), {});
  console.log("Por porte:", JSON.stringify(bySize));
  if (DRY) return;

  const pool = getPool();
  const { rows: orgs } = await pool.query(`SELECT id FROM organizations WHERE name = $1`, [ORG]);
  if (!orgs.length) throw new Error(`Organização "${ORG}" não encontrada.`);
  const orgId = orgs[0].id;

  let inserted = 0;
  let updated = 0;
  const COLS = 12;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const params = [];
    const values = chunk.map((r, j) => {
      params.push(orgId, r.name, r.cnpj, r.city, "MG", r.segment, r.cnaeCode, r.size, r.employees, r.priority, r.lists, SOURCE_DETAIL);
      const b = j * COLS;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, $${b + 11}::text[], 'planilha', $${b + 12})`;
    });
    const res = await pool.query(
      `INSERT INTO companies (organization_id, name, cnpj, city, uf, segment, cnae_code, size, employees, priority, lists, source, source_detail)
       VALUES ${values.join(",")}
       ON CONFLICT (organization_id, cnpj) WHERE cnpj IS NOT NULL DO UPDATE SET
         employees = coalesce(EXCLUDED.employees, companies.employees),
         priority = coalesce(EXCLUDED.priority, companies.priority),
         cnae_code = coalesce(companies.cnae_code, EXCLUDED.cnae_code),
         size = coalesce(companies.size, EXCLUDED.size),
         lists = (SELECT array_agg(DISTINCT x) FROM unnest(companies.lists || EXCLUDED.lists) AS x),
         updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      params
    );
    for (const r of res.rows) r.inserted ? inserted++ : updated++;
    process.stdout.write(`\r${Math.min(i + 500, rows.length)}/${rows.length}`);
  }
  console.log(`\nConcluído: ${inserted} empresas novas, ${updated} já existentes atualizadas.`);
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
