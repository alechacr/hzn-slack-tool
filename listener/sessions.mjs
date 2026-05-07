// Session key + on-disk store. One JSON file per Slack thread. Listener restart
// shouldn't lose the channel<->tmux mapping.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = join(homedir(), ".local", "share", "hzn-slack", "sessions");
mkdirSync(ROOT, { recursive: true });

// Stable key from a Slack channel + thread_ts. `channelId` is the Slack channel
// (e.g. "C0123ABCD"); `threadTs` is the parent message ts. Top-level messages
// use ts as their own thread_ts.
export function sessionKey(channelId, threadTs) {
  return `slack:channel:${channelId}:ts:${threadTs}`;
}

// tmux session name must be filesystem-safe. Slack thread_ts is "1234567890.000123";
// keep digits + a single underscore in place of the dot for tmux compatibility.
export function tmuxTarget(channelId, threadTs) {
  const safe = `${channelId}_${threadTs.replace(".", "_")}`;
  return `slack-${safe}`;
}

function pathFor(key) {
  // Avoid colons in filenames on shared mounts; the key is opaque after hash anyway
  // but keep it readable for debugging.
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(ROOT, `${safe}.json`);
}

export function load(key) {
  const p = pathFor(key);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); }
  catch { return null; }
}

export function save(key, data) {
  writeFileSync(pathFor(key), JSON.stringify(data, null, 2));
}
