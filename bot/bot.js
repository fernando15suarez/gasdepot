#!/usr/bin/env node

// gt-bot — Telegram bridge for Gas Town, bundled with gasdepot.
//
// Inbound:  Telegram text in an authorized chat -> `gt mail send mayor/ --stdin`
//           plus `gt nudge mayor ...` for immediate delivery.
//           Attachments (photo/document/voice/audio/video) download to
//           GT_BOT_INBOX_DIR; the path is mailed + nudged to mayor.
// Outbound: HTTP POST /send      { message, chat? } -> Telegram text
//           HTTP POST /send-file { path, chat?, caption?, kind? } -> upload
//
// Unauthorized chats are silently ignored (logged at debug). Mail polling
// is still a follow-up bead. See README.md.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { promises: fsp } = require("fs");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { Bot, InputFile } = require("grammy");

const config = require("./config");

const execFileAsync = promisify(execFile);

// Mayor session — used by the busy-notice probe. Hardcoded layout
// because the bot is shipped as part of mayor's stack; if mayor lives
// somewhere else, set GT_MAYOR_CWD.
const MAYOR_CWD = process.env.GT_MAYOR_CWD
  || `${process.env.GT_TOWN_ROOT || "/gastown/repos/hq"}/mayor`;
const CLAUDE_HOME = process.env.CLAUDE_HOME
  || `${process.env.HOME || "/home/gastown"}/.claude`;

// Where inbound files land. Mayor reads from this directory. Configurable
// so operators can point it elsewhere (volume mount, tmpfs, etc.).
const INBOX_DIR = process.env.GT_BOT_INBOX_DIR
  || `${process.env.GT_TOWN_ROOT || "/gastown/repos/hq"}/mayor/inbox`;

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

function isFreshUserPrompt(ev) {
  if (!ev) return false;
  if (ev.type === "last-prompt") return true;
  if (ev.type !== "user") return false;
  const c = ev.message && ev.message.content;
  if (!Array.isArray(c)) return false;
  // tool_result wrappers aren't "user input" — they're mayor's own
  // intermediate state. Only count user entries with non-tool_result text.
  return c.some(p => p && p.type !== "tool_result");
}

function summarizeMayorBusy(entries) {
  if (!entries.length) return null;
  const last = entries[entries.length - 1];
  const lastTs = Date.parse(last.timestamp || "");
  if (!lastTs) return null;
  const ageSec = (Date.now() - lastTs) / 1000;
  if (ageSec > BUSY_WINDOW_SEC) return null;

  // Walk back from the latest entry. Mayor is busy iff one of:
  //   (a) we hit a fresh user prompt before finding any assistant turn —
  //       new input arrived after mayor's last reply, mayor is about to
  //       process it (this is the gap the previous heuristic missed)
  //   (b) the most recent assistant turn issued a tool_use — mayor is
  //       mid tool-call loop, not done responding
  // Otherwise (latest assistant is text-only, no fresh prompt after it),
  // mayor is idle waiting for the next prompt.
  let sawFreshPromptSinceLastAssistant = false;
  let busy = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "assistant") {
      const content = e.message && Array.isArray(e.message.content) ? e.message.content : [];
      const hasToolUse = content.some(p => p && p.type === "tool_use");
      busy = sawFreshPromptSinceLastAssistant || hasToolUse;
      break;
    }
    if (isFreshUserPrompt(e)) sawFreshPromptSinceLastAssistant = true;
  }
  // Fresh session with pending input but no assistant turn yet.
  if (!busy && sawFreshPromptSinceLastAssistant) busy = true;
  if (!busy) return null;

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
const REBIND_INTERVAL_MS = 30000; // re-resolve mayor's session id periodically

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
  let watcher = null;
  let watchedFile = null;
  let lastSize = 0;
  let lastSid = null;
  let processing = false;

  async function consumeNewBytes() {
    if (processing || !watchedFile) return;
    processing = true;
    try {
      const stat = await fsp.stat(watchedFile).catch(() => null);
      if (!stat || stat.size <= lastSize) return;

      // Always advance the cursor — we don't want to re-scan if a later
      // event finds new pending notices but the bytes are old.
      const start = lastSize;
      const end = stat.size;
      lastSize = end;
      if (pendingBackNotices.size === 0) return;

      const fh = await fsp.open(watchedFile, "r");
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
            // Fire-and-forget: don't block subsequent matches on Telegram I/O.
            bot.api.sendMessage(pending.chatId, `🎩 Mayor is back, starting on: ${summary}`)
              .then(() => console.log(`back-notice sent to ${pending.chatId}`))
              .catch(err => console.error("back notice send failed:", err.message));
            pendingBackNotices.delete(key);
          }
        }
      }
    } catch (err) {
      if (process.env.DEBUG) console.error("watcher consume failed:", err.message);
    } finally {
      processing = false;
    }
  }

  async function rebind() {
    try {
      const sid = await readMayorSessionId();
      if (sid === lastSid && watcher) return;
      if (watcher) { try { watcher.close(); } catch {} watcher = null; }
      lastSid = sid;
      if (!sid) return;
      const projDir = MAYOR_CWD.replace(/\//g, "-");
      const file = `${CLAUDE_HOME}/projects/${projDir}/${sid}.jsonl`;
      const stat = await fsp.stat(file).catch(() => null);
      if (!stat) return;
      watchedFile = file;
      lastSize = stat.size; // start at the tail
      try {
        watcher = fs.watch(file, { persistent: false }, (eventType) => {
          if (eventType === "change") consumeNewBytes();
        });
      } catch (err) {
        console.error("fs.watch failed:", err.message);
      }
    } catch (err) {
      if (process.env.DEBUG) console.error("watcher rebind failed:", err.message);
    }
  }

  rebind();
  const interval = setInterval(rebind, REBIND_INTERVAL_MS);
  interval.unref();
  // Returned so tests can shut the watcher down between cases.
  return () => {
    clearInterval(interval);
    if (watcher) { try { watcher.close(); } catch {} watcher = null; }
  };
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

// --- Inbound: Telegram media -> disk + mail to mayor -------------------
//
// Telegram delivers attachments as one of several field shapes (photo is
// an array of thumbnails; document/voice/audio/video each have their own
// object). `extractMedia` normalizes them into a single descriptor so the
// rest of the flow doesn't have to care which kind it is.

function extractMedia(msg) {
  if (!msg) return null;
  const caption = msg.caption || null;
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const p = msg.photo[msg.photo.length - 1]; // largest resolution
    return { kind: "photo", fileId: p.file_id, name: `photo-${p.file_unique_id}.jpg`, size: p.file_size, mime: "image/jpeg", caption };
  }
  if (msg.document) {
    const d = msg.document;
    return { kind: "document", fileId: d.file_id, name: d.file_name || `doc-${d.file_unique_id}`, size: d.file_size, mime: d.mime_type, caption };
  }
  if (msg.voice) {
    const v = msg.voice;
    return { kind: "voice", fileId: v.file_id, name: `voice-${v.file_unique_id}.ogg`, size: v.file_size, mime: v.mime_type || "audio/ogg", caption };
  }
  if (msg.audio) {
    const a = msg.audio;
    return { kind: "audio", fileId: a.file_id, name: a.file_name || `audio-${a.file_unique_id}.mp3`, size: a.file_size, mime: a.mime_type, caption };
  }
  if (msg.video) {
    const v = msg.video;
    return { kind: "video", fileId: v.file_id, name: v.file_name || `video-${v.file_unique_id}.mp4`, size: v.file_size, mime: v.mime_type, caption };
  }
  return null;
}

function safeFilename(name) {
  // Strip anything that could break a shell, a path, or mayor's parser.
  // Keeping it conservative: letters, digits, dash, underscore, dot only.
  return (name || "file").replace(/[^\w.\-]/g, "_").slice(0, 120) || "file";
}

async function handleTelegramMedia(ctx) {
  const chatId = String(ctx.chat.id);
  if (!isAuthorized(chatId)) {
    if (process.env.DEBUG) console.log(`[debug] ignoring media from chat ${chatId}`);
    return;
  }

  const info = extractMedia(ctx.message);
  if (!info) return;

  const from = ctx.from?.first_name || ctx.from?.username || "unknown";
  const ts = Date.now();
  const destPath = `${INBOX_DIR}/${ts}-${safeFilename(info.name)}`;

  try {
    await fsp.mkdir(INBOX_DIR, { recursive: true });
    const file = await ctx.getFile();
    await file.download(destPath);
  } catch (err) {
    console.error("file download failed:", err.message);
    try { await ctx.reply("Failed to download attachment."); } catch {}
    return;
  }

  const rigs = allowedRigs(chatId);
  const rigScope = rigs.includes("*") ? null : rigs;
  const rigTag = rigScope ? ` [rigs:${rigScope.join(",")}]` : "";
  const subject = `Telegram ${info.kind} from ${from}${rigTag}: ${safeFilename(info.name)}`.slice(0, 140);
  const captionLine = info.caption ? `\nCaption: ${info.caption}` : "";
  const body = [
    rigScope ? `[Chat ${chatId} — access: ${rigScope.join(", ")}]` : `[Chat ${chatId}]`,
    `[From: ${from}]`,
    "",
    `File received and saved to disk.`,
    `  Path:  ${destPath}`,
    `  Kind:  ${info.kind}`,
    `  Name:  ${info.name || "(none)"}`,
    `  Size:  ${info.size ?? "?"} bytes`,
    `  MIME:  ${info.mime || "?"}`,
    captionLine,
  ].filter(Boolean).join("\n");

  try {
    await gtMailSend("mayor/", subject, body);
  } catch (err) {
    console.error("gt mail send (file) failed:", err.message);
    try { await ctx.reply("File saved but delivery to mayor failed."); } catch {}
    return;
  }

  try {
    const nudgeText = `[Telegram ${info.kind} from ${from}]: ${destPath}${info.caption ? ` — ${info.caption}` : ""}`;
    await gtNudge("mayor", nudgeText);
  } catch (err) {
    console.error("gt nudge (file) failed (non-fatal):", err.message);
  }

  console.log(`forwarded ${info.kind} to mayor: ${destPath}`);
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
    // If mayor is replying to this chat, mayor is "back" — flush any
    // pending back-notices for this chat BEFORE the reply so Telegram
    // delivers them in the right order. The fs.watch path may have
    // already won the race; if so, this is a no-op.
    await flushBackNoticesForChat(bot, id);
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

async function flushBackNoticesForChat(bot, chatId) {
  const targetId = String(chatId);
  const matches = [];
  for (const [key, pending] of pendingBackNotices) {
    if (String(pending.chatId) === targetId) matches.push([key, pending]);
  }
  for (const [key, pending] of matches) {
    pendingBackNotices.delete(key); // claim before send so the watcher won't double-fire
    const summary = pending.text.replace(/\s+/g, " ").slice(0, 140);
    try {
      await bot.api.sendMessage(targetId, `🎩 Mayor is back, starting on: ${summary}`);
      console.log(`back-notice (flushed ahead of reply) sent to ${targetId}`);
    } catch (err) {
      console.error("back notice (flush) send failed:", err.message);
    }
  }
}

// --- Outbound: HTTP /send-file -----------------------------------------
//
// POST {path, chat?, caption?, kind?} — uploads a local file to Telegram.
// `kind` selects the send method (photo/document/voice/audio/video); if
// omitted, we guess from the extension and fall back to document. No
// path-traversal protection: callers are already trusted (localhost HTTP).

function guessKindFromExt(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, "");
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return "photo";
  if (["mp4", "mov", "webm", "mkv"].includes(ext)) return "video";
  if (["ogg", "oga"].includes(ext)) return "voice";
  if (["mp3", "m4a", "wav", "flac"].includes(ext)) return "audio";
  return "document";
}

async function handleSendFile(bot, req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    return jsonResponse(res, 400, { error: "invalid JSON" });
  }

  const { path: filePath, chat, caption, kind } = payload || {};
  if (!filePath || typeof filePath !== "string") {
    return jsonResponse(res, 400, { error: "path field required" });
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch (err) {
    return jsonResponse(res, 404, { error: `file not found: ${err.message}` });
  }
  if (!stat.isFile()) {
    return jsonResponse(res, 400, { error: "path is not a regular file" });
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

  const effectiveKind = kind || guessKindFromExt(filePath);
  const opts = caption ? { caption } : {};

  const senders = {
    photo: (id, f) => bot.api.sendPhoto(id, f, opts),
    document: (id, f) => bot.api.sendDocument(id, f, opts),
    voice: (id, f) => bot.api.sendVoice(id, f, opts),
    audio: (id, f) => bot.api.sendAudio(id, f, opts),
    video: (id, f) => bot.api.sendVideo(id, f, opts),
  };
  const send = senders[effectiveKind] || senders.document;

  const delivered = [];
  for (const id of targets) {
    try {
      // Fresh InputFile per send: grammy consumes the stream on first use.
      await send(id, new InputFile(filePath));
      delivered.push({ chat: id, ok: true });
    } catch (err) {
      delivered.push({ chat: id, ok: false, error: err.message });
    }
  }
  console.log(`HTTP /send-file: ${filePath} (${effectiveKind}) -> ${targets.join(",")}`);
  jsonResponse(res, 200, { ok: true, delivered, kind: effectiveKind });
}

function startHttpServer(bot) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/send") {
        return await handleSend(bot, req, res);
      }
      if (req.method === "POST" && req.url === "/send-file") {
        return await handleSendFile(bot, req, res);
      }
      if (req.method === "GET" && req.url === "/health") {
        return jsonResponse(res, 200, {
          ok: true,
          port: config.port(),
          permissions: Object.keys(perms).length,
          inbox: INBOX_DIR,
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
  bot.on([
    "message:photo",
    "message:document",
    "message:voice",
    "message:audio",
    "message:video",
  ], handleTelegramMedia);
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

module.exports = {
  main,
  // Not a stable API — exposed so tests can drive handlers and inspect
  // module-scoped state without spinning up a real bot or Dolt.
  __test: {
    summarizeMayorBusy,
    extractPromptText,
    detectMayorBusy,
    maybeBusyNotice,
    rememberPendingBack,
    startTranscriptWatcher,
    handleTelegramText,
    handleSend,
    flushBackNoticesForChat,
    pendingBackNotices,
    setPerms: (p) => { perms = p; },
  },
};

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal:", err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  });
}
