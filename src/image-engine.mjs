/**
 * image-engine.mjs — one place that talks to Atlas Cloud for images.
 *
 * Atlas is used instead of the Gemini key directly because the free Gemini quota for images is
 * a queue (429 with a retry hint even after waiting), while Atlas answers in 8-18 seconds for
 * $0.004-0.07 an image.
 *
 * The model ids carry a task suffix ("/text-to-image", "/edit"); a bare family name fails with a
 * confusing pricing error on their side, so ids are validated before the call.
 */
import fs from "node:fs";
import { config, log } from "./config.mjs";

const BASE = () => config.atlasBaseUrl || "https://api.atlascloud.ai";
const HEADERS = () => ({
  authorization: `Bearer ${config.atlasApiKey}`,
  "content-type": "application/json",
  "X-Atlas-Client": "understudy",
});

export const imageEngineReady = () => (config.imageEngine === "openrouter" ? !!config.openrouterApiKey : !!config.atlasApiKey);

/** Ids differ between the two services. Atlas ids carry a task suffix ("/text-to-image", "/edit");
 *  OpenRouter slugs do not — so anything without the suffix is taken as an OpenRouter id as-is. */
const OPENROUTER_FALLBACK = { text: "google/gemini-3.1-flash-image", edit: "google/gemini-3.1-flash-image" };
function openRouterModel(model, images = []) {
  const id = String(model || "");
  if (!/\/(text-to-image|edit)(-developer)?$/i.test(id)) return id;
  if (/^(google|openai)\//.test(id)) return id;
  return (images || []).length ? OPENROUTER_FALLBACK.edit : OPENROUTER_FALLBACK.text;
}

/**
 * OpenRouter path: chat/completions with modalities ["image","text"], input images as data URLs.
 * Same return shape as the Atlas path so callers do not care which engine is on.
 */
async function viaOpenRouter({ model, prompt, aspect, images, timeoutSec }) {
  const parts = [...(images || []).map((url) => ({ type: "image_url", image_url: { url } })), { type: "text", text: prompt }];
  const t0 = Date.now();
  const post = (modalities) =>
    fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.openrouterApiKey}` },
      signal: AbortSignal.timeout(Math.min(timeoutSec, 180) * 1000),
      body: JSON.stringify({ model, modalities, messages: [{ role: "user", content: parts }] }),
    }).then((r) => r.json());
  try {
    let j = await post(["image", "text"]);
    // image-only models (e.g. black-forest-labs/flux.2-pro) reject "image, text" and want just "image"
    if (j.error && /modalities/i.test(String(j.error.message || ""))) j = await post(["image"]);
    if (j.error) return { ok: false, error: String(j.error.message || j.error).slice(0, 200), seconds: (Date.now() - t0) / 1000 };
    const msg = j.choices?.[0]?.message || {};
    const url = msg.images?.[0]?.image_url?.url || msg.images?.[0]?.imageUrl?.url || "";
    if (!url) return { ok: false, error: "no image in the reply", seconds: (Date.now() - t0) / 1000 };
    const b64 = url.split(",")[1] || url;
    const buf = Buffer.from(b64, "base64");
    const seconds = Number(((Date.now() - t0) / 1000).toFixed(1));
    log(`image (openrouter): ${model} → ${(buf.length / 1024).toFixed(0)} kb in ${seconds}s ($${Number(j.usage?.cost || 0).toFixed(3)})`);
    return { ok: true, buf, url: "", seconds, price: Number(j.usage?.cost || 0) };
  } catch (err) {
    return { ok: false, error: err.message.slice(0, 200), seconds: (Date.now() - t0) / 1000 };
  }
}

/**
 * Generate one image. Returns { ok, buf, url, seconds, price } — or { ok: false, error }.
 * `images` (public URLs) turns a text-to-image model call into an edit against a reference.
 */
export async function generateImage({ model, prompt, aspect = "1:1", images = [], resolution = "1k", timeoutSec = 180 }) {
  if (!imageEngineReady()) return { ok: false, error: `image engine not configured (${config.imageEngine})` };
  if (config.imageEngine === "openrouter") {
    const primary = openRouterModel(model, images);
    const fallback = images.length ? OPENROUTER_FALLBACK.edit : OPENROUTER_FALLBACK.text;
    const first = await viaOpenRouter({ model: primary, prompt, aspect, images, timeoutSec });
    if (first.ok || primary === fallback) return first;
    // the chosen model can be rejected upstream (e.g. flux.2-pro moderates a face+dress request);
    // fall back to the known-good model so a selfie still comes out, and say so in the log
    log(`image (openrouter): ${primary} failed (${first.error}) — retrying with ${fallback}`);
    const second = await viaOpenRouter({ model: fallback, prompt, aspect, images, timeoutSec });
    return second.ok ? second : first;
  }
  if (!/\/[a-z-]+$/i.test(String(model || ""))) return { ok: false, error: `model id needs a task suffix: ${model}` };
  const body = { model, prompt };
  if (aspect) body.aspect_ratio = aspect;
  if (resolution) body.resolution = resolution;
  if (images.length) body.images = images;
  const t0 = Date.now();
  try {
    const sub = await fetch(`${BASE()}/api/v1/model/generateImage`, {
      method: "POST",
      headers: HEADERS(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const sj = await sub.json();
    const id = sj?.data?.id || sj?.id;
    if ((sj.code && sj.code !== 200) || !id) {
      return { ok: false, error: `${sj.code || sub.status} ${sj.msg || ""}`.trim(), seconds: (Date.now() - t0) / 1000 };
    }
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));
      const r = await fetch(`${BASE()}/api/v1/model/prediction/${id}`, { headers: HEADERS(), signal: AbortSignal.timeout(30000) });
      const j = await r.json();
      const d = j.data || j;
      const status = String(d.status || "?");
      if (status === "completed" || status === "succeeded") {
        const url = [].concat(d.outputs || d.output || []).map((o) => (typeof o === "string" ? o : o?.url)).filter(Boolean)[0] || "";
        if (!url) return { ok: false, error: "no output url", seconds: (Date.now() - t0) / 1000 };
        const img = await fetch(url, { signal: AbortSignal.timeout(90000) });
        const buf = Buffer.from(await img.arrayBuffer());
        const seconds = Number(((Date.now() - t0) / 1000).toFixed(1));
        log(`image: ${model} → ${(buf.length / 1024).toFixed(0)} kb in ${seconds}s (${Number(d.price ?? 0).toFixed(3)})`);
        return { ok: true, buf, url, seconds, price: Number(d.price || 0) };
      }
      if (status === "failed" || status === "error") {
        return { ok: false, error: String(d.error || status).slice(0, 200), seconds: (Date.now() - t0) / 1000 };
      }
    }
    return { ok: false, error: "timed out waiting for the image", seconds: (Date.now() - t0) / 1000 };
  } catch (err) {
    return { ok: false, error: err.message.slice(0, 200), seconds: (Date.now() - t0) / 1000 };
  }
}

/** Write a generated buffer to disk, picking the extension from its magic bytes. */
export function writeImage(fileBase, buf) {
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  const file = `${fileBase}.${isPng ? "png" : "jpg"}`;
  fs.writeFileSync(file, buf);
  return file;
}
