// Dolt connection helper — port 3307, no password, root user.
// Callers may pass `database` to bind to gt_bot; init-time callers
// should omit it (database doesn't exist yet).

const mysql = require("mysql2/promise");

function doltPort() {
  // Accept either GT_DOLT_PORT (gt-bot's own var) or DOLT_PORT (the var the
  // gasdepot entrypoint and .env.example use). They must agree; treat
  // GT_DOLT_PORT as the authoritative override and fall back to DOLT_PORT
  // before defaulting to 3307. Without this, a user who sets DOLT_PORT=3308
  // to dodge a host collision ends up with Dolt on 3308 and the bot still
  // dialing 3307.
  return parseInt(
    process.env.GT_DOLT_PORT || process.env.DOLT_PORT || "3307",
    10,
  );
}

async function connect({ database } = {}) {
  return mysql.createConnection({
    host: "127.0.0.1",
    port: doltPort(),
    user: "root",
    password: "",
    multipleStatements: true,
    ...(database ? { database } : {}),
  });
}

async function withConnection(fn, opts) {
  const conn = await connect(opts);
  try {
    return await fn(conn);
  } finally {
    await conn.end().catch(() => {});
  }
}

module.exports = { connect, withConnection, doltPort };
