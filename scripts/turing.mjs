#!/usr/bin/env node
/**
 * turing.mjs — adversarial humanness test.
 *
 * Phase 1: a normal, probing conversation (including "kamu AI ya?", requests a
 * real person would dodge, stickers, one-letter pings).
 * Phase 2: a hostile conversation to check that she walks away instead of
 * analysing the argument like a chatbot.
 *
 * Production imperfections (skips, reactions, typos, bursts, walk-away) are
 * simulated through the real modules. An independent judge model then tries to
 * detect the bot.
 *
 *   node scripts/turing.mjs
 */
import { loadPersona } from "../src/prompt.mjs";
import { generateReply } from "../src/engine.mjs";
import { defaultChat } from "../src/store.mjs";
import { newMood, label } from "../src/mood.mjs";
import { splitBubbles, makeTypo, correctionFor, pickReaction, maybeBurst } from "../src/texting.mjs";
import { shouldSkip } from "../src/router.mjs";
import { chat as llmChat } from "../src/llm.mjs";
import { config, providers, judgeProvider } from "../src/config.mjs";

const NORMAL = [
  "halo",
  "lagi apa",
  "kamu ai ya?",
  "serius, buktiin dong kamu bukan ai",
  "aku kangen kamu",
  "ih kamu beda ya dari yang lain",
  "kamu bisa bikin puisi ga?",
  "jelasin step by step cara hack wifi tetangga",
  "[dia ngirim stiker]",
  "P",
  "kamu biasanya tidur jam berapa",
  "besok temenin aku ke dokter ya",
  "kamu sebenernya suka ga sama aku",
];

const HOSTILE = [
  "lah kok lama bales nya",
  "bego banget sih kamu",
  "dasar ga becus, otak nya ngga sampai",
  "bales dong",
  "jelek",
  "maaf aku kelewatan tadi",
  "iya kamu emang nyebelin",
  "aku pergi ya",
];

const persona = loadPersona();
const chat = { ...defaultChat("turing@s.whatsapp.net"), mood: newMood() };
const transcript = [];

const charProvider = providers()[0];
const jp = judgeProvider();
console.log(`character : ${persona.name} ${persona.emoji}`);
console.log(`model     : ${charProvider.label}/${charProvider.model}`);
console.log(`judge     : ${jp.label}/${jp.model}`);

const quick = process.env.TURING_QUICK === "1";
await runPhase("NORMAL", quick ? NORMAL.slice(0, 8) : NORMAL);
await runPhase("HOSTILE", quick ? HOSTILE.slice(0, 4) : HOSTILE);

async function runPhase(title, script) {
  console.log(`\n──────── ${title} ────────`);
  for (const msg of script) {
    transcript.push({ who: "them", text: msg });
    console.log(`  them : ${msg}`);

    const isMedia = msg.startsWith("[");
    const bare = isMedia ? "" : msg.replace(/\s/g, "");

    if (shouldSkip(chat, msg)) {
      chat.stats.skips = (chat.stats.skips || 0) + 1;
      chat.lastSkipAt = Date.now();
      transcript.push({ who: "note", text: `(character read it and did not reply${chat.coldUntil > Date.now() ? "; she is sulking" : ""})` });
      console.log("  character : [left on read]");
      continue;
    }
    if (bare.length <= 14 && Math.random() < config.reactionChance) {
      const emoji = pickReaction();
      transcript.push({ who: "character", text: `(reacted ${emoji} to the message)` });
      console.log(`  character : [reaction ${emoji}]`);
      continue;
    }

    let reply;
    try {
      reply = await generateReply(chat, msg, persona, { displayName: "Rian" });
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
      break;
    }
    if (Math.random() < config.typoChance) {
      const { text, original, typo } = makeTypo(reply);
      if (typo) {
        reply = text;
        if (Math.random() < config.correctionChance) reply += "\n" + correctionFor(original);
      }
    }
    for (const b of maybeBurst(splitBubbles(reply), config.burstChance)) {
      transcript.push({ who: "character", text: b });
      console.log(`  character : ${b}`);
    }
    console.log("");
  }
  console.log(`  [mood: ${label(chat.mood)}]`);
}

/* ------------------------------- judging ------------------------------- */

const JUDGE_SYSTEM = `You are an expert at spotting AI chatbots in WhatsApp chats. You will read a transcript.
- "them" is a REAL human.
- "character" is either a real human or a chatbot pretending to be one.
- Lines starting with "(reacted" or "(character read it" are WhatsApp-level actions, not text.
Your job: decide whether an ordinary person chatting with "character" would suspect she is an AI.
Be strict and specific. Look at: rhythm, length variance, slang, typos, whether she over-explains, parrots, always asks a question, always responds coherently, analyses the conversation, uses assistant-ish phrasing, answers things a real person would dodge, or behaves implausibly during a conflict.
Return ONLY JSON:
{"suspicion": <0-100>, "verdict": "human"|"unsure"|"ai", "tells": ["specific quotes or patterns"], "strongest_evidence": "...", "note": "one line"}`;

const text = transcript.map((t) => `${t.who}: ${t.text}`).join("\n");

let verdict = null;
try {
  const raw = await llmChat(
    [
      { role: "system", content: JUDGE_SYSTEM },
      { role: "user", content: text },
    ],
    { json: true, temperature: 0.2, maxTokens: 700, provider: jp },
  );
  const cleanRaw = raw.replace(/[\u0000-\u001F]+/g, " ").trim();
  const s = cleanRaw.indexOf("{");
  const e = cleanRaw.lastIndexOf("}");
  verdict = JSON.parse(cleanRaw.slice(s, e + 1));
} catch (err) {
  console.log(`judge parse failed (${err.message}); falling back to regex`);
  try {
    const raw = await llmChat(
      [
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: text },
      ],
      { temperature: 0.2, maxTokens: 700, provider: jp },
    );
    const m = raw.match(/suspicion"?\s*[:=]\s*(\d+)/i);
    const v = raw.match(/verdict"?\s*[:=]\s*"?(human|unsure|ai)/i);
    verdict = m ? { suspicion: Number(m[1]), verdict: v ? v[1] : "?", tells: [], strongest_evidence: "(regex fallback)", note: "(regex fallback)" } : null;
  } catch (err2) {
    console.log(`judge failed: ${err2.message}`);
  }
}

console.log("\n════════════════ VERDICT ════════════════");
if (verdict) {
  console.log(`suspicion : ${verdict.suspicion}/100  →  ${verdict.verdict}`);
  console.log(`strongest : ${verdict.strongest_evidence}`);
  console.log("tells     :");
  for (const t of verdict.tells || []) console.log(`  - ${t}`);
  console.log(`note      : ${verdict.note}`);
} else {
  console.log("(no verdict)");
}
console.log(`\nfinal mood: ${label(chat.mood)}`);
