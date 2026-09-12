/**
 * schedule.mjs — when she may start a chat, and the extra context you add by hand.
 *
 * Two small things that both feed the prompt:
 *
 * 1. CHAT SCHEDULE (per character, in the persona frontmatter)
 *    "11,16,20"       -> a random minute inside that hour, different every day
 *    "12:30,20:15"    -> that exact minute
 *    The editor adds/removes slots freely, and the model can propose a schedule
 *    that fits the character (her waking hours, her job, her vibe).
 *
 * 2. EXTRA CONTEXT (per character, in <slug>.world.json)
 *    Free-form notes you want her to keep in mind ("she is moving house this
 *    month", "it is rainy season in Bali"). They are ADDITIVE: they can never
 *    replace the character card, the live mood, or any other rule.
 */
import { chat as llmChat } from "./llm.mjs";
import { log } from "./config.mjs";
import { languageDirective } from "./lang.mjs";
import { extractJsonObject } from "./guard.mjs";

/* ------------------------------- schedule ------------------------------- */

/** "11,16,20:30" -> [{hour:11,minute:null},{hour:16,minute:null},{hour:20,minute:30}] */
export function parseSchedule(spec) {
  const out = [];
  for (const rawPart of String(spec || "").split(",")) {
    const part = rawPart.trim();
    if (!part) continue;
    const m = part.match(/^(\d{1,2})(?::(\d{1,2}|\*))?$/);
    if (!m) continue;
    const hour = Number(m[1]);
    if (hour > 23) continue;
    let minute = null;
    if (m[2] !== undefined && m[2] !== "*") {
      const mi = Number(m[2]);
      if (mi > 59) continue;
      minute = mi;
    }
    out.push({ hour, minute, raw: minute === null ? String(hour) : `${hour}:${String(minute).padStart(2, "0")}` });
  }
  return out;
}

export function formatSchedule(slots) {
  const seen = new Set();
  const parts = [];
  for (const s of slots || []) {
    const hour = Number(s?.hour);
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) continue;
    let raw = String(hour);
    if (s.minute !== null && s.minute !== undefined && s.minute !== "") {
      const mi = Number(s.minute);
      if (!Number.isFinite(mi) || mi < 0 || mi > 59) continue;
      raw = `${hour}:${String(mi).padStart(2, "0")}`;
    }
    if (seen.has(raw)) continue;
    seen.add(raw);
    parts.push(raw);
  }
  // order by time so the list stays readable
  parts.sort((a, b) => {
    const [ah, am] = a.split(":").map(Number);
    const [bh, bm] = b.split(":").map(Number);
    return ah * 60 + (am || 0) - (bh * 60 + (bm || 0));
  });
  return parts.join(",");
}

/** How many slots she has, and whether the values make sense. */
export function scheduleStats(spec) {
  const slots = parseSchedule(spec);
  const exact = slots.filter((s) => s.minute !== null).length;
  return { count: slots.length, exact, random: slots.length - exact };
}

const SCHEDULE_SYSTEM = `You decide when a roleplay character tends to message first on WhatsApp.

Return ONLY JSON, with the shape {"hours":[<integers 0-23>],"why":"<one short line>"} — do NOT copy any example numbers, choose them yourself.

Rules:
- Hours are 24h integers, inside her waking hours (see the card), and they must fit her life:
  her job, her energy, her personality. A night owl messages late; someone with a 9-5 does not
  message at 3am.
- 3-7 hours. Spread them naturally — not every hour in a row, and a few gaps where she is busy
  or asleep.
- She sleeps during her quiet hours, so never place a slot inside them.
- Prefer hours where a real person would reach out: waking up, lunch, after work, late evening.
- "why" is one short line explaining the pattern.`;

/** Ask the model for a schedule that fits the character. */
export async function generateSchedule(persona, { count = 5, current = "", quiet = [2, 8] } = {}) {
  const user = [
    `CHARACTER CARD:\n${String(persona?.card || "").slice(0, 2400)}`,
    `LANGUAGE: ${languageDirective(persona?.language) || "match the card"} (the "why" line only)`,
    persona?.active_hours ? `HER WAKING HOURS: ${persona.active_hours}` : "",
    persona?.work_hours ? `HER WORK HOURS: ${persona.work_hours}` : "",
    `SHE SLEEPS: ${quiet[0]}:00 - ${quiet[1]}:00`,
    current ? `CURRENT SCHEDULE (change it if it does not fit): ${current}` : "",
    `WANTED SLOTS: ${count} (between 3 and 7, pick what fits her day)`,
  ]
    .filter(Boolean)
    .join("\n");

  const messages = [
    { role: "system", content: SCHEDULE_SYSTEM },
    { role: "user", content: user },
  ];
  let out;
  try {
    out = await llmChat(messages, { json: true, temperature: 0.8, maxTokens: 400 });
  } catch (err) {
    log(`schedule generation failed: ${err.message}`);
    return null;
  }

  const parsed = extractJsonObject(out);
  let hours = (Array.isArray(parsed?.hours) ? parsed.hours : [])
    .map((h) => Number(h))
    .filter((h) => Number.isFinite(h) && h >= 0 && h <= 23);
  let why = String(parsed?.why || "").slice(0, 120);

  // the model sometimes answers in prose despite json mode — ask once more, bluntly
  if (!hours.length) {
    log("schedule: reply was not JSON — asking again");
    try {
      const retry = await llmChat(
        [
          ...messages,
          { role: "assistant", content: String(out).slice(0, 600) },
          { role: "user", content: 'Return ONLY a JSON object with "hours" (an array of integers) and "why". No prose, no markdown.' },
        ],
        { json: true, temperature: 0, maxTokens: 200 },
      );
      const again = extractJsonObject(retry);
      hours = (Array.isArray(again?.hours) ? again.hours : [])
        .map((h) => Number(h))
        .filter((h) => Number.isFinite(h) && h >= 0 && h <= 23);
      if (again?.why) why = String(again.why).slice(0, 120);
    } catch (err) {
      log(`schedule retry failed: ${err.message}`);
    }
  }

  // last resort: spread slots across the hours she is actually awake
  if (!hours.length) {
    const windows = String(persona?.active_hours || "9-21").split(",");
    for (const w of windows) {
      const m = w.trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
      if (!m) continue;
      const a = Number(m[1]);
      let b = Number(m[2]);
      if (b <= a) b += 24;
      for (let h = a; h <= b; h += 2) hours.push(h % 24);
    }
    why = "spread across her waking hours";
    log("schedule: fell back to her active hours");
  }

  hours = [...new Set(hours)].filter((h) => !(quiet[0] <= quiet[1] ? h >= quiet[0] && h < quiet[1] : h >= quiet[0] || h < quiet[1]));  return { spec: formatSchedule(hours.map((hour) => ({ hour, minute: null }))), why: String(parsed?.why || "fits her waking hours and routine").slice(0, 120) };
}

/* ----------------------------- extra context ---------------------------- */

export const CONTEXT_MAX = 12;

/** Keep the useful ones, drop expired, newest last. */
export function cleanContext(list) {
  const now = Date.now();
  return (Array.isArray(list) ? list : [])
    .map((c) => ({
      text: String(c?.text || "").trim().slice(0, 300),
      at: Number(c?.at) || now,
      until: c?.until ? String(c.until).slice(0, 10) : "",
    }))
    .filter((c) => c.text)
    .filter((c) => !c.until || c.until >= new Date(now).toISOString().slice(0, 10))
    .slice(-CONTEXT_MAX);
}

export function addContext(world, text, until = "") {
  const item = { text: String(text || "").trim().slice(0, 300), at: Date.now(), until: String(until || "").slice(0, 10) };
  if (!item.text) return world.context || [];
  const list = cleanContext(world.context);
  const dup = list.some((c) => c.text.toLowerCase() === item.text.toLowerCase());
  return dup ? list : [...list, item].slice(-CONTEXT_MAX);
}

/**
 * Prompt block. The wording matters: this must never look like it can override
 * the card, the mood or the rules.
 */
export function contextBlock(world) {
  const list = cleanContext(world?.context);
  if (!list.length) return "";
  return [
    "## Catatan tambahan dari owner (konteks khusus)",
    ...list.map((c) => `- ${c.text}`),
    "Ini TAMBAHAN, bukan pengganti. Kartu karakter, mood, aturan, dan hubungan tetap yang utama.",
    "Pakai kalau nyambung. Jangan diumumin, jangan dijelasin, jangan dijadikan alasan buat keluar karakter.",
  ].join("\n");
}
