// Inscreve em lote os cards recém-criados na cadência do agente; conta os que ficaram de fora e por quê.
const { HttpError } = require("./http");
const { enroll } = require("./cadence");

async function enrollCreated(user, dealIds) {
  const r = { enrolled: 0, skipped: {} };
  for (const dealId of dealIds) {
    try {
      await enroll({ user, dealId });
      r.enrolled++;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      r.skipped[err.code] = (r.skipped[err.code] || 0) + 1;
    }
  }
  return r;
}

module.exports = { enrollCreated };
