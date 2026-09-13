/**
 * evals.mjs — the humanness score, over time.
 *
 * scripts/eval.mjs runs an adversarial conversation and an independent judge
 * scores how detectable she is. This module stores those runs, tells the
 * scheduler when the next one is due, and gives the dashboard a trend.
 *
 *   data/evals.json  [{ at, score, verdict, model, judge, tells[], note }]
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, config, log } from "./config.mjs";

const FILE = path.join(DATA_DIR, "evals.json");
const KEEP = 60;

export function listEvals() {
  if (!fs.existsSync(FILE)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function recordEval(entry) {
  const list = listEvals();
  list.push({ at: Date.now(), ...entry });
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list.slice(-KEEP), null, 2));
  log(`eval recorded: ${entry.score}/100 (${entry.verdict})`);
  return list[list.length - 1];
}

export function lastEval() {
  const list = listEvals();
  return list[list.length - 1] || null;
}

/** Is a run due? (weekly by default, and never while one is already running) */
export function dueForEval(now = Date.now()) {
  if (!config.evalWeekly) return false;
  if (running) return false;
  const last = lastEval();
  if (!last) return true;
  return now - last.at > config.evalEveryDays * 24 * 3600 * 1000;
}

let running = false;
export const isEvalRunning = () => running;

export async function runAndRecord(runner) {
  if (running) return { ok: false, reason: "an eval is already running" };
  running = true;
  try {
    const result = await runner();
    if (!result || !Number.isFinite(result.score)) return { ok: false, reason: "no verdict" };
    recordEval(result);
    return { ok: true, result };
  } catch (err) {
    log(`eval failed: ${err.message}`);
    return { ok: false, reason: err.message };
  } finally {
    running = false;
  }
}

/** Compact summary for the dashboard: last score, best/worst, trend. */
export function evalSummary() {
  const list = listEvals();
  if (!list.length) return { runs: 0, last: null, history: [], best: null, worst: null };
  const scores = list.map((e) => e.score);
  return {
    runs: list.length,
    last: list[list.length - 1],
    history: list.slice(-20).map((e) => ({ at: e.at, score: e.score })),
    best: Math.min(...scores),
    worst: Math.max(...scores),
    average: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
  };
}
