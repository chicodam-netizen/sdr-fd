// Funil padrão criado para toda organização nova (mesmas etapas da migração 002).
const DEFAULT_STAGES = [
  { name: "Novo lead", color: "#64748b", kind: "open" },
  { name: "Pesquisa", color: "#3b82f6", kind: "open" },
  { name: "Primeiro contato", color: "#8b5cf6", kind: "open" },
  { name: "Em conversa", color: "#f59e0b", kind: "open" },
  { name: "Qualificado", color: "#00c896", kind: "qualified" },
  { name: "Desqualificado", color: "#ef5b5b", kind: "disqualified" },
];

// db: pool ou client (dentro de transação)
async function createDefaultPipeline(db, organizationId, name = "Prospecção", stages = DEFAULT_STAGES) {
  const { rows } = await db.query(
    `INSERT INTO pipelines (organization_id, name) VALUES ($1, $2) RETURNING id`,
    [organizationId, name]
  );
  const pipelineId = rows[0].id;
  for (const [i, s] of stages.entries()) {
    await db.query(
      `INSERT INTO stages (organization_id, pipeline_id, name, position, color, kind) VALUES ($1, $2, $3, $4, $5, $6)`,
      [organizationId, pipelineId, s.name, i + 1, s.color, s.kind]
    );
  }
  return pipelineId;
}

module.exports = { DEFAULT_STAGES, createDefaultPipeline };
