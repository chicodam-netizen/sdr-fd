// Captação de leads: base pública de CNPJ (Receita) e Google Maps -> funil.
import { api, errorMessage, escapeHtml, formatCnpj, formatMoney, refreshIcons, toast, prefs } from "../client.js";
import { openDialog, bindForm, options } from "../ui.js";

const UFS = "AC AL AM AP BA CE DF ES GO MA MG MS MT PA PB PE PI PR RJ RN RO RR RS SC SE SP TO".split(" ");
const PORTES = [
  { value: "demais", label: "Médio/grande" },
  { value: "pequeno", label: "Pequeno porte" },
  { value: "micro", label: "Microempresa" },
];
let state;

function isManager() {
  return ["admin", "gestor"].includes(state.user.role);
}

// ---------- Envio ao funil (comum às duas fontes) ----------
async function openSendDialog(count, buildPayload, onDone) {
  const [p, a] = await Promise.all([api("GET", "/pipelines"), api("GET", "/agents")]);
  if (!p.ok) return toast(errorMessage(p.data), "error");
  const pipelines = p.data.pipelines;
  const agents = a.ok ? a.data.agents.filter((x) => x.active) : [];
  let pipeline = pipelines.find((x) => x.id === prefs.get("pipeline", "")) || pipelines[0];
  const stageOpts = () => options(pipeline.stages.map((s) => ({ value: s.id, label: escapeHtml(s.name) })), pipeline.stages[0].id);

  const dialog = openDialog(`
    <form class="form" novalidate>
      <h2>Enviar ${count} empresa(s) ao funil</h2>
      <label>Funil<select name="pipelineId">${options(pipelines.map((x) => ({ value: x.id, label: escapeHtml(x.name) })), pipeline.id)}</select></label>
      <label>Etapa de entrada<select name="stageId">${stageOpts()}</select></label>
      <label>Agente SDR (opcional)<select name="agentId">${options(agents.map((x) => ({ value: x.id, label: escapeHtml(x.name) })), "", { empty: "Definir depois" })}</select></label>
      <p class="hint">Empresas que já estão neste funil são ignoradas. A origem (fonte e busca) fica registrada em cada empresa.</p>
      <p class="form-error" hidden></p>
      <div class="dialog-actions">
        <button type="button" class="btn btn-secondary" data-close>Cancelar</button>
        <button type="submit" class="btn btn-primary">Enviar ao funil</button>
      </div>
    </form>`);
  dialog.querySelector("[name=pipelineId]").addEventListener("change", (e) => {
    pipeline = pipelines.find((x) => x.id === e.target.value);
    dialog.querySelector("[name=stageId]").innerHTML = stageOpts();
  });
  bindForm(dialog.querySelector("form"), async (fd) => {
    const r = await api("POST", "/sourcing/import", {
      ...buildPayload(),
      pipelineId: fd.get("pipelineId"),
      stageId: fd.get("stageId"),
      agentId: fd.get("agentId") || null,
    });
    if (!r.ok) return errorMessage(r.data);
    toast(`${r.data.created} empresa(s) enviada(s) ao funil${r.data.alreadyInPipeline ? `; ${r.data.alreadyInPipeline} já estavam lá` : ""}.`, "success");
    dialog.close();
    onDone();
    return null;
  });
}

function selectionBar(id, count, label) {
  return `<div class="selection-bar" id="${id}" ${count ? "" : "hidden"}>
    <span><strong>${count}</strong> selecionada(s)</span>
    ${isManager() ? `<button class="btn btn-primary btn-sm" data-send><i data-lucide="send-to-back"></i>${label}</button>` : `<span class="muted small">Peça a um gestor para enviar ao funil.</span>`}
  </div>`;
}

// ---------- Base CNPJ ----------
function cnpjFiltersHtml() {
  const s = state.status.cnpjBase;
  const f = state.cnpj.filters;
  if (!s.rows) {
    return `<div class="panel empty-state"><i data-lucide="database"></i><h2>Base CNPJ ainda não carregada</h2>
      <p class="muted">Os dados abertos da Receita Federal são carregados por um script, com recorte por UF e CNAE (a base completa tem dezenas de milhões de empresas).</p>
      <p class="muted small">Comando: <code>node --env-file=.env.local scripts/load-cnpj.js --dir PASTA_DOS_ZIPS --uf MG --cnae 10,62</code></p></div>`;
  }
  return `
    <form id="cnpj-form" class="panel form sourcing-filters" novalidate>
      <div class="filters-grid">
        <label>UF<select name="uf">${options(UFS.map((u) => ({ value: u, label: u + (s.ufs.includes(u) ? "" : " (não carregada)") })), f.uf || s.ufs[0] || "", { empty: "Todas" })}</select></label>
        <label>Município<select name="municipio"><option value="">Todos</option></select></label>
        <label class="span-2 cnae-picker">Atividade (CNAE)
          <input id="cnae-search" placeholder="Digite parte da descrição ou o código (ex.: laticínios, 1052)" autocomplete="off" />
          <div id="cnae-suggestions" class="suggestions" hidden></div>
          <div id="cnae-chips" class="chips"></div>
        </label>
        <label>Nome contém<input name="q" value="${escapeHtml(f.q || "")}" /></label>
        <fieldset class="checks"><legend>Porte</legend>
          ${PORTES.map((p) => `<label class="check"><input type="checkbox" name="porte" value="${p.value}"${(f.porte || []).includes(p.value) ? " checked" : ""} />${p.label}</label>`).join("")}
        </fieldset>
        <fieldset class="checks span-2"><legend>Somente</legend>
          <label class="check"><input type="checkbox" name="hasEmail"${f.hasEmail ? " checked" : ""} />com e-mail</label>
          <label class="check"><input type="checkbox" name="hasPhone"${f.hasPhone ? " checked" : ""} />com telefone</label>
          <label class="check"><input type="checkbox" name="matriz"${f.matriz ? " checked" : ""} />matriz</label>
          <label class="check"><input type="checkbox" name="notInBase"${f.notInBase !== false ? " checked" : ""} />fora da minha base</label>
        </fieldset>
      </div>
      <p class="form-error" hidden></p>
      <div><button type="submit" class="btn btn-primary"><i data-lucide="search"></i>Buscar empresas</button></div>
    </form>
    <div id="cnpj-results"></div>`;
}

function cnpjResultsHtml() {
  const r = state.cnpj.result;
  if (!r) return "";
  if (!r.results.length) return `<div class="panel empty-state"><p class="muted">Nenhuma empresa com esses filtros.</p></div>`;
  const sel = state.cnpj.selected;
  const pages = Math.ceil(r.total / r.pageSize);
  return `
    <div class="results-head"><span><strong>${r.total.toLocaleString("pt-BR")}</strong> empresa(s) · página ${r.page} de ${pages}</span>
      <span class="pager">
        <button class="btn btn-secondary btn-sm" data-page="${r.page - 1}" ${r.page <= 1 ? "disabled" : ""}>Anterior</button>
        <button class="btn btn-secondary btn-sm" data-page="${r.page + 1}" ${r.page >= pages ? "disabled" : ""}>Próxima</button>
      </span></div>
    <div class="panel panel-flush"><table class="table">
      <thead><tr><th><input type="checkbox" id="cnpj-all" aria-label="Selecionar página" /></th><th>Empresa</th><th>Atividade</th><th>Porte</th><th>Local</th><th>Contato</th><th>Capital</th></tr></thead>
      <tbody>${r.results
        .map(
          (x) => `<tr>
            <td><input type="checkbox" class="cnpj-check" value="${x.cnpj}"${sel.has(x.cnpj) ? " checked" : ""}${x.inBase ? " disabled" : ""} /></td>
            <td data-label="Empresa"><strong>${escapeHtml(x.name)}</strong>${x.inBase ? ` <span class="badge badge-muted">na base</span>` : ""}
              <div class="muted small">${escapeHtml(formatCnpj(x.cnpj))}${x.legalName && x.legalName !== x.name ? ` · ${escapeHtml(x.legalName)}` : ""}${x.isMatriz ? "" : " · filial"}</div></td>
            <td data-label="Atividade" class="small">${escapeHtml(x.cnaeDescription || x.cnae)}</td>
            <td data-label="Porte" class="small">${escapeHtml(x.sizeLabel || "—")}</td>
            <td data-label="Local">${escapeHtml([x.city, x.uf].filter(Boolean).join("/"))}</td>
            <td data-label="Contato" class="small">${escapeHtml(x.email || "")}${x.email && x.phone ? "<br>" : ""}${escapeHtml(x.phone || "")}${!x.email && !x.phone ? "—" : ""}</td>
            <td data-label="Capital" class="small">${x.capital ? formatMoney(x.capital) : "—"}</td>
          </tr>`
        )
        .join("")}</tbody></table></div>
    ${selectionBar("cnpj-bar", sel.size, "Enviar ao funil")}`;
}

function drawCnpjChips() {
  const box = state.container.querySelector("#cnae-chips");
  if (!box) return;
  box.innerHTML = state.cnpj.cnaes
    .map((c) => `<span class="chip" title="${escapeHtml(c.description)}">${escapeHtml(c.code)} · ${escapeHtml(c.description.slice(0, 40))}<button type="button" data-remove="${escapeHtml(c.code)}" aria-label="Remover">×</button></span>`)
    .join("");
  box.querySelectorAll("[data-remove]").forEach((b) =>
    b.addEventListener("click", () => {
      state.cnpj.cnaes = state.cnpj.cnaes.filter((c) => c.code !== b.dataset.remove);
      drawCnpjChips();
    })
  );
}

async function loadMunicipios(uf, selected) {
  const sel = state.container.querySelector("[name=municipio]");
  if (!sel) return;
  if (!uf) {
    sel.innerHTML = `<option value="">Todos</option>`;
    return;
  }
  const r = await api("GET", `/sourcing/municipios?uf=${uf}`);
  const list = r.ok ? r.data.municipios : [];
  sel.innerHTML = `<option value="">Todos</option>` + list.map((m) => `<option value="${escapeHtml(m.value)}"${m.value === selected ? " selected" : ""}>${escapeHtml(m.name)} (${m.count})</option>`).join("");
}

async function runCnpjSearch(page = 1) {
  const f = state.cnpj.filters;
  const qs = new URLSearchParams();
  if (f.uf) qs.set("uf", f.uf);
  if (f.municipio) qs.set("municipio", f.municipio);
  if (state.cnpj.cnaes.length) qs.set("cnae", state.cnpj.cnaes.map((c) => c.code).join(","));
  if (f.porte?.length) qs.set("porte", f.porte.join(","));
  if (f.q) qs.set("q", f.q);
  for (const k of ["hasEmail", "hasPhone", "matriz", "notInBase"]) if (f[k]) qs.set(k, "1");
  qs.set("page", page);
  const box = state.container.querySelector("#cnpj-results");
  box.innerHTML = `<p class="muted">Buscando...</p>`;
  const r = await api("GET", `/sourcing/cnpj?${qs}`);
  if (!r.ok) {
    box.innerHTML = "";
    return toast(r.data.error === "missing_filters" ? "Escolha ao menos UF, atividade (CNAE) ou nome." : errorMessage(r.data), "error");
  }
  state.cnpj.result = r.data;
  drawCnpjResults();
}

function drawCnpjResults() {
  const box = state.container.querySelector("#cnpj-results");
  box.innerHTML = cnpjResultsHtml();
  refreshIcons();
  const sel = state.cnpj.selected;
  const updateBar = () => {
    const bar = box.querySelector("#cnpj-bar");
    if (!bar) return;
    bar.hidden = !sel.size;
    bar.querySelector("strong").textContent = sel.size;
  };
  box.querySelectorAll("[data-page]").forEach((b) => b.addEventListener("click", () => runCnpjSearch(Number(b.dataset.page))));
  box.querySelectorAll(".cnpj-check").forEach((c) =>
    c.addEventListener("change", () => {
      c.checked ? sel.add(c.value) : sel.delete(c.value);
      updateBar();
    })
  );
  box.querySelector("#cnpj-all")?.addEventListener("change", (e) => {
    box.querySelectorAll(".cnpj-check:not(:disabled)").forEach((c) => {
      c.checked = e.target.checked;
      e.target.checked ? sel.add(c.value) : sel.delete(c.value);
    });
    updateBar();
  });
  box.querySelector("#cnpj-bar [data-send]")?.addEventListener("click", () =>
    openSendDialog(sel.size, () => ({ source: "cnpj", cnpjs: [...sel] }), () => {
      sel.clear();
      runCnpjSearch(state.cnpj.result.page);
    })
  );
}

function bindCnpj() {
  const form = state.container.querySelector("#cnpj-form");
  if (!form) return;
  const ufSel = form.querySelector("[name=uf]");
  loadMunicipios(ufSel.value, state.cnpj.filters.municipio);
  ufSel.addEventListener("change", () => loadMunicipios(ufSel.value));
  drawCnpjChips();

  const input = form.querySelector("#cnae-search");
  const sug = form.querySelector("#cnae-suggestions");
  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) return (sug.hidden = true);
      const r = await api("GET", `/sourcing/cnaes?q=${encodeURIComponent(q)}`);
      const list = r.ok ? r.data.cnaes : [];
      // Código digitado vira filtro por prefixo (ex.: "10" = toda a divisão de alimentos).
      const digits = q.replace(/\D/g, "");
      const prefixOption = digits.length >= 2 && digits.length < 7 ? [{ code: digits, description: `Todos os CNAEs iniciados por ${digits}` }] : [];
      const all = [...prefixOption, ...list];
      sug.innerHTML = all.length
        ? all.map((c) => `<button type="button" data-code="${escapeHtml(c.code)}" data-desc="${escapeHtml(c.description)}"><strong>${escapeHtml(c.code)}</strong> ${escapeHtml(c.description)}</button>`).join("")
        : `<span class="muted small">Nenhum CNAE encontrado.</span>`;
      sug.hidden = false;
      sug.querySelectorAll("[data-code]").forEach((b) =>
        b.addEventListener("click", () => {
          if (!state.cnpj.cnaes.some((c) => c.code === b.dataset.code)) state.cnpj.cnaes.push({ code: b.dataset.code, description: b.dataset.desc });
          input.value = "";
          sug.hidden = true;
          drawCnpjChips();
        })
      );
    }, 250);
  });

  bindForm(form, async (fd) => {
    state.cnpj.filters = {
      uf: fd.get("uf"),
      municipio: fd.get("municipio"),
      q: fd.get("q"),
      porte: fd.getAll("porte"),
      hasEmail: fd.get("hasEmail") === "on",
      hasPhone: fd.get("hasPhone") === "on",
      matriz: fd.get("matriz") === "on",
      notInBase: fd.get("notInBase") === "on",
    };
    state.cnpj.selected.clear();
    await runCnpjSearch(1);
    return null;
  });
}

// ---------- Google Maps ----------
function placesHtml() {
  if (!state.status.placesConfigured) {
    return `<div class="panel empty-state"><i data-lucide="map-pin"></i><h2>Google Maps não configurado</h2>
      <p class="muted">Requer uma chave da Google Places API (cobrança por uso no Google Cloud) em <code>GOOGLE_PLACES_API_KEY</code>.</p></div>`;
  }
  return `
    <form id="places-form" class="panel form form-row" novalidate>
      <label class="grow">O que e onde<input name="q" placeholder="ex.: indústria de laticínios em Juiz de Fora MG" value="${escapeHtml(state.places.q)}" required /></label>
      <button type="submit" class="btn btn-primary"><i data-lucide="search"></i>Buscar no Google Maps</button>
    </form>
    <div id="places-results"></div>`;
}

function drawPlaces() {
  const box = state.container.querySelector("#places-results");
  const list = state.places.results;
  const sel = state.places.selected;
  if (!list.length) {
    box.innerHTML = state.places.searched ? `<div class="panel empty-state"><p class="muted">Nenhum resultado.</p></div>` : "";
    return;
  }
  box.innerHTML = `
    <div class="results-head"><span><strong>${list.length}</strong> resultado(s)</span>
      ${state.places.nextPageToken ? `<button class="btn btn-secondary btn-sm" id="places-more">Mais resultados</button>` : ""}</div>
    <div class="panel panel-flush"><table class="table">
      <thead><tr><th></th><th>Empresa</th><th>Categoria</th><th>Local</th><th>Telefone / site</th><th>Avaliação</th></tr></thead>
      <tbody>${list
        .map(
          (p) => `<tr>
            <td><input type="checkbox" class="place-check" value="${escapeHtml(p.placeId)}"${sel.has(p.placeId) ? " checked" : ""}${p.inBase ? " disabled" : ""} /></td>
            <td data-label="Empresa"><strong>${escapeHtml(p.name)}</strong>${p.inBase ? ` <span class="badge badge-muted">na base</span>` : ""}<div class="muted small">${escapeHtml(p.address || "")}</div></td>
            <td data-label="Categoria" class="small">${escapeHtml(p.category || "—")}</td>
            <td data-label="Local">${escapeHtml([p.city, p.uf].filter(Boolean).join("/"))}</td>
            <td data-label="Contato" class="small">${escapeHtml(p.phone || "")}${p.website ? `<br><a href="${escapeHtml(p.website)}" target="_blank" rel="noopener">site</a>` : ""}</td>
            <td data-label="Avaliação" class="small">${p.rating ? `${p.rating} ★ (${p.ratings})` : "—"}</td>
          </tr>`
        )
        .join("")}</tbody></table></div>
    ${selectionBar("places-bar", sel.size, "Enviar ao funil")}`;
  refreshIcons();
  const updateBar = () => {
    const bar = box.querySelector("#places-bar");
    bar.hidden = !sel.size;
    bar.querySelector("strong").textContent = sel.size;
  };
  box.querySelectorAll(".place-check").forEach((c) =>
    c.addEventListener("change", () => {
      c.checked ? sel.add(c.value) : sel.delete(c.value);
      updateBar();
    })
  );
  box.querySelector("#places-more")?.addEventListener("click", () => searchPlaces(true));
  box.querySelector("#places-bar [data-send]")?.addEventListener("click", () =>
    openSendDialog(sel.size, () => ({ source: "places", searchQuery: state.places.q, places: list.filter((p) => sel.has(p.placeId)) }), () => {
      sel.clear();
      searchPlaces(false);
    })
  );
}

async function searchPlaces(more) {
  const qs = new URLSearchParams({ q: state.places.q });
  if (more && state.places.nextPageToken) qs.set("pageToken", state.places.nextPageToken);
  const r = await api("GET", `/sourcing/places?${qs}`);
  if (!r.ok) return toast(errorMessage(r.data), "error");
  state.places.results = more ? [...state.places.results, ...r.data.results] : r.data.results;
  state.places.nextPageToken = r.data.nextPageToken;
  state.places.searched = true;
  drawPlaces();
}

function bindPlaces() {
  const form = state.container.querySelector("#places-form");
  if (!form) return;
  bindForm(form, async (fd) => {
    state.places.q = fd.get("q").trim();
    if (!state.places.q) return "Descreva o que procurar.";
    state.places.selected.clear();
    await searchPlaces(false);
    return null;
  });
}

// ---------- Página ----------
function draw() {
  const { container, tab, status } = state;
  const s = status.cnpjBase;
  container.innerHTML = `
    <div class="page-head"><h1>Captação de leads</h1>
      <p class="muted">Encontre empresas por atividade e região e envie direto para o funil. A origem de cada lead fica registrada (LGPD).</p></div>
    <div class="segmented tabs" role="tablist">
      <button data-tab="cnpj" class="${tab === "cnpj" ? "active" : ""}"><i data-lucide="database"></i>Base CNPJ (Receita)</button>
      <button data-tab="places" class="${tab === "places" ? "active" : ""}"><i data-lucide="map-pin"></i>Google Maps</button>
      <button data-tab="linkedin" class="${tab === "linkedin" ? "active" : ""}"><i data-lucide="linkedin"></i>LinkedIn</button>
    </div>
    <p class="muted small source-status">
      Base CNPJ: ${s.rows ? `${s.rows.toLocaleString("pt-BR")} estabelecimentos (${s.ufs.join(", ")})` : "não carregada"}
      · Google Maps: ${status.placesConfigured ? "configurado" : "não configurado"}
    </p>
    <div id="tab-body">${
      tab === "cnpj"
        ? cnpjFiltersHtml()
        : tab === "places"
          ? placesHtml()
          : `<div class="panel"><h2>LinkedIn</h2>
              <p>Os termos do LinkedIn proíbem coleta automatizada e mensagens automáticas — o sistema não faz isso, para não arriscar o bloqueio das contas.</p>
              <ol class="roadmap">
                <li>Monte a lista no LinkedIn / Sales Navigator.</li>
                <li>Exporte para planilha (ou copie para uma) e salve como CSV.</li>
                <li>No <a href="#/funil">Funil</a>, use <strong>Importar CSV</strong>: a coluna “LinkedIn” vai para o perfil do contato.</li>
                <li>O primeiro contato pelo LinkedIn é feito manualmente; o agente SDR cuida do e-mail.</li>
              </ol></div>`
    }</div>`;
  refreshIcons();
  container.querySelectorAll("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      state.tab = b.dataset.tab;
      prefs.set("sourcingTab", state.tab);
      draw();
    })
  );
  if (tab === "cnpj") {
    bindCnpj();
    if (state.cnpj.result) drawCnpjResults();
  }
  if (tab === "places") {
    bindPlaces();
    drawPlaces();
  }
}

export async function renderSourcing(container, { user }) {
  container.innerHTML = `<p class="muted">Carregando...</p>`;
  const r = await api("GET", "/sourcing/status");
  if (!r.ok) {
    container.innerHTML = `<p class="form-error">${escapeHtml(errorMessage(r.data))}</p>`;
    return;
  }
  const saved = prefs.get("sourcingTab", "cnpj");
  state = {
    container,
    user,
    status: r.data,
    tab: ["cnpj", "places", "linkedin"].includes(saved) ? saved : "cnpj",
    cnpj: { filters: { notInBase: true, hasEmail: true }, cnaes: [], result: null, selected: new Set() },
    places: { q: "", results: [], selected: new Set(), nextPageToken: null, searched: false },
  };
  draw();
}
