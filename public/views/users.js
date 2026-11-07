import { api, errorMessage, escapeHtml, formatDateTime, mailToast, refreshIcons, toast, ROLE_LABELS } from "../client.js";

let state;

function roleOptions(selected) {
  return Object.entries(ROLE_LABELS)
    .map(([v, l]) => `<option value="${v}"${v === selected ? " selected" : ""}>${l}</option>`)
    .join("");
}

function rowHtml(u, me) {
  const isAdmin = me.role === "admin";
  const status = u.active
    ? u.mustChangePassword
      ? `<span class="badge badge-warning">Aguardando 1º acesso</span>`
      : `<span class="badge badge-success">Ativo</span>`
    : `<span class="badge badge-muted">Inativo</span>`;
  const actions = isAdmin
    ? `<button class="icon-btn" data-action="edit" data-id="${u.id}" title="Editar"><i data-lucide="pencil"></i></button>
       ${u.active ? `<button class="icon-btn" data-action="reset" data-id="${u.id}" title="Gerar nova senha temporária"><i data-lucide="key-round"></i></button>` : ""}`
    : "";
  return `<tr>
    <td data-label="Nome"><strong>${escapeHtml(u.name)}</strong>${u.id === me.id ? ` <span class="muted">(você)</span>` : ""}</td>
    <td data-label="E-mail">${escapeHtml(u.email)}</td>
    <td data-label="Perfil">${ROLE_LABELS[u.role]}</td>
    <td data-label="Situação">${status}</td>
    <td data-label="Último acesso">${formatDateTime(u.lastLoginAt)}</td>
    <td class="actions">${actions}</td>
  </tr>`;
}

function draw(container) {
  const { users, me, loading, loadError } = state;
  let body;
  if (loading) body = `<p class="muted">Carregando...</p>`;
  else if (loadError) body = `<p class="form-error">${escapeHtml(loadError)}</p>`;
  else
    body = `<table class="table">
      <thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Situação</th><th>Último acesso</th><th></th></tr></thead>
      <tbody>${users.map((u) => rowHtml(u, me)).join("")}</tbody>
    </table>`;

  container.innerHTML = `
    <div class="page-head page-head-row">
      <div><h1>Usuários</h1><p class="muted">Quem tem acesso ao sistema e com qual perfil.</p></div>
      ${me.role === "admin" ? `<button class="btn btn-primary" id="new-user"><i data-lucide="user-plus"></i>Novo usuário</button>` : ""}
    </div>
    <div class="panel panel-flush">${body}</div>
    <dialog id="user-dialog" class="dialog"></dialog>`;
  refreshIcons();
}

async function load(container) {
  state.loading = true;
  draw(container);
  const { ok, data } = await api("GET", "/users");
  state.loading = false;
  state.loadError = ok ? null : errorMessage(data);
  state.users = ok ? data.users : [];
  draw(container);
}

function openDialog(container, html, onSubmit) {
  const dialog = container.querySelector("#user-dialog");
  dialog.innerHTML = html;
  dialog.showModal();
  refreshIcons();
  dialog.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => dialog.close()));
  const form = dialog.querySelector("form");
  if (form && onSubmit) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errorBox = form.querySelector(".form-error");
      errorBox.hidden = true;
      form.querySelector("button[type=submit]").disabled = true;
      const err = await onSubmit(new FormData(form), dialog);
      form.querySelector("button[type=submit]")?.removeAttribute("disabled");
      if (err) {
        errorBox.textContent = err;
        errorBox.hidden = false;
      }
    });
  }
  return dialog;
}

// Quando o e-mail não saiu, mostra a senha temporária uma única vez para o admin repassar.
function showTempPassword(dialog, email, tempPassword) {
  dialog.innerHTML = `
    <h2>Senha temporária</h2>
    <p class="muted">O e-mail para <strong>${escapeHtml(email)}</strong> não foi enviado. Repasse a senha abaixo por um canal seguro — ela não será exibida novamente.</p>
    <p class="temp-password">${escapeHtml(tempPassword)}</p>
    <div class="dialog-actions"><button class="btn btn-primary" data-close>Entendi</button></div>`;
  dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
}

function openCreate(container) {
  openDialog(
    container,
    `<form class="form" novalidate>
      <h2>Novo usuário</h2>
      <label>Nome<input name="name" required autofocus /></label>
      <label>E-mail<input type="email" name="email" required /></label>
      <label>Perfil<select name="role">${roleOptions("sdr")}</select></label>
      <p class="hint">Uma senha temporária será enviada por e-mail; a troca é obrigatória no 1º acesso.</p>
      <p class="form-error" hidden></p>
      <div class="dialog-actions">
        <button type="button" class="btn btn-secondary" data-close>Cancelar</button>
        <button type="submit" class="btn btn-primary">Criar usuário</button>
      </div>
    </form>`,
    async (fd, dialog) => {
      const { ok, data } = await api("POST", "/users", {
        name: fd.get("name"),
        email: fd.get("email"),
        role: fd.get("role"),
      });
      if (!ok) return errorMessage(data);
      mailToast(data, "Usuário criado.");
      state.users.push(data.user);
      draw(container);
      bind(container);
      if (data.tempPassword) {
        const d = container.querySelector("#user-dialog");
        d.showModal();
        showTempPassword(d, data.user.email, data.tempPassword);
      } else dialog.close();
      return null;
    }
  );
}

function openEdit(container, user) {
  const self = user.id === state.me.id;
  openDialog(
    container,
    `<form class="form" novalidate>
      <h2>Editar usuário</h2>
      <p class="muted">${escapeHtml(user.email)}</p>
      <label>Nome<input name="name" value="${escapeHtml(user.name)}" required /></label>
      <label>Perfil<select name="role"${self ? " disabled" : ""}>${roleOptions(user.role)}</select></label>
      <label class="check"><input type="checkbox" name="active"${user.active ? " checked" : ""}${self ? " disabled" : ""} /> Usuário ativo</label>
      ${self ? `<p class="hint">Você não pode alterar o próprio perfil nem se desativar.</p>` : ""}
      <p class="form-error" hidden></p>
      <div class="dialog-actions">
        <button type="button" class="btn btn-secondary" data-close>Cancelar</button>
        <button type="submit" class="btn btn-primary">Salvar</button>
      </div>
    </form>`,
    async (fd, dialog) => {
      const payload = { name: fd.get("name") };
      if (!self) {
        payload.role = fd.get("role");
        payload.active = fd.get("active") === "on";
      }
      const { ok, data } = await api("PATCH", `/users/${user.id}`, payload);
      if (!ok) return errorMessage(data);
      toast("Usuário atualizado.", "success");
      dialog.close();
      state.users = state.users.map((u) => (u.id === user.id ? data.user : u));
      draw(container);
      bind(container);
      return null;
    }
  );
}

function openReset(container, user) {
  openDialog(
    container,
    `<form class="form">
      <h2>Gerar nova senha temporária</h2>
      <p>Uma nova senha temporária será enviada para <strong>${escapeHtml(user.email)}</strong>. A senha atual deixa de valer e as sessões abertas desse usuário são encerradas.</p>
      <p class="form-error" hidden></p>
      <div class="dialog-actions">
        <button type="button" class="btn btn-secondary" data-close>Cancelar</button>
        <button type="submit" class="btn btn-danger">Gerar nova senha</button>
      </div>
    </form>`,
    async (_fd, dialog) => {
      const { ok, data } = await api("POST", `/users/${user.id}/reset-password`, {});
      if (!ok) return errorMessage(data);
      mailToast(data, "Senha redefinida.");
      if (data.tempPassword) showTempPassword(dialog, user.email, data.tempPassword);
      else dialog.close();
      return null;
    }
  );
}

function bind(container) {
  container.querySelector("#new-user")?.addEventListener("click", () => openCreate(container));
  container.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const user = state.users.find((u) => u.id === btn.dataset.id);
      if (btn.dataset.action === "edit") openEdit(container, user);
      if (btn.dataset.action === "reset") openReset(container, user);
    });
  });
}

export async function renderUsers(container, { user }) {
  state = { me: user, users: [], loading: true, loadError: null };
  await load(container);
  bind(container);
}
