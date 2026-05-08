// Download Slack file attachments to a per-thread temp dir so pi can read
// them via @path references. Each Slack message can carry zero or more files;
// `url_private` requires the bot token in the Authorization header.
//
// Returns an array of { path | skipped, name, reason? } entries — one per
// input file. Caller decides what to do with skipped entries (typically
// prepend a small note in the composed prompt).

import { mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { join } from "node:path";

const ROOT = "/tmp/hzn-slack/files";
const MAX_BYTES = 25 * 1024 * 1024;  // 25MB per file — protects the VM disk

export async function downloadSlackFiles(files, sessionKey, botToken) {
  if (!files?.length) return [];
  const safeKey = sessionKey.replace(/[^a-zA-Z0-9._-]/g, "_");
  const dir = join(ROOT, safeKey);
  await mkdir(dir, { recursive: true });

  const results = [];
  for (const f of files) {
    const name = f.name || `file-${f.id}`;
    if (f.size && f.size > MAX_BYTES) {
      results.push({ skipped: true, name, reason: `${f.size} bytes > ${MAX_BYTES} cap` });
      continue;
    }
    if (!f.url_private) {
      // Either the file was deleted, or the bot lacks files:read scope.
      results.push({ skipped: true, name, reason: "no url_private (deleted or missing files:read scope)" });
      continue;
    }
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const dest = join(dir, `${f.id || Date.now()}-${safeName}`);
    try {
      const res = await fetch(f.url_private, {
        headers: { Authorization: `Bearer ${botToken}` },
      });
      if (!res.ok) {
        results.push({ skipped: true, name, reason: `HTTP ${res.status}` });
        continue;
      }
      await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
      results.push({ path: dest, name });
    } catch (err) {
      results.push({ skipped: true, name, reason: err.message });
    }
  }
  return results;
}
