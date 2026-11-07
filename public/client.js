// Cliente da API + utilitários de interface compartilhados pelas views.

export async function api(method, path, body) {
  const opts = { method, credentials: "same-origin", headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`/api${path}`, opts);
  } catch {
    return { ok: false, status: 0, data: { ok: false, error: "network_error" } };
  }
  const data = await res.json().catch(() => ({ ok: false, error: "invalid_response" }));
  return { ok: res.ok, status: res.status, data };
}

const ERRORS = {
  network_error: "Sem conexão com o servidor.",
  internal_error: "Erro interno. Tente novamente.",
  invalid_credentials: "E-mail ou senha inválidos.",
  missing_credentials: "Informe e-mail e senha.",
  too_many_attempts: "Muitas tentativas. Aguarde 15 minutos e tente novamente.",
  password_too_short: "A senha precisa ter pelo menos 10 caracteres.",
  password_needs_letters_and_numbers: "A senha precisa ter letras e números.",
  wrong_current_password: "Senha atual incorreta.",
  password_unchanged: "A nova senha deve ser diferente da atual.",
  invalid_or_expired_token: "Link inválido ou expirado. Solicite um novo.",
  missing_token: "Link inválido.",
  missing_email: "Informe o e-mail.",
  missing_name: "Informe o nome.",
  invalid_email: "E-mail inválido.",
  invalid_role: "Perfil inválido.",
  email_in_use: "Já existe um usuário com esse e-mail.",
  cannot_change_own_role: "Você não pode alterar o seu próprio perfil.",
  cannot_deactivate_self: "Você não pode desativar o seu próprio usuário.",
  user_inactive: "Usuário inativo.",
  forbidden: "Você não tem permissão para esta ação.",
  unauthorized: "Sua sessão expirou. Entre novamente.",
  missing_company_name: "Informe o nome da empresa.",
  invalid_cnpj: "CNPJ inválido (precisa ter 14 dígitos).",
  invalid_value: "Valor inválido.",
  invalid_owner: "Responsável inválido.",
  invalid_stage_id: "Etapa inválida.",
  cnpj_in_use: "Já existe uma empresa com esse CNPJ.",
  missing_contact_name: "Informe o nome ou e-mail do contato.",
  stage_not_empty: "Esta etapa tem cards. Mova-os antes de excluir.",
  last_stage: "O funil precisa de pelo menos uma etapa.",
  last_pipeline: "É preciso manter pelo menos um funil ativo.",
  too_many_rows: "Máximo de 2.000 linhas por importação.",
  missing_rows: "Nenhuma linha para importar.",
  not_found: "Registro não encontrado.",
  missing_body: "Escreva a anotação.",
};

export function errorMessage(data) {
  return ERRORS[data?.error] || "Não foi possível concluir a operação.";
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function toast(message, kind = "info") {
  const box = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

export function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

export const ROLE_LABELS = { admin: "Administrador", gestor: "Gestor", sdr: "SDR" };

export function formatDateTime(iso) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

// Mensagem padronizada sobre o resultado do envio de e-mail (sent / simulado / falhou).
export function mailToast(result, okText) {
  if (result.mail?.sent) {
    toast(`${okText} E-mail enviado.`, "success");
  } else if (result.mail?.simulated) {
    toast(`${okText} E-mail NÃO enviado (envio desativado neste ambiente).`, "warning");
  } else {
    toast(`${okText} Falha ao enviar o e-mail.`, "error");
  }
}

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
export function formatMoney(value) {
  return value === null || value === undefined ? "" : money.format(value);
}

export function formatDate(iso) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(iso));
}

export function daysSince(iso) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

export function formatCnpj(d) {
  return d && d.length === 14 ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}` : d || "";
}

// Preferências locais do usuário (visão do funil etc.). Falha silenciosa sem storage.
export const prefs = {
  get(key, fallback) {
    try {
      return localStorage.getItem(`sdr.${key}`) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`sdr.${key}`, value);
    } catch {}
  },
};

export const PASSWORD_HINT = "Mínimo de 10 caracteres, com letras e números.";
