import { chat as llmChat } from "./llm.mjs";
import { trackerProvider } from "./config.mjs";
import { label, snapshot, KEYS } from "./mood.mjs";

/**
 * Internal affect tracker. Runs a small, strict JSON call after each reply to
 * update mood + memory reliably (the main roleplay model tends to ignore the
 * inline control-line instruction).
 */

const SYSTEM = `You are the internal affect tracker for a roleplay character. You are shown the character's current mood, what the character remembers, the other person's message, and the character's reply. Update the character's emotional state and long-term memory.

Respond with ONLY a JSON object, no prose, no markdown:
{"mood":{"valence":0.0,"energy":0.0,"arousal":0.0,"affection":0.0,"patience":0.0,"playfulness":0.0},"remember":[],"forget":[],"plans":[],"jokes":[],"boundaries":[],"relationship":"","name":"","nick":"","followup":{"what":"","due":"","for":""}}

Rules:
- mood values are DELTAS applied to the current mood, each between -0.2 and 0.2. Omit a key if it did not change.
- Be sensitive: a sweet message warms affection/valence; being ignored, insulted or made jealous lowers patience/valence and can raise arousal; jokes raise playfulness; demands lower patience; long/dramatic messages raise arousal.
- name: the other person's actual name/nickname ONLY when it was just revealed or corrected, in the same language as the conversation. Otherwise "".
- nick: only if the character just settled on what to call them. Otherwise "".
- remember: concrete, durable facts about them — job, schedule, health, family, pets, preferences, fears, important dates, things they said about themselves. Up to 3. ALWAYS store a new concrete fact. Write in the conversation's language.
- plans: promises, appointments or plans with a time ("interview tanggal 15", "nonton sabtu"). Only new ones.
- jokes: running jokes, nicknames, callbacks that you two keep repeating. Only new ones.
- boundaries: things they dislike, topics to avoid, things that upset them. Only new ones.
- followup: fill this ONLY when a future update was agreed — the character promised to report back ("nanti aku kabarin kalau udah selesai", "I'll let you know") OR the other person asked to be told ("kabarin ya kalau udah beres", "tell me when it's done"). Set what = short description of what will be reported; due = ISO-8601 datetime if a time was agreed, otherwise empty string; for = "me" if the character promised, "them" if they asked her to report. Otherwise use an empty object {}.
- Never invent mood changes for a flat, neutral exchange: an all-zero mood object is valid.
- Output JSON only.`;

function safeParse(text) {
  let t = text.trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function analyzeAffect(session, incoming, reply, persona) {
  const mem = session.memory || {};
  const user = [
    `CHARACTER: ${persona.name} ${persona.emoji}`,
    `THEM (name): ${session.profile?.name || "unknown"} | nickname you use: ${session.profile?.nick || "none"}`,
    `CURRENT MOOD: ${snapshot(session.mood)}`,
    `KNOWN FACTS: ${mem.facts?.length ? mem.facts.join(" | ") : "none"}`,
    `KNOWN PLANS: ${mem.plans?.length ? mem.plans.join(" | ") : "none"}`,
    `KNOWN JOKES: ${mem.jokes?.length ? mem.jokes.join(" | ") : "none"}`,
    `KNOWN BOUNDARIES: ${mem.boundaries?.length ? mem.boundaries.join(" | ") : "none"}`,
    `RELATIONSHIP: ${mem.relationship || "unknown"}`,
    "",
    `THEM: ${incoming}`,
    `YOU (${persona.name}): ${reply}`,
  ].join("\n");

  const raw = await llmChat(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
    ],
    { json: true, temperature: 0.2, maxTokens: 900, provider: trackerProvider() },
  );

  const parsed = safeParse(raw);
  if (!parsed || typeof parsed !== "object") return null;

  // keep only known mood keys and clamp deltas
  if (parsed.mood && typeof parsed.mood === "object") {
    const mood = {};
    for (const k of KEYS) {
      const n = Number(parsed.mood[k]);
      if (Number.isFinite(n) && n !== 0) mood[k] = Math.max(-0.2, Math.min(0.2, n));
    }
    parsed.mood = mood;
  }
  return parsed;
}

/**
 * Ask the model what her mood should be right now, given the recent chat and
 * the character. Used by the dashboard's "Auto" mood button.
 */
export async function suggestMood(session, persona) {
  const mem = session.memory || {};
  const recent = (session.history || [])
    .slice(-12)
    .map((h) => `${h.role === "user" ? "them" : persona.name}: ${h.content}`)
    .join("\n");
  const system =
    "You set the current emotional state of a roleplay character. " +
    "Given the character, the recent conversation and the current numbers, return ONLY JSON: " +
    '{"mood":{"valence":0.0,"energy":0.6,"arousal":0.4,"affection":0.5,"patience":0.6,"playfulness":0.5},"reason":"max 12 words"}. ' +
    "valence is -1..1 (sad..happy); the rest are 0..1. " +
    "These are ABSOLUTE values, not deltas. Be true to the character and to what just happened " +
    "(a fight => low valence/patience; a sweet moment => higher affection; late night => low energy).";
  const user = `CHARACTER:\n${persona.card.slice(0, 3000)}\n\nCURRENT: ${snapshot(session.mood)}\nRELATIONSHIP: ${
    mem.relationship || "unknown"
  }\n\nRECENT CHAT:\n${recent || "(nothing yet)"}`;
  const raw = await llmChat(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { json: true, temperature: 0.3, maxTokens: 1200, provider: trackerProvider() },
  );
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  if (s === -1 || e === -1) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(s, e + 1));
  } catch {
    return null;
  }
  const mood = {};
  for (const k of KEYS) {
    const n = Number(parsed.mood?.[k]);
    if (Number.isFinite(n)) mood[k] = k === "valence" ? Math.max(-1, Math.min(1, n)) : Math.max(0, Math.min(1, n));
  }
  if (!Object.keys(mood).length) return null;
  return { mood, reason: String(parsed.reason || "").slice(0, 120) };
}
