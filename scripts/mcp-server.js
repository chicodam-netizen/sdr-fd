// Servidor MCP (stdio) do SDR FD: dá ao Claude acesso ao sistema por conversa.
// Uso (o Claude Desktop/Claude Code inicia este processo sozinho):
//   node --env-file=D:\...\SDR-FD\.env.local D:\...\SDR-FD\scripts\mcp-server.js
// Opcional: MCP_USER_EMAIL=usuario@empresa  (padrão: o único admin ativo).
//
// Segurança: as ferramentas chamam as mesmas rotas da API (validação, papéis e auditoria).
// Não há ferramenta de ENVIO de e-mail, exclusão, usuários ou senhas: o envio continua
// exigindo aprovação na tela Aprovações do sistema.

// stdout é o canal do protocolo: qualquer log vai para stderr.
console.log = console.error;
console.info = console.error;
console.warn = console.error;

const { dispatch } = require("../api/index");
const { query } = require("../lib/db");
const { HttpError } = require("../lib/http");

const SERVER = { name: "sdr-fd", version: "1.0.0" };
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

let currentUser = null;
async function loadUser() {
  if (currentUser) return currentUser;
  const email = (process.env.MCP_USER_EMAIL || "").trim().toLowerCase();
  const { rows } = await query(
    `SELECT u.id, u.organization_id, u.name, u.email, u.role, o.name AS organization_name
     FROM users u JOIN organizations o ON o.id = u.organization_id
     WHERE u.active AND ($1 = '' OR lower(u.email) = $1)
     ORDER BY (u.role = 'admin') DESC, u.created_at`,
    [email]
  );
  if (!rows.length) throw new Error(email ? `Usuário ${email} não encontrado ou inativo.` : "Nenhum usuário ativo.");
  if (!email && rows.filter((r) => r.role === "admin").length > 1) {
    throw new Error("Há mais de um admin: defina MCP_USER_EMAIL na configuração do MCP.");
  }
  const r = rows[0];
  currentUser = { id: r.id, organizationId: r.organization_id, organizationName: r.organization_name, name: r.name, email: r.email, role: r.role, mustChangePassword: false };
  return currentUser;
}

const call = async (method, path, opts = {}) => dispatch({ method, path, user: await loadUser(), ...opts });

// Limita listas grandes para não estourar o contexto do Claude.
function cap(items, limit = 50) {
  const n = Math.max(1, Math.min(500, Number(limit) || 50));
  return { total: items.length, mostrando: Math.min(n, items.length), itens: items.slice(0, n) };
}

async function defaultPipelineId(id) {
  if (id) return id;
  const { pipelines } = await call("GET", "/pipelines");
  const p = (pipelines || []).find((x) => !x.archivedAt) || pipelines?.[0];
  if (!p) throw new HttpError(404, "no_pipeline");
  return p.id;
}

const uuid = { type: "string", description: "ID (UUID)" };
const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });
const bool = (description) => ({ type: "boolean", description });
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const RO = { readOnlyHint: true, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const TOOLS = [
  // ---------- Leitura ----------
  {
    name: "painel",
    description: "Resumo geral do SDR FD (números do painel inicial: cards, conversas, envios, pendências).",
    inputSchema: obj({}),
    annotations: RO,
    run: () => call("GET", "/dashboard"),
  },
  {
    name: "listar_funis",
    description: "Lista os funis e suas etapas (com IDs). Use para saber o etapaId ao mover cards ou enviar empresas ao funil.",
    inputSchema: obj({}),
    annotations: RO,
    run: () => call("GET", "/pipelines"),
  },
  {
    name: "buscar_cards",
    description: "Lista/busca cards (negócios) de um funil. Busca por título, empresa, contato, e-mail ou CNPJ. Sem funilId usa o funil principal.",
    inputSchema: obj({ funilId: uuid, busca: str("Texto a procurar (opcional)"), limite: num("Máximo de cards no retorno (padrão 50)") }),
    annotations: RO,
    run: async (a) => {
      const r = await call("GET", "/deals", { query: { pipelineId: await defaultPipelineId(a.funilId), q: a.busca } });
      return cap(r.deals, a.limite);
    },
  },
  {
    name: "ver_card",
    description: "Detalhe completo de um card: empresa, contato, etapa, histórico de atividades, mensagens (e-mails/LinkedIn) e situação da cadência.",
    inputSchema: obj({ cardId: uuid }, ["cardId"]),
    annotations: RO,
    run: async (a) => {
      const [card, msgs, cad] = await Promise.all([
        call("GET", `/deals/${a.cardId}`),
        call("GET", `/deals/${a.cardId}/messages`),
        call("GET", `/deals/${a.cardId}/enrollment`),
      ]);
      return { ...card, mensagens: msgs.messages, cadencia: cad };
    },
  },
  {
    name: "buscar_empresas",
    description: "Busca empresas cadastradas no sistema por nome, CNPJ, cidade ou segmento.",
    inputSchema: obj({ busca: str("Texto a procurar"), limite: num("Máximo no retorno (padrão 50)") }),
    annotations: RO,
    run: async (a) => cap((await call("GET", "/companies", { query: { q: a.busca } })).companies, a.limite),
  },
  {
    name: "ver_empresa",
    description: "Detalhe de uma empresa: dados cadastrais, contatos e cards.",
    inputSchema: obj({ empresaId: uuid }, ["empresaId"]),
    annotations: RO,
    run: (a) => call("GET", `/companies/${a.empresaId}`),
  },
  {
    name: "base_de_leads",
    description: "Consulta a Base de leads (empresas prospectadas), com filtros e paginação (50 por página).",
    inputSchema: obj({
      busca: str("Nome, CNPJ ou segmento"),
      cidade: str("Cidade exata"),
      setor: str("Setor exato"),
      porte: { type: "string", enum: ["micro", "pequeno", "demais"], description: "Porte (demais = médias e grandes)" },
      minFuncionarios: num("Mínimo de funcionários"),
      maxFuncionarios: num("Máximo de funcionários"),
      lista: str("Nome da lista de importação"),
      contato: { type: "string", enum: ["with", "without"], description: "with = com e-mail de contato; without = sem" },
      noFunil: { type: "string", enum: ["yes", "no"], description: "yes = já está no funil; no = ainda não" },
      ordem: str("recent | priority | employees | name | city | sector | contacts (sufixo _asc/_desc opcional)"),
      pagina: num("Página (padrão 1)"),
    }),
    annotations: RO,
    run: (a) =>
      call("GET", "/leadbase", {
        query: {
          q: a.busca, city: a.cidade, sector: a.setor, size: a.porte, minEmployees: a.minFuncionarios, maxEmployees: a.maxFuncionarios,
          list: a.lista, contact: a.contato, inPipeline: a.noFunil, order: a.ordem, page: a.pagina,
        },
      }),
  },
  {
    name: "buscar_cnpj_receita",
    description: "Pesquisa empresas na base da Receita Federal carregada localmente (exige UF, CNAE ou texto). Retorna CNPJs que podem ser importados para o funil.",
    inputSchema: obj({
      uf: str("Sigla da UF, ex.: MG"),
      municipio: str("Nome do município"),
      cnae: str("Prefixos de CNAE separados por vírgula, ex.: 10,62"),
      porte: str("micro, pequeno, demais, nao_informado (separados por vírgula)"),
      busca: str("Trecho da razão social ou nome fantasia"),
      comEmail: bool("Só com e-mail"),
      comTelefone: bool("Só com telefone"),
      somenteMatriz: bool("Só matrizes"),
      foraDaBase: bool("Só as que ainda não estão no sistema"),
      pagina: num("Página (padrão 1)"),
    }),
    annotations: RO,
    run: (a) =>
      call("GET", "/sourcing/cnpj", {
        query: {
          uf: a.uf, municipio: a.municipio, cnae: a.cnae, porte: a.porte, q: a.busca, page: a.pagina,
          hasEmail: a.comEmail ? 1 : "", hasPhone: a.comTelefone ? 1 : "", matriz: a.somenteMatriz ? 1 : "", notInBase: a.foraDaBase ? 1 : "",
        },
      }),
  },
  {
    name: "aprovacoes_pendentes",
    description: "Rascunhos de e-mail aguardando aprovação (com a última mensagem do lead quando for resposta).",
    inputSchema: obj({ limite: num("Máximo no retorno (padrão 50)") }),
    annotations: RO,
    run: async (a) => cap((await call("GET", "/messages/pending")).messages, a.limite),
  },
  {
    name: "tarefas_linkedin",
    description: "Tarefas de LinkedIn pendentes (pedidos de conexão, mensagens e respostas) com o texto preparado pela IA.",
    inputSchema: obj({ limite: num("Máximo no retorno (padrão 50)") }),
    annotations: RO,
    run: async (a) => cap((await call("GET", "/linkedin/tasks")).tasks, a.limite),
  },
  {
    name: "cadencias_visao_geral",
    description: "Visão geral das cadências: cards em cadência por agente, aguardando aprovação, pausados, próximos passos.",
    inputSchema: obj({}),
    annotations: RO,
    run: () => call("GET", "/cadences/overview"),
  },
  {
    name: "listar_agentes",
    description: "Lista os agentes SDR (IA) com seus IDs e configurações.",
    inputSchema: obj({}),
    annotations: RO,
    run: () => call("GET", "/agents"),
  },
  {
    name: "ver_cadencia_agente",
    description: "Passos da cadência de um agente (canal, dias de espera, instruções).",
    inputSchema: obj({ agenteId: uuid }, ["agenteId"]),
    annotations: RO,
    run: (a) => call("GET", `/agents/${a.agenteId}/cadence`),
  },
  {
    name: "relatorio",
    description: "Relatório do período: funil, conversão por etapa, desempenho por agente, envios diários, categorias de resposta e cadências.",
    inputSchema: obj({ dias: num("Período em dias (padrão 30, máx. 365)"), funilId: uuid }),
    annotations: RO,
    run: (a) => call("GET", "/reports", { query: { days: a.dias, pipelineId: a.funilId } }),
  },

  // ---------- Ações (nada é enviado ao lead por aqui) ----------
  {
    name: "gerar_rascunho",
    description: "A IA escreve um rascunho para o card. O rascunho vai para Aprovações (e-mail) ou para o menu LinkedIn; NÃO é enviado.",
    inputSchema: obj(
      {
        cardId: uuid,
        agenteId: uuid,
        tipo: { type: "string", enum: ["first", "followup", "reply"], description: "first = 1º contato; followup; reply = resposta. Omitir = automático" },
        instrucao: str("Orientação extra para a IA (opcional)"),
        canal: { type: "string", enum: ["email", "linkedin_connect", "linkedin_message"], description: "Padrão: email" },
      },
      ["cardId"]
    ),
    annotations: RW,
    run: (a) =>
      call("POST", `/deals/${a.cardId}/messages/draft`, { body: { agentId: a.agenteId, kind: a.tipo, instruction: a.instrucao, channel: a.canal } }),
  },
  {
    name: "editar_rascunho",
    description: "Altera assunto/texto de um rascunho pendente (não envia). Para e-mail o assunto é obrigatório.",
    inputSchema: obj({ mensagemId: uuid, assunto: str("Assunto (e-mail)"), texto: str("Corpo da mensagem") }, ["mensagemId", "texto"]),
    annotations: RW,
    run: (a) => call("PATCH", `/messages/${a.mensagemId}`, { body: { subject: a.assunto, body: a.texto } }),
  },
  {
    name: "descartar_rascunho",
    description: "Descarta um rascunho pendente (se for de cadência, a cadência segue as regras do sistema).",
    inputSchema: obj({ mensagemId: uuid }, ["mensagemId"]),
    annotations: { ...RW, destructiveHint: true },
    run: (a) => call("POST", `/messages/${a.mensagemId}/discard`),
  },
  {
    name: "adicionar_nota",
    description: "Adiciona uma nota ao histórico do card.",
    inputSchema: obj({ cardId: uuid, texto: str("Texto da nota") }, ["cardId", "texto"]),
    annotations: RW,
    run: (a) => call("POST", `/deals/${a.cardId}/notes`, { body: { body: a.texto } }),
  },
  {
    name: "mover_card",
    description: "Move o card para outra etapa do funil (IDs das etapas em listar_funis). Mover para Qualificado/Desqualificado encerra a cadência.",
    inputSchema: obj({ cardId: uuid, etapaId: uuid }, ["cardId", "etapaId"]),
    annotations: RW,
    run: (a) => call("POST", `/deals/${a.cardId}/move`, { body: { stageId: a.etapaId } }),
  },
  {
    name: "iniciar_cadencia",
    description: "Inicia a cadência do agente para um ou mais cards (até 200). Sem agenteId usa o agente do card. Não duplica 1º contato.",
    inputSchema: obj({ cardIds: { type: "array", items: { type: "string" }, description: "IDs dos cards" }, agenteId: uuid }, ["cardIds"]),
    annotations: RW,
    run: (a) => call("POST", "/enrollments/bulk", { body: { dealIds: a.cardIds, agentId: a.agenteId } }),
  },
  {
    name: "controlar_cadencia",
    description: "Pausa, retoma ou encerra a cadência de um card (o ID da inscrição aparece em ver_card → cadencia).",
    inputSchema: obj({ inscricaoId: uuid, acao: { type: "string", enum: ["pause", "resume", "stop"] } }, ["inscricaoId", "acao"]),
    annotations: RW,
    run: (a) => {
      if (!["pause", "resume", "stop"].includes(a.acao)) throw new HttpError(400, "invalid_action");
      return call("POST", `/enrollments/${a.inscricaoId}/${a.acao}`);
    },
  },
  {
    name: "registrar_resposta_recebida",
    description: "Registra uma resposta do lead recebida fora do sistema (ex.: LinkedIn, WhatsApp colado). A IA classifica, para a cadência e prepara rascunho de resposta.",
    inputSchema: obj(
      { cardId: uuid, texto: str("Texto recebido do lead"), assunto: str("Assunto (opcional)"), canal: { type: "string", enum: ["email", "linkedin"] } },
      ["cardId", "texto"]
    ),
    annotations: RW,
    run: (a) => call("POST", `/deals/${a.cardId}/messages/inbound`, { body: { body: a.texto, subject: a.assunto, channel: a.canal } }),
  },
  {
    name: "enviar_empresas_ao_funil",
    description: "Cria cards no funil para empresas da Base de leads (opcionalmente já iniciando a cadência do agente).",
    inputSchema: obj(
      {
        empresaIds: { type: "array", items: { type: "string" } },
        funilId: uuid,
        etapaId: uuid,
        agenteId: uuid,
        iniciarCadencia: bool("Iniciar a cadência do agente (exige agenteId)"),
      },
      ["empresaIds", "funilId", "etapaId"]
    ),
    annotations: RW,
    run: (a) =>
      call("POST", "/leadbase/to-pipeline", {
        body: { companyIds: a.empresaIds, pipelineId: a.funilId, stageId: a.etapaId, agentId: a.agenteId, startCadence: Boolean(a.iniciarCadencia) },
      }),
  },
  {
    name: "importar_cnpjs_receita",
    description: "Importa CNPJs (encontrados em buscar_cnpj_receita) para o sistema, criando os cards no funil.",
    inputSchema: obj(
      {
        cnpjs: { type: "array", items: { type: "string" } },
        funilId: uuid,
        etapaId: uuid,
        agenteId: uuid,
        iniciarCadencia: bool("Iniciar a cadência do agente (exige agenteId)"),
      },
      ["cnpjs", "funilId", "etapaId"]
    ),
    annotations: RW,
    run: (a) =>
      call("POST", "/sourcing/import", {
        body: { source: "cnpj", cnpjs: a.cnpjs, pipelineId: a.funilId, stageId: a.etapaId, agentId: a.agenteId, startCadence: Boolean(a.iniciarCadencia) },
      }),
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

async function handle(msg) {
  const { id, method, params = {} } = msg;
  switch (method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER,
        instructions:
          "SDR FD: CRM de prospecção B2B com agentes de IA. Use buscar_cards/base_de_leads para encontrar IDs antes das ações. " +
          "Nenhuma ferramenta envia e-mail ou mensagem ao lead: rascunhos ficam em Aprovações (e-mail) ou no menu LinkedIn para o usuário aprovar. " +
          "Responda ao usuário em português.",
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS.map(({ run, ...t }) => t) };
    case "tools/call": {
      const tool = byName.get(params.name);
      if (!tool) throw Object.assign(new Error(`Ferramenta desconhecida: ${params.name}`), { code: -32602 });
      try {
        const result = await tool.run(params.arguments || {});
        return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
      } catch (err) {
        const text = err instanceof HttpError ? `Erro do sistema: ${err.code} (HTTP ${err.status})` : `Erro: ${err.message || err}`;
        if (!(err instanceof HttpError)) console.error(`[mcp] ${params.name}:`, err);
        return { content: [{ type: "text", text }], isError: true };
      }
    }
    default:
      if (id === undefined) return undefined; // notificação (ex.: notifications/initialized)
      throw Object.assign(new Error(`Método não suportado: ${method}`), { code: -32601 });
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    handle(msg).then(
      (result) => {
        if (msg.id !== undefined && result !== undefined) send({ jsonrpc: "2.0", id: msg.id, result });
      },
      (err) => {
        if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: err.code || -32603, message: err.message || "Erro interno" } });
      }
    );
  }
});
process.stdin.on("end", async () => {
  try {
    await require("../lib/db").getPool().end();
  } catch {}
  process.exit(0);
});
console.error(`[mcp] ${SERVER.name} ${SERVER.version} pronto (${TOOLS.length} ferramentas).`);
