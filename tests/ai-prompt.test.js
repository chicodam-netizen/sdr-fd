// O prompt do agente: foco no objetivo do cadastro, base geral x base do agente, e histórico de outro agente.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { _internals } = require("../lib/ai");
const { agentSystemPrompt, threadContext, leadContext } = _internals;

const agent = { id: "k", sender_name: "Karla", sender_title: "Especialista ISO 9001", objective: "Diagnóstico ISO 9001", rules: "", persona: "" };

test("prompt separa documentos gerais dos do agente e fixa o foco no objetivo", () => {
  const p = agentSystemPrompt(agent, [
    { title: "Sobre a empresa", content: "Governança de dados e LGPD", agent_id: null },
    { title: "Oferta ISO", content: "Diagnóstico de qualidade", agent_id: "k" },
  ], "FD");
  assert.match(p, /<documentos_gerais_da_empresa>[\s\S]*Governança de dados[\s\S]*<\/documentos_gerais_da_empresa>/);
  assert.match(p, /<documentos_do_agente>[\s\S]*Diagnóstico de qualidade[\s\S]*<\/documentos_do_agente>/);
  assert.match(p, /FOCO: o assunto das suas mensagens é definido pelo seu cadastro/);
  assert.match(p, /<objetivo>\nDiagnóstico ISO 9001/);
});

test("histórico marca mensagens enviadas por outro agente", () => {
  const t = threadContext([
    { direction: "out", agent_id: "a", agent_name: "Ana", subject: "LGPD", body: "x", created_at: new Date() },
    { direction: "out", agent_id: "k", agent_name: "Karla", subject: "ISO", body: "y", created_at: new Date() },
    { direction: "in", subject: "Re", body: "z", created_at: new Date() },
  ], [], "k");
  assert.match(t, /Enviado por outro agente \(Ana\)/);
  assert.match(t, /Enviado por nós/);
  assert.match(t, /Recebido do lead/);
});

test("contexto do lead traz segmento e atividade", () => {
  const l = leadContext({ company: { name: "X", sector: "Metalurgia", segment: "Fundição" }, contact: null, stageName: "Novo" });
  assert.match(l, /Segmento: Metalurgia/);
  assert.match(l, /Atividade: Fundição/);
});
