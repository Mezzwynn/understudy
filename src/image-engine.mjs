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

export const imageEngineReady = () => !!config.atlasApiKey;

/**
 * Generate one image. Returns { ok, buf, url, seconds, price } — or { ok: false, error }.
 * `images` (public URLs) turns a text-to-image model call into an edit against a reference.
 */
export async function generateImage({ model, prompt, aspect = "1:1", images = [], resolution = "1k", timeoutSec = 180 }) {
  if (!imageEngineReady()) return { ok: false, error: "ATLAS_API_KEY is not set" };
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
