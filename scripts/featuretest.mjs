#!/usr/bin/env node
/**
 * featuretest.mjs — every feature switch must actually change behaviour.
 *
 * A switch that only looks like it works is worse than no switch: .env said
 * WORLD=true while the running process had it false, because the dashboard wrote
 * "1" and the config compared against "true".
 *
 * Each case runs in its own process: config.mjs caches .env at import time, so a
 * flag changed inside this process would not be re-read (that mistake made the
 * first version of this test lie).
 *
 *   node scripts/featuretest.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT, ".env");
const original = fs.readFileSync(ENV_FILE, "utf8");
const BOOLS =
  "WORLD ROUTINE ROUTINE_MOOD PROACTIVE SULKING SOFT_MODE COMMITMENTS INSTRUCTION_FOLLOWUP CROSS_CHAT TASKS STRANGER_GUARD MEMORY_EMBEDDINGS MILESTONES PRESENCE MARK_READ MOOD_MEDIA SAVE_USER_STICKERS INJECTION_GUARD NICK_ACCEPT_WARM BACKUP DASHBOARD".split(" ");

let failures = 0;

function setFlags(pairs) {
  let text = fs.readFileSync(ENV_FILE, "utf8");
  for (const [key, on] of pairs) {
    const re = new RegExp(`^${key}=.*$`, "m");
    const line = `${key}=${on ? "true" : "false"}`;
    text = re.test(text) ? text.replace(re, line) : text + `\n${line}\n`;
  }
  fs.writeFileSync(ENV_FILE, text, { mode: 0o600 });
}

/** Ask a fresh process whether the prompt contains a line, and what a flag reads as. */
function probe(needle, flag, inject = "") {
  const script = `
    const P = await import("./src/prompt.mjs");
    const S = await import("./src/store.mjs");
    const { config } = await import("./src/config.mjs");
    const chat = S.loadChat("215341758152901@lid");
    ${inject}
    const text = P.buildSystem(chat, P.loadPersona());
    console.log(JSON.stringify({ has: text.includes(${JSON.stringify(needle)}), flag: ${flag ? `config.${flag}` : "null"} }));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: ROOT, encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop());
}

console.log("\n  Understudy · feature switches\n");

// a cross-chat block only renders when there IS a note, so the test injects one
const NOTE = 'chat.crossNotes = [{ at: Date.now(), kind: "mention", fromJid: "t@s.whatsapp.net", fromName: "Tester", what: "said hi", done: false }];';
const CASES = [
  ["WORLD", "Dunia kamu", "backstory & cast", ""],
  ["ROUTINE", "Hari kamu sendiri", "daily routine", ""],
  ["CROSS_CHAT", "nyangkut sama ORANG LAIN", "cross-chat notes", NOTE],
];

try {
  for (const [flag, needle, label, inject] of CASES) {
    const prop = flag === "WORLD" ? "world" : flag === "ROUTINE" ? "routine" : "crossChat";
    setFlags([[flag, false]]);
    const off = probe(needle, prop, inject);
    setFlags([[flag, true]]);
    const on = probe(needle, prop, inject);

    const ok = off.flag === false && off.has === false && on.flag === true && on.has === true;
    if (ok) console.log(`  \x1b[32m✓\x1b[0m ${flag}: ${label} disappears when off, returns when on`);
    else {
      failures++;
      console.log(`  \x1b[31m✗\x1b[0m ${flag}: off(read ${off.flag}, present ${off.has}) on(read ${on.flag}, present ${on.has})`);
    }
  }

  // every boolean flag must be stored as true/false, and parse as a boolean
  const envText = fs.readFileSync(ENV_FILE, "utf8");
  const bad = BOOLS.filter((k) => new RegExp(`^${k}=[01]$`, "m").test(envText));
  if (!bad.length) console.log("  \x1b[32m✓\x1b[0m every boolean flag is stored as true/false");
  else {
    failures++;
    console.log(`  \x1b[31m✗\x1b[0m stored as 1/0: ${bad.join(", ")}`);
  }

  // a hand-written 1 must still be understood
  setFlags([["WORLD", false]]);
  fs.writeFileSync(ENV_FILE, fs.readFileSync(ENV_FILE, "utf8").replace(/^WORLD=.*$/m, "WORLD=1"), { mode: 0o600 });
  if (probe("Dunia kamu", "world").flag === true) console.log("  \x1b[32m✓\x1b[0m a hand-written WORLD=1 still parses as true");
  else {
    failures++;
    console.log("  \x1b[31m✗\x1b[0m WORLD=1 did not parse as true");
  }
} finally {
  fs.writeFileSync(ENV_FILE, original, { mode: 0o600 });
}

console.log(failures ? `\n  \x1b[31m${failures} feature check(s) failed\x1b[0m\n` : "\n  \x1b[32mall feature switches behave\x1b[0m\n");
process.exit(failures ? 1 : 0);
