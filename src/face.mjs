/**
 * face.mjs — her face, kept in one place.
 *
 * What the tests showed: a single generated photo already reads as real (9.5/10), but identity
 * does not survive generation — a reference photo scored 2/10, a written description 4/10, and
 * an editing model given the reference 4/10 as well. So the face is not something to generate on
 * a whim: it is chosen once, saved, and then reused.
 *
 * This module holds that choice:
 *   data/photos/<slug>/avatar.jpg      what WhatsApp shows as her profile picture
 *   data/photos/<slug>/face.json       the face bible: the approved look, the reference image
 *                                      for any future generation, and what was rejected
 *   data/photos/<slug>/candidates/     the shots waiting to be judged
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, config, log } from "./config.mjs";
import { generateImage, writeImage, imageEngineReady } from "./image-engine.mjs";

const slugOf = (slug) => String(slug || config.persona || "character").replace(/[^\w.-]/g, "");

export function faceDir(slug) {
  const d = path.join(DATA_DIR, "photos", slugOf(slug));
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

export const faceFile = (slug) => path.join(faceDir(slug), "face.json");

export function loadFace(slug) {
  try {
    return { slug: slugOf(slug), avatar: "", reference: "", approved: [], rejected: [], updatedAt: 0, ...JSON.parse(fs.readFileSync(faceFile(slug), "utf8")) };
  } catch {
    return { slug: slugOf(slug), avatar: "", reference: "", approved: [], rejected: [], updatedAt: 0 };
  }
}

export function saveFace(slug, face) {
  const clean = {
    slug: slugOf(slug),
    avatar: String(face.avatar || ""),
    reference: String(face.reference || ""),
    approved: (face.approved || []).slice(-40),
    rejected: (face.rejected || []).slice(-40),
    prompt: String(face.prompt || "").slice(0, 2000),
    updatedAt: Date.now(),
  };
  fs.writeFileSync(faceFile(slug), JSON.stringify(clean, null, 2));
  return clean;
}

export const candidatesDir = (slug) => {
  const d = path.join(faceDir(slug), "candidates");
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
};

export function listCandidates(slug) {
  const d = candidatesDir(slug);
  return fs
    .readdirSync(d)
    .filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
    .map((f) => ({ file: f, at: fs.statSync(path.join(d, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
    .slice(0, 24);
}

export const avatarPath = (slug) => {
  for (const ext of ["jpg", "jpeg", "png"]) {
    const f = path.join(faceDir(slug), `avatar.${ext}`);
    if (fs.existsSync(f)) return f;
  }
  return "";
};

/**
 * How she looks, written as a prompt. Taken from her own card first: the card is the character,
 * and a face that contradicts it is worse than no photo at all.
 */
export function facePrompt(persona) {
  const card = String(persona?.card || "");
  const look =
    (card.match(/^appearance:\s*(.+)$/im) || [])[1] ||
    `a 20-year-old Indonesian woman from Denpasar, shoulder-length straight black hair, minimal monochrome clothing, flat unexpressive face`;
  return [
    `A candid front-camera selfie taken on a phone by ${persona?.name || "a young woman"} — ${look}.`,
    `No makeup, visible skin texture and pores, a small natural mole, slightly tired eyes, no smile.`,
    `Indoor daylight from a window, an ordinary lived-in room behind her, mildly noisy phone sensor,`,
    `slightly crooked framing, imperfect and unposed. A real snapshot sent to a friend on WhatsApp,`,
    `not a produced photo, not a studio portrait. No text, no watermark, no filters.`,
  ].join(" ");
}

/** Generate a batch of face candidates for Hik to judge. Costs config.photoCandidateCount images. */
export async function generateCandidates(persona, { count = null, slug = null } = {}) {
  const n = Math.max(1, Math.min(8, Number(count) || Number(config.photoCandidateCount) || 4));
  const model = config.faceModel;
  if (!imageEngineReady()) return { ok: false, error: "no image engine configured (ATLAS_API_KEY missing)" };
  const prompt = facePrompt(persona);
  const made = [];
  const errors = [];
  for (let i = 0; i < n; i++) {
    const res = await generateImage({ model, prompt, aspect: "1:1" });
    if (!res.ok) {
      errors.push(res.error);
      continue;
    }
    const file = writeImage(path.join(candidatesDir(slug), `cand-${Date.now()}-${i}`), res.buf);
    made.push({ file: path.basename(file), price: res.price, seconds: res.seconds });
  }
  if (made.length) {
    const face = loadFace(slug);
    saveFace(slug, { ...face, prompt, candidates: undefined });
    log(`face: ${made.length}/${n} candidate(s) for ${slugOf(slug)} with ${model}`);
  }
  return { ok: made.length > 0, made, errors, prompt, model };
}

/** Approve a candidate: it becomes her avatar and the reference for any future generation. */
export async function approveCandidate(slug, file, sock = null) {
  const src = path.join(candidatesDir(slug), path.basename(String(file || "")));
  if (!fs.existsSync(src)) return { ok: false, error: "that candidate is no longer there" };
  const face = loadFace(slug);
  const ext = path.extname(src).slice(1).toLowerCase();
  const avatar = path.join(faceDir(slug), `avatar.${ext}`);
  for (const old of ["jpg", "jpeg", "png"]) fs.rmSync(path.join(faceDir(slug), `avatar.${old}`), { force: true });
  fs.copyFileSync(src, avatar);
  const saved = saveFace(slug, { ...face, avatar, reference: avatar, approved: [...face.approved, { file: path.basename(src), at: Date.now() }] });
  let whatsapp = { ok: false, error: "WhatsApp is not connected" };
  if (sock) whatsapp = await pushAvatar(sock, avatar);
  return { ok: true, face: saved, avatar, whatsapp };
}

/** Set the picture on WhatsApp itself, so contacts see it too. */
export async function pushAvatar(sock, file) {
  try {
    const jid = sock?.user?.id;
    if (!jid) return { ok: false, error: "no logged-in account" };
    if (!fs.existsSync(file)) return { ok: false, error: "no avatar file yet" };
    await sock.updateProfilePicture(jid, fs.readFileSync(file));
    log(`face: profile picture updated from ${path.basename(file)}`);
    return { ok: true, jid: String(jid).split(":")[0] };
  } catch (err) {
    log(`face: profile picture failed — ${err.message}`);
    return { ok: false, error: err.message.slice(0, 160) };
  }
}

/** What WhatsApp currently shows, if it can be read. */
export async function currentAvatarUrl(sock) {
  try {
    const jid = sock?.user?.id;
    if (!jid) return "";
    return (await sock.profilePictureUrl(jid, "image")) || "";
  } catch {
    return "";
  }
}

export function rejectCandidate(slug, file) {
  const src = path.join(candidatesDir(slug), path.basename(String(file || "")));
  if (!fs.existsSync(src)) return { ok: false, error: "not found" };
  const face = loadFace(slug);
  const dest = path.join(faceDir(slug), `rejected-${path.basename(src)}`);
  fs.renameSync(src, dest);
  saveFace(slug, { ...face, rejected: [...face.rejected, { file: path.basename(dest), at: Date.now() }] });
  return { ok: true };
}

/** The face bible as a prompt block, for anything else that wants to draw her later. */
export function facePromptBlock(slug = config.persona) {
  const face = loadFace(slug);
  if (!face.avatar) return "";
  return [
    "HER FACE (fixed — she is the same person in every photo):",
    face.prompt ? `look: ${face.prompt.slice(0, 400)}` : "",
    face.reference ? "a reference image of her is on file; keep the same person when generating" : "",
    "A new photo of her is not something to invent lightly: identity does not survive generation.",
  ]
    .filter(Boolean)
    .join("\n");
}
