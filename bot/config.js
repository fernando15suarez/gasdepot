// gt-bot config loader.
//
// Secrets (TELEGRAM_BOT_TOKEN) come from env/.env.
// Permissions (chat_id -> role/rigs) live in Dolt (gt_bot.permissions).

const path = require("path");
const fs = require("fs");

// Load .env from the bot dir if present. Real env vars always win.
const ENV_PATH = path.join(__dirname, ".env");
if (fs.existsSync(ENV_PATH)) {
  require("dotenv").config({ path: ENV_PATH });
}

const { withConnection } = require("./db");

function requireToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error(
      "TELEGRAM_BOT_TOKEN is required. Set it in the environment or in " +
        path.join(__dirname, ".env") + " (see .env.example)."
    );
    process.exit(1);
  }
  return token;
}

function port() {
  return parseInt(process.env.GT_BOT_PORT || "3335", 10);
}

// --- Permissions access ---

async function loadAllPermissions() {
  return withConnection(async (conn) => {
    const [rows] = await conn.query(
      "SELECT chat_id, role, rigs, label, created_at FROM permissions"
    );
    const map = {};
    for (const r of rows) {
      map[String(r.chat_id)] = {
        role: r.role,
        rigs: String(r.rigs || "*")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        label: r.label || null,
      };
    }
    return map;
  }, { database: "gt_bot" });
}

async function countPermissions() {
  return withConnection(async (conn) => {
    const [rows] = await conn.query("SELECT COUNT(*) AS n FROM permissions");
    return Number(rows[0].n);
  }, { database: "gt_bot" });
}

async function addPermission({ chatId, role = "user", rigs = "*", label = null }) {
  return withConnection(async (conn) => {
    await conn.query(
      "INSERT INTO permissions (chat_id, role, rigs, label) VALUES (?, ?, ?, ?) " +
        "ON DUPLICATE KEY UPDATE role = VALUES(role), rigs = VALUES(rigs), label = VALUES(label)",
      [String(chatId), role, rigs, label]
    );
  }, { database: "gt_bot" });
}

async function removePermission(chatId) {
  return withConnection(async (conn) => {
    const [res] = await conn.query(
      "DELETE FROM permissions WHERE chat_id = ?",
      [String(chatId)]
    );
    return res.affectedRows;
  }, { database: "gt_bot" });
}

async function listPermissions() {
  return withConnection(async (conn) => {
    const [rows] = await conn.query(
      "SELECT chat_id, role, rigs, label, created_at FROM permissions ORDER BY created_at"
    );
    return rows;
  }, { database: "gt_bot" });
}

module.exports = {
  requireToken,
  port,
  loadAllPermissions,
  countPermissions,
  addPermission,
  removePermission,
  listPermissions,
};
