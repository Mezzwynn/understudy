#!/usr/bin/env node
/**
 * stats.mjs — quota + usage for today (used by `rp status`).
 */
import { loadState, listChats } from "../src/store.mjs";
import { config } from "../src/config.mjs";

const st = loadState();
console.log(`\n── Biaya & kuota (${st.usageDay || "belum ada"}) ──`);

const usage = st.usage || {};
const labels = Object.keys(usage);
if (!labels.length) {
  console.log("  token: belum ada pemakaian tercatat (restart setelah update)");
} else {
  for (const label of labels) {
    const u = usage[label];
    console.log(
      `  ${label.padEnd(20)} ${String(u.calls).padStart(4)} call   in ${String(u.in).padStart(7)}   out ${String(u.out).padStart(6)} token`,
    );
  }
}

const photos = st.photoCount || 0;
const elChars = st.elChars || 0;
console.log(
  `  foto hari ini        ${photos}/${config.photoGlobalDailyMax}` +
    `   ·   TTS ${elChars}${config.elevenlabsDailyChars ? `/${config.elevenlabsDailyChars}` : ""} karakter`,
);

if (config.elevenlabsApiKey) {
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": config.elevenlabsApiKey },
    });
    if (res.ok) {
      const j = await res.json();
      const left = j.character_limit - j.character_count;
      const reset = j.next_character_count_reset_unix
        ? new Date(j.next_character_count_reset_unix * 1000).toLocaleDateString("id-ID")
        : "-";
      console.log(`  ElevenLabs           sisa ${left} karakter (reset ${reset})`);
    } else {
      console.log(`  ElevenLabs           gagal cek (HTTP ${res.status})`);
    }
  } catch {
    console.log("  ElevenLabs           gagal cek (offline?)");
  }
}

const chats = listChats();
if (chats.length) {
  const ttsSafe = config.elevenlabsDailyChars || 0;
  if (ttsSafe) {
    const voiceChance = config.voiceChance;
    console.log(`  (VOICE_CHANCE ${voiceChance} · cap TTS harian ${ttsSafe} karakter)`);
  }
}
console.log();
