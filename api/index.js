// Função serverless única: todas as rotas /api/* chegam aqui (ver vercel.json)
// e são despachadas pela tabela de rotas de lib/routes. Uma função só evita o
// limite de funções do plano Hobby da Vercel conforme o sistema cresce.
const { HttpError, sendJson, readJsonBody, clientIp } = require("../lib/http");
const { loadSessionUser, requireRole } = require("../lib/auth");

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

const routeDefs = [
  ...require("../lib/routes/auth"),
  ...require("../lib/routes/users"),
  ...require("../lib/routes/pipelines").routes,
  ...require("../lib/routes/deals"),
  ...require("../lib/routes/companies"),
  ...require("../lib/routes/import"),
  ...require("../lib/routes/dashboard"),
];

// "/users/:id" -> /^\/users\/(?<id>uuid)$/  (parâmetros são sempre UUID)
const routes = routeDefs.map((r) => ({
  ...r,
  regex: new RegExp("^" + r.path.replace(/:(\w+)/g, `(?<$1>${UUID})`) + "$"),
}));

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function parseUrl(req) {
  const url = new URL(req.url, "http://localhost");
  // A rewrite da Vercel envia o caminho original em ?__path=; no dev server vem no próprio pathname.
  const fromQuery = url.searchParams.get("__path");
  url.searchParams.delete("__path");
  const raw = fromQuery !== null ? `/${fromQuery}` : url.pathname.replace(/^\/api/, "");
  return { path: raw.replace(/\/+$/, "") || "/", query: url.searchParams };
}

function matchRoute(method, path) {
  let pathMatched = false;
  for (const r of routes) {
    const m = r.regex.exec(path);
    if (!m) continue;
    pathMatched = true;
    if (r.method === method) return { route: r, params: m.groups || {} };
  }
  return { route: null, pathMatched };
}

module.exports = async (req, res) => {
  try {
    const { path, query } = parseUrl(req);
    const { route, params, pathMatched } = matchRoute(req.method, path);
    if (!route) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? "method_not_allowed" : "not_found");

    // Proteção CSRF complementar ao SameSite=Lax: formulários de outros sites
    // não conseguem enviar application/json sem preflight CORS.
    if (MUTATING.has(req.method) && !String(req.headers["content-type"] || "").includes("application/json")) {
      throw new HttpError(415, "json_required");
    }

    const user = await loadSessionUser(req, res);
    if (!route.public) {
      requireRole(user, route.roles);
      if (user.mustChangePassword && !route.allowPendingPasswordChange) {
        throw new HttpError(403, "password_change_required");
      }
    }

    const body = MUTATING.has(req.method) ? await readJsonBody(req) : {};
    const result = await route.handler({ req, res, user, params, query, body, ip: clientIp(req) });

    if (result && result.status) sendJson(res, result.status, result.body);
    else sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { ok: false, error: err.code });
      return;
    }
    console.error("api error:", err);
    sendJson(res, 500, { ok: false, error: "internal_error" });
  }
};
