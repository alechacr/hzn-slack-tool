// Thin wrapper over tmux. All session lifecycle + I/O.

import { spawnSync } from "node:child_process";
import { extractReply, hasSpinner } from "./filters.mjs";

const HISTORY_LIMIT = 8000;
const PANE_W = 220;
const PANE_H = 50;
const POLL_MS = 400;
const IDLE_MS = 1500;
const TURN_TIMEOUT_MS = 300_000;  // 5 min — multi-step /investigate flows can be long

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

const SCROLLBACK_LINES = 4000;  // captures history+visible so the user's anchor
                                // line stays findable across long replies that
                                // overflow the visible pane (e.g. /investigate
                                // with many tool calls).

// -e preserves ANSI escapes — extractReply uses them to detect italic-mode
// thinking lines before stripping for display.
// -S -N includes the last N lines of scrollback ahead of the visible pane;
// without this, long pi answers push the user's anchor off-screen and
// extractReply returns null forever.
function captureVisible(target) {
  const r = tmux(["capture-pane", "-t", target, "-p", "-e", "-S", `-${SCROLLBACK_LINES}`]);
  if (r.status !== 0) return [];
  return r.stdout.replace(/\n$/, "").split("\n");
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

  // Idle detection has to handle pi's multi-step tool-use flow:
  //   user -> [Working...] -> partial answer -> [Working...] -> tool call ->
  //   tool result -> [Working...] -> more answer -> ... -> final answer.
  // Returning on the first 1.5s of "no new content" cuts off mid-flow when
  // pi is between the model and the next tool. We extend the deadline as
  // long as the spinner is still visible somewhere in the pane.
  let last = "";
  let lastChange = 0;        // 0 until we observe non-empty content
  let lastWorkingAt = 0;     // last time we saw the spinner
  const startedAt = Date.now();
  while (true) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const lines = captureVisible(target);
    const reply = extractReply(lines, text);
    const working = hasSpinner(lines);

    if (working) lastWorkingAt = Date.now();
    if (reply && reply !== last) {
      last = reply;
      lastChange = Date.now();
      try { onProgress(reply); } catch { /* don't let UI errors break the poll */ }
    }

    // Idle = have content, not currently working, and quiet for IDLE_MS since
    // both the last content change AND the last spinner observation.
    const quietSince = Math.max(lastChange, lastWorkingAt);
    if (last.length > 0 && !working && Date.now() - quietSince >= IDLE_MS) {
      return last;
    }
    if (Date.now() - startedAt > TURN_TIMEOUT_MS) {
      throw new Error(`turn timed out after ${TURN_TIMEOUT_MS / 1000}s`);
    }
  }
}
