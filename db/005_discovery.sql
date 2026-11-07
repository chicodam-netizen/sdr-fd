-- Base própria de leads (planilhas) e busca de contatos na web aberta.
-- Somente colunas novas (sem DROP).

ALTER TABLE companies
  ADD COLUMN employees     integer,
  ADD COLUMN priority      numeric(10, 2),
  ADD COLUMN lists         text[] NOT NULL DEFAULT '{}',
  ADD COLUMN instagram_url text,
  ADD COLUMN discovery     jsonb,
  ADD COLUMN discovered_at timestamptz;

CREATE INDEX companies_lists_idx ON companies USING gin (lists);
CREATE INDEX companies_org_city_idx ON companies (organization_id, city);

-- kind: person = pessoa (decisor); generic = canal da empresa (contato@, comercial@).
-- source_url: página pública onde o dado foi encontrado (LGPD: origem do dado).
ALTER TABLE contacts
  ADD COLUMN kind       text NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'generic')),
  ADD COLUMN source_url text;
