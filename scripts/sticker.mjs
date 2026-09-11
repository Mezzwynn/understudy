#!/usr/bin/env node
/**
 * sticker.mjs — build WhatsApp stickers from images.
 *
 *   node scripts/sticker.mjs <image.png|jpg> [name]
 *   node scripts/sticker.mjs --generate "kucing lucu pakai topi" [name]
 *
 * Stickers are saved to assets/stickers/*.webp and sent at random by the bot
 * (STICKER_CHANCE). Requires cwebp (pkg install libwebp).
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config.mjs";
import { generateImage, toSticker } from "../src/image.mjs";

const args = process.argv.slice(2);
const genIdx = args.indexOf("--generate");
const dir = path.join(ROOT, "assets", "stickers");
fs.mkdirSync(dir, { recursive: true });

async function save(buffer, name) {
  const webp = toSticker(buffer);
  if (!webp) {
    console.error("conversion failed (is cwebp installed?)");
    process.exit(1);
  }
  const slug = (name || `sticker-${Date.now()}`).replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
  const out = path.join(dir, `${slug}.webp`);
  fs.writeFileSync(out, webp);
  console.log(`saved: ${out} (${(webp.length / 1024).toFixed(0)} kb)`);
}

if (genIdx >= 0) {
  const prompt = args[genIdx + 1];
  const name = args[genIdx + 2];
  if (!prompt) {
    console.error('usage: sticker.mjs --generate "prompt" [name]');
    process.exit(1);
  }
  const img = await generateImage(`Sticker WhatsApp lucu dan ekspresif: ${prompt}. Gaya kartun/vektor sederhana, latar transparan atau warna solid, subjek besar dan jelas.`);
  if (!img) process.exit(1);
  await save(img.buffer, name);
} else {
  const file = args[0];
  if (!file) {
    console.error('usage: sticker.mjs <image> [name]  |  sticker.mjs --generate "prompt" [name]');
    process.exit(1);
  }
  await save(fs.readFileSync(file), args[1]);
}
