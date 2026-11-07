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

## Agentes SDR (Fase 3)

- Agente = remetente + persona, objetivo, tom, premissas, critérios de qualificação, proibições,
  assinatura e limite diário. Base de conhecimento por agente ou compartilhada (texto, .txt/.md).
- Na ficha do card: escolher o agente → "Gerar rascunho" (Claude, `lib/ai.js`, saída JSON) →
  revisar/editar → "Aprovar e enviar". Toda mensagem passa por aprovação humana (modo rascunho).
  Fila geral em **Aprovações**.
- Envio (`lib/prospect-mailer.js`): `MAIL_ENABLED=false` simula; `MAIL_REDIRECT_TO` desvia TODO
  e-mail para o endereço de teste (assunto `[TESTE → lead@...]`). Rodapé de descadastro automático.
  Bloqueia contato com opt-out, sem e-mail ou acima do limite diário do agente.
- Respostas: colar manualmente na ficha ("Registrar resposta recebida") ou ler a caixa via IMAP
  (`npm run inbox`, botão "Ler caixa de entrada" em Aprovações, ou `GET /api/cron/inbox` com
  `CRON_SECRET`). Associação pelo In-Reply-To/References (ou remetente). A IA classifica
  (interessado, reunião, objeção, sair...) e sugere etapa; "SAIR" marca opt-out na hora.
- Cron na Vercel: o plano Hobby só permite cron diário; para ler a caixa a cada poucos minutos é
  preciso plano Pro ou um agendador externo chamando `/api/cron/inbox`.
- Testes usam `AI_FAKE=1` (sem chamar a API).

## Captação de leads (Fase 4)

Tela **Captação** (`/captacao`), envio direto ao funil (com etapa e agente), origem registrada em cada empresa.

- **Base CNPJ (Receita Federal, dados abertos)**: recorte carregado por script, sem dados de sócios.
  Baixe os .zip oficiais (Cnaes, Municipios, Estabelecimentos0..9, Empresas0..9) numa pasta e rode:
  `node --env-file=.env.local scripts/load-cnpj.js --dir PASTA --uf MG,SP --cnae 10,62`
  (`--cnae` aceita prefixos: `10` = toda a divisão; padrão só empresas ativas; `--incluir-inativas`).
  Busca por UF, município, CNAE, porte, nome, com e-mail/telefone, matriz e "fora da minha base".
- **Google Maps (Places API New, oficial)**: `GOOGLE_PLACES_API_KEY`; cobrança por uso no Google Cloud.
  Deduplica pelo place_id.
- **Enriquecimento por CNPJ**: base local primeiro, depois BrasilAPI (gratuita, exige User-Agent).
  Só preenche campos vazios; descarta o quadro de sócios (LGPD). Botão na ficha da empresa e
  "Enriquecer pendentes" em Leads (lotes de 10, para respeitar o limite da BrasilAPI).
- **LinkedIn**: apenas importação CSV e contato manual (termos de uso proíbem automação).

## Cadências, autonomia e resultados (Fase 5)

- Cada agente tem uma cadência (até 10 passos; padrão 0/3/7/14 dias) editável na ficha do agente.
- Inscrição: na ficha do card ("Iniciar cadência") ou no envio em lote ao funil (Leads/Captação).
- Autonomia do agente: **rascunho** (todo passo vai para Aprovações), **semiautônomo** (1º passo aprovado,
  follow-ups automáticos), **autônomo** (todos automáticos). Respostas de leads nunca são automáticas:
  a cadência para e um humano assume. Também para em opt-out, sem e-mail ou card qualificado/desqualificado.
- Envio só em horário comercial (seg-sex 8h-18h de Brasília) por padrão; respeita o limite diário do agente.
- Processamento: botão "Processar cadências" em Aprovações,  ( para rodar
  continuamente) ou  com  (4 passos por chamada).
- **Resultados** (): funil de conversão, cards por etapa, desempenho por agente, atividade diária.

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
