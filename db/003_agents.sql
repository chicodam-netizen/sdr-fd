-- Agentes SDR (IA), base de conhecimento e mensagens (e-mail) por card.
-- Somente criação de tabelas e colunas novas (sem DROP).

-- autonomy: draft = toda mensagem passa por aprovação humana (único modo ativo no MVP);
-- semi/auto ficam reservados para a fase de automação.
CREATE TABLE agents (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                   text NOT NULL,
  active                 boolean NOT NULL DEFAULT true,
  sender_name            text NOT NULL,
  sender_title           text,
  persona                text,
  objective              text,
  tone                   text,
  rules                  text,
  qualification_criteria text,
  forbidden              text,
  signature              text,
  autonomy               text NOT NULL DEFAULT 'draft' CHECK (autonomy IN ('draft', 'semi', 'auto')),
  daily_limit            integer NOT NULL DEFAULT 30 CHECK (daily_limit BETWEEN 1 AND 500),
  created_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agents_org_idx ON agents (organization_id);

-- agent_id nulo = conhecimento compartilhado por todos os agentes da organização.
CREATE TABLE knowledge_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id        uuid REFERENCES agents(id) ON DELETE CASCADE,
  title           text NOT NULL,
  content         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_items_org_idx ON knowledge_items (organization_id, agent_id);

ALTER TABLE deals ADD COLUMN agent_id uuid REFERENCES agents(id) ON DELETE SET NULL;

-- direction out: rascunho -> aprovado -> enviado (ou descartado / falhou)
-- direction in : resposta recebida (status received), com classificação da IA em ai_meta.
CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  deal_id         uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  agent_id        uuid REFERENCES agents(id) ON DELETE SET NULL,
  direction       text NOT NULL CHECK (direction IN ('out', 'in')),
  status          text NOT NULL CHECK (status IN ('draft', 'sent', 'failed', 'discarded', 'received')),
  subject         text,
  body            text NOT NULL,
  to_email        text,
  delivered_to    text,
  from_email      text,
  message_id      text,
  in_reply_to     text,
  error           text,
  ai_meta         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_deal_idx ON messages (deal_id, created_at);
CREATE INDEX messages_org_status_idx ON messages (organization_id, status, created_at DESC);
CREATE UNIQUE INDEX messages_message_id_uniq ON messages (message_id) WHERE message_id IS NOT NULL;
