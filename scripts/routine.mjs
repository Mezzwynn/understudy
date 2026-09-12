#!/usr/bin/env node
/**
 * routine.mjs — lihat / bikin ulang rutinitas harian dia.
 *
 * Rutinitas itu GLOBAL per karakter (satu orang, satu hari) — bukan per kontak.
 * Disimpan di data/routine/<slug>.json
 *
 *   node scripts/routine.mjs                 # hari ini (generate kalau belum ada)
 *   node scripts/routine.mjs --new           # paksa bikin ulang hari ini
 *   node scripts/routine.mjs --history       # hari-hari terakhir + highlight
 *   node scripts/routine.mjs --at 15:30      # lihat jadwal jam 15:30
 *   node scripts/routine.mjs --persona fiona
 */
import { loadPersona } from "../src/prompt.mjs";
import { ensureToday, tickMoments, currentBlock, nextBlock, loadRoutine, saveRoutine, prune } from "../src/routine.mjs";
import { config } from "../src/config.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : null;
};

const slug = val("--persona") || config.persona;
const persona = loadPersona(slug);

const KINDICON = { fun: "😄", sweet: "🥰", proud: "😤", annoyed: "😒", sad: "😢", scared: "😨", tired: "😮‍💨", awkward: "😬" };

if (flag("--history")) {
  const r = loadRoutine(slug);
  if (!r) {
    console.log("no routine yet. run without --history first.");
    process.exit(0);
  }
  console.log(`# Routine history — ${persona.name}\n`);
  for (const d of r.history || []) {
    console.log(`${d.date} ${d.weekday || ""} — ${d.theme}`);
    for (const m of d.moments || []) console.log(`   ${m.at} [${m.kind}] ${m.what}`);
  }
  console.log(`\n# Highlights (kept forever: ${(r.highlights || []).length})`);
  for (const h of r.highlights || []) console.log(`   ${h.date} ${KINDICON[h.kind] || "•"} ${h.what}`);
  process.exit(0);
}

const r = await ensureToday(persona, { force: flag("--new") });
if (!r) {
  console.log("could not generate a routine (see rp.log).");
  process.exit(1);
}
const fired = tickMoments(r);
saveRoutine(slug, prune(r));

const at = val("--at");
const when = at
  ? (() => {
      const [h, m] = at.split(":").map(Number);
      const d = new Date();
      d.setHours(h, m, 0, 0);
      return d;
    })()
  : new Date();

const cur = currentBlock(r, when);
console.log(`# ${persona.name} — ${r.weekday} ${r.date}`);
console.log(`  theme: ${r.theme}\n`);
console.log("## Schedule");
for (const b of r.blocks) {
  console.log(`  ${b.start}–${b.end}  ${b.what}${b.place ? `  @${b.place}` : ""}${cur && cur.start === b.start ? "  ← now" : ""}`);
}
console.log("\n## Moments");
for (const m of r.moments) {
  console.log(
    `  ${m.at}  ${KINDICON[m.kind] || "•"} [${m.kind}] ${m.what}${m.firedAt ? "" : "   (not yet)"}${
      m.share === false ? "  (private)" : ""
    }`,
  );
}
const nxt = nextBlock(r, when);
console.log(`\n  next: ${nxt ? `${nxt.start} ${nxt.what}` : "—"}`);
console.log(`  highlights kept: ${(r.highlights || []).length}`);
if (fired.length) console.log(`  ⚡ ${fired.length} new moments fired (every contact mood shifted)`);
if (flag("--new")) console.log("\n✓ today's routine was regenerated.");
