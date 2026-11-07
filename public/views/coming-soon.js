export function renderComingSoon(container, title, description, phase) {
  container.innerHTML = `
    <div class="page-head"><h1>${title}</h1></div>
    <div class="panel empty-state">
      <i data-lucide="construction"></i>
      <h2>Em construção</h2>
      <p class="muted">${description}</p>
      <span class="badge">Fase ${phase}</span>
    </div>`;
}
