// Templates recebem dados já formatados; sempre com versão texto + HTML.

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function layout(title, paragraphsHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif;color:#1d2733">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden">
      <tr><td style="background:#0c1a2e;padding:20px 28px;color:#ffffff;font-size:18px;font-weight:bold">SDR FD Consultoria</td></tr>
      <tr><td style="padding:28px">
        <h2 style="margin:0 0 16px;font-size:20px;color:#0c1a2e">${escapeHtml(title)}</h2>
        ${paragraphsHtml}
      </td></tr>
      <tr><td style="padding:16px 28px;background:#f4f6f9;color:#6b7785;font-size:12px">Mensagem automática - não responda este e-mail.</td></tr>
    </table>
  </td></tr></table></body></html>`;
}

function p(text) {
  return `<p style="margin:0 0 14px;line-height:1.5">${text}</p>`;
}

function button(url, label) {
  return `<p style="margin:20px 0"><a href="${escapeHtml(url)}" style="background:#00a57c;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold">${escapeHtml(label)}</a></p>`;
}

function code(value) {
  return `<span style="font-family:Consolas,monospace;font-size:16px;background:#eef2f6;padding:4px 8px;border-radius:4px">${escapeHtml(value)}</span>`;
}

function inviteEmail({ to, name, orgName, tempPassword, appUrl }) {
  const subject = "Seu acesso ao SDR FD Consultoria";
  const text = [
    `Olá, ${name}!`,
    "",
    `Você foi convidado(a) para acessar o SDR FD Consultoria (${orgName}).`,
    "",
    `Endereço: ${appUrl}`,
    `Login: ${to}`,
    `Senha temporária: ${tempPassword}`,
    "",
    "No primeiro acesso será solicitada a troca da senha.",
  ].join("\n");
  const html = layout("Seu acesso foi criado", [
    p(`Olá, ${escapeHtml(name)}!`),
    p(`Você foi convidado(a) para acessar o SDR FD Consultoria (${escapeHtml(orgName)}).`),
    p(`Login: <strong>${escapeHtml(to)}</strong><br>Senha temporária: ${code(tempPassword)}`),
    button(appUrl, "Acessar o sistema"),
    p("No primeiro acesso será solicitada a troca da senha."),
  ].join(""));
  return { to, subject, text, html };
}

function tempPasswordEmail({ to, name, tempPassword, appUrl }) {
  const subject = "Sua senha do SDR FD Consultoria foi redefinida";
  const text = [
    `Olá, ${name}!`,
    "",
    "Um administrador redefiniu sua senha.",
    `Senha temporária: ${tempPassword}`,
    `Acesse: ${appUrl}`,
    "",
    "No próximo acesso será solicitada a troca da senha.",
  ].join("\n");
  const html = layout("Senha redefinida", [
    p(`Olá, ${escapeHtml(name)}!`),
    p("Um administrador redefiniu sua senha."),
    p(`Senha temporária: ${code(tempPassword)}`),
    button(appUrl, "Acessar o sistema"),
    p("No próximo acesso será solicitada a troca da senha."),
  ].join(""));
  return { to, subject, text, html };
}

function resetLinkEmail({ to, name, resetUrl }) {
  const subject = "Redefinição de senha - SDR FD Consultoria";
  const text = [
    `Olá, ${name}!`,
    "",
    "Recebemos um pedido para redefinir sua senha. Use o link abaixo (válido por 1 hora):",
    resetUrl,
    "",
    "Se não foi você, ignore este e-mail - sua senha continua a mesma.",
  ].join("\n");
  const html = layout("Redefinição de senha", [
    p(`Olá, ${escapeHtml(name)}!`),
    p("Recebemos um pedido para redefinir sua senha. O link é válido por 1 hora."),
    button(resetUrl, "Criar nova senha"),
    p("Se não foi você, ignore este e-mail - sua senha continua a mesma."),
  ].join(""));
  return { to, subject, text, html };
}

module.exports = { inviteEmail, tempPasswordEmail, resetLinkEmail };
