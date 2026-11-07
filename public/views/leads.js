// Base de leads: empresas e seus contatos (edição, novo contato, opt-out).
import { api, errorMessage, escapeHtml, formatDate, formatCnpj, formatMoney, refreshIcons, toast } from "../client.js";
import { openDialog, bindForm } from "../ui.js";

let state;

const SOURCE_LABEL = { csv: "CSV", receita_cnpj: "Base CNPJ", google_places: "Google Maps", manual: "Manual" };
const SIZE_LABEL = { micro: "Microempresa", pequeno: "Pequeno porte", demais: "Médio/grande porte", nao_informado: "Não informado" };

function sourceLabel(c) {
  if (c.source === "csv") return `CSV: ${c.sourceDetail || ""}`;
  if (c.source === "google_places") return c.sourceDetail || "Google Maps";
  return SOURCE_LABEL[c.source] || c.source || "Manual";
}

function registrationHtml(c) {
  if (!c.cnpj) return `<p class="muted small">Sem CNPJ: informe o CNPJ acima para enriquecer os dados cadastrais.</p>`;
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
    <dt>Consulta</dt><dd class="muted small">${e.source === "brasilapi" ? "BrasilAPI" : "Base CNPJ local"} · ${formatDate(c.enrichedAt)}</dd>
  </dl>`;
}

function tableHtml() {
  if (!state.companies.length) {
    return `<div class="panel empty-state"><i data-lucide="building-2"></i><h2>Nenhuma empresa${state.q ? " encontrada" : " ainda"}</h2>
      <p class="muted">Cadastre leads pelo Funil (Novo lead ou Importar CSV).</p></div>`;
  }
  return `<div class="panel panel-flush"><table class="table table-click">
    <thead><tr><th>Empresa</th><th>CNPJ</th><th>Cidade/UF</th><th>Segmento</th><th>Contatos</th><th>Cards</th><th>Origem</th><th>Cadastro</th></tr></thead>
    <tbody>${state.companies
      .map(
        (c) => `<tr data-id="${c.id}">
          <td data-label="Empresa"><strong>${escapeHtml(c.name)}</strong>${c.registrationStatus && c.registrationStatus !== "ativa" ? ` <span class="badge badge-danger">${escapeHtml(c.registrationStatus)}</span>` : ""}</td>
          <td data-label="CNPJ">${escapeHtml(formatCnpj(c.cnpj)) || "—"}</td>
          <td data-label="Cidade/UF">${escapeHtml([c.city, c.uf].filter(Boolean).join("/")) || "—"}</td>
          <td data-label="Segmento">${escapeHtml(c.segment || "—")}</td>
          <td data-label="Contatos">${c.contacts}</td>
          <td data-label="Cards">${c.deals}</td>
          <td data-label="Origem" class="muted small">${escapeHtml(sourceLabel(c))}</td>
          <td data-label="Cadastro">${formatDate(c.createdAt)}</td>
        </tr>`
      )
      .join("")}</tbody></table></div>`;
}

function drawTable() {
  state.container.querySelector("#companies").innerHTML = tableHtml();
  refreshIcons();
  state.container.querySelectorAll("tbody tr").forEach((tr) => tr.addEventListener("click", () => openCompany(tr.dataset.id)));
}

async function load() {
  const qs = state.q ? `?q=${encodeURIComponent(state.q)}` : "";
  const { ok, data } = await api("GET", `/companies${qs}`);
  state.companies = ok ? data.companies : [];
  if (!ok) toast(errorMessage(data), "error");
  drawTable();
}

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

async function openCompany(id) {
  const dialog = openDialog(`<div class="drawer-loading muted">Carregando...</div>`, { variant: "drawer", onClose: load });
  const render = async () => {
    const { ok, data } = await api("GET", `/companies/${id}`);
    if (!ok) {
      dialog.close();
      return toast(errorMessage(data), "error");
    }
    const { company: c, contacts, deals } = data;
    dialog.innerHTML = `
      <header class="drawer-head">
        <div><h2>${escapeHtml(c.name)}</h2><p class="muted">Origem: ${escapeHtml(sourceLabel(c))} · cadastrada em ${formatDate(c.createdAt)}</p></div>
        <button class="icon-btn" data-close aria-label="Fechar"><i data-lucide="x"></i></button>
      </header>
      <div class="drawer-body">
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
        <section class="drawer-section">
          <div class="section-head"><h3>Dados cadastrais (Receita)</h3>${c.cnpj ? `<button class="btn btn-secondary btn-sm" id="enrich-btn"><i data-lucide="refresh-cw"></i>${c.enrichedAt ? "Atualizar" : "Consultar CNPJ"}</button>` : ""}</div>
          ${registrationHtml(c)}
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
                        <div><strong>${escapeHtml(ct.name)}</strong>${ct.optOut ? ` <span class="badge badge-danger">Não contatar</span>` : ""}
                          <div class="muted small">${escapeHtml([ct.jobTitle, ct.email, ct.phone].filter(Boolean).join(" · ") || "sem dados de contato")}</div></div>
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
              ? `<ul class="plain-list">${deals
                  .map((d) => `<li><span class="dot" style="background:${escapeHtml(d.stageColor)}"></span>${escapeHtml(d.pipelineName)} · <strong>${escapeHtml(d.stageName)}</strong></li>`)
                  .join("")}</ul>`
              : `<p class="muted">Esta empresa não está em nenhum funil.</p>`
          }
        </section>
      </div>`;
    refreshIcons();
    dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());

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

async function enrichPending(btn) {
  btn.disabled = true;
  let total = 0;
  for (;;) {
    btn.textContent = `Consultando CNPJs... ${total}`;
    const r = await api("POST", "/companies/enrich-pending", {});
    if (!r.ok) {
      toast(errorMessage(r.data), "error");
      break;
    }
    total += r.data.done;
    const blocked = !r.data.done && r.data.errors.some((e) => e.error !== "cnpj_not_found");
    if (!r.data.remaining || blocked) {
      if (r.data.remaining) toast(`Consulta pausada (limite ou indisponibilidade da BrasilAPI). Faltam ${r.data.remaining}.`, "warning");
      break;
    }
  }
  toast(`${total} empresa(s) enriquecida(s).`, "success");
  btn.disabled = false;
  btn.innerHTML = `<i data-lucide="refresh-cw"></i>Enriquecer pendentes`;
  refreshIcons();
  load();
}

export async function renderLeads(container, { query, user }) {
  state = { container, companies: [], q: "" };
  container.innerHTML = `
    <div class="page-head"><h1>Leads</h1><p class="muted">Base de empresas e contatos. Para colocar no funil, use "Novo lead" ou "Importar CSV" no Funil.</p></div>
    <div class="toolbar"><div class="search"><i data-lucide="search"></i><input id="company-search" type="search" placeholder="Buscar por nome, CNPJ, cidade, segmento..." /></div>
      <a class="btn btn-secondary" href="#/captacao"><i data-lucide="radar"></i>Captar leads</a>
      ${["admin", "gestor"].includes(user.role) ? `<button class="btn btn-secondary" id="enrich-pending" title="Consulta na Receita as empresas com CNPJ ainda não consultadas"><i data-lucide="refresh-cw"></i>Enriquecer pendentes</button>` : ""}</div>
    <div id="companies"><p class="muted">Carregando...</p></div>`;
  refreshIcons();
  let timer;
  container.querySelector("#company-search").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.q = e.target.value.trim();
      load();
    }, 250);
  });
  container.querySelector("#enrich-pending")?.addEventListener("click", (e) => enrichPending(e.currentTarget));
  await load();
  const open = query.get("empresa");
  if (open) openCompany(open);
}
