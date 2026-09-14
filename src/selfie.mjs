/**
 * selfie.mjs — the photos she takes of herself on a schedule, always in the same place.
 *
 * Hik's idea, and it is the right one: a mirror outfit check every morning, always at the same spot —
 * the mirror by her bedroom door — with the outfit, the angle, the light and the mood different every
 * time. The fixed place is what makes it believable: people do photograph themselves in the same corner
 * of their room over and over, and the sameness is the proof rather than a flaw. What must never repeat
 * is the outfit, the pose, the framing, the hour's light.
 *
 * The face is the hard part everywhere else in this project; a mirror selfie is the one format where it
 * matters least, because the phone covers part of it and the angle is whatever it is.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, config, log } from "./config.mjs";
import { generateImage, writeImage, imageEngineReady } from "./image-engine.mjs";
import { humanize } from "./humanize.mjs";
import { loadWardrobe, timeBucket, pickOutfit } from "./photos.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
import { avatarPath } from "./face.mjs";
import { addPhoto, markSent, photoHistory } from "./photo-library.mjs";

const stateFile = (slug) => path.join(DATA_DIR, "photos", `selfie-${String(slug || config.persona).replace(/[^\w.-]/g, "")}.json`);

function loadState(slug) {
  try {
    return { sent: {}, ...JSON.parse(fs.readFileSync(stateFile(slug), "utf8")) };
  } catch {
    return { sent: {} };
  }
}
const saveState = (slug, st) => fs.writeFileSync(stateFile(slug), JSON.stringify(st, null, 2));

/** The angle, the light and the mood rotate; the place never moves. */
const ANGLES = [
  "the phone held low at chest height, tilted slightly up",
  "the phone held at chin height, a little crooked",
  "arm raised, the phone a bit high and tilted down",
  "holding the phone sideways in one hand, head turned a quarter away",
  "phone held close, the top of her head cut off by the frame",
  "phone resting on the shelf, angled at her from the side",
];
const LIGHT = [
  "the room light on, warm and slightly yellow",
  "only the window light, flat and grey",
  "a lamp on one side, half her face in shadow",
  "bright ceiling light, unflattering and honest",
  "dim, as if she did not bother turning anything on",
];
const MOOD = [
  "flat, unimpressed, no expression",
  "tired eyes, half a sigh",
  "in a hurry, mid-movement, slightly blurred",
  "a small dry half-smile, the closest she gets",
  "annoyed at something she is looking at on the screen",
  "caught between two thoughts, eyes on the mirror not the lens",
];
const FRAMING = [
  "waist up, the outfit readable",
  "shoulders down, the whole shirt visible",
  "mostly the outfit, her chin just at the top of the frame",
  "close, the fabric and the mirror edge filling the frame",
];

/** What she is checking, why this photo exists. */
const REASONS = [
  "outfit check before leaving",
  "trying the shirt on, deciding",
  "one photo to see if the colours work",
  "quick check before she goes out",
];

const pickR = (list, seed) => list[Math.abs(seed) % list.length];

/** The outfit of the last selfie, so the next one is not the same shirt. */
function lastOutfit(slug) {
  try {
    return String(loadState(slug).lastOutfit || "");
  } catch {
    return "";
  }
}

/**
 * The prompt. The spot comes from the character (bedroom mirror by the door by default) and is the same
 * every time; everything else is drawn from the lists above by day, so two selfies never look alike.
 */
export function selfiePrompt(persona, { day = null, outfit = null, style = "casual", why = "", slug: slugIn = null } = {}) {
  const slug = slugIn || persona?.slug || config.persona;
  const d = day || new Date();
  const seed = d.getFullYear() * 372 + (d.getMonth() + 1) * 31 + d.getDate();
  // the card carries it as mirror_spot (snake_case, like every other frontmatter key)
  const spot = String(persona?.mirror_spot || persona?.mirrorSpot || config.selfieSpot || "the full-length mirror on the inside of her bedroom door");
  const wear = outfit || pickOutfit(persona, { hour: d.getHours(), style: style || "casual", avoid: lastOutfit(slug) });
  const who = `${persona?.name || "a young woman"}, ${String(persona?.appearance || "slim, 20, shoulder-length black hair, minimal monochrome clothes").slice(0, 160)}`;
  return [
    `Keep the same woman as the reference photo — the same face and hair. Do not change her face.`,
    `New photo: a mirror selfie she took with her phone${why ? `, ${why}` : ""}.`,
    `PLACE (always exactly this, it never changes): ${spot}, a plain wall behind her, the edge of her room visible — same corner of the same room as every other mirror photo she has taken.`,
    `She is wearing ${wear}.`,
    `${pickR(FRAMING, seed + 1)}, ${pickR(ANGLES, seed + 2)}, ${pickR(LIGHT, seed + 3)}.`,
    `Her face: ${pickR(MOOD, seed + 4)} — and the phone partly covers her face or her eyes are on the screen, the way a mirror selfie actually looks.`,
    `Ordinary and unpolished: the mirror has a smudge, the room behind is lived in, the framing is not quite straight. Not a photoshoot, not a studio, no filter. No text, no watermark.`,
  ].join(" ");
}

/**
 * When a mirror selfie makes sense today, taken from her own routine rather than a fixed clock.
 * A person photographs themselves before going out, after training, or when they have just put something
 * on — not at 07:30 because a config says so. Each routine moment that suggests it carries the style she
 * would be wearing for it, so the outfit follows the day.
 */
const SELFIE_MOMENT = [
  { re: /(keluar|berangkat|pergi|leave|heading out|off to|ke kantor|ke kampus)/i, style: "kerja", why: "before heading out" },
  { re: /(pilates|gym|olahraga|lari|run|workout|training)/i, style: "fitness", why: "after training" },
  { re: /(mandi|shower|ganti|beres-beres|dandan|get ready)/i, style: "casual", why: "just got changed" },
  { re: /(brunch|kafe|cafe|makan malam|dinner|nongkrong|ketemu|meet)/i, style: "casual", why: "before going out to eat" },
];

export function selfieMoments(slug = config.persona, now = new Date()) {
  try {
    const { loadRoutine } = require("./routine.mjs");
    const routine = loadRoutine(slug);
    if (!routine || routine.date !== now.toISOString().slice(0, 10)) return [];
    const found = [];
    for (const b of routine.blocks || []) {
      for (const m of SELFIE_MOMENT) {
        if (m.re.test(String(b.what || ""))) found.push({ at: b.start, style: m.style, why: m.why, from: b.what });
      }
    }
    for (const mo of routine.moments || []) {
      for (const m of SELFIE_MOMENT) {
        if (m.re.test(String(mo.what || ""))) found.push({ at: mo.at, style: m.style, why: m.why, from: mo.what });
      }
    }
    return found.sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(0, 3);
  } catch {
    return [];
  }
}

/** A scheduled moment that has come round and not been photographed yet. */
export function dueSelfie(slug = config.persona, now = new Date()) {
  if (!config.selfieEnabled) return null;
  const today = now.toISOString().slice(0, 10);
  const st = loadState(slug);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  // a cap, because her routine mentions food three times a day and three mirror selfies a day is a habit
  const sentToday = Object.keys(st.sent || {}).filter((k) => k.startsWith(today)).length;
  if (sentToday >= Number(config.selfieMaxPerDay || 2)) return null;
  for (const m of selfieMoments(slug, now)) {
    const [h, mi] = String(m.at).split(":").map(Number);
    if (Number.isNaN(h)) continue;
    const at = h * 60 + (mi || 0);
    const key = `${today} ${m.at}`;
    // within a 90 minute window, so a restart still catches up
    if (nowMin >= at && nowMin - at <= 90 && !st.sent[key]) return { time: m.at, key, style: m.style, why: m.why, from: m.from };
  }
  // a fallback so a day with no matching moment still gets one selfie, not none
  const fallback = String(config.selfieSchedule || "").split(",").map((t) => t.trim()).filter(Boolean);
  for (const t of fallback) {
    const [h, mi] = t.split(":").map(Number);
    if (Number.isNaN(h)) continue;
    const at = h * 60 + (mi || 0);
    const key = `${today} ${t}`;
    if (nowMin >= at && nowMin - at <= 90 && !st.sent[key]) return { time: t, key, style: "casual", why: "outfit check" };
  }
  return null;
}

export function markSelfieSent(slug, key) {
  const st = loadState(slug);
  st.sent[key] = Date.now();
  // keep the file small: only yesterday onwards matter
  const keep = Object.fromEntries(Object.entries(st.sent).slice(-12));
  saveState(slug, { ...st, sent: keep });
}

/**
 * Make one and file it in the library. The photo is generated fresh, then humanised like everything else
 * and added with the mirror spot as its scene, so it can be sent again later and rated like the rest.
 */
export async function makeSelfie(persona, { slug = null, day = null, style = "casual", why = "", outfit = "" } = {}) {
  const s = slug || persona?.slug || config.persona;
  if (!imageEngineReady()) return { ok: false, error: "no image engine configured" };
  const ref = avatarPath(s);
  const prompt = selfiePrompt(persona, { day, style, why, outfit: outfit || null, slug: s });
  const res = await generateImage({
    model: config.editModel,
    prompt,
    aspect: "3:4",
    images: ref && fs.existsSync(ref) ? [`data:image/jpeg;base64,${fs.readFileSync(ref).toString("base64")}`] : [],
  });
  if (!res.ok) return { ok: false, error: res.error };
  const tmp = writeImage(path.join(DATA_DIR, "photos", `selfie-tmp-${Date.now()}`), res.buf);
  const small = humanize(fs.readFileSync(tmp), { profile: config.photoPhone, maxSide: config.photoMaxSide, quality: config.photoQuality });
  const final = path.join(DATA_DIR, "photos", `selfie-${Date.now()}.jpg`);
  fs.writeFileSync(final, small.buf);
  fs.rmSync(tmp, { force: true });
  const added = addPhoto(s, final, {
    scene: `selfie-cermin-${new Date().toISOString().slice(0, 10)}`,
    note: "mirror selfie, same spot as always",
    kind: "self",
    hour: new Date().getHours(),
    topics: "cermin,outfit,selfie",
  });
  fs.rmSync(final, { force: true });
  const hour = new Date().getHours();
  // remember what she was wearing so the next selfie differs
  const st = loadState(s);
  const wearLine = (prompt.match(/She is wearing ([^.]+)\./) || [])[1] || "";
  saveState(s, { ...st, lastOutfit: wearLine });
  log(`selfie: ${res.seconds}s, $${(res.price || 0).toFixed(3)} — pakai "${String(wearLine).slice(0, 40)}" → ${added.ok ? added.photo.id : "gagal simpan"}`);
  return { ok: true, photo: added.photo, seconds: res.seconds, price: res.price, bucket: timeBucket(hour) };
}

/** Used by the panel: what is scheduled and what the spot is. */
export const selfieSettings = (persona = null) => ({
  enabled: !!config.selfieEnabled,
  schedule: String(config.selfieSchedule || ""),
  spot: String(persona?.mirror_spot || persona?.mirrorSpot || config.selfieSpot || ""),
  maxPerDay: Number(config.selfieMaxPerDay || 2),
  sent: loadState(persona?.slug || config.persona).sent,
});
