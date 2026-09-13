import { chat as llmChat } from "./llm.mjs";
import { embed } from "./embed.mjs";
import { buildMessages, buildProactiveMessages, buildNudgeMessages, buildDryMessages, buildFollowupMessages, buildCheckupMessages } from "./prompt.mjs";
import { recallMemory, addMemory } from "./store.mjs";
import { extractControl, clean, looksBroken, deflection, stripAudioTags, tameTics } from "./guard.mjs";
import { drift, applyDeltas, heuristicNudge, normalize, baselineFor, isMoodLocked, lockValue } from "./mood.mjs";
import { analyzeAffect } from "./affect.mjs";
import { needsIntroduction, markIntroAsked } from "./stranger.mjs";
import { validateTask } from "./tasks.mjs";
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

/* ------------------------------ memory ------------------------------- */

function applyControl(chat, control, incoming = "") {
  if (!control || typeof control !== "object") return;
  if (control.mood && typeof control.mood === "object") {
    const deltas = {};
    for (const [k, v] of Object.entries(control.mood)) {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      deltas[k] = Math.max(-0.25, Math.min(0.25, n));
    }
    bump(chat, deltas);
  }
  const mem = chat.memory;
  for (const key of ["facts", "plans", "jokes", "boundaries"]) {
    const src = Array.isArray(control[key]) ? control[key] : key === "facts" && Array.isArray(control.remember) ? control.remember : [];
    for (const v of src.slice(0, key === "facts" ? 3 : 2)) {
      const before = mem[key]?.length || 0;
      pushFact(mem[key], v, key === "facts" ? { trivia: true } : {});
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
    const n = control.name.trim().slice(0, 60);
    // never let the tracker invent a name: it may only be set when the person
    // actually wrote it themselves (or when we have no name yet)
    const saidIt = incoming.toLowerCase().includes(n.toLowerCase());
    if (saidIt || !chat.profile.name) chat.profile.name = n;
    else log(`ignored invented name "${n}" (keeping "${chat.profile.name}")`);
  }
  if (typeof control.nick === "string" && control.nick.trim()) {
    // strangers do not get a pet name, no matter what the model thinks
    if (chat.trusted === true) chat.profile.nick = control.nick.trim().slice(0, 40);
    else log(`ignored nick "${control.nick.trim()}" (untrusted contact)`);
  }

  // a promise to follow up later ("nanti aku kabarin kalau udah selesai")
  // she only makes promises to people she knows
  if (config.commitments && chat.trusted === true && control.followup && typeof control.followup === "object") {
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
  // she was asked to message somebody else — queue it, the router sends it
  if (control.task && typeof control.task === "object" && Object.keys(control.task).length) {
    const check = validateTask(chat, control.task);
    if (check.ok) chat.pendingTasks = [...(chat.pendingTasks || []), check.task].slice(-3);
    else log(`task refused: ${check.reason}`);
  }
  if (typeof control.summary === "string" && control.summary.trim()) {
    mem.summary = control.summary.trim().slice(0, 1200);
  }
}

/* ------------------------------ memory ------------------------------- */

// words that carry no meaning for comparing two memory lines
const STOPWORDS = new Set(
  ["yang","dan","di","ke","dari","itu","ini","aku","kamu","dia","sudah","udah","masih","lagi","gak","ga","nggak","tidak","bikin","buat","sama","juga","terus","dengan","untuk","pas","saat","kalau","biar","the","a","an","to","of","is","it","he","she","i","you","and","or","for","on","in","at","that","this","his","her","not","no","do","does"],
);
function memTokens(s) {
  return new Set(
    String(s)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}
function memSimilar(a, b) {
  const A = memTokens(a), B = memTokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Facts must be ABOUT them, not a transcript of the last message. The tracker
 * loves writing "Bilang \"tch\" — bereaksi kesal", which is worthless a week later.
 */
const TRIVIA_VERB =
  /^(bilang|berkata|mengatakan|mengucap|menyebut|menulis|menjawab|membalas|merespons|bereaksi|bertanya|menanyakan|meminta|memohon|mengancam|menegaskan|menyalahkan|meniru|mengeluh|bercanda|tertawa|menyerah|menolak|menyindir|menuding)\b/i;

function looksLikeTrivia(text) {
  const s = String(text || "").trim();
  if (!s) return true;
  if (TRIVIA_VERB.test(s)) return true;
  if (/^["'“”]/.test(s)) return true;
  // "something \"quoted phrase\" something" near the start
  if (/^[^—]{0,40}["“][^"”]{3,60}["”]/.test(s)) return true;
  return false;
}

/** Add a memory line, folding it into a near-identical one instead of duplicating. */
function pushFact(list, fact, { max = 40, threshold = 0.5, trivia = false } = {}) {
  const f = String(fact).trim();
  if (!f) return;
  if (trivia && looksLikeTrivia(f)) return;
  for (let i = 0; i < list.length; i++) {
    const ex = String(list[i]);
    if (ex.toLowerCase() === f.toLowerCase()) return;
    if (memSimilar(f, ex) >= threshold) {
      // keep whichever version says more
      if (f.length > ex.length + 6) list[i] = f;
      else return;
    }
  }
  list.push(f);
  if (list.length > max) list.splice(0, list.length - max);
}

/**
 * Rewrite the long-term memory: one runnable summary plus consolidated lists.
 * Runs on the same schedule as before, but now it also merges the duplicated
 * "jangan panggil honey" style lines and drops what is no longer true.
 */
export async function consolidateMemory(chat, { force = false } = {}) {
  if (!force && chat.history.length <= config.summarizeAt) return false;
  const half = force ? chat.history.length : Math.floor(chat.history.length / 2);
  const old = chat.history.slice(0, half);
  const transcript = old.map((m) => `${m.role === "user" ? "them" : "you"}: ${m.content}`).join("\n");
  const mem = chat.memory || (chat.memory = {});

  const existing = [
    mem.summary ? `MEMORY SO FAR: ${mem.summary}` : "",
    mem.relationship ? `RELATIONSHIP: ${mem.relationship}` : "",
    mem.facts?.length ? `FACTS: ${mem.facts.join(" | ")}` : "",
    mem.plans?.length ? `PLANS: ${mem.plans.join(" | ")}` : "",
    mem.boundaries?.length ? `BOUNDARIES: ${mem.boundaries.join(" | ")}` : "",
    mem.jokes?.length ? `JOKES: ${mem.jokes.join(" | ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const system = [
    "You maintain the long-term memory of a roleplay character.",
    "You get the memory so far plus a transcript chunk. Rewrite the memory: merge duplicates, drop anything that is no longer true, keep the most specific wording.",
    "Answer with EXACTLY these five sections, in this order, nothing else:",
    "SUMMARY:",
    "(max 8 short lines, plain text, no bullets) who they are, state of the relationship, open threads)",
    "FACTS:",
    "(REBUILD THIS FROM SCRATCH from the transcript — do not copy the trivia lines from the memory so far. Durable things about THEM: work, habits, health, family, preferences, important events. NOT quotes of what they said, not their reactions, not what happened in one message — drop all trivia.)",
    "(max 15 lines, one per line, each starting with '- ')",
    "BOUNDARIES:",
    "(max 8 lines, one per line, each starting with '- ') things she must not do around them",
    "PLANS:",
    "(max 6 lines, one per line, each starting with '- ') ongoing promises and plans",
    "JOKES:",
    "(max 5 lines, one per line, each starting with '- ') running jokes and callbacks",
    "LANGUAGE: same language as the transcript (Indonesian transcript -> Indonesian). Never answer in English just because these instructions are English.",
    `The other person's name is ${JSON.stringify(chat.profile?.name || "")} — use exactly that name. Never invent or guess a name; if it is empty, do not use any name at all.`,
    "Lines that say the same thing in different words MUST be merged into one line, but keep every DISTINCT rule: never drop a boundary just because another one looks similar. Drop only what is no longer true.",
    "Only state things that actually appear. Never invent, never roleplay, never address the reader, no preamble.",
  ].join("\n");

  let out;
  try {
    out = await llmChat(
      [
        { role: "system", content: system },
        { role: "user", content: `${existing}\n\n--- transcript ---\n${transcript}` },
      ],
      { temperature: 0.2, maxTokens: 1800 },
    );
  } catch (err) {
    log(`memory consolidation failed: ${err.message}`);
    return false;
  }

  const sections = {};
  let current = "summary";
  sections[current] = [];
  for (const rawLine of String(out).split(/\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const head = line.match(/^(SUMMARY|FACTS|BOUNDARIES|PLANS|JOKES)\s*:\s*(.*)$/i);
    if (head) {
      current = head[1].toLowerCase();
      sections[current] = sections[current] || [];
      if (head[2]) sections[current].push(head[2]);
      continue;
    }
    sections[current] = sections[current] || [];
    sections[current].push(line.replace(/^[-*•\d.\s]+/, ""));
  }

  const clean = (arr, max, threshold, trivia = false) => {
    const out2 = [];
    for (const item of (arr || []).map((s) => String(s).replace(/\s+/g, " ").trim()).filter(Boolean)) {
      pushFact(out2, item, { max, threshold, trivia });
    }
    return out2;
  };

  const summary = (sections.summary || []).join("\n").replace(/^#+\s*/gm, "").slice(0, 1200).trim();
  if (summary) mem.summary = summary;
  // whatever you pinned in the dashboard survives the rebuild
  for (const p of mem.pinned || []) {
    const target = ["facts", "boundaries", "plans", "jokes"].includes(p.list) ? p.list : null;
    if (!target) continue;
    mem[target] ||= [];
    if (!mem[target].some((x) => String(x).toLowerCase() === String(p.text).toLowerCase())) mem[target].push(p.text);
  }
  if (sections.facts) mem.facts = clean(sections.facts, 20, 0.5, true);
  if (sections.boundaries) mem.boundaries = clean(sections.boundaries, 12, 0.45);
  if (sections.plans) mem.plans = clean(sections.plans, 10, 0.5);
  if (sections.jokes) mem.jokes = clean(sections.jokes, 8, 0.5);

  if (!force) chat.history = chat.history.slice(half);
  log(
    `memory consolidated: ${half} turns · facts ${mem.facts?.length || 0} · boundaries ${
      mem.boundaries?.length || 0
    }`,
  );
  return true;
}

async function maybeSummarize(chat) {
  await consolidateMemory(chat);
}

/**
 * Keep a small mood history for the dashboard sparkline: one sample every
 * 30 minutes, at most two days' worth.
 */
function sampleMood(chat) {
  const m = chat.mood;
  if (!m) return;
  chat.moodHistory ||= [];
  const last = chat.moodHistory[chat.moodHistory.length - 1];
  if (last && Date.now() - last.t < 30 * 60000) return;
  chat.moodHistory.push({
    t: Date.now(),
    v: Number(m.valence.toFixed(2)),
    e: Number(m.energy.toFixed(2)),
    a: Number(m.affection.toFixed(2)),
  });
  if (chat.moodHistory.length > 96) chat.moodHistory = chat.moodHistory.slice(-96);
}

/** Change the mood — unless the dashboard locked it for this contact. */
function bump(session, deltas) {
  if (isMoodLocked(session)) { session.mood = lockValue(session); return; }
  session.mood = applyDeltas(session.mood, deltas);
}

function reDrift(session) {
  if (isMoodLocked(session)) { session.mood = lockValue(session); return; }
  session.mood = drift(session.mood, session.lastInteraction || Date.now(), Date.now(), baselineFor(session));
}

/**
 * Produce one in-character reply and update the chat state.
 */
export async function generateReply(chat, incoming, persona, { displayName, voice, startedIt, thawed, injection, worried } = {}) {
  chat.mood = normalize(chat.mood);
  reDrift(chat);

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

  const messages = buildMessages(chat, persona, incoming, { displayName, voice, startedIt, thawed, injection, recalled, worried });
  // she just asked a stranger who they are — do not ask again next message
  if (needsIntroduction(chat)) markIntroAsked(chat);

  let raw = await llmChat(messages);
  if (config.debug) log(`RAW:\n${raw}`);
  let { text, control } = extractControl(raw);
  const cleanOpts = { keepAudioTags: !!voice };
  text = clean(text, persona.name, cleanOpts);
  // she over-uses one interjection if left alone; drop the repeat
  const tamedTic = tameTics(text, chat.history);
  if (tamedTic !== text) log(`repeated filler stripped: ${text.trim().slice(0, 40)}`);
  text = tamedTic;

  if (looksBroken(text)) {
    log(`guard tripped for ${chat.jid}; regenerating`);
    const retry = [
      ...messages,
      { role: "assistant", content: raw },
      {
        role: "user",
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
    text = tameTics(text, chat.history);
    if (looksBroken(text) || !text) {
      log(`guard still tripped; using deflection`);
      text = deflection(persona.name, persona.deflection);
      control = null;
    }
  }

  if (!text) text = deflection(persona.name, persona.deflection);

  // Inline control line from the roleplay model (if it used one).
  applyControl(chat, control, incoming);

  // Reliable affect tracking: a small JSON call updates mood + memory.
  try {
    const affect = await analyzeAffect(chat, incoming, text, persona);
    if (affect) applyControl(chat, affect, incoming);
    else {
      const nudge = heuristicNudge(incoming);
      if (Object.keys(nudge).length) bump(chat, nudge);
    }

    // she melts for a while, then pulls back (tsundere). Nothing lasts.
    if (config.softMode) {
      const d = affect?.mood || {};
      // the tracker can stay negative while she is furious, so also count the
      // other person actually being warm — that is what melts a real person
      const sweetSignal =
        /(sayang|cinta|kangen|love you|love u|miss you|miss u|makasih|thank you|thanks|maaf|sorry|sori|peluk|cium|manis banget)/i.test(
          incoming,
        );
      const strong =
        sweetSignal ||
        (Number(d.affection) || 0) >= 0.08 ||
        (Number(d.valence) || 0) >= 0.08;
      // note: a fresh apology (thawed) does NOT open the soft window on the same
      // turn — the prompt says "you are still cold, thaw slowly", so the machine
      // must not melt her at the same instant.
      const now = Date.now();
      // the soft window is a reward for someone she knows — strangers never get it
      if (chat.trusted === true && strong && now >= (chat.softUntil || 0) && Math.random() < config.softTriggerChance) {
        const span = Math.max(1, config.softMaxMin - config.softMinMin);
        const mins = config.softMinMin + Math.random() * span;
        chat.softUntil = now + mins * 60000;
        const deep = chat.mood.valence < -0.5;
        bump(chat, {
          valence: deep ? 0.22 : 0.14,
          affection: 0.18,
          playfulness: 0.12,
          patience: 0.18,
        });
        log(`soft window open (~${Math.round(mins)} min)`);
      }
    }
  } catch (err) {
    log(`affect tracker failed: ${err.message}`);
    const nudge = heuristicNudge(incoming);
    if (Object.keys(nudge).length) bump(chat, nudge);
  }

  sampleMood(chat);
  chat.history.push({ role: "user", content: incoming, ts: Date.now() });
  chat.history.push({ role: "assistant", content: stripAudioTags(text), ts: Date.now() });
  chat.stats.inbound = (chat.stats.inbound || 0) + 1;
  // long back-and-forth tires her out a little (she's not a machine)
  if (Date.now() - (chat.lastInteraction || 0) < 15 * 60000) {
    bump(chat, { energy: -0.02 });
  }
  chat.lastInteraction = Date.now();

  // they acknowledged something she told them to do -> no need to nag
  for (const ins of chat.instructions || []) {
    if (!ins.done && TOPIC_RE[ins.label]?.test(incoming)) {
      ins.done = true;
      ins.doneAt = Date.now();
    }
  }

  // she just told them to do something (eat / sleep / workout) -> maybe check later.
  // Only for people she actually knows, only sometimes, never twice in a row about
  // the same thing — otherwise she reads like an alarm clock instead of a person.
  if (config.instructionFollowup && chat.trusted === true) {
    const label = detectInstruction(stripAudioTags(text));
    const list = chat.instructions || (chat.instructions = []);
    const pending = list.filter((i) => !i.done);
    const nowTs = Date.now();
    const cooldown = config.checkupCooldownMin * 60000;
    const saidRecently = list.some((i) => i.label === label && nowTs - (i.createdAt || 0) < cooldown);
    const alreadyPending = pending.some((i) => i.label === label);
    const tooMany = pending.length >= config.maxPendingCheckups;
    if (label && !alreadyPending && !saidRecently && !tooMany && Math.random() < config.checkupChance) {
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
  reDrift(session);

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
    // she must talk TO them — reject diary entries that narrate them in the
    // third person ("mungkin dia nunggu aku ngecek. tapi aku nggak akan.")
    if (/\b(dia|he|she|him|her)\b/i.test(text) && !/\b(kamu|u|you|lu|km|kmu)\b/i.test(text)) {
      log(`proactive narrated them in third person, retrying`);
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
    bump(session, { affection: 0.02 });
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
  reDrift(session);
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
  reDrift(session);
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
