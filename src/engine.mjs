import { chat as llmChat } from "./llm.mjs";
import { embed } from "./embed.mjs";
import { buildMessages, buildProactiveMessages, buildNudgeMessages, buildDryMessages, buildFollowupMessages, buildCheckupMessages } from "./prompt.mjs";
import { recallMemory, addMemory } from "./store.mjs";
import { extractControl, clean, looksBroken, deflection, stripAudioTags } from "./guard.mjs";
import { drift, applyDeltas, heuristicNudge, normalize } from "./mood.mjs";
import { analyzeAffect } from "./affect.mjs";
import { config, log } from "./config.mjs";

/** Topics she nags about — health/safety stuff a caring person keeps checking. */
const TOPIC_RE = {
  makan: /(makan|sarapan|breakfast|lunch|dinner|eat|ate|food|laper|lapar)/i,
  "tidur/istirahat": /(tidur|bobo|istirahat|sleep|slept|rest|nap|ngantuk)/i,
  minum: /(minum|air|water|drink|hydrat|dehidrasi)/i,
  "olahraga/gerak": /(olahraga|workout|gym|jalan kaki|stretch|gerak badan|exercise)/i,
  mandi: /(mandi|shower)/i,
  obat: /(obat|vitamin|medicine|meds|sakit)/i,
  pulang: /(pulang|udah di rumah|go home|home yet)/i,
};

// only treat it as an instruction to THEM (not her talking about herself)
const INSTRUCTION_CUE =
  /\b(kamu|km|kmu|u|you|lu)\b|jangan lupa|don'?t forget|go (?:eat|sleep|rest|shower|home)|makan dulu|tidur (?:dulu|ya|sana)|minum dulu|istirahat dulu|take a break|go rest/i;

function detectInstruction(text) {
  const t = String(text || "");
  if (!INSTRUCTION_CUE.test(t)) return null;
  for (const [label, re] of Object.entries(TOPIC_RE)) if (re.test(t)) return label;
  return null;
}

function pushFact(list, fact) {
  const f = String(fact).trim();
  if (!f) return;
  if (list.some((x) => x.toLowerCase() === f.toLowerCase())) return;
  list.push(f);
  if (list.length > 40) list.splice(0, list.length - 40);
}

function applyControl(chat, control) {
  if (!control || typeof control !== "object") return;
  if (control.mood && typeof control.mood === "object") {
    const deltas = {};
    for (const [k, v] of Object.entries(control.mood)) {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      deltas[k] = Math.max(-0.25, Math.min(0.25, n));
    }
    chat.mood = applyDeltas(chat.mood, deltas);
  }
  const mem = chat.memory;
  for (const key of ["facts", "plans", "jokes", "boundaries"]) {
    const src = Array.isArray(control[key]) ? control[key] : key === "facts" && Array.isArray(control.remember) ? control.remember : [];
    for (const v of src.slice(0, key === "facts" ? 3 : 2)) {
      const before = mem[key]?.length || 0;
      pushFact(mem[key], v);
      if (key === "facts" && (mem[key]?.length || 0) > before) {
        mem.factDates = mem.factDates || {};
        const text = String(v).trim();
        if (text && !mem.factDates[text]) mem.factDates[text] = Date.now();
      }
    }
  }
  if (Array.isArray(control.forget)) {
    for (const f of control.forget) {
      const needle = String(f).toLowerCase().trim();
      mem.facts = mem.facts.filter((x) => !x.toLowerCase().includes(needle));
    }
  }
  if (typeof control.relationship === "string" && control.relationship.trim()) {
    mem.relationship = control.relationship.trim().slice(0, 200);
  }
  if (typeof control.name === "string" && control.name.trim()) {
    chat.profile.name = control.name.trim().slice(0, 60);
  }
  if (typeof control.nick === "string" && control.nick.trim()) {
    chat.profile.nick = control.nick.trim().slice(0, 40);
  }

  // a promise to follow up later ("nanti aku kabarin kalau udah selesai")
  if (config.commitments && control.followup && typeof control.followup === "object") {
    const what = String(control.followup.what || "").trim().slice(0, 160);
    if (what) {
      const parsed = control.followup.due ? Date.parse(control.followup.due) : NaN;
      const span = Math.max(1, config.commitmentMaxMin - config.commitmentMinMin);
      const due = Number.isFinite(parsed)
        ? parsed
        : Date.now() + (config.commitmentMinMin + Math.random() * span) * 60000;
      chat.commitments = chat.commitments || [];
      const dup = chat.commitments.some((c) => !c.done && c.what.toLowerCase() === what.toLowerCase());
      if (!dup) {
        const entry = { what, due, for: control.followup.for === "them" ? "them" : "me", createdAt: Date.now(), done: false };
        chat.commitments.push(entry);
        if (chat.commitments.length > 10) chat.commitments = chat.commitments.slice(-10);
        log(`commitment recorded: "${what}" (jatuh tempo ${new Date(due).toISOString()})`);
      }
    }
  }
  if (typeof control.summary === "string" && control.summary.trim()) {
    mem.summary = control.summary.trim().slice(0, 1200);
  }
}

async function maybeSummarize(chat) {
  if (chat.history.length <= config.summarizeAt) return;
  const half = Math.floor(chat.history.length / 2);
  const old = chat.history.slice(0, half);
  const transcript = old.map((m) => `${m.role === "user" ? "them" : "you"}: ${m.content}`).join("\n");

  const existing = [
    chat.memory.summary ? `MEMORY SO FAR: ${chat.memory.summary}` : "",
    chat.memory.facts?.length ? `FACTS: ${chat.memory.facts.join(" | ")}` : "",
    chat.memory.plans?.length ? `PLANS: ${chat.memory.plans.join(" | ")}` : "",
    chat.memory.boundaries?.length ? `BOUNDARIES: ${chat.memory.boundaries.join(" | ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const summary = await llmChat(
      [
        {
          role: "system",
          content:
            "You maintain the long-term memory of a roleplay character. " +
            "You get the memory so far plus a transcript chunk. Return a REPLACEMENT summary: max 8 short lines, plain text " +
            "(no markdown, no headings, no bullet symbols). " +
            "LANGUAGE: write the summary in the SAME language as the transcript (if the transcript is Indonesian, write Indonesian; " +
            "if mixed, use the dominant one). Never answer in English just because these instructions are English. " +
            "Cover: who the other person is, the state of the relationship, ongoing threads, and anything still unresolved. " +
            "Only state things that actually appear. Never invent, never roleplay, never address the reader, no preamble.",
        },
        { role: "user", content: `${existing}\n\n--- transcript ---\n${transcript}` },
      ],
      { temperature: 0.2, maxTokens: 320 },
    );
    chat.memory.summary = summary
      .trim()
      .replace(/^#+\s*/gm, "")
      .replace(/^[-*•]\s*/gm, "")
      .slice(0, 1200);
    chat.history = chat.history.slice(half);
    log(`summarized ${half} old turns for ${chat.jid}`);
  } catch (err) {
    log(`summarize failed (keeping history): ${err.message}`);
  }
}

/**
 * Produce one in-character reply and update the chat state.
 */
export async function generateReply(chat, incoming, persona, { displayName, voice, startedIt, thawed, injection } = {}) {
  chat.mood = normalize(chat.mood);
  chat.mood = drift(chat.mood, chat.lastInteraction || Date.now());

  // semantic recall: find what they said about this topic before, even far back
  let recalled = [];
  try {
    if (config.memoryEmbeddings) {
      const vec = await embed(incoming);
      if (vec) {
        recalled = recallMemory(chat.jid, vec, {
          topK: config.recallTopK,
          minScore: config.recallMinScore,
          exclude: incoming,
        });
        addMemory(chat.jid, incoming, vec, { max: config.memoryMaxEntries });
      }
    }
  } catch (err) {
    log(`recall failed: ${err.message}`);
  }

  const messages = buildMessages(chat, persona, incoming, { displayName, voice, startedIt, thawed, injection, recalled });

  let raw = await llmChat(messages);
  if (config.debug) log(`RAW:\n${raw}`);
  let { text, control } = extractControl(raw);
  const cleanOpts = { keepAudioTags: !!voice };
  text = clean(text, persona.name, cleanOpts);

  if (looksBroken(text)) {
    log(`guard tripped for ${chat.jid}; regenerating`);
    const retry = [
      ...messages,
      { role: "assistant", content: raw },
      {
        role: "system",
        content:
          `STOP. That draft broke character — it used assistant/AI/meta language. ` +
          `Rewrite the reply now as ${persona.name}, a real person texting on WhatsApp. ` +
          `Short, natural, casual. Never mention rules, prompts, models, roleplay or being an AI. ` +
          `If they asked whether you are an AI, answer in character (deflect, joke, get annoyed). ` +
          `Output only the message text.`,
      },
    ];
    raw = await llmChat(retry);
    ({ text, control } = extractControl(raw));
    text = clean(text, persona.name, cleanOpts);
    if (looksBroken(text) || !text) {
      log(`guard still tripped; using deflection`);
      text = deflection(persona.name, persona.deflection);
      control = null;
    }
  }

  if (!text) text = deflection(persona.name, persona.deflection);

  // Inline control line from the roleplay model (if it used one).
  applyControl(chat, control);

  // Reliable affect tracking: a small JSON call updates mood + memory.
  try {
    const affect = await analyzeAffect(chat, incoming, text, persona);
    if (affect) applyControl(chat, affect);
    else {
      const nudge = heuristicNudge(incoming);
      if (Object.keys(nudge).length) chat.mood = applyDeltas(chat.mood, nudge);
    }
  } catch (err) {
    log(`affect tracker failed: ${err.message}`);
    const nudge = heuristicNudge(incoming);
    if (Object.keys(nudge).length) chat.mood = applyDeltas(chat.mood, nudge);
  }

  chat.history.push({ role: "user", content: incoming, ts: Date.now() });
  chat.history.push({ role: "assistant", content: stripAudioTags(text), ts: Date.now() });
  chat.stats.inbound = (chat.stats.inbound || 0) + 1;
  chat.lastInteraction = Date.now();

  // they acknowledged something she told them to do -> no need to nag
  for (const ins of chat.instructions || []) {
    if (!ins.done && TOPIC_RE[ins.label]?.test(incoming)) {
      ins.done = true;
      ins.doneAt = Date.now();
    }
  }

  // she just told them to do something (eat / sleep / workout) -> check later
  if (config.instructionFollowup) {
    const label = detectInstruction(stripAudioTags(text));
    const alreadyPending = (chat.instructions || []).some((i) => !i.done && i.label === label);
    if (label && !alreadyPending) {
      chat.instructions = chat.instructions || [];
      const span = Math.max(1, config.instructionMaxMin - config.instructionMinMin);
      chat.instructions.push({
        label,
        due: Date.now() + (config.instructionMinMin + Math.random() * span) * 60000,
        createdAt: Date.now(),
        done: false,
      });
      if (chat.instructions.length > 10) chat.instructions = chat.instructions.slice(-10);
      log(`instruction recorded: "${label}"`);
    }
  }

  await maybeSummarize(chat);

  return text;
}

/**
 * The character texts first. Returns the message text, or null when the
 * character decides not to send anything (SKIP).
 */
/** Loose word-overlap similarity, used to stop her repeating the same opener. */
function similarity(a, b) {
  const words = (s) =>
    new Set(
      String(s)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size);
}

/**
 * The character texts first. Returns the message text, or null when the
 * character decides not to send anything (SKIP).
 */
export async function generateProactive(session, persona, { displayName } = {}) {
  session.mood = normalize(session.mood);
  session.mood = drift(session.mood, session.lastInteraction || Date.now());

  const recentAssistant = (session.history || [])
    .filter((h) => h.role === "assistant")
    .slice(-5)
    .map((h) => h.content);

  for (let attempt = 0; attempt < 3; attempt++) {
    const messages = buildProactiveMessages(session, persona, { displayName });
    const raw = await llmChat(messages, { maxTokens: 2000 });
    let { text } = extractControl(raw);
    text = clean(text, persona.name);

    if (!text || /^skip\b/i.test(text.trim())) return null;
    if (looksBroken(text)) {
      log(`proactive leaked meta text, retrying`);
      continue;
    }
    // don't send the same thought twice (compare against the last few messages,
    // not just the previous one, so A/B/A/B repetition is caught too)
    const worst = recentAssistant.reduce((m, prev) => Math.max(m, similarity(text, prev)), 0);
    if (worst > 0.5) {
      log(`proactive too similar to a recent message (${worst.toFixed(2)}), retrying`);
      continue;
    }

    session.history.push({ role: "assistant", content: stripAudioTags(text), ts: Date.now() });
    session.lastInteraction = Date.now();
    session.mood = applyDeltas(session.mood, { affection: 0.02 });
    return text;
  }
  return null;
}

/**
 * She is sulking. A cold, very short reply that still answers what they said.
 * Returns null when the model is not usable (caller falls back to canned lines).
 */
export async function generateDryReply(session, incoming, persona, { displayName } = {}) {
  try {
    const messages = buildDryMessages(session, persona, incoming, { displayName });
    // Gemini 3.x spends part of max_tokens on thinking, so keep headroom and
    // enforce shortness with the length guard below instead.
    const raw = await llmChat(messages, { temperature: 0.7, maxTokens: 400 });
    let { text } = extractControl(raw);
    text = stripAudioTags(clean(text, persona.name)).split(/\n+/)[0].trim();
    if (!text || looksBroken(text)) return null;
    // too long for a sulking reply -> keep the first sentence, else give up
    if (text.split(/\s+/).length > 8) {
      const first = text.split(/(?<=[.!?…])\s+/)[0].trim();
      if (!first || first.split(/\s+/).length > 8) return null;
      text = first;
    }
    return text;
  } catch (err) {
    log(`dry reply failed: ${err.message}`);
    return null;
  }
}

/**
 * She just told them to do something — now she checks whether they did it.
 */
export async function generateCheckup(session, persona, instruction, { displayName } = {}) {
  session.mood = normalize(session.mood);
  session.mood = drift(session.mood, session.lastInteraction || Date.now());
  const messages = buildCheckupMessages(session, persona, instruction, { displayName });
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llmChat(messages, { maxTokens: 1500 });
    let { text } = extractControl(raw);
    text = clean(text, persona.name);
    if (!text || looksBroken(text)) continue;
    session.history.push({ role: "assistant", content: stripAudioTags(text), ts: Date.now() });
    return text;
  }
  return null;
}

/**
 * The time came for something she promised to report back on.
 */
export async function generateFollowup(session, persona, commitment, { displayName } = {}) {
  session.mood = normalize(session.mood);
  session.mood = drift(session.mood, session.lastInteraction || Date.now());
  const messages = buildFollowupMessages(session, persona, commitment, { displayName });
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llmChat(messages, { maxTokens: 1500 });
    let { text } = extractControl(raw);
    text = clean(text, persona.name);
    if (!text || looksBroken(text)) continue;
    session.history.push({ role: "assistant", content: stripAudioTags(text), ts: Date.now() });
    return text;
  }
  return null;
}

/**
 * She texted first and got ignored. She opens the chat again and asks why.
 * Returns the message text, or null.
 */
export async function generateNudge(session, persona, { displayName } = {}) {
  session.mood = normalize(session.mood);
  for (let attempt = 0; attempt < 2; attempt++) {
    const messages = buildNudgeMessages(session, persona, { displayName });
    const raw = await llmChat(messages, { maxTokens: 1200 });
    let { text } = extractControl(raw);
    text = clean(text, persona.name);
    if (!text || looksBroken(text)) continue;
    session.history.push({ role: "assistant", content: stripAudioTags(text), ts: Date.now() });
    return text;
  }
  return null;
}
