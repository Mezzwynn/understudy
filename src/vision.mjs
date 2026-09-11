import { config, log } from "./config.mjs";

/**
 * Optional media understanding through Gemini (image description, audio
 * transcription). Silently disabled when GEMINI_API_KEY is not set.
 */

async function gemini(parts) {
  if (!config.geminiApiKey) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.visionModel}:generateContent?key=${config.geminiApiKey}`;
  const body = { contents: [{ role: "user", parts }] };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text);
    const out = (json.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text)
      .filter(Boolean)
      .join(" ")
      .trim();
    return out || null;
  } catch (err) {
    log(`gemini media failed: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function describeImage(buffer, mimetype) {
  if (!config.geminiApiKey) return null;
  return gemini([
    { text: "Describe this image in 2 short sentences, neutral and factual. Mention faces, objects, setting, and any visible text. Do not speculate about the relationship between people." },
    { inline_data: { mime_type: mimetype || "image/jpeg", data: buffer.toString("base64") } },
  ]);
}

export async function transcribeAudio(buffer, mimetype) {
  if (!config.geminiApiKey) return null;
  return gemini([
    { text: "Transcribe this voice message verbatim in its original language. If it is not speech, say '[no speech]'. Output only the transcript." },
    { inline_data: { mime_type: mimetype || "audio/ogg", data: buffer.toString("base64") } },
  ]);
}
