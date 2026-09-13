/**
 * places.mjs — real photographs of her city, for her to send.
 *
 * A photo of a place has no face in it, so it cannot be "the wrong person" the way a
 * selfie can. And a real photograph has no AI tells at all, because it is not AI. So the
 * place library is built first: it is free, needs no image quota, and it covers most of
 * what people actually send each other.
 *
 * Sources are keyless and carry licence metadata: Wikimedia Commons and Openverse.
 * Licence rule: public domain first, then CC BY / CC BY-SA with the author recorded.
 * Search quality is the real work — "Denpasar street night" returns aeroplanes at the
 * airport — so every candidate passes a vision reviewer before it is kept.
 *
 * Usage:  node scripts/places.mjs [--limit N] [--kinds warung,cafe] [--dry]
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, log } from "../src/config.mjs";

const UA = "understudy/1.2 (personal roleplay bot; contact: owner)";
const OUT_DIR = path.join(DATA_DIR, "photos", "places");
const CREDITS = path.join(OUT_DIR, "CREDITS.txt");
const INDEX = path.join(OUT_DIR, "index.json");

/** What she might photograph, and how it ties to her day. */
export const PLACE_KINDS = {
  warung: { q: ["warung makan Bali", "nasi campur Bali plate", "warung sederhana Bali"], note: "lunch at a warung" },
  kopi: { q: ["es kopi Indonesia", "kopi tubruk", "warung kopi Bali", "coffee cup table Indonesia"], note: "coffee, working" },
  pasar: { q: ["pasar Badung Denpasar", "pasar tradisional Bali buah", "pedagang pasar Bali"], note: "errand at the market" },
  gang: { q: ["gang kecil Denpasar", "jalan kampung Bali", "alley Denpasar Bali"], note: "walking home" },
  jalan: { q: ["jalan raya Denpasar", "traffic Denpasar Bali", "motorcycle street Bali"], note: "stuck on the road" },
  pantai: { q: ["Sanur beach morning", "pantai Sanur Bali", "Bali beach morning walk"], note: "early walk by the water" },
  hujan: { q: ["hujan jalan Bali", "rain street Indonesia", "wet road Bali rain"], note: "rain, can't go out" },
  kelas: { q: ["kelas universitas Indonesia", "ruang kuliah Indonesia", "kampus Denpasar"], note: "class" },
  kantor: { q: ["kantor Bali meja", "office desk Indonesia", "ruang kerja Bali"], note: "at the office" },
  kucing: { q: ["kucing jalanan Indonesia", "cat Bali street", "anak kucing Indonesia"], note: "a cat, obviously" },
};

const BAD_TITLE = /(aircraft|airplane|airport|boeing|airbus|map|diagram|chart|logo|coat of arms|monument|museum|statue|plane|terminal|flag|banknote|stamp|poster|screenshot|satellite|aerial view|panorama of the world)/i;

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const LIMIT = Number(arg("limit", 3));
const DRY = args.includes("--dry");
const KINDS = String(arg("kinds", "")).split(",").filter(Boolean);

const key = () => (fs.readFileSync(path.join(process.cwd(), ".env"), "utf8").match(/^OPENROUTER_API_KEY=(.+)$/m) || [])[1]?.trim();

async function searchOpenverse(query) {
  const out = [];
  try {
    const r = await fetch(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=12&license_type=commercial,modification&mature=false`, { headers: { "user-agent": UA } });
    const j = await r.json();
    for (const it of j.results || []) {
      out.push({
        title: String(it.title || "untitled"),
        url: String(it.url || ""),
        source: "openverse",
        page: String(it.foreign_landing_url || it.url || ""),
        license: `${String(it.license || "").toUpperCase()} ${it.license_version || ""}`.trim(),
        author: String(it.creator || "").slice(0, 60),
        w: it.width,
        h: it.height,
      });
    }
  } catch (err) {
    log(`places: openverse failed (${err.message})`);
  }
  return out;
}

async function search(query) {
  const out = [];
  try {
    const r = await fetch(
      `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch=${encodeURIComponent(`${query} filetype:bitmap`)}&gsrnamespace=6&gsrlimit=${LIMIT * 3}&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=1400&origin=*`,
      { headers: { "user-agent": UA } },
    );
    const j = await r.json();
    for (const p of Object.values(j.query?.pages || {})) {
      const ii = p.imageinfo?.[0] || {};
      out.push({
        title: String(p.title || "").replace("File:", ""),
        url: ii.thumburl || ii.url || "",
        source: "wikimedia",
        page: `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title || "")}`,
        license: ii.extmetadata?.LicenseShortName?.value || "",
        author: String(ii.extmetadata?.Artist?.value || "").replace(/<[^>]*>/g, "").trim().slice(0, 60),
        w: ii.width,
        h: ii.height,
      });
    }
  } catch (err) {
    log(`places: wikimedia failed (${err.message})`);
  }
  // Openverse answers 500/504 from this network right now and each failed call costs a
  // minute, so it is opt-in: --openverse. Wikimedia alone carries the library.
  if (!args.includes("--openverse")) return out;
  const ov = await searchOpenverse(query);
  return [...out, ...ov];
}

function usable(c) {
  if (!c.url || !c.w || !c.h) return "no image";
  if (c.w < 900) return "too small";
  if (BAD_TITLE.test(c.title)) return `title looks wrong (${c.title.slice(0, 30)})`;
  if (!c.license) return "no licence stated";
  const free = /^(cc0|public domain|pd|no restrictions)/i.test(c.license);
  const share = /^(cc by|cc by-sa)/i.test(c.license);
  if (!free && !share) return `licence not usable (${c.license})`;
  return "";
}

/** Runs on the local disk: is this a photo she could plausibly have taken? */
async function review(file, place) {
  const b64 = fs.readFileSync(file).toString("base64");
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key()}` },
    body: JSON.stringify({
      model: "google/gemini-3.1-flash-lite",
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
            {
              type: "text",
              text: `A 20-year-old woman in Denpasar, Bali sends casual photos on WhatsApp. This candidate is meant for: "${place}". Answer with JSON only:
{"ok":true|false,"what":"what is actually in the photo, one short line","why":"if not ok, why"}
Reject when: it is a car, motorbike or signage by itself with no place in it, or it plainly does not match the note above; it is an aerial or drone shot, a brochure or professional landscape, a monument or tourist postcard, a diagram or map, focus is on a stranger's face, it is clearly not Indonesia, it is a plane or a building interior that nobody would photograph, or it is visibly a stock/studio photo. Accept when it looks like an ordinary photo a person took with a phone of something ordinary around them.`,
            },
          ],
        },
      ],
    }),
  });
  const j = await r.json();
  const txt = j.choices?.[0]?.message?.content || "";
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, what: "", why: "reviewer gave no verdict" };
  try {
    return JSON.parse(m[0]);
  } catch {
    return { ok: false, what: "", why: "reviewer verdict unreadable" };
  }
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const index = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, "utf8")) : [];
  const have = new Set(index.map((i) => `${i.kind}|${i.title}`));
  const kinds = (KINDS.length ? KINDS : Object.keys(PLACE_KINDS)).filter((k) => PLACE_KINDS[k]);
  let kept = 0;
  let seen = 0;

  for (const kind of kinds) {
    const place = PLACE_KINDS[kind].note;
    const queries = PLACE_KINDS[kind].q;
    let candidates = [];
    for (const q of queries) candidates = candidates.concat(await search(q));
    let taken = 0;
    for (const c of candidates) {
      if (taken >= LIMIT) break;
      if (have.has(`${kind}|${c.title}`)) continue;
      const bad = usable(c);
      if (bad) {
        console.log(`  ✗ ${kind}: ${bad} — ${c.title.slice(0, 40)}`);
        continue;
      }
      seen++;
      const file = path.join(OUT_DIR, `${kind}-${c.title.replace(/[^\w]+/g, "-").slice(0, 34)}.jpg`);
      try {
        const img = await fetch(c.url, { headers: { "user-agent": UA } });
        if (!img.ok) throw new Error(`download ${img.status}`);
        fs.writeFileSync(file, Buffer.from(await img.arrayBuffer()));
      } catch (err) {
        console.log(`  ✗ ${kind}: download failed (${err.message})`);
        continue;
      }
      if (DRY) {
        console.log(`  · ${kind}: ${c.title.slice(0, 40)} [${c.license}] (not reviewed, --dry)`);
        fs.unlinkSync(file);
        taken++;
        continue;
      }
      const v = await review(file, place);
      if (!v.ok) {
        console.log(`  ✗ ${kind}: ${String(v.why || "rejected").slice(0, 70)} — ${c.title.slice(0, 30)}`);
        fs.unlinkSync(file);
        continue;
      }
      index.push({
        kind,
        note: PLACE_KINDS[kind].note,
        file: path.basename(file),
        title: c.title,
        source: c.source,
        page: c.page,
        license: c.license,
        author: c.author,
        what: String(v.what || "").slice(0, 120),
        addedAt: Date.now(),
      });
      const line = `${c.license}${c.author ? ` — ${c.author}` : ""} — ${c.page}\n`;
      fs.appendFileSync(CREDITS, `${path.basename(file)}\n  ${line}`);
      console.log(`  ✓ ${kind}: ${String(v.what || "").slice(0, 60)} [${c.license}]`);
      kept++;
      taken++;
    }
    if (!taken) console.log(`  — ${kind}: nothing usable`);
  }

  if (!DRY) {
    fs.writeFileSync(INDEX, JSON.stringify(index, null, 2));
    console.log(`\n  ${kept} kept of ${seen} reviewed · ${index.length} in the library · ${OUT_DIR}`);
    if (kept) console.log(`  credits written to ${CREDITS}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
