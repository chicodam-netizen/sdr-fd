// Configuração dos funis: etapas (nome, cor, tipo, ordem), novos funis e arquivamento.
import { api, errorMessage, escapeHtml, refreshIcons, toast } from "../client.js";
import { openDialog, bindForm, options } from "../ui.js";

const KIND_LABELS = { open: "Em andamento", qualified: "Qualificado (entrega)", disqualified: "Desqualificado" };
let state;

function stageRow(s) {
  return `<li class="stage-row" data-id="${s.id}">
    <span class="drag-handle" title="Arraste para reordenar"><i data-lucide="grip-vertical"></i></span>
    <input type="color" class="stage-color" value="${s.color}" aria-label="Cor" />
    <input class="stage-name" value="${escapeHtml(s.name)}" maxlength="60" aria-label="Nome da etapa" />
    <select class="stage-kind" aria-label="Tipo">${options(Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })), s.kind)}</select>
    <button class="icon-btn stage-delete" title="Excluir etapa"><i data-lucide="trash-2"></i></button>
  </li>`;
}

function draw() {
  const { container, pipelines, pipeline } = state;
  container.innerHTML = `
    <div class="page-head page-head-row">
      <div>
        <a href="#/funil" class="link-small back-link"><i data-lucide="arrow-left"></i>Voltar ao funil</a>
        <h1>Configurar funil</h1>
        <p class="muted">As alterações são salvas automaticamente.</p>
      </div>
      <button class="btn btn-secondary" id="new-pipeline"><i data-lucide="plus"></i>Novo funil</button>
    </div>
    <div class="grid-config">
      <div class="panel">
        <div class="form-row">
          <label class="grow">Funil
            <select id="cfg-pipeline">${options(pipelines.map((p) => ({ value: p.id, label: escapeHtml(p.name) })), pipeline.id)}</select>
          </label>
          <label class="grow">Nome<input id="cfg-name" value="${escapeHtml(pipeline.name)}" maxlength="80" /></label>
        </div>
        <h2 class="mt">Etapas</h2>
        <ul class="stage-list" id="stage-list">${pipeline.stages.map(stageRow).join("")}</ul>
        <form id="add-stage" class="form-row mt" novalidate>
          <input name="name" placeholder="Nova etapa" maxlength="60" class="grow" />
          <button class="btn btn-secondary" type="submit"><i data-lucide="plus"></i>Adicionar etapa</button>
        </form>
        ${pipelines.length > 1 ? `<div class="drawer-danger"><button class="btn btn-ghost-danger btn-sm" id="archive-pipeline"><i data-lucide="archive"></i>Arquivar este funil</button></div>` : ""}
      </div>
      <div class="panel">
        <h2>Tipos de etapa</h2>
        <dl class="details">
          <dt>Em andamento</dt><dd>Lead sendo trabalhado (pesquisa, contato, conversa).</dd>
          <dt>Qualificado</dt><dd>Lead entregue ao time comercial. Conta como resultado no painel.</dd>
          <dt>Desqualificado</dt><dd>Lead descartado (sem fit, sem interesse, pediu para não ser contatado).</dd>
        </dl>
        <p class="hint mt">Etapas com cards não podem ser excluídas: mova os cards antes.</p>
      </div>
    </div>`;
  refreshIcons();
  bind();
}

async function reload(selectId) {
  const { ok, data } = await api("GET", "/pipelines");
  if (!ok) return toast(errorMessage(data), "error");
  state.pipelines = data.pipelines;
  state.pipeline = data.pipelines.find((p) => p.id === (selectId || state.pipeline?.id)) || data.pipelines[0];
  draw();
}

async function patchStage(id, payload) {
  const { ok, data } = await api("PATCH", `/stages/${id}`, payload);
  if (!ok) {
    toast(errorMessage(data), "error");
    await reload();
    return;
  }
  const s = state.pipeline.stages.find((x) => x.id === id);
  Object.assign(s, data.stage);
  toast("Etapa salva.", "success");
}

function bind() {
  const c = state.container;
  c.querySelector("#cfg-pipeline").addEventListener("change", (e) => reload(e.target.value));

  c.querySelector("#cfg-name").addEventListener("change", async (e) => {
    const { ok, data } = await api("PATCH", `/pipelines/${state.pipeline.id}`, { name: e.target.value });
    if (!ok) return toast(errorMessage(data), "error");
    toast("Nome do funil salvo.", "success");
    reload();
  });

  c.querySelectorAll(".stage-row").forEach((row) => {
    const id = row.dataset.id;
    row.querySelector(".stage-name").addEventListener("change", (e) => patchStage(id, { name: e.target.value }));
    row.querySelector(".stage-color").addEventListener("change", (e) => patchStage(id, { color: e.target.value }));
    row.querySelector(".stage-kind").addEventListener("change", (e) => patchStage(id, { kind: e.target.value }));
    row.querySelector(".stage-delete").addEventListener("click", async () => {
      const name = row.querySelector(".stage-name").value;
      if (!confirm(`Excluir a etapa "${name}"?`)) return;
      const { ok, data } = await api("DELETE", `/stages/${id}`, {});
      if (!ok) return toast(errorMessage(data), "error");
      toast("Etapa excluída.", "success");
      reload();
    });
  });

  if (window.Sortable) {
    window.Sortable.create(c.querySelector("#stage-list"), {
      handle: ".drag-handle",
      animation: 150,
      onEnd: async () => {
        const order = [...c.querySelectorAll(".stage-row")].map((r) => r.dataset.id);
        const { ok, data } = await api("POST", `/pipelines/${state.pipeline.id}/stages/reorder`, { order });
        if (!ok) toast(errorMessage(data), "error");
        else toast("Ordem salva.", "success");
        reload();
      },
    });
  }

  bindForm(c.querySelector("#add-stage"), async (fd) => {
    const { ok, data } = await api("POST", `/pipelines/${state.pipeline.id}/stages`, { name: fd.get("name") });
    if (!ok) return toast(errorMessage(data), "error");
    reload();
    return null;
  });

  c.querySelector("#archive-pipeline")?.addEventListener("click", async () => {
    if (!confirm(`Arquivar o funil "${state.pipeline.name}"? Ele some das telas, mas os dados são mantidos.`)) return;
    const { ok, data } = await api("POST", `/pipelines/${state.pipeline.id}/archive`, {});
    if (!ok) return toast(errorMessage(data), "error");
    toast("Funil arquivado.", "success");
    state.pipeline = null;
    reload();
  });

  c.querySelector("#new-pipeline").addEventListener("click", () => {
    const dialog = openDialog(`
      <form class="form" novalidate>
        <h2>Novo funil</h2>
        <label>Nome<input name="name" required autofocus maxlength="80" /></label>
        <p class="hint">Começa com as etapas padrão; depois você ajusta.</p>
        <p class="form-error" hidden></p>
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" data-close>Cancelar</button>
          <button type="submit" class="btn btn-primary">Criar funil</button>
        </div>
      </form>`);
    bindForm(dialog.querySelector("form"), async (fd) => {
      const { ok, data } = await api("POST", "/pipelines", { name: fd.get("name") });
      if (!ok) return errorMessage(data);
      dialog.close();
      toast("Funil criado.", "success");
      reload(data.pipeline.id);
      return null;
    });
  });
}

export async function renderPipelineConfig(container) {
  state = { container, pipelines: [], pipeline: null };
  container.innerHTML = `<p class="muted">Carregando...</p>`;
  await reload();
}
