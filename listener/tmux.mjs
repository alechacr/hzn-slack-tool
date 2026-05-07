// Thin wrapper over tmux. All session lifecycle + I/O.

import { spawnSync } from "node:child_process";
import { extractReply } from "./filters.mjs";

const HISTORY_LIMIT = 8000;
const PANE_W = 220;
const PANE_H = 50;
const POLL_MS = 400;
const IDLE_MS = 1500;
const TURN_TIMEOUT_MS = 180_000;

function tmux(args) {
  const r = spawnSync("tmux", args, { encoding: "utf8" });
  if (r.error) throw new Error(`tmux not found: ${r.error.message}`);
  return r;
}

export function exists(target) {
  return tmux(["has-session", "-t", target]).status === 0;
}

// Idempotent: creates the session running pi if missing.
export function ensureSession(target, { command = "pi", cwd } = {}) {
  if (exists(target)) return false;
  const args = ["new-session", "-d", "-s", target, "-x", String(PANE_W), "-y", String(PANE_H)];
  if (cwd) { args.push("-c", cwd); }
  args.push(command);
  const r = tmux(args);
  if (r.status !== 0) throw new Error(`new-session: ${r.stderr}`);
  tmux(["set-option", "-t", target, "history-limit", String(HISTORY_LIMIT)]);
  return true;
}

export function kill(target) {
  if (!exists(target)) return false;
  tmux(["kill-session", "-t", target]);
  return true;
}

function captureVisible(target) {
  const r = tmux(["capture-pane", "-t", target, "-p"]);
  if (r.status !== 0) return [];
  return r.stdout.replace(/\n$/, "").split("\n").map(l => l.replace(/\s+$/, ""));
}

// Send `text` to the session and resolve when the reply settles (no change for
// IDLE_MS). `onProgress(reply)` is invoked every time the reply text changes —
// the listener uses this to incrementally update the Slack message.
export async function ask(target, text, onProgress = () => {}) {
  if (!exists(target)) throw new Error(`tmux session not found: ${target}`);
  // -l = literal (no key-name parsing).
  const r1 = tmux(["send-keys", "-t", target, "-l", text]);
  if (r1.status !== 0) throw new Error(`send-keys text: ${r1.stderr}`);
  const r2 = tmux(["send-keys", "-t", target, "Enter"]);
  if (r2.status !== 0) throw new Error(`send-keys enter: ${r2.stderr}`);

  let last = "";
  let lastChange = Date.now();
  const startedAt = Date.now();
  while (true) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const lines = captureVisible(target);
    const reply = extractReply(lines, text);
    if (reply !== null && reply !== last) {
      last = reply;
      lastChange = Date.now();
      try { onProgress(reply); } catch { /* don't let UI errors break the poll */ }
    }
    if (reply !== null && Date.now() - lastChange >= IDLE_MS) return last;
    if (Date.now() - startedAt > TURN_TIMEOUT_MS) {
      throw new Error(`turn timed out after ${TURN_TIMEOUT_MS / 1000}s`);
    }
  }
}
