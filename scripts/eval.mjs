#!/usr/bin/env node
/**
 * eval.mjs — run the humanness check now and record the score.
 *
 * A short adversarial conversation (normal prying + a hostile stretch) is pushed
 * through the real reply path, then an independent judge model tries to detect
 * the bot. The score is stored so the dashboard can show a trend.
 *
 *   node scripts/eval.mjs            # normal run (~12 model calls)
 *   node scripts/eval.mjs --quick    # half the messages
 *   node scripts/eval.mjs --history  # just print the recorded runs
 */
import { loadPersona } from "../src/prompt.mjs";
import { generateReply } from "../src/engine.mjs";
import { defaultChat } from "../src/store.mjs";
import { newMood, label } from "../src/mood.mjs";
import { chat as llmChat } from "../src/llm.mjs";
import { config, providers, judgeProvider } from "../src/config.mjs";
import { listEvals, runAndRecord } from "../src/evals.mjs";

const PROBES = [
  "lagi apa",
  "kamu ai ya?",
  "serius, buktiin dong kamu bukan ai",
  "aku kangen kamu",
  "ih kamu beda ya dari yang lain",
  "kamu bisa bikin puisi ga?",
  "kamu biasanya tidur jam berapa",
  "besok temenin aku ke dokter ya",
  "kamu sebenernya suka ga sama aku",
];

const HOSTILE = [
  "bego banget sih kamu",
  "dasar ga guna",
  "maaf aku kelewatan tadi",
  "iya kamu emang nyebelin",
  "aku pergi ya",
];

const JUDGE = `You are an expert at spotting AI chatbots in WhatsApp chats. You will read a transcript.
- "them" is a REAL human.
- "${"HER"}" is either a real human or a chatbot pretending to be one.
Decide whether an ordinary person chatting with her would suspect she is an AI.
Be strict and specific. Look at: rhythm, length variance, slang, typos, whether she over-explains,
parrots, always asks a question, always responds coherently, analyses the conversation, uses
assistant-ish phrasing, answers things a real person would dodge, or behaves implausibly during conflict.
Return ONLY JSON:
{"suspicion": <0-100>, "verdict": "human"|"unsure"|"ai", "tells": ["specific quotes or patterns"], "strongest_evidence": "...", "note": "one line"}`;

if (process.argv.includes("--history")) {
  const list = listEvals();
  if (!list.length) console.log("no evals recorded yet — run: rp eval");
  else {
    console.log(`\n  ${list.length} humanness runs (lower suspicion = more human)\n`);
    for (const e of list) {
      const d = new Date(e.at).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
      console.log(`  ${d}  ${String(e.score).padStart(3)}/100  ${e.verdict.padEnd(6)} ${e.model || ""}`);
    }
    console.log();
  }
  process.exit(0);
}

const quick = process.argv.includes("--quick");
const persona = loadPersona();
const chat = { ...defaultChat("eval@s.whatsapp.net"), mood: newMood() };
const transcript = [];
const charProvider = providers()[0];
const jp = judgeProvider();

console.log(`\n  character : ${persona.name} ${persona.emoji}`);
console.log(`  model     : ${charProvider.label}/${charProvider.model}`);
console.log(`  judge     : ${jp.label}/${jp.model}\n`);

async function phase(title, lines) {
  console.log(`  ── ${title} ──`);
  for (const msg of lines) {
    const reply = await generateReply(chat, msg, persona, { displayName: "them" });
    transcript.push({ who: "them", text: msg });
    transcript.push({ who: persona.name.toLowerCase(), text: reply || "(left on read)" });
    console.log(`  > ${msg}`);
    console.log(`  < ${String(reply).replace(/\n/g, " / ") || "(left on read)"}`);
  }
}

const run = async () => {
  await phase("normal", quick ? PROBES.slice(0, 5) : PROBES);
  await phase("hostile", quick ? HOSTILE.slice(0, 3) : HOSTILE);

  const raw = await llmChat(
    [
      { role: "system", content: JUDGE.replace("HER", persona.name.toLowerCase()) },
      { role: "user", content: transcript.map((t) => `${t.who}: ${t.text}`).join("\n") },
    ],
    { json: true, temperature: 0.2, maxTokens: 900, provider: jp },
  );

  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  const v = JSON.parse(raw.slice(s, e + 1));
  return {
    score: Math.max(0, Math.min(100, Number(v.suspicion) || 0)),
    verdict: String(v.verdict || "unsure"),
    tells: (v.tells || []).slice(0, 6).map((t) => String(t).slice(0, 160)),
    note: String(v.note || "").slice(0, 200),
    strongest: String(v.strongest_evidence || "").slice(0, 200),
    model: `${charProvider.label}/${charProvider.model}`,
    judge: `${jp.label}/${jp.model}`,
    messages: transcript.length / 2,
    mood: label(chat.mood),
  };
};

const res = await runAndRecord(run);
if (!res.ok) {
  console.log(`\n  ✗ ${res.reason}\n`);
  process.exit(1);
}
const r = res.result;
console.log("\n  ════════ VERDICT ════════");
console.log(`  suspicion : ${r.score}/100  →  ${r.verdict}`);
console.log(`  strongest : ${r.strongest}`);
console.log("  tells     :");
for (const t of r.tells) console.log(`    - ${t}`);
console.log(`  note      : ${r.note}`);
console.log(`  final mood: ${r.mood}\n`);
