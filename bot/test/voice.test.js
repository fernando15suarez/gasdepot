// Tests for the voice transcription path. Drives the bot with fake
// `ffmpeg` and `whisper-cli` binaries on PATH so no real Whisper or
// audio decode is required.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  makeCtx,
  makeGtLog,
  readGtLog,
  installFakeFetch,
  setActiveFakeFetchCtx,
} = require("./helpers");

const FAKES = path.join(__dirname, "fakes");
const GT = makeGtLog();
const INBOX = fs.mkdtempSync(path.join(os.tmpdir(), "gt-bot-voice-inbox-"));

// Pre-create a fake model file so the existing handleTelegramMedia tests
// hit the fast path (model present → no lazy download). The lazy-download
// tests below override WHISPER_MODEL per-test to point at a missing path.
const MODEL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gt-bot-voice-model-"));
const PRESENT_MODEL = path.join(MODEL_DIR, "ggml-tiny.en.bin");
fs.writeFileSync(PRESENT_MODEL, "fake-model-bytes");

process.env.PATH = `${FAKES}:${process.env.PATH || ""}`;
process.env.GT_FAKE_LOG = GT.log;
process.env.GT_BOT_INBOX_DIR = INBOX;
process.env.GT_TOWN_ROOT = "/tmp";
process.env.WHISPER_MODEL = PRESENT_MODEL;

installFakeFetch();

const { __test } = require("../bot");
const {
  handleTelegramMedia,
  transcribeVoice,
  ensureWhisperModel,
  resetWhisperModelDownload,
  setPerms,
} = __test;

function voiceCtx({ chatId, bytes = Buffer.from("opus-bytes"), caption = null } = {}) {
  return makeCtx({
    chatId,
    voice: { file_id: "vid", file_unique_id: "uid", file_size: bytes.length, mime_type: "audio/ogg" },
    caption,
    file: { bytes },
  });
}

// --- transcribeVoice ---------------------------------------------------

test("transcribeVoice: returns trimmed text from whisper-cli stdout", async () => {
  const oggPath = path.join(INBOX, "raw.ogg");
  fs.writeFileSync(oggPath, "opus");
  const text = await transcribeVoice(oggPath);
  assert.equal(text, "this is a fake transcription");
});

test("transcribeVoice: respects WHISPER_FAKE_OUTPUT override", async () => {
  const oggPath = path.join(INBOX, "raw2.ogg");
  fs.writeFileSync(oggPath, "opus");
  process.env.WHISPER_FAKE_OUTPUT = "hello mayor please run the deploy";
  try {
    const text = await transcribeVoice(oggPath);
    assert.equal(text, "hello mayor please run the deploy");
  } finally {
    delete process.env.WHISPER_FAKE_OUTPUT;
  }
});

test("transcribeVoice: returns null when whisper-cli is missing", async () => {
  const oggPath = path.join(INBOX, "raw3.ogg");
  fs.writeFileSync(oggPath, "opus");
  const prev = process.env.WHISPER_BIN;
  process.env.WHISPER_BIN = "definitely-not-on-path-zzzz";
  try {
    const text = await transcribeVoice(oggPath);
    assert.equal(text, null);
  } finally {
    if (prev === undefined) delete process.env.WHISPER_BIN;
    else process.env.WHISPER_BIN = prev;
  }
});

test("transcribeVoice: cleans up the wav file on success", async () => {
  const oggPath = path.join(INBOX, "raw4.ogg");
  fs.writeFileSync(oggPath, "opus");
  await transcribeVoice(oggPath);
  assert.equal(fs.existsSync(`${oggPath}.wav`), false);
});

// --- handleTelegramMedia: voice path -----------------------------------

test("handleTelegramMedia: voice mails mayor with the transcript as the body", async () => {
  setPerms({ "300": { role: "admin", rigs: ["*"] } });
  fs.writeFileSync(GT.log, "");
  process.env.WHISPER_FAKE_OUTPUT = "deploy the staging branch please";
  try {
    const ctx = voiceCtx({ chatId: 300 });
    setActiveFakeFetchCtx(ctx);
    await handleTelegramMedia(ctx);
    const log = readGtLog(GT.log);
    const argvs = log.filter(e => e.kind === "argv").map(e => e.args);
    const mailCall = argvs.find(a => a[0] === "mail" && a[1] === "send");
    assert.ok(mailCall, "expected a gt mail send");
    const subject = mailCall[mailCall.indexOf("-s") + 1];
    assert.match(subject, /deploy the staging branch/);
    const stdin = log.find(e => e.kind === "stdin");
    assert.ok(stdin && stdin.body.includes("deploy the staging branch please"));
    assert.ok(stdin.body.includes("Transcribed locally"));
  } finally {
    delete process.env.WHISPER_FAKE_OUTPUT;
  }
});

test("handleTelegramMedia: voice falls back to path-only when transcription fails", async () => {
  setPerms({ "300": { role: "admin", rigs: ["*"] } });
  fs.writeFileSync(GT.log, "");
  const prev = process.env.WHISPER_BIN;
  process.env.WHISPER_BIN = "definitely-not-on-path-zzzz";
  try {
    const ctx = voiceCtx({ chatId: 300 });
    setActiveFakeFetchCtx(ctx);
    await handleTelegramMedia(ctx);
    const log = readGtLog(GT.log);
    const stdin = log.find(e => e.kind === "stdin");
    assert.ok(stdin, "mail still sent — fallback path must not lose the message");
    assert.ok(stdin.body.includes("Transcription failed"), "body should flag the fallback");
    assert.ok(stdin.body.includes("File received and saved"), "body should include the path-only block");
  } finally {
    if (prev === undefined) delete process.env.WHISPER_BIN;
    else process.env.WHISPER_BIN = prev;
  }
});

test("handleTelegramMedia: photo path is unchanged (no transcription attempted)", async () => {
  setPerms({ "300": { role: "admin", rigs: ["*"] } });
  fs.writeFileSync(GT.log, "");
  process.env.WHISPER_BIN = "definitely-not-on-path-zzzz";
  try {
    const ctx = makeCtx({
      chatId: 300,
      photo: [{ file_id: "p", file_unique_id: "u", file_size: 5 }],
      file: { bytes: Buffer.from("jpeg") },
    });
    setActiveFakeFetchCtx(ctx);
    await handleTelegramMedia(ctx);
    const log = readGtLog(GT.log);
    assert.ok(log.find(e => e.kind === "argv" && e.args[0] === "mail" && e.args[1] === "send"),
      "photo should still mail mayor");
  } finally {
    delete process.env.WHISPER_BIN;
  }
});

// --- handleTelegramMedia: nudge & echo behavior ------------------------
//
// The text-message path appends `Reply via: curl ... /send` to the nudge
// so mayor knows to reply over Telegram. The voice/media path was missing
// this hint — without it, mayor falls back to gt mail reply and replies
// land in beads instead of going back to the operator.

test("handleTelegramMedia: nudge text includes Reply via hint with chat id", async () => {
  setPerms({ "300": { role: "admin", rigs: ["*"] } });
  fs.writeFileSync(GT.log, "");
  process.env.WHISPER_FAKE_OUTPUT = "test transcript";
  try {
    const ctx = voiceCtx({ chatId: 300 });
    setActiveFakeFetchCtx(ctx);
    await handleTelegramMedia(ctx);
    // The reply hint contains newlines, which the line-oriented readGtLog
    // truncates. Read the raw log instead and assert against its bytes.
    const log = readGtLog(GT.log);
    const nudgeArgs = log.find(e => e.kind === "argv" && e.args[0] === "nudge");
    assert.ok(nudgeArgs, "expected a gt nudge call from the media path");
    const raw = fs.readFileSync(GT.log, "utf8");
    assert.match(raw, /Reply via: curl/, "nudge text should include Reply via: curl");
    assert.match(raw, /"chat":"300"/, "nudge text should include the originating chat id");
    assert.match(raw, /\/send/, "nudge text should reference the /send endpoint");
  } finally {
    delete process.env.WHISPER_FAKE_OUTPUT;
  }
});

test("handleTelegramMedia: echoes the transcript back to operator on Telegram", async () => {
  setPerms({ "300": { role: "admin", rigs: ["*"] } });
  fs.writeFileSync(GT.log, "");
  process.env.WHISPER_FAKE_OUTPUT = "schedule a haircut for tomorrow";
  try {
    const ctx = voiceCtx({ chatId: 300 });
    setActiveFakeFetchCtx(ctx);
    await handleTelegramMedia(ctx);
    const echo = ctx.replies.find(r => r.includes("Heard:"));
    assert.ok(echo, "expected a ctx.reply with `Heard:` echo");
    assert.match(echo, /schedule a haircut for tomorrow/);
  } finally {
    delete process.env.WHISPER_FAKE_OUTPUT;
  }
});

test("handleTelegramMedia: no echo when transcription fails (silent fallback)", async () => {
  setPerms({ "300": { role: "admin", rigs: ["*"] } });
  fs.writeFileSync(GT.log, "");
  const prev = process.env.WHISPER_BIN;
  process.env.WHISPER_BIN = "definitely-not-on-path-zzzz";
  try {
    const ctx = voiceCtx({ chatId: 300 });
    setActiveFakeFetchCtx(ctx);
    await handleTelegramMedia(ctx);
    const echo = ctx.replies.find(r => r.includes("Heard:"));
    assert.equal(echo, undefined, "should not echo when no transcript");
  } finally {
    if (prev === undefined) delete process.env.WHISPER_BIN;
    else process.env.WHISPER_BIN = prev;
  }
});

// --- ensureWhisperModel: lazy-download paths ---------------------------
//
// The model is ~75 MB and most installs may never receive a voice DM,
// so the Dockerfile keeps it out of the image. ensureWhisperModel pulls
// it on first voice DM (with operator notice + single-flight) and skips
// on subsequent voice DMs. Three paths are covered:
//   (1) missing model → notice fires before download → model on disk
//   (2) model already present → no notice, no download
//   (3) concurrent first-voices → exactly one download, one notice

function withMissingModelEnv(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gt-bot-lazy-"));
  const missingModelPath = path.join(tmpDir, "ggml-tiny.en.bin");
  const prevModel = process.env.WHISPER_MODEL;
  process.env.WHISPER_MODEL = missingModelPath;
  resetWhisperModelDownload();
  return {
    missingModelPath,
    cleanup() {
      process.env.WHISPER_MODEL = prevModel;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      resetWhisperModelDownload();
    },
  };
}

function stubModelFetch({ delayMs = 0, bytes = Buffer.from("fake-whisper-model") } = {}) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    if (typeof url === "string" && url.includes("huggingface.co")) {
      calls.push(url);
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      return {
        ok: true,
        status: 200,
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
      };
    }
    return orig(url);
  };
  return {
    calls,
    restore() { globalThis.fetch = orig; },
  };
}

test("ensureWhisperModel: missing model → notice fires before download, model lands on disk", async () => {
  const env = withMissingModelEnv();
  const stub = stubModelFetch();
  try {
    const ctx = { replies: [], async reply(t) { this.replies.push(t); } };
    const ok = await ensureWhisperModel(ctx);
    assert.equal(ok, true);
    assert.equal(fs.existsSync(env.missingModelPath), true, "model should be on disk");
    assert.equal(stub.calls.length, 1, "one HF download call");
    assert.match(stub.calls[0], /ggml-tiny\.en\.bin$/);
    const notice = ctx.replies.find(r => r.includes("First voice on this install"));
    assert.ok(notice, "expected the lazy-download notice ctx.reply");
    assert.match(notice, /~75 MB/);
  } finally {
    stub.restore();
    env.cleanup();
  }
});

test("ensureWhisperModel: present model → no notice, no download", async () => {
  // Default WHISPER_MODEL points at PRESENT_MODEL (set at module load).
  resetWhisperModelDownload();
  const stub = stubModelFetch();
  try {
    const ctx = { replies: [], async reply(t) { this.replies.push(t); } };
    const ok = await ensureWhisperModel(ctx);
    assert.equal(ok, true);
    assert.equal(stub.calls.length, 0, "should not download when model present");
    assert.equal(ctx.replies.length, 0, "should not notify when model present");
  } finally {
    stub.restore();
  }
});

test("ensureWhisperModel: concurrent first-voices single-flight (one download, one notice)", async () => {
  const env = withMissingModelEnv();
  const stub = stubModelFetch({ delayMs: 50 });
  try {
    const ctx1 = { replies: [], async reply(t) { this.replies.push(t); } };
    const ctx2 = { replies: [], async reply(t) { this.replies.push(t); } };
    // Fire concurrently — both find the model missing and would each try
    // to download without single-flight gating.
    const [r1, r2] = await Promise.all([
      ensureWhisperModel(ctx1),
      ensureWhisperModel(ctx2),
    ]);
    assert.equal(r1, true);
    assert.equal(r2, true);
    assert.equal(stub.calls.length, 1, "exactly one download under concurrent calls");
    const totalNotices = ctx1.replies.length + ctx2.replies.length;
    assert.equal(totalNotices, 1, "exactly one operator notice across both ctxs");
  } finally {
    stub.restore();
    env.cleanup();
  }
});

test("ensureWhisperModel: download failure returns false (caller falls back)", async () => {
  const env = withMissingModelEnv();
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (typeof url === "string" && url.includes("huggingface.co")) {
      return { ok: false, status: 503, async arrayBuffer() { return new ArrayBuffer(0); } };
    }
    return orig(url);
  };
  try {
    const ctx = { replies: [], async reply(t) { this.replies.push(t); } };
    const ok = await ensureWhisperModel(ctx);
    assert.equal(ok, false, "download failure should return false");
    assert.equal(fs.existsSync(env.missingModelPath), false, "no model file on failure");
  } finally {
    globalThis.fetch = orig;
    env.cleanup();
  }
});

test("handleTelegramMedia: voice on missing model → notice → download → transcribe", async () => {
  const env = withMissingModelEnv();
  const stub = stubModelFetch();
  setPerms({ "300": { role: "admin", rigs: ["*"] } });
  fs.writeFileSync(GT.log, "");
  process.env.WHISPER_FAKE_OUTPUT = "first voice on this install";
  try {
    const ctx = voiceCtx({ chatId: 300 });
    setActiveFakeFetchCtx(ctx);
    await handleTelegramMedia(ctx);
    // Notice fired before transcript echo (download happened in between).
    const noticeIdx = ctx.replies.findIndex(r => r.includes("First voice on this install"));
    const echoIdx = ctx.replies.findIndex(r => r.includes("Heard:"));
    assert.ok(noticeIdx >= 0, "expected lazy-download notice");
    assert.ok(echoIdx >= 0, "expected transcript echo");
    assert.ok(noticeIdx < echoIdx, "notice must fire before transcript echo");
    // Model now on disk; the mail body has the transcript.
    assert.equal(fs.existsSync(env.missingModelPath), true);
    const log = readGtLog(GT.log);
    const stdin = log.find(e => e.kind === "stdin");
    assert.ok(stdin && stdin.body.includes("first voice on this install"));
  } finally {
    delete process.env.WHISPER_FAKE_OUTPUT;
    stub.restore();
    env.cleanup();
  }
});
