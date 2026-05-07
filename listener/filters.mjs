// Strip ANSI/OSC escapes and pi-specific UI chrome from captured pane text.

// OSC ( ESC ] ... BEL|ST ) | CSI ( ESC [ params final )
export const ANSI_RE = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B\[[0-?]*[ -/]*[@-~]/g;

// SGR sequence with `3` as a standalone parameter = italic mode. Pi reserves
// italic for thinking/reasoning summaries (gpt-5, sonnet) which we don't want
// to forward to Slack. Matches `\x1B[3m`, `\x1B[1;3m`, `\x1B[3;1m`, etc., but
// NOT `\x1B[38;2;...m` where the `3` is part of `38`.
export const ITALIC_SGR_RE = /\x1B\[(?:\d+;)*3(?:;\d+)*m/;

// Braille spinner glyphs followed by pi's status verbs.
const SPINNER_RE = /[⠀-⣿]\s+(Working|Thinking|Loading|Generating|Streaming)/i;

// "Is pi currently busy?" — used to extend the idle deadline across multi-step
// tool-use cycles (model -> tool -> model -> tool -> ...). Without this check
// the listener returns prematurely when pi is between tool calls.
export function hasSpinner(rawLines) {
  return rawLines.some(l => SPINNER_RE.test(stripAnsi(l)));
}
const COST_RE = /\$\d+(?:\.\d+)?\s*\(sub\)/;
const DIVIDER_RE = /^[\s─━═-]+$/;
const WORKDIR_RE = /^~?\/[^\s]/;

export function stripAnsi(s) { return s.replace(ANSI_RE, ""); }

export function isNoise(line) {
  const t = line.trimEnd();
  if (t === "") return true;
  if (DIVIDER_RE.test(t)) return true;
  if (SPINNER_RE.test(t)) return true;
  if (COST_RE.test(t)) return true;
  return false;
}

// Given raw (ANSI-preserving) visible-pane lines and the text we just sent,
// return the reply (everything between the user's line and the first
// divider/workdir/cost line below it), or null if the anchor hasn't appeared.
//
// Thinking lines (italic SGR) are dropped before stripping ANSI, so pi's
// gpt-5 / sonnet chain-of-thought summaries don't get forwarded to Slack.
export function extractReply(rawLines, sentText) {
  const plain = rawLines.map(l => stripAnsi(l).trimEnd());
  // Exact (trimmed) match — substring matching false-positives on the agent's
  // own reply when the reply contains the user's word, e.g.
  // user: "Hello"  →  agent: " Hello! What can I help you with?"
  const target = sentText.trim();
  let anchor = -1;
  for (let i = plain.length - 1; i >= 0; i--) {
    if (plain[i].trim() === target) { anchor = i; break; }
  }
  if (anchor < 0) return null;
  const out = [];
  for (let i = anchor + 1; i < plain.length; i++) {
    const t = plain[i];
    if (DIVIDER_RE.test(t)) break;
    if (WORKDIR_RE.test(t)) break;
    if (COST_RE.test(t)) break;
    if (isNoise(t)) continue;
    if (ITALIC_SGR_RE.test(rawLines[i])) continue;  // pi thinking summary
    out.push(t);
  }
  return out.join("\n").trim();
}
