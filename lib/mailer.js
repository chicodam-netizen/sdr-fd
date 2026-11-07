// Envio de e-mail transacional (notificações internas: convites, senhas).
// MAIL_ENABLED=false (padrão em dev) apenas registra no console, sem enviar.
// Todas as mensagens de um mesmo evento saem numa única conexão SMTP.
const nodemailer = require("nodemailer");

function mailEnabled() {
  return process.env.MAIL_ENABLED === "true";
}

function fromAddress() {
  const name = process.env.MAIL_FROM_NAME || "SDR FD Consultoria";
  return `"${name}" <${process.env.SMTP_USER}>`;
}

// messages: [{ to, subject, text, html }]
// Retorna { sent, simulated, error? } - o chamador repassa isso à interface.
async function sendBatch(messages) {
  if (!mailEnabled()) {
    for (const m of messages) {
      console.log(`[mail simulado] para=${m.to} assunto="${m.subject}"\n${m.text}\n`);
    }
    return { sent: false, simulated: true };
  }

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.error("mailer: SMTP não configurado");
    return { sent: false, simulated: false, error: "smtp_not_configured" };
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    pool: true,
    maxConnections: 1,
  });

  try {
    for (const m of messages) {
      await transporter.sendMail({ from: fromAddress(), ...m });
    }
    return { sent: true, simulated: false };
  } catch (err) {
    console.error("mailer error:", err);
    return { sent: false, simulated: false, error: "send_failed" };
  } finally {
    transporter.close();
  }
}

module.exports = { sendBatch, mailEnabled };
