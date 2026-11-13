// Fila de aprovação: todos os rascunhos gerados pela IA aguardando revisão humana.
import { api, errorMessage, escapeHtml, formatDateTime, refreshIcons, toast } from "../client.js";
import { openDeal } from "./deal-dialog.js";

const KIND_LABELS = { first: "Primeiro contato", followup: "Follow-up", reply: "Resposta" };
const CATEGORY_LABELS = {
  interested: "Interessado", meeting_request: "Pediu reunião", question: "Pergunta", objection: "Objeção", not_now: "Agora não",
  not_interested: "Sem interesse", unsubscribe: "Pediu para sair", out_of_office: "Ausência", wrong_person: "Pessoa errada", other: "Outro",
};

// Rascunho de resposta: mostra o que o lead escreveu (e como a IA classificou) para revisar com contexto.
function inboundHtml(m) {
  const i = m.lastInbound;
  if (m.ai?.kind !== "reply" || !i) return "";
  return `<details class="lead-reply" open>
    <summary><i data-lucide="mail-open"></i>Mensagem do lead${i.category ? ` · <span class="badge">${escapeHtml(CATEGORY_LABELS[i.category] || i.category)}</span>` : ""}${i.at ? ` · <span class="muted small">${formatDateTime(i.at)}</span>` : ""}</summary>
    ${i.summary ? `<p class="muted small">Resumo da IA: ${escapeHtml(i.summary)}</p>` : ""}
    ${i.subject ? `<div class="small"><strong>${escapeHtml(i.subject)}</strong></div>` : ""}
    <pre class="lead-reply-body">${escapeHtml(i.body || "")}</pre>
  </details>`;
}

function automationHtml(a) {
  if (!a) return "";
  const when = (iso) => (iso ? new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "—");
  const ib = a.lastInbox;
  const cd = a.lastCadence;
  const last = a.lastRunAt
    ? `Última verificação ${when(a.lastRunAt)}: ${ib?.ok ? `${ib.matched} resposta(s) de leads, ${ib.drafted} rascunho(s) de resposta` : ib?.error === "imap_not_configured" ? "caixa de entrada não configurada" : "erro ao ler a caixa"}; cadência: ${cd ? `${cd.drafted} rascunho(s), ${cd.sent} enviado(s)` : "—"}.`
    : "Ainda não rodou desde que o servidor subiu.";
  return a.enabled
    ? `<div class="notice automation-status"><i data-lucide="bot"></i><span><strong>Automação ligada</strong> · lê a caixa de entrada e processa as cadências a cada ${a.intervalMin} min${a.running ? " · <em>rodando agora…</em>" : ` · próxima às ${when(a.nextRunAt)}`}<br><span class="muted small">${last}</span></span></div>`
    : `<div class="notice automation-status"><i data-lucide="bot-off"></i><span><strong>Automação desligada</strong> · use os botões ao lado para ler a caixa e processar as cadências manualmente.</span></div>`;
}

async function loadAutomation() {
  const box = state.container.querySelector("#automation");
  if (!box) return;
  const r = await api("GET", "/automation");
  box.innerHTML = r.ok ? automationHtml(r.data) : "";
  refreshIcons();
}
let state;

function itemHtml(m) {
  const blocked = m.contact?.optOut ? "opt-out" : !m.contact?.email ? "sem e-mail" : null;
  return `<article class="panel approval" data-id="${m.id}">
    <header class="approval-head">
      <div>
        <strong>${escapeHtml(m.company)}</strong>
        <span class="muted small">· ${escapeHtml(m.contact?.name || "sem contato")}${m.contact?.email ? ` &lt;${escapeHtml(m.contact.email)}&gt;` : ""}</span>
        <div class="muted small">${KIND_LABELS[m.ai?.kind] || "Mensagem"}${m.step ? ` · passo ${m.step} da cadência` : ""} · ${escapeHtml(m.agentName || "")} · gerado ${formatDateTime(m.createdAt)}${m.createdByName ? ` por ${escapeHtml(m.createdByName)}` : ""}</div>
      </div>
      <button class="btn btn-secondary btn-sm" data-act="open"><i data-lucide="panel-right-open"></i>Abrir card</button>
    </header>
    ${inboundHtml(m)}
    ${m.ai?.rationale ? `<p class="msg-rationale"><i data-lucide="sparkles"></i>${escapeHtml(m.ai.rationale)}</p>` : ""}
    ${blocked ? `<div class="notice notice-danger">Envio bloqueado: contato ${blocked}.</div>` : ""}
    <label class="msg-field">Assunto<input class="draft-subject" value="${escapeHtml(m.subject || "")}" maxlength="200" /></label>
    <label class="msg-field">Mensagem<textarea class="draft-body" rows="9">${escapeHtml(m.body)}</textarea></label>
    <div class="msg-actions">
      <button class="btn btn-ghost-danger btn-sm" data-act="discard"><i data-lucide="x"></i>Descartar</button>
      <button class="btn btn-primary btn-sm" data-act="send" ${blocked ? "disabled" : ""}><i data-lucide="send"></i>Aprovar e enviar</button>
    </div>
  </article>`;
}

async function load() {
  const { ok, data } = await api("GET", "/messages/pending");
  state.items = ok ? data.messages : [];
  if (!ok) toast(errorMessage(data), "error");
  draw();
}

function draw() {
  const list = state.container.querySelector("#approvals");
  list.innerHTML = state.items.length
    ? state.items.map(itemHtml).join("")
    : `<div class="panel empty-state"><i data-lucide="check-check"></i><h2>Nada aguardando aprovação</h2><p class="muted">Gere mensagens pela ficha de um card no Funil.</p></div>`;
  state.container.querySelector("#approvals-count").textContent = state.items.length;
  refreshIcons();
  list.querySelectorAll(".approval").forEach(bindItem);
}

function bindItem(el) {
  const id = el.dataset.id;
  const m = state.items.find((x) => x.id === id);
  const payload = () => ({ subject: el.querySelector(".draft-subject").value, body: el.querySelector(".draft-body").value });

  el.querySelector("[data-act=open]").addEventListener("click", () =>
    openDeal(m.dealId, { pipelines: state.pipelines, owners: state.owners, user: state.user, onMessagesChanged: load, onDelete: load })
  );
  el.querySelector("[data-act=discard]").addEventListener("click", async () => {
    if (!confirm("Descartar este rascunho?")) return;
    const r = await api("POST", `/messages/${id}/discard`, {});
    if (!r.ok) return toast(errorMessage(r.data), "error");
    load();
  });
  el.querySelector("[data-act=send]").addEventListener("click", async (e) => {
    if (!confirm(`Enviar para ${m.contact?.email}?`)) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Enviando...";
    const p = payload();
    if (p.subject !== (m.subject || "") || p.body !== m.body) {
      const s = await api("PATCH", `/messages/${id}`, p);
      if (!s.ok) {
        toast(errorMessage(s.data), "error");
        return load();
      }
    }
    const r = await api("POST", `/messages/${id}/send`, {});
    if (!r.ok) {
      toast(errorMessage(r.data), "error");
      return load();
    }
    toast(r.data.simulated ? `Envio simulado. Destino: ${r.data.deliveredTo}` : `Enviado para ${r.data.deliveredTo}.`, r.data.simulated ? "warning" : "success");
    load();
  });
}

export async function renderApprovals(container, { user }) {
  state = { container, user, items: [], pipelines: [], owners: [] };
  container.innerHTML = `
    <div class="page-head page-head-row">
      <div><h1>Aprovações <span class="badge" id="approvals-count">…</span></h1>
        <p class="muted">Mensagens escritas pelos agentes aguardando revisão. Edite à vontade antes de aprovar.</p></div>
      ${["admin", "gestor"].includes(user.role) ? `<span class="toolbar-actions"><button class="btn btn-secondary" id="run-cadences" title="Gera os passos de cadência que já venceram"><i data-lucide="repeat"></i>Processar cadências</button><button class="btn btn-secondary" id="poll-inbox"><i data-lucide="mail-search"></i>Ler caixa de entrada</button></span>` : ""}
    </div>
    ${["admin", "gestor"].includes(user.role) ? `<div id="automation"></div>` : ""}
    <div id="approvals"><p class="muted">Carregando...</p></div>`;
  refreshIcons();
  container.querySelector("#run-cadences")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Processando...";
    let total = { processed: 0, sent: 0, drafted: 0 };
    for (let i = 0; i < 10; i++) {
      const r = await api("POST", "/cadences/run", { limit: 5 });
      if (!r.ok) {
        toast(errorMessage(r.data), "error");
        break;
      }
      for (const k of Object.keys(total)) total[k] += r.data[k] || 0;
      if (!r.data.remainingDue || !r.data.processed) break;
    }
    toast(`Cadências: ${total.processed} passo(s) processado(s): ${total.drafted} rascunho(s), ${total.sent} enviado(s) automaticamente.`, "success");
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="repeat"></i>Processar cadências';
    refreshIcons();
    load();
  });
  container.querySelector("#poll-inbox")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const r = await api("POST", "/inbox/poll", {});
    btn.disabled = false;
    if (!r.ok) return toast(errorMessage(r.data), "error");
    toast(`Caixa lida: ${r.data.scanned} e-mail(s) dos últimos dias, ${r.data.matched} resposta(s) nova(s) de leads, ${r.data.drafted} rascunho(s) de resposta.`, "success");
    load();
    loadAutomation();
  });
  const [p, o] = await Promise.all([api("GET", "/pipelines"), api("GET", "/users/options")]);
  state.pipelines = p.ok ? p.data.pipelines : [];
  state.owners = o.ok ? o.data.users : [];
  await load();
  await loadAutomation();
}
