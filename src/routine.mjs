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
import { ROOT, DATA_DIR, config, trackerProvider, log } from "./config.mjs";
import { lifestyleBlock, hasClass, bandOf, BANDS } from "./lifestyle.mjs";
import { loadWorld } from "./world.mjs";
import { languageDirective } from "./lang.mjs";

// under DATA_DIR so a test run with a throwaway data dir cannot touch real routines
const DIR = path.join(DATA_DIR, "routine");

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
 "blocks":[{"start":"HH:MM","end":"HH:MM","what":"short, concrete","place":"short","with":"name or empty"}],
 "moments":[{"at":"HH:MM","kind":"fun|annoyed|sad|scared|proud|tired|sweet|awkward","what":"short, concrete, specific","with":"name or empty","intensity":0.4,"share":true}]}

Rules:
- Cover her WHOLE waking day, in order, 6-10 blocks, each 45-180 minutes, no overlaps.
  Stay inside her waking hours (see the card). Do not plan while she sleeps.
- Blocks must fit HER life: her job, her city, her age, her habits, her personality, AND her class.
  The CLASS AND LIFESTYLE block is not decoration: where she eats, how she travels, where she lives and
  what she spends money on must match it. An upper-middle-class day does not include a warung, an angkot,
  counting coins or a nasi bungkus, unless the card itself says so. Getting this wrong is worse than
  being boring.
- Ordinary days, no fantasy, no drama-movie events.
- Vary it: different places, activities and errands than the recent days you are shown. Never reuse yesterday's theme.
- moments: 2-5, at a specific time inside a block, each ONE concrete thing that happened. Not feelings in general ("merasa capek") but events ("klien revisi brief ke-4, aku nahan nangis di toilet kafe").
- intensity 0.2-1.0. share=true if she would naturally bring it up in chat, false if private.
- kind must be one of the listed values.
- LANGUAGE: "theme", "what" and "place" must follow the LANGUAGE line in the user message exactly. Keep every string SHORT, max ~12 words.
- COMPANIONS: at least ONE block and ONE moment a day must involve someone from the PEOPLE IN HER LIFE
  list, and they must be NAMED — "jogging dengan Jessy", never "jogging with a friend". She is not a
  hermit: people show up on most days. Do not invent names, and do not put the same person in every block
  (vary who, and let some blocks be alone).
- NO GAPS: the blocks must run back to back from waking to sleeping, with no unexplained hole.
- Nothing sexual, nothing illegal, nothing about the people she chats with (this is HER day, they are not in it).`;

/**
 * The class check. After a plan comes back, one cheap pass asks whether anything in it contradicts
 * her lifestyle: "nasi campur di warung" for a character with a car and a pilates subscription is the
 * kind of detail that makes the whole character read as invented. If it finds something, the plan is
 * made again with the findings attached as things to avoid.
 */
async function classProblems(plan, persona) {
  if (!hasClass(persona)) return [];
  const text = [
    `theme: ${plan.theme}`,
    ...(plan.blocks || []).map((b) => `${b.start}-${b.end} ${b.what}${b.place ? ` (${b.place})` : ""}`),
    ...(plan.moments || []).map((m) => `${m.at} [${m.kind}] ${m.what}`),
  ].join("\n");
  const ask = `CHARACTER CLASS AND LIFESTYLE:
${lifestyleBlock(persona)}

HER PLAN FOR THE DAY:
${text}

List anything in this plan that does NOT fit her class and lifestyle. Be strict and concrete: a place she would not go, transport she would not use, food that costs the wrong amount of money, a purchase that contradicts her income. If everything fits, say so.
Answer with JSON only: {"fits":true|false,"problems":["..."]}`;
  try {
    const out = await llmChat(
      [
        { role: "system", content: "You check one thing: does this day fit this character's social class and lifestyle. JSON only." },
        { role: "user", content: ask },
      ],
      { json: true, temperature: 0, maxTokens: 400, provider: trackerProvider() },
    );
    const s2 = out.indexOf("{");
    const e2 = out.lastIndexOf("}");
    const j = JSON.parse(out.slice(s2, e2 + 1));
    if (j.fits) return [];
    return (j.problems || []).map((p) => String(p).slice(0, 120)).slice(0, 6);
  } catch (err) {
    log(`class check skipped: ${err.message}`);
    return [];
  }
}

/** Is it already partway through the day? (used to ask for a partial plan) */
function isTodayMid() {
  const h = new Date().getHours();
  return h >= 11;
}

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

/**
 * Two blocks cannot run at the same time. The model occasionally produces an
 * overlap (22:30-23:30 then 23:00-00:30), so the earlier block is trimmed back
 * and dropped if nothing is left of it.
 */
function dropOverlaps(list) {
  const out = [];
  for (const b of list) {
    const start = toMin(b.start);
    const end = toMin(b.end);
    if (start === null || end === null) continue;
    const prev = out[out.length - 1];
    if (prev) {
      const prevEnd = toMin(prev.end);
      if (prevEnd !== null && start < prevEnd) {
        if (start <= toMin(prev.start)) continue; // fully inside the previous one
        prev.end = b.start; // trim the earlier block
      }
    }
    out.push(b);
  }
  return out;
}

function sanitize(raw) {
  if (!raw || typeof raw !== "object") return null;
  const blocks = dropOverlaps((Array.isArray(raw.blocks) ? raw.blocks : [])
    .map((b) => ({
      start: String(b?.start || "").trim(),
      end: String(b?.end || "").trim(),
      what: String(b?.what || "").trim().slice(0, 120),
      place: String(b?.place || "").trim().slice(0, 60),
      with: String(b?.with || "").trim().slice(0, 40),
    }))
    .filter((b) => toMin(b.start) !== null && toMin(b.end) !== null && b.what)
    .sort((a, b) => toMin(a.start) - toMin(b.start))
    .slice(0, 12));
  const moments = (Array.isArray(raw.moments) ? raw.moments : [])
    .map((m) => ({
      at: String(m?.at || "").trim(),
      kind: KIND_EFFECT[m?.kind] ? m.kind : "annoyed",
      what: String(m?.what || "").trim().slice(0, 160),
      with: String(m?.with || "").trim().slice(0, 40),
      intensity: Math.max(0.2, Math.min(1, Number(m?.intensity) || 0.5)),
      share: m?.share !== false,
      firedAt: 0,
    }))
    .filter((m) => toMin(m.at) !== null && m.what)
    .sort((a, b) => toMin(a.at) - toMin(b.at))
    .slice(0, 6);
  const theme = String(raw.theme || "").trim().slice(0, 160);
  if (!blocks.length || !theme) return null;
  // A hole in the day is always a mistake: either the model skipped time or a block was dropped.
  // Extending the previous block is honest — she is still doing something.
  for (let i = 1; i < blocks.length; i++) {
    const prevEnd = toMin(blocks[i - 1].end);
    const nextStart = toMin(blocks[i].start);
    if (prevEnd === null || nextStart === null || nextStart <= prevEnd) continue;
    if (nextStart - prevEnd <= 180) blocks[i - 1].end = blocks[i].start;
  }
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

  const nowClock = `${String(new Date().getHours()).padStart(2, "0")}:${String(new Date().getMinutes()).padStart(2, "0")}`;
  const partial = isTodayMid() ? `- It is already ${nowClock} for her. Plan ONLY the rest of the day, from ${nowClock} until she sleeps. Do not plan anything before that.` : "";
  const user = [
    `CHARACTER CARD:\n${String(persona?.card || "").slice(0, 2600)}`,
    lifestyleBlock(persona),
    (() => {
      const w = loadWorld(persona?.slug || config.persona);
      const cast = (w?.cast || []).filter((c) => c.relation && !/cat|kucing|pet/i.test(c.relation));
      if (!cast.length) return "";
      return `PEOPLE IN HER LIFE (use these names when someone is with her — never say "a friend"):\n${cast
        .map((c) => `- ${c.name} — ${c.relation}${c.vibe ? `, ${c.vibe}` : ""}`)
        .join("\n")}`;
    })(),
    `LANGUAGE: ${languageDirective(persona?.language) || "match the character card"} (card: "${persona?.language || "-"}")`,
    `TODAY: ${weekdayName()} ${key}`,
    persona?.work_hours ? `HER WORK HOURS: ${persona.work_hours}` : "",
    persona?.active_hours ? `HER WAKING HOURS: ${persona.active_hours}` : "",
    partial,
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

  // Class check: if the day does not fit her lifestyle, it is made once more with the findings named.
  const wrong = await classProblems(clean, persona);
  if (wrong.length) {
    log(`routine fits her class badly (${wrong.length}): ${wrong.join(" | ").slice(0, 160)} — planning again`);
    try {
      const strict = await llmChat(
        [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: `${user}\n\nDO NOT REPEAT THESE MISTAKES FROM THE LAST ATTEMPT:\n- ${wrong.join("\n- ")}`,
          },
        ],
        { json: true, temperature: 0.9, maxTokens: 1600, provider: trackerProvider() },
      );
      const s3 = strict.indexOf("{");
      const e3 = strict.lastIndexOf("}");
      const again = sanitize(JSON.parse(strict.slice(s3, e3 + 1)));
      if (again && !(await classProblems(again, persona)).length) {
        parsed = again;
        log("routine: second attempt fits her class");
      } else {
        log("routine: second attempt still imperfect — keeping the first, it is her day either way");
      }
    } catch (err) {
      log(`routine second attempt failed: ${err.message}`);
    }
  }

  // Regenerating mid-day must NOT wipe what already happened: keep the blocks that
  // are already over and the moments that already fired, and only replace the rest.
  const isToday = current && current.date === key;
  const nowM = nowMin();
  const keepBlocks = isToday
    ? (current.blocks || []).filter((b) => {
        const end = toMin(b.end);
        return end !== null && end <= nowM;
      })
    : [];
  const keepMoments = isToday ? (current.moments || []).filter((m) => m.firedAt) : [];

  const freshBlocks = clean.blocks.filter((b) => {
    const end = toMin(b.end);
    return end === null || end > nowM;
  });
  const freshMoments = clean.moments.filter((m) => {
    const at = toMin(m.at);
    return at === null || at >= nowM;
  });

  const mergedBlocks = [...keepBlocks, ...freshBlocks]
    .sort((a, b) => (toMin(a.start) ?? 0) - (toMin(b.start) ?? 0))
    .slice(0, 14);
  // close any hole the merge created: the kept blocks end where the day was when she regenerated,
  // and the fresh ones start at that moment, so a small hole is normal here and only looks like a bug
  for (let i = 1; i < mergedBlocks.length; i++) {
    const prevEnd = toMin(mergedBlocks[i - 1].end);
    const nextStart = toMin(mergedBlocks[i].start);
    if (prevEnd === null || nextStart === null || nextStart <= prevEnd) continue;
    if (nextStart - prevEnd <= 180) mergedBlocks[i - 1].end = mergedBlocks[i].start;
  }
  const mergedMoments = [...keepMoments, ...freshMoments]
    .sort((a, b) => (toMin(a.at) ?? 0) - (toMin(b.at) ?? 0))
    .slice(-8);

  if (isToday && keepBlocks.length + keepMoments.length) {
    log(
      `routine ${slug}: kept ${keepBlocks.length} finished blocks and ${keepMoments.length} lived moments, regenerated the rest of the day`,
    );
  }

  const history2 = current && current.date !== key ? [...(current.history || []), strip(current)] : current?.history || [];
  const routine = {
    slug,
    date: key,
    weekday: weekdayName(),
    createdAt: isToday && current?.createdAt ? current.createdAt : Date.now(),
    theme: isToday && clean.theme ? clean.theme : clean.theme,
    blocks: mergedBlocks.length ? mergedBlocks : clean.blocks,
    moments: mergedMoments.length ? mergedMoments : clean.moments,
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
