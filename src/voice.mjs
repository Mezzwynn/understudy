import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { config, DATA_DIR, log } from "./config.mjs";
import { loadState, saveState } from "./store.mjs";

/**
 * voice.mjs — turn a short text into a WhatsApp voice note (Ogg/Opus PTT).
 *
 * Providers:
 *   - ElevenLabs  (preferred when ELEVENLABS_API_KEY is set) -> returns Ogg/Opus
 *   - Gemini TTS  (fallback) -> PCM wrapped to WAV, encoded with opusenc
 *
 * ElevenLabs has a character quota, so a daily budget (ELEVENLABS_DAILY_CHARS)
 * stops the bot from burning it all in one day.
 */

const TMP = path.join(DATA_DIR, "tmp");

function pcmToWav(pcm, sampleRate = 24000, channels = 1, bits = 16) {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bits) / 8;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function encodeOpus(pcm, sampleRate = 24000) {
  fs.mkdirSync(TMP, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const wavPath = path.join(TMP, `${stamp}.wav`);
  const oggPath = path.join(TMP, `${stamp}.ogg`);
  try {
    fs.writeFileSync(wavPath, pcmToWav(pcm, sampleRate));
    const r = spawnSync("opusenc", ["--bitrate", "24", "--quiet", wavPath, oggPath], { encoding: "utf8" });
    if (r.error || r.status !== 0) throw new Error(r.error ? r.error.message : r.stderr || `opusenc exit ${r.status}`);
    return fs.readFileSync(oggPath);
  } catch (err) {
    log(`opus encode failed: ${err.message}`);
    return null;
  } finally {
    try {
      fs.rmSync(wavPath, { force: true });
      fs.rmSync(oggPath, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Strip anything a real voice note would never say out loud. */
export function toSpeakable(text) {
  return text
    .replace(/<\|[^|>]*\|>/g, "")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2764}]/gu, "")
    .replace(/\[[^\]\n]*$/g, "") // dangling, unclosed tag at the end
    .replace(/\s*\n\s*/g, ". ")
    .replace(/[.]{2,}/g, ".")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s.,!?]+|[\s.,!?]+$/g, "")
    .trim();
}

/* ----------------------------- ElevenLabs ----------------------------- */

function elevenBudgetOk(len) {
  const limit = config.elevenlabsDailyChars;
  if (!limit) return true;
  const st = loadState();
  const today = new Date().toISOString().slice(0, 10);
  if (st.elDay !== today) {
    st.elDay = today;
    st.elChars = 0;
  }
  return (st.elChars || 0) + len <= limit;
}

function elevenCommit(len) {
  const st = loadState();
  const today = new Date().toISOString().slice(0, 10);
  if (st.elDay !== today) {
    st.elDay = today;
    st.elChars = 0;
  }
  st.elChars = (st.elChars || 0) + len;
  saveState(st);
}

async function elevenLabs(text, persona, ignoreBudget = false) {
  const key = config.elevenlabsApiKey;
  const voiceId = persona.voice_eleven || config.elevenlabsVoiceId;
  if (!key || !voiceId) return null;
  if (!ignoreBudget && !elevenBudgetOk(text.length)) {
    log(`elevenlabs daily budget reached (${config.elevenlabsDailyChars} chars), sending text instead`);
    return null;
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${config.elevenlabsFormat}`;
  const body = {
    text,
    model_id: config.elevenlabsModel,
    voice_settings: {
      stability: config.elevenlabsStability,
      similarity_boost: config.elevenlabsSimilarity,
      style: config.elevenlabsStyle,
      use_speaker_boost: true,
    },
  };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/*" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const type = res.headers.get("content-type") || "";
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`${res.status} ${t.slice(0, 200)}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());

    // Ogg/Opus straight from the API — ready for WhatsApp PTT.
    if (buf.slice(0, 4).toString() === "OggS") {
      elevenCommit(text.length);
      return buf;
    }
    // Raw PCM requested: wrap + encode.
    const m = config.elevenlabsFormat.match(/^pcm_(\d+)/);
    if (m) {
      const out = encodeOpus(buf, Number(m[1]));
      if (out) {
        elevenCommit(text.length);
        return out;
      }
    }
    throw new Error(`unexpected audio (${type})`);
  } catch (err) {
    log(`elevenlabs failed: ${err.message}`);
    return null;
  }
}

/* ------------------------------- Gemini ------------------------------- */

async function geminiTts(text, persona) {
  if (!config.geminiApiKey) return null;
  const voice = persona.voice || "Aoede";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.ttsModel}:generateContent?key=${config.geminiApiKey}`;
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const t = await res.text();
    if (!res.ok) throw new Error(`${res.status}: ${t.slice(0, 200)}`);
    const json = JSON.parse(t);
    const part = json.candidates?.[0]?.content?.parts?.[0];
    const data = part?.inlineData?.data || part?.inline_data?.data;
    if (!data) throw new Error("no audio in response");
    return encodeOpus(Buffer.from(data, "base64"), 24000);
  } catch (err) {
    log(`gemini tts failed: ${err.message}`);
    return null;
  }
}

/* ------------------------------ entrypoint ---------------------------- */

/** Returns an Ogg/Opus Buffer, or null on failure. */
export async function synthesize(text, persona = {}, { ignoreBudget = false } = {}) {
  const speakable = toSpeakable(text);
  if (speakable.length < 3) return null;

  const order =
    config.ttsProvider === "gemini"
      ? [geminiTts]
      : config.ttsProvider === "elevenlabs"
        ? [elevenLabs]
        : [elevenLabs, geminiTts];

  for (const fn of order) {
    const out = fn === elevenLabs ? await elevenLabs(speakable, persona, ignoreBudget) : await fn(speakable, persona);
    if (out) return out;
  }
  return null;
}
