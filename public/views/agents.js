// Agentes SDR: lista e edição (persona, premissas, qualificação, limites) + base de conhecimento.
import { api, errorMessage, escapeHtml, formatDate, refreshIcons, toast } from "../client.js";
import { openDialog, bindForm } from "../ui.js";
import { navigate } from "../app.js";

const isManager = (user) => ["admin", "gestor"].includes(user.role);

export async function renderAgents(container, { user }) {
  container.innerHTML = `<p class="muted">Carregando...</p>`;
  const { ok, data } = await api("GET", "/agents");
  if (!ok) {
    container.innerHTML = `<p class="form-error">${escapeHtml(errorMessage(data))}</p>`;
    return;
  }
  const agents = data.agents;
  container.innerHTML = `
    <div class="page-head page-head-row">
      <div><h1>Agentes SDR</h1><p class="muted">Cada agente escreve em nome de um remetente, seguindo persona, premissas e base de conhecimento. Toda mensagem passa por aprovação humana.</p></div>
      ${isManager(user) ? `<a class="btn btn-primary" href="#/agentes/editar"><i data-lucide="bot"></i>Novo agente</a>` : ""}
    </div>
    ${
      agents.length
        ? `<div class="agent-grid">${agents
            .map(
              (a) => `<a class="agent-card${a.active ? "" : " inactive"}" href="#/agentes/editar?id=${a.id}">
                <div class="agent-card-head">
                  <span class="avatar">${escapeHtml(a.name.charAt(0).toUpperCase())}</span>
                  <div><strong>${escapeHtml(a.name)}</strong><div class="muted small">${escapeHtml(a.senderName)}${a.senderTitle ? ` · ${escapeHtml(a.senderTitle)}` : ""}</div></div>
                  ${a.active ? `<span class="badge badge-success">Ativo</span>` : `<span class="badge badge-muted">Inativo</span>`}
                </div>
                <p class="muted small agent-card-goal">${escapeHtml(a.objective || "Sem objetivo definido.")}</p>
                <div class="agent-card-stats">
                  <span><strong>${a.deals}</strong> cards</span>
                  <span><strong>${a.pending}</strong> aguardando aprovação</span>
                  <span><strong>${a.sentToday}/${a.dailyLimit}</strong> envios hoje</span>
                </div>
              </a>`
            )
            .join("")}</div>`
        : `<div class="panel empty-state"><i data-lucide="bot"></i><h2>Nenhum agente ainda</h2>
            <p class="muted">${isManager(user) ? "Crie o primeiro agente SDR para gerar mensagens com IA." : "Peça a um gestor para criar o primeiro agente."}</p></div>`
    }`;
  refreshIcons();
}

function field(label, name, value, { textarea, rows = 4, hint, required, maxlength, disabled } = {}) {
  const attrs = `name="${name}"${required ? " required" : ""}${maxlength ? ` maxlength="${maxlength}"` : ""}${disabled ? " disabled" : ""}`;
  const input = textarea
    ? `<textarea ${attrs} rows="${rows}">${escapeHtml(value || "")}</textarea>`
    : `<input ${attrs} value="${escapeHtml(value ?? "")}" />`;
  return `<label class="${textarea ? "span-2" : ""}">${label}${input}${hint ? `<span class="hint">${hint}</span>` : ""}</label>`;
}

function knowledgeHtml(items, agentId, canEdit) {
  const shared = items.filter((k) => !k.agentId);
  const own = items.filter((k) => k.agentId);
  const block = (title, list, scope) => `
    <h3 class="form-section">${title}</h3>
    ${
      list.length
        ? `<ul class="kb-list">${list
            .map(
              (k) => `<li data-id="${k.id}">
                <div><strong>${escapeHtml(k.title)}</strong><div class="muted small">${k.content.length.toLocaleString("pt-BR")} caracteres · atualizado ${formatDate(k.updatedAt)}</div></div>
                ${canEdit ? `<button class="icon-btn kb-edit" title="Editar"><i data-lucide="pencil"></i></button><button class="icon-btn kb-delete" title="Excluir"><i data-lucide="trash-2"></i></button>` : `<button class="icon-btn kb-edit" title="Ver"><i data-lucide="eye"></i></button>`}
              </li>`
            )
            .join("")}</ul>`
        : `<p class="muted small">Nenhum documento.</p>`
    }
    ${canEdit && (scope === "shared" || agentId) ? `<button class="btn btn-secondary btn-sm kb-add" data-scope="${scope}"><i data-lucide="plus"></i>Adicionar documento</button>` : ""}`;
  return `${block("Do agente", own, "agent")}${block("Compartilhada (todos os agentes)", shared, "shared")}`;
}

function openKnowledgeEditor(item, { agentId, scope, readOnly, onSaved }) {
  const dialog = openDialog(`
    <form class="form" novalidate>
      <h2>${readOnly ? "Documento" : item ? "Editar documento" : "Novo documento"}</h2>
      <p class="hint">${scope === "shared" || (item && !item.agentId) ? "Compartilhado: todos os agentes usam." : "Usado só por este agente."} Cole textos de apresentação, serviços, cases autorizados, perguntas frequentes, respostas a objeções. Também é possível carregar um arquivo .txt ou .md.</p>
      <label>Título<input name="title" maxlength="150" value="${escapeHtml(item?.title || "")}" ${readOnly ? "disabled" : "required"} /></label>
      <label>Conteúdo<textarea name="content" rows="14" ${readOnly ? "disabled" : ""}>${escapeHtml(item?.content || "")}</textarea></label>
      ${readOnly ? "" : `<label class="file-inline"><i data-lucide="file-text"></i> Carregar de arquivo (.txt, .md)<input type="file" accept=".txt,.md,text/plain,text/markdown" hidden /></label>`}
      <p class="form-error" hidden></p>
      <div class="dialog-actions">
        <button type="button" class="btn btn-secondary" data-close>${readOnly ? "Fechar" : "Cancelar"}</button>
        ${readOnly ? "" : `<button type="submit" class="btn btn-primary">Salvar</button>`}
      </div>
    </form>`);
  dialog.classList.add("dialog-wide");
  if (readOnly) return;
  dialog.querySelector("input[type=file]").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    dialog.querySelector("[name=content]").value = text;
    const title = dialog.querySelector("[name=title]");
    if (!title.value) title.value = file.name.replace(/\.(txt|md)$/i, "");
  });
  bindForm(dialog.querySelector("form"), async (fd) => {
    const payload = { title: fd.get("title"), content: fd.get("content") };
    const r = item
      ? await api("PATCH", `/knowledge/${item.id}`, payload)
      : await api("POST", "/knowledge", { ...payload, agentId: scope === "agent" ? agentId : null });
    if (!r.ok) return errorMessage(r.data);
    toast("Documento salvo.", "success");
    dialog.close();
    onSaved();
    return null;
  });
}

// Editor dos passos da cadência do agente (salva a lista inteira).
async function renderCadenceEditor(box, agentId, canEdit) {
  const r = await api("GET", `/agents/${agentId}/cadence`);
  let steps = r.ok ? r.data.steps : [];
  const draw = () => {
    box.innerHTML = `
      <ol class="cadence-steps">${steps
        .map(
          (s, i) => `<li data-i="${i}">
            <div class="cadence-step-head"><strong>Passo ${i + 1}</strong>
              <label class="inline-num">${i === 0 ? "após a inscrição, em" : "dias depois:"} <input type="number" min="0" max="90" class="step-delay" value="${s.delayDays}" ${canEdit ? "" : "disabled"} /> ${i === 0 ? "dias" : ""}</label>
              ${canEdit && steps.length > 1 ? `<button class="icon-btn step-remove" title="Remover passo"><i data-lucide="trash-2"></i></button>` : ""}</div>
            <textarea class="step-instruction" rows="2" placeholder="Orientação para a IA neste passo" ${canEdit ? "" : "disabled"}>${escapeHtml(s.instruction || "")}</textarea>
          </li>`
        )
        .join("")}</ol>
      ${canEdit ? `<div class="form-actions-inline"><button class="btn btn-secondary btn-sm" id="step-add" ${steps.length >= 10 ? "disabled" : ""}><i data-lucide="plus"></i>Adicionar passo</button>
        <button class="btn btn-primary btn-sm" id="steps-save">Salvar cadência</button></div>` : ""}`;
    refreshIcons();
    const read = () =>
      [...box.querySelectorAll(".cadence-steps li")].map((li) => ({
        delayDays: Number(li.querySelector(".step-delay").value),
        instruction: li.querySelector(".step-instruction").value,
      }));
    box.querySelectorAll(".step-remove").forEach((b) =>
      b.addEventListener("click", () => {
        steps = read();
        steps.splice(Number(b.closest("li").dataset.i), 1);
        draw();
      })
    );
    box.querySelector("#step-add")?.addEventListener("click", () => {
      steps = [...read(), { delayDays: 3, instruction: "" }];
      draw();
    });
    box.querySelector("#steps-save")?.addEventListener("click", async () => {
      const res = await api("PUT", `/agents/${agentId}/cadence`, { steps: read() });
      if (!res.ok) return toast(errorMessage(res.data), "error");
      steps = read();
      toast("Cadência salva.", "success");
    });
  };
  draw();
}

export async function renderAgentEdit(container, { user, query }) {
  const id = query.get("id");
  const canEdit = isManager(user);
  let agent = null;
  let knowledge = [];
  if (id) {
    const { ok, data } = await api("GET", `/agents/${id}`);
    if (!ok) {
      container.innerHTML = `<p class="form-error">${escapeHtml(errorMessage(data))}</p>`;
      return;
    }
    agent = data.agent;
    knowledge = data.knowledge;
  } else {
    if (!canEdit) return navigate("/agentes");
    const r = await api("GET", "/knowledge");
    knowledge = r.ok ? r.data.knowledge : [];
  }
  const a = agent || { active: true, dailyLimit: 30, autonomy: "draft" };
  const dis = !canEdit;

  container.innerHTML = `
    <div class="page-head">
      <a href="#/agentes" class="link-small back-link"><i data-lucide="arrow-left"></i>Agentes</a>
      <h1>${agent ? escapeHtml(agent.name) : "Novo agente SDR"}</h1>
    </div>
    <div class="grid-config">
      <form id="agent-form" class="panel form form-grid" novalidate>
        <h3 class="span-2 form-section">Identificação</h3>
        ${field("Nome do agente *", "name", a.name, { required: true, maxlength: 80, hint: "Uso interno, ex.: “SDR Indústria MG”.", disabled: dis })}
        <label>Situação<select name="active" ${dis ? "disabled" : ""}><option value="true"${a.active ? " selected" : ""}>Ativo</option><option value="false"${a.active ? "" : " selected"}>Inativo</option></select></label>
        ${field("Nome do remetente *", "senderName", a.senderName, { required: true, maxlength: 80, hint: "Como assina os e-mails.", disabled: dis })}
        ${field("Cargo do remetente", "senderTitle", a.senderTitle, { maxlength: 120, disabled: dis })}

        <h3 class="span-2 form-section">Comportamento</h3>
        ${field("Persona", "persona", a.persona, { textarea: true, rows: 3, hint: "Quem é, como se comporta, nível de formalidade.", disabled: dis })}
        ${field("Objetivo", "objective", a.objective, { textarea: true, rows: 2, hint: "O que o agente quer obter (ex.: agendar diagnóstico de 30 min).", disabled: dis })}
        ${field("Tom de voz", "tone", a.tone, { textarea: true, rows: 2, disabled: dis })}
        ${field("Premissas e regras", "rules", a.rules, { textarea: true, rows: 5, hint: "Como abordar, o que priorizar, como tratar objeções. Uma regra por linha.", disabled: dis })}
        ${field("Critérios de qualificação", "qualificationCriteria", a.qualificationCriteria, { textarea: true, rows: 4, hint: "Quando o lead é considerado qualificado (ex.: BANT: orçamento, autoridade, necessidade, prazo).", disabled: dis })}
        ${field("Proibido", "forbidden", a.forbidden, { textarea: true, rows: 3, hint: "Assuntos, promessas ou termos que nunca devem aparecer.", disabled: dis })}
        ${field("Assinatura", "signature", a.signature, { textarea: true, rows: 3, hint: "Se vazio, usa nome + cargo + empresa.", disabled: dis })}

        <h3 class="span-2 form-section">Envio</h3>
        <label>Modo de autonomia
          <select name="autonomy" ${dis ? "disabled" : ""}>
            <option value="draft"${a.autonomy === "draft" ? " selected" : ""}>Rascunho: toda mensagem é aprovada por uma pessoa</option>
            <option value="semi"${a.autonomy === "semi" ? " selected" : ""}>Semiautônomo: aprova o 1º e-mail; follow-ups saem sozinhos</option>
            <option value="auto"${a.autonomy === "auto" ? " selected" : ""}>Autônomo: todos os passos da cadência saem sozinhos</option>
          </select>
          <span class="hint">Respostas dos leads sempre param a cadência e vão para um humano.</span>
        </label>
        ${field("Limite de envios por dia", "dailyLimit", a.dailyLimit, { hint: "Protege a reputação do domínio de envio.", disabled: dis })}
        <label class="check span-2"><input type="checkbox" name="businessHoursOnly"${a.businessHoursOnly !== false ? " checked" : ""}${dis ? " disabled" : ""} /> Enviar só em horário comercial (seg-sex, 8h-18h de Brasília)</label>
        <p class="form-error span-2" hidden></p>
        ${canEdit ? `<div class="span-2"><button type="submit" class="btn btn-primary">${agent ? "Salvar alterações" : "Criar agente"}</button></div>` : ""}
      </form>
      <div class="panel">
        <h2>Base de conhecimento</h2>
        <p class="muted small">O agente só pode afirmar o que estiver aqui ou nos dados do lead. Nunca inventa preços, prazos ou cases.</p>
        <div id="kb">${knowledgeHtml(knowledge, agent?.id, canEdit)}</div>
        ${!agent && canEdit ? `<p class="hint mt">Salve o agente para adicionar documentos exclusivos dele.</p>` : ""}
        ${agent ? `<h2 class="mt">Cadência de follow-up</h2>
          <p class="muted small">Passos enviados aos cards inscritos. "Dias" conta a partir do envio do passo anterior (o 1º, da inscrição). A cadência para quando o lead responde, pede para sair ou o card é qualificado/desqualificado.</p>
          <div id="cadence"><p class="muted small">Carregando...</p></div>` : ""}
      </div>
    </div>`;
  refreshIcons();

  const reloadKb = async () => {
    const r = agent ? await api("GET", `/agents/${agent.id}`) : await api("GET", "/knowledge");
    knowledge = r.ok ? (agent ? r.data.knowledge : r.data.knowledge) : knowledge;
    container.querySelector("#kb").innerHTML = knowledgeHtml(knowledge, agent?.id, canEdit);
    refreshIcons();
    bindKb();
  };

  const bindKb = () => {
    container.querySelectorAll(".kb-add").forEach((b) =>
      b.addEventListener("click", () => openKnowledgeEditor(null, { agentId: agent?.id, scope: b.dataset.scope, onSaved: reloadKb }))
    );
    container.querySelectorAll(".kb-edit").forEach((b) => {
      const item = knowledge.find((k) => k.id === b.closest("li").dataset.id);
      b.addEventListener("click", () => openKnowledgeEditor(item, { agentId: agent?.id, readOnly: !canEdit, onSaved: reloadKb }));
    });
    container.querySelectorAll(".kb-delete").forEach((b) => {
      const item = knowledge.find((k) => k.id === b.closest("li").dataset.id);
      b.addEventListener("click", async () => {
        if (!confirm(`Excluir o documento "${item.title}"?${item.agentId ? "" : " Ele é compartilhado: todos os agentes deixam de usá-lo."}`)) return;
        const r = await api("DELETE", `/knowledge/${item.id}`, {});
        if (!r.ok) return toast(errorMessage(r.data), "error");
        toast("Documento excluído.", "success");
        reloadKb();
      });
    });
  };
  bindKb();

  if (agent) renderCadenceEditor(container.querySelector("#cadence"), agent.id, canEdit);

  if (!canEdit) return;
  bindForm(container.querySelector("#agent-form"), async (fd) => {
    const payload = {
      name: fd.get("name"),
      active: fd.get("active") === "true",
      senderName: fd.get("senderName"),
      senderTitle: fd.get("senderTitle"),
      persona: fd.get("persona"),
      objective: fd.get("objective"),
      tone: fd.get("tone"),
      rules: fd.get("rules"),
      qualificationCriteria: fd.get("qualificationCriteria"),
      forbidden: fd.get("forbidden"),
      signature: fd.get("signature"),
      dailyLimit: Number(fd.get("dailyLimit")),
      autonomy: fd.get("autonomy"),
      businessHoursOnly: fd.get("businessHoursOnly") === "on",
    };
    if (payload.autonomy !== "draft" && payload.autonomy !== agent?.autonomy &&
        !confirm(payload.autonomy === "auto"
          ? "Modo autônomo: os e-mails da cadência serão enviados SEM revisão humana. Confirmar?"
          : "Modo semiautônomo: depois do 1º e-mail aprovado, os follow-ups serão enviados SEM revisão. Confirmar?")) return "Alteração cancelada.";
    const r = agent ? await api("PATCH", `/agents/${agent.id}`, payload) : await api("POST", "/agents", payload);
    if (!r.ok) return errorMessage(r.data);
    toast(agent ? "Agente salvo." : "Agente criado.", "success");
    if (!agent) navigate(`/agentes/editar?id=${r.data.agent.id}`);
    return null;
  });
}
