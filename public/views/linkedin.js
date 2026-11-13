// Tarefas de LinkedIn: passos manuais da cadência (pedido de conexão / mensagem) e respostas pelo LinkedIn.
// A IA escreve o texto; a pessoa abre o perfil, cola, envia pelo LinkedIn e marca como feito.
// Nada é enviado ao LinkedIn pelo sistema (sem automação na plataforma).
import { api, errorMessage, escapeHtml, formatDateTime, refreshIcons, toast } from "../client.js";
import { openDeal } from "./deal-dialog.js";
import { CATEGORY_LABELS } from "./conversation.js";

const TASK_LABELS = {
  linkedin_connect: { label: "Pedido de conexão", icon: "user-plus", limit: 300 },
  linkedin_message: { label: "Mensagem", icon: "message-square", limit: 8000 },
  linkedin_reply: { label: "Resposta", icon: "reply", limit: 8000 },
};
let state;

function searchUrl(t) {
  const q = [t.contact?.name, t.company].filter(Boolean).join(" ");
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(q)}`;
}

function profileHtml(t) {
  if (!t.contact) return `<div class="notice notice-warning">Card sem contato: cadastre o contato na ficha do card.</div>`;
  if (t.contact.linkedinUrl) {
    return `<div class="li-profile">
      <a class="btn btn-secondary btn-sm" href="${escapeHtml(t.contact.linkedinUrl)}" target="_blank" rel="noopener noreferrer"><i data-lucide="external-link"></i>Abrir perfil</a>
      <span class="muted small">${escapeHtml(t.contact.linkedinUrl.replace("https://www.linkedin.com", ""))}</span>
      <button type="button" class="link-btn" data-act="edit-url">trocar</button>
    </div>`;
  }
  return `<div class="li-profile li-profile-missing">
    <a class="btn btn-secondary btn-sm" href="${searchUrl(t)}" target="_blank" rel="noopener noreferrer"><i data-lucide="search"></i>Buscar no LinkedIn</a>
    <input class="li-url" placeholder="Cole aqui o link do perfil (linkedin.com/in/...)" />
    <button type="button" class="btn btn-secondary btn-sm" data-act="save-url">Salvar perfil</button>
  </div>`;
}

function inboundHtml(t) {
  const i = t.lastInbound;
  if (t.ai?.kind !== "linkedin_reply" || !i) return "";
  return `<details class="lead-reply" open>
    <summary><i data-lucide="mail-open"></i>Mensagem do lead${i.category ? ` · <span class="badge">${escapeHtml(CATEGORY_LABELS[i.category] || i.category)}</span>` : ""}</summary>
    <pre class="lead-reply-body">${escapeHtml(i.body || "")}</pre>
  </details>`;
}

function taskHtml(t) {
  const kind = TASK_LABELS[t.ai?.kind] || TASK_LABELS.linkedin_message;
  const blocked = t.contact?.optOut;
  return `<article class="panel approval li-task" data-id="${t.id}">
    <header class="approval-head">
      <div>
        <strong>${escapeHtml(t.company)}</strong>
        <span class="muted small">· ${escapeHtml(t.contact?.name || "sem contato")}${t.contact?.jobTitle ? ` — ${escapeHtml(t.contact.jobTitle)}` : ""}${t.city ? ` · ${escapeHtml(t.city)}` : ""}</span>
        <div class="muted small"><span class="badge"><i data-lucide="${kind.icon}"></i>${kind.label}</span>${t.step ? ` · passo ${t.step} da cadência` : ""} · ${escapeHtml(t.agentName || "")} · gerado ${formatDateTime(t.createdAt)}</div>
      </div>
      <button class="btn btn-secondary btn-sm" data-act="open"><i data-lucide="panel-right-open"></i>Abrir card</button>
    </header>
    ${blocked ? `<div class="notice notice-danger">Contato pediu para não ser contatado.</div>` : ""}
    ${profileHtml(t)}
    ${inboundHtml(t)}
    ${t.ai?.rationale ? `<p class="msg-rationale"><i data-lucide="sparkles"></i>${escapeHtml(t.ai.rationale)}</p>` : ""}
    <label class="msg-field">Texto para o LinkedIn
      <textarea class="li-body" rows="${kind.limit <= 300 ? 4 : 7}">${escapeHtml(t.body)}</textarea></label>
    <div class="li-count muted small" data-limit="${kind.limit}"></div>
    <div class="msg-actions">
      <button class="btn btn-ghost-danger btn-sm" data-act="skip" title="Não deu para fazer (sem perfil, não aceitou a conexão...): a cadência segue para o próximo passo"><i data-lucide="skip-forward"></i>Pular</button>
      <button class="btn btn-secondary btn-sm" data-act="copy"><i data-lucide="copy"></i>Copiar texto</button>
      <button class="btn btn-primary btn-sm" data-act="done" ${blocked ? "disabled" : ""}><i data-lucide="check"></i>Feito: enviei no LinkedIn</button>
    </div>
  </article>`;
}

async function load() {
  const { ok, data } = await api("GET", "/linkedin/tasks");
  state.items = ok ? data.tasks : [];
  if (!ok) toast(errorMessage(data), "error");
  draw();
}

function draw() {
  const list = state.container.querySelector("#li-tasks");
  list.innerHTML = state.items.length
    ? state.items.map(taskHtml).join("")
    : `<div class="panel empty-state"><i data-lucide="check-check"></i><h2>Nenhuma tarefa de LinkedIn</h2>
        <p class="muted">As tarefas aparecem aqui quando a cadência de um agente chega a um passo de LinkedIn. Configure os passos em Agentes SDR → Cadência.</p></div>`;
  state.container.querySelector("#li-count").textContent = state.items.length;
  refreshIcons();
  list.querySelectorAll(".li-task").forEach(bindTask);
}

function bindTask(el) {
  const id = el.dataset.id;
  const t = state.items.find((x) => x.id === id);
  const body = el.querySelector(".li-body");
  const counter = el.querySelector(".li-count");
  const limit = Number(counter.dataset.limit);
  const count = () => {
    const n = body.value.length;
    counter.textContent = limit <= 300 ? `${n}/${limit} caracteres${n > limit ? " — acima do limite da nota de conexão" : ""}` : `${n} caracteres`;
    counter.classList.toggle("li-over", n > limit);
  };
  body.addEventListener("input", count);
  count();

  el.querySelector("[data-act=open]").addEventListener("click", () =>
    openDeal(t.dealId, { pipelines: state.pipelines, owners: state.owners, user: state.user, onMessagesChanged: load, onDelete: load })
  );
  el.querySelector("[data-act=copy]").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(body.value);
      toast("Texto copiado. Cole no LinkedIn.", "success");
    } catch {
      body.select();
      toast("Selecione e copie o texto (Ctrl+C).", "warning");
    }
  });
  el.querySelector("[data-act=edit-url]")?.addEventListener("click", () => {
    t.contact.linkedinUrl = null;
    const fresh = document.createElement("div");
    fresh.innerHTML = profileHtml(t);
    el.querySelector(".li-profile").replaceWith(fresh.firstElementChild);
    refreshIcons();
    bindUrl(el, t);
  });
  bindUrl(el, t);
  el.querySelector("[data-act=done]").addEventListener("click", async (e) => {
    if (body.value.length > limit && !confirm("O texto passa do limite da nota de conexão (300). Marcar como feito mesmo assim?")) return;
    e.currentTarget.disabled = true;
    const r = await api("POST", `/messages/${id}/linkedin-done`, { body: body.value });
    if (!r.ok) {
      e.currentTarget.disabled = false;
      return toast(errorMessage(r.data), "error");
    }
    toast(`${t.company}: registrado no histórico.`, "success");
    load();
  });
  el.querySelector("[data-act=skip]").addEventListener("click", async () => {
    const reason = prompt("Pular esta tarefa? A cadência segue para o próximo passo.\nMotivo (opcional):", "");
    if (reason === null) return;
    const r = await api("POST", `/messages/${id}/linkedin-skip`, { reason });
    if (!r.ok) return toast(errorMessage(r.data), "error");
    toast("Tarefa pulada.", "success");
    load();
  });
}

function bindUrl(el, t) {
  el.querySelector("[data-act=save-url]")?.addEventListener("click", async () => {
    const url = el.querySelector(".li-url").value.trim();
    if (!url) return toast("Cole o link do perfil.", "error");
    const r = await api("POST", `/contacts/${t.contact.id}/linkedin`, { url });
    if (!r.ok) return toast(errorMessage(r.data), "error");
    toast("Perfil salvo no contato.", "success");
    load();
  });
}

export async function renderLinkedin(container, { user }) {
  state = { container, user, items: [], pipelines: [], owners: [] };
  container.innerHTML = `
    <div class="page-head">
      <h1>LinkedIn <span class="badge" id="li-count">…</span></h1>
      <p class="muted">Tarefas do dia: a IA escreveu o texto; abra o perfil, cole, envie pelo LinkedIn e marque como feito. O sistema não acessa o LinkedIn.</p>
    </div>
    <details class="panel li-help">
      <summary><i data-lucide="info"></i>Como fazer cada tarefa</summary>
      <ol class="small">
        <li><strong>Pedido de conexão:</strong> no perfil, clique em Conectar → Adicionar nota → cole o texto (limite de 300 caracteres) → Enviar.</li>
        <li><strong>Mensagem / Resposta:</strong> só funciona se vocês já estão conectados. Se a conexão ainda não foi aceita, use <em>Pular</em>.</li>
        <li><strong>Lead respondeu no LinkedIn?</strong> Abra o card → Conversa → Registrar resposta recebida → canal LinkedIn. A IA classifica e prepara a resposta aqui.</li>
        <li>No plano gratuito o LinkedIn limita a quantidade de convites (e de convites com nota) por semana/mês: distribua as tarefas ao longo dos dias.</li>
      </ol>
    </details>
    <div id="li-tasks"><p class="muted">Carregando...</p></div>`;
  refreshIcons();
  const [p, o] = await Promise.all([api("GET", "/pipelines"), api("GET", "/users/options")]);
  state.pipelines = p.ok ? p.data.pipelines : [];
  state.owners = o.ok ? o.data.users : [];
  await load();
}
