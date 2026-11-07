# SDR FD

Prospecção B2B com agentes de IA (SDR), funil customizável e entrega de leads qualificados.

Stack (espelha o SiteFD): SPA em JS puro (`public/`, router por hash), uma função serverless
Node na Vercel (`api/index.js`, despacha as rotas de `lib/routes/`), Postgres via `pg`
(Neon em produção), nodemailer (SMTP) e API da Anthropic.

## Ambiente local

Banco de teste em cluster próprio: `D:\FD_CONSULTORIA\DESENVOLVIMENTO\pgdata-sdr-fd` (porta 5545).
Não sobe sozinho com o Windows; para ligar/desligar:

```
"C:\Program Files\PostgreSQL\17\bin\pg_ctl.exe" -D D:\FD_CONSULTORIA\DESENVOLVIMENTO\pgdata-sdr-fd -l D:\FD_CONSULTORIA\DESENVOLVIMENTO\pgdata-sdr-fd\server.log start
"C:\Program Files\PostgreSQL\17\bin\pg_ctl.exe" -D D:\FD_CONSULTORIA\DESENVOLVIMENTO\pgdata-sdr-fd stop
```

```
npm install
npm run migrate   # aplica db/*.sql pendentes (só localhost, salvo --allow-remote)
npm run seed      # cria a 1ª organização + admin (dados em .env.local)
npm run dev       # http://localhost:3100
npm test          # testes de integração da API contra o banco local
```

Configuração em `.env.local` (modelo em `.env.example`). Com `MAIL_ENABLED=false` nenhum e-mail
sai: o conteúdo vai para o console e, na tela de usuários, a senha temporária é exibida ao admin.

## CRM (Fase 2)

- Funis com etapas customizáveis (`/funil/configurar`): nome, cor, ordem e tipo
  (em andamento / qualificado / desqualificado). Toda organização nova recebe o funil padrão.
- Funil em kanban (arrastar e soltar via SortableJS) ou lista; ficha do card com anotações e histórico.
- Importação CSV no navegador (UTF-8 ou Windows-1252 do Excel, `;` ou `,`), com mapeamento de
  colunas; deduplica empresa por CNPJ (ou nome) e contato por e-mail. Exemplo: `tests/exemplo-importacao.csv`.
- Origem de cada empresa/contato fica registrada (`source`, `source_detail`) e contatos têm opt-out (LGPD).

## Migrações

Arquivos `db/NNN_nome.sql`, aplicados em ordem e registrados em `schema_migrations`.
Contra o banco de produção só com plano aprovado:
`CONFIRM_REMOTE_MIGRATION=sim node --env-file=.env.production.local scripts/migrate.js --allow-remote`
(`--dry-run` lista o que está pendente sem aplicar).

## Segurança

- Senhas com bcrypt; sessão em cookie httpOnly/SameSite=Lax (Secure em https), 12h deslizantes;
  no banco fica só o SHA-256 do token.
- Requisições que alteram dados exigem `application/json` (proteção CSRF complementar).
- Bloqueio de login após 5 falhas em 15 min; troca de senha obrigatória no 1º acesso.
- Todas as consultas filtram por `organization_id` (multi-tenant); ações relevantes vão para `audit_log`.
