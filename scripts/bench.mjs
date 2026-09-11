#!/usr/bin/env node
/**
 * bench.mjs — compare character models with the same judge.
 *
 * Reads bench.json (array of OpenAI-compatible models), runs the turing test
 * against each, saves the transcript, and ranks them by AI-suspicion.
 *
 *   node scripts/bench.mjs
 *
 * bench.json entry:
 *   { "label": "hermes-4-70b",
 *     "baseUrl": "https://openrouter.ai/api/v1",
 *     "model": "nousresearch/hermes-4-70b",
 *     "apiKeyEnv": "OPENROUTER_API_KEY" }     // or "apiKey": "sk-..."
 *
 * The judge is fixed (JUDGE_* env or the primary provider) so scores compare.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT, judgeProvider, envGet } from "../src/config.mjs";

const file = path.join(ROOT, "bench.json");
if (!fs.existsSync(file)) {
  console.error("No bench.json. Copy bench.example.json and fill it in.");
  process.exit(1);
}

const models = JSON.parse(fs.readFileSync(file, "utf8"));
const jp = judgeProvider();
console.log(`judge: ${jp.label}/${jp.model}\n`);

const results = [];
for (const m of models) {
  const label = m.label || m.model;
  const apiKey = m.apiKey || envGet(m.apiKeyEnv || "", "") || process.env[m.apiKeyEnv || ""] || "";
  if (!apiKey) {
    console.log(`skip ${label}: no key (${m.apiKeyEnv || "apiKey"})`);
    continue;
  }
  console.log(`── ${label} (${m.model}) ──`);
  const env = {
    ...process.env,
    LLM_BASE_URL: m.baseUrl,
    LLM_API_KEY: apiKey,
    LLM_MODEL: m.model,
    LLM_LABEL: m.label || "char",
    LLM_TEMPERATURE: String(m.temperature ?? 0.9),
    JUDGE_BASE_URL: jp.baseUrl,
    JUDGE_API_KEY: jp.apiKey,
    JUDGE_MODEL: jp.model,
    TRACKER_BASE_URL: jp.baseUrl,
    TRACKER_API_KEY: jp.apiKey,
    TRACKER_MODEL: jp.model,
  };
  const r = spawnSync("node", ["scripts/turing.mjs"], { cwd: ROOT, env: { ...env, TURING_QUICK: "1" }, encoding: "utf8", timeout: 1200000 });
  const out = r.stdout || "";
  const sus = (out.match(/suspicion\s*:\s*(\d+)/) || [])[1];
  const verdict = (out.match(/suspicion\s*:\s*\d+\/100\s*→\s*(\w+)/) || [])[1];
  const score = sus ? Number(sus) : null;
  results.push({ label, model: m.model, score, verdict });
  const safe = label.replace(/[^a-z0-9]+/gi, "_");
  fs.writeFileSync(path.join(ROOT, `data/bench-${safe}.txt`), out);
  console.log(`   → suspicion ${score ?? "?"}/100  ${verdict ?? ""}\n`);
}

console.log("════════ RANKING (lower = less detectable) ════════");
results
  .filter((r) => r.score !== null)
  .sort((a, b) => a.score - b.score)
  .forEach((r, i) => console.log(`${i + 1}. ${r.label.padEnd(26)} ${r.score}/100  ${r.verdict}`));
console.log("\ntranscripts saved to data/bench-*.txt");
