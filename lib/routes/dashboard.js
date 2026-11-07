const { query } = require("../db");

async function summary({ user }) {
  const { rows } = await query(
    `SELECT
       count(*) FILTER (WHERE s.kind = 'open')::int         AS open,
       count(*) FILTER (WHERE s.kind = 'qualified')::int    AS qualified,
       count(*) FILTER (WHERE s.kind = 'disqualified')::int AS disqualified,
       count(*) FILTER (WHERE s.kind = 'qualified' AND d.stage_changed_at > now() - interval '30 days')::int AS qualified_30d
     FROM deals d
     JOIN stages s ON s.id = d.stage_id
     JOIN pipelines p ON p.id = d.pipeline_id
     WHERE d.organization_id = $1 AND p.archived_at IS NULL`,
    [user.organizationId]
  );
  const { rows: companies } = await query(`SELECT count(*)::int AS n FROM companies WHERE organization_id = $1`, [user.organizationId]);
  const { rows: extra } = await query(
    `SELECT (SELECT count(*)::int FROM messages WHERE organization_id = $1 AND status = 'draft') AS pending_approval,
            (SELECT count(*)::int FROM agents WHERE organization_id = $1 AND active) AS active_agents,
            (SELECT count(*)::int FROM messages WHERE organization_id = $1 AND direction = 'out' AND status = 'sent' AND sent_at > now() - interval '7 days') AS sent_7d,
            (SELECT count(*)::int FROM messages WHERE organization_id = $1 AND direction = 'in' AND created_at > now() - interval '7 days') AS replies_7d`,
    [user.organizationId]
  );
  return { ok: true, summary: { ...rows[0], companies: companies[0].n, ...extra[0] } };
}

module.exports = [{ method: "GET", path: "/dashboard", handler: summary }];
