/**
 * routine.mjs — one day in her life (GLOBAL, per character — not per contact).
 *
 * A person has one life: if she talks to two people, both of them get the same
 * Monday. So the day plan lives in data/routine/<persona>.json, and the mood it
 * produces is applied to every chat that character is talking in.
 *
 * Why a routine at all: without it she only had the chat history to talk about,
 * so she repeated herself. With a day of her own she always has something new,
 * the mood has a reason to move, and every day is different.
 *
 * Storage rules:
 *   data/routine/<slug>.json
 *     date/blocks/moments  today only, regenerated every day
 *     history              the last ROUTINE_KEEP_DAYS days, then deleted
 *     highlights           only the special moments, kept forever (capped)
 */
import fs from "node:fs";
import path from "node:path";
import { chat as llmChat } from "./llm.mjs";
import { ROOT, config, trackerProvider, log } from "./config.mjs";
import { languageDirective } from "./lang.mjs";

const DIR = path.join(ROOT, "data", "routine");

const KIND_EFFECT = {
  fun: { valence: 0.09, playfulness: 0.07, energy: 0.03 },
  sweet: { valence: 0.07, affection: 0.05, arousal: -0.03 },
  proud: { valence: 0.08, energy: 0.04, arousal: 0.03 },
  annoyed: { valence: -0.08, patience: -0.07, arousal: 0.05 },
  sad: { valence: -0.09, energy: -0.05, playfulness: -0.05 },
  scared: { valence: -0.05, arousal: 0.1, patience: -0.04 },
  tired: { energy: -0.09, playfulness: -0.04 },
  awkward: { valence: -0.03, arousal: 0.04, playfulness: -0.02 },
};

export const KINDS = Object.keys(KIND_EFFECT);

const SYSTEM = `You plan ONE day in the life of a roleplay character, so she has something real to talk about and a reason for her mood.

Return ONLY JSON, no prose:
{"theme":"one short line for the whole day",
 "blocks":[{"start":"HH:MM","end":"HH:MM","what":"short, concrete","place":"short"}],
 "moments":[{"at":"HH:MM","kind":"fun|annoyed|sad|scared|proud|tired|sweet|awkward","what":"short, concrete, specific","intensity":0.4,"share":true}]}

Rules:
- Cover her WHOLE waking day, in order, 6-10 blocks, each 45-180 minutes, no overlaps.
  Stay inside her waking hours (see the card). Do not plan while she sleeps.
- Blocks must fit HER life: her job, her city, her age, her habits, her personality. Ordinary days, no fantasy, no drama-movie events.
- Vary it: different places, activities and errands than the recent days you are shown. Never reuse yesterday's theme.
- moments: 2-5, at a specific time inside a block, each ONE concrete thing that happened. Not feelings in general ("merasa capek") but events ("klien revisi brief ke-4, aku nahan nangis di toilet kafe").
- intensity 0.2-1.0. share=true if she would naturally bring it up in chat, false if private.
- kind must be one of the listed values.
- LANGUAGE: "theme", "what" and "place" must follow the LANGUAGE line in the user message exactly. Keep every string SHORT, max ~12 words.
- Nothing sexual, nothing illegal, nothing about the people she chats with (this is HER day, they are not in it).`;

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function weekdayName(d = new Date()) {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()];
}
function toMin(hhmm) {
  const m = String(hhmm || "").match(/^(\d{1,2})[:.](\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}
function nowMin(d = new Date()) {
  return d.getHours() * 60 + d.getMinutes();
}
function clock(d = new Date()) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/* ------------------------------ storage ------------------------------- */

function fileFor(slug) {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
  return path.join(DIR, `${String(slug || "character").replace(/[^\w.-]/g, "_")}.json`);
}

export function loadRoutine(slug) {
  const f = fileFor(slug);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

export function saveRoutine(slug, routine) {
  const f = fileFor(slug);
  fs.writeFileSync(f, JSON.stringify(routine, null, 2));
  return routine;
}

/** Routine for whatever character this chat is talking to. */
export function routineForChat(chat) {
  return loadRoutine(chat?.persona || config.persona);
}

/* ------------------------------- shape -------------------------------- */

function sanitize(raw) {
  if (!raw || typeof raw !== "object") return null;
  const blocks = (Array.isArray(raw.blocks) ? raw.blocks : [])
    .map((b) => ({
      start: String(b?.start || "").trim(),
      end: String(b?.end || "").trim(),
      what: String(b?.what || "").trim().slice(0, 120),
      place: String(b?.place || "").trim().slice(0, 60),
    }))
    .filter((b) => toMin(b.start) !== null && toMin(b.end) !== null && b.what)
    .sort((a, b) => toMin(a.start) - toMin(b.start))
    .slice(0, 12);
  const moments = (Array.isArray(raw.moments) ? raw.moments : [])
    .map((m) => ({
      at: String(m?.at || "").trim(),
      kind: KIND_EFFECT[m?.kind] ? m.kind : "annoyed",
      what: String(m?.what || "").trim().slice(0, 160),
      intensity: Math.max(0.2, Math.min(1, Number(m?.intensity) || 0.5)),
      share: m?.share !== false,
      firedAt: 0,
    }))
    .filter((m) => toMin(m.at) !== null && m.what)
    .sort((a, b) => toMin(a.at) - toMin(b.at))
    .slice(0, 6);
  const theme = String(raw.theme || "").trim().slice(0, 160);
  if (!blocks.length || !theme) return null;
  return { theme, blocks, moments };
}

/* ------------------------------- generate ----------------------------- */

/**
 * Make sure today's plan exists. Cheap no-op when it already does.
 * Pass `force` to roll a new one (used by the dashboard button / rp routine --new).
 */
export async function ensureToday(persona, { force = false, mood = null } = {}) {
  if (!config.routine) return null;
  const slug = persona?.slug || config.persona;
  const key = todayKey();
  const current = loadRoutine(slug);
  if (!force && current && current.date === key) return current;

  const history = (current?.history || []).slice(-3);
  const highlights = (current?.highlights || []).slice(-6);
  const recent = [
    history.length
      ? `RECENT DAYS (do not repeat these):\n${history
          .map((d) => `${d.date} ${d.weekday || ""} — theme: ${d.theme}; moments: ${(d.moments || []).map((m) => m.what).join(" | ")}`)
          .join("\n")}`
      : "",
    highlights.length ? `HIGHLIGHTS SO FAR: ${highlights.map((h) => h.what).join(" | ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const user = [
    `CHARACTER CARD:\n${String(persona?.card || "").slice(0, 2600)}`,
    `LANGUAGE: ${languageDirective(persona?.language) || "match the character card"} (card: "${persona?.language || "-"}")`,
    `TODAY: ${weekdayName()} ${key}`,
    persona?.work_hours ? `HER WORK HOURS: ${persona.work_hours}` : "",
    persona?.active_hours ? `HER WAKING HOURS: ${persona.active_hours}` : "",
    mood ? `HER MOOD RIGHT NOW: ${JSON.stringify(mood)}` : "",
    recent,
  ]
    .filter(Boolean)
    .join("\n");

  let out;
  try {
    out = await llmChat(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
      { json: true, temperature: 1.0, maxTokens: 1600, provider: trackerProvider() },
    );
  } catch (err) {
    log(`routine generation failed: ${err.message}`);
    return current || null;
  }

  let parsed;
  try {
    const s = out.indexOf("{");
    const e = out.lastIndexOf("}");
    parsed = JSON.parse(out.slice(s, e + 1));
  } catch {
    log("routine generation returned junk");
    return current || null;
  }

  const clean = sanitize(parsed);
  if (!clean) {
    log("routine generation incomplete — keeping the old one");
    return current || null;
  }

  const history2 = current && current.date !== key ? [...(current.history || []), strip(current)] : current?.history || [];
  const routine = {
    slug,
    date: key,
    weekday: weekdayName(),
    createdAt: Date.now(),
    ...clean,
    history: history2,
    highlights: current?.highlights || [],
  };
  prune(routine);
  saveRoutine(slug, routine);
  log(`routine ${slug} ${key}: "${clean.theme}" (${clean.blocks.length} blok, ${clean.moments.length} momen)`);
  return routine;
}

function strip(r) {
  return { date: r.date, weekday: r.weekday, theme: r.theme, moments: (r.moments || []).map((m) => ({ at: m.at, kind: m.kind, what: m.what })) };
}

/* -------------------------------- read -------------------------------- */

export function currentBlock(routine, now = new Date()) {
  if (!routine || routine.date !== todayKey(now)) return null;
  const m = nowMin(now);
  for (const b of routine.blocks || []) {
    const a = toMin(b.start);
    const z = toMin(b.end);
    if (a === null || z === null) continue;
    if (m >= a && m < z) return b;
  }
  return null;
}

export function nextBlock(routine, now = new Date()) {
  if (!routine || routine.date !== todayKey(now)) return null;
  const m = nowMin(now);
  return (routine.blocks || []).find((b) => (toMin(b.start) ?? 0) > m) || null;
}

export function livedMoments(routine, { shareOnly = true, max = 3 } = {}) {
  if (!routine) return [];
  return (routine.moments || []).filter((m) => m.firedAt && (!shareOnly || m.share !== false)).slice(-max);
}

/**
 * Moments whose time has come. Marks them fired (once, globally) and records the
 * ones worth remembering as highlights. Returns the moments that just fired so
 * the caller can apply the mood to every chat.
 */
export function tickMoments(routine, now = new Date()) {
  if (!routine || routine.date !== todayKey(now)) return [];
  const m = nowMin(now);
  const fired = [];
  for (const moment of routine.moments || []) {
    if (moment.firedAt) continue;
    const at = toMin(moment.at);
    if (at === null || at > m) continue;
    moment.firedAt = Date.now();
    fired.push(moment);
    if (moment.share !== false && moment.intensity >= config.routineHighlightMin) {
      routine.highlights = [
        ...(routine.highlights || []),
        { date: routine.date, kind: moment.kind, what: moment.what, intensity: moment.intensity },
      ].slice(-config.routineHighlightMax);
    }
  }
  if (fired.length) {
    log(`moment: ${fired.map((f) => `${f.kind}:${f.what.slice(0, 40)}`).join(" · ")}`);
    prune(routine);
  }
  return fired;
}

/** Mood deltas for one moment (already scaled by intensity). */
export function momentDeltas(moment) {
  const effect = KIND_EFFECT[moment?.kind] || {};
  const deltas = {};
  for (const [k, v] of Object.entries(effect)) deltas[k] = v * (Number(moment?.intensity) || 0.5);
  return deltas;
}

/** Keep ROUTINE_KEEP_DAYS of ordinary days; highlights survive forever. */
export function prune(routine) {
  if (!routine || !config.routine) return routine;
  const cutoff = Date.now() - config.routineKeepDays * 24 * 3600 * 1000;
  const keep = (day) => {
    const t = Date.parse(`${day.date}T00:00:00`);
    return !Number.isFinite(t) || t >= cutoff;
  };
  routine.history = (routine.history || []).filter(keep).slice(-10);
  if (routine.highlights?.length > config.routineHighlightMax) {
    routine.highlights = routine.highlights.slice(-config.routineHighlightMax);
  }
  return routine;
}

/* ------------------------------- prompt ------------------------------- */

/** The block of prompt text that tells her what her own day looks like. */
export function routinePromptBlock(routine, now = new Date()) {
  if (!routine || routine.date !== todayKey(now)) return "";
  const block = currentBlock(routine, now);
  const next = nextBlock(routine, now);
  const lived = livedMoments(routine, { shareOnly: true, max: 3 });

  return [
    "## Hari kamu sendiri (INI HARI KAMU, bukan topik obrolan)",
    `Tema hari ini: ${routine.theme}`,
    block
      ? `Sekarang jam ${clock(now)} — kamu lagi: ${block.what}${block.place ? ` (${block.place})` : ""}.`
      : `Sekarang jam ${clock(now)}.`,
    next
      ? `Rencana berikutnya (BELUM kejadian — jangan cerita seolah sudah lewat; boleh disebut cuma kalau dia nanya rencana kamu): ${next.what}.`
      : "",
    lived.length ? `Yang sudah kejadian hari ini:\n${lived.map((m) => `- ${m.what}`).join("\n")}` : "",
    (routine.highlights || []).length
      ? `Yang masih kamu inget dari hari-hari sebelumnya: ${(routine.highlights || [])
          .slice(-4)
          .map((h) => h.what)
          .join(" | ")}`
      : "",
    "",
    "Cara pakai: anggap ini hidupmu sendiri. Yang SUDAH kejadian boleh disinggung sekali — satu hal aja, singkat, jangan daftar. Yang BELUM kejadian jangan diceritakan sebagai sudah terjadi.",
    "JANGAN bilang jamnya, jangan nyeritain seluruh jadwal, jangan kayak laporan. Sisanya cukup kamu tau.",
    "Kalau dia nanya kamu lagi ngapain, jawab sesuai yang di atas.",
    "Catatan ini cuma data internal — JANGAN tiru bahasanya. Tetap ngomong pakai bahasamu sendiri (lihat kartu karakter).",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Ideas for a message she starts herself — keeps her from repeating herself. */
export function routineSparks(routine, now = new Date()) {
  if (!routine) return [];
  const lived = livedMoments(routine, { shareOnly: true, max: 4 });
  const block = currentBlock(routine, now);
  const next = nextBlock(routine, now);
  const sparks = lived.map((m) => m.what);
  if (block) sparks.push(`lagi ${String(block.what).toLowerCase()}${block.place ? ` di ${String(block.place).toLowerCase()}` : ""}`);
  if (next) sparks.push(`mau ${String(next.what).toLowerCase()} setelah ini`);
  return sparks;
}
