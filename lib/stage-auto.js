// Avanço automático de etapa no funil conforme a conversa acontece (só etapas de rotina):
//   1º e-mail enviado          -> "Primeiro contato"
//   lead respondeu (conversa)  -> "Em conversa"
// Regras: só avança (nunca volta), só entre etapas abertas, nunca mexe em Qualificado/Desqualificado
// (essas ficam como sugestão da IA para um humano aplicar). As etapas são achadas pelo nome no funil do card;
// se o funil não tiver uma etapa com esse nome, nada acontece.
const { nextPosition, logActivity } = require("./crm");

const TARGETS = {
  first_contact: ["primeiro contato", "1o contato", "contato inicial", "contatado"],
  conversation: ["em conversa", "em conversacao", "conversando", "em negociacao"],
};

// Respostas que contam como "conversa em andamento".
const CONVERSATION_CATEGORIES = ["interested", "meeting_request", "question", "objection", "not_now", "wrong_person", "other"];

const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/º/g, "o").toLowerCase().trim();

async function autoAdvance(db, { orgId, dealId, target, reason }) {
  const names = TARGETS[target];
  if (!names) return null;
  const { rows } = await db.query(
    `SELECT d.id, d.company_id, d.pipeline_id, s.name AS stage_name, s.position AS stage_position, s.kind
     FROM deals d JOIN stages s ON s.id = d.stage_id WHERE d.id = $1`,
    [dealId]
  );
  const deal = rows[0];
  if (!deal || deal.kind !== "open") return null;
  const { rows: stages } = await db.query(
    `SELECT id, name, position FROM stages WHERE pipeline_id = $1 AND kind = 'open' ORDER BY position`,
    [deal.pipeline_id]
  );
  const to = stages.find((s) => names.includes(norm(s.name)));
  if (!to || to.position <= deal.stage_position) return null;
  const position = await nextPosition(db, to.id);
  await db.query(`UPDATE deals SET stage_id = $2, position = $3, stage_changed_at = now(), updated_at = now() WHERE id = $1`, [dealId, to.id, position]);
  await logActivity(db, {
    orgId, dealId, companyId: deal.company_id, userId: null, type: "stage_change",
    meta: { from: deal.stage_name, to: to.name, toKind: "open", auto: true, reason },
  });
  return to.name;
}

module.exports = { autoAdvance, CONVERSATION_CATEGORIES };
