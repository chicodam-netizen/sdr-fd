// ==========================================================================
// SDR FD — roteador por hash + casca da aplicação (menu lateral, topo)
// ==========================================================================
import { api, escapeHtml, refreshIcons, toast, ROLE_LABELS } from "./client.js";
import { renderLogin, renderForgotPassword, renderResetPassword } from "./views/auth.js";
import { renderChangePassword } from "./views/change-password.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderPipeline } from "./views/pipeline.js";
import { renderPipelineConfig } from "./views/pipeline-config.js";
import { renderLeads } from "./views/leads.js";
import { renderAgents, renderAgentEdit } from "./views/agents.js";
import { renderApprovals } from "./views/approvals.js";
import { renderUsers } from "./views/users.js";
import { renderProfile } from "./views/profile.js";
import { renderNotFound } from "./views/notfound.js";

const routes = {
  "/login": { render: renderLogin, public: true },
  "/esqueci-senha": { render: renderForgotPassword, public: true },
  "/redefinir-senha": { render: renderResetPassword, public: true },
  "/trocar-senha": { render: renderChangePassword, bare: true },
  "/": { render: renderDashboard, label: "Início", icon: "layout-dashboard" },
  "/funil": { render: renderPipeline, label: "Funil", icon: "kanban" },
  "/funil/configurar": { render: renderPipelineConfig, roles: ["admin", "gestor"], nav: "/funil" },
  "/leads": { render: renderLeads, label: "Leads", icon: "building-2" },
  "/aprovacoes": { render: renderApprovals, label: "Aprovações", icon: "mail-check" },
  "/agentes": { render: renderAgents, label: "Agentes SDR", icon: "bot" },
  "/agentes/editar": { render: renderAgentEdit, nav: "/agentes" },
  "/usuarios": { render: renderUsers, label: "Usuários", icon: "users", roles: ["admin", "gestor"] },
  "/perfil": { render: renderProfile },
};

const NAV = ["/", "/funil", "/aprovacoes", "/leads", "/agentes", "/usuarios"];

const session = { user: null };

export function getUser() {
  return session.user;
}

export async function refreshUser() {
  const { ok, data } = await api("GET", "/auth/me");
  session.user = ok ? data.user : null;
  return session.user;
}

export function navigate(path) {
  if (window.location.hash === `#${path}`) render();
  else window.location.hash = path;
}

function parseHash() {
  const raw = window.location.hash.replace(/^#/, "") || "/";
  const [path, qs] = raw.split("?");
  return { path: path || "/", query: new URLSearchParams(qs || "") };
}

function shellHtml(user, activePath) {
  const links = NAV.filter((p) => !routes[p].roles || routes[p].roles.includes(user.role))
    .map((p) => {
      const r = routes[p];
      return `<a href="#${p}" class="nav-item${p === activePath ? " active" : ""}">
        <i data-lucide="${r.icon}"></i><span>${r.label}</span></a>`;
    })
    .join("");

  return `
    <div class="shell">
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-brand">
          <img src="assets/logo-header.png" alt="" />
          <div><strong>SDR FD</strong><small>${escapeHtml(user.organization.name)}</small></div>
        </div>
        <nav class="sidebar-nav">${links}</nav>
      </aside>
      <div class="main">
        <header class="topbar">
          <button class="icon-btn menu-toggle" id="menu-toggle" aria-label="Abrir menu"><i data-lucide="menu"></i></button>
          <div class="topbar-spacer"></div>
          <a href="#/perfil" class="topbar-user">
            <span class="avatar">${escapeHtml(user.name.charAt(0).toUpperCase())}</span>
            <span class="topbar-user-text"><strong>${escapeHtml(user.name)}</strong><small>${ROLE_LABELS[user.role]}</small></span>
          </a>
          <button class="icon-btn" id="logout-btn" title="Sair" aria-label="Sair"><i data-lucide="log-out"></i></button>
        </header>
        <main class="content" id="view"></main>
      </div>
    </div>`;
}

async function render() {
  const root = document.getElementById("root");
  const { path, query } = parseHash();
  const route = routes[path];
  const user = session.user;

  if (route?.public) {
    if (user && path === "/login") return navigate("/");
    root.innerHTML = `<div class="auth-page" id="view"></div>`;
    route.render(document.getElementById("view"), { query });
    refreshIcons();
    return;
  }

  if (!user) return navigate("/login");
  if (user.mustChangePassword && path !== "/trocar-senha") return navigate("/trocar-senha");

  if (route?.bare) {
    root.innerHTML = `<div class="auth-page" id="view"></div>`;
    route.render(document.getElementById("view"), { query, user });
    refreshIcons();
    return;
  }

  root.innerHTML = shellHtml(user, route?.nav || path);
  const view = document.getElementById("view");

  if (!route) renderNotFound(view);
  else if (route.roles && !route.roles.includes(user.role)) renderNotFound(view, true);
  else route.render(view, { query, user });

  document.getElementById("menu-toggle").addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("open");
  });
  document.getElementById("logout-btn").addEventListener("click", async () => {
    await api("POST", "/auth/logout", {});
    session.user = null;
    toast("Sessão encerrada.");
    navigate("/login");
  });
  refreshIcons();
}

window.addEventListener("hashchange", render);
refreshUser().then(render);
