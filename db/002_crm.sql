-- CRM: funis e etapas customizáveis, empresas, contatos, negócios (cards) e atividades.
-- Somente criação de tabelas + funil padrão para organizações já existentes (sem DROP).

CREATE TABLE pipelines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pipelines_org_idx ON pipelines (organization_id);

-- kind: open = em andamento; qualified = lead qualificado (entregue); disqualified = descartado.
CREATE TABLE stages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pipeline_id     uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  name            text NOT NULL,
  position        integer NOT NULL,
  color           text NOT NULL DEFAULT '#3b82f6',
  kind            text NOT NULL DEFAULT 'open' CHECK (kind IN ('open', 'qualified', 'disqualified')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stages_pipeline_idx ON stages (pipeline_id, position);

-- source/source_detail: origem do dado (base legal LGPD - legítimo interesse exige rastrear a fonte).
CREATE TABLE companies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  cnpj            text,
  website         text,
  segment         text,
  city            text,
  uf              text,
  phone           text,
  linkedin_url    text,
  notes           text,
  source          text NOT NULL DEFAULT 'manual',
  source_detail   text,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX companies_org_idx ON companies (organization_id);
CREATE INDEX companies_org_name_idx ON companies (organization_id, lower(name));
CREATE UNIQUE INDEX companies_org_cnpj_uniq ON companies (organization_id, cnpj) WHERE cnpj IS NOT NULL;

CREATE TABLE contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id      uuid REFERENCES companies(id) ON DELETE CASCADE,
  name            text NOT NULL,
  email           text,
  phone           text,
  job_title       text,
  linkedin_url    text,
  opt_out         boolean NOT NULL DEFAULT false,
  source          text NOT NULL DEFAULT 'manual',
  source_detail   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contacts_company_idx ON contacts (company_id);
CREATE UNIQUE INDEX contacts_org_email_uniq ON contacts (organization_id, lower(email)) WHERE email IS NOT NULL;

-- position: ordem do card dentro da etapa (float para inserir entre dois cards sem renumerar).
CREATE TABLE deals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pipeline_id      uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  stage_id         uuid NOT NULL REFERENCES stages(id),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id       uuid REFERENCES contacts(id) ON DELETE SET NULL,
  owner_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  title            text NOT NULL,
  value            numeric(14, 2),
  position         double precision NOT NULL DEFAULT 0,
  next_action_at   timestamptz,
  stage_changed_at timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deals_pipeline_stage_idx ON deals (pipeline_id, stage_id, position);
CREATE INDEX deals_company_idx ON deals (company_id);
CREATE INDEX deals_org_idx ON deals (organization_id);

CREATE TABLE activities (
  id              bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  deal_id         uuid REFERENCES deals(id) ON DELETE CASCADE,
  company_id      uuid REFERENCES companies(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  type            text NOT NULL,
  body            text,
  meta            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activities_deal_idx ON activities (deal_id, created_at DESC);
CREATE INDEX activities_company_idx ON activities (company_id, created_at DESC);

-- Funil padrão para organizações que já existem.
WITH p AS (
  INSERT INTO pipelines (organization_id, name)
  SELECT id, 'Prospecção' FROM organizations
  RETURNING id, organization_id
)
INSERT INTO stages (organization_id, pipeline_id, name, position, color, kind)
SELECT p.organization_id, p.id, s.name, s.position, s.color, s.kind
FROM p
CROSS JOIN (VALUES
  ('Novo lead', 1, '#64748b', 'open'),
  ('Pesquisa', 2, '#3b82f6', 'open'),
  ('Primeiro contato', 3, '#8b5cf6', 'open'),
  ('Em conversa', 4, '#f59e0b', 'open'),
  ('Qualificado', 5, '#00c896', 'qualified'),
  ('Desqualificado', 6, '#ef5b5b', 'disqualified')
) AS s(name, position, color, kind);
