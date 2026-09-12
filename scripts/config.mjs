#!/usr/bin/env node
/**
 * config.mjs — behaviour settings: auto (model decides) or manual.
 *
 *   node scripts/config.mjs            (or: rp config)
 *   node scripts/config.mjs show
 *   node scripts/config.mjs auto
 *   node scripts/config.mjs manual
 *   node scripts/config.mjs reset
 */
import { loadPersona } from "../src/prompt.mjs";
import { envGet } from "../src/config.mjs";
import { KNOBS, currentValues, applyValues, autoSuggest, askManually, formatTable } from "./_settings.mjs";
import { createAsk } from "./_ask.mjs";

const { ask, close } = createAsk();

function defaults() {
  const out = {};
  for (const k of KNOBS) out[k.key] = k.def;
  return out;
}

async function runAuto() {
  if (!envGet("LLM_BASE_URL")) return console.log("  No model configured — run: rp setup");
  const persona = loadPersona();
  const current = currentValues();
  console.log(`  Active character: ${persona.name} ${persona.emoji}`);
  console.log("  The model is choosing settings…");
  const suggested = await autoSuggest(persona, current);
  console.log(`\n  Proposal:\n${formatTable(suggested)}\n`);
  const ok = await ask("  Terapkan? [y/N]", "y");
  if (ok.toLowerCase() !== "y") return console.log("  cancelled.");
  applyValues(suggested);
  console.log("  ✓ applied. Run: rp restart");
}

async function runManual() {
  const current = currentValues();
  console.log(`\n  Current settings:\n${formatTable(current)}\n`);
  const values = await askManually(rl, current);
  applyValues(values);
  console.log("  ✓ applied. Run: rp restart");
}

async function main() {
  const cmd = process.argv[2] || "";

  if (cmd === "show") {
    console.log(`\n  Character: ${loadPersona().name}\n`);
    console.log(formatTable(currentValues()));
    console.log();
    return;
  }
  if (cmd === "auto") return runAuto();
  if (cmd === "manual") return runManual();
  if (cmd === "reset") {
    applyValues(defaults());
    console.log("  ✓ settings reset to defaults. Run: rp restart");
    return;
  }
  if (cmd) {
    console.log("usage: rp config [show|auto|manual|reset]");
    return;
  }

  console.log(`
  ┌─────────────────────────────────────────────┐
  │  Understudy · setting tingkah laku           │
  └─────────────────────────────────────────────┘

  Karakter: ${loadPersona().name}

   1) Lihat setting sekarang
   2) Auto   — model yang atur, sesuai karakter ini
   3) Manual — ubah satu per satu
   4) Reset ke default
`);
  const pick = await ask("  Pilih [1-4]", "1");
  if (pick === "1") {
    console.log(`\n${formatTable(currentValues())}\n`);
  } else if (pick === "2") {
    await runAuto();
  } else if (pick === "3") {
    await runManual();
  } else if (pick === "4") {
    applyValues(defaults());
    console.log("  ✓ defaults restored. Run: rp restart");
  }
}

main()
  .catch((err) => console.error("failed:", err.message))
  .finally(() => close());
