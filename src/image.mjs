import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { config, DATA_DIR, ROOT, envGet, log } from "./config.mjs";

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
    const preferred =
      fromUser.length && Math.random() < config.preferUserSticker ? fromUser : all;
    // some files can be unreadable (owned by another app) — try a few, not just one
    const pool = [...preferred].sort(() => Math.random() - 0.5);
    const fallback = [...all].sort(() => Math.random() - 0.5);
    for (const name of [...pool, ...fallback]) {
      try {
        return fs.readFileSync(path.join(STICKER_DIR, name));
      } catch {
        /* unreadable — try the next one */
      }
    }
    log("no readable sticker in assets/stickers (fix with: rp stickers sync)");
    return null;
  } catch {
    return null;
  }
}

/** Which stickers can we actually read? (used by doctor / sticker sync) */
export function readableStickers() {
  try {
    return fs
      .readdirSync(STICKER_DIR)
      .filter((f) => f.endsWith(".webp"))
      .filter((f) => {
        try {
          fs.accessSync(path.join(STICKER_DIR, f), fs.constants.R_OK);
          return true;
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/**
 * Import stickers from the WhatsApp sticker folder into our own folder,
 * with permissions we can read (files copied by another app are often not).
 */
export function syncStickers(sourceDirs = []) {
  const candidates = [
    ...sourceDirs,
    envGet("STICKER_SOURCE", ""),
    "/sdcard/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Stickers",
    "/sdcard/Download",
  ].filter(Boolean);
  fs.mkdirSync(STICKER_DIR, { recursive: true });
  let copied = 0;
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".webp"));
    } catch {
      continue;
    }
    for (const f of files) {
      const target = path.join(STICKER_DIR, `imp-${f.replace(/[^\w.\-]+/g, "_")}`);
      if (fs.existsSync(target)) continue;
      try {
        const buf = fs.readFileSync(path.join(dir, f));
        fs.writeFileSync(target, buf, { mode: 0o644 });
        copied++;
      } catch {
        /* skip unreadable */
      }
    }
  }
  return copied;
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
