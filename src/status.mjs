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
import { extractJsonObject, salvageJsonObject } from "./guard.mjs";

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
      .map((i, n) => ({
        at: String(i.at || "").slice(0, 5),
        text: String(i.text || "").trim().slice(0, 220),
        reason: String(i.reason || "").slice(0, 80),
        color: nearestPaletteColor(i.color) || pickColor(n),
        font: Math.max(1, Math.min(5, Number(i.font) || 1 + (n % 3))),
        media: String(i.media || ""),
        postedAt: Number(i.postedAt) || 0,
        key: i.key && i.key.id ? { id: String(i.key.id), remoteJid: String(i.key.remoteJid || "status@broadcast"), fromMe: true, participant: i.key.participant ? String(i.key.participant) : undefined } : null,
        id: String(i.id || newId()),
      }))
      // an item is a status line, a photo with a caption, or a photo on its own
      .filter((i) => (i.text || i.media) && /^\d{1,2}:\d{2}$/.test(i.at))
      .slice(0, 12),
    history: (plan.history || [])
      .map((h) => ({
        at: Number(h.at) || 0,
        text: String(h.text || "").slice(0, 220),
        color: String(h.color || ""),
        media: String(h.media || ""),
        key: h.key && h.key.id ? { id: String(h.key.id), remoteJid: String(h.key.remoteJid || "status@broadcast"), fromMe: true } : null,
      }))
      .slice(-60),
  };
  try {
    fs.writeFileSync(fileFor(slug), JSON.stringify(clean, null, 2));
  } catch (err) {
    log(`status plan save failed: ${err.message}`);
  }
  return clean;
}

const newId = () => Math.random().toString(36).slice(2, 8);

/** Everything the dashboard needs to draw the tab. */
export function statusState(slug = config.persona) {
  const plan = loadPlan(slug);
  return {
    ...plan,
    colors: STATUS_COLORS,
    window: statusWindow(),
    minGapMin: Number(config.statusMinGapMin) || 0,
    perDay: Number(config.statusPerDay) || 3,
    audience: statusAudience(),
    audienceMode: config.statusAudience,
    mediaAllowed: !!config.statusMedia,
    enabled: !!config.waStatus,
  };
}

/** Edit one item (by id) or add a new one when there is no id. */
export function upsertItem(slug, patch = {}) {
  const plan = loadPlan(slug);
  if (!plan.date) plan.date = todayKey();
  const at = String(patch.at || "").slice(0, 5);
  if (!/^\d{1,2}:\d{2}$/.test(at)) return { ok: false, error: "time must look like 14:30" };
  const id = String(patch.id || "");
  const textGiven = Object.prototype.hasOwnProperty.call(patch, "text");
  const text = String(patch.text ?? "").trim().slice(0, 220);
  const mediaGiven = Object.prototype.hasOwnProperty.call(patch, "media");
  const media = String(patch.media ?? "").trim();
  if (!text && !media) return { ok: false, error: "a status needs a line of text or a photo" };
  if (id) {
    const item = plan.items.find((i) => i.id === id);
    if (!item) return { ok: false, error: "that item is no longer in the plan" };
    Object.assign(item, { at, text: textGiven ? text : item.text });
    if (mediaGiven) item.media = media;
    if (patch.color) item.color = String(patch.color);
    if (patch.font) item.font = Number(patch.font);
  } else {
    plan.items.push({ at, text, media, color: patch.color || "", font: Number(patch.font) || 0, id: "" });
  }
  plan.items.sort((a, b) => a.at.localeCompare(b.at));
  const saved = savePlan(slug, plan);
  return { ok: true, plan: saved };
}

export function removeItem(slug, id) {
  const plan = loadPlan(slug);
  const before = plan.items.length;
  plan.items = plan.items.filter((i) => i.id !== String(id));
  if (plan.items.length === before) return { ok: false, error: "not found" };
  return { ok: true, plan: savePlan(slug, plan) };
}

/** Clear the plan for today. Posted ones stay in the history unless asked otherwise. */
export function clearPlan(slug) {
  const plan = loadPlan(slug);
  plan.items = [];
  plan.date = todayKey();
  return { ok: true, plan: savePlan(slug, plan) };
}

/** Copy yesterday's shape into today: same times, rewritten lines. */
export function copyPlanForward(slug) {
  const plan = loadPlan(slug);
  const fresh = plan.items.filter((i) => !i.postedAt);
  if (!fresh.length) return { ok: false, error: "nothing left to copy" };
  plan.history = [...(plan.history || []), ...plan.items.filter((i) => i.postedAt).map((i) => ({ at: i.postedAt, text: i.text, color: i.color, media: i.media, key: i.key }))].slice(-60);
  plan.items = fresh.map((i) => ({ ...i, postedAt: 0, key: null, id: "" }));
  plan.date = todayKey();
  return { ok: true, plan: savePlan(slug, plan) };
}

/** Keep a photo for a status. Returns the path the plan should store. */
export function saveMedia(base64, ext = "jpg") {
  const dir = path.join(dirFor(), "media");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const clean = String(base64 || "").replace(/^data:[^,]+,/, "");
  if (!clean || clean.length < 100) return "";
  const safeExt = ["jpg", "jpeg", "png", "webp", "mp4"].includes(String(ext).toLowerCase()) ? String(ext).toLowerCase() : "jpg";
  const file = path.join(dir, `status-${Date.now()}.${safeExt}`);
  try {
    fs.writeFileSync(file, Buffer.from(clean, "base64"));
    log(`status media saved: ${path.basename(file)}`);
    return file;
  } catch (err) {
    log(`status media failed: ${err.message}`);
    return "";
  }
}

/**
 * WhatsApp's own text-status colours (the ones you get when you tap the palette).
 * No pure black: a black status is what you get when no colour is sent at all.
 */
export const STATUS_COLORS = [
  "#0A7CFF", // blue
  "#00A884", // green
  "#7F66FF", // purple
  "#E91E63", // pink
  "#FF7A00", // orange
  "#F4B400", // amber
  "#546E7A", // blue grey
  "#00695C", // teal
  "#5E35B1", // deep purple
  "#D84315", // deep orange
  "#37474F", // dark slate
  "#6D4C41", // brown
];

export function nearestPaletteColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return "";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  let best = "", bestD = Infinity;
  for (const c of STATUS_COLORS) {
    const v = parseInt(c.slice(1), 16);
    const dr = r - ((v >> 16) & 255), dg = g - ((v >> 8) & 255), db = b - (v & 255);
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}
const pickColor = (i = 0) => STATUS_COLORS[Math.abs(Number(i) || 0) % STATUS_COLORS.length];

const todayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** No model needed: her routine already knows what she did today. */
function planFromRoutine(routine, persona) {
  const out = [];
  const moments = (routine?.moments || []).filter((m) => m.share !== false);
  for (const m of moments.slice(0, config.statusPerDay)) {
    const text = String(m.what || "").split(/\s+/).slice(0, 12).join(" ");
    if (text) out.push({ at: m.at, text, color: pickColor(out.length), reason: `taken from her day (${m.kind})` });
  }
  if (out.length < 2) {
    for (const b of (routine?.blocks || []).slice(0, 3)) {
      const text = String(b.what || "").split(/\s+/).slice(0, 10).join(" ");
      if (text) out.push({ at: b.start, text, color: pickColor(out.length + 3), reason: "taken from her routine" });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at)).slice(0, config.statusPerDay);
}

const SYSTEM = `You write the WhatsApp Status ("story") posts of a roleplay character for one day.

Answer with ONE JSON object and nothing else:
{"items":[{"at":"HH:MM","text":"one short status line, max 12 words","color":"#RRGGBB","reason":"how it fits her day"}]}

Between 3 and 4 items, spread across her waking hours and matching what she is doing then.
For "color", pick from exactly these: PALETTE.
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

  let parsed = extractJsonObject(out) || salvageJsonObject(out);
  if (parsed) log("status plan: jawabannya kepotong, tapi masih bisa diselamatkan");
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
      parsed = extractJsonObject(retry) || salvageJsonObject(retry);
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

  let next = savePlan(slug, {
    date: todayKey(),
    items: (parsed.items || []).map((i, n) => ({ ...i, id: `${todayKey()}-${n}` })),
    history: plan.history,
  });
  if (!next.items.length) {
    // a plan with no usable lines is worse than no model at all: her own day always has something
    const fallback = planFromRoutine(routine, persona);
    if (fallback.length) {
      log(`status plan: model gave ${(parsed.items || []).length} unusable line(s) — using her routine instead`);
      next = savePlan(slug, { date: todayKey(), items: fallback.map((f, n) => ({ ...f, id: `${todayKey()}-fb${n}` })), history: plan.history });
    } else {
      log(`status plan: model gave ${(parsed.items || []).length} unusable line(s) and the routine had nothing — no plan today`);
      return plan;
    }
  }
  log(`status plan ${slug}: ${next.items.length} posts — ${next.items.map((i) => i.at).join(", ")}`);
  return next;
}

/** The next planned status whose time has come. */
export function statusWindow() {
  return { start: Number(config.statusQuietStart) || 0, end: Number(config.statusQuietEnd) || 0 };
}

/** Inside the window she is allowed to post (quiet hours are the opposite of it). */
export function inStatusWindow(now = new Date()) {
  const h = now.getHours();
  const { start, end } = statusWindow();
  if (start === end) return true;
  if (start < end) return !(h >= start && h < end);
  return !(h >= start || h < end);
}

const toMin = (hhmm) => {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  return (Number(h) || 0) * 60 + (Number(m) || 0);
};

/** When did she last post anything? (items and history both count) */
export function lastPostedAt(slug) {
  const plan = loadPlan(slug);
  const stamps = [...(plan.items || []).map((i) => i.postedAt), ...(plan.history || []).map((h) => h.at)].filter(Boolean);
  return stamps.length ? Math.max(...stamps) : 0;
}

/**
 * The next status whose time has come. Respects the allowed window and the minimum
 * gap, so a plan whose times bunch up cannot come out as three posts in ten minutes.
 */
export function dueStatus(slug, now = new Date()) {
  const plan = loadPlan(slug);
  if (plan.date !== todayKey(now)) return null;
  if (!inStatusWindow(now)) return null;
  const gap = Number(config.statusMinGapMin) || 0;
  if (gap > 0 && !plan.items.some((i) => i.postedAt === 0 && false)) {
    const last = lastPostedAt(slug);
    if (last && Date.now() - last < gap * 60000) return null;
  }
  const mins = now.getHours() * 60 + now.getMinutes();
  const due = plan.items
    .filter((i) => !i.postedAt && toMin(i.at) <= mins)
    .sort((a, b) => toMin(a.at) - toMin(b.at));
  return due[0] || null;
}

export function markPosted(slug, item, key = null, now = Date.now()) {
  const plan = loadPlan(slug);
  const target = plan.items.find((i) => i.id === item?.id);
  if (target) {
    target.postedAt = now;
    if (key && key.id) target.key = key;
  }
  plan.history = [
    ...(plan.history || []),
    { at: now, text: String(item?.text || ""), color: String(item?.color || ""), media: String(item?.media || ""), key: key && key.id ? key : null },
  ].slice(-60);
  return savePlan(slug, plan);
}

/**
 * Who can see her status.
 *
 * WhatsApp wants the recipients as phone-number jids. A list made only of anonymous
 * LIDs appears to be dropped server-side: the send resolves here, but the status
 * never shows up anywhere — which is exactly what happened. So only real numbers go
 * in, and LID-only contacts are skipped (their number is hidden from the bot) with a
 * count in the log.
 */
export function statusAudience() {
  const chats = listChats().filter((c) => (config.statusAudience === "trusted" ? c.trusted === true : true));
  const out = [];
  let skipped = 0;
  for (const c of chats) {
    const jid = String(c.jid);
    if (/@s\.whatsapp\.net$/.test(jid)) {
      out.push(jid);
      continue;
    }
    const lid = jid.split("@")[0];
    const mapped = config.lidMap?.[lid];
    if (mapped) {
      out.push(`${String(mapped).replace(/\D/g, "")}@s.whatsapp.net`);
      continue;
    }
    const num = String(c.profile?.number || "").replace(/\D/g, "");
    if (num && num !== lid && num.length >= 8 && num.length <= 16) {
      out.push(`${num}@s.whatsapp.net`);
      continue;
    }
    skipped++;
  }
  if (skipped) log(`status audience: ${out.length} number(s), ${skipped} contact(s) skipped (their number is hidden)`);
  return [...new Set(out)];
}

/** Delete a status from WhatsApp (the poster can always take their own back). */
export async function revokeStatus(sock, key) {
  if (!key || !key.id) return false;
  try {
    await sock.sendMessage("status@broadcast", { delete: key });
    log(`status deleted from WhatsApp: ${String(key.id).slice(0, 12)}`);
    return true;
  } catch (err) {
    log(`status delete failed: ${err.message}`);
    return false;
  }
}

/** Forget a history entry (with or without deleting it from WhatsApp). */
export function forgetHistory(slug, at) {
  const plan = loadPlan(slug);
  const before = (plan.history || []).length;
  plan.history = (plan.history || []).filter((h) => Number(h.at) !== Number(at));
  if (plan.history.length === before) return { ok: false, error: "not found" };
  return { ok: true, plan: savePlan(slug, plan) };
}

export async function postStatus(sock, text, { audience = null, color = "", font = 1, media = "" } = {}) {
  const list = audience || statusAudience();
  if (!list.length) {
    log("status skipped: nobody in the audience list");
    return "";
  }
  // no colour is what produces the plain black card, so always send one
  const bg = nearestPaletteColor(color) || pickColor(Date.now());
  const line = String(text || "").slice(0, 300);
  let content;
  let kind = "text";
  try {
    if (media && fs.existsSync(media)) {
      const buf = fs.readFileSync(media);
      content = /\.(mp4|mov)$/i.test(media) ? { video: buf, caption: line } : { image: buf, caption: line };
      kind = /mp4|mov$/i.test(media) ? "video" : "photo";
    } else {
      content = { text: line };
    }
    const key = await sock.sendMessage("status@broadcast", content, {
      statusJidList: list,
      backgroundColor: bg,
      font: Math.max(1, Math.min(5, Number(font) || 1)),
    });
    log(`status posted (${kind}) → ${list.length} contact(s) [${bg}]: ${line.slice(0, 60)}`);
    return key?.key || "";
  } catch (err) {
    log(`status post failed: ${err.message}`);
    return "";
  }
}

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
