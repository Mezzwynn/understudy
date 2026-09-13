/**
 * status.mjs — her WhatsApp Status (the story feed).
 *
 * A status is not a reply: it goes to everyone in her list and nobody is expected to
 * answer it. So it is a good place for the things a person posts without being asked —
 * a coffee at 11, work annoying her at 14, a small win at 19.
 *
 * Statuses are planned as a small arc for the day (3-4 of them, tied to the blocks and
 * moments of her routine), so scrolling her status tells the story of that day rather
 * than a random line. Plans live in data/status/<slug>.json.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, config, log } from "./config.mjs";
import { chat as llmChat } from "./llm.mjs";
import { languageDirective } from "./lang.mjs";
import { listChats } from "./store.mjs";
import { extractJsonObject } from "./guard.mjs";

function dirFor() {
  const d = path.join(DATA_DIR, "status");
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function fileFor(slug) {
  return path.join(dirFor(), `${String(slug || "character").replace(/[^\w.-]/g, "")}.json`);
}

export function loadPlan(slug) {
  const f = fileFor(slug);
  if (!fs.existsSync(f)) return { slug, date: "", items: [], history: [] };
  try {
    const p = JSON.parse(fs.readFileSync(f, "utf8"));
    return { slug, date: "", items: [], history: [], ...p };
  } catch {
    return { slug, date: "", items: [], history: [] };
  }
}

export function savePlan(slug, plan) {
  const clean = {
    slug,
    date: String(plan.date || ""),
    items: (plan.items || [])
      .map((i) => ({
        at: String(i.at || "").slice(0, 5),
        text: String(i.text || "").trim().slice(0, 160),
        reason: String(i.reason || "").slice(0, 80),
        postedAt: Number(i.postedAt) || 0,
        id: String(i.id || ""),
      }))
      .filter((i) => i.text && /^\d{1,2}:\d{2}$/.test(i.at))
      .slice(0, 8),
    history: (plan.history || [])
      .map((h) => ({ at: Number(h.at) || 0, text: String(h.text || "").slice(0, 160) }))
      .slice(-40),
  };
  fs.writeFileSync(fileFor(slug), JSON.stringify(clean, null, 2));
  return clean;
}

const todayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** No model needed: her routine already knows what she did today. */
function planFromRoutine(routine, persona) {
  const out = [];
  const moments = (routine?.moments || []).filter((m) => m.share !== false);
  for (const m of moments.slice(0, config.statusPerDay)) {
    const text = String(m.what || "").split(/\s+/).slice(0, 12).join(" ");
    if (text) out.push({ at: m.at, text, reason: `taken from her day (${m.kind})` });
  }
  if (out.length < 2) {
    for (const b of (routine?.blocks || []).slice(0, 3)) {
      const text = String(b.what || "").split(/\s+/).slice(0, 10).join(" ");
      if (text) out.push({ at: b.start, text, reason: "taken from her routine" });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at)).slice(0, config.statusPerDay);
}

const SYSTEM = `You write the WhatsApp Status ("story") posts of a roleplay character for one day.

Answer with ONE JSON object and nothing else:
{"items":[{"at":"HH:MM","text":"one short status line, max 12 words","reason":"how it fits her day"}]}

Between 3 and 4 items, spread across her waking hours and matching what she is doing then.
A status is what someone posts without being asked: a one-liner, a complaint, a small win, something she noticed. It is not a message to anyone and not a reply.
They must read as one arc across the day, in order, not four unrelated lines.
Write in her language and her voice: if she is terse and cold, the statuses are terse and cold. Lowercase is fine. At most one emoji, and only if it fits her.
Never mention the people she chats with, and never name a place someone could find her.
"reason" is for the owner's eyes only.

Your reply must start with the character { — no explanation, no markdown, no repeating these instructions.`;

/** Plan today's status arc from her routine and mood. */
export async function ensurePlan(persona, routine, chat, { force = false } = {}) {
  if (!config.waStatus) return null;
  const slug = persona?.slug || config.persona;
  const plan = loadPlan(slug);
  if (!force && plan.date === todayKey() && plan.items.length) return plan;

  const blocks = (routine?.blocks || []).map((b) => `${b.start}-${b.end} ${b.what}${b.place ? ` (${b.place})` : ""}`).join("\n");
  const moments = (routine?.moments || []).map((m) => `${m.at} [${m.kind}] ${m.what}`).join("\n");
  const user = [
    `CHARACTER CARD:\n${String(persona?.card || "").slice(0, 2000)}`,
    `LANGUAGE: ${languageDirective(persona?.language) || "match the card"}`,
    routine?.theme ? `TODAY'S THEME: ${routine.theme}` : "",
    blocks ? `HER DAY:\n${blocks}` : "",
    moments ? `MOMENTS TODAY:\n${moments}` : "",
    `HER MOOD: ${JSON.stringify(
      Object.fromEntries(
        Object.entries(chat?.mood || {}).filter(([k]) => k !== "updatedAt").map(([k, v]) => [k, Math.round(v * 100) / 100]),
      ),
    )}`,
    `HOW MANY: ${config.statusPerDay}`,
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
      { json: true, temperature: 1.0, maxTokens: 700 },
    );
  } catch (err) {
    log(`status plan failed: ${err.message}`);
    return plan;
  }

  let parsed = extractJsonObject(out);
  if (!parsed) {
    log(`status plan was not JSON (${String(out).slice(0, 70).replace(/\s+/g, " ")}…) — asking again, minimal`);
    try {
      // a short, blunt retry: long list-like prompts make this model chatty
      const retry = await llmChat(
        [
          { role: "system", content: 'You output only JSON. Nothing else, ever.' },
          {
            role: "user",
            content:
              `Character: ${persona?.name || "her"} — ${String(persona?.vibe || "").slice(0, 80)}. ` +
              `Language: ${languageDirective(persona?.language) || "as the card"}. ` +
              `Her day: ${(routine?.blocks || []).map((b) => `${b.start} ${b.what}`).slice(0, 6).join("; ")}. ` +
              `Write her ${config.statusPerDay} WhatsApp status lines for today as JSON: ` +
              '{"items":[{"at":"HH:MM","text":"max 12 words","reason":"why"}]}',
          },
        ],
        { json: true, temperature: 0, maxTokens: 400 },
      );
      parsed = extractJsonObject(retry);
    } catch (err) {
      log(`status plan retry failed: ${err.message}`);
    }
  }
  // still nothing: write the arc from her own day, without the model
  if (!parsed) {
    const fallback = planFromRoutine(routine, persona);
    if (!fallback.length) {
      log("status plan returned junk and there was nothing to fall back on");
      return plan;
    }
    log(`status plan: using ${fallback.length} lines taken from her own routine`);
    return savePlan(slug, { date: todayKey(), items: fallback.map((f, n) => ({ ...f, id: `${todayKey()}-fb${n}` })), history: plan.history });
  }

  const next = savePlan(slug, {
    date: todayKey(),
    items: (parsed.items || []).map((i, n) => ({ ...i, id: `${todayKey()}-${n}` })),
    history: plan.history,
  });
  log(`status plan ${slug}: ${next.items.length} posts — ${next.items.map((i) => i.at).join(", ")}`);
  return next;
}

/** The next planned status whose time has come. */
export function dueStatus(slug, now = new Date()) {
  const plan = loadPlan(slug);
  if (plan.date !== todayKey(now)) return null;
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return plan.items.find((i) => !i.postedAt && i.at <= hhmm) || null;
}

export function markPosted(slug, item, now = Date.now()) {
  const plan = loadPlan(slug);
  const target = plan.items.find((i) => i.id === item.id);
  if (target) target.postedAt = now;
  plan.history = [...plan.history, { at: now, text: item.text }];
  return savePlan(slug, plan);
}

/**
 * Who can see her status: everyone she talks to, or only the trusted ones.
 * The chat's own jid is used as-is — building a phone-number jid out of an anonymous
 * LID would produce a number that does not exist.
 */
export function statusAudience() {
  const chats = listChats().filter((c) => (config.statusAudience === "trusted" ? c.trusted === true : true));
  return [...new Set(chats.map((c) => String(c.jid)).filter((j) => /@(s\.whatsapp\.net|lid)$/.test(j)))];
}

/**
 * Post it. WhatsApp requires the recipient list; without it the status is invisible.
 */
export async function postStatus(sock, text, { audience = null } = {}) {
  const list = audience || statusAudience();
  if (!list.length) {
    log("status skipped: nobody in the audience list");
    return false;
  }
  try {
    await sock.sendMessage("status@broadcast", { text: String(text).slice(0, 300) }, { statusJidList: list });
    log(`status posted → ${list.length} contact(s): ${String(text).slice(0, 60)}`);
    return true;
  } catch (err) {
    log(`status post failed: ${err.message}`);
    return false;
  }
}

/** Prompt line: she may bring up what she posted, the way people do ("did u see my status"). */
export function statusPromptBlock(slug = config.persona) {
  if (!config.waStatus) return "";
  const plan = loadPlan(slug);
  const today = (plan.history || []).filter((h) => nowAgo(h.at) < 12);
  if (!today.length) return "";
  return [
    "## Status WA kamu hari ini",
    ...today.map((h) => `- "${h.text}"`),
    "Itu yang kamu posting (semua kontak bisa lihat). Boleh disinggung kalau nyambung, atau nyindir kalau dia nggak lihat.",
  ].join("\n");
}

const nowAgo = (ts) => (Date.now() - (ts || 0)) / 3600000;
