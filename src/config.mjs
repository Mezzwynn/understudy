import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const STARTED_AT = Date.now();
// The data directory can be pointed elsewhere (the smoke test uses a throwaway
// one, so a test run can never touch real chats).
export const DATA_DIR = process.env.UNDERSTUDY_DATA_DIR || path.join(ROOT, "data");
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

function freshEnv() {
  return { ...parseEnvFile(path.join(ROOT, ".env")), ...process.env };
}
let env = freshEnv();

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/**
 * Booleans are written as true/false by the CLI and as 1/0 by the dashboard, and
 * people hand-edit .env too. Accept all of them: 1, true, on, yes.
 */
export function envFlag(key, def = false) {
  const raw = envGet(key, "");
  if (raw === "") return def;
  return /^(1|true|on|yes)$/i.test(String(raw).trim());
}

export function envGet(key, fallback = "") {
  const v = env[key];
  return v === undefined || v === "" ? fallback : v;
}

function buildConfig() {
  return {
  botName: envGet("BOT_NAME", "Alya"),
  persona: envGet("PERSONA", "example"),
  // What the character calls the user by default. Only applies to TRUSTED
  // contacts, so strangers never get the pet name.
  defaultNick: envGet("DEFAULT_NICK", ""),

  // Numbers that get the FULL character: warm baseline, pet names, voice notes,
  // stickers, soft window, proactive messages. Everyone else gets the reserved
  // "stranger" treatment. E.164, comma separated. "*" = everyone trusted.
  trusted: envGet("TRUSTED", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Set true if you want every contact treated as trusted (old behaviour).
  trustStrangers: envFlag("TRUST_STRANGERS", false),

  // ── strangers: guard + block, and when someone stops being a stranger ──
  // ── errands for the owner (send a message to a third number) ──
  tasks: envFlag("TASKS", true),
  taskDailyMax: num(envGet("TASK_DAILY_MAX", "5"), 5),

  strangerGuard: envFlag("STRANGER_GUARD", true),
  // the sulking escalation (nudge -> dry -> silent) and cross-chat notes are
  // features in their own right, so they can be switched off
  sulking: envFlag("SULKING", true),
  // her sense of humour and what she is interested in (traits.mjs)
  lifeEvents: envFlag("LIFE_EVENTS", true),
  // she sleeps during quiet hours and does not answer every 3am message
  // safety valve: stop making calls when the day's budget is spent
  budgetGuard: envFlag("BUDGET_GUARD", true),
  llmDailyCallsMax: num(envGet("LLM_DAILY_CALLS_MAX", "400"), 400),
  // when someone writes something that is no longer roleplay
  // push character changes to every conversation, with a diff
  // everyday unpredictability
  // why she may leave a message on read (see worth.mjs)
  skipTerminalChance: num(envGet("SKIP_TERMINAL_CHANCE", "0.6"), 0.6),
  skipBoredChance: num(envGet("SKIP_BORED_CHANCE", "0.15"), 0.15),
  skipFloodPerMin: num(envGet("SKIP_FLOOD_PER_MIN", "5"), 5),
  skipLowEnergyChance: num(envGet("SKIP_LOW_ENERGY_CHANCE", "0.35"), 0.35),
  skipColdChance: num(envGet("SKIP_COLD_CHANCE", "0.3"), 0.3),
  skipCarryingChance: num(envGet("SKIP_CARRYING_CHANCE", "0.25"), 0.25),
  // WhatsApp Status (the story feed)
  waStatus: envFlag("WA_STATUS", true),
  statusPerDay: num(envGet("STATUS_PER_DAY", "3"), 3),
  statusAudience: envGet("STATUS_AUDIENCE", "all"),
  statusQuietStart: num(envGet("STATUS_QUIET_START", "2"), 2),
  statusQuietEnd: num(envGet("STATUS_QUIET_END", "8"), 8),
  statusMinGapMin: num(envGet("STATUS_MIN_GAP_MIN", "150"), 150),
  statusMedia: envFlag("STATUS_MEDIA", true),
  // ── gambar: Atlas Cloud (pilihan Hik: nano-banana-pro buat wajah, seedream-v5 buat scene)
  imageEngine: envGet("IMAGE_ENGINE", "atlas"),
  openrouterApiKey: envGet("OPENROUTER_API_KEY", ""),
  atlasApiKey: envGet("ATLAS_API_KEY", ""),
  atlasBaseUrl: envGet("ATLAS_BASE_URL", "https://api.atlascloud.ai"),
  faceModel: envGet("FACE_MODEL", "black-forest-labs/flux-2-pro/text-to-image"),
  sceneModel: envGet("SCENE_MODEL", "black-forest-labs/flux-2-pro/text-to-image"),
  // model yang menerima foto referensi (dia yang dipakai buat foto dengan wajahnya)
  editModel: envGet("EDIT_MODEL", "black-forest-labs/flux-2-pro/edit"),
  // ── perpustakaan foto (dia kirim dari sini, bukan generate tiap kali)
  photoLibrary: envFlag("PHOTO_LIBRARY", true),
  photoSend: envFlag("PHOTO_SEND", true),
  photoFirst: envFlag("PHOTO_FIRST", true),
  photoGenerateOnDemand: envFlag("PHOTO_GENERATE_ON_DEMAND", false),
  // tampilan foto: "HP"-nya, dan knob olah gambarnya
  photoPhone: envGet("PHOTO_PHONE", "pixel"),
  photoGrain: num(envGet("PHOTO_GRAIN", "-1"), -1),
  photoBloom: num(envGet("PHOTO_BLOOM", "-1"), -1),
  photoMaxSide: num(envGet("PHOTO_MAX_SIDE", "1280"), 1280),
  photoQuality: num(envGet("PHOTO_QUALITY", "74"), 74),
  photoLearn: envFlag("PHOTO_LEARN", true),
  // selfie terjadwal: tempat tetap, baju/angle/cahaya/vibe selalu beda
  selfieEnabled: envFlag("SELFIE_ENABLED", true),
  selfieSchedule: envGet("SELFIE_SCHEDULE", "07:30,16:30"),
  selfieSpot: envGet("SELFIE_SPOT", "the full-length mirror on the inside of her bedroom door"),
  selfieMaxPerDay: num(envGet("SELFIE_MAX_PER_DAY", "2"), 2),
  // empty = rotate through the wardrobe; a name/id here locks every selfie to that outfit
  selfieOutfit: envGet("SELFIE_OUTFIT", ""),
  // how much of her face shows in a mirror selfie: full | half | hide
  selfieFace: envGet("SELFIE_FACE", "half"),
  // how she stands/holds herself: auto | natural | peace | hip | hair | sit | shoulder
  selfiePose: envGet("SELFIE_POSE", "auto"),
  // mirror = the same mirror spot; pap = a plain front-camera selfie at arm's length
  selfieType: envGet("SELFIE_TYPE", "mirror"),
  // her expression: auto | flat | tired | hurry | halfsmile | annoyed | distant | smirk | soft | laugh | amused
  selfieExpression: envGet("SELFIE_EXPRESSION", "auto"),
  // why she is sending this photo ("nemu bunga di taman...") — manual, or generated from the routine
  selfieWhy: envGet("SELFIE_WHY", ""),
  // how many selfie candidates to generate and judge, keeping the best (1-5)
  selfieCandidates: num(envGet("SELFIE_CANDIDATES", "1"), 1),
  // which framing reference group to use: auto | off | full | half | waist | face (auto = no ref is fine)
  selfieFraming: envGet("SELFIE_FRAMING", "auto"),
  objectModel: envGet("OBJECT_MODEL", "openai/gpt-image-1-mini/text-to-image"),
  photoCandidateCount: num(envGet("PHOTO_CANDIDATE_COUNT", "4"), 4),
  topicFatigue: envFlag("TOPIC_FATIGUE", true),
  lateReplyNote: envFlag("LATE_REPLY_NOTE", true),
  lateReplyMinMin: num(envGet("LATE_REPLY_MIN_MIN", "90"), 90),
  oddHourNote: envFlag("ODD_HOUR_NOTE", true),
  editChance: num(envGet("EDIT_CHANCE", "0.05"), 0.05),
  dailyVariance: envFlag("DAILY_VARIANCE", true),
  dailySpread: num(envGet("DAILY_SPREAD", "0.08"), 0.08),
  busyBlocks: envFlag("BUSY_BLOCKS", true),
  busyMaxMin: num(envGet("BUSY_MAX_MIN", "40"), 40),
  busyDelayMaxMin: num(envGet("BUSY_DELAY_MAX_MIN", "20"), 20),
  changeFeed: envFlag("CHANGE_FEED", true),
  changeWatchFiles: envFlag("CHANGE_WATCH_FILES", true),
  changeNotify: envFlag("CHANGE_NOTIFY", true),
  crisisWatch: envFlag("CRISIS_WATCH", true),
  crisisNotify: envFlag("CRISIS_NOTIFY", true),
  weekDigest: envFlag("WEEK_DIGEST", true),
  // small human imperfections
  misrememberChance: num(envGet("MISREMEMBER_CHANCE", "0.06"), 0.06),
  moodResidue: envFlag("MOOD_RESIDUE", true),
  sleepMode: envFlag("SLEEP_MODE", true),
  sleepReplyChance: num(envGet("SLEEP_REPLY_CHANCE", "0.25"), 0.25),
  humor: envFlag("HUMOR", true),
  interest: envFlag("INTEREST", true),
  // weekly humanness check (an independent judge scores how detectable she is)
  evalWeekly: envFlag("EVAL_WEEKLY", true),
  evalEveryDays: num(envGet("EVAL_EVERY_DAYS", "7"), 7),
  crossChat: envFlag("CROSS_CHAT", true),
  // suspicion points: link 2, scam wording 3, code/password 4, sexual 3, flood 2, repeats 2 ...
  strangerWarnScore: num(envGet("STRANGER_WARN_SCORE", "3"), 3),
  strangerBlockScore: num(envGet("STRANGER_BLOCK_SCORE", "7"), 7),
  strangerFloodPerMin: num(envGet("STRANGER_FLOOD_PER_MIN", "6"), 6),
  // how many messages from them before she treats a well-behaved stranger as an acquaintance
  strangerPromoteAfter: num(envGet("STRANGER_PROMOTE_AFTER", "6"), 6),
  // Resting mood for trusted contacts: valence,energy,arousal,affection,patience,playfulness
  baselineTrusted: envGet("BASELINE_TRUSTED", "0.30,0.60,0.45,0.68,0.60,0.50")
    .split(",")
    .map((s) => Number(s.trim())),

  // Numbers allowed to talk to the bot (E.164, no spaces). Empty = allow everyone.
  allow: envGet("ALLOW", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // Groups: off by default (roleplay is meant for DMs).
  allowGroups: envFlag("ALLOW_GROUPS", false),
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
  markRead: envFlag("MARK_READ", true),
  readDelayMinMs: num(envGet("READ_DELAY_MIN_MS", "2500"), 2500),
  readDelayMaxMs: num(envGet("READ_DELAY_MAX_MS", "90000"), 90000),
  quoteChance: num(envGet("QUOTE_CHANCE", "0.2"), 0.2),

  // Human imperfections
  skipChance: num(envGet("SKIP_CHANCE", "0.06"), 0.06),
  typoChance: num(envGet("TYPO_CHANCE", "0.2"), 0.2),
  correctionChance: num(envGet("CORRECTION_CHANCE", "0.35"), 0.35),
  reactionChance: num(envGet("REACTION_CHANCE", "0.12"), 0.12),
  burstChance: num(envGet("BURST_CHANCE", "0.18"), 0.18),

  // Proactive (texting first)
  proactive: envFlag("PROACTIVE", true),
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

  // nickname behaviour ("honey"). ONE dial: how warm she has to feel before the
  // pet name is allowed (average of affection, patience and mood). Three separate
  // thresholds used to fight each other.
  nickMoodMin: num(envGet("NICK_MOOD_MIN", "0.55"), 0.55),
  nickChance: num(envGet("NICK_CHANCE", "0.25"), 0.25),
  nickAcceptWarm: envFlag("NICK_ACCEPT_WARM", true),

  // Show as "online" only during her active hours
  presence: envFlag("PRESENCE", true),

  // Local web dashboard
  dashboard: envFlag("DASHBOARD", true),
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
  saveUserStickers: envFlag("SAVE_USER_STICKERS", true),
  userStickerKeep: num(envGet("USER_STICKER_KEEP", "30"), 30),
  preferUserSticker: num(envGet("PREFER_USER_STICKER", "0.5"), 0.5),
  // let mood influence which kind of reply she sends
  moodMedia: envFlag("MOOD_MEDIA", true),
  // prompt-injection resistance (DMs are open)
  injectionGuard: envFlag("INJECTION_GUARD", true),
  // relationship milestones (first "I love you", first fight, ...)
  milestones: envFlag("MILESTONES", true),
  // promises to follow up later ("nanti aku kabarin kalau udah selesai")
  commitments: envFlag("COMMITMENTS", true),
  commitmentMinMin: num(envGet("COMMITMENT_MIN_MIN", "90"), 90),
  commitmentMaxMin: num(envGet("COMMITMENT_MAX_MIN", "480"), 480),
  // she told them to do something (eat / sleep / workout) -> check later
  instructionFollowup: envFlag("INSTRUCTION_FOLLOWUP", true),
  // how often she actually follows up on "go eat / go sleep", so she does not
  // turn into a repeating alarm clock
  // ── her own daily life (routine.mjs) ──
  // her backstory + the people around her (world.mjs)
  world: envFlag("WORLD", true),

  routine: envFlag("ROUTINE", true),
  routineMood: envFlag("ROUTINE_MOOD", true),
  routineKeepDays: num(envGet("ROUTINE_KEEP_DAYS", "3"), 3),
  routineHighlightMin: num(envGet("ROUTINE_HIGHLIGHT_MIN", "0.5"), 0.5),
  routineHighlightMax: num(envGet("ROUTINE_HIGHLIGHT_MAX", "30"), 30),

  checkupChance: num(envGet("CHECKUP_CHANCE", "0.45"), 0.45),
  checkupCooldownMin: num(envGet("CHECKUP_COOLDOWN_MIN", "120"), 120),
  maxPendingCheckups: num(envGet("MAX_PENDING_CHECKUPS", "2"), 2),
  instructionMinMin: num(envGet("INSTRUCTION_MIN_MIN", "6"), 6),
  instructionMaxMin: num(envGet("INSTRUCTION_MAX_MIN", "35"), 35),
  // temporary softness: she melts, then pulls back (tsundere)
  softMode: envFlag("SOFT_MODE", true),
  softMinMin: num(envGet("SOFT_MIN_MIN", "8"), 8),
  softMaxMin: num(envGet("SOFT_MAX_MIN", "45"), 45),
  softTriggerChance: num(envGet("SOFT_TRIGGER_CHANCE", "0.55"), 0.55),
  softRetractChance: num(envGet("SOFT_RETRACT_CHANCE", "0.35"), 0.35),

  // ── semantic memory (embeddings) ────────────────────────
  memoryEmbeddings: envFlag("MEMORY_EMBEDDINGS", true),
  embedModel: envGet("EMBED_MODEL", "gemini-embedding-001"),
  recallTopK: num(envGet("RECALL_TOP_K", "4"), 4),
  recallMinScore: num(envGet("RECALL_MIN_SCORE", "0.62"), 0.62),
  memoryMaxEntries: num(envGet("MEMORY_MAX_ENTRIES", "400"), 400),

  // ── maintenance ─────────────────────────────────────────
  backup: envFlag("BACKUP", true),
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
  photoGlobalDailyMax: num(envGet("PHOTO_GLOBAL_DAILY_MAX", "30"), 30),
  stickerChance: num(envGet("STICKER_CHANCE", "0.08"), 0.08),
  // chance the sticker is the whole reply instead of an addition to text/voice
  stickerOnlyChance: num(envGet("STICKER_ONLY_CHANCE", "0.4"), 0.4),

    debug: envFlag("DEBUG", false),
  };
}

export const config = buildConfig();

/**
 * Re-read .env into the SAME config object, so a running bot picks up new
 * settings without being restarted (`rp restart` should not be part of editing
 * a value in the dashboard).
 */
export function reloadConfig() {
  env = freshEnv();
  Object.assign(config, buildConfig());
  return config;
}

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
