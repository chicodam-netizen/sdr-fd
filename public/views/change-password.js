import { api, errorMessage, toast, PASSWORD_HINT } from "../client.js";
import { refreshUser, navigate } from "../app.js";

// Formulário de troca de senha, reaproveitado na troca obrigatória (1º acesso) e no Perfil.
export function changePasswordForm() {
  return `
    <form id="change-password-form" class="form" novalidate>
      <label>Senha atual<input type="password" name="currentPassword" autocomplete="current-password" required /></label>
      <label>Nova senha<input type="password" name="newPassword" autocomplete="new-password" required /></label>
      <label>Confirme a nova senha<input type="password" name="confirm" autocomplete="new-password" required /></label>
      <p class="hint">${PASSWORD_HINT}</p>
      <p class="form-error" hidden></p>
      <button type="submit" class="btn btn-primary">Salvar nova senha</button>
    </form>`;
}

export function bindChangePasswordForm(container, onDone) {
  const form = container.querySelector("#change-password-form");
  const errorBox = form.querySelector(".form-error");
  const showError = (msg) => {
    errorBox.textContent = msg || "";
    errorBox.hidden = !msg;
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    if (fd.get("newPassword") !== fd.get("confirm")) return showError("As senhas não conferem.");
    showError("");
    form.querySelector("button").disabled = true;
    const { ok, data } = await api("POST", "/auth/change-password", {
      currentPassword: fd.get("currentPassword"),
      newPassword: fd.get("newPassword"),
    });
    form.querySelector("button").disabled = false;
    if (!ok) return showError(errorMessage(data));
    form.reset();
    toast("Senha alterada.", "success");
    onDone?.();
  });
}

export function renderChangePassword(container) {
  container.innerHTML = `
    <div class="auth-card">
      <div class="auth-brand"><img src="assets/logo-header.png" alt="" /><span>SDR FD</span></div>
      <h1>Defina sua senha</h1>
      <p class="muted">Por segurança, troque a senha temporária antes de continuar.</p>
      ${changePasswordForm()}
    </div>`;
  bindChangePasswordForm(container, async () => {
    await refreshUser();
    navigate("/");
  });
}
