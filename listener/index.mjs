// hzn-slack listener — bolt over Socket Mode -> tmux -> pi.
//
// One Slack thread maps to one tmux session running pi. Each inbound message
// is forwarded to that session via send-keys; the reply is harvested by
// polling capture-pane and posted back to the same thread.

import bolt from "@slack/bolt";
import { ensureSession, ask } from "./tmux.mjs";
import { sessionKey, tmuxTarget, load, save } from "./sessions.mjs";
import { downloadSlackFiles } from "./attachments.mjs";

const { App, LogLevel } = bolt;

const SLACK_BOT_TOKEN = required("SLACK_BOT_TOKEN");
const SLACK_APP_TOKEN = required("SLACK_APP_TOKEN");
const SLACK_CHANNEL_ID = required("SLACK_CHANNEL_ID");
// Default to ~/repos (the hzn-hub super-root) so pi discovers skills installed
// per the TOOLS.md contract at $PI_SUPER_ROOT/.pi/agent/skills/<name>/. Running
// from $HOME would find user-global skills (ohara-*) but miss super-root ones
// (freddy, hzn-agent). Override with PI_CWD if a non-hzn-hub layout is needed.
const PI_CWD = process.env.PI_CWD || `${process.env.HOME}/repos`;

const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

// Slack's chat.update / chat.postMessage text limit is 3000 chars; past that
// the API returns msg_too_long. We use two strategies:
//   - Streaming edits (placeholder updates as pi works): clamp to last N
//     chars. Only one message is visible while streaming, so trailing slice
//     is fine — user sees the most recent state.
//   - Final reply: split into multiple thread messages so nothing is lost.
const SLACK_TEXT_LIMIT = 2900;
const CHUNK_TARGET = 2700;  // leaves headroom inside the per-message limit

function clampForSlack(text) {
  if (!text) return text;
  if (text.length <= SLACK_TEXT_LIMIT) return text;
  const header = `_(streaming — full reply at end of thread)_\n\n`;
  return header + text.slice(-(SLACK_TEXT_LIMIT - header.length));
}

// Split into chunks that fit Slack's per-message limit, breaking on paragraph
// boundaries when possible to avoid mid-sentence cuts. Single paragraphs that
// exceed the limit get hard-split.
function chunkForSlack(text, limit = CHUNK_TARGET) {
  if (!text) return [""];
  if (text.length <= limit) return [text];
  const paras = text.split(/\n\n+/);
  const chunks = [];
  let cur = "";
  const flush = () => { if (cur.trim()) { chunks.push(cur.trim()); cur = ""; } };
  for (const p of paras) {
    if (p.length > limit) {
      flush();
      for (let i = 0; i < p.length; i += limit) chunks.push(p.slice(i, i + limit));
      continue;
    }
    if ((cur.length + 2 + p.length) > limit) flush();
    cur += (cur ? "\n\n" : "") + p;
  }
  flush();
  return chunks;
}

// One queue per thread so two rapid-fire messages in the same thread don't
// race the same tmux session.
const threadQueues = new Map();
function enqueue(key, fn) {
  const prev = threadQueues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);  // run regardless of prev outcome
  threadQueues.set(key, next.finally(() => {
    if (threadQueues.get(key) === next) threadQueues.delete(key);
  }));
  return next;
}

app.message(async ({ message, client, logger }) => {
  // Filter: only the configured channel; skip bot messages, edits, joins, etc.
  // file_share is the only subtype we keep — that's what comes in when the
  // user uploads an attachment (sometimes alongside text).
  if (message.channel !== SLACK_CHANNEL_ID) return;
  if (message.subtype && message.subtype !== "file_share") return;
  if (message.bot_id) return;

  const text = (message.text ?? "").trim();
  const files = message.files ?? [];
  if (!text && files.length === 0) return;

  const threadTs = message.thread_ts ?? message.ts;
  const key = sessionKey(message.channel, threadTs);
  const target = tmuxTarget(message.channel, threadTs);

  await enqueue(key, async () => {
    try {
      const created = ensureSession(target, { cwd: PI_CWD });
      if (created) {
        save(key, { channel: message.channel, threadTs, target, createdAt: Date.now() });
        // Pi takes a moment to boot before send-keys lands cleanly.
        await new Promise(r => setTimeout(r, 2500));
      }

      // Pull any attachments down to a per-thread temp dir; pi reads them
      // inline via @path references the same way it does at CLI invocation.
      const downloads = await downloadSlackFiles(files, key, SLACK_BOT_TOKEN);
      const filePaths = downloads.filter(d => d.path).map(d => `@${d.path}`);
      const skipNotes = downloads.filter(d => d.skipped)
                                 .map(d => `[skipped ${d.name}: ${d.reason}]`);
      // Composed prompt: @paths first, then user text, then any skip notes
      // so pi sees what got dropped. Empty user text + at least one file
      // is fine — pi will infer intent from the file alone.
      const composed = [...filePaths, text, ...skipNotes].filter(Boolean).join(" ");
      if (!composed) {
        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: threadTs,
          text: ":warning: nothing to forward (no usable files and no text)",
        }).catch(() => {});
        return;
      }
      if (filePaths.length > 0) {
        logger.info(`forwarded ${filePaths.length} attachment(s) to ${target}`);
      }

      // Post a placeholder we'll edit as the reply streams in.
      const placeholder = await client.chat.postMessage({
        channel: message.channel,
        thread_ts: threadTs,
        text: ":thinking_face: …",
      });

      let lastEdit = 0;
      const onProgress = (reply) => {
        const now = Date.now();
        // Throttle edits — Slack rate-limits chat.update.
        if (now - lastEdit < 700) return;
        lastEdit = now;
        client.chat.update({
          channel: message.channel,
          ts: placeholder.ts,
          text: clampForSlack(reply) || ":thinking_face: …",
        }).catch(() => {});
      };

      const finalReply = await ask(target, composed, onProgress);
      const chunks = chunkForSlack(finalReply || "_(empty reply)_");
      const total = chunks.length;
      const label = (i) => total > 1 ? `*(${i + 1}/${total})*\n` : "";

      // First chunk replaces the streaming placeholder.
      try {
        await client.chat.update({
          channel: message.channel,
          ts: placeholder.ts,
          text: label(0) + chunks[0],
        });
      } catch (e) {
        logger.warn(`final chat.update failed (${e?.data?.error || e?.message}); falling back to fresh thread reply`);
        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: threadTs,
          text: label(0) + chunks[0],
        }).catch(() => {});
      }

      // Remaining chunks land as new replies in the same thread, in order.
      for (let i = 1; i < total; i++) {
        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: threadTs,
          text: label(i) + chunks[i],
        }).catch((e) => logger.warn(`chunk ${i + 1}/${total} post failed: ${e?.data?.error || e?.message}`));
      }
    } catch (err) {
      logger.error(err);
      await client.chat.postMessage({
        channel: message.channel,
        thread_ts: threadTs,
        text: `:warning: bridge error: \`${err.message}\``,
      }).catch(() => {});
    }
  });
});

app.error(async (err) => { console.error("[bolt error]", err); });

await app.start();
console.log(`[hzn-slack] listening on channel ${SLACK_CHANNEL_ID}`);

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[hzn-slack] FATAL: ${name} not set. Exiting.`);
    process.exit(1);
  }
  return v;
}
