/**
 * pause.mjs — switch her off for a while, in character.
 *
 * While paused she does not reply to anyone, does not message first, and does not
 * run check-ups. The reason is kept so that when you switch her back on she knows
 * she was away ("out of town, bad signal") instead of pretending nothing happened.
 *
 *   data/pause.json  { until, reason, createdAt, resumedAt, lastReason }
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, log } from "./config.mjs";

const FILE = path.join(DATA_DIR, "pause.json");
const EMPTY = { until: 0, reason: "", createdAt: 0, resumedAt: 0, lastReason: "" };

export function loadPause() {
  if (!fs.existsSync(FILE)) return { ...EMPTY };
  try {
    return { ...EMPTY, ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
  } catch {
    return { ...EMPTY };
  }
}

function save(state) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  return state;
}

export function isPaused(now = Date.now()) {
  const p = loadPause();
  return p.until > now;
}

/** Minutes left, or 0 when she is awake. */
export function pausedFor(now = Date.now()) {
  const p = loadPause();
  return p.until > now ? Math.ceil((p.until - now) / 60000) : 0;
}

export function pauseFor(minutes, reason = "") {
  const state = loadPause();
  const until = Date.now() + Math.max(1, Math.round(minutes)) * 60000;
  const next = save({ ...state, until, reason: String(reason || "").slice(0, 160), createdAt: Date.now() });
  log(`paused for ${Math.round(minutes)} min${reason ? ` — ${reason}` : ""} (until ${new Date(until).toLocaleString()})`);
  return next;
}

/**
 * Unpause. The reason she was away is remembered so her first replies afterwards
 * can own it ("i was out of town") instead of ignoring the gap.
 */
export function resume() {
  const state = loadPause();
  if (!state.until && !state.lastReason) return state;
  const next = save({
    ...state,
    until: 0,
    resumedAt: Date.now(),
    lastReason: state.reason || state.lastReason,
    reason: "",
  });
  log(`resumed${next.lastReason ? ` — she was away: ${next.lastReason}` : ""}`);
  return next;
}

/** Prompt line: she is away, or she just came back from somewhere. */
export function pausePromptBlock() {
  const p = loadPause();
  if (p.until > Date.now()) {
    const mins = Math.ceil((p.until - Date.now()) / 60000);
    return [
      "## Kamu lagi nggak bisa bales",
      `Kamu lagi di luar / nggak pegang HP (${p.reason || "sibuk"}). Sisa ~${mins} menit lagi.`,
      "Balasanmu nanti boleh nyambungin itu — jangan pura-pura nggak terjadi.",
    ].join("\n");
  }
  const back = p.resumedAt ? Date.now() - p.resumedAt : Infinity;
  if (p.lastReason && back < 6 * 3600 * 1000) {
    return [
      "## Kamu baru balik",
      `Kamu baru balik dari: ${p.lastReason}. Kalau nyambung, boleh disinggung sekali — singkat, jangan minta maaf berlebihan.`,
    ].join("\n");
  }
  return "";
}
