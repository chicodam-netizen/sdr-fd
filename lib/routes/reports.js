// Painel de resultados: funil de conversão, etapas, desempenho por agente, série diária e respostas.
const { query } = require("../db");
const { HttpError } = require("../http");
const { optUuid } = require("../validate");

async function report({ user, query: qs }) {
  const days = Math.min(365, Math.max(1, Number(qs.get("days")) || 30));
  const org = user.organizationId;
  let pipelineId = optUuid(qs.get("pipelineId"), "pipeline_id");
  if (!pipelineId) {
    const { rows } = await query(`SELECT id FROM pipelines WHERE organization_id = $1 AND archived_at IS NULL ORDER BY created_at LIMIT 1`, [org]);
    pipelineId = rows[0]?.id;
  }
  if (!pipelineId) throw new HttpError(404, "not_found");
  const since = `now() - make_interval(days => $2)`;

  const [funnel, stages, agents, daily, categories, cadences] = await Promise.all([
    // Cards criados no período e até onde chegaram.
    query(
      `SELECT count(*)::int AS created,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM messages m WHERE m.deal_id = d.id AND m.direction = 'out' AND m.status = 'sent'))::int AS contacted,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM messages m WHERE m.deal_id = d.id AND m.direction = 'in'))::int AS replied,
         count(*) FILTER (WHERE s.kind = 'qualified')::int AS qualified,
         count(*) FILTER (WHERE s.kind = 'disqualified')::int AS disqualified
       FROM deals d JOIN stages s ON s.id = d.stage_id
       WHERE d.organization_id = $1 AND d.pipeline_id = $3 AND d.created_at > ${since}`,
      [org, days, pipelineId]
    ),
    query(
      `SELECT s.id, s.name, s.color, s.kind, s.position, count(d.id)::int AS deals, coalesce(sum(d.value), 0)::float AS value,
              coalesce(avg(EXTRACT(EPOCH FROM now() - d.stage_changed_at) / 86400) FILTER (WHERE d.id IS NOT NULL), 0)::float AS avg_days
       FROM stages s LEFT JOIN deals d ON d.stage_id = s.id
       WHERE s.pipeline_id = $1 GROUP BY s.id ORDER BY s.position`,
      [pipelineId]
    ),
    query(
      `SELECT a.id, a.name, a.autonomy, a.active,
         (SELECT count(*)::int FROM messages m WHERE m.agent_id = a.id AND m.direction = 'out' AND m.status = 'sent' AND m.sent_at > ${since}) AS sent,
         (SELECT count(*)::int FROM messages m WHERE m.agent_id = a.id AND m.direction = 'out' AND m.status = 'sent' AND m.approved_by IS NULL AND m.sent_at > ${since}) AS auto_sent,
         (SELECT count(DISTINCT m.deal_id)::int FROM messages m WHERE m.agent_id = a.id AND m.direction = 'out' AND m.status = 'sent' AND m.sent_at > ${since}) AS deals_contacted,
         (SELECT count(DISTINCT m.deal_id)::int FROM messages m WHERE m.agent_id = a.id AND m.direction = 'in' AND m.created_at > ${since}) AS deals_replied,
         (SELECT count(*)::int FROM deals d JOIN stages s ON s.id = d.stage_id WHERE d.agent_id = a.id AND s.kind = 'qualified') AS qualified,
         (SELECT count(*)::int FROM messages m WHERE m.agent_id = a.id AND m.status = 'draft') AS pending,
         (SELECT count(*)::int FROM enrollments e WHERE e.agent_id = a.id AND e.status IN ('active', 'waiting_approval')) AS in_cadence
       FROM agents a WHERE a.organization_id = $1 ORDER BY a.name`,
      [org, days]
    ),
    query(
      `SELECT to_char(g.day, 'YYYY-MM-DD') AS day,
         (SELECT count(*)::int FROM messages m WHERE m.organization_id = $1 AND m.direction = 'out' AND m.status = 'sent'
            AND (m.sent_at AT TIME ZONE 'America/Sao_Paulo')::date = g.day) AS sent,
         (SELECT count(*)::int FROM messages m WHERE m.organization_id = $1 AND m.direction = 'in'
            AND (m.created_at AT TIME ZONE 'America/Sao_Paulo')::date = g.day) AS received
       FROM generate_series((now() AT TIME ZONE 'America/Sao_Paulo')::date - ($2::int - 1), (now() AT TIME ZONE 'America/Sao_Paulo')::date, interval '1 day') AS g(day)
       ORDER BY g.day`,
      [org, days]
    ),
    query(
      `SELECT ai_meta->'classification'->>'category' AS category, count(*)::int AS n
       FROM messages WHERE organization_id = $1 AND direction = 'in' AND created_at > ${since} AND ai_meta ? 'classification'
       GROUP BY 1 ORDER BY 2 DESC`,
      [org, days]
    ),
    query(`SELECT status, count(*)::int AS n FROM enrollments WHERE organization_id = $1 GROUP BY status`, [org]),
  ]);

  return {
    ok: true,
    days,
    pipelineId,
    funnel: funnel.rows[0],
    stages: stages.rows.map((s) => ({ id: s.id, name: s.name, color: s.color, kind: s.kind, deals: s.deals, value: s.value, avgDays: Math.round(s.avg_days * 10) / 10 })),
    agents: agents.rows.map((a) => ({
      id: a.id, name: a.name, autonomy: a.autonomy, active: a.active, sent: a.sent, autoSent: a.auto_sent,
      dealsContacted: a.deals_contacted, dealsReplied: a.deals_replied,
      replyRate: a.deals_contacted ? Math.round((a.deals_replied / a.deals_contacted) * 1000) / 10 : null,
      qualified: a.qualified, pending: a.pending, inCadence: a.in_cadence,
    })),
    daily: daily.rows,
    categories: categories.rows,
    cadences: Object.fromEntries(cadences.rows.map((r) => [r.status, r.n])),
  };
}

module.exports = [{ method: "GET", path: "/reports", handler: report }];
