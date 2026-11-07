import { escapeHtml } from "../client.js";

const KPIS = [
  { label: "Leads no funil", icon: "building-2" },
  { label: "Em qualificação", icon: "messages-square" },
  { label: "Qualificados", icon: "badge-check" },
  { label: "Agentes ativos", icon: "bot" },
];

export function renderDashboard(container, { user }) {
  const firstName = user.name.split(" ")[0];
  container.innerHTML = `
    <div class="page-head">
      <h1>Olá, ${escapeHtml(firstName)}</h1>
      <p class="muted">Visão geral da prospecção.</p>
    </div>
    <div class="kpi-grid">
      ${KPIS.map(
        (k) => `<div class="kpi">
          <div class="kpi-icon"><i data-lucide="${k.icon}"></i></div>
          <div><div class="kpi-value">—</div><div class="kpi-label">${k.label}</div></div>
        </div>`
      ).join("")}
    </div>
    <div class="panel">
      <h2>Próximas etapas</h2>
      <p class="muted">Os indicadores serão preenchidos conforme o funil e os agentes forem ativados.</p>
      <ol class="roadmap">
        <li class="done">Base do sistema, login e gestão de usuários</li>
        <li>Funil em kanban e lista, cadastro e importação de leads</li>
        <li>Agentes SDR com base de conhecimento e aprovação humana</li>
        <li>Captação de leads (CNPJ, Google Places, CSV)</li>
        <li>Cadências automáticas e painel de resultados</li>
      </ol>
    </div>`;
}
