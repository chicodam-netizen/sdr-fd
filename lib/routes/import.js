// Importação de leads (CSV já lido e mapeado no navegador): cria empresas, contatos e cards.
// Linhas inválidas são relatadas e puladas; as válidas entram numa única transação.
const { withTransaction } = require("../db");
const { HttpError } = require("../http");
const { audit } = require("../audit");
const { findPipeline, findStage } = require("./pipelines");
const { reqUuid, optText, optMoney } = require("../validate");
const { cleanCompany, cleanContact, findOrCreateCompany, findOrCreateContact, nextPosition, logActivity } = require("../crm");

const MAX_ROWS = 2000;

async function importDeals({ user, body, ip }) {
  const pipelineId = reqUuid(body.pipelineId, "pipeline_id");
  const stageId = reqUuid(body.stageId, "stage_id");
  await findPipeline(user, pipelineId);
  const stage = await findStage(user, stageId);
  if (stage.pipeline_id !== pipelineId) throw new HttpError(400, "invalid_stage_id");
  if (!Array.isArray(body.rows) || !body.rows.length) throw new HttpError(400, "missing_rows");
  if (body.rows.length > MAX_ROWS) throw new HttpError(400, "too_many_rows");
  const sourceDetail = optText(body.fileName, "file_name", 200) || "CSV";

  const errors = [];
  const valid = [];
  body.rows.forEach((row, i) => {
    try {
      valid.push({
        line: i + 1,
        company: cleanCompany(row.company || {}),
        contact: cleanContact(row.contact),
        value: optMoney(row.value),
      });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      errors.push({ line: i + 1, error: err.code });
    }
  });

  const result = { created: 0, alreadyInPipeline: 0, companiesCreated: 0, contactsCreated: 0 };
  await withTransaction(async (db) => {
    let position = await nextPosition(db, stageId);
    for (const r of valid) {
      const co = await findOrCreateCompany(db, user.organizationId, user.id, r.company, "csv", sourceDetail);
      if (co.created) result.companiesCreated++;
      const ct = await findOrCreateContact(db, user.organizationId, co.id, r.contact, "csv", sourceDetail);
      if (ct?.created) result.contactsCreated++;

      // Não duplica card: empresa que já está neste funil é pulada.
      const exists = await db.query(`SELECT 1 FROM deals WHERE pipeline_id = $1 AND company_id = $2`, [pipelineId, co.id]);
      if (exists.rowCount) {
        result.alreadyInPipeline++;
        continue;
      }
      const { rows } = await db.query(
        `INSERT INTO deals (organization_id, pipeline_id, stage_id, company_id, contact_id, owner_id, title, value, position, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $6) RETURNING id`,
        [user.organizationId, pipelineId, stageId, co.id, ct?.id || null, user.id, r.company.name, r.value, position]
      );
      position += 1024;
      await logActivity(db, {
        orgId: user.organizationId, dealId: rows[0].id, companyId: co.id, userId: user.id,
        type: "import", meta: { file: sourceDetail, line: r.line },
      });
      result.created++;
    }
  });

  await audit({
    organizationId: user.organizationId, userId: user.id, action: "deals_imported", entity: "pipeline", entityId: pipelineId,
    details: { file: sourceDetail, ...result, errors: errors.length }, ip,
  });
  return { ok: true, ...result, errors };
}

module.exports = [{ method: "POST", path: "/import/deals", handler: importDeals, roles: ["admin", "gestor"] }];
