#!/usr/bin/env node
/**
 * sticker.mjs — build WhatsApp stickers from images.
 *
 *   node scripts/sticker.mjs <image.png|jpg> [name]
 *   node scripts/sticker.mjs --generate "kucing lucu pakai topi" [name]
 *   node scripts/sticker.mjs --sync            # import dari folder stiker WhatsApp
 *
 * Stickers are saved to assets/stickers/*.webp and sent at random by the bot
 * (STICKER_CHANCE). Requires cwebp (pkg install libwebp).
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config.mjs";
import { generateImage, toSticker, syncStickers, readableStickers, tagStickers } from "../src/image.mjs";

const args = process.argv.slice(2);

// import stickers from the WhatsApp sticker folder (they are usually owned by
// another app, so copies made by us are the only ones we can read)
const TRASH_DIR = path.join(ROOT, "assets", "stickers", ".trash");

// always move, never delete: a sticker you cannot read today may be readable
// again later (different owner/app), and losing them is not recoverable.
if (args[0] === "--clean" || args[0] === "clean") {
  const dir = path.join(ROOT, "assets", "stickers");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".webp"));
  const good = new Set(readableStickers());
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  let moved = 0;
  for (const f of files) {
    if (good.has(f)) continue;
    try {
      fs.renameSync(path.join(dir, f), path.join(TRASH_DIR, f));
      moved++;
    } catch {
      /* ignore */
    }
  }
  console.log(`✓ pindahkan ${moved} stiker yang tidak bisa dibaca → assets/stickers/.trash/`);
  console.log(`  tersisa: ${readableStickers().length} stiker siap pakai`);
  console.log("  (balikin kapan saja: rp sticker --restore)");
  process.exit(0);
}

if (args[0] === "--restore" || args[0] === "restore") {
  if (!fs.existsSync(TRASH_DIR)) {
    console.log("tidak ada .trash — belum pernah ada yang dipindahkan");
    process.exit(0);
  }
  const dir = path.join(ROOT, "assets", "stickers");
  let back = 0;
  for (const f of fs.readdirSync(TRASH_DIR)) {
    if (!f.endsWith(".webp")) continue;
    try {
      fs.renameSync(path.join(TRASH_DIR, f), path.join(dir, f));
      back++;
    } catch {
      /* ignore */
    }
  }
  console.log(`✓ dikembalikan ${back} stiker dari .trash`);
  console.log(`  total yang bisa dipakai: ${readableStickers().length}`);
  process.exit(0);
}

if (args[0] === "--tag" || args[0] === "tag") {
  const force = args.includes("--force");
  const { done, skipped, total } = await tagStickers({
    force,
    onProgress: (f, info, n) => console.log(`  ${String(n).padStart(2)}. ${f} → ${info.tags.join(", ")}`),
  });
  console.log(`\n✓ selesai: ${done} stiker baru dikasih tag, ${skipped} sudah ada, total ${total}`);
  process.exit(0);
}

if (args[0] === "--sync" || args[0] === "sync") {
  const copied = syncStickers(args.slice(1));
  console.log(`✓ import ${copied} stiker baru ke assets/stickers/`);
  console.log(`  total yang bisa dipakai: ${readableStickers().length}`);
  process.exit(0);
}

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
