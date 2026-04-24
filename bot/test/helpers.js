// Test helpers: fake grammy Context, fake bot.api, fake http req/res,
// and gt-subprocess log inspection.

const fs = require("fs");
const os = require("os");
const path = require("path");

function makeCtx({ chatId, text, from = { first_name: "Tester" }, photo, document, voice, audio, video, caption, file }) {
  const message = { text, caption };
  if (photo) message.photo = photo;
  if (document) message.document = document;
  if (voice) message.voice = voice;
  if (audio) message.audio = audio;
  if (video) message.video = video;

  const replies = [];
  return {
    chat: { id: chatId },
    from,
    message,
    replies,
    async reply(text) { replies.push(text); return { message_id: 1 }; },
    async getFile() {
      return {
        file_path: file?.serverPath || "dummy/path",
        async download(dest) {
          // Simulate a real download by writing the known bytes.
          fs.writeFileSync(dest, file?.bytes ?? Buffer.from("hello"));
          return dest;
        },
      };
    },
  };
}

function makeReq(body) {
  const chunks = Array.isArray(body) ? body : [body];
  let idx = 0;
  const handlers = {};
  return {
    on(event, cb) { handlers[event] = cb; return this; },
    // Kick off "streaming" synchronously-ish: tests call emit() to simulate
    emit() {
      for (const c of chunks) handlers.data?.(c);
      handlers.end?.();
    },
  };
}

function makeRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(payload) { this.body = payload; },
  };
}

function makeBotApi() {
  const calls = [];
  const mk = (kind) => async (chatId, content, opts) => {
    calls.push({ kind, chatId, content, opts });
    return { message_id: calls.length };
  };
  return {
    calls,
    sendMessage: mk("sendMessage"),
    sendPhoto: mk("sendPhoto"),
    sendDocument: mk("sendDocument"),
    sendVoice: mk("sendVoice"),
    sendAudio: mk("sendAudio"),
    sendVideo: mk("sendVideo"),
  };
}

function makeGtLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gt-bot-test-"));
  const log = path.join(dir, "gt.log");
  fs.writeFileSync(log, "");
  return { dir, log };
}

function readGtLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  const text = fs.readFileSync(logPath, "utf8");
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const [tag, ...rest] = line.split("\t");
    if (tag === "ARGV") {
      entries.push({ kind: "argv", args: rest.filter(Boolean) });
    } else if (tag === "STDIN") {
      entries.push({ kind: "stdin", body: rest.join("\t") });
    }
  }
  return entries;
}

module.exports = {
  makeCtx,
  makeReq,
  makeRes,
  makeBotApi,
  makeGtLog,
  readGtLog,
};
