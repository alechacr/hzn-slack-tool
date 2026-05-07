// Strip ANSI/OSC escapes and pi-specific UI chrome from captured pane text.

// OSC ( ESC ] ... BEL|ST ) | CSI ( ESC [ params final )
export const ANSI_RE = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B\[[0-?]*[ -/]*[@-~]/g;

// Braille spinner glyphs followed by pi's status verbs.
const SPINNER_RE = /[⠀-⣿]\s+(Working|Thinking|Loading|Generating|Streaming)/i;
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

// Given visible-pane lines and the text we just sent, return the reply
// (everything between the user's line and the first divider/workdir/cost line
// below it), or null if the anchor hasn't appeared yet.
export function extractReply(lines, sentText) {
  let anchor = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(sentText)) { anchor = i; break; }
  }
  if (anchor < 0) return null;
  const out = [];
  for (let i = anchor + 1; i < lines.length; i++) {
    const t = lines[i].trimEnd();
    if (DIVIDER_RE.test(t)) break;
    if (WORKDIR_RE.test(t)) break;
    if (COST_RE.test(t)) break;
    if (isNoise(t)) continue;
    out.push(t);
  }
  return out.join("\n").trim();
}
