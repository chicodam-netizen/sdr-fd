// Painel de resultados: funil de conversão, etapas, agentes, atividade diária e tipos de resposta.
// Cores das séries validadas (dataviz) contra o fundo escuro: enviados #00a57c, recebidos #8b5cf6.
import { api, errorMessage, escapeHtml, formatMoney, refreshIcons, prefs } from "../client.js";
import { options } from "../ui.js";
import { CATEGORY_LABELS } from "./conversation.js";

const AUTONOMY_LABEL = { draft: "Rascunho", semi: "Semiautônomo", auto: "Autônomo" };
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const fmtDay = (iso) => {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
};

// Barras horizontais de uma série (rótulo à esquerda, valor direto à direita, dica ao passar o mouse).
function hbars(items, { color = "var(--series-1)" } = {}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return `<div class="hbars" role="list">${items
    .map(
      (i) => `<div class="hbar" role="listitem" title="${escapeHtml(i.tip || `${i.label}: ${i.value}`)}">
        <span class="hbar-label">${escapeHtml(i.label)}</span>
        <span class="hbar-track"><span class="hbar-fill" style="width:${Math.max(i.value ? 2 : 0, (i.value / max) * 100)}%;background:${i.color || color}"></span></span>
        <span class="hbar-value">${i.display ?? i.value.toLocaleString("pt-BR")}</span>
      </div>`
    )
    .join("")}</div>`;
}

// Colunas diárias com duas séries lado a lado; legenda sempre visível e tabela alternativa.
function dailyChart(daily) {
  const max = Math.max(1, ...daily.map((d) => Math.max(d.sent, d.received)));
  const every = daily.length > 31 ? 7 : daily.length > 14 ? 3 : 1;
  return `
    <div class="legend"><span><i class="swatch" style="background:var(--series-1)"></i>Enviados</span><span><i class="swatch" style="background:var(--series-2)"></i>Respostas recebidas</span></div>
    <div class="vbars" role="img" aria-label="E-mails enviados e respostas recebidas por dia">
      ${daily
        .map(
          (d, i) => `<div class="vbar-group" title="${fmtDay(d.day)}: ${d.sent} enviado(s), ${d.received} resposta(s)">
            <div class="vbar-pair">
              <span class="vbar" style="height:${(d.sent / max) * 100}%;background:var(--series-1)"></span>
              <span class="vbar" style="height:${(d.received / max) * 100}%;background:var(--series-2)"></span>
            </div>
            <span class="vbar-x">${i % every === 0 || i === daily.length - 1 ? fmtDay(d.day) : ""}</span>
          </div>`
        )
        .join("")}
    </div>
    <details class="table-view"><summary>Ver como tabela</summary>
      <table class="table"><thead><tr><th>Dia</th><th>Enviados</th><th>Respostas</th></tr></thead>
      <tbody>${daily.filter((d) => d.sent || d.received).map((d) => `<tr><td>${fmtDay(d.day)}</td><td>${d.sent}</td><td>${d.received}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">Sem atividade no período.</td></tr>`}</tbody></table>
    </details>`;
}

function render(container, r, pipelines, state) {
  const f = r.funnel;
  const totalSent = r.daily.reduce((s, d) => s + d.sent, 0);
  const totalRecv = r.daily.reduce((s, d) => s + d.received, 0);
  const c = r.cadences || {};
  container.innerHTML = `
    <div class="page-head page-head-row">
      <div><h1>Resultados</h1><p class="muted">Prospecção dos últimos ${r.days} dias.</p></div>
      <div class="toolbar-actions">
        ${pipelines.length > 1 ? `<select id="rep-pipeline">${options(pipelines.map((p) => ({ value: p.id, label: escapeHtml(p.name) })), r.pipelineId)}</select>` : ""}
        <div class="segmented" role="group" aria-label="Período">${[7, 30, 90]
          .map((d) => `<button data-days="${d}" class="${r.days === d ? "active" : ""}">${d} dias</button>`)
          .join("")}</div>
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-icon"><i data-lucide="send"></i></div><div><div class="kpi-value">${totalSent.toLocaleString("pt-BR")}</div><div class="kpi-label">E-mails enviados</div></div></div>
      <div class="kpi"><div class="kpi-icon"><i data-lucide="mail-open"></i></div><div><div class="kpi-value">${totalRecv.toLocaleString("pt-BR")}</div><div class="kpi-label">Respostas recebidas</div></div></div>
      <div class="kpi"><div class="kpi-icon"><i data-lucide="percent"></i></div><div><div class="kpi-value">${pct(f.replied, f.contacted)}</div><div class="kpi-label">Taxa de resposta (cards)</div></div></div>
      <div class="kpi"><div class="kpi-icon"><i data-lucide="badge-check"></i></div><div><div class="kpi-value">${pct(f.qualified, f.contacted)}</div><div class="kpi-label">Contatados → qualificados</div></div></div>
    </div>

    <div class="grid-2">
      <section class="panel">
        <h2>Funil de conversão</h2>
        <p class="muted small">Cards criados no período e até onde chegaram.</p>
        ${hbars([
          { label: "Criados", value: f.created },
          { label: "Contatados", value: f.contacted, display: `${f.contacted} · ${pct(f.contacted, f.created)}` },
          { label: "Responderam", value: f.replied, display: `${f.replied} · ${pct(f.replied, f.contacted)}` },
          { label: "Qualificados", value: f.qualified, display: `${f.qualified} · ${pct(f.qualified, f.contacted)}` },
        ])}
        <p class="muted small mt">Desqualificados no período: ${f.disqualified}</p>
      </section>
      <section class="panel">
        <h2>Cards por etapa (agora)</h2>
        <p class="muted small">Cor de cada etapa; ao passar o mouse, valor e tempo médio na etapa.</p>
        ${hbars(r.stages.map((s) => ({ label: s.name, value: s.deals, color: s.color, tip: `${s.name}: ${s.deals} card(s) · ${formatMoney(s.value) || "R$ 0,00"} · média de ${s.avgDays} dia(s) na etapa` })))}
      </section>
    </div>

    <section class="panel">
      <h2>Atividade diária</h2>
      ${dailyChart(r.daily)}
    </section>

    <div class="grid-2">
      <section class="panel panel-flush">
        <h2 class="panel-title">Agentes SDR</h2>
        <table class="table">
          <thead><tr><th>Agente</th><th>Modo</th><th>Enviados</th><th>Resposta</th><th>Qualificados</th><th>Na fila</th><th>Em cadência</th></tr></thead>
          <tbody>${
            r.agents.length
              ? r.agents
                  .map(
                    (a) => `<tr>
                <td data-label="Agente"><strong>${escapeHtml(a.name)}</strong>${a.active ? "" : ` <span class="badge badge-muted">inativo</span>`}</td>
                <td data-label="Modo">${AUTONOMY_LABEL[a.autonomy]}</td>
                <td data-label="Enviados">${a.sent}${a.autoSent ? ` <span class="muted small">(${a.autoSent} auto)</span>` : ""}</td>
                <td data-label="Resposta">${a.replyRate === null ? "—" : `${a.replyRate}%`}</td>
                <td data-label="Qualificados">${a.qualified}</td>
                <td data-label="Na fila">${a.pending}</td>
                <td data-label="Em cadência">${a.inCadence}</td>
              </tr>`
                  )
                  .join("")
              : `<tr><td colspan="7" class="muted">Nenhum agente.</td></tr>`
          }</tbody>
        </table>
      </section>
      <section class="panel">
        <h2>Tipos de resposta</h2>
        ${r.categories.length ? hbars(r.categories.map((x) => ({ label: CATEGORY_LABELS[x.category] || x.category, value: x.n }))) : `<p class="muted">Nenhuma resposta classificada no período.</p>`}
        <h2 class="mt">Cadências</h2>
        <dl class="details">
          <dt>Em andamento</dt><dd>${(c.active || 0) + (c.waiting_approval || 0)} <span class="muted small">(${c.waiting_approval || 0} aguardando aprovação)</span></dd>
          <dt>Pausadas</dt><dd>${c.paused || 0}</dd>
          <dt>Lead respondeu</dt><dd>${c.replied || 0}</dd>
          <dt>Concluídas</dt><dd>${c.finished || 0}</dd>
          <dt>Interrompidas</dt><dd>${c.stopped || 0}</dd>
        </dl>
      </section>
    </div>`;
  refreshIcons();
  container.querySelectorAll("[data-days]").forEach((b) =>
    b.addEventListener("click", () => {
      state.days = Number(b.dataset.days);
      prefs.set("reportDays", String(state.days));
      load(container, state);
    })
  );
  container.querySelector("#rep-pipeline")?.addEventListener("change", (e) => {
    state.pipelineId = e.target.value;
    load(container, state);
  });
}

async function load(container, state) {
  const qs = new URLSearchParams({ days: state.days });
  if (state.pipelineId) qs.set("pipelineId", state.pipelineId);
  const [r, p] = await Promise.all([api("GET", `/reports?${qs}`), api("GET", "/pipelines")]);
  if (!r.ok) {
    container.innerHTML = `<p class="form-error">${escapeHtml(errorMessage(r.data))}</p>`;
    return;
  }
  render(container, r.data, p.ok ? p.data.pipelines : [], state);
}

export async function renderReports(container) {
  container.innerHTML = `<p class="muted">Carregando...</p>`;
  const days = Number(prefs.get("reportDays", "30"));
  await load(container, { days: [7, 30, 90].includes(days) ? days : 30, pipelineId: null });
}
