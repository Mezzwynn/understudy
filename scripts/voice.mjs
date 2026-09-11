#!/usr/bin/env node
/**
 * voice.mjs — generate a voice note from text (for testing / preview).
 *
 *   node scripts/voice.mjs "halo lagi apa"
 *   node scripts/voice.mjs "halo" --voice Kore
 *
 * Writes data/voice-test.ogg
 */
import fs from "node:fs";
import path from "node:path";
import { synthesize, toSpeakable } from "../src/voice.mjs";
import { loadPersona } from "../src/prompt.mjs";
import { DATA_DIR, config } from "../src/config.mjs";

const args = process.argv.slice(2);
const text = args.find((a) => !a.startsWith("--"));
const vi = args.indexOf("--voice");
const voiceArg = vi >= 0 ? args[vi + 1] : "";

if (!text) {
  console.error('usage: voice.mjs "text to speak" [--voice Aoede]');
  process.exit(1);
}

const persona = loadPersona();
if (voiceArg) persona.voice = voiceArg;
const provider = (config.ttsProvider === "elevenlabs" || (config.ttsProvider === "auto" && config.elevenlabsApiKey)) ? "elevenlabs" : "gemini";
console.log(`provider: ${provider}`);
console.log(`voice   : ${provider === "elevenlabs" ? persona.voice_eleven || config.elevenlabsVoiceId : persona.voice || "(default Aoede)"}`);
console.log(`spoken : ${toSpeakable(text)}`);

const ogg = await synthesize(text, persona);
if (!ogg) {
  console.error("failed to synthesize (check GEMINI_API_KEY / TTS_MODEL / opusenc)");
  process.exit(1);
}

const out = path.join(DATA_DIR, "voice-test.ogg");
fs.writeFileSync(out, ogg);
console.log(`saved  : ${out} (${(ogg.length / 1024).toFixed(0)} kb)`);
console.log(`preview: termux-open ${out}`);
