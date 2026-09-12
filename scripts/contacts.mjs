#!/usr/bin/env node
/**
 * contacts.mjs — see and manage per-contact identity.
 *
 *   node scripts/contacts.mjs list
 *   node scripts/contacts.mjs show <jid|number>
 *   node scripts/contacts.mjs set  <jid|number> name "Budi"
 *   node scripts/contacts.mjs set  <jid|number> nick "sayang"
 *   node scripts/contacts.mjs set  <jid|number> persona alya2
 *   node scripts/contacts.mjs set  <jid|number> notes "suka kopi"
 *   node scripts/contacts.mjs reset <jid|number>
 */
import { listChats, loadChat, saveChat, defaultChat } from "../src/store.mjs";

function resolve(id) {
  if (!id) return null;
  if (id.includes("@")) return id;
  const num = id.replace(/^\+/, "");
  const hit = listChats().find((c) => c.jid.startsWith(num) || (c.profile?.number || "").includes(num));
  return hit ? hit.jid : `${num}@s.whatsapp.net`;
}

function short(chat) {
  const p = chat.profile || {};
  return `${(p.name || "?").padEnd(18)} ${(p.number || chat.jid.split("@")[0]).padEnd(16)} msgs:${String(chat.stats?.inbound || 0).padStart(3)} mood:${(chat.mood?.valence ?? 0).toFixed(2)} persona:${chat.persona || "(default)"}`;
}

const [cmd, id, key, ...rest] = process.argv.slice(2);
const value = rest.join(" ");
const jid = resolve(id);

switch (cmd) {
  case "list":
  case "ls":
  case undefined: {
    const chats = listChats();
    if (!chats.length) {
      console.log("No contacts yet.");
      break;
    }
    for (const c of chats) console.log(short(c));
    break;
  }
  case "show":
    if (!jid) throw new Error("usage: contacts.mjs show <jid|number>");
    console.log(JSON.stringify(loadChat(jid), null, 2));
    break;
  case "set": {
    if (!jid || !key) throw new Error("usage: contacts.mjs set <jid|number> name|nick|persona|notes <value>");
    const chat = loadChat(jid);
    if (key === "persona") chat.persona = value;
    else if (["name", "nick", "number", "notes"].includes(key)) chat.profile[key] = value;
    else throw new Error(`unknown key: ${key}`);
    saveChat(chat);
    console.log("updated:", short(chat));
    break;
  }
  case "reset": {
    if (!jid) throw new Error("usage: contacts.mjs reset <jid|number>");
    const old = loadChat(jid);
    const fresh = { ...defaultChat(jid), profile: { ...defaultChat(jid).profile, number: old.profile?.number || "" } };
    saveChat(fresh);
    console.log("reset contact:", jid);
    break;
  }
  default:
    console.log("usage: contacts.mjs [list|show <id>|set <id> <name|nick|persona|notes> <value>|reset <id>]");
}
