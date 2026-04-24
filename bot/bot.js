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
const { promises: fsp } = require("fs");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { Bot } = require("grammy");

const config = require("./config");

const execFileAsync = promisify(execFile);

// Mayor session — used by the busy-notice probe. Hardcoded layout
// because the bot is shipped as part of mayor's stack; if mayor lives
// somewhere else, set GT_MAYOR_CWD.
const MAYOR_CWD = process.env.GT_MAYOR_CWD
  || `${process.env.GT_TOWN_ROOT || "/gastown/repos/hq"}/mayor`;
const CLAUDE_HOME = process.env.CLAUDE_HOME
  || `${process.env.HOME || "/home/gastown"}/.claude`;

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

// `gt mail send` / `gt nudge` need to know where the Gas Town HQ lives —
// otherwise they fail with "not in a Gas Town workspace." We source the
// path from GT_TOWN_ROOT (the same env var `gt install --shell` sets) and
// pass it to every subprocess as both cwd and an explicit env var so gt
// finds it regardless of which resolution path it takes internally.
function gtEnv(extra = {}) {
  const townRoot = process.env.GT_TOWN_ROOT;
  const env = { ...process.env, ...extra };
  if (townRoot) env.GT_TOWN_ROOT = townRoot;
  return {
    cwd: townRoot || process.cwd(),
    env,
  };
}

async function gtMailSend(target, subject, body) {
  const proc = execFileAsync("gt", ["mail", "send", target, "-s", subject, "--stdin"], {
    timeout: 30000,
    ...gtEnv(),
  });
  proc.child.stdin.write(body);
  proc.child.stdin.end();
  const { stderr } = await proc;
  if (stderr) console.error("gt mail send stderr:", stderr);
}

async function gtNudge(target, text) {
  await execFileAsync("gt", ["nudge", target, text, "--mode", "immediate"], {
    timeout: 10000,
    ...gtEnv(),
  });
}

// --- Busy-notice probe -------------------------------------------------
//
// Goal: when a user pings mayor, tell them inline if mayor is mid-work
// so they don't sit watching a silent chat. We read the live Claude Code
// transcript (jsonl) — every prompt and tool call is appended in real
// time, so we can infer "busy" without communicating with mayor at all.
//
// Heuristic: mayor is BUSY iff the most recent activity was within the
// last BUSY_WINDOW_SEC seconds AND the latest assistant message issued
// at least one tool_use (so the agent is in a tool/result loop, not
// awaiting a new user prompt). Anything older or any text-only assistant
// reply means mayor is idle / between turns.

const BUSY_WINDOW_SEC = 30;

async function readMayorSessionId() {
  try {
    const buf = await fsp.readFile(`${MAYOR_CWD}/.runtime/session_id`, "utf8");
    return buf.split("\n")[0].trim() || null;
  } catch { return null; }
}

async function readTranscriptTail(sid, n = 50) {
  if (!sid) return [];
  // Claude Code project dir = cwd with `/` replaced by `-`.
  const projDir = MAYOR_CWD.replace(/\//g, "-");
  const file = `${CLAUDE_HOME}/projects/${projDir}/${sid}.jsonl`;
  try {
    const { stdout } = await execFileAsync("tail", ["-n", String(n), file], {
      timeout: 2000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const out = [];
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return out;
  } catch { return []; }
}

function summarizeMayorBusy(entries) {
  if (!entries.length) return null;
  const last = entries[entries.length - 1];
  const lastTs = Date.parse(last.timestamp || "");
  if (!lastTs) return null;
  const ageSec = (Date.now() - lastTs) / 1000;
  if (ageSec > BUSY_WINDOW_SEC) return null;

  // Look back for the most recent assistant entry; busy iff it has a
  // tool_use part (i.e. mayor is mid tool-call loop, not done responding).
  let lastAssistantHasToolUse = false;
  let foundAssistant = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type !== "assistant") continue;
    const content = entries[i].message?.content;
    if (!Array.isArray(content)) continue;
    foundAssistant = true;
    lastAssistantHasToolUse = content.some(p => p && p.type === "tool_use");
    break;
  }
  // No assistant turn yet but recent activity = mayor just got a prompt
  // and hasn't started replying. Treat as busy (likely about to be).
  if (!foundAssistant) {
    // Only if there's a recent user prompt
    const hasRecentUser = entries.some(e =>
      e.type === "user" && e.message && Array.isArray(e.message.content) &&
      e.message.content.some(p => p && p.type !== "tool_result")
    );
    if (!hasRecentUser) return null;
  } else if (!lastAssistantHasToolUse) {
    return null; // text-only assistant = end of turn = idle
  }

  // Find the user prompt mayor is processing — last-prompt entry, or
  // failing that, the last text-bearing user message.
  let task = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "last-prompt") {
      task = e.lastPrompt || e.text;
      break;
    }
    if (e.type === "user" && e.message && Array.isArray(e.message.content)) {
      const text = e.message.content
        .filter(p => p && p.type !== "tool_result")
        .map(p => (typeof p === "string" ? p : p.text || ""))
        .filter(Boolean).join(" ").trim();
      if (text) { task = text; break; }
    }
  }
  return { task: (task || "an unspecified task").replace(/\s+/g, " ").slice(0, 140) };
}

async function detectMayorBusy() {
  try {
    const sid = await readMayorSessionId();
    const entries = await readTranscriptTail(sid);
    return summarizeMayorBusy(entries);
  } catch (err) {
    if (process.env.DEBUG) console.error("busy detect failed:", err.message);
    return null;
  }
}

async function maybeBusyNotice(ctx, userText) {
  const busy = await detectMayorBusy();
  if (!busy) return false;
  const text = `🎩 Mayor is busy working on: ${busy.task}\n\nYour message is queued — he'll get back to you shortly.`;
  try {
    await ctx.reply(text);
  } catch (err) {
    console.error("busy notice send failed:", err.message);
    return false;
  }
  rememberPendingBack(String(ctx.chat.id), userText);
  return true;
}

// --- Back-notice watcher -----------------------------------------------
//
// Companion to maybeBusyNotice: when we tell the user "queued", we should
// also tell them when mayor actually starts on their message. We remember
// each (chat, text) the busy-notice fired for, then poll mayor's
// transcript for new last-prompt / user entries that include the text.
// First match wins: send "Mayor is back, starting on …" and forget.
//
// State is in-memory. A bot restart drops pending back-notices — the
// user's queued message still reaches mayor (mail is durable), they just
// won't get the second heads-up.

const pendingBackNotices = new Map();
const PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour
const WATCHER_INTERVAL_MS = 2000;

function rememberPendingBack(chatId, text) {
  if (!text) return;
  // Key by chat + a prefix so multiple distinct messages from the same
  // user can each get their own back-notice without colliding.
  const key = `${chatId}:${text.slice(0, 80)}`;
  pendingBackNotices.set(key, { chatId, text, sentAt: Date.now() });
  // Opportunistic GC of stale entries.
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [k, v] of pendingBackNotices) {
    if (v.sentAt < cutoff) pendingBackNotices.delete(k);
  }
}

function extractPromptText(ev) {
  if (!ev) return null;
  if (ev.type === "last-prompt") return ev.lastPrompt || ev.text || null;
  if (ev.type === "user" && ev.message && Array.isArray(ev.message.content)) {
    return ev.message.content
      .filter(p => p && p.type !== "tool_result")
      .map(p => typeof p === "string" ? p : p.text || "")
      .filter(Boolean).join(" ");
  }
  return null;
}

function startTranscriptWatcher(bot) {
  let lastSize = null;
  let lastSid = null;
  setInterval(async () => {
    try {
      const sid = await readMayorSessionId();
      if (sid !== lastSid) { lastSize = null; lastSid = sid; }
      if (!sid) return;
      const projDir = MAYOR_CWD.replace(/\//g, "-");
      const file = `${CLAUDE_HOME}/projects/${projDir}/${sid}.jsonl`;
      const stat = await fsp.stat(file).catch(() => null);
      if (!stat) return;
      if (lastSize === null) { lastSize = stat.size; return; } // baseline only
      if (stat.size <= lastSize) return;

      // Always advance the cursor, even if we skip the parse, so we don't
      // re-scan the same bytes next tick.
      const start = lastSize;
      const end = stat.size;
      lastSize = end;
      if (pendingBackNotices.size === 0) return;

      const fh = await fsp.open(file, "r");
      let chunk;
      try {
        const buf = Buffer.alloc(end - start);
        await fh.read(buf, 0, buf.length, start);
        chunk = buf.toString("utf8");
      } finally { await fh.close(); }

      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        const prompt = extractPromptText(ev);
        if (!prompt) continue;
        for (const [key, pending] of pendingBackNotices) {
          const needle = pending.text.slice(0, 80);
          if (needle && prompt.includes(needle)) {
            const summary = pending.text.replace(/\s+/g, " ").slice(0, 140);
            try {
              await bot.api.sendMessage(pending.chatId, `🎩 Mayor is back, starting on: ${summary}`);
              console.log(`back-notice sent to ${pending.chatId}`);
            } catch (err) {
              console.error("back notice send failed:", err.message);
            }
            pendingBackNotices.delete(key);
          }
        }
      }
    } catch (err) {
      if (process.env.DEBUG) console.error("transcript watcher tick failed:", err.message);
    }
  }, WATCHER_INTERVAL_MS).unref(); // don't keep the process alive on its own
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

  // Race the busy-notice with the forwarding work — if mayor is mid-turn,
  // the user gets a heads-up before mayor processes the queued message.
  // Passing `text` lets the back-notice watcher recognize when mayor
  // actually starts on it.
  const busyNoticePromise = maybeBusyNotice(ctx, text);
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

  // Don't leak an unhandled rejection if the busy-notice send threw.
  await busyNoticePromise.catch(() => {});

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
  startTranscriptWatcher(bot);

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
