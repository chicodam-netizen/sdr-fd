// Carregado antes de todos os testes (npm test): testes nunca enviam e-mail de verdade nem chamam a IA,
// mesmo que o .env.local esteja com MAIL_ENABLED=true.
process.env.MAIL_ENABLED = "false";
process.env.MAIL_REDIRECT_TO = process.env.MAIL_REDIRECT_TO || "teste-redirect@teste.local";
process.env.AI_FAKE = "1";
