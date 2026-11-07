// Testes de integração da API contra o banco LOCAL de teste.
// Cria uma organização própria e a remove ao final (ON DELETE CASCADE).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { createServer } = require("../scripts/dev-server");
const { getPool } = require("../lib/db");
const { hashPassword } = require("../lib/auth");

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || "")) {
  throw new Error("Os testes só rodam contra banco local.");
}

const suffix = crypto.randomBytes(4).toString("hex");
const ADMIN = { email: `admin-${suffix}@teste.local`, password: "SenhaAdmin123" };
const SDR = { email: `sdr-${suffix}@teste.local`, password: "SenhaSdr12345" };
let server, base, orgId;

function client() {
  let cookie = "";
  return async (method, path, body, headers = {}) => {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: res.status, data: await res.json(), setCookie };
  };
}

before(async () => {
  const pool = getPool();
  const org = await pool.query(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [`Teste ${suffix}`]);
  orgId = org.rows[0].id;
  for (const [u, role] of [[ADMIN, "admin"], [SDR, "sdr"]]) {
    await pool.query(
      `INSERT INTO users (organization_id, name, email, password_hash, role, must_change_password)
       VALUES ($1, $2, $3, $4, $5, false)`,
      [orgId, role.toUpperCase(), u.email, await hashPassword(u.password), role]
    );
  }
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await getPool().query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
  await getPool().query(`DELETE FROM audit_log WHERE details->>'email' LIKE $1`, [`%-${suffix}@teste.local`]);
  server.close();
  await getPool().end();
});

test("rotas protegidas exigem login", async () => {
  const api = client();
  assert.equal((await api("GET", "/users")).status, 401);
  assert.equal((await api("GET", "/auth/me")).status, 401);
});

test("rota inexistente retorna 404 e método errado 405", async () => {
  const api = client();
  assert.equal((await api("GET", "/nao-existe")).status, 404);
  assert.equal((await api("DELETE", "/auth/me", {})).status, 405);
});

test("login com senha errada falha; correta cria sessão httpOnly", async () => {
  const api = client();
  const bad = await api("POST", "/auth/login", { email: ADMIN.email, password: "errada" });
  assert.equal(bad.status, 401);
  assert.equal(bad.data.error, "invalid_credentials");

  const ok = await api("POST", "/auth/login", { email: ADMIN.email.toUpperCase(), password: ADMIN.password });
  assert.equal(ok.status, 200);
  assert.match(ok.setCookie, /HttpOnly/);
  assert.match(ok.setCookie, /SameSite=Lax/);

  const me = await api("GET", "/auth/me");
  assert.equal(me.data.user.email, ADMIN.email);
  assert.equal(me.data.user.role, "admin");
});

test("POST sem application/json é recusado (CSRF)", async () => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "email=a&password=b",
  });
  assert.equal(res.status, 415);
});

test("SDR não pode criar usuários; admin pode", async () => {
  const sdr = client();
  await sdr("POST", "/auth/login", SDR);
  const denied = await sdr("POST", "/users", { name: "X", email: `x-${suffix}@teste.local`, role: "sdr" });
  assert.equal(denied.status, 403);
  assert.equal((await sdr("GET", "/users")).status, 403);

  const admin = client();
  await admin("POST", "/auth/login", ADMIN);
  const created = await admin("POST", "/users", { name: "Novo", email: `novo-${suffix}@teste.local`, role: "gestor" });
  assert.equal(created.status, 201);
  assert.equal(created.data.user.mustChangePassword, true);
  // MAIL_ENABLED=false nos testes: e-mail simulado => senha temporária volta para o admin
  assert.equal(created.data.mail.simulated, true);
  assert.ok(created.data.tempPassword);

  const dup = await admin("POST", "/users", { name: "Dup", email: `NOVO-${suffix}@teste.local`, role: "sdr" });
  assert.equal(dup.status, 409);

  // Novo usuário: login com senha temporária fica bloqueado até trocar a senha
  const novo = client();
  await novo("POST", "/auth/login", { email: `novo-${suffix}@teste.local`, password: created.data.tempPassword });
  assert.equal((await novo("GET", "/users")).data.error, "password_change_required");
  const weak = await novo("POST", "/auth/change-password", { currentPassword: created.data.tempPassword, newPassword: "curta" });
  assert.equal(weak.data.error, "password_too_short");
  const changed = await novo("POST", "/auth/change-password", {
    currentPassword: created.data.tempPassword,
    newPassword: "NovaSenha2026",
  });
  assert.equal(changed.status, 200);
  assert.equal((await novo("GET", "/users")).status, 200);
});

test("admin não pode se desativar; desativar outro encerra a sessão dele", async () => {
  const admin = client();
  await admin("POST", "/auth/login", ADMIN);
  const me = (await admin("GET", "/auth/me")).data.user;
  assert.equal((await admin("PATCH", `/users/${me.id}`, { active: false })).data.error, "cannot_deactivate_self");

  const sdr = client();
  await sdr("POST", "/auth/login", SDR);
  const users = (await admin("GET", "/users")).data.users;
  const sdrUser = users.find((u) => u.email === SDR.email);
  assert.equal((await admin("PATCH", `/users/${sdrUser.id}`, { active: false })).status, 200);
  assert.equal((await sdr("GET", "/auth/me")).status, 401);
  assert.equal((await sdr("POST", "/auth/login", SDR)).status, 401);
  await admin("PATCH", `/users/${sdrUser.id}`, { active: true });
});

test("isolamento entre organizações: id de outra org retorna 404", async () => {
  const admin = client();
  await admin("POST", "/auth/login", ADMIN);
  const other = await getPool().query(`SELECT gen_random_uuid() AS id`);
  assert.equal((await admin("PATCH", `/users/${other.rows[0].id}`, { name: "X" })).status, 404);
  assert.equal((await admin("PATCH", `/users/nao-e-uuid`, { name: "X" })).status, 404);
});

test("esqueci a senha: resposta igual para e-mail inexistente; token redefine a senha", async () => {
  const api = client();
  assert.equal((await api("POST", "/auth/forgot-password", { email: `ninguem-${suffix}@teste.local` })).status, 200);

  // Insere um token conhecido diretamente (o real só vai por e-mail).
  const token = crypto.randomBytes(32).toString("base64url");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  await getPool().query(
    `INSERT INTO password_resets (token_hash, user_id, expires_at)
     SELECT $1, id, now() + interval '1 hour' FROM users WHERE email = $2`,
    [hash, SDR.email]
  );
  assert.equal((await api("POST", "/auth/reset-password", { token, newPassword: "Redefinida2026" })).status, 200);
  assert.equal((await api("POST", "/auth/reset-password", { token, newPassword: "Outra2026abc" })).data.error, "invalid_or_expired_token");
  assert.equal((await api("POST", "/auth/login", { email: SDR.email, password: "Redefinida2026" })).status, 200);
});

test("bloqueio após 5 tentativas erradas", async () => {
  const api = client();
  const email = `bloqueio-${suffix}@teste.local`;
  for (let i = 0; i < 5; i++) await api("POST", "/auth/login", { email, password: "x" });
  assert.equal((await api("POST", "/auth/login", { email, password: "x" })).status, 429);
});
