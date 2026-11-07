import { api, escapeHtml, refreshIcons } from "../client.js";

export async function renderDashboard(container, { user }) {
  const firstName = user.name.split(" ")[0];
  const { ok, data } = await api("GET", "/dashboard");
  const s = ok ? data.summary : {};
  const n = (v) => (v === undefined ? "—" : v.toLocaleString("pt-BR"));

  const kpis = [
    { label: "Leads em andamento", value: n(s.open), icon: "kanban", href: "#/funil" },
    { label: "Qualificados", value: n(s.qualified), icon: "badge-check", note: s.qualified_30d !== undefined ? `${n(s.qualified_30d)} nos últimos 30 dias` : "" },
    { label: "Desqualificados", value: n(s.disqualified), icon: "circle-x" },
    { label: "Empresas na base", value: n(s.companies), icon: "building-2", href: "#/leads" },
  ];

  container.innerHTML = `
    <div class="page-head">
      <h1>Olá, ${escapeHtml(firstName)}</h1>
      <p class="muted">Visão geral da prospecção.</p>
    </div>
    <div class="kpi-grid">
      ${kpis
        .map(
          (k) => `<${k.href ? `a href="${k.href}"` : "div"} class="kpi${k.href ? " kpi-link" : ""}">
          <div class="kpi-icon"><i data-lucide="${k.icon}"></i></div>
          <div><div class="kpi-value">${k.value}</div><div class="kpi-label">${k.label}</div>${k.note ? `<div class="kpi-note">${k.note}</div>` : ""}</div>
        </${k.href ? "a" : "div"}>`
        )
        .join("")}
    </div>
    <div class="panel">
      <h2>Próximas etapas</h2>
      <ol class="roadmap">
        <li class="done">Base do sistema, login e gestão de usuários</li>
        <li class="done">Funil em kanban e lista, cadastro e importação de leads</li>
        <li>Agentes SDR com base de conhecimento e aprovação humana</li>
        <li>Captação de leads (CNPJ, Google Places, CSV)</li>
        <li>Cadências automáticas e painel de resultados</li>
      </ol>
    </div>`;
  refreshIcons();
}
