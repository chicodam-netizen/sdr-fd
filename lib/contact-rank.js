// Qual contato da empresa usar na prospecção: pessoa com e-mail > canal comercial > outros canais.
// Caixas de RH, currículos, financeiro, fiscal etc. nunca são escolhidas.

// Parte local de e-mail que não serve para prospecção (em qualquer posição do endereço).
const NON_SALES_EMAIL = /(^|[._-])(nfe|nf-e|nfse|xml|fiscal|tax|contab|cobranca|boleto|faturamento|danfe|financeiro|rh|dp\d*|curriculo|curriculos|vagas|trabalheconosco|recrutamento|compras)([._-]|\d|$)/i;
const SALES_HINT = /(comercial|vendas|contato|atendimento|sac|orcamento|negocios|marketing)/i;

function isNonSalesEmail(email) {
  return NON_SALES_EMAIL.test(String(email || "").split("@")[0]);
}

// Trecho SQL para ordenar contatos (tabela com alias livre: usa as colunas kind, name, email, created_at).
const BEST_CONTACT_ORDER = `(kind = 'person') DESC,
  CASE WHEN (name || ' ' || split_part(email, '@', 1)) ~* '(comercial|vendas|contato|atendimento|sac|orcamento|negocios)' THEN 0 ELSE 1 END,
  created_at`;

// Filtro SQL que exclui caixas que não servem para prospecção.
const SALES_EMAIL_FILTER = `split_part(email, '@', 1) !~* '(^|[._-])(nfe|nf-e|nfse|xml|fiscal|tax|contab|cobranca|boleto|faturamento|danfe|financeiro|rh|dp[0-9]*|curriculo|curriculos|vagas|trabalheconosco|recrutamento|compras)([._-]|[0-9]|$)'`;

module.exports = { isNonSalesEmail, SALES_HINT, BEST_CONTACT_ORDER, SALES_EMAIL_FILTER };
