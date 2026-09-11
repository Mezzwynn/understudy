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

export const KNOBS = [
  { key: "VOICE_CHANCE", label: "Balas pakai voice note", kind: "float", def: 0.15, hint: "0 = nggak pernah" },
  { key: "VOICE_MIRROR_CHANCE", label: "Balas VN kalau dikirim VN", kind: "float", def: 0.7 },
  { key: "REACTION_CHANCE", label: "Cuma kasih reaction emoji", kind: "float", def: 0.12 },
  { key: "QUOTE_CHANCE", label: "Balas sambil nge-quote pesan", kind: "float", def: 0.2 },
  { key: "SKIP_CHANCE", label: "Dibaca tapi nggak dibales (ping pendek)", kind: "float", def: 0.06 },
  { key: "TYPO_CHANCE", label: "Salah ketik", kind: "float", def: 0.2 },
  { key: "BURST_CHANCE", label: "Pecah jadi 2 bubble", kind: "float", def: 0.18 },
  { key: "LONG_DELAY_CHANCE", label: "Jeda lama sebelum bales", kind: "float", def: 0.1 },
  { key: "PHOTO_CHANCE", label: "Kirim foto/selfie sendiri", kind: "float", def: 0.03 },
  { key: "STICKER_CHANCE", label: "Kirim stiker", kind: "float", def: 0.08 },
  { key: "NUDGE_AFTER_MIN", label: "Dia nanya kalau nggak dibales (menit)", kind: "int", def: 8 },
  { key: "DRY_AFTER_MIN", label: "Masuk mode ngambek (menit)", kind: "int", def: 5 },
  { key: "DRY_SILENT_AFTER", label: "Diam total setelah N balasan ngambek", kind: "int", def: 4 },
  { key: "PROACTIVE_IDLE_MIN", label: "Sepi berapa lama sebelum dia chat duluan", kind: "int", def: 45 },
  { key: "PROACTIVE_GAP_MIN", label: "Jeda minimal antar chat duluan", kind: "int", def: 180 },
  { key: "DEFAULT_NICK", label: "Dia manggil kamu apa", kind: "text", def: "" },
];

export function currentValues() {
  const out = {};
  for (const k of KNOBS) {
    const raw = envGet(k.key, "");
    out[k.key] = raw === "" ? k.def : k.kind === "text" ? raw : Number(raw);
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
