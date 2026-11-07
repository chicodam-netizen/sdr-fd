// Funis e etapas (configuráveis por admin/gestor; leitura para todos).
const { query, withTransaction } = require("../db");
const { HttpError } = require("../http");
const { audit } = require("../audit");
const { createDefaultPipeline } = require("../default-pipeline");
const { reqText, optText, optColor, reqUuid } = require("../validate");

const MANAGERS = ["admin", "gestor"];
const KINDS = ["open", "qualified", "disqualified"];

function stageDto(s) {
  return { id: s.id, name: s.name, position: s.position, color: s.color, kind: s.kind };
}

async function loadPipelines(orgId) {
  const { rows: pipelines } = await query(
    `SELECT id, name, created_at FROM pipelines
     WHERE organization_id = $1 AND archived_at IS NULL ORDER BY created_at`,
    [orgId]
  );
  const { rows: stages } = await query(
    `SELECT s.id, s.pipeline_id, s.name, s.position, s.color, s.kind
     FROM stages s JOIN pipelines p ON p.id = s.pipeline_id
     WHERE s.organization_id = $1 AND p.archived_at IS NULL
     ORDER BY s.position`,
    [orgId]
  );
  return pipelines.map((p) => ({
    id: p.id,
    name: p.name,
    stages: stages.filter((s) => s.pipeline_id === p.id).map(stageDto),
  }));
}

async function findPipeline(user, id) {
  const { rows } = await query(
    `SELECT id, name FROM pipelines WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL`,
    [id, user.organizationId]
  );
  if (!rows.length) throw new HttpError(404, "not_found");
  return rows[0];
}

async function findStage(user, id) {
  const { rows } = await query(
    `SELECT id, pipeline_id, name, kind FROM stages WHERE id = $1 AND organization_id = $2`,
    [id, user.organizationId]
  );
  if (!rows.length) throw new HttpError(404, "not_found");
  return rows[0];
}

async function list({ user }) {
  let pipelines = await loadPipelines(user.organizationId);
  // Toda organização tem pelo menos um funil.
  if (!pipelines.length) {
    await createDefaultPipeline({ query }, user.organizationId);
    pipelines = await loadPipelines(user.organizationId);
  }
  return { ok: true, pipelines };
}

async function create({ user, body, ip }) {
  const name = reqText(body.name, "name", 80);
  const pipelineId = await withTransaction(async (client) => {
    const stages = Array.isArray(body.stages) && body.stages.length ? body.stages : null;
    if (!stages) return createDefaultPipeline(client, user.organizationId, name);
    const clean = stages.slice(0, 20).map((s) => ({
      name: reqText(s.name, "stage_name", 60),
      color: optColor(s.color) || "#3b82f6",
      kind: KINDS.includes(s.kind) ? s.kind : "open",
    }));
    return createDefaultPipeline(client, user.organizationId, name, clean);
  });
  await audit({ organizationId: user.organizationId, userId: user.id, action: "pipeline_created", entity: "pipeline", entityId: pipelineId, details: { name }, ip });
  const pipelines = await loadPipelines(user.organizationId);
  return { status: 201, body: { ok: true, pipeline: pipelines.find((p) => p.id === pipelineId) } };
}

async function update({ user, params, body, ip }) {
  await findPipeline(user, params.id);
  const name = reqText(body.name, "name", 80);
  await query(`UPDATE pipelines SET name = $2 WHERE id = $1`, [params.id, name]);
  await audit({ organizationId: user.organizationId, userId: user.id, action: "pipeline_updated", entity: "pipeline", entityId: params.id, details: { name }, ip });
  return { ok: true };
}

// Arquivar (não apaga dados): o funil some das telas, os negócios continuam no banco.
async function archive({ user, params, ip }) {
  await findPipeline(user, params.id);
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM pipelines WHERE organization_id = $1 AND archived_at IS NULL`,
    [user.organizationId]
  );
  if (rows[0].n <= 1) throw new HttpError(400, "last_pipeline");
  await query(`UPDATE pipelines SET archived_at = now() WHERE id = $1`, [params.id]);
  await audit({ organizationId: user.organizationId, userId: user.id, action: "pipeline_archived", entity: "pipeline", entityId: params.id, ip });
  return { ok: true };
}

async function addStage({ user, params, body, ip }) {
  await findPipeline(user, params.id);
  const name = reqText(body.name, "name", 60);
  const kind = KINDS.includes(body.kind) ? body.kind : "open";
  const color = optColor(body.color) || "#3b82f6";
  const { rows } = await query(
    `INSERT INTO stages (organization_id, pipeline_id, name, position, color, kind)
     VALUES ($1, $2, $3, (SELECT coalesce(max(position), 0) + 1 FROM stages WHERE pipeline_id = $2), $4, $5)
     RETURNING id, name, position, color, kind`,
    [user.organizationId, params.id, name, color, kind]
  );
  await audit({ organizationId: user.organizationId, userId: user.id, action: "stage_created", entity: "stage", entityId: rows[0].id, details: { name }, ip });
  return { status: 201, body: { ok: true, stage: stageDto(rows[0]) } };
}

async function updateStage({ user, params, body, ip }) {
  await findStage(user, params.id);
  const changes = {};
  if (body.name !== undefined) changes.name = reqText(body.name, "name", 60);
  if (body.color !== undefined) changes.color = optColor(body.color) || "#3b82f6";
  if (body.kind !== undefined) {
    if (!KINDS.includes(body.kind)) throw new HttpError(400, "invalid_kind");
    changes.kind = body.kind;
  }
  const keys = Object.keys(changes);
  if (!keys.length) throw new HttpError(400, "nothing_to_update");
  const { rows } = await query(
    `UPDATE stages SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1
     RETURNING id, name, position, color, kind`,
    [params.id, ...keys.map((k) => changes[k])]
  );
  await audit({ organizationId: user.organizationId, userId: user.id, action: "stage_updated", entity: "stage", entityId: params.id, details: changes, ip });
  return { ok: true, stage: stageDto(rows[0]) };
}

async function reorderStages({ user, params, body }) {
  await findPipeline(user, params.id);
  const order = Array.isArray(body.order) ? body.order.map((id) => reqUuid(id, "stage_id")) : null;
  if (!order) throw new HttpError(400, "missing_order");
  const { rows } = await query(`SELECT id FROM stages WHERE pipeline_id = $1`, [params.id]);
  const current = new Set(rows.map((r) => r.id));
  if (order.length !== current.size || !order.every((id) => current.has(id))) throw new HttpError(400, "invalid_order");
  await withTransaction(async (client) => {
    for (const [i, id] of order.entries()) {
      await client.query(`UPDATE stages SET position = $2 WHERE id = $1`, [id, i + 1]);
    }
  });
  return { ok: true };
}

// Só apaga etapa vazia; com negócios, pede para movê-los antes.
async function deleteStage({ user, params, ip }) {
  const stage = await findStage(user, params.id);
  const { rows } = await query(
    `SELECT (SELECT count(*)::int FROM deals WHERE stage_id = $1) AS deals,
            (SELECT count(*)::int FROM stages WHERE pipeline_id = $2) AS stages`,
    [stage.id, stage.pipeline_id]
  );
  if (rows[0].deals > 0) throw new HttpError(409, "stage_not_empty");
  if (rows[0].stages <= 1) throw new HttpError(400, "last_stage");
  await query(`DELETE FROM stages WHERE id = $1`, [stage.id]);
  await audit({ organizationId: user.organizationId, userId: user.id, action: "stage_deleted", entity: "stage", entityId: stage.id, details: { name: stage.name }, ip });
  return { ok: true };
}

module.exports = {
  routes: [
    { method: "GET", path: "/pipelines", handler: list },
    { method: "POST", path: "/pipelines", handler: create, roles: MANAGERS },
    { method: "PATCH", path: "/pipelines/:id", handler: update, roles: MANAGERS },
    { method: "POST", path: "/pipelines/:id/archive", handler: archive, roles: MANAGERS },
    { method: "POST", path: "/pipelines/:id/stages", handler: addStage, roles: MANAGERS },
    { method: "POST", path: "/pipelines/:id/stages/reorder", handler: reorderStages, roles: MANAGERS },
    { method: "PATCH", path: "/stages/:id", handler: updateStage, roles: MANAGERS },
    { method: "DELETE", path: "/stages/:id", handler: deleteStage, roles: MANAGERS },
  ],
  findPipeline,
  findStage,
};
