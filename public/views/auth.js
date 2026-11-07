import { api, errorMessage, toast, PASSWORD_HINT } from "../client.js";
import { refreshUser, navigate } from "../app.js";

function card(title, subtitle, inner) {
  return `
    <div class="auth-card">
      <div class="auth-brand"><img src="assets/logo-header.png" alt="" /><span>SDR FD</span></div>
      <h1>${title}</h1>
      ${subtitle ? `<p class="muted">${subtitle}</p>` : ""}
      ${inner}
    </div>`;
}

function setBusy(form, busy) {
  form.querySelectorAll("button, input").forEach((el) => (el.disabled = busy));
}

function showError(form, message) {
  const box = form.querySelector(".form-error");
  box.textContent = message || "";
  box.hidden = !message;
}

export function renderLogin(container) {
  container.innerHTML = card(
    "Entrar",
    "Acesse com o seu e-mail corporativo.",
    `<form id="login-form" class="form" novalidate>
      <label>E-mail<input type="email" name="email" autocomplete="username" required autofocus /></label>
      <label>Senha<input type="password" name="password" autocomplete="current-password" required /></label>
      <p class="form-error" hidden></p>
      <button type="submit" class="btn btn-primary btn-block">Entrar</button>
      <a href="#/esqueci-senha" class="link-small">Esqueci minha senha</a>
    </form>`
  );

  const form = container.querySelector("#login-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError(form, "");
    const fd = new FormData(form);
    setBusy(form, true);
    const { ok, data } = await api("POST", "/auth/login", { email: fd.get("email"), password: fd.get("password") });
    setBusy(form, false);
    if (!ok) return showError(form, errorMessage(data));
    await refreshUser();
    navigate("/");
  });
}

export function renderForgotPassword(container) {
  container.innerHTML = card(
    "Esqueci minha senha",
    "Informe seu e-mail e enviaremos um link para criar uma nova senha.",
    `<form id="forgot-form" class="form" novalidate>
      <label>E-mail<input type="email" name="email" required autofocus /></label>
      <p class="form-error" hidden></p>
      <button type="submit" class="btn btn-primary btn-block">Enviar link</button>
      <a href="#/login" class="link-small">Voltar para o login</a>
    </form>`
  );

  const form = container.querySelector("#forgot-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError(form, "");
    setBusy(form, true);
    const { ok, data } = await api("POST", "/auth/forgot-password", { email: new FormData(form).get("email") });
    setBusy(form, false);
    if (!ok) return showError(form, errorMessage(data));
    form.innerHTML = `<p class="notice">Se o e-mail estiver cadastrado, você receberá um link válido por 1 hora.</p>
      <a href="#/login" class="btn btn-secondary btn-block">Voltar para o login</a>`;
  });
}

export function renderResetPassword(container, { query }) {
  const token = query.get("token") || "";
  container.innerHTML = card(
    "Criar nova senha",
    PASSWORD_HINT,
    `<form id="reset-form" class="form" novalidate>
      <label>Nova senha<input type="password" name="newPassword" autocomplete="new-password" required autofocus /></label>
      <label>Confirme a nova senha<input type="password" name="confirm" autocomplete="new-password" required /></label>
      <p class="form-error" hidden></p>
      <button type="submit" class="btn btn-primary btn-block">Salvar nova senha</button>
    </form>`
  );

  const form = container.querySelector("#reset-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    if (fd.get("newPassword") !== fd.get("confirm")) return showError(form, "As senhas não conferem.");
    showError(form, "");
    setBusy(form, true);
    const { ok, data } = await api("POST", "/auth/reset-password", { token, newPassword: fd.get("newPassword") });
    setBusy(form, false);
    if (!ok) return showError(form, errorMessage(data));
    toast("Senha redefinida. Entre com a nova senha.", "success");
    navigate("/login");
  });
}
