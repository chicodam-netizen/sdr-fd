// Lê a caixa de prospecção uma vez (IMAP_* no .env.local) e registra as respostas nos cards.
const { pollInbox } = require("../lib/inbox");
const { getPool } = require("../lib/db");

pollInbox()
  .then((r) => console.log(JSON.stringify(r, null, 2)))
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
