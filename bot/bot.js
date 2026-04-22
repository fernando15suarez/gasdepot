#!/usr/bin/env node

// gt-bot — Telegram bridge for Gas Town, bundled with gasdepot.
//
// Inbound:  Telegram text in an authorized chat -> `gt mail send mayor/ --stdin`
//           plus `gt nudge mayor ...` for immediate delivery.
// Outbound: HTTP POST /send { message, chat? } -> sends via Telegram bot API.
//
// Unauthorized chats are silently ignored (logged at debug). v0 is text-only
// and does not handle voice, documents, commands, or mail polling — those are
// follow-up beads. See README.md.

const http = require("http");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { Bot } = require("grammy");

const config = require("./config");

const execFileAsync = promisify(execFile);

// --- Permissions cache -------------------------------------------------

// Loaded once at startup. SIGHUP reloads from Dolt (cheap — one SELECT).
let perms = {};

async function reloadPerms() {
  perms = await config.loadAllPermissions();
}

function isAuthorized(chatId) {
  return String(chatId) in perms;
}

function isAdmin(chatId) {
  const p = perms[String(chatId)];
  return !!p && p.role === "admin";
}

function allowedRigs(chatId) {
  const p = perms[String(chatId)];
  return p ? p.rigs : [];
}

function hasRigAccess(chatId, rig) {
  const rigs = allowedRigs(chatId);
  return rigs.includes("*") || rigs.includes(rig);
}

function allChatsByRole(role) {
  return Object.entries(perms)
    .filter(([, p]) => p.role === role)
    .map(([id]) => id);
}

// --- gt bridging --------------------------------------------------------

function gtAvailable() {
  try {
    require("child_process").execFileSync("gt", ["--help"], {
      stdio: "ignore",
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

async function gtMailSend(target, subject, body) {
  const proc = execFileAsync("gt", ["mail", "send", target, "-s", subject, "--stdin"], {
    timeout: 30000,
  });
  proc.child.stdin.write(body);
  proc.child.stdin.end();
  const { stderr } = await proc;
  if (stderr) console.error("gt mail send stderr:", stderr);
}

async function gtNudge(target, text) {
  await execFileAsync("gt", ["nudge", target, text, "--mode", "immediate"], {
    timeout: 10000,
  });
}

// --- Inbound: Telegram text -> gt mail ---------------------------------

async function handleTelegramText(ctx) {
  const chatId = String(ctx.chat.id);
  if (!isAuthorized(chatId)) {
    if (process.env.DEBUG) console.log(`[debug] ignoring chat ${chatId}`);
    return;
  }

  const from = ctx.from?.first_name || ctx.from?.username || "unknown";
  const text = ctx.message.text || "";
  const rigs = allowedRigs(chatId);
  const rigScope = rigs.includes("*") ? null : rigs;

  const rigTag = rigScope ? ` [rigs:${rigScope.join(",")}]` : "";
  const subject = `Telegram from ${from}${rigTag}: ${text.slice(0, 60)}`;
  const body = rigScope
    ? `[Chat ${chatId} — access: ${rigScope.join(", ")}]\n[From: ${from}]\n\n${text}`
    : text;

  try {
    await gtMailSend("mayor/", subject, body);
  } catch (err) {
    console.error("gt mail send failed:", err.message);
    try { await ctx.reply("Failed to deliver message to Gas Town."); } catch {}
    return;
  }

  try {
    const nudgeText = `[Telegram from ${from}]: ${text}\n\nReply via: curl -s -X POST http://localhost:${config.port()}/send -H 'Content-Type: application/json' -d '{"message":"your reply","chat":"${chatId}"}'`;
    await gtNudge("mayor", nudgeText);
  } catch (err) {
    // Nudge failure is non-fatal — the mail is already durable.
    console.error("gt nudge failed (non-fatal):", err.message);
  }

  console.log(`forwarded to mayor: ${subject}`);
}

// --- Outbound: HTTP /send ----------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

function jsonResponse(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function handleSend(bot, req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    return jsonResponse(res, 400, { error: "invalid JSON" });
  }

  const { message, chat } = payload || {};
  if (!message || typeof message !== "string") {
    return jsonResponse(res, 400, { error: "message field required" });
  }

  let targets;
  if (chat) {
    const id = String(chat);
    if (!isAuthorized(id)) {
      return jsonResponse(res, 403, { error: `chat ${id} not in permissions` });
    }
    targets = [id];
  } else {
    targets = allChatsByRole("admin");
    if (targets.length === 0) {
      return jsonResponse(res, 200, { ok: true, delivered: [], note: "no admin chats configured" });
    }
  }

  const delivered = [];
  for (const id of targets) {
    try {
      await bot.api.sendMessage(id, message);
      delivered.push({ chat: id, ok: true });
    } catch (err) {
      delivered.push({ chat: id, ok: false, error: err.message });
    }
  }
  console.log(`HTTP /send: "${message.slice(0, 60)}" -> ${targets.join(",")}`);
  jsonResponse(res, 200, { ok: true, delivered });
}

function startHttpServer(bot) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/send") {
        return await handleSend(bot, req, res);
      }
      if (req.method === "GET" && req.url === "/health") {
        return jsonResponse(res, 200, {
          ok: true,
          port: config.port(),
          permissions: Object.keys(perms).length,
        });
      }
      jsonResponse(res, 404, { error: "not found" });
    } catch (err) {
      console.error("HTTP handler error:", err);
      try { jsonResponse(res, 500, { error: err.message }); } catch {}
    }
  });

  server.listen(config.port(), () => {
    console.log(`gt-bot HTTP API on http://localhost:${config.port()}`);
  });
  return server;
}

// --- Main ---------------------------------------------------------------

async function main() {
  const token = config.requireToken();

  await reloadPerms();
  if (Object.keys(perms).length === 0) {
    console.error(
      "gt-bot refuses to start: no rows in gt_bot.permissions.\n" +
        "Run: node bin/gt-bot perms add <chat_id> --role admin --label \"your label\""
    );
    process.exit(1);
  }
  console.log(`Loaded ${Object.keys(perms).length} permission row(s) from Dolt.`);

  if (!gtAvailable()) {
    console.warn("Warning: `gt` CLI not found on PATH. Inbound messages will fail to forward to mayor.");
  }

  const bot = new Bot(token);
  bot.on("message:text", handleTelegramText);
  bot.catch((err) => console.error("grammy error:", err));

  process.on("SIGHUP", async () => {
    try {
      await reloadPerms();
      console.log(`Reloaded permissions (${Object.keys(perms).length} rows).`);
    } catch (err) {
      console.error("SIGHUP reload failed:", err.message);
    }
  });

  startHttpServer(bot);

  // Run Telegram polling alongside HTTP. A polling failure (bad token,
  // network blip) logs but does not tear down the HTTP server — mayor can
  // still queue outbound sends, and we'll surface the error in the logs.
  bot
    .start({
      onStart: (info) => console.log(`gt-bot Telegram polling started as @${info.username}`),
    })
    .catch((err) => {
      console.error("Telegram polling stopped:", err.message);
    });

  // Keep the event loop alive indefinitely (the HTTP server's listen already
  // does this, but be explicit for clarity).
}

module.exports = { main };

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal:", err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  });
}
