import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const STARTED_AT = Date.now();
export const DATA_DIR = path.join(ROOT, "data");
export const AUTH_DIR = path.join(DATA_DIR, "auth");
export const CHATS_DIR = path.join(DATA_DIR, "chats");
export const PROMPT_DIR = path.join(ROOT, "prompt");
export const PERSONA_DIR = path.join(ROOT, "personas");
export const STATE_FILE = path.join(DATA_DIR, "state.json");

function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i === -1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    // strip an inline comment ("value   # note") unless the value is quoted
    if (!v.startsWith('"') && !v.startsWith("'")) v = v.replace(/\s+#.*$/, "").trim();
    if (
      (v.startsWith('"') && v.endsWith('"') && v.length > 1) ||
      (v.startsWith("'") && v.endsWith("'") && v.length > 1)
    ) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

const fileEnv = parseEnvFile(path.join(ROOT, ".env"));
const env = { ...fileEnv, ...process.env };

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function envGet(key, fallback = "") {
  const v = env[key];
  return v === undefined || v === "" ? fallback : v;
}

export const config = {
  botName: envGet("BOT_NAME", "Alya"),
  persona: envGet("PERSONA", "example"),
  // what the character calls the user by default (per-contact override: rp contacts set)
  defaultNick: envGet("DEFAULT_NICK", ""),

  // Numbers allowed to talk to the bot (E.164, no spaces). Empty = allow everyone.
  allow: envGet("ALLOW", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // Groups: off by default (roleplay is meant for DMs).
  allowGroups: envGet("ALLOW_GROUPS", "false") === "true",
  groupAllow: envGet("GROUP_ALLOW", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // WhatsApp LIDs (new anonymous ids) mapped to real numbers, e.g.
  // LID_MAP=215341758152901:+6285111046991
  lidMap: (() => {
    const out = {};
    for (const pair of envGet("LID_MAP", "").split(",")) {
      const [lid, num] = pair.split(":");
      if (lid && num) out[lid.trim()] = num.trim();
    }
    return out;
  })(),

  // Texting feel
  maxBubbles: num(envGet("MAX_BUBBLES", "4"), 4),
  bubbleMaxChars: num(envGet("BUBBLE_MAX_CHARS", "320"), 320),
  minTypingMs: num(envGet("MIN_TYPING_MS", "900"), 900),
  maxTypingMs: num(envGet("MAX_TYPING_MS", "4500"), 4500),
  debounceMs: num(envGet("DEBOUNCE_MS", "1800"), 1800),
  // batching cap: never wait longer than this since the FIRST message of a burst
  debounceMaxMs: num(envGet("DEBOUNCE_MAX_MS", "12000"), 12000),
  replyDelayMs: num(envGet("REPLY_DELAY_MS", "0"), 0),
  // reading + pre-typing (the pause before "typing…" even appears)
  readMinMs: num(envGet("READ_MIN_MS", "600"), 600),
  readMaxMs: num(envGet("READ_MAX_MS", "4000"), 4000),
  pretypeMinMs: num(envGet("PRETYPE_MIN_MS", "1500"), 1500),
  pretypeMaxMs: num(envGet("PRETYPE_MAX_MS", "9000"), 9000),
  typingPauseChance: num(envGet("TYPING_PAUSE_CHANCE", "0.25"), 0.25),
  markRead: envGet("MARK_READ", "true") === "true",
  readDelayMinMs: num(envGet("READ_DELAY_MIN_MS", "2500"), 2500),
  readDelayMaxMs: num(envGet("READ_DELAY_MAX_MS", "90000"), 90000),
  quoteChance: num(envGet("QUOTE_CHANCE", "0.2"), 0.2),

  // Human imperfections
  skipChance: num(envGet("SKIP_CHANCE", "0.06"), 0.06),
  longDelayChance: num(envGet("LONG_DELAY_CHANCE", "0.1"), 0.1),
  longDelayMinMs: num(envGet("LONG_DELAY_MIN_MS", "25000"), 25000),
  longDelayMaxMs: num(envGet("LONG_DELAY_MAX_MS", "150000"), 150000),
  typoChance: num(envGet("TYPO_CHANCE", "0.2"), 0.2),
  correctionChance: num(envGet("CORRECTION_CHANCE", "0.35"), 0.35),
  reactionChance: num(envGet("REACTION_CHANCE", "0.12"), 0.12),
  burstChance: num(envGet("BURST_CHANCE", "0.18"), 0.18),

  // Proactive (texting first)
  proactive: envGet("PROACTIVE", "true") === "true",
  proactiveIdleMin: num(envGet("PROACTIVE_IDLE_MIN", "45"), 45),
  proactiveGapMin: num(envGet("PROACTIVE_GAP_MIN", "180"), 180),
  proactiveTickSec: num(envGet("PROACTIVE_TICK_SEC", "60"), 60),
  proactiveChancePerTick: num(envGet("PROACTIVE_CHANCE_PER_TICK", "0.15"), 0.15),
  // Optional fallback schedule when the persona has no `active_hours`:
  //   "11-14,17-19,21-2" or with weights "12-14:0.6,20-1:1.5"
  proactiveWindows: envGet("PROACTIVE_WINDOWS", ""),
  // Fixed daily times she texts first, e.g. "12:30,19:00,23:30" (per-persona:
  // `chat_schedule`). A slot only fires if she is eligible at that moment.
  proactiveSchedule: envGet("PROACTIVE_SCHEDULE", ""),
  scheduleGraceMin: num(envGet("SCHEDULE_GRACE_MIN", "20"), 20),
  scheduleJitterMin: num(envGet("SCHEDULE_JITTER_MIN", "0"), 0),
  nudgeAfterMin: num(envGet("NUDGE_AFTER_MIN", "8"), 8),
  dryAfterMin: num(envGet("DRY_AFTER_MIN", "5"), 5),
  drySilentAfter: num(envGet("DRY_SILENT_AFTER", "4"), 4),
  quietStart: num(envGet("QUIET_START", "2"), 2),
  quietEnd: num(envGet("QUIET_END", "8"), 8),

  // Context
  historyTurns: num(envGet("HISTORY_TURNS", "30"), 30),
  summarizeAt: num(envGet("SUMMARIZE_AT", "60"), 60),

  // LLM
  temperature: num(envGet("LLM_TEMPERATURE", "0.95"), 0.95),
  maxTokens: num(envGet("LLM_MAX_TOKENS", "700"), 700),
  freqPenalty: num(envGet("LLM_FREQ_PENALTY", "0.4"), 0.4),
  presencePenalty: num(envGet("LLM_PRESENCE_PENALTY", "0.4"), 0.4),
  requestTimeoutMs: num(envGet("LLM_TIMEOUT_MS", "90000"), 90000),

  // Optional vision/audio via Gemini
  geminiApiKey: envGet("GEMINI_API_KEY", ""),
  visionModel: envGet("VISION_MODEL", "gemini-flash-latest"),

  // jam kerja user (biar pertanyaan "udah makan?" dll pas waktunya)
  userWorkHours: envGet("USER_WORK_HOURS", "9-17"),

  // nickname behaviour ("honey")
  nickAffectionMin: num(envGet("NICK_AFFECTION_MIN", "0.45"), 0.45),
  nickValenceMin: num(envGet("NICK_VALENCE_MIN", "-0.05"), -0.05),
  nickPatienceMin: num(envGet("NICK_PATIENCE_MIN", "0.35"), 0.35),
  nickChance: num(envGet("NICK_CHANCE", "0.25"), 0.25),
  nickAcceptWarm: envGet("NICK_ACCEPT_WARM", "true") === "true",

  // Show as "online" only during her active hours
  presence: envGet("PRESENCE", "true") === "true",

  // Local web dashboard
  dashboard: envGet("DASHBOARD", "true") === "true",
  dashboardPort: num(envGet("DASHBOARD_PORT", "8787"), 8787),
  dashboardHost: envGet("DASHBOARD_HOST", "127.0.0.1"),
  dashboardToken: envGet("DASHBOARD_TOKEN", ""),

  // ── human extras ────────────────────────────────────────
  // "read then delete": she almost says something honest, then removes it
  deleteChance: num(envGet("DELETE_CHANCE", "0.06"), 0.06),
  deleteCoverChance: num(envGet("DELETE_COVER_CHANCE", "0.5"), 0.5),
  deleteMinMs: num(envGet("DELETE_MIN_MS", "1500"), 1500),
  deleteMaxMs: num(envGet("DELETE_MAX_MS", "6000"), 6000),
  // keep the stickers people send her and reuse them later
  saveUserStickers: envGet("SAVE_USER_STICKERS", "true") === "true",
  userStickerKeep: num(envGet("USER_STICKER_KEEP", "30"), 30),
  preferUserSticker: num(envGet("PREFER_USER_STICKER", "0.5"), 0.5),
  // let mood influence which kind of reply she sends
  moodMedia: envGet("MOOD_MEDIA", "true") === "true",
  // prompt-injection resistance (DMs are open)
  injectionGuard: envGet("INJECTION_GUARD", "true") === "true",
  // relationship milestones (first "I love you", first fight, ...)
  milestones: envGet("MILESTONES", "true") === "true",
  // promises to follow up later ("nanti aku kabarin kalau udah selesai")
  commitments: envGet("COMMITMENTS", "true") === "true",
  commitmentMinMin: num(envGet("COMMITMENT_MIN_MIN", "90"), 90),
  commitmentMaxMin: num(envGet("COMMITMENT_MAX_MIN", "480"), 480),
  // she told them to do something (eat / sleep / workout) -> check later
  instructionFollowup: envGet("INSTRUCTION_FOLLOWUP", "true") === "true",
  instructionMinMin: num(envGet("INSTRUCTION_MIN_MIN", "6"), 6),
  instructionMaxMin: num(envGet("INSTRUCTION_MAX_MIN", "35"), 35),
  // temporary softness: she melts, then pulls back (tsundere)
  softMode: envGet("SOFT_MODE", "true") === "true",
  softMinMin: num(envGet("SOFT_MIN_MIN", "8"), 8),
  softMaxMin: num(envGet("SOFT_MAX_MIN", "45"), 45),
  softTriggerChance: num(envGet("SOFT_TRIGGER_CHANCE", "0.55"), 0.55),
  softRetractChance: num(envGet("SOFT_RETRACT_CHANCE", "0.35"), 0.35),

  // ── semantic memory (embeddings) ────────────────────────
  memoryEmbeddings: envGet("MEMORY_EMBEDDINGS", "true") === "true",
  embedModel: envGet("EMBED_MODEL", "gemini-embedding-001"),
  recallTopK: num(envGet("RECALL_TOP_K", "4"), 4),
  recallMinScore: num(envGet("RECALL_MIN_SCORE", "0.62"), 0.62),
  memoryMaxEntries: num(envGet("MEMORY_MAX_ENTRIES", "400"), 400),

  // ── maintenance ─────────────────────────────────────────
  backup: envGet("BACKUP", "true") === "true",
  backupDir: envGet("BACKUP_DIR", ""),
  backupKeep: num(envGet("BACKUP_KEEP", "7"), 7),

  // Voice notes out (Gemini TTS -> Ogg/Opus PTT)
  ttsProvider: envGet("TTS_PROVIDER", "auto"), // auto | elevenlabs | gemini
  ttsModel: envGet("TTS_MODEL", "gemini-2.5-flash-preview-tts"),
  voiceChance: num(envGet("VOICE_CHANCE", "0.15"), 0.15),
  voiceMaxChars: num(envGet("VOICE_MAX_CHARS", "240"), 240),
  // combinations: a short text before the voice note, or two voice notes in a row
  textThenVoiceChance: num(envGet("TEXT_THEN_VOICE_CHANCE", "0.2"), 0.2),
  voiceSplitChance: num(envGet("VOICE_SPLIT_CHANCE", "0.25"), 0.25),

  // Voice notes out (ElevenLabs, preferred when configured)
  voiceMirrorChance: num(envGet("VOICE_MIRROR_CHANCE", "0.7"), 0.7),
  elevenlabsApiKey: envGet("ELEVENLABS_API_KEY", ""),
  elevenlabsVoiceId: envGet("ELEVENLABS_VOICE_ID", ""),
  elevenlabsModel: envGet("ELEVENLABS_MODEL", "eleven_multilingual_v2"),
  elevenlabsFormat: envGet("ELEVENLABS_FORMAT", "opus_48000_128"),
  elevenlabsStability: num(envGet("ELEVENLABS_STABILITY", "0.5"), 0.5),
  elevenlabsSimilarity: num(envGet("ELEVENLABS_SIMILARITY", "0.75"), 0.75),
  elevenlabsStyle: num(envGet("ELEVENLABS_STYLE", "0.15"), 0.15),
  elevenlabsDailyChars: num(envGet("ELEVENLABS_DAILY_CHARS", "700"), 700),

  // Photos & stickers out
  imageModel: envGet("IMAGE_MODEL", "gemini-2.5-flash-image"),
  photoChance: num(envGet("PHOTO_CHANCE", "0.05"), 0.05),
  photoDailyMax: num(envGet("PHOTO_DAILY_MAX", "6"), 6),
  photoGlobalDailyMax: num(envGet("PHOTO_GLOBAL_DAILY_MAX", "30"), 30),
  stickerChance: num(envGet("STICKER_CHANCE", "0.08"), 0.08),
  // chance the sticker is the whole reply instead of an addition to text/voice
  stickerOnlyChance: num(envGet("STICKER_ONLY_CHANCE", "0.4"), 0.4),

  debug: envGet("DEBUG", "false") === "true",
};

function provider(baseUrl, apiKey, model, label, temperature) {
  if (!baseUrl || !apiKey || !model) return null;
  const p = { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model, label };
  if (Number.isFinite(temperature)) p.temperature = temperature;
  return p;
}

/** Build a provider from a PREFIX_BASE_URL / PREFIX_API_KEY / PREFIX_MODEL / PREFIX_TEMPERATURE set. */
function providerFor(prefix, fallbackLabel) {
  const tRaw = envGet(`${prefix}_TEMPERATURE`, "");
  const t = tRaw === "" ? NaN : Number(tRaw);
  return provider(
    envGet(`${prefix}_BASE_URL`),
    envGet(`${prefix}_API_KEY`),
    envGet(`${prefix}_MODEL`),
    envGet(`${prefix}_LABEL`, fallbackLabel),
    t,
  );
}

/** Ordered list of providers to try. */
export function providers() {
  const list = [
    providerFor("LLM", "primary"),
    providerFor("FALLBACK", "fallback"),
    providerFor("FALLBACK2", "fallback2"),
  ].filter(Boolean);
  if (!list.length) {
    throw new Error(
      "No LLM provider configured. Set LLM_BASE_URL / LLM_API_KEY / LLM_MODEL in .env",
    );
  }
  return list;
}

/** Separate provider for the eval judge so model comparisons stay fair. */
export function judgeProvider() {
  return providerFor("JUDGE", "judge") || providers()[0];
}

/**
 * Provider for the internal mood/memory tracker. Keep this on a reliable model
 * even when the character runs on a small roleplay model.
 */
export function trackerProvider() {
  return providerFor("TRACKER", "tracker") || providers()[0];
}

/** An arbitrary OpenAI-compatible provider from env vars. */
export function providerFromEnv(prefix, label = prefix) {
  return provider(
    envGet(`${prefix}_BASE_URL`),
    envGet(`${prefix}_API_KEY`),
    envGet(`${prefix}_MODEL`),
    label,
  );
}

export function ensureDirs() {
  for (const d of [DATA_DIR, AUTH_DIR, CHATS_DIR]) fs.mkdirSync(d, { recursive: true });
}

export function log(...args) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}]`, ...args);
}
