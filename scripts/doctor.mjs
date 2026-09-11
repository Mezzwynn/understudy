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
nodeMajor >= 18 ? ok(`Node.js ${process.version}`) : bad(`Node.js ${process.version} (butuh >=18)`);

const git = spawnSync("git", ["--version"], { encoding: "utf8" });
git.status === 0 ? ok(git.stdout.trim()) : warn("git tidak ada (npm install bisa gagal)");

for (const [bin, why] of [["opusenc", "voice note"], ["cwebp", "stiker"]]) {
  const r = spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
  r.status === 0 ? ok(`${bin} ada (${why})`) : warn(`${bin} tidak ada — ${why} mati`);
}

fs.existsSync(path.join(ROOT, "node_modules"))
  ? ok("node_modules ada")
  : bad("node_modules belum ada — jalankan ./install.sh");

/* 2. config */
const envFile = path.join(ROOT, ".env");
if (!fs.existsSync(envFile)) {
  bad(".env belum ada — copy dari .env.example atau jalankan: rp setup");
} else {
  const mode = (fs.statSync(envFile).mode & 0o777).toString(8);
  mode === "600" ? ok(".env ada (chmod 600)") : warn(`.env permission ${mode} — sebaiknya 600 (chmod 600 .env)`);
}

/* 3. provider */
try {
  const list = providers();
  ok(`provider: ${list.map((p) => `${p.label}:${p.model}`).join(" → ")}`);
  const t = trackerProvider();
  const j = judgeProvider();
  ok(`tracker: ${t.label}:${t.model} · judge: ${j.label}:${j.model}`);
  process.stdout.write("  … tes model utama ");
  const reply = await llmChat([{ role: "user", content: "balas satu kata: ok" }], { maxTokens: 400 });
  ok(`terhubung — jawab: ${reply.replace(/\s+/g, " ").slice(0, 40)}`);
} catch (err) {
  bad(`provider gagal: ${err.message}`);
}

/* 4. media keys + kuota */
if (config.geminiApiKey) ok("GEMINI_API_KEY ada (vision / TTS / foto)"); else warn("GEMINI_API_KEY kosong");
if (config.elevenlabsApiKey) {
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": config.elevenlabsApiKey },
    });
    if (res.ok) {
      const j = await res.json();
      const left = j.character_limit - j.character_count;
      (left > 500 ? ok : warn)(`ElevenLabs sisa ${left} karakter (reset ${new Date(j.next_character_count_reset_unix * 1000).toLocaleDateString("id-ID")})`);
    } else bad(`ElevenLabs key ditolak (HTTP ${res.status})`);
  } catch {
    warn("ElevenLabs tidak bisa dicek (offline?)");
  }
} else warn("ELEVENLABS_API_KEY kosong (voice note pakai Gemini/off)");

/* 5. whatsapp + data */
fs.existsSync(path.join(DATA_DIR, "auth", "creds.json"))
  ? ok("WhatsApp sudah pernah ditautkan (data/auth)")
  : warn("WhatsApp belum ditautkan — jalankan: rp start");
// ask the running bot through the dashboard (this script is a separate process)
let liveConnected = null;
try {
  const res = await fetch(`http://127.0.0.1:${config.dashboardPort}/api/summary`);
  if (res.ok) liveConnected = Boolean((await res.json()).bot?.connected);
} catch {
  /* bot probably not running */
}
if (liveConnected === null) warn("bot sedang tidak jalan (rp start)");
else if (liveConnected) ok("WhatsApp sekarang: tersambung");
else bad("WhatsApp tidak tersambung — cek: rp log");

const chats = listChats();
ok(`${chats.length} kontak tersimpan`);

/* stickers */
const stickerDir = path.join(ROOT, "assets", "stickers");
let stickerTotal = 0;
try {
  stickerTotal = fs.readdirSync(stickerDir).filter((f) => f.endsWith(".webp")).length;
} catch {
  /* none */
}
const stickerOk = readableStickers().length;
if (!stickerTotal) warn("belum ada stiker — taruh .webp di assets/stickers/ atau: rp sticker --sync");
else if (!stickerOk) bad(`0/${stickerTotal} stiker bisa dibaca — jalankan: rp sticker --sync`);
else if (stickerOk < stickerTotal)
  warn(
    `${stickerOk}/${stickerTotal} stiker bisa dibaca — ${stickerTotal - stickerOk} milik app lain dan tidak terpakai (rp sticker --clean untuk buang)`,
  );
else ok(`${stickerOk} stiker siap dipakai`);
const st = loadState();
ok(`pemakaian hari ini: foto ${st.photoCount || 0}/${config.photoGlobalDailyMax} · TTS ${st.elChars || 0} karakter`);

/* 6. persona */
const p = loadPersona();
if (/TODO/i.test(p.card) && p.slug === "character") warn(`karakter masih template kosong — jalankan: rp character`);
else ok(`karakter: ${p.name} ${p.emoji} (${p.slug})`);
ok(`jam kerja: ${p.work_hours || "—"} · aktif: ${p.active_hours || "—"} · jadwal: ${p.chat_schedule || "—"}`);

/* 7. dashboard */
if (config.dashboard) {
  try {
    const res = await fetch(`http://127.0.0.1:${config.dashboardPort}/api/summary`);
    res.ok ? ok(`dashboard hidup di http://127.0.0.1:${config.dashboardPort}`) : warn("dashboard tidak menjawab");
  } catch {
    warn("dashboard tidak menjawab (normal kalau bot belum jalan)");
  }
} else warn("dashboard dimatikan (DASHBOARD=false)");

console.log("\n  Selesai. Kalau ada yang '!', itu opsional/kosmetik; '✗' perlu dibenerin.\n");
