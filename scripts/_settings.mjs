/**
 * _settings.mjs — shared behaviour knobs (used by character.mjs and config.mjs).
 *
 * "auto"   -> the model proposes values based on the character
 * "manual" -> you answer prompts (with the suggestion as default)
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT, envGet } from "../src/config.mjs";
import { chat as llmChat } from "../src/llm.mjs";

export const ENV_FILE = path.join(ROOT, ".env");

export function setEnv(key, value) {
  let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (re.test(text)) text = text.replace(re, line);
  else text += (text.endsWith("\n") || !text ? "" : "\n") + line + "\n";
  fs.writeFileSync(ENV_FILE, text, { mode: 0o600 });
}

/**
 * Read .env straight from disk. config.mjs caches the file at import time, so
 * after setEnv() the in-memory copy is stale — this keeps the UI honest.
 */
export function readEnvFile() {
  const out = {};
  if (!fs.existsSync(ENV_FILE)) return out;
  for (const raw of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i === -1) continue;
    let v = line.slice(i + 1).trim();
    if (!v.startsWith('"') && !v.startsWith("'")) v = v.replace(/\s+#.*$/, "").trim();
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

/**
 * Feature switches. Rendered as toggles in the dashboard, saved as 1/0, and every
 * one of them actually gates its code path (not just the prompt).
 */
export const FEATURES = [
  { key: "WORLD", label: "Backstory & the people around her", kind: "bool", def: 1, hint: "her private history and cast — off: she has no past to reference" },
  { key: "ROUTINE", label: "Her own daily routine", kind: "bool", def: 1, hint: "a generated day with hour blocks and moments" },
  { key: "ROUTINE_MOOD", label: "Routine affects her mood", kind: "bool", def: 1, hint: "a bad client at 13:00 actually sours her" },
  { key: "PROACTIVE", label: "She may message first", kind: "bool", def: 1, hint: "off: she only ever replies" },
  { key: "SULKING", label: "Sulking & going silent", kind: "bool", def: 1, hint: "off: no nudge, no cold replies, no silence — she just answers" },
  { key: "SOFT_MODE", label: "Soft window (melts, then pulls back)", kind: "bool", def: 1, hint: "off: no sudden warmth, no 'forget what i said'" },
  { key: "COMMITMENTS", label: "Promises & follow-ups", kind: "bool", def: 1, hint: "she remembers what she said she would report back on" },
  { key: "INSTRUCTION_FOLLOWUP", label: "Checks up on eat / sleep / rest", kind: "bool", def: 1, hint: "off: she stops asking whether you ate" },
  { key: "CROSS_CHAT", label: "Cross-chat notes (referrals)", kind: "bool", def: 1, hint: "off: contacts stay fully sealed from each other" },
  { key: "TASKS", label: "Errands (message a third number)", kind: "bool", def: 1, hint: "off: you cannot ask her to order food for you" },
  { key: "STRANGER_GUARD", label: "Guard & block strangers", kind: "bool", def: 1, hint: "off: no spam scoring, no warnings, no blocking" },
  { key: "MEMORY_EMBEDDINGS", label: "Semantic memory", kind: "bool", def: 1, hint: "off: she still remembers facts, but cannot recall by meaning" },
  { key: "MILESTONES", label: "Milestones", kind: "bool", def: 1, hint: "notices anniversaries and firsts" },
  { key: "PRESENCE", label: "Online / offline presence", kind: "bool", def: 1, hint: "off: she never appears online or typing" },
  { key: "MARK_READ", label: "Read receipts", kind: "bool", def: 1, hint: "off: your messages stay unread (blue ticks never appear)" },
  { key: "MOOD_MEDIA", label: "Mood affects media", kind: "bool", def: 1, hint: "off: voice/sticker/reaction odds ignore her mood" },
  { key: "SAVE_USER_STICKERS", label: "Keep stickers people send", kind: "bool", def: 1, hint: "off: she never reuses your stickers" },
  { key: "INJECTION_GUARD", label: "Prompt-injection guard", kind: "bool", def: 1, hint: "keep on unless you are testing" },
  { key: "NICK_ACCEPT_WARM", label: "Accepts pet names when warm", kind: "bool", def: 1, hint: "off: she refuses them even when close" },
  { key: "LIFE_EVENTS", label: "Real things happen to her", kind: "bool", def: 1, hint: "a weird stranger or a scare colours her mood, her day and what she talks about" },
  { key: "HUMOR", label: "She has a sense of humour", kind: "bool", def: 1, hint: "editable per character in the Character tab" },
  { key: "INTEREST", label: "She gets interested (and bored)", kind: "bool", def: 1, hint: "what lights her up, and what makes her switch off" },
  { key: "EVAL_WEEKLY", label: "Weekly humanness check", kind: "bool", def: 1, hint: "an independent judge scores how detectable she is, and the trend is kept" },
  { key: "BACKUP", label: "Daily backup", kind: "bool", def: 1, hint: "writes a tarball to your Downloads every day" },
];

export const KNOBS = [
  ...FEATURES,

  { key: "VOICE_CHANCE", label: "Reply with a voice note", kind: "float", def: 0.15, hint: "0 = never" },
  { key: "VOICE_MIRROR_CHANCE", label: "Answer a voice note with a voice note", kind: "float", def: 0.7 },
  { key: "TEXT_THEN_VOICE_CHANCE", label: "Text first, then a voice note", kind: "float", def: 0.2 },
  { key: "VOICE_SPLIT_CHANCE", label: "Split the voice note in two", kind: "float", def: 0.25 },
  { key: "REACTION_CHANCE", label: "Reply with a reaction emoji only", kind: "float", def: 0.12 },
  { key: "QUOTE_CHANCE", label: "Quote their message when replying", kind: "float", def: 0.2 },
  { key: "SKIP_CHANCE", label: "Read but do not reply (short ping)", kind: "float", def: 0.06 },
  { key: "TYPO_CHANCE", label: "Make a typo", kind: "float", def: 0.2 },
  { key: "BURST_CHANCE", label: "Split into two bubbles", kind: "float", def: 0.18 },
  { key: "DEBOUNCE_MS", label: "Batching: silent wait before replying (ms)", kind: "int", def: 1800 },
  { key: "DEBOUNCE_MAX_MS", label: "Batching: maximum wait (ms)", kind: "int", def: 12000 },
  { key: "READ_MIN_MS", label: "Read delay, minimum (ms)", kind: "int", def: 600 },
  { key: "READ_MAX_MS", label: "Read delay, maximum (ms)", kind: "int", def: 4000 },
  { key: "PRETYPE_MIN_MS", label: "Delay before typing starts, minimum (ms)", kind: "int", def: 1500 },
  { key: "PRETYPE_MAX_MS", label: "Delay before typing starts, maximum (ms)", kind: "int", def: 9000 },
  { key: "TYPING_PAUSE_CHANCE", label: "Chance of pausing mid-typing", kind: "float", def: 0.25 },
  { key: "PHOTO_CHANCE", label: "Send a photo or selfie unprompted", kind: "float", def: 0.03 },
  { key: "STICKER_CHANCE", label: "Send a sticker", kind: "float", def: 0.08 },
  { key: "STICKER_ONLY_CHANCE", label: "Sticker as the whole reply", kind: "float", def: 0.4 },
  { key: "CHECKUP_CHANCE", label: "Chance she follows up on eat/sleep advice", kind: "float", def: 0.45 },
  { key: "CHECKUP_COOLDOWN_MIN", label: "Minimum gap before repeating the same topic (minutes)", kind: "int", def: 120 },
  { key: "MAX_PENDING_CHECKUPS", label: "Maximum pending follow-ups", kind: "int", def: 2 },
  { key: "NUDGE_AFTER_MIN", label: "Time before she nudges after no reply (minutes)", kind: "int", def: 8 },
  { key: "DRY_AFTER_MIN", label: "Time before she goes cold (minutes)", kind: "int", def: 5 },
  { key: "DRY_SILENT_AFTER", label: "Go fully silent after N cold replies", kind: "int", def: 4 },
  { key: "PROACTIVE_IDLE_MIN", label: "Idle time before she messages first (minutes)", kind: "int", def: 45 },
  { key: "PROACTIVE_GAP_MIN", label: "Minimum gap between two messages she starts", kind: "int", def: 180 },
  { key: "DEFAULT_NICK", label: "What she calls you", kind: "text", def: "" },
  { key: "NICK_MOOD_MIN", label: "How warm before the pet name is allowed", kind: "float", def: 0.55 },
  { key: "NICK_CHANCE", label: "How often she uses the pet name", kind: "float", def: 0.25 },
  { key: "TASK_DAILY_MAX", label: "Maximum errands she runs per day", kind: "int", def: 5 },
  { key: "STRANGER_WARN_SCORE", label: "Suspicion score that triggers a warning", kind: "int", def: 3 },
  { key: "STRANGER_BLOCK_SCORE", label: "Suspicion score that blocks the number", kind: "int", def: 7 },
  { key: "STRANGER_FLOOD_PER_MIN", label: "Messages per minute that count as flooding", kind: "int", def: 6 },
  { key: "STRANGER_PROMOTE_AFTER", label: "Safe messages before a stranger becomes an acquaintance", kind: "int", def: 6 },
  { key: "ROUTINE_KEEP_DAYS", label: "Keep ordinary days for (days)", kind: "int", def: 3 },
  { key: "ROUTINE_HIGHLIGHT_MIN", label: "Minimum intensity to become a highlight", kind: "float", def: 0.5 },
  { key: "ROUTINE_HIGHLIGHT_MAX", label: "Maximum stored highlights", kind: "int", def: 30 },
  { key: "USER_WORK_HOURS", label: "Your work hours (for natural small talk)", kind: "text", def: "9-17" },
];

export function currentValues() {
  const file = readEnvFile();
  const out = {};
  for (const k of KNOBS) {
    const raw = file[k.key] !== undefined ? file[k.key] : envGet(k.key, "");
    if (k.kind === "text") {
      out[k.key] = raw === "" ? k.def : raw;
      continue;
    }
    if (k.kind === "bool") {
      out[k.key] = raw === "" ? k.def : (/^(1|true|on|yes)$/i.test(String(raw)) ? 1 : 0);
      continue;
    }
    const n = Number(raw);
    out[k.key] = raw === "" || !Number.isFinite(n) ? k.def : n;
  }
  return out;
}

export function applyValues(values) {
  for (const k of KNOBS) {
    if (values[k.key] === undefined) continue;
    // booleans go to .env as true/false, whatever the caller sent (1, 0, "on"…)
    if (k.kind === "bool") {
      const on = /^(1|true|on|yes)$/i.test(String(values[k.key]));
      setEnv(k.key, on ? "true" : "false");
      continue;
    }
    setEnv(k.key, String(values[k.key]));
  }
}

export function formatTable(values) {
  return KNOBS.map((k) => `  ${k.label.padEnd(46)} ${String(values[k.key]).padEnd(8)}`).join("\n");
}

/** Ask the model for character-appropriate values. */
export async function autoSuggest(persona, current) {
  const list = KNOBS.map((k) => `${k.key} (${k.label}, ${k.kind}${k.kind === "float" ? ", 0..1" : ""})`).join("\n");
  const system =
    "You tune a WhatsApp roleplay bot to match a character. " +
    "Given the character card and the current settings, propose values that make the experience feel like that character. " +
    "Cold/tsundere -> fewer emojis/reactions, slower replies, longer sulks. Warm/playful -> more reactions, faster. " +
    "Busy person -> lower proactive and higher delays. Return ONLY JSON mapping each key to a number/string.";
  const user = `KARTU KARAKTER:\n${persona.card.slice(0, 4000)}\n\nSETTING SEKARANG:\n${JSON.stringify(current)}\n\nKUNCI YANG HARUS DIISI:\n${list}`;
  const raw = await llmChat(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { json: true, temperature: 0.3, maxTokens: 3000 },
  );
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  let parsed = null;
  if (s !== -1 && e !== -1 && e > s) {
    try {
      parsed = JSON.parse(raw.slice(s, e + 1));
    } catch {
      parsed = null;
    }
  }
  // salvage a truncated JSON object: pull out "KEY": value pairs one by one
  if (!parsed) {
    parsed = {};
    for (const k of KNOBS) {
      const m = raw.match(new RegExp(`"${k.key}"\\s*:\\s*("?[^",}\\n]+"?)`));
      if (m) parsed[k.key] = m[1].replace(/^"/, "").replace(/"$/, "");
    }
    if (!Object.keys(parsed).length) {
      console.log("  ! the model returned invalid JSON — settings left unchanged");
      return current;
    }
  }
  const out = { ...current };
  for (const k of KNOBS) {
    if (parsed[k.key] === undefined) continue;
    if (k.kind === "text") out[k.key] = String(parsed[k.key]).slice(0, 40);
    else {
      const n = Number(parsed[k.key]);
      if (Number.isFinite(n)) out[k.key] = k.kind === "int" ? Math.round(n) : Math.max(0, Math.min(1, n));
    }
  }
  return out;
}

/** Prompt every knob, using the suggestion as the default. */
export async function askManually(rl, suggestions) {
  const out = { ...suggestions };
  for (const k of KNOBS) {
    const cur = suggestions[k.key];
    const ans = (await rl.question(`  ${k.label} [${cur}]${k.hint ? ` (${k.hint})` : ""}: `)).trim();
    if (!ans) continue;
    if (k.kind === "text") out[k.key] = ans.slice(0, 40);
    else {
      const n = Number(ans);
      if (Number.isFinite(n)) out[k.key] = k.kind === "int" ? Math.round(n) : Math.max(0, Math.min(1, n));
    }
  }
  return out;
}
