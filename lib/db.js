// Pool pg singleton, reaproveitado entre invocações da função serverless
// (evita abrir uma conexão nova a cada requisição em instâncias "quentes").
// Em produção (Neon) a connection string já traz sslmode=require.
const { Pool } = require("pg");

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  }
  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

module.exports = { getPool, query };
