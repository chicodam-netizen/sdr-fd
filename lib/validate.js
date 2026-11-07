const { HttpError } = require("./http");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

// Texto opcional: string aparada, vazia vira null; acima do limite é erro.
function optText(value, field, max = 500) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" && typeof value !== "number") throw new HttpError(400, `invalid_${field}`);
  const s = String(value).trim();
  if (s.length > max) throw new HttpError(400, `${field}_too_long`);
  return s || null;
}

function reqText(value, field, max = 200) {
  const s = optText(value, field, max);
  if (!s) throw new HttpError(400, `missing_${field}`);
  return s;
}

function optUuid(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new HttpError(400, `invalid_${field}`);
  return value;
}

function reqUuid(value, field) {
  const v = optUuid(value, field);
  if (!v) throw new HttpError(400, `missing_${field}`);
  return v;
}

function optEmail(value) {
  const s = optText(value, "email", 200);
  if (s && !EMAIL_RE.test(s)) throw new HttpError(400, "invalid_email");
  return s ? s.toLowerCase() : null;
}

// CNPJ guardado só com dígitos; aceita com ou sem máscara.
function optCnpj(value) {
  const s = optText(value, "cnpj", 30);
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length !== 14) throw new HttpError(400, "invalid_cnpj");
  return digits;
}

function optUf(value) {
  const s = optText(value, "uf", 2);
  return s ? s.toUpperCase() : null;
}

// Valor monetário: aceita número ou texto "1.234,56" / "1234.56".
function optMoney(value) {
  if (value === undefined || value === null || value === "") return null;
  let n = value;
  if (typeof value === "string") {
    const s = value.replace(/[R$\s]/g, "");
    n = Number(s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s);
  }
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1e12) throw new HttpError(400, "invalid_value");
  return Math.round(n * 100) / 100;
}

function optDate(value, field) {
  if (value === undefined || value === null || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `invalid_${field}`);
  return d.toISOString();
}

function optColor(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !COLOR_RE.test(value)) throw new HttpError(400, "invalid_color");
  return value.toLowerCase();
}

module.exports = { UUID_RE, optText, reqText, optUuid, reqUuid, optEmail, optCnpj, optUf, optMoney, optDate, optColor };
