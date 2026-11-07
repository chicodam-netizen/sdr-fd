// Conversa por e-mail do card: agente, rascunho com IA, aprovação/envio, respostas e classificação.
import { api, errorMessage, escapeHtml, formatDateTime, refreshIcons, toast } from "../client.js";
import { options } from "../ui.js";

export const CATEGORY_LABELS = {
  interested: "Interessado",
  meeting_request: "Quer reunião",
  question: "Pergunta",
  objection: "Objeção",
  not_now: "Agora não",
  not_interested: "Sem interesse",
  unsubscribe: "Pediu para sair",
  out_of_office: "Ausência / férias",
  wrong_person: "Pessoa errada",
  other: "Outro",
};
const KIND_LABELS = { first: "Primeiro contato", followup: "Follow-up", reply: "Resposta" };
const STAGE_KIND_LABELS = { qualified: "Qualificado", disqualified: "Desqualificado", open: "Em andamento" };

function draftHtml(m) {
  return `<div class="msg msg-draft" data-id="${m.id}">
    <div class="msg-head"><span class="badge badge-warning">Rascunho · ${KIND_LABELS[m.ai?.kind] || "IA"}</span>
      <span class="muted small">${escapeHtml(m.agentName || "")} · ${formatDateTime(m.createdAt)}${m.ai?.edited ? " · editado" : ""}</span></div>
    ${m.ai?.rationale ? `<p class="msg-rationale"><i data-lucide="sparkles"></i>${escapeHtml(m.ai.rationale)}</p>` : ""}
    <label class="msg-field">Assunto<input class="draft-subject" value="${escapeHtml(m.subject || "")}" maxlength="200" /></label>
    <label class="msg-field">Mensagem<textarea class="draft-body" rows="10">${escapeHtml(m.body)}</textarea></label>
    <p class="hint">Rodapé automático: “Se preferir não receber novos contatos, basta responder esta mensagem com SAIR.”</p>
    <div class="msg-actions">
      <button class="btn btn-ghost-danger btn-sm" data-act="discard"><i data-lucide="x"></i>Descartar</button>
      <button class="btn btn-secondary btn-sm" data-act="save"><i data-lucide="save"></i>Salvar edição</button>
      <button class="btn btn-primary btn-sm" data-act="send"><i data-lucide="send"></i>Aprovar e enviar</button>
    </div>
  </div>`;
}

function sentHtml(m) {
  const status =
    m.status === "failed"
      ? `<span class="badge badge-danger">Falhou</span>`
      : m.ai?.simulated
        ? `<span class="badge badge-muted" title="MAIL_ENABLED=false: não saiu de fato">Envio simulado</span>`
        : `<span class="badge badge-success">Enviado</span>`;
  const redirected = m.deliveredTo && m.deliveredTo !== m.toEmail ? ` <span class="muted small">(desviado para ${escapeHtml(m.deliveredTo)})</span>` : "";
  return `<div class="msg msg-out">
    <div class="msg-head">${status}<span class="muted small">para ${escapeHtml(m.toEmail || "—")}${redirected} · ${formatDateTime(m.sentAt || m.createdAt)}${m.approvedByName ? ` · aprovado por ${escapeHtml(m.approvedByName)}` : ""}</span></div>
    <div class="msg-subject">${escapeHtml(m.subject || "")}</div>
    <div class="msg-body">${escapeHtml(m.body)}</div>
  </div>`;
}

function receivedHtml(m, pipeline) {
  const c = m.ai?.classification;
  const targetStage = c && ["qualified", "disqualified"].includes(c.suggested_stage_kind) ? pipeline?.stages.find((s) => s.kind === c.suggested_stage_kind) : null;
  return `<div class="msg msg-in">
    <div class="msg-head"><span class="badge">Resposta recebida</span><span class="muted small">${escapeHtml(m.fromEmail || "")} · ${formatDateTime(m.sentAt || m.createdAt)}</span></div>
    ${m.subject ? `<div class="msg-subject">${escapeHtml(m.subject)}</div>` : ""}
    <div class="msg-body">${escapeHtml(m.body)}</div>
    ${
      c
        ? `<div class="msg-ai">
            <div class="msg-ai-head"><i data-lucide="sparkles"></i><strong>${CATEGORY_LABELS[c.category] || c.category}</strong>
              ${c.suggested_stage_kind && c.suggested_stage_kind !== "none" ? `<span class="muted small">· sugestão: ${STAGE_KIND_LABELS[c.suggested_stage_kind]}</span>` : ""}</div>
            <p>${escapeHtml(c.summary)}</p>
            ${c.qualification_notes ? `<p class="small"><strong>Qualificação:</strong> ${escapeHtml(c.qualification_notes)}</p>` : ""}
            ${c.next_step ? `<p class="small"><strong>Próximo passo:</strong> ${escapeHtml(c.next_step)}</p>` : ""}
            ${targetStage ? `<button class="btn btn-secondary btn-sm" data-move="${targetStage.id}"><i data-lucide="arrow-right"></i>Mover para “${escapeHtml(targetStage.name)}”</button>` : ""}
          </div>`
        : ""
    }
  </div>`;
}

// opts: { dealId, deal, agents, pipeline, onDealChange(deal), onChanged() }
export async function renderConversation(container, opts) {
  let deal = opts.deal;
  const activeAgents = opts.agents.filter((a) => a.active || a.id === deal.agent?.id);

  const draw = async () => {
    const { ok, data } = await api("GET", `/deals/${opts.dealId}/messages`);
    const messages = ok ? data.messages : [];
    const hasDraft = messages.some((m) => m.status === "draft");
    const optOut = deal.contact?.optOut;

    container.innerHTML = `
      ${optOut ? `<div class="notice notice-danger"><i data-lucide="ban"></i>Contato pediu para não ser contatado. Novas mensagens estão bloqueadas.</div>` : ""}
      ${!deal.contact?.email ? `<div class="notice notice-warning">Contato sem e-mail: é possível gerar rascunho, mas não enviar.</div>` : ""}
      <div class="conv-toolbar">
        <label class="grow">Agente SDR
          <select id="conv-agent">${options(activeAgents.map((a) => ({ value: a.id, label: escapeHtml(a.name) })), deal.agent?.id || "", { empty: activeAgents.length ? "Escolha o agente" : "Nenhum agente cadastrado" })}</select>
        </label>
      </div>
      <details class="conv-instruction"${hasDraft || optOut ? "" : " open"}>
        <summary>Gerar mensagem com IA</summary>
        <textarea id="conv-instruction" rows="2" placeholder="Orientação opcional para este e-mail (ex.: citar o evento X, foco em LGPD, tom mais curto)"></textarea>
        <button class="btn btn-primary btn-sm" id="conv-generate" ${optOut ? "disabled" : ""}><i data-lucide="sparkles"></i>Gerar rascunho</button>
      </details>
      <div class="conv-thread">${
        messages.length
          ? messages.map((m) => (m.status === "draft" ? draftHtml(m) : m.direction === "in" ? receivedHtml(m, opts.pipeline) : sentHtml(m))).join("")
          : `<p class="muted small">Nenhuma mensagem ainda.</p>`
      }</div>
      <details class="conv-inbound">
        <summary>Registrar resposta recebida</summary>
        <p class="hint">Cole a resposta do lead (enquanto a leitura automática da caixa não estiver ligada). A IA classifica e sugere o próximo passo.</p>
        <input id="in-subject" placeholder="Assunto (opcional)" />
        <textarea id="in-body" rows="4" placeholder="Texto da resposta"></textarea>
        <button class="btn btn-secondary btn-sm" id="in-save"><i data-lucide="mail-plus"></i>Registrar e classificar</button>
      </details>`;
    refreshIcons();
    bind(messages);
  };

  const busy = (btn, label) => {
    btn.disabled = true;
    btn.dataset.label = btn.innerHTML;
    btn.textContent = label;
  };
  const idle = (btn) => {
    btn.disabled = false;
    if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
    refreshIcons();
  };

  const bind = (messages) => {
    container.querySelector("#conv-agent").addEventListener("change", async (e) => {
      const r = await api("PATCH", `/deals/${opts.dealId}`, { agentId: e.target.value || null });
      if (!r.ok) return toast(errorMessage(r.data), "error");
      deal = r.data.deal;
      opts.onDealChange?.(deal);
      toast("Agente do card atualizado.", "success");
    });

    container.querySelector("#conv-generate").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      busy(btn, "Gerando com IA... (até ~20s)");
      const r = await api("POST", `/deals/${opts.dealId}/messages/draft`, {
        agentId: container.querySelector("#conv-agent").value || undefined,
        instruction: container.querySelector("#conv-instruction").value,
      });
      idle(btn);
      if (!r.ok) return toast(errorMessage(r.data), "error");
      toast("Rascunho gerado. Revise antes de enviar.", "success");
      if (!deal.agent) {
        deal = { ...deal, agent: { id: r.data.message.agentId, name: r.data.message.agentName } };
      }
      opts.onChanged?.();
      draw();
    });

    container.querySelectorAll(".msg-draft").forEach((el) => {
      const id = el.dataset.id;
      const payload = () => ({ subject: el.querySelector(".draft-subject").value, body: el.querySelector(".draft-body").value });
      const original = messages.find((m) => m.id === id);
      const changed = () => payload().subject !== (original.subject || "") || payload().body !== original.body;

      el.querySelector("[data-act=save]").addEventListener("click", async () => {
        const r = await api("PATCH", `/messages/${id}`, payload());
        if (!r.ok) return toast(errorMessage(r.data), "error");
        toast("Edição salva.", "success");
        draw();
      });
      el.querySelector("[data-act=discard]").addEventListener("click", async () => {
        if (!confirm("Descartar este rascunho?")) return;
        const r = await api("POST", `/messages/${id}/discard`, {});
        if (!r.ok) return toast(errorMessage(r.data), "error");
        opts.onChanged?.();
        draw();
      });
      el.querySelector("[data-act=send]").addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        if (!confirm(`Enviar este e-mail para ${deal.contact?.email || "o contato"}?`)) return;
        busy(btn, "Enviando...");
        if (changed()) {
          const s = await api("PATCH", `/messages/${id}`, payload());
          if (!s.ok) {
            idle(btn);
            return toast(errorMessage(s.data), "error");
          }
        }
        const r = await api("POST", `/messages/${id}/send`, {});
        idle(btn);
        if (!r.ok) return toast(errorMessage(r.data), "error");
        if (r.data.simulated) toast(`Envio simulado (e-mail desligado neste ambiente). Destino: ${r.data.deliveredTo}`, "warning");
        else toast(`E-mail enviado para ${r.data.deliveredTo}.`, "success");
        opts.onChanged?.();
        draw();
      });
    });

    container.querySelectorAll("[data-move]").forEach((b) =>
      b.addEventListener("click", async () => {
        const r = await api("POST", `/deals/${opts.dealId}/move`, { stageId: b.dataset.move });
        if (!r.ok) return toast(errorMessage(r.data), "error");
        deal = r.data.deal;
        opts.onDealChange?.(deal);
        toast("Card movido.", "success");
      })
    );

    container.querySelector("#in-save").addEventListener("click", async (e) => {
      const body = container.querySelector("#in-body").value;
      if (!body.trim()) return toast("Cole o texto da resposta.", "error");
      const btn = e.currentTarget;
      busy(btn, "Classificando com IA...");
      const r = await api("POST", `/deals/${opts.dealId}/messages/inbound`, { subject: container.querySelector("#in-subject").value, body });
      idle(btn);
      if (!r.ok) return toast(errorMessage(r.data), "error");
      const c = r.data.classification;
      toast(c ? `Resposta registrada: ${CATEGORY_LABELS[c.category] || c.category}.` : "Resposta registrada (sem agente para classificar).", "success");
      if (c?.category === "unsubscribe") deal = { ...deal, contact: { ...deal.contact, optOut: true } };
      opts.onChanged?.();
      draw();
    });
  };

  await draw();
}
