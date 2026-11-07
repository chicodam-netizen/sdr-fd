-- Captação de leads: dados cadastrais nas empresas, base pública de CNPJ (Receita) e CNAEs.
-- Somente criação de tabelas e colunas novas (sem DROP).

ALTER TABLE companies
  ADD COLUMN legal_name          text,
  ADD COLUMN cnae_code           text,
  ADD COLUMN size                text,
  ADD COLUMN registration_status text,
  ADD COLUMN opened_at           date,
  ADD COLUMN external_ids        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN enrichment          jsonb,
  ADD COLUMN enriched_at         timestamptz;

CREATE INDEX companies_places_idx ON companies ((external_ids->>'places')) WHERE external_ids ? 'places';

-- Recorte dos dados abertos de CNPJ da Receita Federal (dado público, compartilhado por todas as
-- organizações). Carregado por scripts/load-cnpj.js com filtros de UF/CNAE; sem dados de sócios.
CREATE TABLE cnpj_establishments (
  cnpj              text PRIMARY KEY,
  cnpj_basico       text NOT NULL,
  is_matriz         boolean NOT NULL,
  razao_social      text,
  nome_fantasia     text,
  situacao          text NOT NULL,
  data_inicio       date,
  cnae_principal    text NOT NULL,
  cnaes_secundarios text,
  logradouro        text,
  numero            text,
  bairro            text,
  cep               text,
  uf                text NOT NULL,
  municipio_codigo  text,
  municipio         text,
  telefone          text,
  email             text,
  porte             text,
  capital_social    numeric(18, 2),
  loaded_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cnpj_est_basico_idx ON cnpj_establishments (cnpj_basico);
CREATE INDEX cnpj_est_uf_mun_idx ON cnpj_establishments (uf, municipio);
CREATE INDEX cnpj_est_cnae_idx ON cnpj_establishments (cnae_principal text_pattern_ops, uf);

CREATE TABLE cnaes (
  code        text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE cnpj_loads (
  id         bigserial PRIMARY KEY,
  reference  text,
  filters    jsonb NOT NULL DEFAULT '{}'::jsonb,
  rows       integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
