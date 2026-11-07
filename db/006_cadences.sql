-- Cadências (sequências de follow-up) por agente e inscrição de cards nelas.
-- Somente tabelas/colunas novas + cadência padrão para agentes existentes (sem DROP).

-- Passos da cadência do agente. delay_days: dias após o envio do passo anterior (passo 1: após a inscrição).
CREATE TABLE cadence_steps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id        uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  position        integer NOT NULL,
  delay_days      integer NOT NULL DEFAULT 0 CHECK (delay_days BETWEEN 0 AND 90),
  instruction     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, position)
);

-- status: active (aguardando a hora do próximo passo), waiting_approval (rascunho na fila),
-- paused, replied (lead respondeu), finished (sequência concluída ou card qualificado/desqualificado),
-- stopped (opt-out, sem e-mail, encerrada manualmente).
CREATE TABLE enrollments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  deal_id         uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  agent_id        uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  current_step    integer NOT NULL DEFAULT 1,
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'waiting_approval', 'paused', 'replied', 'finished', 'stopped')),
  next_run_at     timestamptz,
  stop_reason     text,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- Um card só pode ter uma cadência em andamento.
CREATE UNIQUE INDEX enrollments_open_deal_uniq ON enrollments (deal_id) WHERE status IN ('active', 'waiting_approval', 'paused');
CREATE INDEX enrollments_due_idx ON enrollments (status, next_run_at);

ALTER TABLE messages
  ADD COLUMN enrollment_id uuid REFERENCES enrollments(id) ON DELETE SET NULL,
  ADD COLUMN step          integer;

-- Envio só em horário comercial (seg-sex, 8h-18h de Brasília) por padrão.
ALTER TABLE agents ADD COLUMN business_hours_only boolean NOT NULL DEFAULT true;

-- Cadência padrão de 4 toques para os agentes que já existem.
INSERT INTO cadence_steps (organization_id, agent_id, position, delay_days, instruction)
SELECT a.organization_id, a.id, s.position, s.delay_days, s.instruction
FROM agents a
CROSS JOIN (VALUES
  (1, 0, 'Primeiro contato.'),
  (2, 3, 'Follow-up curto retomando o primeiro e-mail com um ângulo novo; não repita o texto anterior.'),
  (3, 7, 'Compartilhe um insight útil e concreto ligado ao segmento do lead e renove o convite.'),
  (4, 14, 'E-mail de encerramento cordial: pergunte se faz sentido seguir conversando ou se deve encerrar o contato por ora.')
) AS s(position, delay_days, instruction);
