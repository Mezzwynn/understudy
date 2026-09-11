import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { config, DATA_DIR, log } from "./config.mjs";

/**
 * image.mjs — generate photos (Gemini image model) and convert images into
 * WhatsApp stickers (512x512 webp via cwebp).
 */

const TMP = path.join(DATA_DIR, "tmp");

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

/** Random sticker from assets/stickers (if the user dropped any in). */
export function randomSticker() {
  const dir = path.join(DATA_DIR, "..", "assets", "stickers");
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".webp"));
    if (!files.length) return null;
    const pick = files[Math.floor(Math.random() * files.length)];
    return fs.readFileSync(path.join(dir, pick));
  } catch {
    return null;
  }
}
