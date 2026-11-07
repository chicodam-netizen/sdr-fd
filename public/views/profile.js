import { escapeHtml, ROLE_LABELS } from "../client.js";
import { changePasswordForm, bindChangePasswordForm } from "./change-password.js";

export function renderProfile(container, { user }) {
  container.innerHTML = `
    <div class="page-head"><h1>Meu perfil</h1></div>
    <div class="grid-2">
      <div class="panel">
        <h2>Dados</h2>
        <dl class="details">
          <dt>Nome</dt><dd>${escapeHtml(user.name)}</dd>
          <dt>E-mail</dt><dd>${escapeHtml(user.email)}</dd>
          <dt>Perfil</dt><dd>${ROLE_LABELS[user.role]}</dd>
          <dt>Organização</dt><dd>${escapeHtml(user.organization.name)}</dd>
        </dl>
      </div>
      <div class="panel">
        <h2>Trocar senha</h2>
        ${changePasswordForm()}
      </div>
    </div>`;
  bindChangePasswordForm(container);
}
