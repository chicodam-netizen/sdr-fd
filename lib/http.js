// Helpers HTTP independentes da Vercel: funcionam tanto na função serverless
// quanto no servidor de desenvolvimento local (node:http puro).

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  // Na Vercel, req.body já vem parseado; no node:http puro lemos o stream.
  if (req.body !== undefined) {
    if (typeof req.body === "string") return parseOrThrow(req.body);
    return req.body || {};
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new HttpError(413, "body_too_large");
    chunks.push(chunk);
  }
  return parseOrThrow(Buffer.concat(chunks).toString("utf8"));
}

function parseOrThrow(text) {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new HttpError(400, "invalid_body");
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (key) out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.socket?.remoteAddress || null;
}

module.exports = { HttpError, sendJson, readJsonBody, parseCookies, clientIp };
