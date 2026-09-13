#!/usr/bin/env node
/**
 * lint.mjs — catch identifiers that are used but never imported or defined.
 *
 * Why this exists: a missing import in router.mjs ("decide is not defined") went
 * to production. `node --check` only validates syntax, and every test passed —
 * the only symptom was that she silently stopped answering anyone.
 *
 *   node scripts/lint.mjs            # check src/ and scripts/
 *   node scripts/lint.mjs --quiet    # only print problems
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quiet = process.argv.includes("--quiet");

const GLOBALS = new Set([
  "RGX",
  "Float32Array",
  "Float64Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "ArrayBuffer",
  "TextEncoder",
  "TextDecoder",
  "AbortSignal",
  "FileReader",
  "URL",
  "Promise",
  "Map",
  "Set",
  "JSON",
  "Math",
  "Date",
  "Number",
  "String",
  "Object",
  "Array",
  "Error",
  "RegExp",
  "Function",
  "Boolean",
  "Symbol",
  "BigInt",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURIComponent",
  "decodeURIComponent",
  "structuredClone",
  "queueMicrotask",
  "fetch",
  "process",
  "console",
  "globalThis",
  "Infinity",
  "NaN",
  "undefined",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "setImmediate",
  "crypto",
  "Buffer",
  "FormData",
  "Blob",
  "Intl",
  "caches",
  "Request",
  "Response",
  "Headers",
  "WebSocket",
  "atob",
  "btoa",

  // language
  "if","for","while","switch","catch","return","typeof","instanceof","new","await","function","class",
  "do","else","try","finally","throw","delete","void","yield","super","this","in","of","case","default",
  "async","static","get","set","import","export","let","const","var","extends","break","continue","with",
  // builtins
  "console","Math","JSON","Date","Object","Array","String","Number","Boolean","BigInt","Symbol","Promise",
  "Set","Map","WeakMap","WeakSet","RegExp","Error","TypeError","RangeError","SyntaxError","EvalError",
  "parseInt","parseFloat","isNaN","isFinite","setTimeout","clearTimeout","setInterval","clearInterval",
  "setImmediate","queueMicrotask","fetch","process","Buffer","URL","URLSearchParams","TextEncoder",
  "TextDecoder","structuredClone","Intl","AbortController","AbortSignal","encodeURIComponent",
  "decodeURIComponent","encodeURI","decodeURI","globalThis","require","module","exports","atob","btoa",
  "crypto","performance","Reflect","Proxy","FormData","Blob","File","Headers","Request","Response",
  "WebSocket","EventTarget","Event","DOMException","AggregateError","FinalizationRegistry","WeakRef",
]);


/** Balanced-parenthesis body starting at the "(" at `start`. */
function parenBody(code, start) {
  if (code[start] !== "(") return null;
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    const c = code[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return { body: code.slice(start + 1, i), end: i };
    }
  }
  return null;
}

function addParamNames(names, body) {
  for (const part of String(body).split(",")) {
    const clean = part
      .replace(/\{[^}]*\}/g, (m) => m.slice(1, -1).split(":").pop())
      .replace(/=.*$/, "")
      .replace(/[\s\S]*?[:.]/, "")
      .replace(/[^\w$,\s]/g, " ")
      .trim();
    for (const piece of clean.split(/\s+/)) {
      if (/^[A-Za-z_$][\w$]*$/.test(piece)) names.add(piece);
    }
  }
}

/** Everything this file brings into scope. */
function collectBindings(code) {
  const names = new Set();

  // import { a, b as c } from "..."   /   import x, { y } from "..."
  for (const m of code.matchAll(/import\s+([\s\S]*?)\s+from\s+["'][^"']+["']/g)) {
    const clause = m[1];
    const braces = clause.match(/\{([\s\S]*?)\}/);
    if (braces) {
      for (const part of braces[1].split(",")) {
        const name = part.includes(" as ") ? part.split(" as ")[1] : part;
        const clean = name.trim().replace(/^type\s+/, "");
        if (/^[A-Za-z_$][\w$]*$/.test(clean)) names.add(clean);
      }
    }
    const def = clause.replace(/\{[\s\S]*?\}/, "").replace(/,/g, " ").trim();
    if (/^[A-Za-z_$][\w$]*$/.test(def)) names.add(def);
  }

  // const/let/var, including destructuring
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([^=;]+)=/g)) {
    const target = m[1];
    const braces = target.match(/\{([\s\S]*?)\}/);
    const brackets = target.match(/\[([\s\S]*?)\]/);
    if (braces) {
      for (const part of braces[1].split(",")) {
        const name = part.includes(":") ? part.split(":")[1] : part;
        const clean = name.replace(/=.*$/, "").trim();
        if (/^[A-Za-z_$][\w$]*$/.test(clean)) names.add(clean);
      }
    } else if (brackets) {
      for (const part of brackets[1].split(",")) {
        const clean = part.replace(/=.*$/, "").trim();
        if (/^[A-Za-z_$][\w$]*$/.test(clean)) names.add(clean);
      }
    } else {
      for (const part of target.split(",")) {
        const clean = part.trim();
        if (/^[A-Za-z_$][\w$]*$/.test(clean)) names.add(clean);
      }
    }
  }

  // function / class names
  for (const m of code.matchAll(/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/\b(?:async\s+)?function\s*[\w$]*\s*\(/g)) { const pr = parenBody(code, m.index + m[0].length - 1); if (pr) addParamNames(names, pr.body); }
  for (const m of code.matchAll(/\(/g)) {
    // arrow function params: the parenthesis that is closed by "=>"
    const params = parenBody(code, m.index);
    if (params === null) continue;
    const after = code.slice(params.end + 1).match(/^\s*=>/);
    if (after) addParamNames(names, params.body);
  }
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1]);
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // namespace imports: import * as PHOTOS from "..."
  for (const m of code.matchAll(/\bimport\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // object method shorthand: "  close() {" inside a literal
  for (const m of code.matchAll(/^[ \t]*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) names.add(m[1]);

  return names;
}

/** Remove comments, strings and regex literals so their contents are never read as code. */
function stripCode(code) {
  return code
    // block comments
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    // template literals (with escapes)
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
    // quoted strings
    .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, '""')
    // regex literals: a slash that is not preceded by a word char, ")" or "]"
    // (which would make it division). Lookbehind keeps /\b(...)/ from being read
    // as a call to a function named b.
    .replace(/(?<![\w)\]$/*])\s*\/(?![*/])(?:\\[\s\S]|\[[^\]\n]*\]|[^/\n\\])+\/[gimsuy]*/g, " RGX")
    // line comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");;
}

/** Identifiers that are called like a function, excluding `obj.method(`. */
function collectCalls(code) {
  // strip comments, strings and regex literals first, so text inside them is
  // never mistaken for code
    const stripped = stripCode(code);

  const used = new Map();
  for (const m of stripped.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    const line = stripped.slice(0, m.index).split("\n").length;
    if (!used.has(name)) used.set(name, line);
  }
  return used;
}

const files = [];
for (const dir of ["src", "scripts"]) {
  const p = path.join(ROOT, dir);
  if (!fs.existsSync(p)) continue;
  for (const f of fs.readdirSync(p)) {
    // lint does not read its own source: the regex literals inside it confuse the scan
    if (f.endsWith(".mjs") && f !== "lint.mjs") files.push(path.join(p, f));
  }
}

// Constants that are used but never defined: the function check above only sees
// `name(`, so a missing import of something used as a value slipped through once
// (DATA_DIR in the dashboard). Our convention is ALL_CAPS for module constants, which
// is narrow enough to check without a real parser.
{
  let missing = 0;
  for (const file of files) {
    const code = stripCode(fs.readFileSync(file, "utf8"));
    const defined = collectBindings(fs.readFileSync(file, "utf8"));
    const seen = new Set();
    for (const m of code.matchAll(/(^|[^\w$.])([A-Z][A-Z0-9_]{2,})(?![A-Za-z0-9_])/g)) {
      const name = m[2];
      // an object key or a label ("KEY: value"), not a reference to a constant
      const after = code.slice(m.index + m[1].length + name.length, m.index + m[1].length + name.length + 6);
      if (/^\s*:/.test(after)) continue; // object key or label
      if (/^\s+as\s/.test(after)) continue; // "import { KEYS as MOOD_KEYS }"
      if (name.startsWith("RGX")) continue; // left over from stripping regex literals
      if (seen.has(name) || GLOBALS.has(name) || defined.has(name)) continue;
      seen.add(name);
      const line = code.slice(0, m.index).split("\n").length;
      console.log(`  ${path.relative(ROOT, file)}:${line}  "${name}" is used but never imported or defined`);
      missing++;
    }
  }
  if (missing) process.exitCode = 1;
}

// A duplicated `if (x) {` left behind by a text patch parses fine but is always a
// bug — it happened three times while adding agent actions.
let dupes = 0;
{
  const files = [];
  for (const dir of ["src", "scripts"]) {
    const p = path.join(ROOT, dir);
    if (!fs.existsSync(p)) continue;
    for (const f of fs.readdirSync(p)) {
    // lint does not read its own source: the regex literals inside it confuse the scan
    if (f.endsWith(".mjs") && f !== "lint.mjs") files.push(path.join(p, f));
  }
  }
  for (const file of files) {
    const code = fs.readFileSync(file, "utf8");
    for (const m of code.matchAll(/^(\s*)if\s*\(([^)]{1,120})\)\s*\{\s*if\s*\(\2\)\s*\{/gm)) {
      dupes++;
      console.log(`  ${path.relative(ROOT, file)}: duplicated condition "if (${m[2]})"`);
    }
  }
}

let problems = 0;
for (const file of files) {
  const code = fs.readFileSync(file, "utf8");
  const bindings = collectBindings(code);
  for (const [name, line] of collectCalls(code)) {
    if (GLOBALS.has(name) || bindings.has(name)) continue;
    problems++;
    console.log(`  ${path.relative(ROOT, file)}:${line}  "${name}" is called but never imported or defined`);
  }
}

if (!quiet && !dupes) console.log("  ✓ no duplicated if-blocks");
process.exit(problems + dupes ? 1 : 0);
