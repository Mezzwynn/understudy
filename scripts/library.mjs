/**
 * library.mjs — fill and inspect her photo library.
 *
 *   node scripts/library.mjs list
 *   node scripts/library.mjs import-places     real photographs of Denpasar (Wikimedia, licensed)
 *   node scripts/library.mjs import-tests      the humanised photos from the scenario tests
 *   node scripts/library.mjs add <file> [--scene X] [--note Y] [--kind view|self] [--hour H]
 *   node scripts/library.mjs remove <id>
 *   node scripts/library.mjs pick [--hour H]   what she would send right now, and why
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, config, log } from "../src/config.mjs";
import { addPhoto, removePhoto, librarySummary, loadLibrary, pickPhoto, partOfDay } from "../src/photo-library.mjs";
import { checkPhoto } from "../src/photo-check.mjs";
import { avatarPath } from "../src/face.mjs";

const args = process.argv.slice(2);
const cmd = args[0];
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const slug = arg("slug", config.persona);
const skipCheck = args.includes("--no-check");

/** Nothing enters the library until it passes the check: no visible phone, no third-person POV. */
async function checked(file) {
  const v = await checkPhoto(file, { avatar: avatarPath(slug) || null });
  if (v.ok) return { ok: true };
  const why = [
    v.phone_visible ? "HP-nya kelihatan di foto (padahal HP itu yang motret)" : "",
    v.third_person ? "POV-nya dari orang lain, bukan dari dia" : "",
    v.professional ? "kelihatan foto profesional/stock, bukan jepretan HP" : "",
    ...(v.problems || []),
  ].filter(Boolean);
  return { ok: false, why: why.join("; ") || "gagal pemeriksaan" };
}

/** Places come with a kind and a note already, from scripts/places.mjs. */
async function importPlaces() {
  const placesDir = path.join(DATA_DIR, "photos", "places");
  if (!fs.existsSync(placesDir)) {
    console.log("  no place library yet — run: rp places");
    return;
  }
  let index = { photos: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(placesDir, "index.json"), "utf8"));
    index = { photos: Array.isArray(raw) ? raw : raw.photos || [] };
  } catch {
    /* fall back to the files themselves */
  }
  const hourFor = { warung: 12, kopi: 10, pasar: 9, gang: 17, jalan: 18, pantai: 6, hujan: 15, kelas: 9, kantor: 13, kucing: 16 };
  let added = 0;
  const seen = new Set(loadLibrary(slug).photos.map((p) => p.scene));
  for (const p of index.photos) {
    const file = path.join(placesDir, p.file || "");
    if (!p.file || !fs.existsSync(file)) continue;
    const scene = `tempat-${p.kind}-${(p.title || "").slice(0, 24).replace(/[^\w]+/g, "-").toLowerCase()}`;
    if (seen.has(scene)) continue;
    const gate = skipCheck ? { ok: true } : await checked(file);
    if (!gate.ok) {
      console.log(`  ✗ ${scene.slice(0, 40)}: ${gate.why}`.slice(0, 110));
      continue;
    }
    const r = addPhoto(slug, file, {
      scene,
      kind: "view",
      note: `real photo · ${p.what || p.title} · ${p.license || ""}`.slice(0, 190),
      hour: hourFor[p.kind] ?? 12,
      topics: `${p.kind},${p.kind === "kucing" ? "momo" : p.kind}`,
    });
    if (r.ok) {
      added++;
      seen.add(scene);
    }
  }
  console.log(`  places: ${added} photo(s) added`);
}

/** The humanised scenario photos — the ones that scored well, plus both selfies. */
async function importTests() {
  const dirs = [
    "/sdcard/Download/Understudy/pov-test",
    "/sdcard/Download/Understudy/scenario-face",
    "/sdcard/Download/Understudy/scenario-test",
  ];
  const hours = { "meja-pagi": 10, "warung-malam": 20, momo: 16, "selfie-siang": 14, "selfie-malam": 22, "jalan-pulang": 18, "pagi-kerja": 10 };
  const seen = new Set(loadLibrary(slug).photos.map((p) => p.scene));
  let added = 0;
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(jpg|jpeg|png)$/i.test(f) || /avatar/i.test(f)) continue;
      const base = f.replace(/\.(jpg|jpeg|png)$/i, "").replace(/-HUMANIZED$/, "");
      const scene = base.replace(/_(text-to-image|edit)(-developer)?$/, "").replace(/-(seedream|nano-banana|flux|qwen)[\w.-]*$/, "");
      const key = `${scene}-${base.includes("HUMANIZED") ? "h" : "raw"}`;
      if (seen.has(key)) continue;
      const model = (base.match(/(seedream|nano-banana|flux|qwen)[\w.-]*/) || [])[0] || "";
      const sceneName = scene.replace(/-(h|raw)$/, "");
      // meja kerja & kucing: masuk akal jam berapa saja; selfie & jalan tetap terikat jamnya
      const anyTime = ["meja-pagi", "pagi-kerja", "momo"].includes(sceneName);
      const gate = skipCheck ? { ok: true } : await checked(path.join(dir, f));
      if (!gate.ok) {
        console.log(`  ✗ ${key}: ${gate.why}`.slice(0, 120));
        continue;
      }
      const r = addPhoto(slug, path.join(dir, f), {
        scene: key,
        kind: /selfie/i.test(scene) ? "self" : "view",
        note: `${model} · ${path.basename(dir)}`,
        timeOfDay: anyTime ? "any" : undefined,
        hour: hours[sceneName] ?? 14,
        topics: scene.includes("momo") ? "momo,kucing" : scene.includes("warung") ? "warung,makan" : scene.includes("meja") || scene.includes("pagi-kerja") ? "kerja,meja,kopi" : scene.includes("jalan") ? "jalan,pulang" : "",
      });
      if (r.ok) {
        added++;
        seen.add(key);
      }
    }
  }
  console.log(`  tests: ${added} photo(s) added`);
}

function list() {
  const s = librarySummary(slug);
  console.log(`  ${s.count} photo(s) for ${s.slug} — kinds: ${JSON.stringify(s.byKind)} times: ${JSON.stringify(s.byTime)}`);
  for (const p of s.photos) {
    console.log(`   ${p.id}  ${String(p.kind).padEnd(5)} ${String(p.timeOfDay).padEnd(8)} sent ${String(p.usedCount).padStart(2)}x  ${String(p.scene).slice(0, 42)}  [${(p.topics || []).join(",")}]`);
  }
}

function pick() {
  const hour = Number(arg("hour", new Date().getHours()));
  const moment = { what: arg("moment", ""), kind: arg("kind", "") };
  const chat = { jid: arg("jid", "test@s.whatsapp.net"), trusted: true, mood: { valence: Number(arg("mood", "0.5")) } };
  const now = new Date();
  now.setHours(hour, 0, 0, 0);
  const chosen = pickPhoto({ slug, chat, moment, now });
  console.log(`  sekarang jam ${hour} (${partOfDay(hour)})${moment.what ? ` · momen: ${moment.what}` : ""}`);
  if (!chosen) console.log("  → nggak ada yang cocok: dia nggak kirim foto");
  else console.log(`  → dia kirim "${chosen.scene}" (${chosen.kind}) — ${chosen.why}`);
}

if (cmd === "list") list();
else if (cmd === "import-places") await importPlaces();
else if (cmd === "import-tests") await importTests();
else if (cmd === "add") {
  const file = args[1];
  const gate = skipCheck ? { ok: true } : await checked(file);
  if (!gate.ok) {
    console.log(`  ditolak: ${gate.why}`);
    process.exit(0);
  }
  const r = addPhoto(slug, file, {
    scene: arg("scene", path.basename(file, path.extname(file))),
    note: arg("note", ""),
    kind: arg("kind", ""),
    hour: Number(arg("hour", "12")),
    topics: arg("topics", ""),
  });
  console.log(r.ok ? `  added ${r.photo.id} (${r.photo.kind}, ${r.photo.timeOfDay})` : `  gagal: ${r.error}`);
} else if (cmd === "remove") {
  const r = removePhoto(slug, args[1]);
  console.log(r.ok ? "  removed" : `  gagal: ${r.error}`);
} else if (cmd === "pick") pick();
else
  console.log(
    "  pakai: rp photos list | import-places | import-tests | add <file> | remove <id> | pick [--hour H] [--moment TEXT] [--mood 0.4]",
  );
