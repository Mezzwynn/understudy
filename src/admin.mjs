/**
 * admin.mjs — the OOC (out of character) config assistant.
 *
 * You talk to it in the dashboard, it helps you set things up: tune behaviour,
 * rewrite the personality card, inject a day plan, change the schedule, switch
 * characters, adjust per-contact settings.
 *
 * SAFETY MODEL (this is the important part)
 * Every change goes through a strict allowlist. The assistant can only ASK for
 * an action; the server validates it and refuses anything outside the list:
 *
 *   allowed  settings knobs (the ones in the dashboard), persona frontmatter,
 *            the persona card text, the daily routine, schedule fields, the
 *            active character, per-contact nickname/persona
 *   refused  anything else: files, code, arbitrary shell, API keys, the repo,
 *            ALLOW/TRUSTED lists, deleting contacts or wiping memory
 *
 * A model can never be trusted with "please edit this file", so the refusal is
 * enforced here in code, not in the prompt.
 */
import fs from "node:fs";
import path from "node:path";
import { chat as llmChat } from "./llm.mjs";
import { extractJsonObject } from "./guard.mjs";
import { PERSONA_DIR, config, log } from "./config.mjs";
import { loadPersona, parsePersonaFrontmatter } from "./prompt.mjs";
import { KNOBS, applyValues, currentValues } from "../scripts/_settings.mjs";
import { ensureToday, tickMoments, saveRoutine, prune, loadRoutine, KINDS } from "./routine.mjs";
import { RELATIONS, loadWorld, saveWorld } from "./world.mjs";
import { generateSchedule, formatSchedule, parseSchedule, addContext, cleanContext } from "./schedule.mjs";
import { loadTraits, saveTraits, generateTraits } from "./traits.mjs";

const KNOB_KEYS = new Set(KNOBS.map((k) => k.key));

/** Frontmatter fields the assistant may touch. Note: no API keys, no paths. */
const PERSONA_FIELDS = new Set([
  "name",
  "emoji",
  "vibe",
  "language",
  "deflection",
  "voice",
  "voice_eleven",
  "voice_tags",
  "voice_style",
  "active_hours",
  "work_hours",
  "chat_schedule",
  "appearance",
]);

/** Fields that exist but are off limits (they are wiring, not personality). */
const PERSONA_BLOCKED = new Set(["persona", "slug", "id"]);

export const ACTION_TYPES = [
  "set_setting",
  "set_persona_field",
  "edit_persona_card",
  "new_routine",
  "inject_routine",
  "set_contact",
  "set_relation",
  "set_world",
  "set_traits",
  "gen_traits",
  "set_schedule",
  "gen_schedule",
  "add_context",
  "remove_context",
  "switch_persona",
];

const SYSTEM = `You are the OUT-OF-CHARACTER setup assistant inside the dashboard of a WhatsApp roleplay bot. You are NOT the character: you speak to the owner, plainly and professionally, about configuration. Never roleplay, never flirt, never answer as the character.

LANGUAGE: reply in English. Formal, neutral and concise. No slang, no emoji, no filler.

You help with: behaviour settings, the personality card, the daily routine, schedules, switching character, per-contact options.

Reply with ONLY this JSON, no prose:
{"say":"short answer to the owner, formal English, max 4 sentences",
 "actions":[{"type":"...","...":"..."}]}

Actions you may use (nothing else exists):
- {"type":"set_setting","key":"SKIP_CHANCE","value":0.15}
   key must be one of the listed knobs. Numbers only (0..1 for chances, ms for *_MS, minutes for *_MIN).
- {"type":"set_persona_field","slug":"fiona","field":"active_hours","value":"10-14,17-20,22-2"}
   fields: name, emoji, vibe, language, deflection, voice, voice_eleven, voice_tags, voice_style, active_hours, work_hours, chat_schedule, appearance
- {"type":"edit_persona_card","slug":"fiona","find":"exact existing text","replace":"new text"}
   patches the personality text. "find" must be an exact substring of the card. To add something new use "append" instead.
- {"type":"edit_persona_card","slug":"fiona","append":"## New section\\n- content"}
- {"type":"new_routine","slug":"fiona"} — roll a fresh day plan
- {"type":"inject_routine","slug":"fiona","theme":"...","blocks":[{"start":"09:00","end":"11:00","what":"...","place":"..."}],"moments":[{"at":"10:30","kind":"annoyed","what":"...","intensity":0.6,"share":true}]}
   kind ∈ ${KINDS.join("|")}. Use this when the owner wants to define her day themselves.
- {"type":"set_contact","jid":"...","field":"nick","value":"..."} — field: nick or persona
- {"type":"set_relation","jid":"...","relation":"friend","note":"optional"} — who this person is to her.
   (the field is "relation", NOT "type" — "type" is the action name)
   types: partner, spouse, ex, friend, bestfriend, sibling, parent, child, relative, coworker, boss,
   subordinate, client, mentor, student, neighbor, rival, stranger. This changes her tone (polite,
   loose, respectful, careful) for that contact.
- {"type":"set_world","slug":"fiona","backstory":"...","cast":[{"name":"...","relation":"...","vibe":"...","notes":"..."}],"removeCast":["name"]}
   her history and the people around her. "cast" entries are MERGED by name (existing people are
   updated, new ones added) — it never wipes the rest. Omit "cast" to keep them all. Use "removeCast"
   to delete someone. Omit "backstory" to keep the current one.
- {"type":"set_schedule","slug":"fiona","slots":"11,16,20:30"}
   when she is allowed to message first. "11" = a random minute in that hour (differs each day),
   "20:30" = that exact minute. Set it freely — add or remove as many as you like.
- {"type":"gen_schedule","slug":"fiona","count":5}
   let the model propose a schedule that fits her waking hours, her job and her personality.
- {"type":"add_context","slug":"fiona","text":"she is moving house this month","until":"2026-10-01"}
   an extra note she should keep in mind. ADDITIVE only: it can never replace the card, the mood
   or the rules. "until" is optional (YYYY-MM-DD).
- {"type":"remove_context","slug":"fiona","text":"..."} — drop that note again.
- {"type":"set_traits","slug":"fiona","humor":{"style":"dry, teasing","chance":0.3,"dark":false,"avoid":["his family"],"examples":["sure. believe whatever."]},"interest":{"level":0.6,"topics":["cats","coffee"],"bored":["gossip"],"curious":true}}
   her sense of humour and what interests her. Send only the parts you want to change.
- {"type":"gen_traits","slug":"fiona"} — the model works both out from the card and backstory
- {"type":"switch_persona","slug":"fiona"} — make another character the active one

Requests you must refuse (state the reason plainly in "say", send no action):
- editing code, files, or any .env key outside the knob list
- API keys, ALLOW/TRUSTED lists, provider settings
- deleting anything, wiping memory, resetting contacts
- any change to the bot's internals rather than its behaviour

Be concrete: if the request is vague, choose sensible values and state what you changed. If something is missing, say what is needed instead of guessing. Keep "say" short and factual.`;

function cardPath(slug) {
  return path.join(PERSONA_DIR, `${String(slug).replace(/[^\w.-]/g, "")}.md`);
}

function readCard(slug) {
  const f = cardPath(slug);
  if (!fs.existsSync(f)) return null;
  const raw = fs.readFileSync(f, "utf8");
  return { raw, meta: parsePersonaFrontmatter(raw), body: raw.replace(/^---[\s\S]*?\n---\s*\n?/, "") };
}

function writeCard(slug, { frontmatter, body }) {
  const f = cardPath(slug);
  // Tulis SEMUA field yang sudah ada (bukan cuma yang ada di allowlist), supaya
  // field lain di kartu nggak ikut hilang. Allowlist tetap yang menentukan field
  // mana yang BOLEH DIUBAH — itu dicek sebelum fungsi ini dipanggil.
  const lines = Object.entries(frontmatter)
    .filter(([k, v]) => /^[a-z_]+$/i.test(k) && v !== undefined)
    .map(([k, v]) => `${k}: ${String(v).replace(/\n/g, " ").trim()}`);
  fs.writeFileSync(f, `---\n${lines.join("\n")}\n---\n\n${String(body).trim()}\n`);
}

/* ------------------------------ validation ----------------------------- */

function num(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (min !== undefined && n < min) return null;
  if (max !== undefined && n > max) return null;
  return n;
}

function checkTime(t) {
  return /^\d{1,2}:\d{2}$/.test(String(t)) && (() => {
    const [h, m] = String(t).split(":").map(Number);
    return h <= 23 && m <= 59;
  })();
}


/**
 * Validate one requested action. Returns { apply: fn, describe: string, undo }
 * or { refuse: reason } — never a raw file operation.
 */
function validate(action, { personas = [] } = {}) {
  const t = action?.type;
  if (!t) return { refuse: "action without a type" };
  if (!ACTION_TYPES.includes(t)) return { refuse: `action "${t}" is unknown or not permitted` };

  if (t === "set_setting") {
    const key = String(action.key || "").toUpperCase();
    if (!KNOB_KEYS.has(key)) return { refuse: `setting "${action.key}" is outside the editable list` };
    const knob = KNOBS.find((k) => k.key === key);
    let value = action.value;
    if (knob.kind === "float") {
      value = num(value, 0, 1);
      if (value === null) return { refuse: `${key} must be a number between 0 and 1` };
    } else if (knob.kind === "int") {
      value = num(value, 0);
      if (value === null) return { refuse: `${key} must be a number` };
    } else {
      value = String(value ?? "").slice(0, 60);
    }
    const before = currentValues()[key];
    return {
      describe: `${key}: ${before} → ${value}`,
      apply: () => {
        applyValues({ [key]: value });
        return { key, before, value };
      },
    };
  }

  if (t === "set_persona_field") {
    const slug = String(action.slug || config.persona).replace(/[^\w.-]/g, "");
    const field = String(action.field || "").trim();
    if (PERSONA_BLOCKED.has(field)) return { refuse: `field "${field}" may not be changed` };
    if (!PERSONA_FIELDS.has(field)) return { refuse: `unknown field "${field}" (not part of the character)` };
    const card = readCard(slug);
    if (!card) return { refuse: `character "${slug}" does not exist` };
    const value = String(action.value ?? "").slice(0, 400);
    if (["active_hours", "work_hours", "chat_schedule"].includes(field) && !/^[\d\-:, ]*$/.test(value)) {
      return { refuse: `${field} may only contain digits, commas, colons and hyphens` };
    }
    return {
      describe: `${slug}.${field}: "${card.meta[field] || ""}" → "${value}"`,
      apply: () => {
        writeCard(slug, { frontmatter: { ...card.meta, [field]: value }, body: card.body });
        return { slug, field, value };
      },
    };
  }

  if (t === "edit_persona_card") {
    const slug = String(action.slug || config.persona).replace(/[^\w.-]/g, "");
    const card = readCard(slug);
    if (!card) return { refuse: `character "${slug}" does not exist` };
    if (action.append) {
      const text = String(action.append).slice(0, 4000);
      const before = currentValues;
      return {
        describe: `append a section to the card of ${slug} (${text.length} karakter)`,
        apply: () => {
          writeCard(slug, { frontmatter: card.meta, body: `${card.body.trim()}\n\n${text.trim()}` });
          return { slug, appended: text.slice(0, 80) };
        },
      };
    }
    const find = String(action.find || "");
    const replace = String(action.replace ?? "");
    if (find.length < 8) return { refuse: "search text too short — it must match the card exactly" };
    if (!card.body.includes(find)) return { refuse: `that text does not exist in the card for ${slug}` };
    if (card.body.split(find).length > 2) return { refuse: "that text appears more than once — make it more specific" };
    return {
      describe: `replace in card: "${find.slice(0, 50)}…" → "${replace.slice(0, 50)}…"`,
      apply: () => {
        writeCard(slug, { frontmatter: card.meta, body: card.body.replace(find, replace) });
        return { slug, replaced: find.slice(0, 60) };
      },
    };
  }

  if (t === "new_routine") {
    const slug = String(action.slug || config.persona).replace(/[^\w.-]/g, "");
    const persona = loadPersona(slug);
    return {
      describe: `generate a new routine for ${slug}`,
      reload: true,
      apply: async () => {
        const r = await ensureToday(persona, { force: true });
        if (!r) return null;
        tickMoments(r);
        saveRoutine(slug, prune(r));
        return { slug, theme: r.theme };
      },
    };
  }

  if (t === "inject_routine") {
    const slug = String(action.slug || config.persona).replace(/[^\w.-]/g, "");
    const blocks = (Array.isArray(action.blocks) ? action.blocks : [])
      .map((b) => ({
        start: String(b?.start || ""),
        end: String(b?.end || ""),
        what: String(b?.what || "").slice(0, 120),
        place: String(b?.place || "").slice(0, 60),
      }))
      .filter((b) => checkTime(b.start) && checkTime(b.end) && b.what);
    const moments = (Array.isArray(action.moments) ? action.moments : [])
      .map((m) => ({
        at: String(m?.at || ""),
        kind: KINDS.includes(m?.kind) ? m.kind : "annoyed",
        what: String(m?.what || "").slice(0, 160),
        intensity: num(m?.intensity, 0.2, 1) ?? 0.5,
        share: m?.share !== false,
        firedAt: 0,
      }))
      .filter((m) => checkTime(m.at) && m.what);
    const theme = String(action.theme || "").slice(0, 160);
    if (!blocks.length) return { refuse: "an injected routine needs at least one time block" };
    if (!theme) return { refuse: "a routine needs a theme" };
    return {
      describe: `inject routine ${slug}: "${theme}" (${blocks.length} blok, ${moments.length} momen)`,
      reload: true,
      apply: () => {
        const old = loadRoutine(slug);
        const today = new Date();
        const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
        const routine = {
          slug,
          date: key,
          weekday: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][today.getDay()],
          createdAt: Date.now(),
          theme,
          blocks,
          moments,
          history: old && old.date !== key ? [...(old.history || []), old] : old?.history || [],
          highlights: old?.highlights || [],
        };
        saveRoutine(slug, prune(routine));
        return { slug, theme, blocks: blocks.length, moments: moments.length, injected: true };
      },
    };
  }

  if (t === "set_contact") {
    const field = String(action.field || "");
    if (!["nick", "persona"].includes(field)) return { refuse: `contact field "${field}" is not allowed` };
    const jid = String(action.jid || "");
    if (!/@/.test(jid)) return { refuse: "invalid contact jid" };
    const value = String(action.value ?? "").slice(0, 60);
    if (field === "persona" && value && !personas.includes(value)) return { refuse: `character "${value}" does not exist` };
    return {
      describe: `contact ${jid}: ${field} → "${value}"`,
      reload: true,
      apply: async () => {
        const { loadChat, saveChat } = await import("./store.mjs");
        const chat = loadChat(jid);
        if (field === "nick") chat.profile.nick = value;
        else chat.persona = value;
        saveChat(chat);
        return { jid, field, value };
      },
    };
  }

  if (t === "set_relation") {
    const jid = String(action.jid || "");
    if (!/@/.test(jid)) return { refuse: "invalid contact jid" };
    const type = String(action.relation ?? action.relationType ?? "");
    if (type && !RELATIONS[type]) return { refuse: `unknown relation "${type}"` };
    const note = String(action.note || "").slice(0, 160);
    return {
      describe: `contact ${jid}: relation → ${type || "(cleared)"}${note ? ` (${note})` : ""}`,
      reload: true,
      apply: async () => {
        const { loadChat, saveChat } = await import("./store.mjs");
        const c = loadChat(jid);
        c.relation = { type, note };
        saveChat(c);
        return { jid, type, note };
      },
    };
  }

  if (t === "set_world") {
    const slug = String(action.slug || config.persona).replace(/[^\w.-]/g, "");
    const card = readCard(slug);
    if (!card) return { refuse: `character "${slug}" does not exist` };
    const current = loadWorld(slug);
    const backstory = action.backstory !== undefined ? String(action.backstory) : current.backstory;
    const cleanEntry = (c) => ({
      name: String(c?.name || "").trim(),
      relation: String(c?.relation || "").trim(),
      vibe: String(c?.vibe || "").trim(),
      notes: String(c?.notes || "").trim(),
      canon: c?.canon === true,
    });
    // merge by name: never wipe the people already there just because the model
    // only mentioned one new person
    let cast = [...(current.cast || [])];
    if (Array.isArray(action.cast)) {
      for (const raw of action.cast.map(cleanEntry).filter((c) => c.name)) {
        const i = cast.findIndex((c) => c.name.toLowerCase() === raw.name.toLowerCase());
        if (i >= 0) cast[i] = { ...cast[i], ...raw };
        else cast.push(raw);
      }
    }
    if (Array.isArray(action.removeCast)) {
      const drop = action.removeCast.map((n) => String(n || "").trim().toLowerCase()).filter(Boolean);
      cast = cast.filter((c) => !drop.includes(c.name.toLowerCase()));
    }
    if (!backstory && !cast.length) return { refuse: "nothing to save" };
    return {
      describe: `world ${slug}: backstory ${String(backstory).length} chars, cast ${cast.length}`,
      reload: true,
      apply: () => ({ slug, ...saveWorld(slug, { backstory, cast, source: "agent" }) }),
    };
  }

  if (t === "set_schedule") {
    const slug = String(action.slug || config.persona).replace(/[^\w.-]/g, "");
    const card = readCard(slug);
    if (!card) return { refuse: `character "${slug}" does not exist` };
    const spec = typeof action.slots === "string" ? action.slots : formatSchedule(action.slots);
    const parsed = parseSchedule(spec);
    if (!parsed.length) return { refuse: "that schedule has no valid hours" };
    return {
      describe: `${slug}.chat_schedule: "${card.meta.chat_schedule || ""}" → "${spec}" (${parsed.length} slots)`,
      reload: true,
      apply: () => {
        writeCard(slug, { frontmatter: { ...card.meta, chat_schedule: spec }, body: card.body });
        return { slug, slots: spec };
      },
    };
  }

  if (t === "gen_schedule") {
    const slug = String(action.slug || config.persona).replace(/[^\w.-]/g, "");
    const card = readCard(slug);
    if (!card) return { refuse: `character "${slug}" does not exist` };
    return {
      describe: `generate a schedule for ${slug}`,
      reload: true,
      apply: async () => {
        const p = loadPersona(slug);
        const r = await generateSchedule(p, { count: Number(action.count) || 5, current: card.meta.chat_schedule || "" });
        if (!r) return null;
        writeCard(slug, { frontmatter: { ...card.meta, chat_schedule: r.spec }, body: card.body });
        return { slug, slots: r.spec, why: r.why };
      },
    };
  }

  if (t === "add_context" || t === "remove_context") {
    const slug = String(action.slug || config.persona).replace(/[^\w.-]/g, "");
    const card = readCard(slug);
    if (!card) return { refuse: `character "${slug}" does not exist` };
    const text = String(action.text || "").trim().slice(0, 300);
    if (!text) return { refuse: "no note text given" };
    const isRemove = t === "remove_context";
    return {
      describe: isRemove ? `remove note from ${slug}: "${text.slice(0, 50)}"` : `note for ${slug}: "${text.slice(0, 60)}"`,
      reload: true,
      apply: () => {
        const world = loadWorld(slug);
        const list = isRemove
          ? cleanContext(world.context).filter((c) => c.text.toLowerCase() !== text.toLowerCase())
          : addContext(world, text, action.until);
        saveWorld(slug, { ...world, context: list });
        return { slug, context: list.length };
      },
    };
  }

  if (t === "set_traits" || t === "gen_traits") {
    const slug = String(action.slug || config.persona).replace(/[^\w.-]/g, "");
    const card = readCard(slug);
    if (!card) return { refuse: `character "${slug}" does not exist` };
    if (t === "gen_traits") {
      return {
        describe: `generate humour & interests for ${slug}`,
        reload: true,
        apply: async () => {
          const world = loadWorld(slug);
          const traits = await generateTraits(loadPersona(slug), world, { force: true });
          return { slug, humor: traits.humor.style, interests: traits.interest.topics.length };
        },
      };
    }
    const current = loadTraits(slug);
    const next = {
      humor: { ...current.humor, ...(action.humor || {}) },
      interest: { ...current.interest, ...(action.interest || {}) },
      learned: current.learned,
      source: "agent",
    };
    return {
      describe: `traits ${slug}: humour "${String(next.humor.style).slice(0, 40)}" ${Math.round(next.humor.chance * 100)}%, interest ${Math.round(next.interest.level * 100)}%`,
      reload: true,
      apply: () => ({ slug, ...saveTraits(slug, next) }),
    };
  }

  if (t === "switch_persona") {
    const slug = String(action.slug || "").replace(/[^\w.-]/g, "");
    if (!personas.includes(slug)) return { refuse: `character "${slug}" does not exist` };
    const before = config.persona;
    return {
      describe: `active character: ${before} → ${slug}`,
      reload: true,
      apply: async () => {
        const { setEnv } = await import("../scripts/_settings.mjs");
        setEnv("PERSONA", slug);
        const { reloadConfig } = await import("./config.mjs");
        reloadConfig();
        return { from: before, to: slug };
      },
    };
  }

  return { refuse: `action "${t}" refused` };
}

/* -------------------------------- context ------------------------------ */

function buildContext({ personas, contacts, routine }) {
  const values = currentValues();
  const knobLines = KNOBS.map((k) => `${k.key}=${values[k.key]}  (${k.label})`).join("\n");
  const card = readCard(config.persona);
  const contactLines = contacts
    .map((c) => `- ${c.name || c.number} (${c.jid}) trusted=${c.trusted} nick="${c.nick}" mood=${c.moodLabel} state=${c.state}`)
    .join("\n");
  const routineLines = routine
    ? [
        `tema: ${routine.theme}`,
        `sekarang: ${routine.now ? routine.now.what : "(bebas)"}`,
        `momen: ${(routine.moments || []).map((m) => `${m.at} ${m.kind} ${m.what}${m.fired ? " (sudah)" : ""}`).join(" | ")}`,
      ].join("\n")
    : "(belum ada rutinitas hari ini)";

  return [
    `KARAKTER AKTIF: ${config.persona} (${personas.join(", ")})`,
    `FRONTMATTER:\n${JSON.stringify(card?.meta || {}, null, 1)}`,
    `KARTU (potongan, buat nyari teks "find"):\n${String(card?.body || "").slice(0, 3500)}`,
    `ROUTINAS HARI INI:\n${routineLines}`,
    `KONTAK:\n${contactLines || "(belum ada)"}`,
    `SETTING YANG ADA:\n${knobLines}`,
  ].join("\n\n");
}

/* --------------------------------- run --------------------------------- */

export async function runAdmin({ message, history = [], context }) {
  const ctx = context || {};
  const messages = [
    { role: "system", content: SYSTEM },
    ...history.slice(-6).map((h) => ({ role: h.role === "agent" ? "assistant" : "user", content: String(h.text || "").slice(0, 800) })),
    { role: "user", content: `${buildContext(ctx)}\n\n--- PERMINTAAN OWNER ---\n${String(message).slice(0, 1500)}` },
  ];

  let raw;
  try {
    raw = await llmChat(messages, { json: true, temperature: 0.3, maxTokens: 2200 });
  } catch (err) {
    return { ok: false, say: `The model call failed: ${err.message}`, applied: [], refused: [] };
  }

  let parsed = extractJsonObject(raw);

  // one repair attempt: models occasionally answer in prose despite json mode
  if (!parsed) {
    log(`admin: reply was not JSON (${String(raw).slice(0, 120).replace(/\s+/g, " ")}…) — asking again`);
    try {
      const retry = await llmChat(
        [
          ...messages,
          { role: "assistant", content: String(raw).slice(0, 1500) },
          {
            role: "user",
            content:
              "That reply was not valid JSON. Answer again with ONLY the JSON object described in your instructions: " +
              '{"say":"...","actions":[...]}. No markdown, no prose before or after, and keep "say" under 3 sentences.',
          },
        ],
        { json: true, temperature: 0, maxTokens: 900 },
      );
      parsed = extractJsonObject(retry);
      if (!parsed) raw = retry;
    } catch (err) {
      log(`admin: repair call failed: ${err.message}`);
    }
  }

  // still nothing usable: show the prose instead of an error, and change nothing
  if (!parsed) {
    const prose = String(raw || "")
      .replace(/```[\s\S]*?```/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 600);
    log("admin: giving up on JSON, replying with prose only (no changes applied)");
    return {
      ok: true,
      degraded: true,
      say: prose || "The model did not answer usefully. Try asking again in a different way.",
      applied: [],
      refused: [],
    };
  }

  const say = String(parsed.say || "").trim().slice(0, 800);
  const requested = Array.isArray(parsed.actions) ? parsed.actions.slice(0, 12) : [];
  const applied = [];
  const refused = [];
  let reload = false;

  for (const action of requested) {
    const check = validate(action, { personas: ctx.personas || [] });
    if (check.refuse) {
      refused.push({ action, reason: check.refuse });
      log(`admin: refused ${action?.type} — ${check.refuse}`);
      continue;
    }
    try {
      const result = await check.apply();
      if (!result) throw new Error("no result");
      applied.push({ type: action.type, describe: check.describe, result });
      if (check.reload) reload = true;
      log(`admin: applied ${action.type} — ${check.describe}`);
    } catch (err) {
      refused.push({ action, reason: err.message });
      log(`admin: failed ${action?.type} — ${err.message}`);
    }
  }

  if (applied.some((a) => a.type === "set_setting")) {
    const { reloadConfig } = await import("./config.mjs");
    reloadConfig();
  }

  return { ok: true, say, applied, refused, reload };
}
