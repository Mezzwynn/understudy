#!/usr/bin/env node
/**
 * character.mjs — create a character, guided by the model.
 *
 *   node scripts/character.mjs            (or: rp character)
 *   node scripts/character.mjs --list
 *   node scripts/character.mjs --use <slug>
 *
 * Modes:
 *   1) from a film / anime / game / book   -> give name + title, the model does the rest
 *   2) from a real public figure           -> person's public persona only
 *   3) from a free description
 *   4) build from scratch (short Q&A)
 *
 * The generation prompt is deliberately strict about canon fidelity so the
 * result actually feels like that character instead of a generic assistant.
 */
import fs from "node:fs";
import path from "node:path";
import { PERSONA_DIR, ROOT, envGet } from "../src/config.mjs";
import { parsePersonaFrontmatter } from "../src/prompt.mjs";
import { chat as llmChat } from "../src/llm.mjs";
import { createAsk } from "./_ask.mjs";
import { KNOBS, currentValues, applyValues, autoSuggest, askManually, setEnv, formatTable } from "./_settings.mjs";

const { ask, close } = createAsk();

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

function listPersonas() {
  const files = fs.readdirSync(PERSONA_DIR).filter((f) => f.endsWith(".md") && !f.startsWith("_"));
  if (!files.length) return console.log("  (belum ada karakter)");
  for (const f of files) {
    const slug = f.replace(/\.md$/, "");
    const meta = parsePersonaFrontmatter(fs.readFileSync(path.join(PERSONA_DIR, f), "utf8"));
    console.log(`  ${slug.padEnd(18)} ${(meta.emoji || "").padEnd(3)} ${meta.name || ""}`);
  }
}

const SYSTEM = `Kamu penulis kartu karakter untuk bot roleplay WhatsApp pribadi.
Tugasmu: bikin kartu yang SANGAT setia ke sumbernya — bukan versi "baik hati" bikinan sendiri.

ATURAN KETAT
1. Pakai fakta KANON saja. Kalau ada yang tidak kamu tahu, pilih yang paling konsisten dengan kanon populer, dan JANGAN mengarang sifat yang bertentangan.
2. Kalau karakter dari karya fiksi, sebut sumbernya (judul + jenis karya) di bagian Snapshot.
3. Tangkap detail:
   - Cara bicara: kata ganti, kebiasaan verbal, kata khas, formal/tidak, campur bahasa apa.
   - Rentang emosi: gimana dia marah, kesel, sedih, malu, takut, sayang, bercanda — termasuk yang dia SEMBUNYIIN.
   - Kontradiksi dirinya (yang bikin terasa nyata).
   - Hubungan awal dengan user dan seberapa cepat dia hangat.
   - Batasan: yang bikin dia ngambek, ngilang, atau dingin.
4. JANGAN menjadikannya asisten, selalu ramah, atau selalu setuju. Pertahankan sifat aslinya walau dingin, kasar, atau menyebalkan.
5. "Contoh ritme chat-nya" WAJIB 8-10 baris dan benar-benar khas dia.
6. Frontmatter WAJIB format ini, semua terisi:
---
name: <nama panggilan singkat>
emoji: <1 emoji>
vibe: <1 baris>
language: <bahasa chat-nya>
deflection: <kalimat penolakan in-character kalau dituduh AI>
voice: <pilih satu: Aoede/Kore/Leda/Zephyr/Puck/Charon>
voice_eleven:
voice_tags: [tag1] [tag2] [tag3] [tag4] [tag5]
voice_style: <1-2 kalimat gaya suaranya>
active_hours: <jam dia biasa online, format 11-14,17-19,21-2>
chat_schedule: <10 jam dia biasa chat duluan, format 11,12,13,17,18,19,20,22,23,0>
appearance: <deskripsi penampilan untuk generate foto>
---

Lalu isi kartu dengan bagian:
# PERSONA CARD — <Nama>
## Snapshot
## Kebiasaan ngetik (yang bikin dia kelihatan manusia)
### Contoh ritme chat-nya (WAJIB diisi)
## Kepribadian
## Sejarah (canon)
## Batasan karakter
## Canon facts (jangan dilanggar)
## Voice rules (ElevenLabs v3)

Balas HANYA dalam format:
<CARD>
...kartu lengkap...
</CARD>`;

async function generate(brief) {
  const raw = await llmChat(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: brief },
    ],
    { temperature: 0.85, maxTokens: 6000 },
  );

  // tolerant extraction: the model may omit the closing tag if it runs long
  let t = raw;
  const open = t.search(/<CARD>/i);
  if (open !== -1) t = t.slice(open + "<CARD>".length);
  const close = t.search(/<\/CARD>/i);
  if (close !== -1) t = t.slice(0, close);
  let card = t
    .trim()
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  if (!card.startsWith("---")) {
    try {
      fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
      fs.writeFileSync(path.join(ROOT, "data", "last-character-raw.txt"), raw);
    } catch {
      /* ignore */
    }
    throw new Error("model tidak mengembalikan kartu yang valid");
  }
  return card;
}

async function buildBrief() {
  console.log(`
  Mau bikin karakter dari mana?

   1) Film / anime / game / buku   (kasih nama + judulnya)
   2) Orang nyata / tokoh publik
   3) Deskripsi bebas
   4) Bikin dari nol (tanya-jawab singkat)
   5) Keluar
`);
  const mode = await ask("  Pilih [1-5]", "1");

  if (mode === "5") return null;

  const lang = await ask("  Bahasa chat dia", "Bahasa Indonesia santai (campur English dikit)");
  const nick = await ask("  Dia manggil kamu apa", "");
  const nickLine = nick ? `Panggilan dia ke user: "${nick}".` : "Panggilan dia ke user: (belum ditentukan, pilih yang natural).";

  if (mode === "1") {
    const name = await ask("  Nama karakter");
    if (!name) return null;
    const title = await ask("  Judul karya (film/anime/game/buku)");
    return `Buatkan kartu karakter untuk "${name}" dari "${title}". ${nickLine} Bahasa chat: ${lang}. Ikuti kanon "${title}" seketat mungkin.`;
  }

  if (mode === "2") {
    const name = await ask("  Nama tokoh");
    if (!name) return null;
    const field = await ask("  Bidangnya (musisi/aktor/atlet/streamer/dll)", "");
    return (
      `Buatkan kartu karakter berdasarkan persona PUBLIK "${name}"${field ? ` (${field})` : ""}. ${nickLine} Bahasa chat: ${lang}. ` +
      `Pakai gaya bicara dan citra publiknya. JANGAN mengarang klaim soal kehidupan pribadinya yang tidak publik, dan jangan menulis hal yang bisa menyinggung/merugikan.`
    );
  }

  if (mode === "3") {
    const desc = await ask("  Ceritakan karakternya (bebas)");
    if (!desc) return null;
    return `Buatkan kartu karakter dari deskripsi ini: ${desc}\n${nickLine} Bahasa chat: ${lang}.`;
  }

  // mode 4 — scratch Q&A
  const name = await ask("  Nama");
  if (!name) return null;
  const age = await ask("  Umur");
  const place = await ask("  Kota / domisili");
  const job = await ask("  Kerja / sekolah");
  const traits = await ask("  ️3-5 sifat (pisah pakai koma)");
  const typing = await ask("  Cara ngetik (pendek/panjang, slang, kapital, emoji)");
  const anger = await ask("  Yang bikin dia kesel");
  const soft = await ask("  Yang bikin dia luluh");
  const rel = await ask("  Hubungan sama kamu", "deket, belum resmi");
  return [
    "Buatkan kartu karakter ORISINIL dari brief ini:",
    `Nama: ${name}; Umur: ${age}; Domisili: ${place}; Kerja: ${job}.`,
    `Sifat: ${traits}.`,
    `Cara ngetik: ${typing}.`,
    `Kesel kalau: ${anger}. Luluh kalau: ${soft}.`,
    `Hubungan dengan user: ${rel}.`,
    nickLine,
    `Bahasa chat: ${lang}.`,
  ].join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--list" || args[0] === "list") return listPersonas();
  if (args[0] === "--use" || args[0] === "use") {
    const slug = args[1];
    if (!slug || !fs.existsSync(path.join(PERSONA_DIR, `${slug}.md`))) {
      console.log("  karakter tidak ditemukan. Lihat: rp character --list");
      return;
    }
    setEnv("PERSONA", slug);
    const meta = parsePersonaFrontmatter(fs.readFileSync(path.join(PERSONA_DIR, `${slug}.md`), "utf8"));
    if (meta.name) setEnv("BOT_NAME", meta.name);
    console.log(`  ✓ aktif: ${meta.name || slug}. Jalankan: rp restart`);
    return;
  }

  if (!envGet("LLM_BASE_URL")) {
    console.log("\n  Belum ada model. Jalankan dulu:  rp setup\n");
    return;
  }

  console.log(`
  ┌─────────────────────────────────────────────┐
  │  Understudy · bikin karakter                 │
  └─────────────────────────────────────────────┘`);

  const brief = await buildBrief();
  if (!brief) return console.log("  dibatalkan.");

  console.log("\n  Model sedang menyusun karakter… (bisa 10-30 detik)");
  let card;
  try {
    card = await generate(brief);
  } catch (err) {
    console.log(`  ✗ gagal: ${err.message}`);
    return;
  }

  const meta = parsePersonaFrontmatter(card);
  const slug = slugify(meta.name || "character");
  console.log(`\n  ── pratinjau (${slug}) ──\n`);
  console.log(
    card
      .split("\n")
      .slice(0, 42)
      .map((l) => "  " + l)
      .join("\n"),
  );
  console.log("\n  …\n");

  const save = (await ask("  Simpan karakter ini? [y/N]", "y")).toLowerCase();
  if (save !== "y") return console.log("  dibatalkan.");

  const file = path.join(PERSONA_DIR, `${slug}.md`);
  fs.writeFileSync(file, card.endsWith("\n") ? card : card + "\n");
  setEnv("PERSONA", slug);
  if (meta.name) setEnv("BOT_NAME", meta.name);
  console.log(`  ✓ disimpan: personas/${slug}.md`);
  console.log(`  ✓ aktif sekarang`);

  // ── settings: auto / manual / skip ────────────────────────────
  const current = currentValues();
  console.log(`
  Setting tingkah laku (voice note, reaction, jam, ngambek, dll):

   1) Auto   — model yang atur, sesuai karakter ini  (disarankan)
   2) Manual — kamu atur satu per satu
   3) Skip   — pakai default
`);
  const mode = await ask("  Pilih [1-3]", "1");

  try {
    if (mode === "1") {
      console.log("  Model sedang memilih setting…");
      const suggested = await autoSuggest({ card }, current);
      console.log(`\n  Usulan:\n${formatTable(suggested)}\n`);
      const ok = (await ask("  Terapkan? [y/N]", "y")).toLowerCase();
      if (ok === "y") {
        applyValues(suggested);
        setEnv("PERSONA", slug);
        console.log("  ✓ setting diterapkan");
      }
    } else if (mode === "2") {
      const suggested = await autoSuggest({ card }, current).catch(() => current);
      const values = await askManually(rl, suggested);
      applyValues(values);
      console.log("  ✓ setting diterapkan");
    }
  } catch (err) {
    console.log(`  ! setting otomatis gagal (${err.message}) — pakai default`);
  }

  console.log(`\n  Selesai. Jalankan:  rp restart\n`);
}

main()
  .catch((err) => console.error("gagal:", err.message))
  .finally(() => close());
