#!/usr/bin/env node
/**
 * events.mjs — real things that happened to her.
 *
 *   node scripts/events.mjs            # last 20, newest first
 *   node scripts/events.mjs --clear    # wipe the log
 *   node scripts/events.mjs --add "<text>" [kind]   # record one by hand
 */
import { listEvents, clearEvents, recordEvent, recentEvents } from "../src/events.mjs";
import { listChats, loadChat, saveChat } from "../src/store.mjs";

const args = process.argv.slice(2);

if (args.includes("--clear")) {
  clearEvents();
  console.log("cleared");
  process.exit(0);
}

if (args.includes("--add")) {
  const i = args.indexOf("--add");
  const what = args[i + 1];
  const kind = args[i + 2] || "stranger";
  if (!what) {
    console.log("usage: node scripts/events.mjs --add \"something happened\" [kind]");
    process.exit(1);
  }
  recordEvent({
    kind,
    what,
    source: "cli",
    applyToChats: () => listChats().filter((c) => c.trusted === true).map((c) => loadChat(c.jid)),
    saveChats: (chats) => chats.forEach((c) => saveChat(c)),
  });
  console.log(`recorded [${kind}]: ${what}`);
  process.exit(0);
}

const all = listEvents();
if (!all.length) {
  console.log("nothing recorded yet — events appear when something actually happens");
  process.exit(0);
}

console.log(`\n  ${all.length} life events recorded · ${recentEvents(24).length} in the last 24h\n`);
for (const e of all.slice(-20).reverse()) {
  const when = new Date(e.at).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  console.log(`  ${when}  [${String(e.kind).padEnd(12)}] ${e.what}`);
}
console.log("\n  kinds: spam, blocked, stranger, promoted, ai_accused, health_scare, milestone, errand\n");
