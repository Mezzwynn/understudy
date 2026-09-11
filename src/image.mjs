import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { config, DATA_DIR, ROOT, log } from "./config.mjs";

/**
 * image.mjs — generate photos (Gemini image model) and convert images into
 * WhatsApp stickers (512x512 webp via cwebp).
 */

const TMP = path.join(DATA_DIR, "tmp");
const STICKER_DIR = path.join(ROOT, "assets", "stickers");

/** Remember a sticker someone sent us, so she can send it back later. */
export function saveUserSticker(buffer) {
  if (!config.saveUserStickers || !buffer?.length) return null;
  try {
    fs.mkdirSync(STICKER_DIR, { recursive: true });
    const name = `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.webp`;
    const file = path.join(STICKER_DIR, name);
    fs.writeFileSync(file, buffer, { mode: 0o644 });
    try {
      fs.chmodSync(file, 0o644); // WhatsApp media can arrive with odd permissions
    } catch {
      /* ignore */
    }
    // keep the folder from growing forever
    const users = fs
      .readdirSync(STICKER_DIR)
      .filter((f) => f.startsWith("user-") && f.endsWith(".webp"))
      .sort();
    for (const old of users.slice(0, Math.max(0, users.length - config.userStickerKeep))) {
      try {
        fs.rmSync(path.join(STICKER_DIR, old), { force: true });
      } catch {
        /* ignore */
      }
    }
    log(`saved sticker from user → ${name}`);
    return name;
  } catch (err) {
    log(`could not save user sticker: ${err.message}`);
    return null;
  }
}

/** Random sticker from assets/stickers. Prefers ones the user sent, sometimes. */
export function randomSticker() {
  try {
    const all = fs.readdirSync(STICKER_DIR).filter((f) => f.endsWith(".webp"));
    if (!all.length) return null;
    const fromUser = all.filter((f) => f.startsWith("user-"));
    const pool =
      fromUser.length && Math.random() < config.preferUserSticker ? fromUser : all;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    return fs.readFileSync(path.join(STICKER_DIR, pick));
  } catch {
    return null;
  }
}

export async function generateImage(prompt) {
  if (!config.geminiApiKey || !prompt) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.imageModel}:generateContent?key=${config.geminiApiKey}`;
  const body = { contents: [{ parts: [{ text: prompt }] }] };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text);
    const parts = json.candidates?.[0]?.content?.parts || [];
    for (const p of parts) {
      const d = p.inlineData || p.inline_data;
      if (d?.data) {
        return { buffer: Buffer.from(d.data, "base64"), mimetype: d.mimeType || d.mime_type || "image/png" };
      }
    }
    throw new Error("no image in response");
  } catch (err) {
    log(`image gen failed: ${err.message}`);
    return null;
  }
}

/** Convert a generated image into a WhatsApp sticker (512x512 webp). */
export function toSticker(buffer, { quality = 80, size = 512 } = {}) {
  fs.mkdirSync(TMP, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inPath = path.join(TMP, `${stamp}.img`);
  const outPath = path.join(TMP, `${stamp}.webp`);
  try {
    fs.writeFileSync(inPath, buffer);
    const r = spawnSync("cwebp", ["-quiet", "-q", String(quality), "-resize", String(size), String(size), inPath, "-o", outPath], {
      encoding: "utf8",
    });
    if (r.error || r.status !== 0) throw new Error(r.error ? r.error.message : r.stderr || `cwebp exit ${r.status}`);
    return fs.readFileSync(outPath);
  } catch (err) {
    log(`sticker convert failed: ${err.message}`);
    return null;
  } finally {
    try {
      fs.rmSync(inPath, { force: true });
      fs.rmSync(outPath, { force: true });
    } catch {
      /* ignore */
    }
  }
}
