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

export const KNOBS = [
  { key: "VOICE_CHANCE", label: "Balas pakai voice note", kind: "float", def: 0.15, hint: "0 = nggak pernah" },
  { key: "VOICE_MIRROR_CHANCE", label: "Balas VN kalau dikirim VN", kind: "float", def: 0.7 },
  { key: "TEXT_THEN_VOICE_CHANCE", label: "Teks dulu, lalu voice note", kind: "float", def: 0.2 },
  { key: "VOICE_SPLIT_CHANCE", label: "Voice note dipecah jadi 2", kind: "float", def: 0.25 },
  { key: "REACTION_CHANCE", label: "Cuma kasih reaction emoji", kind: "float", def: 0.12 },
  { key: "QUOTE_CHANCE", label: "Balas sambil nge-quote pesan", kind: "float", def: 0.2 },
  { key: "SKIP_CHANCE", label: "Dibaca tapi nggak dibales (ping pendek)", kind: "float", def: 0.06 },
  { key: "TYPO_CHANCE", label: "Salah ketik", kind: "float", def: 0.2 },
  { key: "BURST_CHANCE", label: "Pecah jadi 2 bubble", kind: "float", def: 0.18 },
  { key: "LONG_DELAY_CHANCE", label: "Jeda lama sebelum bales", kind: "float", def: 0.1 },
  { key: "DEBOUNCE_MS", label: "Batch pesan: jeda diam sebelum bales (ms)", kind: "int", def: 1800 },
  { key: "DEBOUNCE_MAX_MS", label: "Batch pesan: maksimal nunggu (ms)", kind: "int", def: 12000 },
  { key: "READ_MIN_MS", label: "Waktu baca min (ms)", kind: "int", def: 600 },
  { key: "READ_MAX_MS", label: "Waktu baca max (ms)", kind: "int", def: 4000 },
  { key: "PRETYPE_MIN_MS", label: "Jeda sebelum mulai ngetik min (ms)", kind: "int", def: 1500 },
  { key: "PRETYPE_MAX_MS", label: "Jeda sebelum mulai ngetik max (ms)", kind: "int", def: 9000 },
  { key: "TYPING_PAUSE_CHANCE", label: "Peluang berhenti ngetik sebentar", kind: "float", def: 0.25 },
  { key: "PHOTO_CHANCE", label: "Kirim foto/selfie sendiri", kind: "float", def: 0.03 },
  { key: "STICKER_CHANCE", label: "Kirim stiker", kind: "float", def: 0.08 },
  { key: "STICKER_ONLY_CHANCE", label: "Stiker jadi balasan tunggal (bukan tambahan)", kind: "float", def: 0.4 },
  { key: "NUDGE_AFTER_MIN", label: "Dia nanya kalau nggak dibales (menit)", kind: "int", def: 8 },
  { key: "DRY_AFTER_MIN", label: "Masuk mode ngambek (menit)", kind: "int", def: 5 },
  { key: "DRY_SILENT_AFTER", label: "Diam total setelah N balasan ngambek", kind: "int", def: 4 },
  { key: "PROACTIVE_IDLE_MIN", label: "Sepi berapa lama sebelum dia chat duluan", kind: "int", def: 45 },
  { key: "PROACTIVE_GAP_MIN", label: "Jeda minimal antar chat duluan", kind: "int", def: 180 },
  { key: "DEFAULT_NICK", label: "Dia manggil kamu apa", kind: "text", def: "" },
  { key: "NICK_CHANCE", label: "Seberapa sering dia pakai panggilan itu", kind: "float", def: 0.25 },
  { key: "NICK_AFFECTION_MIN", label: "Syarat affection biar boleh manis", kind: "float", def: 0.45 },
  { key: "NICK_VALENCE_MIN", label: "Syarat valence biar boleh manis", kind: "float", def: -0.05 },
  { key: "NICK_PATIENCE_MIN", label: "Syarat patience biar boleh manis", kind: "float", def: 0.35 },
  { key: "USER_WORK_HOURS", label: "Jam kerja user (buat pertanyaan natural)", kind: "text", def: "9-17" },
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
    const n = Number(raw);
    out[k.key] = raw === "" || !Number.isFinite(n) ? k.def : n;
  }
  return out;
}

export function applyValues(values) {
  for (const k of KNOBS) {
    if (values[k.key] === undefined) continue;
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
      console.log("  ! model tidak mengembalikan JSON yang valid — setting dibiarkan seperti sekarang");
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
