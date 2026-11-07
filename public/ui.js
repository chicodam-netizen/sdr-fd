// Componentes de interface reaproveitáveis: modal/painel lateral e formulário com erro.
import { refreshIcons } from "./client.js";

// Abre um <dialog> próprio (anexado ao body, removido ao fechar).
// variant: "modal" (centro) ou "drawer" (painel lateral à direita).
export function openDialog(html, { variant = "modal", onClose } = {}) {
  const dialog = document.createElement("dialog");
  dialog.className = variant === "drawer" ? "dialog drawer" : "dialog";
  dialog.innerHTML = html;
  document.body.appendChild(dialog);
  dialog.addEventListener("close", () => {
    dialog.remove();
    onClose?.();
  });
  // Clique no fundo fecha.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.showModal();
  bindClose(dialog);
  refreshIcons();
  return dialog;
}

export function bindClose(root) {
  root.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog")?.close()));
}

// Liga o submit de um form: desabilita o botão durante a chamada e mostra o erro retornado.
export function bindForm(form, onSubmit) {
  const errorBox = form.querySelector(".form-error");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (errorBox) errorBox.hidden = true;
    const submit = form.querySelector("button[type=submit]");
    if (submit) submit.disabled = true;
    const err = await onSubmit(new FormData(form));
    if (submit) submit.disabled = false;
    if (err && errorBox) {
      errorBox.textContent = err;
      errorBox.hidden = false;
    }
  });
}

export function options(list, selected, { empty } = {}) {
  const head = empty !== undefined ? `<option value="">${empty}</option>` : "";
  return head + list.map((o) => `<option value="${o.value}"${o.value === selected ? " selected" : ""}>${o.label}</option>`).join("");
}
