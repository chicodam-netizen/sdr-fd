-- Segmento (divisão CNAE, 2 dígitos) da empresa, para filtrar a base de leads.
-- O campo "segment" já existente continua com a atividade detalhada (CNAE de 7 dígitos).
-- Somente adições (sem DROP).

CREATE TABLE cnae_divisions (
  code text PRIMARY KEY,   -- 2 dígitos, ex.: "10"
  name text NOT NULL       -- ex.: "Fabricação de Produtos Alimentícios"
);

ALTER TABLE companies ADD COLUMN sector text;
CREATE INDEX companies_org_sector_idx ON companies (organization_id, sector);
