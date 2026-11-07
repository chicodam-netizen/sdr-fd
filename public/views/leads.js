// Base de leads: filtros paginados, seleção em lote (buscar contatos na web / enviar ao funil),
// ficha da empresa com dados cadastrais, resultado da pesquisa web e contatos.
import { api, errorMessage, escapeHtml, formatDate, formatCnpj, formatMoney, refreshIcons, toast, prefs } from "../client.js";
import { openDialog, bindForm, options } from "../ui.js";
import { openSendDialog } from "./sourcing.js";

let state;

const SOURCE_LABEL = { csv: "CSV", receita_cnpj: "Base CNPJ", google_places: "Google Maps", manual: "Manual", planilha: "Planilha", web: "Pesquisa web" };
const SIZE_LABEL = { micro: "Microempresa", pequeno: "Pequeno porte", demais: "Médio/grande porte", nao_informado: "Não informado" };
const CONF_BADGE = { alta: "badge-success", media: "badge-warning", baixa: "badge-muted" };

const isManager = () => ["admin", "gestor"].includes(state.user.role);

function sourceLabel(c) {
  if (c.source === "csv") return `CSV: ${c.sourceDetail || ""}`;
  if (c.source === "google_places" || c.source === "planilha") return c.sourceDetail || SOURCE_LABEL[c.source];
  return SOURCE_LABEL[c.source] || c.source || "Manual";
}

function registrationHtml(c) {
  if (!c.cnpj) return `<p class="muted small">Sem CNPJ: informe o CNPJ acima para consultar os dados cadastrais.</p>`;
  if (!c.enrichedAt) return `<p class="muted small">Dados cadastrais ainda não consultados.</p>`;
  if (c.enrichment?.error) return `<p class="muted small">CNPJ não encontrado na consulta de ${formatDate(c.enrichedAt)}.</p>`;
  const e = c.enrichment || {};
  const inactive = c.registrationStatus && c.registrationStatus !== "ativa";
  return `<dl class="details">
    <dt>Razão social</dt><dd>${escapeHtml(c.legalName || "—")}</dd>
    <dt>Situação</dt><dd>${inactive ? `<span class="badge badge-danger">${escapeHtml(c.registrationStatus)}</span>` : escapeHtml(c.registrationStatus || "—")}</dd>
    <dt>Atividade</dt><dd>${escapeHtml([c.cnaeCode, e.cnaeDescription].filter(Boolean).join(" · ") || "—")}</dd>
    <dt>Porte</dt><dd>${escapeHtml(SIZE_LABEL[c.size] || "—")}</dd>
    <dt>Abertura</dt><dd>${c.openedAt ? formatDate(c.openedAt) : "—"}</dd>
    <dt>Capital social</dt><dd>${e.capital ? formatMoney(e.capital) : "—"}</dd>
    <dt>Tel./e-mail cadastral</dt><dd>${escapeHtml([e.phone, e.email].filter(Boolean).join(" · ") || "—")}</dd>
    <dt>Consulta</dt><dd class="muted small">${e.source === "brasilapi" ? "BrasilAPI" : "Base CNPJ local"} · ${formatDate(c.enrichedAt)}</dd>
  </dl>`;
}

const link = (url, label) => (url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(label || url)}</a>` : "—");
const host = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

function discoveryHtml(c) {
  const d = c.discovery;
  if (!d) return `<p class="muted small">Ainda não pesquisada na web.</p>`;
  const f = d.findings;
  if (!f) return `<p class="muted small">Só a consulta cadastral foi feita (${formatDate(c.discoveredAt)}).</p>`;
  return `
    <p class="small"><span class="badge ${CONF_BADGE[f.confidence] || ""}">confiança ${escapeHtml(f.confidence)}</span>
      <span class="muted">· ${formatDate(c.discoveredAt)} · ${d.usage?.searches || 0} busca(s) · US$ ${Number(d.costUsd || 0).toFixed(3)}</span></p>
    ${f.confidence === "baixa" ? `<div class="notice notice-warning">Confiança baixa: nada foi gravado nos contatos. Confira manualmente.</div>` : ""}
    <dl class="details">
      <dt>Site</dt><dd>${link(f.website, f.website && host(f.website))}</dd>
      <dt>LinkedIn</dt><dd>${link(f.linkedin_company_url, "página da empresa")}</dd>
      <dt>Instagram</dt><dd>${link(f.instagram_url, "perfil")}</dd>
      <dt>Telefones</dt><dd>${f.phones.length ? f.phones.map((p) => `${escapeHtml(p.phone)} <span class="muted small">(${link(p.source_url, "fonte")})</span>`).join("<br>") : "—"}</dd>
      <dt>E-mails</dt><dd>${f.emails.length ? f.emails.map((e) => `${escapeHtml(e.email)} <span class="muted small">(${link(e.source_url, "fonte")})</span>`).join("<br>") : "—"}</dd>
      <dt>Decisores</dt><dd>${f.people.length ? f.people.map((p) => `${escapeHtml(p.name)} — ${escapeHtml(p.role)} <span class="muted small">(${link(p.source_url, host(p.source_url))})</span>`).join("<br>") : "—"}</dd>
    </dl>
    ${f.notes ? `<details class="small"><summary class="muted">Observações da pesquisa</summary><p>${escapeHtml(f.notes)}</p></details>` : ""}`;
}

// ---------- Lista ----------
function filtersHtml() {
  const f = state.filters;
  const cityOpts = state.facets.cities.map((c) => ({ value: c.city, label: `${escapeHtml(c.city)} (${c.n.toLocaleString("pt-BR")})` }));
  const listOpts = state.facets.lists.map((l) => ({ value: l.list, label: `${escapeHtml(l.list)} (${l.n.toLocaleString("pt-BR")})` }));
  return `
    <form id="lead-filters" class="panel form lead-filters" novalidate>
      <div class="search grow"><i data-lucide="search"></i><input name="q" type="search" placeholder="Nome, CNPJ ou atividade" value="${escapeHtml(f.q || "")}" /></div>
      <select name="list" aria-label="Lista">${options(listOpts, f.list || "", { empty: "Todas as listas" })}</select>
      <select name="city" aria-label="Cidade">${options(cityOpts, f.city || "", { empty: "Todas as cidades" })}</select>
      <select name="size" aria-label="Porte">${options([{ value: "micro", label: "Microempresa" }, { value: "pequeno", label: "Pequeno porte" }, { value: "demais", label: "Médio/grande" }], f.size || "", { empty: "Todos os portes" })}</select>
      <label class="inline-num">Func. de <input name="minEmployees" type="number" min="0" value="${escapeHtml(f.minEmployees || "")}" /></label>
      <label class="inline-num">até <input name="maxEmployees" type="number" min="0" value="${escapeHtml(f.maxEmployees || "")}" /></label>
      <select name="contact" aria-label="Contato">${options([{ value: "with", label: "Com e-mail de contato" }, { value: "without", label: "Sem e-mail de contato" }], f.contact || "", { empty: "Contato: todos" })}</select>
      <select name="discovered" aria-label="Pesquisa web">${options([{ value: "yes", label: "Já pesquisadas na web" }, { value: "no", label: "Não pesquisadas" }], f.discovered || "", { empty: "Pesquisa web: todas" })}</select>
      <select name="inPipeline" aria-label="Funil">${options([{ value: "no", label: "Fora do funil" }, { value: "yes", label: "No funil" }], f.inPipeline || "", { empty: "Funil: todas" })}</select>
      <select name="order" aria-label="Ordem">${options([{ value: "priority", label: "Ordem: prioridade" }, { value: "employees", label: "Ordem: nº func." }, { value: "name", label: "Ordem: nome" }, { value: "recent", label: "Ordem: mais recentes" }], f.order || "priority")}</select>
      <button type="submit" class="btn btn-primary btn-sm">Filtrar</button>
      <button type="button" class="btn btn-secondary btn-sm" id="clear-filters">Limpar</button>
    </form>`;
}

function tableHtml() {
  const r = state.result;
  if (!r) return `<p class="muted">Carregando...</p>`;
  if (!r.companies.length) {
    return `<div class="panel empty-state"><i data-lucide="building-2"></i><h2>Nenhuma empresa encontrada</h2>
      <p class="muted">Ajuste os filtros, ou capte leads em <a href="#/captacao">Captação</a> / importe CSV no Funil.</p></div>`;
  }
  const pages = Math.ceil(r.total / r.pageSize);
  const sel = state.selected;
  return `
    <div class="results-head"><span><strong>${r.total.toLocaleString("pt-BR")}</strong> empresa(s) · página ${r.page} de ${pages}</span>
      <span class="pager">
        <button class="btn btn-secondary btn-sm" data-page="${r.page - 1}" ${r.page <= 1 ? "disabled" : ""}>Anterior</button>
        <button class="btn btn-secondary btn-sm" data-page="${r.page + 1}" ${r.page >= pages ? "disabled" : ""}>Próxima</button>
      </span></div>
    <div class="panel panel-flush"><table class="table table-click">
      <thead><tr>${isManager() ? `<th><input type="checkbox" id="sel-page" aria-label="Selecionar página" /></th>` : ""}<th>Empresa</th><th>Cidade</th><th>Atividade</th><th>Func.</th><th>Contatos</th><th>Pesquisa web</th><th>Funil</th></tr></thead>
      <tbody>${r.companies
        .map(
          (c) => `<tr data-id="${c.id}">
            ${isManager() ? `<td><input type="checkbox" class="sel" value="${c.id}"${sel.has(c.id) ? " checked" : ""} /></td>` : ""}
            <td data-label="Empresa"><strong>${escapeHtml(c.name)}</strong>${c.registrationStatus && c.registrationStatus !== "ativa" ? ` <span class="badge badge-danger">${escapeHtml(c.registrationStatus)}</span>` : ""}
              <div class="muted small">${escapeHtml(formatCnpj(c.cnpj))}${c.lists?.includes("Lista de trabalho RMBH") ? ` · <span class="badge">lista de trabalho</span>` : ""}</div></td>
            <td data-label="Cidade">${escapeHtml(c.city || "—")}</td>
            <td data-label="Atividade" class="small">${escapeHtml(c.segment || "—")}</td>
            <td data-label="Func.">${c.employees ?? "—"}</td>
            <td data-label="Contatos">${c.emails ? `<span class="badge badge-success">${c.emails} e-mail${c.emails > 1 ? "s" : ""}</span>` : c.contacts ? `${c.contacts}` : `<span class="muted">—</span>`}</td>
            <td data-label="Pesquisa web">${c.discoveredAt ? (c.confidence ? `<span class="badge ${CONF_BADGE[c.confidence] || ""}">${escapeHtml(c.confidence)}</span>` : `<span class="muted small">cadastral</span>`) : `<span class="muted">—</span>`}</td>
            <td data-label="Funil">${c.deals ? `<span class="badge">no funil</span>` : "—"}</td>
          </tr>`
        )
        .join("")}</tbody></table></div>
    ${
      isManager()
        ? `<div class="selection-bar" id="sel-bar" ${sel.size ? "" : "hidden"}>
            <span><strong>${sel.size}</strong> selecionada(s) <button type="button" class="link-btn" id="sel-clear">limpar</button></span>
            <span class="toolbar-actions">
              <button class="btn btn-secondary btn-sm" id="sel-discover"><i data-lucide="search-check"></i>Buscar contatos na web</button>
              <button class="btn btn-primary btn-sm" id="sel-send"><i data-lucide="send-to-back"></i>Enviar ao funil</button>
            </span>
          </div>`
        : ""
    }`;
}

function drawTable() {
  const box = state.container.querySelector("#companies");
  box.innerHTML = tableHtml();
  refreshIcons();
  const sel = state.selected;
  const updateBar = () => {
    const bar = box.querySelector("#sel-bar");
    if (!bar) return;
    bar.hidden = !sel.size;
    bar.querySelector("strong").textContent = sel.size;
  };
  box.querySelectorAll("[data-page]").forEach((b) => b.addEventListener("click", () => load(Number(b.dataset.page))));
  box.querySelectorAll("tbody tr").forEach((tr) =>
    tr.addEventListener("click", (e) => {
      if (e.target.closest("input")) return;
      openCompany(tr.dataset.id);
    })
  );
  box.querySelectorAll(".sel").forEach((c) =>
    c.addEventListener("change", () => {
      c.checked ? sel.add(c.value) : sel.delete(c.value);
      updateBar();
    })
  );
  box.querySelector("#sel-page")?.addEventListener("change", (e) => {
    box.querySelectorAll(".sel").forEach((c) => {
      c.checked = e.target.checked;
      e.target.checked ? sel.add(c.value) : sel.delete(c.value);
    });
    updateBar();
  });
  box.querySelector("#sel-clear")?.addEventListener("click", () => {
    sel.clear();
    drawTable();
  });
  box.querySelector("#sel-send")?.addEventListener("click", () => {
    if (sel.size > 200) return toast("Envie até 200 empresas por vez.", "warning");
    openSendDialog(sel.size, () => ({ companyIds: [...sel] }), () => {
      sel.clear();
      load(state.result.page);
    }, "/leadbase/to-pipeline");
  });
  box.querySelector("#sel-discover")?.addEventListener("click", (e) => discoverSelected(e.currentTarget));
}

// Pesquisa uma empresa por vez (cada uma leva ~20s), com progresso e custo acumulado.
async function discoverSelected(btn) {
  const ids = [...state.selected];
  const estimate = (ids.length * 0.025).toFixed(2);
  if (!confirm(`Buscar contatos na web para ${ids.length} empresa(s)?\n\nLeva ~20s por empresa e custa cerca de US$ ${estimate} em IA. Mantenha esta página aberta até terminar.`)) return;
  btn.disabled = true;
  let done = 0;
  let cost = 0;
  let withEmail = 0;
  for (const id of ids) {
    btn.textContent = `Pesquisando ${done + 1}/${ids.length}... (US$ ${cost.toFixed(2)})`;
    const r = await api("POST", `/companies/${id}/discover`, {});
    if (!r.ok) {
      toast(errorMessage(r.data), "error");
      if (["ai_not_configured", "ai_rate_limited"].includes(r.data.error)) break;
      continue;
    }
    done++;
    cost += r.data.result.costUsd || 0;
    if (r.data.result.emails || r.data.result.receitaEmail) withEmail++;
    state.selected.delete(id);
  }
  toast(`Pesquisa concluída: ${done} empresa(s), ${withEmail} com e-mail. Custo ~US$ ${cost.toFixed(2)}.`, "success");
  btn.disabled = false;
  load(state.result?.page || 1);
}

async function load(page = 1) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(state.filters)) if (v) qs.set(k, v);
  qs.set("page", page);
  const { ok, data } = await api("GET", `/leadbase?${qs}`);
  if (!ok) toast(errorMessage(data), "error");
  state.result = ok ? data : { companies: [], total: 0, page: 1, pageSize: 50 };
  drawTable();
}

// ---------- Ficha da empresa ----------
function contactForm(ct = {}) {
  return `
    <form class="form form-grid contact-form" novalidate>
      <label>Nome<input name="name" value="${escapeHtml(ct.name || "")}" /></label>
      <label>Cargo<input name="jobTitle" value="${escapeHtml(ct.jobTitle || "")}" /></label>
      <label>E-mail<input type="email" name="email" value="${escapeHtml(ct.email || "")}" /></label>
      <label>Telefone<input name="phone" value="${escapeHtml(ct.phone || "")}" /></label>
      <label class="span-2">LinkedIn<input name="linkedinUrl" value="${escapeHtml(ct.linkedinUrl || "")}" /></label>
      ${ct.id ? `<label class="check span-2"><input type="checkbox" name="optOut"${ct.optOut ? " checked" : ""} /> Não contatar (pediu para sair / opt-out)</label>` : ""}
      <p class="form-error span-2" hidden></p>
      <div class="span-2 form-actions-inline">
        <button type="button" class="btn btn-secondary btn-sm" data-cancel>Cancelar</button>
        <button type="submit" class="btn btn-primary btn-sm">${ct.id ? "Salvar contato" : "Adicionar contato"}</button>
      </div>
    </form>`;
}

function contactPayload(fd, withOptOut) {
  const p = { name: fd.get("name"), jobTitle: fd.get("jobTitle"), email: fd.get("email"), phone: fd.get("phone"), linkedinUrl: fd.get("linkedinUrl") };
  if (withOptOut) p.optOut = fd.get("optOut") === "on";
  return p;
}

function contactSource(ct) {
  if (ct.sourceUrl) return `fonte: ${link(ct.sourceUrl, host(ct.sourceUrl))}`;
  return escapeHtml(SOURCE_LABEL[ct.source] || ct.source || "");
}

async function openCompany(id) {
  const dialog = openDialog(`<div class="drawer-loading muted">Carregando...</div>`, { variant: "drawer", onClose: () => load(state.result?.page || 1) });
  const render = async () => {
    const { ok, data } = await api("GET", `/companies/${id}`);
    if (!ok) {
      dialog.close();
      return toast(errorMessage(data), "error");
    }
    const { company: c, contacts, deals } = data;
    dialog.innerHTML = `
      <header class="drawer-head">
        <div><h2>${escapeHtml(c.name)}</h2><p class="muted">${escapeHtml([c.city, c.employees ? `${c.employees} funcionários` : null].filter(Boolean).join(" · "))} · origem: ${escapeHtml(sourceLabel(c))}</p></div>
        <button class="icon-btn" data-close aria-label="Fechar"><i data-lucide="x"></i></button>
      </header>
      <div class="drawer-body">
        <section class="drawer-section">
          <div class="section-head"><h3>Pesquisa na web</h3>${isManager() ? `<button class="btn btn-secondary btn-sm" id="discover-btn"><i data-lucide="search-check"></i>${c.discoveredAt ? "Pesquisar de novo" : "Buscar contatos"}</button>` : ""}</div>
          ${discoveryHtml(c)}
        </section>
        <section class="drawer-section">
          <div class="section-head"><h3>Contatos</h3><button class="btn btn-secondary btn-sm" id="add-contact"><i data-lucide="user-plus"></i>Novo contato</button></div>
          <div id="new-contact"></div>
          ${
            contacts.length
              ? `<ul class="contact-list">${contacts
                  .map(
                    (ct) => `<li data-id="${ct.id}">
                      <div class="contact-line">
                        <div><strong>${escapeHtml(ct.name)}</strong>${ct.kind === "generic" ? ` <span class="badge badge-muted">canal da empresa</span>` : ""}${ct.optOut ? ` <span class="badge badge-danger">Não contatar</span>` : ""}
                          <div class="muted small">${escapeHtml([ct.jobTitle, ct.email, ct.phone].filter(Boolean).join(" · ") || "sem e-mail/telefone")}</div>
                          <div class="muted small">${contactSource(ct)}${ct.linkedinUrl ? ` · ${link(ct.linkedinUrl, "LinkedIn")}` : ""}</div></div>
                        <button class="icon-btn edit-contact" title="Editar"><i data-lucide="pencil"></i></button>
                      </div>
                      <div class="contact-edit"></div>
                    </li>`
                  )
                  .join("")}</ul>`
              : `<p class="muted">Nenhum contato.</p>`
          }
        </section>
        <section class="drawer-section">
          <h3>Cards no funil</h3>
          ${
            deals.length
              ? `<ul class="plain-list">${deals.map((d) => `<li><span class="dot" style="background:${escapeHtml(d.stageColor)}"></span>${escapeHtml(d.pipelineName)} · <strong>${escapeHtml(d.stageName)}</strong></li>`).join("")}</ul>`
              : `<p class="muted">Esta empresa não está em nenhum funil.</p>`
          }
        </section>
        <section class="drawer-section">
          <div class="section-head"><h3>Dados cadastrais (Receita)</h3>${c.cnpj ? `<button class="btn btn-secondary btn-sm" id="enrich-btn"><i data-lucide="refresh-cw"></i>${c.enrichedAt ? "Atualizar" : "Consultar CNPJ"}</button>` : ""}</div>
          ${registrationHtml(c)}
        </section>
        <section class="drawer-section">
          <h3>Empresa</h3>
          <form id="company-form" class="form form-grid" novalidate>
            <label class="span-2">Nome *<input name="name" value="${escapeHtml(c.name)}" required /></label>
            <label>CNPJ<input name="cnpj" value="${escapeHtml(formatCnpj(c.cnpj))}" /></label>
            <label>Segmento<input name="segment" value="${escapeHtml(c.segment || "")}" /></label>
            <label>Cidade<input name="city" value="${escapeHtml(c.city || "")}" /></label>
            <label>UF<input name="uf" maxlength="2" value="${escapeHtml(c.uf || "")}" /></label>
            <label>Site<input name="website" value="${escapeHtml(c.website || "")}" /></label>
            <label>Telefone<input name="phone" value="${escapeHtml(c.phone || "")}" /></label>
            <label class="span-2">LinkedIn da empresa<input name="linkedinUrl" value="${escapeHtml(c.linkedinUrl || "")}" /></label>
            <label class="span-2">Observações<textarea name="notes" rows="3">${escapeHtml(c.notes || "")}</textarea></label>
            <p class="form-error span-2" hidden></p>
            <div class="span-2"><button type="submit" class="btn btn-secondary btn-sm">Salvar empresa</button></div>
          </form>
        </section>
      </div>`;
    refreshIcons();
    dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());

    dialog.querySelector("#discover-btn")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = "Pesquisando na web... (~20s)";
      const r = await api("POST", `/companies/${id}/discover`, {});
      if (!r.ok) {
        btn.disabled = false;
        return toast(errorMessage(r.data), "error");
      }
      const x = r.data.result;
      toast(`Pesquisa concluída: ${x.contactsCreated} contato(s) novo(s), confiança ${x.confidence || "—"} (US$ ${x.costUsd.toFixed(3)}).`, "success");
      render();
    });

    bindForm(dialog.querySelector("#company-form"), async (fd) => {
      const payload = Object.fromEntries(["name", "cnpj", "segment", "city", "uf", "website", "phone", "linkedinUrl", "notes"].map((k) => [k, fd.get(k)]));
      const r = await api("PATCH", `/companies/${id}`, payload);
      if (!r.ok) return errorMessage(r.data);
      toast("Empresa salva.", "success");
      return null;
    });

    dialog.querySelector("#enrich-btn")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const r = await api("POST", `/companies/${id}/enrich`, {});
      if (!r.ok) {
        btn.disabled = false;
        return toast(errorMessage(r.data), "error");
      }
      toast("Dados cadastrais atualizados.", "success");
      render();
    });

    dialog.querySelector("#add-contact").addEventListener("click", () => {
      const holder = dialog.querySelector("#new-contact");
      holder.innerHTML = contactForm();
      holder.querySelector("[data-cancel]").addEventListener("click", () => (holder.innerHTML = ""));
      bindForm(holder.querySelector("form"), async (fd) => {
        const r = await api("POST", `/companies/${id}/contacts`, contactPayload(fd, false));
        if (!r.ok) return errorMessage(r.data);
        toast("Contato adicionado.", "success");
        render();
        return null;
      });
    });

    dialog.querySelectorAll(".edit-contact").forEach((btn) =>
      btn.addEventListener("click", () => {
        const li = btn.closest("li");
        const ct = contacts.find((x) => x.id === li.dataset.id);
        const holder = li.querySelector(".contact-edit");
        holder.innerHTML = contactForm(ct);
        holder.querySelector("[data-cancel]").addEventListener("click", () => (holder.innerHTML = ""));
        bindForm(holder.querySelector("form"), async (fd) => {
          const r = await api("PATCH", `/contacts/${ct.id}`, contactPayload(fd, true));
          if (!r.ok) return errorMessage(r.data);
          toast("Contato salvo.", "success");
          render();
          return null;
        });
      })
    );
  };
  await render();
}

// ---------- Página ----------
export async function renderLeads(container, { query, user }) {
  let saved = {};
  try {
    saved = JSON.parse(prefs.get("leadFilters", "{}")) || {};
  } catch {
    saved = {};
  }
  state = { container, user, filters: { order: "priority", ...saved }, facets: { cities: [], lists: [] }, result: null, selected: new Set() };
  const f = await api("GET", "/leadbase/facets");
  if (f.ok) state.facets = f.data;

  container.innerHTML = `
    <div class="page-head page-head-row">
      <div><h1>Leads</h1><p class="muted">Base de empresas. Filtre, pesquise contatos na web e envie ao funil quando estiver pronta para abordagem.</p></div>
      <a class="btn btn-secondary" href="#/captacao"><i data-lucide="radar"></i>Captar mais leads</a>
    </div>
    ${filtersHtml()}
    <div id="companies"><p class="muted">Carregando...</p></div>`;
  refreshIcons();

  const form = container.querySelector("#lead-filters");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    state.filters = Object.fromEntries([...new FormData(form).entries()].filter(([, v]) => v !== ""));
    prefs.set("leadFilters", JSON.stringify(state.filters));
    state.selected.clear();
    load(1);
  });
  form.querySelectorAll("select").forEach((s) => s.addEventListener("change", () => form.requestSubmit()));
  container.querySelector("#clear-filters").addEventListener("click", () => {
    state.filters = { order: "priority" };
    prefs.set("leadFilters", "{}");
    renderLeads(container, { query: new URLSearchParams(), user });
  });

  await load(1);
  const open = query.get("empresa");
  if (open) openCompany(open);
}
