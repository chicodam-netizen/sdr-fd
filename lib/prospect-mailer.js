// Envio dos e-mails de prospecção (caixa própria, separada dos e-mails internos).
// - MAIL_ENABLED != "true": não envia, só simula (registra no console).
// - MAIL_REDIRECT_TO preenchido: TODO e-mail vai para esse endereço (ambiente de teste),
//   com o destinatário real indicado no assunto. Nunca chega ao lead.
// - Gera o Message-ID para encadear as respostas (In-Reply-To / References).
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { mailEnabled } = require("./mailer");

const OPT_OUT_FOOTER = "Se preferir não receber novos contatos, basta responder esta mensagem com SAIR.";

function smtpConfig() {
  const host = process.env.PROSPECT_SMTP_HOST || process.env.SMTP_HOST;
  const user = process.env.PROSPECT_SMTP_HOST ? process.env.PROSPECT_SMTP_USER : process.env.SMTP_USER;
  const pass = process.env.PROSPECT_SMTP_HOST ? process.env.PROSPECT_SMTP_PASS : process.env.SMTP_PASS;
  const port = Number(process.env.PROSPECT_SMTP_HOST ? process.env.PROSPECT_SMTP_PORT : process.env.SMTP_PORT) || 587;
  return { host, user, pass, port };
}

function senderAddress() {
  return smtpConfig().user || "prospeccao@localhost";
}

function newMessageId() {
  const domain = senderAddress().split("@")[1] || "sdr.local";
  return `<${crypto.randomUUID()}@${domain}>`;
}

function withFooter(body) {
  return `${body.trim()}\n\n--\n${OPT_OUT_FOOTER}`;
}

// msg: { to, subject, body, fromName, inReplyTo, references }
// Retorna { sent, simulated, deliveredTo, messageId, from, error? }
async function sendProspectEmail(msg) {
  const redirect = (process.env.MAIL_REDIRECT_TO || "").trim();
  const deliveredTo = redirect || msg.to;
  const subject = redirect ? `[TESTE → ${msg.to}] ${msg.subject}` : msg.subject;
  const text = withFooter(msg.body);
  const messageId = newMessageId();
  const from = `"${(msg.fromName || "").replace(/"/g, "")}" <${senderAddress()}>`;
  const headers = {};
  if (msg.inReplyTo) headers["In-Reply-To"] = msg.inReplyTo;
  if (msg.references) headers.References = msg.references;

  if (!mailEnabled()) {
    console.log(`[prospecção simulada] para=${deliveredTo} (lead: ${msg.to}) assunto="${subject}"\n${text}\n`);
    return { sent: false, simulated: true, deliveredTo, messageId, from: senderAddress() };
  }

  const cfg = smtpConfig();
  if (!cfg.host || !cfg.user || !cfg.pass) return { sent: false, simulated: false, error: "smtp_not_configured", deliveredTo, messageId };

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  try {
    await transporter.sendMail({ from, to: deliveredTo, subject, text, messageId, headers });
    return { sent: true, simulated: false, deliveredTo, messageId, from: cfg.user };
  } catch (err) {
    console.error("prospect mailer error:", err);
    return { sent: false, simulated: false, error: "send_failed", deliveredTo, messageId };
  } finally {
    transporter.close();
  }
}

module.exports = { sendProspectEmail, OPT_OUT_FOOTER, senderAddress };
