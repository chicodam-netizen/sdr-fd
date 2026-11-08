// Segmento = divisão CNAE (2 primeiros dígitos). Os nomes vêm da tabela cnae_divisions
// (alimentada pelas planilhas importadas); sem nome conhecido, usa "CNAE XX".

const SMALL_WORDS = new Set(["de", "da", "do", "das", "dos", "e", "em", "para", "por", "à", "às", "ao", "aos", "a", "o", "com", "ou", "exceto"]);

// "Fabricação De Produtos Alimentícios" -> "Fabricação de Produtos Alimentícios"
function tidyName(name) {
  return String(name || "")
    .trim()
    .split(/\s+/)
    .map((w, i) => (i > 0 && SMALL_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : w))
    .join(" ");
}

// "10 - Fabricação De Produtos Alimentícios" -> { code: "10", name: "Fabricação de Produtos Alimentícios" }
function parseDivision(text) {
  const m = /^\s*(\d{2})\s*-\s*(.+)$/.exec(String(text || ""));
  return m ? { code: m[1], name: tidyName(m[2]) } : null;
}

// Nome do segmento a partir de um código CNAE (qualquer tamanho, só dígitos).
async function sectorFromCnae(db, cnaeCode) {
  const code = String(cnaeCode || "").replace(/\D/g, "").slice(0, 2);
  if (code.length !== 2) return null;
  const { rows } = await db.query(`SELECT name FROM cnae_divisions WHERE code = $1`, [code]);
  return rows[0]?.name || `CNAE ${code}`;
}

module.exports = { tidyName, parseDivision, sectorFromCnae };
