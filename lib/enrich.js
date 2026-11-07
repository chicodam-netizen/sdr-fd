// Enriquecimento cadastral por CNPJ: primeiro na base local da Receita (cnpj_establishments),
// depois na BrasilAPI (gratuita). Dados de sócios (QSA) são descartados - dados pessoais (LGPD).
const { query } = require("./db");

let fetchImpl = (...args) => fetch(...args);
// Permite substituir o fetch nos testes automatizados.
function setFetch(fn) {
  fetchImpl = fn;
}

const PORTE_LABEL = { micro: "Microempresa", pequeno: "Pequeno porte", demais: "Médio/grande porte", nao_informado: "Não informado" };

function fromBrasilApi(d) {
  const porte = String(d.porte || d.descricao_porte || "").toUpperCase();
  return {
    source: "brasilapi",
    legalName: d.razao_social || null,
    tradeName: d.nome_fantasia || null,
    cnaeCode: d.cnae_fiscal ? String(d.cnae_fiscal) : null,
    cnaeDescription: d.cnae_fiscal_descricao || null,
    size: porte.includes("MICRO") ? "micro" : porte.includes("PEQUENO") ? "pequeno" : porte.includes("DEMAIS") ? "demais" : null,
    status: d.descricao_situacao_cadastral ? String(d.descricao_situacao_cadastral).toLowerCase() : null,
    openedAt: d.data_inicio_atividade || null,
    city: d.municipio ? titleCase(d.municipio) : null,
    uf: d.uf || null,
    phone: d.ddd_telefone_1 ? formatPhone(d.ddd_telefone_1) : null,
    email: d.email ? String(d.email).toLowerCase() : null,
    capital: d.capital_social ?? null,
  };
}

function fromLocal(r) {
  return {
    source: "receita_local",
    legalName: r.razao_social,
    tradeName: r.nome_fantasia,
    cnaeCode: r.cnae_principal,
    cnaeDescription: r.cnae_description,
    size: r.porte,
    status: r.situacao,
    openedAt: r.data_inicio ? new Date(r.data_inicio).toISOString().slice(0, 10) : null,
    city: r.municipio ? titleCase(r.municipio) : null,
    uf: r.uf,
    phone: r.telefone,
    email: r.email,
    capital: r.capital_social === null ? null : Number(r.capital_social),
  };
}

function titleCase(s) {
  return String(s)
    .toLowerCase()
    .replace(/(^|\s)(\p{L})/gu, (m, sp, ch) => sp + ch.toUpperCase())
    .replace(/\s(De|Da|Do|Das|Dos|E)\s/g, (m) => m.toLowerCase());
}

function formatPhone(raw) {
  const d = String(raw).replace(/\D/g, "");
  return d.length >= 10 ? `(${d.slice(0, 2)}) ${d.slice(2)}` : d || null;
}

async function lookupCnpj(cnpj) {
  const { rows } = await query(
    `SELECT e.*, c.description AS cnae_description FROM cnpj_establishments e
     LEFT JOIN cnaes c ON c.code = e.cnae_principal WHERE e.cnpj = $1`,
    [cnpj]
  );
  if (rows.length) return fromLocal(rows[0]);

  let res;
  try {
    // A BrasilAPI recusa (403) requisições sem User-Agent identificado.
    res = await fetchImpl(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, {
      headers: { Accept: "application/json", "User-Agent": "SDR-FD/1.0 (+https://fdconsultoria.tech)" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { error: "lookup_unavailable" };
  }
  if (res.status === 404) return { error: "cnpj_not_found" };
  if (res.status === 429) return { error: "lookup_rate_limited" };
  if (!res.ok) return { error: "lookup_unavailable" };
  return fromBrasilApi(await res.json());
}

// Preenche apenas campos vazios da empresa (nunca sobrescreve o que o usuário digitou).
async function enrichCompany(company) {
  if (!company.cnpj) return { error: "missing_cnpj" };
  const data = await lookupCnpj(company.cnpj);
  if (data.error) return data;
  await query(
    `UPDATE companies SET
       legal_name = coalesce($2, legal_name),
       cnae_code = coalesce($3, cnae_code),
       size = coalesce($4, size),
       registration_status = coalesce($5, registration_status),
       opened_at = coalesce($6::date, opened_at),
       segment = coalesce(segment, $7),
       city = coalesce(city, $8),
       uf = coalesce(uf, $9),
       phone = coalesce(phone, $10),
       enrichment = $11,
       enriched_at = now(),
       updated_at = now()
     WHERE id = $1`,
    [company.id, data.legalName, data.cnaeCode, data.size, data.status, data.openedAt, data.cnaeDescription, data.city, data.uf, data.phone, data]
  );
  return { ok: true, data };
}

module.exports = { lookupCnpj, enrichCompany, setFetch, PORTE_LABEL, titleCase };
