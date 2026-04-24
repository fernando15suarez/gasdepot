// Tests for busy-notice + back-notice + transcript watcher.
// Drives the bot in isolation: temp MAYOR_CWD and CLAUDE_HOME, fake gt
// on PATH, no Telegram, no Dolt.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { makeCtx, makeBotApi, makeGtLog } = require("./helpers");

// Temp dirs — set BEFORE requiring bot.js so module-scoped paths resolve.
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "gt-bot-notice-"));
const MAYOR_CWD = path.join(TEST_ROOT, "mayor");
const CLAUDE_HOME = path.join(TEST_ROOT, "claude");
const SID = "test-sid-0001";
const PROJ_DIR = path.join(CLAUDE_HOME, "projects", MAYOR_CWD.replace(/\//g, "-"));
const TRANSCRIPT = path.join(PROJ_DIR, `${SID}.jsonl`);

fs.mkdirSync(path.join(MAYOR_CWD, ".runtime"), { recursive: true });
fs.writeFileSync(path.join(MAYOR_CWD, ".runtime/session_id"), SID + "\n");
fs.mkdirSync(PROJ_DIR, { recursive: true });
fs.writeFileSync(TRANSCRIPT, "");

const FAKES = path.join(__dirname, "fakes");
const GT = makeGtLog();
process.env.PATH = `${FAKES}:${process.env.PATH || ""}`;
process.env.GT_FAKE_LOG = GT.log;
process.env.GT_TOWN_ROOT = TEST_ROOT;
process.env.GT_MAYOR_CWD = MAYOR_CWD;
process.env.CLAUDE_HOME = CLAUDE_HOME;

const { __test } = require("../bot");
const {
  summarizeMayorBusy,
  extractPromptText,
  maybeBusyNotice,
  rememberPendingBack,
  startTranscriptWatcher,
  pendingBackNotices,
  setPerms,
} = __test;

// --- Helpers for transcript tests --------------------------------------

function nowISO(offsetSec = 0) {
  return new Date(Date.now() + offsetSec * 1000).toISOString();
}

function userMsg(text, ts = nowISO()) {
  return { type: "user", timestamp: ts, message: { content: [{ type: "text", text }] } };
}

function userToolResult(text, ts = nowISO()) {
  return { type: "user", timestamp: ts, message: { content: [{ type: "tool_result", content: text }] } };
}

function assistantText(text, ts = nowISO()) {
  return { type: "assistant", timestamp: ts, message: { content: [{ type: "text", text }] } };
}

function assistantToolUse(name, ts = nowISO()) {
  return { type: "assistant", timestamp: ts, message: { content: [{ type: "tool_use", name, input: {} }] } };
}

function lastPrompt(text, ts = nowISO()) {
  return { type: "last-prompt", timestamp: ts, lastPrompt: text };
}

function writeTranscript(...entries) {
  fs.writeFileSync(TRANSCRIPT, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
}

function appendTranscript(...entries) {
  fs.appendFileSync(TRANSCRIPT, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
}

function clearTranscript() {
  fs.writeFileSync(TRANSCRIPT, "");
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- Pure: summarizeMayorBusy -----------------------------------------

test("summarizeMayorBusy: empty transcript => null", () => {
  assert.equal(summarizeMayorBusy([]), null);
});

test("summarizeMayorBusy: stale activity (>30s) => null", () => {
  const old = nowISO(-120);
  assert.equal(summarizeMayorBusy([assistantToolUse("Bash", old)]), null);
});

test("summarizeMayorBusy: text-only end-of-turn assistant => null", () => {
  assert.equal(
    summarizeMayorBusy([userMsg("hi"), assistantText("done.")]),
    null,
    "mayor finished a turn — not busy",
  );
});

test("summarizeMayorBusy: mid tool-use loop => busy with task", () => {
  const result = summarizeMayorBusy([
    userMsg("compile the code"),
    assistantToolUse("Bash"),
    userToolResult("ok"),
  ]);
  assert.ok(result, "should detect busy");
  assert.match(result.task, /compile the code/);
});

// THIS is the bug-exposing test: mayor finished a turn, then a fresh
// user message arrived but mayor hasn't started the next turn yet.
// detectMayorBusy SHOULD return busy because the user is queued.
test("summarizeMayorBusy: fresh user message after a finished turn => busy", () => {
  const result = summarizeMayorBusy([
    userMsg("first task"),
    assistantText("done."),
    userMsg("second task"),
  ]);
  assert.ok(result, "fresh prompt after end-of-turn should be busy");
  assert.match(result.task, /second task/);
});

test("summarizeMayorBusy: tool_result-only user does NOT count as fresh prompt", () => {
  // After tool_use → tool_result, mayor is mid-loop, not "fresh user input".
  // The busy flag here comes from the tool_use, not the tool_result, but
  // either way we should not mistakenly treat the tool_result as a new
  // user prompt.
  const result = summarizeMayorBusy([
    userMsg("do work"),
    assistantToolUse("Bash"),
    userToolResult("output"),
  ]);
  assert.ok(result);
  assert.match(result.task, /do work/);
});

// --- Pure: extractPromptText ------------------------------------------

test("extractPromptText: last-prompt entry", () => {
  assert.equal(extractPromptText(lastPrompt("hi mayor")), "hi mayor");
});

test("extractPromptText: user with text content", () => {
  assert.equal(extractPromptText(userMsg("hello there")), "hello there");
});

test("extractPromptText: user with tool_result returns empty (filtered)", () => {
  assert.equal(extractPromptText(userToolResult("output")), "");
});

test("extractPromptText: assistant entry => null", () => {
  assert.equal(extractPromptText(assistantText("done")), null);
});

// --- maybeBusyNotice ---------------------------------------------------

test("maybeBusyNotice: when mayor idle, no reply, no pending registered", async () => {
  setPerms({ "1": { role: "admin", rigs: ["*"] } });
  pendingBackNotices.clear();
  writeTranscript(assistantText("done.", nowISO(-2))); // text-only, idle
  const ctx = makeCtx({ chatId: 1, text: "hello" });
  await maybeBusyNotice(ctx, "hello");
  assert.deepEqual(ctx.replies, []);
  assert.equal(pendingBackNotices.size, 0);
});

test("maybeBusyNotice: when mayor busy, sends notice and registers pending", async () => {
  setPerms({ "1": { role: "admin", rigs: ["*"] } });
  pendingBackNotices.clear();
  writeTranscript(
    userMsg("real work", nowISO(-2)),
    assistantToolUse("Bash", nowISO(-1)),
  );
  const ctx = makeCtx({ chatId: 1, text: "are you there" });
  await maybeBusyNotice(ctx, "are you there");
  assert.equal(ctx.replies.length, 1);
  assert.match(ctx.replies[0], /Mayor is busy/);
  assert.match(ctx.replies[0], /real work/);
  assert.equal(pendingBackNotices.size, 1);
});

test("maybeBusyNotice: bug case — fresh user message after finished turn IS busy", async () => {
  setPerms({ "1": { role: "admin", rigs: ["*"] } });
  pendingBackNotices.clear();
  writeTranscript(
    userMsg("prior message", nowISO(-5)),
    assistantText("prior reply", nowISO(-3)),
    userMsg("brand new prompt", nowISO(-1)),
  );
  const ctx = makeCtx({ chatId: 1, text: "queued message" });
  await maybeBusyNotice(ctx, "queued message");
  assert.equal(ctx.replies.length, 1, "should fire — mayor about to process pending input");
  assert.match(ctx.replies[0], /brand new prompt/);
});

// --- Watcher / back-notice end-to-end ----------------------------------

test("startTranscriptWatcher: fires back-notice when transcript shows the queued text", async () => {
  pendingBackNotices.clear();
  clearTranscript();
  rememberPendingBack("100", "ping mayor please");
  const bot = { api: makeBotApi() };
  const stop = startTranscriptWatcher(bot);
  try {
    await sleep(120); // let watcher bind to the (now-empty) transcript
    appendTranscript(lastPrompt("[Telegram from Tester]: ping mayor please now"));
    // Allow fs.watch + I/O round-trip + fire-and-forget send.
    await sleep(500);
    assert.equal(bot.api.calls.length, 1, "back-notice should have fired exactly once");
    assert.equal(bot.api.calls[0].kind, "sendMessage");
    assert.equal(bot.api.calls[0].chatId, "100");
    assert.match(bot.api.calls[0].content, /Mayor is back/);
    assert.match(bot.api.calls[0].content, /ping mayor please/);
    assert.equal(pendingBackNotices.size, 0, "pending entry should be cleared after fire");
  } finally { stop(); }
});

test("startTranscriptWatcher: ignores transcript writes that don't match any pending", async () => {
  pendingBackNotices.clear();
  clearTranscript();
  rememberPendingBack("100", "specific phrase");
  const bot = { api: makeBotApi() };
  const stop = startTranscriptWatcher(bot);
  try {
    await sleep(120);
    appendTranscript(lastPrompt("[Telegram from Other]: completely unrelated"));
    await sleep(500);
    assert.equal(bot.api.calls.length, 0);
    assert.equal(pendingBackNotices.size, 1, "pending should remain");
  } finally { stop(); }
});

test("rememberPendingBack: GCs entries older than the TTL", () => {
  pendingBackNotices.clear();
  // Inject a stale entry by hand.
  pendingBackNotices.set("stale-key", { chatId: "1", text: "old", sentAt: Date.now() - (2 * 60 * 60 * 1000) });
  rememberPendingBack("2", "new");
  assert.equal(pendingBackNotices.has("stale-key"), false, "stale entry GC'd");
  assert.equal(pendingBackNotices.size, 1);
});
