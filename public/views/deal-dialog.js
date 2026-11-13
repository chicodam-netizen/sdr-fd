// Ficha do card: dados do negócio, contato, empresa, anotações e histórico.
import { api, errorMessage, escapeHtml, formatDateTime, formatCnpj, refreshIcons, toast } from "../client.js";
import { openDialog, bindForm, options } from "../ui.js";
import { renderConversation, CATEGORY_LABELS } from "./conversation.js";

const ACTIVITY_LABEL = {
  created: () => "Card criado",
  import: (a) => `Importado de ${escapeHtml(a.meta.file || "CSV")}`,
  stage_change: (a) => `${a.meta.auto ? "Movido automaticamente" : "Movido"} de <strong>${escapeHtml(a.meta.from || "?")}</strong> para <strong>${escapeHtml(a.meta.to)}</strong>${a.meta.auto && a.meta.reason ? ` <span class="muted small">(${escapeHtml(a.meta.reason)})</span>` : ""}`,
  owner_change: () => "Responsável alterado",
  note: (a) => `<div class="note-body">${escapeHtml(a.body)}</div>`,
  message_draft: (a) => `Rascunho gerado pela IA (${escapeHtml(a.meta.agent || "agente")})`,
  message_sent: (a) => `E-mail ${a.meta.auto ? "enviado automaticamente pela cadência" : a.meta.simulated ? "aprovado (envio simulado)" : "enviado"}${a.meta.step ? ` (passo ${a.meta.step})` : ""}: <strong>${escapeHtml(a.meta.subject || "")}</strong>`,
  message_received: (a) => `Resposta recebida${a.meta.subject ? `: <strong>${escapeHtml(a.meta.subject)}</strong>` : ""}`,
  ai_classification: (a) => `IA classificou: <strong>${escapeHtml(CATEGORY_LABELS[a.meta.category] || a.meta.category)}</strong> — ${escapeHtml(a.meta.summary || "")}`,
  opt_out: () => "Contato marcado como <strong>não contatar</strong> (opt-out)",
  sourced: (a) => `Captado: ${escapeHtml(a.meta.detail || a.meta.source || "")}`,
  cadence_started: (a) => `Cadência iniciada (${a.meta.steps} passos)`,
};

const ACTIVITY_ICON = {
  created: "plus", import: "upload", stage_change: "arrow-right-left", owner_change: "user-cog", note: "sticky-note",
  message_draft: "sparkles", message_sent: "send", message_received: "mail-open", ai_classification: "brain", opt_out: "ban", sourced: "radar", cadence_started: "repeat",
};

function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function timelineHtml(activities) {
  if (!activities.length) return `<p class="muted">Sem atividades.</p>`;
  return `<ol class="timeline">${activities
    .map(
      (a) => `<li>
        <span class="timeline-icon"><i data-lucide="${ACTIVITY_ICON[a.type] || "dot"}"></i></span>
        <div>
          <div class="timeline-text">${(ACTIVITY_LABEL[a.type] || (() => escapeHtml(a.type)))(a)}</div>
          <div class="timeline-meta">${escapeHtml(a.userName || "Sistema")} · ${formatDateTime(a.createdAt)}</div>
        </div>
      </li>`
    )
    .join("")}</ol>`;
}

function bodyHtml(deal, activities, ctx) {
  const { pipeline, owners, user } = ctx;
  const c = deal.company;
  const ct = deal.contact;
  const canDelete = ["admin", "gestor"].includes(user.role);
  const stageOpts = options(pipeline.stages.map((s) => ({ value: s.id, label: escapeHtml(s.name) })), deal.stageId);
  const ownerOpts = options(owners.map((o) => ({ value: o.id, label: escapeHtml(o.name) })), deal.owner?.id || "", { empty: "Sem responsável" });

  return `
    <header class="drawer-head">
      <div>
        <h2>${escapeHtml(c.name)}</h2>
        <p class="muted">${[formatCnpj(c.cnpj), [c.city, c.uf].filter(Boolean).join("/"), c.segment].filter(Boolean).map(escapeHtml).join(" · ") || "&nbsp;"}</p>
      </div>
      <button class="icon-btn" data-close aria-label="Fechar"><i data-lucide="x"></i></button>
    </header>
    <div class="drawer-body">
      <label class="stage-picker">Etapa<select id="deal-stage">${stageOpts}</select></label>

      <section class="drawer-section">
        <h3>Conversa por e-mail</h3>
        <div id="conversation"><p class="muted small">Carregando...</p></div>
      </section>

      <section class="drawer-section">
        <h3>Negócio</h3>
        <form id="deal-form" class="form form-grid" novalidate>
          <label class="span-2">Título<input name="title" value="${escapeHtml(deal.title)}" required /></label>
          <label>Valor estimado (R$)<input name="value" inputmode="decimal" value="${deal.value ?? ""}" /></label>
          <label>Responsável<select name="ownerId">${ownerOpts}</select></label>
          <label class="span-2">Próxima ação<input type="datetime-local" name="nextActionAt" value="${toLocalInput(deal.nextActionAt)}" /></label>
          <p class="form-error span-2" hidden></p>
          <div class="span-2"><button type="submit" class="btn btn-secondary btn-sm">Salvar negócio</button></div>
        </form>
      </section>

      <section class="drawer-section">
        <h3>Contato</h3>
        ${
          ct
            ? `<dl class="details">
                <dt>Nome</dt><dd>${escapeHtml(ct.name)}${ct.optOut ? ` <span class="badge badge-danger">Não contatar</span>` : ""}</dd>
                <dt>Cargo</dt><dd>${escapeHtml(ct.jobTitle || "—")}</dd>
                <dt>E-mail</dt><dd>${ct.email ? `<a href="mailto:${escapeHtml(ct.email)}">${escapeHtml(ct.email)}</a>` : "—"}</dd>
                <dt>Telefone</dt><dd>${escapeHtml(ct.phone || "—")}</dd>
              </dl>`
            : `<p class="muted">Nenhum contato vinculado.</p>`
        }
        <a href="#/leads?empresa=${c.id}" class="link-small" data-close>Gerenciar empresa e contatos</a>
      </section>

      <section class="drawer-section">
        <h3>Empresa</h3>
        <dl class="details">
          <dt>Site</dt><dd>${c.website ? `<a href="${escapeHtml(/^https?:/.test(c.website) ? c.website : "https://" + c.website)}" target="_blank" rel="noopener">${escapeHtml(c.website)}</a>` : "—"}</dd>
          <dt>Telefone</dt><dd>${escapeHtml(c.phone || "—")}</dd>
          <dt>LinkedIn</dt><dd>${c.linkedinUrl ? `<a href="${escapeHtml(c.linkedinUrl)}" target="_blank" rel="noopener">abrir perfil</a>` : "—"}</dd>
          <dt>Origem</dt><dd>${escapeHtml(c.source === "csv" ? `Importação: ${c.sourceDetail}` : "Cadastro manual")}</dd>
        </dl>
      </section>

      <section class="drawer-section">
        <h3>Anotações e histórico</h3>
        <form id="note-form" class="form" novalidate>
          <textarea name="body" rows="3" placeholder="Registrar ligação, e-mail, combinado..."></textarea>
          <p class="form-error" hidden></p>
          <div><button type="submit" class="btn btn-secondary btn-sm"><i data-lucide="plus"></i>Adicionar anotação</button></div>
        </form>
        <div id="timeline">${timelineHtml(activities)}</div>
      </section>

      ${canDelete ? `<div class="drawer-danger"><button class="btn btn-ghost-danger btn-sm" id="deal-delete"><i data-lucide="trash-2"></i>Excluir card</button></div>` : ""}
    </div>`;
}

// ctx: { pipeline, owners, user, onChange(deal) , onDelete(id) }
export async function openDeal(dealId, ctx) {
  const dialog = openDialog(`<div class="drawer-loading muted">Carregando...</div>`, { variant: "drawer" });
  const { ok, data } = await api("GET", `/deals/${dealId}`);
  if (!ok) {
    dialog.close();
    toast(errorMessage(data), "error");
    return;
  }
  let { deal, activities } = data;
  // Na fila de aprovações o funil vem pela lista de funis.
  if (!ctx.pipeline && ctx.pipelines) ctx = { ...ctx, pipeline: ctx.pipelines.find((p) => p.id === deal.pipelineId) };
  const agentsRes = await api("GET", "/agents");
  const agents = agentsRes.ok ? agentsRes.data.agents : [];

  const reloadTimeline = async () => {
    const r = await api("GET", `/deals/${dealId}`);
    if (r.ok) {
      activities = r.data.activities;
      dialog.querySelector("#timeline").innerHTML = timelineHtml(activities);
      refreshIcons();
    }
  };

  dialog.innerHTML = bodyHtml(deal, activities, ctx);
  refreshIcons();
  dialog.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => dialog.close()));

  renderConversation(dialog.querySelector("#conversation"), {
    dealId,
    deal,
    agents,
    pipeline: ctx.pipeline,
    onDealChange: (d) => {
      deal = d;
      dialog.querySelector("#deal-stage").value = d.stageId;
      ctx.onChange?.(d);
      reloadTimeline();
    },
    onChanged: () => {
      reloadTimeline();
      ctx.onMessagesChanged?.();
    },
  });

  dialog.querySelector("#deal-stage").addEventListener("change", async (e) => {
    const r = await api("POST", `/deals/${dealId}/move`, { stageId: e.target.value });
    if (!r.ok) {
      toast(errorMessage(r.data), "error");
      e.target.value = deal.stageId;
      return;
    }
    deal = r.data.deal;
    ctx.onChange?.(deal);
    toast("Etapa atualizada.", "success");
    reloadTimeline();
  });

  bindForm(dialog.querySelector("#deal-form"), async (fd) => {
    const next = fd.get("nextActionAt");
    const r = await api("PATCH", `/deals/${dealId}`, {
      title: fd.get("title"),
      value: fd.get("value"),
      ownerId: fd.get("ownerId") || null,
      nextActionAt: next ? new Date(next).toISOString() : null,
    });
    if (!r.ok) return errorMessage(r.data);
    deal = r.data.deal;
    ctx.onChange?.(deal);
    toast("Negócio salvo.", "success");
    reloadTimeline();
    return null;
  });

  const noteForm = dialog.querySelector("#note-form");
  bindForm(noteForm, async (fd) => {
    const r = await api("POST", `/deals/${dealId}/notes`, { body: fd.get("body") });
    if (!r.ok) return errorMessage(r.data);
    noteForm.reset();
    reloadTimeline();
    return null;
  });

  dialog.querySelector("#deal-delete")?.addEventListener("click", async () => {
    if (!confirm(`Excluir o card "${deal.title}"? O histórico do card também será apagado. A empresa continua na base de leads.`)) return;
    const r = await api("DELETE", `/deals/${dealId}`, {});
    if (!r.ok) return toast(errorMessage(r.data), "error");
    toast("Card excluído.", "success");
    ctx.onDelete?.(dealId);
    dialog.close();
  });
}
