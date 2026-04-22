// Dolt connection helper — port 3307, no password, root user.
// Callers may pass `database` to bind to gt_bot; init-time callers
// should omit it (database doesn't exist yet).

const mysql = require("mysql2/promise");

function doltPort() {
  return parseInt(process.env.GT_DOLT_PORT || "3307", 10);
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
