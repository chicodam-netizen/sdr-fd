// Carrega um recorte dos dados abertos de CNPJ da Receita Federal no banco.
// Uso:
//   node --env-file=.env.local scripts/load-cnpj.js --dir D:\dados\cnpj\2026-10 --uf MG,SP --cnae 10,4711 [--incluir-inativas]
// A pasta deve conter os .zip oficiais: Cnaes, Municipios, Estabelecimentos0..9, Empresas0..9.
// Banco remoto (produção) só com --allow-remote e CONFIRM_REMOTE_LOAD=sim.
const { getPool } = require("../lib/db");
const { loadCnpj } = require("../lib/cnpj-loader");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const dir = arg("--dir");
const ufs = (arg("--uf") || "").split(",").map((s) => s.trim()).filter(Boolean);
const cnaePrefixes = (arg("--cnae") || "").split(",").map((s) => s.trim()).filter(Boolean);
const onlyActive = !process.argv.includes("--incluir-inativas");
// --porte pequeno,demais  (micro | pequeno | demais | nao_informado). "demais" = médias e grandes juntas.
const portes = (arg("--porte") || "").split(",").map((s) => s.trim()).filter(Boolean);

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || "");
if (!isLocal && !(process.argv.includes("--allow-remote") && process.env.CONFIRM_REMOTE_LOAD === "sim")) {
  console.error("ABORTADO: banco não é local. Use --allow-remote com CONFIRM_REMOTE_LOAD=sim.");
  process.exit(1);
}
if (!dir) {
  console.error("Informe --dir com a pasta dos arquivos .zip da Receita.");
  process.exit(1);
}

const t0 = Date.now();
loadCnpj(getPool(), dir, { ufs, cnaePrefixes, onlyActive, portes })
  .then((r) => console.log(JSON.stringify({ ...r, segundos: Math.round((Date.now() - t0) / 1000) })))
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
