import { config, log } from "./config.mjs";

/**
 * embed.mjs — text embeddings for semantic recall (Gemini).
 * Returns null when unavailable, so every caller can degrade to no-recall.
 */

const cache = new Map(); // small LRU-ish cache for repeated texts
const MAX_CACHE = 200;

export async function embed(text) {
  const t = String(text || "").trim();
  if (!config.memoryEmbeddings || !config.geminiApiKey || t.length < 4) return null;
  if (cache.has(t)) return cache.get(t);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.embedModel}:embedContent?key=${config.geminiApiKey}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: `models/${config.embedModel}`,
        content: { parts: [{ text: t.slice(0, 4000) }] },
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const body = await res.text();
    if (!res.ok) throw new Error(`${res.status}: ${body.slice(0, 160)}`);
    const json = JSON.parse(body);
    const values = json.embedding?.values;
    if (!Array.isArray(values) || !values.length) throw new Error("no embedding");
    cache.set(t, values);
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    return values;
  } catch (err) {
    log(`embed failed: ${err.message}`);
    return null;
  }
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
