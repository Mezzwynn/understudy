#!/usr/bin/env node
/**
 * stats.mjs — quota + usage for today (used by `rp status`).
 */
import { loadState, listChats } from "../src/store.mjs";
import { config } from "../src/config.mjs";

const st = loadState();
console.log(`\n── Cost & quota (${st.usageDay || "no data yet"}) ──`);

const usage = st.usage || {};
const labels = Object.keys(usage);
if (!labels.length) {
  console.log("  tokens: no usage recorded yet (restart after updating)");
} else {
  for (const label of labels) {
    const u = usage[label];
    console.log(
      `  ${label.padEnd(20)} ${String(u.calls).padStart(4)} call   in ${String(u.in).padStart(7)}   out ${String(u.out).padStart(6)} tokens`,
    );
  }
}

const photos = st.photoCount || 0;
const elChars = st.elChars || 0;
console.log(
  `  photos today        ${photos}/${config.photoGlobalDailyMax}` +
    `   ·   TTS ${elChars}${config.elevenlabsDailyChars ? `/${config.elevenlabsDailyChars}` : ""} characters`,
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
      console.log(`  ElevenLabs           ${left} characters left (resets ${reset})`);
    } else {
      console.log(`  ElevenLabs           check failed (HTTP ${res.status})`);
    }
  } catch {
    console.log("  ElevenLabs           check failed (offline?)");
  }
}

const chats = listChats();
if (chats.length) {
  const ttsSafe = config.elevenlabsDailyChars || 0;
  if (ttsSafe) {
    const voiceChance = config.voiceChance;
    console.log(`  (VOICE_CHANCE ${voiceChance} · daily TTS cap ${ttsSafe} characters)`);
  }
}
console.log();
