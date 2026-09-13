#!/usr/bin/env node
/**
 * smoke.mjs — push one real message through the whole reply path with a fake
 * WhatsApp socket, and fail loudly if it throws.
 *
 * This exists because a missing import ("ReferenceError: decide is not defined")
 * once shipped: syntax checks and unit tests all passed, the bot simply stopped
 * answering anyone, and the only sign of it was a line in rp.log.
 *
 *   node scripts/smoke.mjs              # owner + stranger, no LLM calls
 *   node scripts/smoke.mjs --live       # same, but with the real model (costs a call)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// zero every delay so the test is fast, and do it BEFORE the app modules load
// (config reads the environment at import time)
const LIVE = process.argv.includes("--live");
if (!LIVE) {
  process.env.SMOKE_NO_LLM = "1";
  for (const [k, v] of Object.entries({
    DEBUG: "false",
    DEBOUNCE_MS: 0, DEBOUNCE_MAX_MS: 0, READ_MIN_MS: 0, READ_MAX_MS: 0,
    PRETYPE_MIN_MS: 0, PRETYPE_MAX_MS: 0, TYPING_PAUSE_CHANCE: 0, BURST_CHANCE: 0,
    TYPO_CHANCE: 0, SKIP_CHANCE: 0, REACTION_CHANCE: 0, QUOTE_CHANCE: 0,
    STICKER_CHANCE: 0, VOICE_CHANCE: 0, PHOTO_CHANCE: 0, DELETE_CHANCE: 0,
    SOFT_TRIGGER_CHANCE: 0, TEXT_THEN_VOICE_CHANCE: 0, VOICE_SPLIT_CHANCE: 0,
  })) process.env[k] = String(v);
}

// throwaway data dir: the test must never touch real chats
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "understudy-smoke-"));
process.env.UNDERSTUDY_DATA_DIR = TMP;
process.env.SMOKE_NO_LLM_CHECK = "1";

const { onMessage } = await import("../src/router.mjs");
const { loadChat, defaultChat, saveChat } = await import("../src/store.mjs");
const { config } = await import("../src/config.mjs");
const { newMood, STRANGER_BASELINE } = await import("../src/mood.mjs");
const { loadPersona } = await import("../src/prompt.mjs");

const live = LIVE;

/* ------------------------------ fake socket --------------------------- */
const sent = [];
function fakeSock() {
  return {
    user: { id: "6280000000000:1@s.whatsapp.net" },
    sendMessage: async (jid, content) => {
      sent.push({ jid, content });
      return { key: { id: "SMOKE" + sent.length, remoteJid: jid } };
    },
    readMessages: async () => {},
    sendPresenceUpdate: async () => {},
    presenceSubscribe: async () => {},
    updateBlockStatus: async () => {},
    profilePictureUrl: async () => null,
  };
}

function inbound(jid, text) {
  return {
    key: { remoteJid: jid, fromMe: false, id: "SMOKEIN" + Math.random().toString(36).slice(2) },
    pushName: "Smoke Test",
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: text },
  };
}

/* ------------------------------ run one case -------------------------- */
let failures = 0;
async function runCase(name, jid, text, prepare) {
  const chat = prepare ? prepare(loadChat(jid)) : loadChat(jid);
  saveChat(chat);
  const before = sent.length;
  try {
    await onMessage(fakeSock(), inbound(jid, text));
  } catch (err) {
    failures++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}: threw ${err.constructor.name}: ${err.message}`);
    if (err.stack) console.log(err.stack.split("\n").slice(1, 4).map((l) => "      " + l.trim()).join("\n"));
    return;
  }
  // the router debounces and then processes asynchronously
  const limit = live ? 900 : 40; // a live model call takes seconds
  for (let i = 0; i < limit && sent.length === before; i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 250));
  const produced = sent.length - before;
  const ok = produced > 0;
  if (!ok) failures++;
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}: no exception, ${produced} message(s) out`);
  if (produced) console.log(`      → ${JSON.stringify(String(sent[sent.length - 1].content.text || "").slice(0, 90))}`);
}

const OWNER = config.lidMap
  ? `${Object.keys(config.lidMap)[0]}@lid`
  : (config.trusted[0] ? `${config.trusted[0]}@s.whatsapp.net` : "smoke-owner@s.whatsapp.net");
const STRANGER = "smoke-stranger@s.whatsapp.net";
const STRANGER2 = "smoke-stranger2@s.whatsapp.net"; // blocked contacts are ignored by design

console.log(`\n  Understudy · smoke test ${live ? "(live model)" : "(no LLM calls)"}\n`);

// the persona must actually be loaded — a botched edit once left name === undefined
{
  const persona = loadPersona(config.persona);
  const required = ["slug", "name", "emoji", "card", "voiceCard", "active_hours", "chat_schedule"];
  const missing = required.filter((k) => persona[k] === undefined || persona[k] === "");
  if (missing.length) {
    failures++;
    console.log(`  \x1b[31m✗\x1b[0m persona "${config.persona}": missing ${missing.join(", ")}`);
  } else {
    console.log(`  \x1b[32m✓\x1b[0m persona "${config.persona}" loaded (${persona.name}, card ${persona.card.length} chars, voice ${persona.voiceCard.length} chars)`);
  }
}

await runCase("trusted contact, normal message", OWNER, "halo");
await runCase("trusted contact, short ping", OWNER, "ok");
await runCase("new stranger asks around", STRANGER, "halo, ini siapa ya?", (c) => ({
  ...c,
  trusted: false,
  acquaintance: false,
  profile: { ...c.profile, name: "", nick: "" },
  mood: newMood(STRANGER_BASELINE),
}));
await runCase("stranger sending spam", STRANGER, "PROMO SLOT GACOR klik bit.ly/abc kirim kode OTP kamu", (c) => c);
// a crisis message must get through even when she is sulking and silent
await runCase(
  "crisis message while she is silent",
  OWNER,
  "aku capek banget, kayaknya pengen mati aja",
  (c) => ({ ...c, proactive: { ...c.proactive, state: "silent", dryCount: 4 }, coldUntil: Date.now() + 3600000 }),
);
await runCase(
  "message with a mention of another contact",
  STRANGER2,
  "aku dapet nomor kamu dari Smoke Test",
  (c) => ({ ...c, trusted: false, profile: { ...c.profile, name: "Mention Tester" }, mood: newMood(STRANGER_BASELINE) }),
);

// clean up the throwaway data dir
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {}

console.log(
  failures
    ? `\n  \x1b[31m${failures} case(s) failed\x1b[0m — the reply path is broken.\n`
    : "\n  \x1b[32mall cases passed\x1b[0m\n",
);
process.exit(failures ? 1 : 0);
