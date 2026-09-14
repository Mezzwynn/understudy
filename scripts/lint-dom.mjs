#!/usr/bin/env node
/**
 * lint-dom.mjs — find element ids the dashboard script reads but the markup no
 * longer has (or has never had).
 *
 * Why: `$("#brand-av").textContent = ...` survived a header redesign, threw
 * "Cannot set properties of null" at runtime, and only showed up as a red banner
 * in the browser. A static check catches it here instead.
 *
 *   node scripts/lint-dom.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(ROOT, "dashboard", "index.html");
const html = fs.readFileSync(file, "utf8");

// ids that exist in the markup (static + inside the JS templates)
const defined = new Set();
for (const m of html.matchAll(/\bid="([\w-]+)"/g)) defined.add(m[1]);
// ids the script builds at runtime: <tag id="x"> inside template literals is
// already covered above, but `${...}` interpolated ids are not — collect them too
for (const m of html.matchAll(/id="\$\{[^}]*\}"/g)) defined.add("__dynamic__");

const refs = new Map();
for (const m of html.matchAll(/\$\$?\(\s*"#([\w-]+)("\s*\+)?/g)) {
  // "#tab-" + tab  → the id is built at runtime, skip it
  if (m[2]) continue;
  if (!refs.has(m[1])) refs.set(m[1], true);
}
for (const m of html.matchAll(/getElementById\(\s*"([\w-]+)"/g)) refs.set(m[1], true);

// A `const X = Y;` where Y is a `let` that gets reassigned later is a snapshot,
// not a reference. That exact mistake left the Features card rendered but empty:
// the key list was copied while it was still [] and never updated.
let snapshots = 0;
const lets = new Set();
for (const m of html.matchAll(/\blet\s+([A-Za-z_$][\w$]*)/g)) lets.add(m[1]);
for (const m of html.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;/g)) {
  const [, alias, source] = m;
  if (!lets.has(source)) continue;
  const reassigned = new RegExp(`(^|[^.\\w])${source}\\s*=(?!=)`).test(html.slice(html.indexOf(m[0]) + m[0].length));
  if (!reassigned) continue;
  snapshots++;
  console.log(`  dashboard/index.html: const ${alias} = ${source} copies a value that changes later — use the source directly`);
}

// ids the script creates itself (an error bar, a temporary node) are not expected in the markup
const DYNAMIC_IDS = new Set(["understudyErrorBar"]);
let missing = 0;
for (const id of refs.keys()) {
  if (defined.has(id) || DYNAMIC_IDS.has(id)) continue;
  missing++;
  console.log(`  dashboard/index.html: #${id} is used by the script but does not exist in the markup`);
}
if (!missing) console.log("  ✓ every id the script uses exists");
if (!snapshots) console.log("  ✓ no stale copies of mutable state");
process.exit(missing + snapshots ? 1 : 0);
