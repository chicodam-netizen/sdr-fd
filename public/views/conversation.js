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
const KIND_LABELS = {
  first: "Primeiro contato", followup: "Follow-up", reply: "Resposta",
  linkedin_connect: "LinkedIn · pedido de conexão", linkedin_message: "LinkedIn · mensagem", linkedin_reply: "LinkedIn · resposta",
};
const LI_BADGE = `<span class="badge channel-li">LinkedIn</span>`;

// Tarefa de LinkedIn no card: o texto é enviado por uma pessoa no LinkedIn; aqui só copia e marca como feito.
function linkedinDraftHtml(m) {
  return `<div class="msg msg-draft msg-draft-li" data-id="${m.id}">
    <div class="msg-head"><span class="badge badge-warning">Tarefa · ${KIND_LABELS[m.ai?.kind] || "LinkedIn"}${m.step ? ` · passo ${m.step} da cadência` : ""}</span>
      <span class="muted small">${escapeHtml(m.agentName || "")} · ${formatDateTime(m.createdAt)}</span></div>
    ${m.ai?.rationale ? `<p class="msg-rationale"><i data-lucide="sparkles"></i>${escapeHtml(m.ai.rationale)}</p>` : ""}
    <label class="msg-field">Texto para o LinkedIn<textarea class="draft-body" rows="5">${escapeHtml(m.body)}</textarea></label>
    <p class="hint">Envie pelo LinkedIn e marque como feito. A lista completa do dia está em <a href="#/linkedin">LinkedIn</a>.</p>
    <div class="msg-actions">
      ${m.step ? `<button class="btn btn-ghost-danger btn-sm" data-li="skip"><i data-lucide="skip-forward"></i>Pular</button>` : `<button class="btn btn-ghost-danger btn-sm" data-li="discard"><i data-lucide="x"></i>Descartar</button>`}
      <button class="btn btn-secondary btn-sm" data-li="copy"><i data-lucide="copy"></i>Copiar texto</button>
      <button class="btn btn-primary btn-sm" data-li="done"><i data-lucide="check"></i>Feito: enviei no LinkedIn</button>
    </div>
  </div>`;
}
const ENROLL_STATUS = {
  active: "Em andamento",
  waiting_approval: "Aguardando aprovação do rascunho",
  paused: "Pausada",
  replied: "Encerrada: o lead respondeu",
  finished: "Concluída",
  stopped: "Interrompida",
};
const STOP_REASON = {
  sequence_completed: "todos os passos enviados",
  qualified: "card qualificado",
  disqualified: "card desqualificado",
  opt_out: "contato pediu para sair",
  contact_without_email: "contato sem e-mail",
  draft_discarded: "rascunho descartado",
  paused_by_user: "pausada manualmente",
  stopped_by_user: "encerrada manualmente",
  agent_inactive: "agente inativo",
  daily_limit_reached: "limite diário do agente atingido",
  lead_replied: "o lead respondeu",
};

function cadenceHtml(e) {
  if (!e || ["replied", "finished", "stopped"].includes(e.status)) {
    const last = e ? `<span class="muted small">Última: ${ENROLL_STATUS[e.status]}${e.stopReason && e.status !== "replied" ? ` (${STOP_REASON[e.stopReason] || e.stopReason})` : ""}.</span>` : "";
    return `<div class="cadence-box"><div><strong>Cadência</strong> <span class="muted small">não iniciada</span> ${last}</div>
      <button class="btn btn-secondary btn-sm" data-cad="enroll"><i data-lucide="play"></i>Iniciar cadência</button></div>`;
  }
  const next = e.status === "active" && e.nextRunAt ? ` · próximo passo ${formatDateTime(e.nextRunAt)}` : "";
  return `<div class="cadence-box cadence-on">
    <div><strong>Cadência</strong> · passo ${e.currentStep} de ${e.totalSteps} · ${ENROLL_STATUS[e.status]}${next}
      ${e.stopReason && e.status === "paused" ? `<div class="muted small">${STOP_REASON[e.stopReason] || e.stopReason}</div>` : ""}</div>
    <span class="toolbar-actions">
      ${e.status === "paused" ? `<button class="btn btn-secondary btn-sm" data-cad="resume"><i data-lucide="play"></i>Retomar</button>` : `<button class="btn btn-secondary btn-sm" data-cad="pause"><i data-lucide="pause"></i>Pausar</button>`}
      <button class="btn btn-ghost-danger btn-sm" data-cad="stop"><i data-lucide="square"></i>Encerrar</button>
    </span></div>`;
}
const STAGE_KIND_LABELS = { qualified: "Qualificado", disqualified: "Desqualificado", open: "Em andamento" };

function draftHtml(m) {
  return `<div class="msg msg-draft" data-id="${m.id}">
    <div class="msg-head"><span class="badge badge-warning">Rascunho · ${KIND_LABELS[m.ai?.kind] || "IA"}${m.step ? ` · passo ${m.step} da cadência` : ""}</span>
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
  if (m.channel === "linkedin") {
    return `<div class="msg msg-out">
      <div class="msg-head">${LI_BADGE}<span class="badge badge-success">Enviado por você</span><span class="muted small">${KIND_LABELS[m.ai?.kind] || ""} · ${formatDateTime(m.sentAt || m.createdAt)}${m.approvedByName ? ` · ${escapeHtml(m.approvedByName)}` : ""}</span></div>
      <div class="msg-body">${escapeHtml(m.body)}</div>
    </div>`;
  }
  const status =
    m.status === "failed"
      ? `<span class="badge badge-danger">Falhou</span>`
      : m.ai?.simulated
        ? `<span class="badge badge-muted" title="MAIL_ENABLED=false: não saiu de fato">Envio simulado</span>`
        : `<span class="badge badge-success">Enviado${m.ai?.autoSent ? " automaticamente" : ""}</span>`;
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
    <div class="msg-head">${m.channel === "linkedin" ? LI_BADGE : ""}<span class="badge">Resposta recebida</span><span class="muted small">${escapeHtml(m.fromEmail || "")} · ${formatDateTime(m.sentAt || m.createdAt)}</span></div>
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
    const [{ ok, data }, enr] = await Promise.all([api("GET", `/deals/${opts.dealId}/messages`), api("GET", `/deals/${opts.dealId}/enrollment`)]);
    const messages = ok ? data.messages : [];
    const enrollment = enr.ok ? enr.data.enrollment : null;
    const hasDraft = messages.some((m) => m.status === "draft");
    const optOut = deal.contact?.optOut;

    container.innerHTML = `
      ${optOut ? `<div class="notice notice-danger"><i data-lucide="ban"></i>Contato pediu para não ser contatado. Novas mensagens estão bloqueadas.</div>` : ""}
      ${!deal.contact?.email ? `<div class="notice notice-warning">Contato sem e-mail: é possível gerar rascunho, mas não enviar.</div>` : ""}
      ${cadenceHtml(enrollment)}
      <div class="conv-toolbar">
        <label class="grow">Agente SDR
          <select id="conv-agent">${options(activeAgents.map((a) => ({ value: a.id, label: escapeHtml(a.name) })), deal.agent?.id || "", { empty: activeAgents.length ? "Escolha o agente" : "Nenhum agente cadastrado" })}</select>
        </label>
      </div>
      <details class="conv-instruction"${hasDraft || optOut ? "" : " open"}>
        <summary>Gerar mensagem com IA</summary>
        <select id="conv-channel" class="select-sm"><option value="email">E-mail</option><option value="linkedin_connect">LinkedIn: pedido de conexão</option><option value="linkedin_message">LinkedIn: mensagem</option></select>
        <textarea id="conv-instruction" rows="2" placeholder="Orientação opcional para esta mensagem (ex.: citar o evento X, foco em ISO 9001, tom mais curto)"></textarea>
        <button class="btn btn-primary btn-sm" id="conv-generate" ${optOut ? "disabled" : ""}><i data-lucide="sparkles"></i>Gerar rascunho</button>
      </details>
      <div class="conv-thread">${
        messages.length
          ? messages.map((m) => (m.status === "draft" ? (m.channel === "linkedin" ? linkedinDraftHtml(m) : draftHtml(m)) : m.direction === "in" ? receivedHtml(m, opts.pipeline) : sentHtml(m))).join("")
          : `<p class="muted small">Nenhuma mensagem ainda.</p>`
      }</div>
      <details class="conv-inbound">
        <summary>Registrar resposta recebida</summary>
        <p class="hint">Respostas por e-mail entram sozinhas pela leitura da caixa. Use aqui para respostas recebidas no LinkedIn (ou um e-mail que não entrou). A IA classifica e prepara a resposta.</p>
        <select id="in-channel" class="select-sm"><option value="linkedin">Recebida no LinkedIn</option><option value="email">Recebida por e-mail</option></select>
        <input id="in-subject" placeholder="Assunto (opcional)" />
        <textarea id="in-body" rows="4" placeholder="Texto da resposta"></textarea>
        <button class="btn btn-secondary btn-sm" id="in-save"><i data-lucide="mail-plus"></i>Registrar e classificar</button>
      </details>`;
    refreshIcons();
    bind(messages, enrollment);
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

  const bind = (messages, enrollment) => {
    container.querySelectorAll("[data-cad]").forEach((b) =>
      b.addEventListener("click", async () => {
        const act = b.dataset.cad;
        if (act === "stop" && !confirm("Encerrar a cadência deste card? Rascunhos pendentes dela serão descartados.")) return;
        const r = act === "enroll"
          ? await api("POST", `/deals/${opts.dealId}/enroll`, { agentId: container.querySelector("#conv-agent").value || undefined })
          : await api("POST", `/enrollments/${enrollment.id}/${act}`, {});
        if (!r.ok) return toast(errorMessage(r.data), "error");
        toast({ enroll: "Cadência iniciada.", pause: "Cadência pausada.", resume: "Cadência retomada.", stop: "Cadência encerrada." }[act], "success");
        opts.onChanged?.();
        draw();
      })
    );
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
        channel: container.querySelector("#conv-channel").value,
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

    container.querySelectorAll(".msg-draft-li").forEach((el) => {
      const id = el.dataset.id;
      const text = () => el.querySelector(".draft-body").value;
      el.querySelector("[data-li=copy]").addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(text());
          toast("Texto copiado. Cole no LinkedIn.", "success");
        } catch {
          toast("Selecione e copie o texto (Ctrl+C).", "warning");
        }
      });
      el.querySelector("[data-li=done]").addEventListener("click", async () => {
        const r = await api("POST", `/messages/${id}/linkedin-done`, { body: text() });
        if (!r.ok) return toast(errorMessage(r.data), "error");
        toast("Registrado como enviado pelo LinkedIn.", "success");
        opts.onChanged?.();
        draw();
      });
      el.querySelector("[data-li=skip]")?.addEventListener("click", async () => {
        const reason = prompt("Pular esta tarefa? A cadência segue para o próximo passo.\nMotivo (opcional):", "");
        if (reason === null) return;
        const r = await api("POST", `/messages/${id}/linkedin-skip`, { reason });
        if (!r.ok) return toast(errorMessage(r.data), "error");
        opts.onChanged?.();
        draw();
      });
      el.querySelector("[data-li=discard]")?.addEventListener("click", async () => {
        if (!confirm("Descartar esta tarefa?")) return;
        const r = await api("POST", `/messages/${id}/discard`, {});
        if (!r.ok) return toast(errorMessage(r.data), "error");
        opts.onChanged?.();
        draw();
      });
    });

    container.querySelectorAll(".msg-draft:not(.msg-draft-li)").forEach((el) => {
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
      const r = await api("POST", `/deals/${opts.dealId}/messages/inbound`, { subject: container.querySelector("#in-subject").value, body, channel: container.querySelector("#in-channel").value });
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
