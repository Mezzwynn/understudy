/**
 * changes.mjs — a change feed with diffs.
 *
 * When her card, traits, world, schedule or settings change, every conversation
 * should know immediately — and know WHAT changed, not just that something did.
 * Otherwise the next reply can be inconsistent with her own definition, and the
 * owner has no way to see what the agent did while they were not looking.
 *
 *   data/changes.json  [{ at, scope, target, source, lines[], summary }]
 *
 * Each chat remembers when it last saw the feed (chat.seenChangeAt), so a change is
 * pushed once per conversation, then it fades.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, config, log } from "./config.mjs";

const FILE = path.join(DATA_DIR, "changes.json");
const KEEP = 120;

export function listChanges() {
  if (!fs.existsSync(FILE)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** A line-level diff, small enough to read in a chat bubble. */
export function diffLines(before, after, { max = 6 } = {}) {
  const a = String(before ?? "").split("\n");
  const b = String(after ?? "").split("\n");
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n && out.length < max; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] === undefined) out.push(`+ ${b[i]}`.slice(0, 140));
    else if (b[i] === undefined) out.push(`- ${a[i]}`.slice(0, 140));
    else {
      out.push(`- ${a[i]}`.slice(0, 140));
      if (out.length < max) out.push(`+ ${b[i]}`.slice(0, 140));
    }
  }
  if (out.length === 0 && before !== after) out.push(`± ${String(after).slice(0, 140)}`);
  return out;
}

/** For a single value change (a frontmatter field, a number). */
export function diffValue(before, after) {
  if (String(before) === String(after)) return [];
  return [`- ${String(before ?? "").slice(0, 120)}`, `+ ${String(after ?? "").slice(0, 120)}`];
}

/**
 * Record a change. `lines` is the diff; `summary` is one short line for the chat.
 */
export function recordChange({ scope, target = "", source = "dashboard", lines = [], summary = "" }) {
  if (!config.changeFeed) return null;
  const entry = {
    at: Date.now(),
    scope: String(scope).slice(0, 40),
    target: String(target).slice(0, 60),
    source: String(source).slice(0, 30),
    summary: String(summary || lines[0] || scope).slice(0, 200),
    lines: lines.slice(0, 8).map((l) => String(l).slice(0, 160)),
  };
  const all = [...listChanges(), entry].slice(-KEEP);
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
  log(`change [${entry.scope}${entry.target ? ":" + entry.target : ""}] from ${entry.source} — ${entry.summary.slice(0, 80)}`);
  return entry;
}

/** What this chat has not seen yet (older than 24h is ignored — it is no longer news). */
export function pendingFor(chat, now = Date.now()) {
  const seen = chat?.seenChangeAt || 0;
  return listChanges().filter((c) => c.at > seen && now - c.at < 24 * 3600 * 1000);
}

export function markSeen(chat, now = Date.now()) {
  chat.seenChangeAt = now;
  return chat;
}

/**
 * Prompt block: the points of the card that just moved. Short on purpose — she
 * should behave consistently, not recite a changelog.
 */
export function changePromptBlock(chat) {
  const pending = pendingFor(chat);
  if (!pending.length) return "";
  const lines = [];
  for (const c of pending.slice(-3)) {
    const where = c.target ? `${c.scope} (${c.target})` : c.scope;
    lines.push(`- ${where}: ${c.summary}`);
    // the actual before/after, trimmed: that is what makes it a fast sync rather
    // than "something changed somewhere"
    for (const l of (c.lines || []).slice(0, 2)) lines.push(`    ${l}`);
  }
  return [
    "## Ada yang berubah soal kamu (baru)",
    ...lines,
    "Ini definisi kamu yang paling baru — pakai yang baru, jangan pakai yang lama.",
    "Jangan nyebut kalau nggak perlu, jangan minta pendapat soal perubahan ini.",
  ].join("\n");
}

/* ------------------------------- watcher -------------------------------- */

const watched = new Map(); // path -> { mtime, hash }

/**
 * Poll the character files so an edit made in a text editor is noticed too, not
 * only changes made through the dashboard. Cheap: a stat() per file, plus a read
 * only when the mtime moved.
 */
export function watchFiles({ personaDir, promptDir, slug, notify = true, onRecord = null } = {}) {
  if (!config.changeWatchFiles) return [];
  const files = [
    ["persona card", path.join(personaDir, `${slug}.md`)],
    ["traits", path.join(personaDir, `${slug}.traits.json`)],
    ["world", path.join(personaDir, `${slug}.world.json`)],
    ["voice rules", path.join(promptDir, "voice.md")],
  ];
  const noticed = [];
  for (const [scope, file] of files) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const prev = watched.get(file);
    const before = prev?.text;
    const changed = !prev || prev.mtime !== stat.mtimeMs;
    if (!changed) continue;
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    watched.set(file, { mtime: stat.mtimeMs, text });
    if (!prev || !before) continue; // first read: just remember it
    const lines = diffLines(before, text);
    if (!lines.length) continue;
    const entry = recordChange({
      scope,
      target: slug,
      source: "file",
      lines,
      summary: `${lines.length} line(s) changed in ${path.basename(file)}`,
    });
    noticed.push(entry);
    if (onRecord) onRecord(entry);
  }
  return noticed;
}
