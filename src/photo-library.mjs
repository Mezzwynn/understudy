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
  gym: ["gym", "olahraga", "workout", "pilates", "fitness", "angkat beban", "jogging", "lari", "senam"],
  kamar: ["kamar", "kasur", "tidur", "bantal", "cermin", "mirror", "kamar mandi"],
  kantor: ["kantor", "office", "rapat", "meeting", "coworking"],
  resto: ["resto", "restoran", "dinner", "makan malam", "meja makan", "makan siang"],
  mall: ["mall", "belanja", "shopping", "toko"],
  mandi: ["mandi", "shower", "handuk", "baru bangun", "bangun tidur"],
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
    title: String(meta.title || meta.caption || scene).slice(0, 80),
    titleFixed: meta.titleFixed === true,
    caption: String(meta.caption || "").slice(0, 160),
    allowSend: meta.allowSend !== false,
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

export function setPhotoAllow(slug, id, allow) {
  const lib = loadLibrary(slug);
  const p = lib.photos.find((x) => x.id === id);
  if (!p) return { ok: false, error: "not found" };
  p.allowSend = !!allow;
  saveLibrary(slug, lib);
  return { ok: true, photo: p };
}

/** A short, honest name for a photo, read from the image itself so the library matches what is in it. */
export async function titleFor(file) {
  try {
    if (!config.openrouterApiKey || !fs.existsSync(file)) return "";
    const b64 = fs.readFileSync(file).toString("base64");
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.openrouterApiKey}` },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({
        model: "google/gemini-3.1-flash-lite",
        max_tokens: 60,
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
              { type: "text", text: 'Beri SATU nama singkat 3-6 kata bahasa Indonesia untuk foto ini, apa adanya sesuai isinya (mis. "selfie cermin pakai kaos", "pemandangan hutan", "meja kafe sama kopi"). JSON only: {"title":"..."}' },
            ],
          },
        ],
      }),
    });
    const j = await r.json();
    const txt = j.choices?.[0]?.message?.content || "";
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return "";
    const v = JSON.parse(m[0]);
    return String(v.title || "").replace(/["'`]/g, "").slice(0, 80);
  } catch {
    return "";
  }
}

/** Re-read one photo's name from the image. */
export async function retitlePhoto(slug, id) {
  const lib = loadLibrary(slug);
  const p = lib.photos.find((x) => x.id === id);
  if (!p) return { ok: false };
  const t = await titleFor(path.join(libraryDir(slug), p.file));
  if (!t) return { ok: false };
  p.title = t;
  p.titleFixed = true;
  saveLibrary(slug, lib);
  return { ok: true, title: t };
}

/** Re-read names for a batch of photos that have not been fixed yet. */
export async function retitleAll(slug, { limit = 8 } = {}) {
  const lib = loadLibrary(slug);
  const targets = lib.photos.filter((p) => !p.titleFixed).slice(0, limit);
  const results = await Promise.all(targets.map((p) => titleFor(path.join(libraryDir(slug), p.file))));
  let done = 0;
  targets.forEach((p, i) => {
    if (results[i]) {
      p.title = results[i];
      p.titleFixed = true;
      done++;
    }
  });
  saveLibrary(slug, lib);
  const remaining = lib.photos.filter((p) => !p.titleFixed).length;
  return { ok: true, done, remaining };
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
export function pickPhoto({ slug = config.persona, chat = null, moment = null, block = null, persona = null, force = false, request = "", now = new Date() } = {}) {
  const lib = loadLibrary(slug);
  if (!lib.photos.length) return null;
  const who = persona || loadPersona(slug);
  const jid = String(chat?.jid || "");
  const pod = partOfDay(now.getHours());
  const context = `${block?.what || ""} ${block?.place || ""} ${moment?.what || ""} ${moment?.kind || ""} ${request || ""} ${chat?.summary || ""}`.toLowerCase();
  const wanted = topicTagsFor(context);
  // only approved photos, none already sent to this person; when he asks for something specific,
  // the photo has to actually match it (otherwise we return null and a fresh one is made)
  let eligible = lib.photos.filter((p) =>
    p.allowSend !== false &&
    !(jid && (p.sentTo || {})[jid]) &&
    fitsPersonaClass(`${p.scene} ${p.note || ""}`, who, { allowOneStep: true })
  );
  if (force && wanted.length) {
    eligible = eligible.filter((p) => {
      const hay = `${p.title || ""} ${p.caption || ""} ${p.scene || ""} ${p.note || ""}`.toLowerCase();
      return wanted.some((t) => (p.topics || []).includes(t)) || wanted.some((t) => hay.includes(t));
    });
  }
  if (!eligible.length) return null;
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
      const capWords = (p.caption || "").toLowerCase().split(/\W+/).filter((w) => w.length > 3);
      const capHits = capWords.filter((w) => context.includes(w)).length;
      if (capHits) {
        score += Math.min(3, capHits);
        why.push("caption nyambung");
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
/**
 * Should a photo go out with this reply?
 *
 * Hik's rule: the ONLY thing that decides is the contact list. Everything else that used to gate a photo —
 * a daily cap, a twelve-hour gap, a chance roll, allowed hours, a per-conversation cap, a kind filter — is
 * gone. Each of them, at some point, refused a photo he had just asked for, and a photo that does not arrive
 * reads as her saying no.
 *
 * What remains: the feature has to be on, she has to be awake, and the contact has to be allowed.
 */
export function shouldSendPhoto({ chat, moment = null, sleepy = false, force = false, request = "", now = new Date() } = {}) {
  if (!config.photoLibrary || !config.photoSend) return { ok: false, reason: "off" };
  if (sleepy) return { ok: false, reason: "asleep" };
  if (chat?.photoAllowed === false) return { ok: false, reason: "turned off for this contact" };
  if (chat?.photoAllowed !== true && !chat?.trusted) return { ok: false, reason: "not allowed for this contact" };
  const pick = pickPhoto({ chat, moment, force, request, now });
  if (!pick) return { ok: false, reason: "nothing in the library fits her day" };
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
        title: p.title || p.caption || p.scene,
        caption: p.caption || "",
        allowSend: p.allowSend !== false,
        timeOfDay: p.timeOfDay,
        topics: p.topics || [],
        usedCount: p.usedCount || 0,
        lastUsedAt: p.lastUsedAt || 0,
        sentToCount: Object.keys(p.sentTo || {}).length,
      }))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.scene.localeCompare(b.scene)),
  };
}
