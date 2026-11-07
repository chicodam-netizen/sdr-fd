// Servidor de desenvolvimento local: serve public/ e encaminha /api/* para a
// mesma função usada na Vercel (api/index.js). Dispensa o Vercel CLI para revisar localmente.
const http = require("http");
const fs = require("fs");
const path = require("path");
const apiHandler = require("../api/index");

const PORT = Number(process.env.PORT) || 3100;
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  let filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.statusCode = 403;
    res.end();
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, "index.html");
  }
  res.setHeader("Content-Type", MIME[path.extname(filePath)] || "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  fs.createReadStream(filePath).pipe(res);
}

function createServer() {
  return http.createServer((req, res) => {
    if (req.url.startsWith("/api/")) return apiHandler(req, res);
    serveStatic(req, res);
  });
}

if (require.main === module) {
  createServer().listen(PORT, () => {
    console.log(`SDR FD rodando em http://localhost:${PORT}`);
  });
}

module.exports = { createServer };
