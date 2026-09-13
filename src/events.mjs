/**
 * events.mjs — things that actually happen to her, in real time.
 *
 * The point: a conversation is not the only input. If a stranger sends something
 * weird and gets blocked, that is a thing that HAPPENED TO HER — it should show up
 * in her mood, in the story of her day, in what she can talk about with anyone, and
 * (if it is durable) in her memory. Otherwise she shrugs it off like a machine.
 *
 * A life event:
 *   - is stored globally (it happened to her, not to one contact)
 *   - nudges the mood of every trusted chat (respecting a manual mood lock)
 *   - can drop a live moment into today's routine, so she might mention it
 *   - is fed to the prompt for a few hours, then fades
 *
 *   data/events.json  [{ at, kind, what, weight, source }]
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, config, log } from "./config.mjs";
import { applyDeltas, normalize, isMoodLocked, lockValue } from "./mood.mjs";

const FILE = path.join(DATA_DIR, "events.json");
const KEEP = 80;

/** How a kind of event feels, and how it lands in the routine. */
const KINDS = {
  spam: { mood: { valence: -0.08, patience: -0.1, arousal: 0.06 }, moment: "annoyed", share: true },
  blocked: { mood: { valence: -0.03, arousal: 0.05 }, moment: "annoyed", share: true },
  stranger: { mood: { arousal: 0.04, patience: -0.03 }, moment: "awkward", share: true },
  promoted: { mood: { valence: 0.04, affection: 0.02 }, moment: "sweet", share: false },
  ai_accused: { mood: { valence: -0.05, arousal: 0.08, patience: -0.06 }, moment: "awkward", share: true },
  health_scare: { mood: { valence: -0.07, arousal: 0.12, affection: 0.05 }, moment: "scared", share: true },
  milestone: { mood: { valence: 0.07, affection: 0.05 }, moment: "sweet", share: true },
  errand: { mood: { valence: 0.02 }, moment: "fun", share: false },
};

export function listEvents() {
  if (!fs.existsSync(FILE)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** Events from the last N hours — what is still "today" for her. */
export function recentEvents(hours = 6, now = Date.now()) {
  return listEvents().filter((e) => now - (e.at || 0) < hours * 3600 * 1000);
}

/**
 * Write it down, feel it, and let it colour her day.
 * `applyToChats` is injected by the caller so this module stays free of the store.
 */
export function recordEvent({ kind, what, source = "", applyToChats = null, saveChats = null, addMoment = null }) {
  const k = KINDS[kind] || { mood: {}, moment: "awkward", share: false };
  const event = { at: Date.now(), kind, what: String(what).slice(0, 240), source: String(source).slice(0, 80) };
  const all = [...listEvents(), event].slice(-KEEP);
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2));

  if (Object.keys(k.mood).length && applyToChats) {
    const touched = [];
    for (const chat of applyToChats()) {
      if (isMoodLocked(chat)) continue;
      chat.mood = applyDeltas(normalize(chat.mood), k.mood);
      touched.push(chat);
    }
    // the caller owns persistence: a mood change she never saves is a mood change
    // nobody feels
    if (saveChats && touched.length) saveChats(touched);
  }
  if (k.share && addMoment) {
    try {
      addMoment({ what: event.what, kind: k.moment });
    } catch (err) {
      log(`event moment failed: ${err.message}`);
    }
  }
  log(`event [${kind}] ${event.what.slice(0, 70)}`);
  return event;
}

export function clearEvents() {
  if (fs.existsSync(FILE)) fs.writeFileSync(FILE, "[]");
  return [];
}

/** Prompt block: what happened to her today, short and natural to mention. */
export function lifePromptBlock(chat, { hours = 8, max = 3, shareOnly = true } = {}) {
  if (!config.lifeEvents) return "";
  const list = recentEvents(hours).slice(-max);
  if (!list.length) return "";
  return [
    "## Yang BARU kejadian sama kamu",
    ...list.map((e) => `- ${e.what}`),
    "Ini kejadian nyata di hidupmu (bukan obrolan ini). Boleh disinggung kalau nyambung — satu aja, singkat.",
    "Kalau lagi kesel karena salah satunya, itu boleh kelihatan di nada kamu. Jangan nyeritain semuanya.",
  ].join("\n");
}
