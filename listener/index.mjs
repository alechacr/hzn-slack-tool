// hzn-slack listener — bolt over Socket Mode -> tmux -> pi.
//
// One Slack thread maps to one tmux session running pi. Each inbound message
// is forwarded to that session via send-keys; the reply is harvested by
// polling capture-pane and posted back to the same thread.

import bolt from "@slack/bolt";
import { ensureSession, ask } from "./tmux.mjs";
import { sessionKey, tmuxTarget, load, save } from "./sessions.mjs";

const { App, LogLevel } = bolt;

const SLACK_BOT_TOKEN = required("SLACK_BOT_TOKEN");
const SLACK_APP_TOKEN = required("SLACK_APP_TOKEN");
const SLACK_CHANNEL_ID = required("SLACK_CHANNEL_ID");
const PI_CWD = process.env.PI_CWD || process.env.HOME;

const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

// Slack chat.update accepts up to ~3000 chars in `text`. Anything longer fails
// silently and leaves the message stuck on the last successful update. We
// clamp to the last N chars (most recent state is what the user wants to see)
// and prepend a marker so it's clear when truncation kicked in.
const SLACK_TEXT_LIMIT = 2900;
function clampForSlack(text) {
  if (!text) return text;
  if (text.length <= SLACK_TEXT_LIMIT) return text;
  return `_(truncated to last ${SLACK_TEXT_LIMIT} chars; full reply was ${text.length} chars — \`tmux attach\` on the VM to read it all)_\n\n` +
         text.slice(-SLACK_TEXT_LIMIT);
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
  if (message.channel !== SLACK_CHANNEL_ID) return;
  if (message.subtype) return;
  if (message.bot_id) return;
  if (!message.text || message.text.trim() === "") return;

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

      const finalReply = await ask(target, message.text, onProgress);

      await client.chat.update({
        channel: message.channel,
        ts: placeholder.ts,
        text: clampForSlack(finalReply) || "_(empty reply)_",
      });
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
