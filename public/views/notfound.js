export function renderNotFound(container, forbidden = false) {
  container.innerHTML = `
    <div class="panel empty-state">
      <i data-lucide="${forbidden ? "lock" : "compass"}"></i>
      <h2>${forbidden ? "Acesso restrito" : "Página não encontrada"}</h2>
      <p class="muted">${forbidden ? "Seu perfil não tem acesso a esta área." : "O endereço acessado não existe."}</p>
      <a href="#/" class="btn btn-secondary">Voltar ao início</a>
    </div>`;
}
