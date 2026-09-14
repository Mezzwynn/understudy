/**
 * photo-library.mjs — the photos she can send, and the rules for when one is worth sending.
 *
 * She does not generate a photo when she feels like it. Real people do not: they send from a small
 * pile — three selfies, the cat, the food they always order, the lane home — and they reuse them for
 * months. Generating on demand was also a lie twice over: it costs money every time, and identity
 * does not survive generation (a reference photo scored 2/10, a description 4/10).
 *
 * So: a library, chosen from, matched to what she is actually doing at that hour.
 *
 *   data/photos/library/<slug>/index.json   the catalogue
 *   data/photos/library/<slug>/*.jpg        the photos themselves (already humanised)
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, config, log } from "./config.mjs";
import { humanize } from "./humanize.mjs";
import { classFitOf, fitsPersonaClass } from "./lifestyle.mjs";
import { loadPersona } from "./prompt.mjs";

const slugOf = (slug) => String(slug || config.persona || "character").replace(/[^\w.-]/g, "");

export function libraryDir(slug) {
  const d = path.join(DATA_DIR, "photos", "library", slugOf(slug));
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}
const indexFile = (slug) => path.join(libraryDir(slug), "index.json");

export function loadLibrary(slug) {
  try {
    const j = JSON.parse(fs.readFileSync(indexFile(slug), "utf8"));
    const photos = (Array.isArray(j.photos) ? j.photos : []).map((p) => ({
      ...p,
      // photos added before class tagging existed get it on read
      classFit: p.classFit || classFitOf(`${p.scene || ""} ${p.note || ""}`),
    }));
    return { slug: slugOf(slug), photos };
  } catch {
    return { slug: slugOf(slug), photos: [] };
  }
}

export function saveLibrary(slug, lib) {
  fs.writeFileSync(indexFile(slug), JSON.stringify({ slug: slugOf(slug), photos: lib.photos || [] }, null, 2));
  return lib;
}

/** Which part of the day a photo belongs to, so a night photo is not sent at 9am. */
export function partOfDay(hour = new Date().getHours()) {
  if (hour < 5) return "night";
  if (hour < 11) return "morning";
  if (hour < 16) return "day";
  if (hour < 20) return "evening";
  return "night";
}

/** Words that tie a photo to what she is doing, taken from her own routine text. */
const TOPICS = {
  meja: ["kerja", "kerja", "kantor", "laptop", "brief", "deadline", "email", "desain", "kopi", "meja", "rapat"],
  kopi: ["kopi", "ngopi", "cafe", "kafe", "minum"],
  warung: ["warung", "makan", "nasi", "lapar", "santap", "dinner", "sarapan", "makanan"],
  momo: ["momo", "kucing", "cat"],
  jalan: ["jalan", "pulang", "berangkat", "motor", "perjalanan", "gang", "scooter"],
  pantai: ["pantai", "sanur", "laut", "beach"],
  pasar: ["pasar", "belanja", "sayur", "errand"],
  hujan: ["hujan", "rain", "mendung"],
  kelas: ["kelas", "kampus", "kuliah", "tugas"],
};

const topicTagsFor = (text) => {
  const t = String(text || "").toLowerCase();
  const out = [];
  for (const [tag, words] of Object.entries(TOPICS)) if (words.some((w) => t.includes(w))) out.push(tag);
  return out;
};

/**
 * Add a photo. Images are humanised on the way in — downscaled and re-encoded to the size a phone
 * produces — so sending later costs nothing and every photo in the library has the same finish.
 */
export function addPhoto(slug, file, meta = {}) {
  const src = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  if (!fs.existsSync(src)) return { ok: false, error: "file not found" };
  const lib = loadLibrary(slug);
  const id = `p${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const target = path.join(libraryDir(slug), `${id}.jpg`);
  try {
    const raw = fs.readFileSync(src);
    const small = humanize(raw, { maxSide: meta.maxSide || 1280, quality: meta.quality || 74, seed: Math.floor(Math.random() * 9999) });
    fs.writeFileSync(target, small.buf);
  } catch (err) {
    return { ok: false, error: `could not process that image: ${err.message}` };
  }
  const scene = String(meta.scene || path.basename(src, path.extname(src)));
  const topics = meta.topics ? String(meta.topics).split(",").map((s) => s.trim()).filter(Boolean) : topicTagsFor(`${scene} ${meta.note || ""}`);
  const entry = {
    id,
    file: path.basename(target),
    // foto warung buat karakter berduit itu tel, sama kayak POV yang salah
    classFit: classFitOf(`${scene} ${meta.note || ""}`),
    scene,
    note: String(meta.note || "").slice(0, 200),
    kind: meta.kind || (String(scene).startsWith("selfie") ? "self" : "view"),
    timeOfDay: meta.timeOfDay || partOfDay(meta.hour ?? 12),
    topics,
    addedAt: Date.now(),
    usedCount: 0,
    lastUsedAt: 0,
    sentTo: {},
  };
  lib.photos.push(entry);
  saveLibrary(slug, lib);
  log(`photo library: added ${entry.kind} "${entry.scene}" [${topics.join(",") || "no topics"}] for ${slugOf(slug)}`);
  return { ok: true, photo: entry };
}

export function removePhoto(slug, id) {
  const lib = loadLibrary(slug);
  const hit = lib.photos.find((p) => p.id === id);
  if (!hit) return { ok: false, error: "not found" };
  lib.photos = lib.photos.filter((p) => p.id !== id);
  fs.rmSync(path.join(libraryDir(slug), hit.file), { force: true });
  saveLibrary(slug, lib);
  return { ok: true };
}

/**
 * Score every photo against this moment and return the best, or null when nothing fits.
 *
 * The weights say what matters: the time of day first (a night photo in the morning is impossible),
 * then whether it matches what she is doing, then whether this contact has already been sent it.
 */
export function pickPhoto({ slug = config.persona, chat = null, moment = null, block = null, persona = null, now = new Date() } = {}) {
  const lib = loadLibrary(slug);
  if (!lib.photos.length) return null;
  const who = persona || loadPersona(slug);
  // a photo from the wrong class of place is a tell: filter before scoring
  const kinds = String(config.photoKinds || "view,self").split(",").map((k) => k.trim()).filter(Boolean);
  const eligible = lib.photos.filter(
    (p) => fitsPersonaClass(`${p.scene} ${p.note || ""}`, who, { allowOneStep: true }) && (!kinds.length || kinds.includes(p.kind)),
  );
  if (!eligible.length) return null;
  const pod = partOfDay(now.getHours());
  const context = `${block?.what || ""} ${block?.place || ""} ${moment?.what || ""} ${moment?.kind || ""} ${chat?.summary || ""}`.toLowerCase();
  const wanted = topicTagsFor(context);
  const jid = String(chat?.jid || "");
  const mood = Number(chat?.mood?.valence ?? 0.5);

  const scores = config.photoLearn ? sceneScores(slug) : {};
  const scored = eligible
    .map((p) => {
      let score = 0;
      const why = [];
      if (p.timeOfDay === pod) {
        score += 3;
        why.push("jam cocok");
      } else if (p.timeOfDay === "any") {
        score += 1;
        why.push("jam bebas");
      } else {
        score -= 2;
      }
      const hits = (p.topics || []).filter((t) => wanted.includes(t));
      if (hits.length) {
        score += 2 * hits.length;
        why.push(`nyambung: ${hits.join(",")}`);
      }
      const lastTo = Number(p.sentTo?.[jid] || 0);
      const daysSince = lastTo ? (Date.now() - lastTo) / 86400000 : 999;
      if (daysSince < 14) {
        score -= 6;
        why.push("sudah pernah dikirim ke dia");
      } else if (lastTo === 0) {
        score += 1;
        why.push("belum pernah");
      }
      // a bad day is not a selfie day; a good mood can carry one
      if (p.kind === "self") {
        if (mood < 0.35) score -= 3;
        else if (mood > 0.65) score += 1;
      } else {
        score += mood < 0.35 ? 1 : 0;
      }
      // what Hik rated well comes back; what he rated badly sinks (PHOTO_LEARN)
      if (config.photoLearn) {
        const sc = scores[p.scene];
        if (sc !== undefined) score += (sc - 0.5) * 6;
      }
      score += Math.random() * 0.9; // a little spontaneity
      return { photo: p, score, why };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < 1) return null;
  return { ...best.photo, score: best.score, why: best.why.join(" · ") };
}

/** Every photo she sends is recorded, because the ratings are what the picking learns from. */
export function photoHistory(slug) {
  try {
    return JSON.parse(fs.readFileSync(path.join(libraryDir(slug), "history.json"), "utf8"));
  } catch {
    return [];
  }
}
function saveHistory(slug, list) {
  fs.writeFileSync(path.join(libraryDir(slug), "history.json"), JSON.stringify(list.slice(-300), null, 2));
}

/** Average rating per scene, so a photo that scored badly stops coming up. */
export function sceneScores(slug) {
  const out = {};
  for (const h of photoHistory(slug)) {
    if (!h.rating) continue;
    const v = h.rating === "bagus" ? 1 : h.rating === "lumayan" ? 0.5 : 0;
    out[h.scene] = out[h.scene] || { sum: 0, n: 0 };
    out[h.scene].sum += v;
    out[h.scene].n++;
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.sum / v.n]));
}

export function markSent(slug, id, jid, extra = {}) {
  const lib = loadLibrary(slug);
  const p = lib.photos.find((x) => x.id === id);
  if (!p) return;
  p.usedCount = (p.usedCount || 0) + 1;
  p.lastUsedAt = Date.now();
  p.sentTo = { ...(p.sentTo || {}), [String(jid)]: Date.now() };
  saveLibrary(slug, lib);
  const hist = photoHistory(slug);
  hist.push({
    id: `h${Date.now().toString(36)}`,
    photoId: id,
    scene: p.scene,
    kind: p.kind,
    timeOfDay: p.timeOfDay,
    topics: p.topics || [],
    jid: String(jid),
    at: Date.now(),
    caption: String(extra.caption || "").slice(0, 120),
    why: String(extra.why || "").slice(0, 120),
    rating: "",
    weird: false,
    note: "",
  });
  saveHistory(slug, hist);
}

/** Rate one sent photo: this is the only signal that says whether the whole pipeline is working. */
export function rateSent(slug, historyId, { rating = "", weird = null, note = "" } = {}) {
  const hist = photoHistory(slug);
  const hit = hist.find((h) => h.id === historyId);
  if (!hit) return { ok: false, error: "not found" };
  if (rating) hit.rating = String(rating).slice(0, 20);
  if (typeof weird === "boolean") hit.weird = weird;
  if (note !== "") hit.note = String(note).slice(0, 200);
  saveHistory(slug, hist);
  // a photo rated badly is retired from the library; a weird one never goes out again
  const scores = sceneScores(slug);
  const lib = loadLibrary(slug);
  const known = Object.values(scores);
  const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
  const worst = Object.entries(scores).filter(([, s]) => s === 0).map(([k]) => k);
  const retired = [];
  if (retired.length === 0 && avg < 1) {
    for (const scene of worst) {
      const p = lib.photos.find((x) => x.scene === scene);
      if (p && (p.badStreak || 0) >= 1) retired.push(scene);
      if (p) {
        p.badStreak = (p.badStreak || 0) + 1;
      }
    }
    if (retired.length) saveLibrary(slug, lib);
  }
  return { ok: true, scores };
}

/**
 * Should a photo go out with this reply at all? Rare is the point: a chat where every third message
 * is a photo reads like a bot, and a photo that does not match her day reads worse than none.
 */
export function shouldSendPhoto({ chat, moment = null, sleepy = false, force = false, now = new Date() } = {}) {
  if (!config.photoLibrary || !config.photoSend) return { ok: false, reason: "off" };
  if (sleepy) return { ok: false, reason: "asleep" };
  // per contact, not a global switch: a contact is allowed because Hik said so, or because they are trusted
  if (chat?.photoAllowed === false) return { ok: false, reason: "turned off for this contact" };
  if (chat?.photoAllowed !== true && !chat?.trusted) return { ok: false, reason: "not allowed for this contact" };
  const hour = new Date(now).getHours();
  const ws = Number(config.photoWindowStart ?? 0);
  const we = Number(config.photoWindowEnd ?? 24);
  if (ws !== we && (hour < ws || hour >= we)) return { ok: false, reason: `outside her photo hours (${ws}-${we})` };
  const perConv = Number(chat?.stats?.photoConvCount || 0);
  if (perConv >= Number(config.photoMaxPerConv || 1) && Date.now() - Number(chat?.stats?.lastPhotoAt || 0) < 3600000) {
    return { ok: false, reason: `already ${perConv} in this conversation` };
  }
  const today = new Date(now).toISOString().slice(0, 10);
  const sent = chat?.stats?.photoDay === today ? Number(chat.stats.photoCount || 0) : 0;
  if (sent >= Number(config.photoDailyMax || 1)) return { ok: false, reason: `already ${sent} today` };
  const last = Number(chat?.stats?.lastPhotoAt || 0);
  const gapMin = Number(config.photoMinGapMin || 0);
  if (last && Date.now() - last < gapMin * 60000) return { ok: false, reason: "too soon" };
  // force = he asked for a photo; the daily cap and the gap still apply, the dice do not
  if (!force) {
    const chance = Number(config.photoChance || 0.05);
    if (Math.random() > chance) return { ok: false, reason: `chance (${Math.round(chance * 100)}%)` };
  }
  const pick = pickPhoto({ chat, moment, now });
  if (!pick) return { ok: false, reason: "nothing fits her day" };
  return { ok: true, photo: pick };
}

export function librarySummary(slug = config.persona) {
  const lib = loadLibrary(slug);
  const byKind = lib.photos.reduce((a, p) => ({ ...a, [p.kind]: (a[p.kind] || 0) + 1 }), {});
  const byTime = lib.photos.reduce((a, p) => ({ ...a, [p.timeOfDay || "?"]: (a[p.timeOfDay || "?"] || 0) + 1 }), {});
  return {
    slug: slugOf(slug),
    count: lib.photos.length,
    byKind,
    byTime,
    photos: lib.photos
      .map((p) => ({
        id: p.id,
        file: p.file,
        url: `/photo?d=library/${slugOf(slug)}&f=${encodeURIComponent(p.file)}`,
        scene: p.scene,
        kind: p.kind,
        timeOfDay: p.timeOfDay,
        topics: p.topics || [],
        usedCount: p.usedCount || 0,
        lastUsedAt: p.lastUsedAt || 0,
        sentToCount: Object.keys(p.sentTo || {}).length,
      }))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.scene.localeCompare(b.scene)),
  };
}
