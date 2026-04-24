// Smoke tests for gt-bot. Runs with node --test (Node 18+). No network,
// no Telegram token, no Dolt. The `gt` CLI is replaced with a bash stub
// on PATH that logs each invocation so we can assert mail/nudge calls.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  makeCtx,
  makeReq,
  makeRes,
  makeBotApi,
  makeGtLog,
  readGtLog,
} = require("./helpers");

// Swap in fake gt + a scratch inbox BEFORE requiring bot.js — handlers
// capture process.env at invocation time, but this keeps the environment
// stable for the lifetime of the test process.
const FAKES = path.join(__dirname, "fakes");
const GT = makeGtLog();
process.env.PATH = `${FAKES}:${process.env.PATH || ""}`;
process.env.GT_FAKE_LOG = GT.log;
const INBOX = fs.mkdtempSync(path.join(os.tmpdir(), "gt-bot-inbox-"));
process.env.GT_BOT_INBOX_DIR = INBOX;
process.env.GT_TOWN_ROOT = "/tmp";  // keeps gtEnv.cwd inside a real dir

const { __test } = require("../bot");
const {
  extractMedia,
  safeFilename,
  guessKindFromExt,
  handleTelegramText,
  handleTelegramMedia,
  handleSend,
  handleSendFile,
  setPerms,
} = __test;

// --- Pure helpers -------------------------------------------------------

test("extractMedia: photo picks the largest resolution", () => {
  const msg = {
    photo: [
      { file_id: "small", file_unique_id: "u1", file_size: 100 },
      { file_id: "large", file_unique_id: "u2", file_size: 10000 },
    ],
    caption: "sunset",
  };
  const info = extractMedia(msg);
  assert.equal(info.kind, "photo");
  assert.equal(info.fileId, "large");
  assert.equal(info.caption, "sunset");
  assert.match(info.name, /\.jpg$/);
});

test("extractMedia: document preserves provided filename", () => {
  const info = extractMedia({
    document: { file_id: "x", file_unique_id: "u", file_name: "report.pdf", file_size: 42, mime_type: "application/pdf" },
  });
  assert.equal(info.kind, "document");
  assert.equal(info.name, "report.pdf");
  assert.equal(info.mime, "application/pdf");
});

test("extractMedia: voice, audio, video normalize", () => {
  assert.equal(extractMedia({ voice: { file_id: "v", file_unique_id: "u", file_size: 1 } }).kind, "voice");
  assert.equal(extractMedia({ audio: { file_id: "a", file_unique_id: "u", file_size: 1 } }).kind, "audio");
  assert.equal(extractMedia({ video: { file_id: "v", file_unique_id: "u", file_size: 1 } }).kind, "video");
});

test("extractMedia: returns null when no media", () => {
  assert.equal(extractMedia({ text: "hello" }), null);
  assert.equal(extractMedia(null), null);
});

test("safeFilename: strips path separators, preserves dots/dashes", () => {
  // Slashes become underscores so the result can never contain a path
  // separator — that plus the `${ts}-${...}` prefix at the use site is
  // what keeps inbound files inside INBOX_DIR. Dots (including ..) are
  // preserved for legibility; no escape is possible without a slash.
  const sanitized = safeFilename("../../../etc/passwd");
  assert.ok(!sanitized.includes("/"), "no slashes in output");
  assert.equal(sanitized, "..%..%..%etc%passwd".replace(/%/g, "_"));
  assert.equal(safeFilename("normal file.txt"), "normal_file.txt");
  assert.equal(safeFilename(""), "file");
  assert.equal(safeFilename(null), "file");
  assert.equal(safeFilename("a-b.c_d"), "a-b.c_d");
});

test("guessKindFromExt: infers from extension, falls back to document", () => {
  assert.equal(guessKindFromExt("/tmp/pic.jpg"), "photo");
  assert.equal(guessKindFromExt("/tmp/PIC.PNG"), "photo");
  assert.equal(guessKindFromExt("/tmp/clip.mp4"), "video");
  assert.equal(guessKindFromExt("/tmp/voice.ogg"), "voice");
  assert.equal(guessKindFromExt("/tmp/song.mp3"), "audio");
  assert.equal(guessKindFromExt("/tmp/report.pdf"), "document");
  assert.equal(guessKindFromExt("/tmp/noext"), "document");
});

// --- Inbound text handler ----------------------------------------------

test("handleTelegramText: unauthorized chat is silently dropped", async () => {
  setPerms({});
  fs.writeFileSync(GT.log, "");
  const ctx = makeCtx({ chatId: 9999, text: "hello" });
  await handleTelegramText(ctx);
  assert.deepEqual(readGtLog(GT.log), [], "no gt commands should run");
  assert.deepEqual(ctx.replies, []);
});

test("handleTelegramText: authorized chat mails + nudges mayor", async () => {
  setPerms({ "100": { role: "admin", rigs: ["*"] } });
  fs.writeFileSync(GT.log, "");
  const ctx = makeCtx({ chatId: 100, text: "ping mayor" });
  await handleTelegramText(ctx);
  const log = readGtLog(GT.log);
  const argvs = log.filter(e => e.kind === "argv").map(e => e.args);
  const mailCall = argvs.find(a => a[0] === "mail" && a[1] === "send");
  const nudgeCall = argvs.find(a => a[0] === "nudge");
  assert.ok(mailCall, "expected a gt mail send call");
  assert.equal(mailCall[2], "mayor/");
  assert.ok(nudgeCall, "expected a gt nudge call");
  assert.equal(nudgeCall[1], "mayor");
  const stdin = log.find(e => e.kind === "stdin");
  assert.ok(stdin && stdin.body.includes("ping mayor"), "mail body should contain the user text");
});

// --- Inbound media handler ---------------------------------------------

test("handleTelegramMedia: downloads file, mails mayor, no reply on success", async () => {
  setPerms({ "200": { role: "admin", rigs: ["*"] } });
  fs.writeFileSync(GT.log, "");
  const bytes = Buffer.from("pretend-jpeg-bytes");
  const ctx = makeCtx({
    chatId: 200,
    photo: [
      { file_id: "small", file_unique_id: "a", file_size: 10 },
      { file_id: "big", file_unique_id: "b", file_size: 1000 },
    ],
    caption: "selfie",
    file: { bytes },
  });
  await handleTelegramMedia(ctx);

  const saved = fs.readdirSync(INBOX).filter(f => f.endsWith("photo-b.jpg"));
  assert.equal(saved.length, 1, "exactly one file saved in inbox");
  assert.deepEqual(fs.readFileSync(path.join(INBOX, saved[0])), bytes);
  assert.deepEqual(ctx.replies, [], "success path should not reply");

  const log = readGtLog(GT.log);
  const argvs = log.filter(e => e.kind === "argv").map(e => e.args);
  assert.ok(argvs.some(a => a[0] === "mail" && a[1] === "send"), "expected mail send");
  assert.ok(argvs.some(a => a[0] === "nudge"), "expected nudge");
});

test("handleTelegramMedia: unauthorized chat is dropped, no download", async () => {
  setPerms({});
  fs.writeFileSync(GT.log, "");
  const before = fs.readdirSync(INBOX).length;
  const ctx = makeCtx({
    chatId: 77777,
    document: { file_id: "d", file_unique_id: "u", file_name: "secret.txt", file_size: 3 },
    file: { bytes: Buffer.from("x") },
  });
  await handleTelegramMedia(ctx);
  assert.equal(fs.readdirSync(INBOX).length, before, "no new files written");
  assert.deepEqual(readGtLog(GT.log), []);
});

// --- Outbound HTTP: /send ----------------------------------------------

async function driveHttp(handler, bot, req) {
  const res = makeRes();
  const p = handler(bot, req, res);
  req.emit();
  await p;
  return res;
}

test("handleSend: 400 on missing message field", async () => {
  const bot = { api: makeBotApi() };
  const res = await driveHttp(handleSend, bot, makeReq(JSON.stringify({ chat: 1 })));
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /message field required/);
});

test("handleSend: 403 on unauthorized chat", async () => {
  setPerms({});
  const bot = { api: makeBotApi() };
  const res = await driveHttp(handleSend, bot, makeReq(JSON.stringify({ message: "hi", chat: 42 })));
  assert.equal(res.statusCode, 403);
});

test("handleSend: 200 + sendMessage on authorized chat", async () => {
  setPerms({ "42": { role: "admin", rigs: ["*"] } });
  const bot = { api: makeBotApi() };
  const res = await driveHttp(handleSend, bot, makeReq(JSON.stringify({ message: "hi", chat: 42 })));
  assert.equal(res.statusCode, 200);
  assert.equal(bot.api.calls.length, 1);
  assert.equal(bot.api.calls[0].kind, "sendMessage");
  assert.equal(bot.api.calls[0].chatId, "42");
  assert.equal(bot.api.calls[0].content, "hi");
});

test("handleSend: fans out to all admins when chat omitted", async () => {
  setPerms({
    "10": { role: "admin", rigs: ["*"] },
    "11": { role: "admin", rigs: ["*"] },
    "20": { role: "viewer", rigs: ["*"] },
  });
  const bot = { api: makeBotApi() };
  const res = await driveHttp(handleSend, bot, makeReq(JSON.stringify({ message: "fanout" })));
  assert.equal(res.statusCode, 200);
  const sent = bot.api.calls.filter(c => c.kind === "sendMessage").map(c => c.chatId).sort();
  assert.deepEqual(sent, ["10", "11"]);
});

// --- Outbound HTTP: /send-file -----------------------------------------

test("handleSendFile: 400 on missing path", async () => {
  const bot = { api: makeBotApi() };
  const res = await driveHttp(handleSendFile, bot, makeReq(JSON.stringify({ chat: 1 })));
  assert.equal(res.statusCode, 400);
});

test("handleSendFile: 404 on missing file", async () => {
  setPerms({ "5": { role: "admin", rigs: ["*"] } });
  const bot = { api: makeBotApi() };
  const res = await driveHttp(handleSendFile, bot, makeReq(JSON.stringify({ path: "/no/such/file.xyz", chat: 5 })));
  assert.equal(res.statusCode, 404);
});

test("handleSendFile: dispatches to sendPhoto for .jpg", async () => {
  setPerms({ "5": { role: "admin", rigs: ["*"] } });
  const p = path.join(INBOX, "pic.jpg");
  fs.writeFileSync(p, "fake-jpeg");
  const bot = { api: makeBotApi() };
  const res = await driveHttp(handleSendFile, bot, makeReq(JSON.stringify({ path: p, chat: 5, caption: "look" })));
  assert.equal(res.statusCode, 200);
  assert.equal(bot.api.calls.length, 1);
  assert.equal(bot.api.calls[0].kind, "sendPhoto");
  assert.equal(bot.api.calls[0].chatId, "5");
  assert.equal(bot.api.calls[0].opts?.caption, "look");
});

test("handleSendFile: kind override wins over extension guess", async () => {
  setPerms({ "5": { role: "admin", rigs: ["*"] } });
  const p = path.join(INBOX, "maybe-a-photo.jpg");
  fs.writeFileSync(p, "data");
  const bot = { api: makeBotApi() };
  const res = await driveHttp(handleSendFile, bot, makeReq(JSON.stringify({ path: p, chat: 5, kind: "document" })));
  assert.equal(res.statusCode, 200);
  assert.equal(bot.api.calls[0].kind, "sendDocument");
});

test("handleSendFile: unknown extension falls back to document", async () => {
  setPerms({ "5": { role: "admin", rigs: ["*"] } });
  const p = path.join(INBOX, "blob.xyz");
  fs.writeFileSync(p, "data");
  const bot = { api: makeBotApi() };
  const res = await driveHttp(handleSendFile, bot, makeReq(JSON.stringify({ path: p, chat: 5 })));
  assert.equal(res.statusCode, 200);
  assert.equal(bot.api.calls[0].kind, "sendDocument");
});
