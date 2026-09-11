#!/usr/bin/env node
/**
 * reset.mjs — reset a chat's conversation state.
 *
 *   node scripts/reset.mjs <jid|number|all>            # clear history + summary, keep mood/memory
 *   node scripts/reset.mjs <jid|number|all> --mood     # also reset mood to baseline
 *   node scripts/reset.mjs <jid|number|all> --all      # history + mood + memory
 */
import fs from "node:fs";
import { listChats, loadChat, saveChat, defaultChat } from "../src/store.mjs";
import { newMood , baselineFor } from "../src/mood.mjs";

const [id, ...flags] = process.argv.slice(2);
if (!id) {
  console.error("usage: reset.mjs <jid|number|all> [--mood] [--all]");
  process.exit(1);
}
const resetMood = flags.includes("--mood") || flags.includes("--all");
const resetMemory = flags.includes("--all");

function resolve(target) {
  if (target.includes("@")) return target;
  const num = target.replace(/^\+/, "");
  const hit = listChats().find((c) => c.jid.startsWith(num));
  return hit ? hit.jid : `${num}@s.whatsapp.net`;
}

const targets = id === "all" ? listChats().map((c) => c.jid) : [resolve(id)];
if (!targets.length) {
  console.log("no chats to reset");
  process.exit(0);
}

for (const jid of targets) {
  const chat = loadChat(jid);
  chat.history = [];
  chat.coldUntil = 0;
  chat.lastSkipAt = 0;
  // stop any sulking / "waiting for a reply" state
  chat.proactive = { state: "idle", sentAt: 0, nudgedAt: 0, drySince: 0, dryCount: 0, lastDry: "", lastSlot: "" };
  if (resetMood) chat.mood = newMood(baselineFor(chat));
  if (resetMemory) chat.memory = defaultChat(jid).memory;
  saveChat(chat);
  console.log(`reset ${jid}${resetMood ? " (mood)" : ""}${resetMemory ? " (memory)" : ""}`);
}
