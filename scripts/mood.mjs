#!/usr/bin/env node
/**
 * mood.mjs — inspect / tweak the live mood of a chat.
 *
 *   node scripts/mood.mjs list
 *   node scripts/mood.mjs show <jid-or-number>
 *   node scripts/mood.mjs set <jid-or-number> <key> <value>
 *   node scripts/mood.mjs nudge <jid-or-number> <event>
 *   node scripts/mood.mjs reset <jid-or-number>
 *
 * Events: sweet flirty compliment joke apologize reconnect fight rude ignored jealous boring tired excited
 */
import { listChats, loadChat, saveChat, defaultChat } from "../src/store.mjs";
import { label, tone, KEYS, normalize, newMood, applyDeltas, NUDGES } from "../src/mood.mjs";

function resolve(id) {
  if (!id) return null;
  if (id.includes("@")) return id;
  const num = id.startsWith("+") ? id.slice(1) : id;
  const match = listChats().find((c) => c.jid.startsWith(num));
  return match ? match.jid : `${num}@s.whatsapp.net`;
}

function show(chat) {
  const m = normalize(chat.mood || newMood());
  console.log(`\n${chat.jid}  (${chat.stats?.inbound || 0} in / ${chat.stats?.outbound || 0} out)`);
  console.log(`  Mood: ${label(m)}`);
  for (const k of KEYS) {
    const norm = k === "valence" ? (m[k] + 1) / 2 : m[k];
    console.log(`    ${k.padEnd(12)} ${m[k].toFixed(2).padStart(5)}  ${"█".repeat(Math.round(norm * 20))}`);
  }
  console.log(`  ${tone(m)}\n`);
}

const [cmd, id, a, b] = process.argv.slice(2);
const jid = resolve(id);
let chat;

switch (cmd) {
  case "list":
  case "ls":
  case undefined: {
    const chats = listChats();
    if (!chats.length) {
      console.log("No chats yet.");
      break;
    }
    for (const c of chats) {
      const m = normalize(c.mood || newMood());
      console.log(`${c.jid.padEnd(28)} ${label(m).padEnd(20)} last: ${new Date(c.lastInteraction || 0).toISOString()}`);
    }
    break;
  }
  case "show":
    if (!jid) throw new Error("usage: mood.mjs show <jid-or-number>");
    chat = loadChat(jid);
    show(chat);
    break;
  case "set":
    if (!jid || !a || b === undefined) throw new Error("usage: mood.mjs set <jid> <key> <value>");
    chat = loadChat(jid);
    chat.mood = applyDeltas(normalize(chat.mood || newMood()), { [a]: Number(b) });
    saveChat(chat);
    show(chat);
    break;
  case "nudge":
    if (!jid || !a) throw new Error(`usage: mood.mjs nudge <jid> <event>\nEvents: ${Object.keys(NUDGES).join(", ")}`);
    if (!NUDGES[a]) throw new Error(`Unknown event: ${a}\nEvents: ${Object.keys(NUDGES).join(", ")}`);
    chat = loadChat(jid);
    chat.mood = applyDeltas(normalize(chat.mood || newMood()), NUDGES[a]);
    saveChat(chat);
    show(chat);
    break;
  case "reset":
    if (!jid) throw new Error("usage: mood.mjs reset <jid>");
    chat = loadChat(jid);
    chat.mood = newMood();
    saveChat(chat);
    show(chat);
    break;
  default:
    console.log("usage: mood.mjs [list|show <jid>|set <jid> <key> <val>|nudge <jid> <event>|reset <jid>]");
}
