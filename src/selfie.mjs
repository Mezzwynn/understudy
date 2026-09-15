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
import { loadWardrobe, timeBucket, pickOutfit, pickOutfitItem, findWardrobeItem } from "./photos.mjs";
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

/** A local file as a data URL, so a reference picture can be sent without publishing it first. */
const MIME_BY_EXT = { png: "image/png", webp: "image/webp", gif: "image/gif" };
function dataUrl(file) {
  const ext = path.extname(String(file)).slice(1).toLowerCase();
  return `data:${MIME_BY_EXT[ext] || "image/jpeg"};base64,${fs.readFileSync(file).toString("base64")}`;
}

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
/** Her expression in a selfie — the panel exposes this as a dropdown; "auto" rotates. */
const EXPRESSIONS = {
  flat: { label: "flat — datar", text: "flat and unimpressed, no expression at all" },
  tired: { label: "capek", text: "tired eyes, half a sigh" },
  hurry: { label: "buru-buru", text: "in a hurry, mid-movement, slightly blurred" },
  halfsmile: { label: "senyum tipis", text: "a small dry half-smile, the closest she gets" },
  annoyed: { label: "kesel", text: "annoyed at something she is looking at on the screen" },
  distant: { label: "melamun", text: "caught between two thoughts, eyes on the mirror not the lens" },
  smirk: { label: "nyengir", text: "the corner of her mouth pulled up just barely, almost a smirk" },
  soft: { label: "lembut", text: "soft for a second, not fully hiding that she is pleased" },
  laugh: { label: "ketawa", text: "a short real laugh, caught before she could stop it" },
  amused: { label: "angkat alis", text: "one eyebrow raised, amused at her own reflection" },
};
const MOOD_TEXTS = Object.values(EXPRESSIONS).map((e) => e.text);

/** How much of her face is visible in a mirror selfie — the panel exposes this as full | half | hide. */
const FACE_LINES = (mood) => ({
  full: {
    hold: `One arm is bent up and her hand is clearly holding the phone, but the phone is held lower, beside her cheek or at chest height, so it does NOT cover her face — the hand and the phone stay visible in the mirror.`,
    face: `Her whole face is visible and clear. Her expression: ${mood}. She is looking at the lens or at the screen, not posing for the mirror.`,
  },
  half: {
    hold: `One arm is bent up and her hand is clearly holding the phone in front of her — the hand and the phone are both visible in the mirror, fingers wrapped around the phone.`,
    face: `Her face is HALF HIDDEN by the phone: it covers one half of her face, so only one eye, half her nose and half her mouth are visible and the other side is behind the phone. Her expression on the visible half: ${mood}. She is looking at the phone or past it, not posing for the mirror.`,
  },
  hide: {
    hold: `One arm is bent up and her hand is clearly holding the phone up in front of her face — the hand and the phone are both visible in the mirror, fingers wrapped around the phone.`,
    face: `Her face is FULLY HIDDEN behind the phone: the phone covers her whole face in the mirror, so no eyes, no nose and no mouth are visible — at most a little hair or her forehead above the top edge. Her hand gripping the phone is clearly visible.`,
  },
});

/** Front-camera "pap" selfie (no mirror): the face rules read differently when she is the one
 *  holding the lens at arm's length and there is no reflection. */
const PAP_FACE = (mood) => ({
  full: `Her whole face is visible and clear, close to the camera. Her expression: ${mood}. She is looking into the lens.`,
  half: `Only half of her face is in the frame — the edge of the photo cuts across her face, so one eye and half her mouth are visible. Her expression on the visible half: ${mood}.`,
  hide: `Her face is NOT in the frame at all — the photo is from the neck down or she is turned away, so no eyes, no nose and no mouth are visible. One of her hands may be in the frame (holding or pointing at the thing in the scene), but the hand holding the camera is never visible.`,
});

/** A front-camera selfie must look like SHE is holding the lens, never like a third person took it. */
const PAP_RULES = `She took this photo HERSELF, one arm stretched toward the lens — it must NOT look like someone else photographed her: she is seen from the FRONT and CLOSE, the background directly behind her, a slight foreshortening on the arm holding the phone. NOT a full-body shot from a distance, NOT from across the room, NOT posed for a photographer, no second person. The phone, the screen, the lens and the hand holding the camera are NEVER visible — at most one free hand may be in the frame if the pose or the scene calls for it. No mirror reflection. Slightly crooked framing, mild sensor noise, caught mid-movement, not a produced or staged photo. No text, no watermark.`;
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

/** How she stands/holds herself — each pose belongs to one shot type, or to both.
 *  `type` mirrors the SELFIE_TYPE: mirror poses need the reflection, pap poses are face gestures. */
const POSE_DEFS = {
  natural: { type: "both", label: "natural — santai", text: "standing relaxed with her weight on one leg, a normal quick check, not posing at all" },
  peace: { type: "pap", label: "peace — dua jari", text: "holding up a small deadpan peace sign with her free hand, like she is half-mocking the gesture" },
  hip: { type: "both", label: "tangan di pinggang", text: "one hand on her hip, elbow out, looking a little impatient" },
  hair: { type: "both", label: "rapiin rambut", text: "her free hand touching her hair or tucking a strand behind her ear, caught mid-motion" },
  sit: { type: "both", label: "duduk", text: "sitting on the edge of her bed, phone held up" },
  shoulder: { type: "mirror", label: "noleh ke belakang (cermin)", text: "turned a little to the side, looking back over her shoulder at the mirror" },
  lean: { type: "both", label: "bersandar tembok", text: "leaning her shoulder against the wall, phone held up, relaxed" },
  back: { type: "mirror", label: "dari belakang (cermin)", text: "her back turned to the mirror, head turned a little so only her profile shows, showing the outfit from behind" },
  crouch: { type: "mirror", label: "jongkok (cermin)", text: "crouching low in front of the mirror, phone held up, like she is fixing her shoe or checking the hem" },
  coffee: { type: "both", label: "pegang kopi", text: "holding a mug of iced coffee in her free hand, phone up in the other" },
  stretch: { type: "both", label: "stretching", text: "one arm stretched up overhead, caught mid-stretch, eyes half closed" },
  scroll: { type: "pap", label: "main hp (scroll)", text: "eyes down on the screen, her thumb scrolling, not paying attention to the camera at all" },
  tongue: { type: "pap", label: "melet", text: "sticking the tip of her tongue out a little, teasing, almost a smirk" },
  laugh: { type: "both", label: "ketawa", text: "caught mid-laugh, eyes squeezed, the phone slightly tilted" },
  wink: { type: "pap", label: "kedip", text: "one eye closed in a small wink, deadpan otherwise" },
  bag: { type: "both", label: "bawa tas", text: "a small bag hanging on her arm, about to leave, one last quick check" },
  hem: { type: "mirror", label: "cek hem (cermin)", text: "bent forward a little, checking the hem or her shoes in the mirror, phone held low" },
  floor: { type: "both", label: "duduk lesehan", text: "sitting cross-legged on the floor, phone held up" },
};

/**
 * The prompt. The spot comes from the character (bedroom mirror by the door by default) and is the same
 * every time; everything else is drawn from the lists above by day, so two selfies never look alike.
 */
export function selfiePrompt(persona, { day = null, outfit = null, outfitItem = null, outfitRef = false, spotRef = false, faceMode = null, poseMode = null, typeMode = null, expressionMode = null, scene = null, style = "casual", why = "", slug: slugIn = null } = {}) {
  const slug = slugIn || persona?.slug || config.persona;
  const d = day || new Date();
  // Vary per shot, not per day: with a day-only seed every selfie on the same day shared the same
  // expression, angle, framing and light, which is the opposite of how mirror selfies actually look.
  const seed = d.getFullYear() * 372 + (d.getMonth() + 1) * 31 + d.getDate() + Math.floor(Math.random() * 100000);
  // the card carries it as mirror_spot (snake_case, like every other frontmatter key)
  const spot = String(persona?.mirror_spot || persona?.mirrorSpot || config.selfieSpot || "the full-length mirror on the inside of her bedroom door");
  // the default spot describes a mirror; if Hik overrides it (e.g. "Park"), use that as the real place
  const spotLooksMirror = /mirror|cermin/i.test(spot);
  // the panel can write WHY this photo exists ("nemu bunga di taman") — it becomes the scene in the image
  const sceneText = String(scene || config.selfieWhy || "").trim();
  const item = outfitItem || null;
  const wear = item?.name || outfit || pickOutfit(persona, { hour: d.getHours(), style: style || "casual", avoid: lastOutfit(slug) });
  // a bare name gives the model nothing to match; the wardrobe entry carries what the garment really looks like
  const garment = item?.description ? ` The garment: ${item.description}` : "";
  // when the panel attaches the room and the garment as pictures, the model only has to move the camera
  const refs = ["Image 1 is her face — keep it exactly and do not change her."];
  let n = 2;
  if (outfitRef) refs.push(`Image ${n++} is the outfit she must wear: put that exact garment on her, matching its fabric, colour, cut and pattern.`);
  if (spotRef) refs.push(`Image ${n++} is the place: reproduce that exact room, wall, mirror and objects in the same layout every time — only the camera angle, framing and light change.`);
  const who = `${persona?.name || "a young woman"}, ${String(persona?.appearance || "slim, 20, shoulder-length black hair, minimal monochrome clothes").slice(0, 160)}`;
  const moodKey = String(expressionMode || config.selfieExpression || "auto").toLowerCase();
  const mood = EXPRESSIONS[moodKey]?.text || pickR(MOOD_TEXTS, seed + 4);
  const mode = String(faceMode || config.selfieFace || "half").toLowerCase();
  const fm = FACE_LINES(mood)[mode] || FACE_LINES(mood).half;
  const isPap = String(typeMode || config.selfieType || "mirror").toLowerCase() === "pap";
  const poseKey = String(poseMode || config.selfiePose || "auto").toLowerCase();
  const poseDef = POSE_DEFS[poseKey];
  const pose = poseDef && (poseDef.type === "both" || poseDef.type === (isPap ? "pap" : "mirror")) ? poseDef.text : null;
  if (isPap) {
    const pf = PAP_FACE(mood)[mode] || PAP_FACE(mood).half;
    return [
      refs.length > 1 ? refs.join(" ") : `Keep the same woman as the reference photo — the same face and hair. Do not change her face.`,
      `New photo: a front-camera selfie she took HERSELF at arm's length with her phone${why ? `, ${why}` : ""}.`,
      `PLACE: ${spotLooksMirror ? "an ordinary lived-in room directly behind her — a plain wall, a bit of her bed or a desk, not tidy, not staged" : spot}.`,
      `She is wearing ${wear}.${garment}`,
      pose ? `Pose: ${pose}.` : `${pickR(FRAMING, seed + 1)}, ${pickR(LIGHT, seed + 3)}.`,
      pf,
      ...(sceneText ? [`This photo is about: ${sceneText}. Include that in the frame — the object, the place, the moment she is showing.`] : []),
      PAP_RULES,
    ].join(" ");
  }
  return [
    refs.length > 1 ? refs.join(" ") : `Keep the same woman as the reference photo — the same face and hair. Do not change her face.`,
    `New photo: a mirror selfie she took with her phone${why ? `, ${why}` : ""}. ${fm.hold}`,
    spotRef
      ? `PLACE: exactly the place in the reference image — the same spot, background and objects every time; it never changes between photos.`
      : `PLACE (always exactly this, it never changes): ${spot}. The same place in every photo — only the camera angle, framing, light and expression change.`,
    `She is wearing ${wear}.${garment}`,
    pose
      ? `${pickR(ANGLES, seed + 2)}, ${pickR(LIGHT, seed + 3)}. Pose: ${pose}.`
      : `${pickR(FRAMING, seed + 1)}, ${pickR(ANGLES, seed + 2)}, ${pickR(LIGHT, seed + 3)}.`,
    fm.face,
    ...(sceneText ? [`This photo is about: ${sceneText}. Include that in the frame — the object, the place, the moment she is showing.`] : []),
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
  const hour = new Date().getHours();
  // the panel can lock one outfit (SELFIE_OUTFIT); otherwise the wardrobe rotates for this hour and style
  const wanted = String(outfit || config.selfieOutfit || "").trim();
  const item = wanted ? findWardrobeItem(s, wanted) : pickOutfitItem(persona, { hour, style, avoid: lastOutfit(s) });
  const wear = item?.name || wanted || null;
  const ref = avatarPath(s);
  const images = [];
  if (ref && fs.existsSync(ref)) images.push(dataUrl(ref));
  // attach the garment picture too, but only when her face is already attached: the prompt names them in order
  const outfitRef = item?.image && images.length && fs.existsSync(item.image);
  if (outfitRef) images.push(dataUrl(item.image));
  // the same room every time, when the panel attached a picture of it: then only the camera moves
  const isPapShot = String(config.selfieType || "mirror").toLowerCase() === "pap";
  const spotFile = String(persona?.mirror_spot_image || "");
  const spotRef = !isPapShot && spotFile && images.length && fs.existsSync(spotFile);
  if (spotRef) images.push(dataUrl(spotFile));
  const prompt = selfiePrompt(persona, { day, style, why, outfit: wear, outfitItem: item, outfitRef: !!outfitRef, spotRef: !!spotRef, slug: s });
  let res = await generateImage({
    model: config.editModel,
    prompt,
    aspect: "3:4",
    images,
  });
  // some garment references trip the model's safety filter (e.g. sleepwear + her face). The outfit
  // is still described in words, so retry with just her face instead of failing the whole selfie.
  if (!res.ok && /no image|content filter|content_filter/i.test(String(res.error || "")) && images.length > 1) {
    log(`selfie: ${res.error} with ${images.length} references — retrying with face only`);
    const faceOnly = images.slice(0, 1);
    const prompt2 = selfiePrompt(persona, { day, style, why, outfit: wear, outfitItem: item, outfitRef: false, spotRef: false, slug: s });
    res = await generateImage({ model: config.editModel, prompt: prompt2, aspect: "3:4", images: faceOnly });
  }
  if (!res.ok) return { ok: false, error: res.error };
  const tmp = writeImage(path.join(DATA_DIR, "photos", `selfie-tmp-${Date.now()}`), res.buf);
  const small = humanize(fs.readFileSync(tmp), {
    profile: config.photoPhone,
    maxSide: config.photoMaxSide,
    quality: config.photoQuality,
    // -1 means "whatever this phone profile does"
    grain: Number(config.photoGrain) < 0 ? null : Number(config.photoGrain),
    bloom: Number(config.photoBloom) < 0 ? null : Number(config.photoBloom),
  });
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
  // remember what she was wearing so the next selfie differs
  const st = loadState(s);
  const wearLine = (prompt.match(/She is wearing ([^.]+)\./) || [])[1] || wear || "";
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
  outfit: String(config.selfieOutfit || ""),
  face: String(config.selfieFace || "half"),
  pose: String(config.selfiePose || "auto"),
  type: String(config.selfieType || "mirror"),
  poses: [{ value: "auto", label: "auto (rotasi)", type: "both" }, ...Object.entries(POSE_DEFS).map(([value, d]) => ({ value, label: d.label, type: d.type }))],
  expression: String(config.selfieExpression || "auto"),
  expressions: [{ value: "auto", label: "auto (rotasi)" }, ...Object.entries(EXPRESSIONS).map(([value, d]) => ({ value, label: d.label }))],
  why: String(config.selfieWhy || ""),
  spotImage: persona?.mirror_spot_image ? "/spot" : "",
  sent: loadState(persona?.slug || config.persona).sent,
});

/** One short reason why she is sending this photo, written from her routine at this moment. */
export async function generateSelfieReason(persona) {
  try {
    const { loadRoutine, currentBlock } = await import("./routine.mjs");
    const routine = loadRoutine(persona?.slug || config.persona);
    const block = currentBlock(routine, new Date());
    const what = String(block?.what || routine?.blocks?.[0]?.what || "").trim();
    const name = persona?.name || "she";
    const { chat } = await import("./llm.mjs");
    const raw = await chat(
      [
        {
          role: "system",
          content: "Kamu nulis SATU baris alasan informal bahasa Indonesia (maks 12 kata, tanpa kutipan, tanpa emoji) kenapa dia ngirim selfie/pap sekarang. Contoh: 'nemu bunga cantik di taman pas jogging, mau nunjukin ke kamu', 'beli matcha pas jalan pulang', 'lagi makan di resto, kamu minta foto'. Kalau kegiatannya kosong, tulis sesuatu generik seperti 'pap aja buat kamu'.",
        },
        { role: "user", content: `Karakter: ${name}. Kegiatan sekarang: ${what || "(tidak diketahui)"}.` },
      ],
      { temperature: 0.9, maxTokens: 60 },
    );
    const line = String(raw || "").replace(/["'`]/g, "").split("\n")[0].trim().slice(0, 140);
    return line || "";
  } catch (err) {
    log(`selfie reason failed: ${err.message}`);
    return "";
  }
}
