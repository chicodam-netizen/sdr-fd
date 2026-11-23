# SDR FD no Claude (MCP): manual básico

O **MCP do SDR FD** permite usar o sistema conversando com o Claude: consultar o funil, ver o histórico de um lead, pedir rascunhos à IA, mover cards, iniciar cadências etc., sem abrir a tela do sistema.

> **Nada é enviado ao lead pelo Claude.** Os rascunhos de e-mail vão para **Aprovações** e os de LinkedIn para o menu **LinkedIn**. O envio continua sendo feito por você, no sistema.

---

## 1. Onde funciona

| Onde | Situação |
|---|---|
| **Claude Desktop – aba Chat** | Instalado (arquivo `claude_desktop_config.json`) |
| **Claude Desktop – aba Code / Claude Code** | Instalado (configuração do usuário) |
| claude.ai no navegador, celular, outros PCs | Não funciona: o MCP roda **neste PC** e usa o banco local |

Requisitos para funcionar:

1. **O banco local (Postgres) precisa estar ligado.** Se o PC reiniciou ou suspendeu, ele para. Peça ao Claude para "subir a aplicação" ou ligue o banco antes.
2. O servidor web do sistema (`localhost:3100`) **não** é necessário para o MCP, mas continua sendo onde você aprova e envia os e-mails e onde a automação roda.

O Claude age como o seu usuário admin (definido em `MCP_USER_EMAIL`). Tudo o que ele faz fica registrado na auditoria do sistema.

---

## 2. Primeiro uso

1. **Feche e abra de novo o Claude Desktop** (feche pela bandeja do Windows, não só a janela) para ele carregar o MCP novo.
2. Numa conversa nova, clique no ícone de **ferramentas/conectores** da caixa de mensagem: deve aparecer **sdr-fd** com as ferramentas.
3. Na primeira vez que o Claude usar uma ferramenta, ele pede permissão. Você pode permitir uma vez ou **sempre** (recomendado para as de consulta).

Teste: *"Use o sdr-fd e me mostre o resumo do painel."*

---

## 3. O que dá para pedir (exemplos)

**Consultas**
- "Quantos leads estão em cada etapa do funil?"
- "Mostre os cards que estão em Em conversa e o que o lead respondeu."
- "Abra o card da Empresa X e resuma o histórico."
- "Quais rascunhos estão aguardando aprovação?"
- "Quais tarefas de LinkedIn tenho hoje?"
- "Relatório dos últimos 30 dias: quantos contatados, quantas respostas, conversão."
- "Na base de leads, quais empresas de Contagem com mais de 50 funcionários ainda não estão no funil?"
- "Na base da Receita, procure empresas de software (CNAE 62) em MG que ainda não estão no sistema."

**Ações (ficam como rascunho / registro, sem envio)**
- "Gere um rascunho de follow-up para a Empresa Y mencionando o case da indústria X."
- "Reescreva o rascunho da Empresa Z mais curto e com assunto mais direto."
- "Adicione uma nota no card da Empresa X: ligar dia 25 às 10h."
- "Mova o card da Empresa X para Qualificado."
- "Inicie a cadência do agente José para estes 10 cards."
- "Pause a cadência da Empresa Y."
- "O lead da Empresa Z me respondeu no LinkedIn: '...'. Registre a resposta."
- "Envie ao funil as 20 empresas de maior prioridade de Betim, etapa Novo, com a cadência do José."

Dica: o Claude encontra os IDs sozinho (busca o card/empresa/agente antes). Se houver nomes parecidos, ele pergunta ou mostra as opções.

---

## 4. Ferramentas disponíveis

**Consulta (não alteram nada)**

| Ferramenta | Para quê |
|---|---|
| `painel` | Números gerais do sistema |
| `listar_funis` | Funis e etapas |
| `buscar_cards` | Lista/busca cards do funil |
| `ver_card` | Card completo: empresa, contato, histórico, mensagens, cadência |
| `buscar_empresas` / `ver_empresa` | Empresas cadastradas e seus contatos |
| `base_de_leads` | Base de leads com filtros (cidade, setor, porte, funcionários, no funil ou não) |
| `buscar_cnpj_receita` | Base da Receita Federal carregada no PC (exige UF, CNAE ou nome) |
| `aprovacoes_pendentes` | Rascunhos de e-mail aguardando aprovação |
| `tarefas_linkedin` | Tarefas de LinkedIn pendentes |
| `cadencias_visao_geral` | Quem está em cadência, pausado, aguardando |
| `listar_agentes` / `ver_cadencia_agente` | Agentes SDR e os passos de cada cadência |
| `relatorio` | Relatório do período (funil, agentes, respostas) |

**Ações**

| Ferramenta | O que faz |
|---|---|
| `gerar_rascunho` | IA escreve e-mail ou texto de LinkedIn → vai para Aprovações / LinkedIn |
| `editar_rascunho` | Altera assunto/texto de um rascunho pendente |
| `descartar_rascunho` | Descarta um rascunho |
| `adicionar_nota` | Nota no histórico do card |
| `mover_card` | Muda a etapa do card |
| `iniciar_cadencia` | Inicia a cadência para 1 ou mais cards (até 200) |
| `controlar_cadencia` | Pausar, retomar ou encerrar a cadência de um card |
| `registrar_resposta_recebida` | Registra resposta do lead vinda de fora (LinkedIn, colada) |
| `enviar_empresas_ao_funil` | Cria cards a partir da Base de leads |
| `importar_cnpjs_receita` | Importa CNPJs da base da Receita para o funil |

**De propósito, não existem:** enviar e-mail, aprovar envio, excluir cards/empresas, gerenciar usuários e senhas, alterar configurações de agentes. Isso continua só pela tela do sistema.

---

## 5. Cuidados

- **Confira antes de confirmar ações em lote** ("inicie a cadência para 50 cards"): peça ao Claude para listar primeiro e só depois executar.
- Iniciar cadência com o agente em modo **Autônomo** faz o sistema enviar os e-mails sozinho quando a automação rodar (regra do próprio sistema, não do Claude). Em modo com aprovação, eles esperam em Aprovações.
- `gerar_rascunho` consome créditos da IA (como na tela).
- O Claude só vê o que o sistema guarda. E-mails respondidos direto pelo webmail não aparecem.

---

## 6. Problemas comuns

| Sintoma | Solução |
|---|---|
| sdr-fd não aparece nas ferramentas | Feche o Claude Desktop pela bandeja e abra de novo |
| Erro de conexão com o banco / "ECONNREFUSED" | O Postgres local está desligado: ligue o banco (ou peça "suba a aplicação") |
| "Erro do sistema: not_found" | ID errado ou o item não existe: peça para buscar pelo nome |
| "Erro do sistema: forbidden" | O usuário configurado não tem permissão para aquela ação |
| `buscar_cnpj_receita` volta vazio | A base da Receita ainda não foi carregada no PC (ver script `load-cnpj.js`) |

**Detalhes técnicos (para manutenção)**
- Servidor: `SDR-FD/scripts/mcp-server.js` (stdio), chama as mesmas rotas da API em processo (validação, permissões e auditoria iguais às da tela).
- Claude Desktop: `%APPDATA%\Claude\claude_desktop_config.json`, entrada `sdr-fd` (backup da versão anterior ao lado, `.bak-AAAAMMDD`).
- Claude Code: `claude mcp list` / `claude mcp remove sdr-fd --scope user`.
- Usuário: variável `MCP_USER_EMAIL` na configuração.
