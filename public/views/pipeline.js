// Funil de vendas: kanban (arrastar e soltar) ou lista, com busca e filtro por responsável.
import { api, errorMessage, escapeHtml, formatMoney, daysSince, refreshIcons, toast, prefs } from "../client.js";
import { openDialog, bindForm, options } from "../ui.js";
import { openDeal } from "./deal-dialog.js";
import { openImport } from "./import-dialog.js";

let state;

const SORTS = {
  company: (d) => d.company.name.toLowerCase(),
  stage: (d) => state.pipeline.stages.findIndex((s) => s.id === d.stageId),
  owner: (d) => d.owner?.name.toLowerCase() || "~",
  value: (d) => d.value ?? -1,
  days: (d) => -new Date(d.stageChangedAt).getTime(),
  updated: (d) => -new Date(d.updatedAt).getTime(),
};

function visibleDeals() {
  const q = state.search.trim().toLowerCase();
  return state.deals.filter((d) => {
    if (state.owner === "me" && d.owner?.id !== state.user.id) return false;
    if (state.owner && state.owner !== "me" && d.owner?.id !== state.owner) return false;
    if (!q) return true;
    return [d.title, d.company.name, d.company.cnpj, d.company.city, d.contact?.name, d.contact?.email]
      .filter(Boolean)
      .some((v) => v.toLowerCase().includes(q));
  });
}

function cardHtml(d) {
  const days = daysSince(d.stageChangedAt);
  return `<article class="deal-card" data-id="${d.id}" tabindex="0">
    <div class="deal-card-title">${escapeHtml(d.company.name)}</div>
    ${d.title !== d.company.name ? `<div class="deal-card-sub">${escapeHtml(d.title)}</div>` : ""}
    ${d.contact ? `<div class="deal-card-contact"><i data-lucide="user"></i>${escapeHtml(d.contact.name)}${d.contact.optOut ? ` <span class="badge badge-danger">opt-out</span>` : ""}</div>` : ""}
    <div class="deal-card-foot">
      <span class="deal-card-value">${formatMoney(d.value)}</span>
      ${d.cadenceStatus ? `<span class="cadence-dot cadence-${d.cadenceStatus}" title="${{ active: "Em cadência", waiting_approval: "Cadência: rascunho aguardando aprovação", paused: "Cadência pausada" }[d.cadenceStatus]}"><i data-lucide="repeat"></i></span>` : ""}
      <span class="deal-card-days" title="Dias nesta etapa">${days}d</span>
      ${d.owner ? `<span class="avatar avatar-sm" title="${escapeHtml(d.owner.name)}">${escapeHtml(d.owner.name.charAt(0).toUpperCase())}</span>` : ""}
    </div>
  </article>`;
}

function kanbanHtml(deals) {
  return `<div class="kanban">${state.pipeline.stages
    .map((s) => {
      const items = deals.filter((d) => d.stageId === s.id).sort((a, b) => a.position - b.position);
      const total = items.reduce((sum, d) => sum + (d.value || 0), 0);
      return `<section class="kanban-col">
        <header class="kanban-col-head" style="--stage:${s.color}">
          <span class="kanban-col-name">${escapeHtml(s.name)}</span>
          <span class="kanban-col-count">${items.length}</span>
          ${total ? `<span class="kanban-col-total">${formatMoney(total)}</span>` : ""}
        </header>
        <div class="kanban-list" data-stage="${s.id}">${items.map(cardHtml).join("")}</div>
      </section>`;
    })
    .join("")}</div>`;
}

function listHtml(deals) {
  const key = state.sort.key;
  const dir = state.sort.dir;
  const sorted = [...deals].sort((a, b) => {
    const va = SORTS[key](a);
    const vb = SORTS[key](b);
    return (va > vb ? 1 : va < vb ? -1 : 0) * dir;
  });
  const th = (k, label) =>
    `<th><button class="th-sort${key === k ? " active" : ""}" data-sort="${k}">${label}${key === k ? (dir > 0 ? " ↑" : " ↓") : ""}</button></th>`;
  const stageOpts = (d) => options(state.pipeline.stages.map((s) => ({ value: s.id, label: escapeHtml(s.name) })), d.stageId);

  if (!sorted.length) return `<div class="panel empty-state"><p class="muted">Nenhum card encontrado.</p></div>`;
  return `<div class="panel panel-flush"><table class="table table-click">
    <thead><tr>${th("company", "Empresa")}<th>Contato</th>${th("stage", "Etapa")}${th("owner", "Responsável")}${th("value", "Valor")}${th("days", "Na etapa")}</tr></thead>
    <tbody>${sorted
      .map(
        (d) => `<tr data-id="${d.id}">
          <td data-label="Empresa"><strong>${escapeHtml(d.company.name)}</strong>${d.company.city ? `<div class="muted small">${escapeHtml([d.company.city, d.company.uf].filter(Boolean).join("/"))}</div>` : ""}</td>
          <td data-label="Contato">${d.contact ? `${escapeHtml(d.contact.name)}${d.contact.email && d.contact.email !== d.contact.name ? `<div class="muted small">${escapeHtml(d.contact.email)}</div>` : ""}` : "—"}</td>
          <td data-label="Etapa"><select class="select-sm stage-select" data-id="${d.id}">${stageOpts(d)}</select></td>
          <td data-label="Responsável">${escapeHtml(d.owner?.name || "—")}</td>
          <td data-label="Valor">${formatMoney(d.value) || "—"}</td>
          <td data-label="Na etapa">${daysSince(d.stageChangedAt)} dias</td>
        </tr>`
      )
      .join("")}</tbody></table></div>`;
}

function toolbarHtml() {
  const { pipelines, pipeline, view, user } = state;
  const canManage = ["admin", "gestor"].includes(user.role);
  const ownerOpts = [
    { value: "", label: "Todos os responsáveis" },
    { value: "me", label: "Meus cards" },
    ...state.owners.filter((o) => o.id !== user.id).map((o) => ({ value: o.id, label: escapeHtml(o.name) })),
  ];
  return `
    <div class="page-head page-head-row">
      <div class="title-with-select">
        <h1>Funil</h1>
        ${pipelines.length > 1 ? `<select id="pipeline-select" class="select-title">${options(pipelines.map((p) => ({ value: p.id, label: escapeHtml(p.name) })), pipeline.id)}</select>` : `<span class="muted">${escapeHtml(pipeline.name)}</span>`}
      </div>
      <div class="toolbar-actions">
        ${canManage ? `<a class="btn btn-secondary" href="#/funil/configurar"><i data-lucide="settings-2"></i>Configurar</a>
        <button class="btn btn-secondary" id="import-btn"><i data-lucide="upload"></i>Importar CSV</button>` : ""}
        <button class="btn btn-primary" id="new-deal"><i data-lucide="plus"></i>Novo lead</button>
      </div>
    </div>
    <div class="toolbar">
      <div class="search"><i data-lucide="search"></i><input id="deal-search" type="search" placeholder="Buscar empresa, contato, CNPJ..." value="${escapeHtml(state.search)}" /></div>
      <select id="owner-filter">${options(ownerOpts, state.owner)}</select>
      <div class="segmented" role="group" aria-label="Visualização">
        <button data-view="kanban" class="${view === "kanban" ? "active" : ""}"><i data-lucide="kanban"></i>Kanban</button>
        <button data-view="list" class="${view === "list" ? "active" : ""}"><i data-lucide="list"></i>Lista</button>
      </div>
    </div>
    <div id="board"></div>`;
}

function drawBoard() {
  const board = state.container.querySelector("#board");
  const deals = visibleDeals();
  board.innerHTML = state.view === "kanban" ? kanbanHtml(deals) : listHtml(deals);
  refreshIcons();
  if (state.view === "kanban") bindKanban(board);
  else bindList(board);
}

function dealCtx() {
  return {
    pipeline: state.pipeline,
    owners: state.owners,
    user: state.user,
    onChange: (deal) => {
      state.deals = state.deals.map((d) => (d.id === deal.id ? deal : d));
      drawBoard();
    },
    onDelete: (id) => {
      state.deals = state.deals.filter((d) => d.id !== id);
      drawBoard();
    },
  };
}

async function moveDeal(dealId, stageId, beforeId, afterId) {
  const { ok, data } = await api("POST", `/deals/${dealId}/move`, { stageId, beforeId, afterId });
  if (!ok) {
    toast(errorMessage(data), "error");
    drawBoard(); // volta o card para onde estava
    return;
  }
  const previousStage = state.deals.find((d) => d.id === dealId)?.stageId;
  state.deals = state.deals.map((d) => (d.id === dealId ? data.deal : d));
  const stage = state.pipeline.stages.find((s) => s.id === stageId);
  if (stage.kind === "qualified" && previousStage !== stageId) toast(`${data.deal.company.name}: lead qualificado!`, "success");
  drawBoard();
}

function bindKanban(board) {
  board.querySelectorAll(".deal-card").forEach((el) => {
    const open = () => openDeal(el.dataset.id, dealCtx());
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => e.key === "Enter" && open());
  });
  if (!window.Sortable) return;
  board.querySelectorAll(".kanban-list").forEach((list) => {
    window.Sortable.create(list, {
      group: "deals",
      animation: 150,
      // Eventos de mouse/toque em vez do drag nativo do HTML5: comportamento igual em todos os navegadores.
      forceFallback: true,
      fallbackTolerance: 4,
      ghostClass: "deal-card-ghost",
      dragClass: "deal-card-drag",
      delayOnTouchOnly: true,
      delay: 150,
      onEnd: (evt) => {
        if (evt.from === evt.to && evt.oldIndex === evt.newIndex) return;
        const item = evt.item;
        moveDeal(
          item.dataset.id,
          evt.to.dataset.stage,
          item.previousElementSibling?.dataset.id || null,
          item.nextElementSibling?.dataset.id || null
        );
      },
    });
  });
}

function bindList(board) {
  board.querySelectorAll("[data-sort]").forEach((b) =>
    b.addEventListener("click", () => {
      const k = b.dataset.sort;
      state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 };
      drawBoard();
    })
  );
  board.querySelectorAll("tbody tr").forEach((tr) =>
    tr.addEventListener("click", (e) => {
      if (e.target.closest("select")) return;
      openDeal(tr.dataset.id, dealCtx());
    })
  );
  board.querySelectorAll(".stage-select").forEach((sel) =>
    sel.addEventListener("change", () => moveDeal(sel.dataset.id, sel.value, null, null))
  );
}

function openNewDeal() {
  const { pipeline, owners, user } = state;
  const dialog = openDialog(`
    <form class="form form-grid" novalidate>
      <h2 class="span-2">Novo lead</h2>
      <h3 class="span-2 form-section">Empresa</h3>
      <label class="span-2">Nome da empresa *<input name="companyName" required autofocus /></label>
      <label>CNPJ<input name="cnpj" placeholder="00.000.000/0000-00" /></label>
      <label>Segmento<input name="segment" /></label>
      <label>Cidade<input name="city" /></label>
      <label>UF<input name="uf" maxlength="2" /></label>
      <label class="span-2">Site<input name="website" placeholder="empresa.com.br" /></label>
      <h3 class="span-2 form-section">Contato</h3>
      <label>Nome<input name="contactName" /></label>
      <label>Cargo<input name="jobTitle" /></label>
      <label>E-mail<input type="email" name="email" /></label>
      <label>Telefone<input name="phone" /></label>
      <h3 class="span-2 form-section">Funil</h3>
      <label>Etapa<select name="stageId">${options(pipeline.stages.map((s) => ({ value: s.id, label: escapeHtml(s.name) })), pipeline.stages[0].id)}</select></label>
      <label>Responsável<select name="ownerId">${options(owners.map((o) => ({ value: o.id, label: escapeHtml(o.name) })), user.id, { empty: "Sem responsável" })}</select></label>
      <label>Valor estimado (R$)<input name="value" inputmode="decimal" /></label>
      <p class="form-error span-2" hidden></p>
      <div class="dialog-actions span-2">
        <button type="button" class="btn btn-secondary" data-close>Cancelar</button>
        <button type="submit" class="btn btn-primary">Criar lead</button>
      </div>
    </form>`);
  dialog.classList.add("dialog-wide");

  bindForm(dialog.querySelector("form"), async (fd) => {
    const { ok, data } = await api("POST", "/deals", {
      pipelineId: pipeline.id,
      stageId: fd.get("stageId"),
      ownerId: fd.get("ownerId") || null,
      value: fd.get("value"),
      company: {
        name: fd.get("companyName"),
        cnpj: fd.get("cnpj"),
        segment: fd.get("segment"),
        city: fd.get("city"),
        uf: fd.get("uf"),
        website: fd.get("website"),
      },
      contact: { name: fd.get("contactName"), jobTitle: fd.get("jobTitle"), email: fd.get("email"), phone: fd.get("phone") },
    });
    if (!ok) return errorMessage(data);
    state.deals.push(data.deal);
    drawBoard();
    toast("Lead criado.", "success");
    dialog.close();
    return null;
  });
}

async function loadDeals() {
  const { ok, data } = await api("GET", `/deals?pipelineId=${state.pipeline.id}`);
  state.deals = ok ? data.deals : [];
  if (!ok) toast(errorMessage(data), "error");
}

function bindToolbar() {
  const c = state.container;
  c.querySelector("#new-deal").addEventListener("click", openNewDeal);
  c.querySelector("#import-btn")?.addEventListener("click", () =>
    openImport(state.pipeline, async () => {
      await loadDeals();
      drawBoard();
    })
  );
  c.querySelector("#pipeline-select")?.addEventListener("change", async (e) => {
    state.pipeline = state.pipelines.find((p) => p.id === e.target.value);
    prefs.set("pipeline", state.pipeline.id);
    await loadDeals();
    drawBoard();
  });
  let timer;
  c.querySelector("#deal-search").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.search = e.target.value;
      drawBoard();
    }, 150);
  });
  c.querySelector("#owner-filter").addEventListener("change", (e) => {
    state.owner = e.target.value;
    drawBoard();
  });
  c.querySelectorAll("[data-view]").forEach((b) =>
    b.addEventListener("click", () => {
      state.view = b.dataset.view;
      prefs.set("view", state.view);
      c.querySelectorAll("[data-view]").forEach((x) => x.classList.toggle("active", x === b));
      drawBoard();
    })
  );
}

export async function renderPipeline(container, { user }) {
  container.innerHTML = `<p class="muted">Carregando funil...</p>`;
  const [pRes, oRes] = await Promise.all([api("GET", "/pipelines"), api("GET", "/users/options")]);
  if (!pRes.ok) {
    container.innerHTML = `<p class="form-error">${escapeHtml(errorMessage(pRes.data))}</p>`;
    return;
  }
  const pipelines = pRes.data.pipelines;
  const saved = prefs.get("pipeline", null);
  state = {
    container,
    user,
    pipelines,
    pipeline: pipelines.find((p) => p.id === saved) || pipelines[0],
    owners: oRes.ok ? oRes.data.users : [],
    deals: [],
    view: prefs.get("view", "kanban") === "list" ? "list" : "kanban",
    search: "",
    owner: "",
    sort: { key: "updated", dir: 1 },
  };
  await loadDeals();
  container.innerHTML = toolbarHtml();
  bindToolbar();
  drawBoard();
}
