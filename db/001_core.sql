-- Núcleo multi-tenant: organizações, usuários, sessões, redefinição de senha e auditoria.
-- Toda tabela de negócio futura carrega organization_id.

CREATE TABLE organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                 text NOT NULL,
  email                text NOT NULL,
  password_hash        text NOT NULL,
  role                 text NOT NULL CHECK (role IN ('admin', 'gestor', 'sdr')),
  active               boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT true,
  last_login_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- E-mail é o login, único em todo o sistema (independente da organização).
CREATE UNIQUE INDEX users_email_uniq ON users (lower(email));
CREATE INDEX users_org_idx ON users (organization_id);

-- Guardamos só o SHA-256 do token; o token em si existe apenas no cookie do navegador.
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  ip         text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE password_resets (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id              bigserial PRIMARY KEY,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  action          text NOT NULL,
  entity          text,
  entity_id       text,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip              text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org_created_idx ON audit_log (organization_id, created_at DESC);
CREATE INDEX audit_log_action_created_idx ON audit_log (action, created_at DESC);
