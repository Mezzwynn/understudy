#!/usr/bin/env node
/**
 * doctor.mjs — cek semua hal penting sekali jalan.
 *
 *   node scripts/doctor.mjs      (or: rp doctor)
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, config, envGet, DATA_DIR } from "../src/config.mjs";
import { loadPersona } from "../src/prompt.mjs";
import { providers, trackerProvider, judgeProvider } from "../src/config.mjs";
import { chat as llmChat } from "../src/llm.mjs";
import { listChats, loadState } from "../src/store.mjs";
import { isConnected } from "../src/whatsapp.mjs";
import { readableStickers } from "../src/image.mjs";

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);

console.log("\n  Understudy · doctor\n");

/* 1. runtime */
const nodeMajor = Number(process.versions.node.split(".")[0]);
nodeMajor >= 18 ? ok(`Node.js ${process.version}`) : bad(`Node.js ${process.version} (needs >=18)`);

const git = spawnSync("git", ["--version"], { encoding: "utf8" });
git.status === 0 ? ok(git.stdout.trim()) : warn("git not found (npm install may fail)");

for (const [bin, why] of [["opusenc", "voice note"], ["cwebp", "stickers"]]) {
  const r = spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
  r.status === 0 ? ok(`${bin} found (${why})`) : warn(`${bin} missing — ${why} will not work`);
}

fs.existsSync(path.join(ROOT, "node_modules"))
  ? ok("node_modules present")
  : bad("node_modules missing — run ./install.sh");

/* 2. config */
const envFile = path.join(ROOT, ".env");
if (!fs.existsSync(envFile)) {
  bad(".env not found — copy .env.example or run: rp setup");
} else {
  const mode = (fs.statSync(envFile).mode & 0o777).toString(8);
  mode === "600" ? ok(".env present (chmod 600)") : warn(`.env permission ${mode} — should be 600 (chmod 600 .env)`);
}

/* 3. provider */
try {
  const list = providers();
  ok(`provider: ${list.map((p) => `${p.label}:${p.model}`).join(" → ")}`);
  const t = trackerProvider();
  const j = judgeProvider();
  ok(`tracker: ${t.label}:${t.model} · judge: ${j.label}:${j.model}`);
  process.stdout.write("  … testing the main model ");
  const reply = await llmChat([{ role: "user", content: "balas satu kata: ok" }], { maxTokens: 400 });
  ok(`connected — replied: ${reply.replace(/\s+/g, " ").slice(0, 40)}`);
} catch (err) {
  bad(`provider failed: ${err.message}`);
}

/* 4. media keys + kuota */
if (config.geminiApiKey) ok("GEMINI_API_KEY present (vision / TTS / photos)"); else warn("GEMINI_API_KEY is empty");
if (config.elevenlabsApiKey) {
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": config.elevenlabsApiKey },
    });
    if (res.ok) {
      const j = await res.json();
      const left = j.character_limit - j.character_count;
      (left > 500 ? ok : warn)(`ElevenLabs ${left} characters left (resets ${new Date(j.next_character_count_reset_unix * 1000).toISOString().slice(0, 10)})`);
    } else bad(`ElevenLabs key rejected (HTTP ${res.status})`);
  } catch {
    warn("ElevenLabs could not be checked (offline?)");
  }
} else warn("ELEVENLABS_API_KEY is empty (voice notes fall back to Gemini or stay off)");

/* 5. whatsapp + data */
fs.existsSync(path.join(DATA_DIR, "auth", "creds.json"))
  ? ok("WhatsApp has been linked before (data/auth)")
  : warn("WhatsApp not linked yet — run: rp start");
// ask the running bot through the dashboard (this script is a separate process)
let liveConnected = null;
try {
  const res = await fetch(`http://127.0.0.1:${config.dashboardPort}/api/summary`);
  if (res.ok) liveConnected = Boolean((await res.json()).bot?.connected);
} catch {
  /* bot probably not running */
}
if (liveConnected === null) warn("the bot is not running (rp start)");
else if (liveConnected) ok("WhatsApp: connected");
else bad("WhatsApp not connected — check: rp log");

const chats = listChats();
ok(`${chats.length} contacts stored`);

/* stickers */
const stickerDir = path.join(ROOT, "assets", "stickers");
let stickerTotal = 0;
try {
  stickerTotal = fs.readdirSync(stickerDir).filter((f) => f.endsWith(".webp")).length;
} catch {
  /* none */
}
const stickerOk = readableStickers().length;
if (!stickerTotal) warn("no stickers yet — drop .webp files in assets/stickers/ or run: rp sticker --sync");
else if (!stickerOk) bad(`0/${stickerTotal} stickers readable — run: rp sticker --sync`);
else if (stickerOk < stickerTotal)
  warn(
    `${stickerOk}/${stickerTotal} stickers readable — ${stickerTotal - stickerOk} owned by another app and unusable (rp sticker --clean to move them out)`,
  );
else ok(`${stickerOk} stickers ready`);
const st = loadState();
ok(`today: photos ${st.photoCount || 0}/${config.photoGlobalDailyMax} · TTS ${st.elChars || 0} characters`);

/* 6. persona */
const p = loadPersona();
if (/TODO/i.test(p.card) && p.slug === "character") warn(`the character is still the empty template — run: rp character`);
else ok(`character: ${p.name} ${p.emoji} (${p.slug})`);
ok(`work hours: ${p.work_hours || "—"} · active: ${p.active_hours || "—"} · schedule: ${p.chat_schedule || "—"}`);

/* 7. dashboard */
if (config.dashboard) {
  try {
    const res = await fetch(`http://127.0.0.1:${config.dashboardPort}/api/summary`);
    res.ok ? ok(`dashboard is up at http://127.0.0.1:${config.dashboardPort}`) : warn("the dashboard is not responding");
  } catch {
    warn("the dashboard is not responding (normal if the bot is not running)");
  }
} else warn("the dashboard is disabled (DASHBOARD=false)");

console.log("\n  Done. '!' means optional/cosmetic, '✗' means it needs fixing.\n");
