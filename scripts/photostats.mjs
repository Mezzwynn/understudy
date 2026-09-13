/**
 * photostats.mjs — measure a photo instead of asking a language model about it.
 *
 * A language model praises images: asked to score "does this look like a real person", it gave
 * 10/10 to photos Hik rejected on sight. So the useful comparison is numeric, and it is against
 * real photos taken on a real phone, which is the thing we are trying to look like.
 *
 * Everything here runs locally. Nothing is uploaded.
 *
 * Usage:
 *   node scripts/photostats.mjs <files...>            # table of measurements
 *   node scripts/photostats.mjs --compare <dir> ...   # rank a folder against a baseline
 */
import fs from "node:fs";
import path from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";

const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

/** One pass over the pixels, gathering everything we can cheaply know. */
export function stats(file) {
  const buf = fs.readFileSync(file);
  // the models do not all produce jpeg — nano-banana and qwen return png
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  const raw = isPng
    ? (() => {
        const p = PNG.sync.read(buf);
        return { width: p.width, height: p.height, data: new Uint8Array(p.data) };
      })()
    : jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  const { width: w, height: h, data } = raw;
  const n = w * h;
  let sum = 0;
  let sumSq = 0;
  let satSum = 0;
  let satSq = 0;
  let clipLow = 0;
  let clipHigh = 0;
  // colourfulness (Hasler & Süsstrunk)
  let rgSum = 0;
  let ybSum = 0;
  let rgSq = 0;
  let ybSq = 0;
  let rgYb = 0;
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const y = luma(r, g, b);
    gray[i] = y;
    sum += y;
    sumSq += y * y;
    if (y < 6) clipLow++;
    if (y > 249) clipHigh++;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const s = mx === 0 ? 0 : (mx - mn) / mx;
    satSum += s;
    satSq += s * s;
    const rg = Math.abs(r - g);
    const yb = Math.abs(0.5 * (r + g) - b);
    rgSum += rg;
    ybSum += yb;
    rgSq += rg * rg;
    ybSq += yb * yb;
    rgYb += rg * yb;
  }
  const mean = sum / n;
  const contrast = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  const satMean = satSum / n;
  const satSd = Math.sqrt(Math.max(0, satSq / n - satMean * satMean));
  const mRg = rgSum / n;
  const mYb = ybSum / n;
  const colorfulness = Math.sqrt(Math.max(0, rgSq / n - mRg * mRg) + Math.max(0, ybSq / n - mYb * mYb)) + 0.3 * Math.sqrt(mRg * mRg + mYb * mYb);

  // second pass: laplacian energy (sharpness) and residual noise in flat areas
  let lapSum = 0;
  let lapCount = 0;
  const flatResiduals = [];
  for (let y = 1; y < h - 1; y += 2) {
    for (let x = 1; x < w - 1; x += 2) {
      const i = y * w + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      const a = Math.abs(lap);
      lapSum += a;
      lapCount++;
      const gx = Math.abs(gray[i + 1] - gray[i - 1]);
      const gy = Math.abs(gray[i + w] - gray[i - w]);
      if (gx + gy < 3) flatResiduals.push(a); // a flat patch: anything here is noise
    }
  }
  flatResiduals.sort((a, b) => a - b);
  const median = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : 0);

  return {
    file: path.basename(file),
    kb: Math.round(fs.statSync(file).size / 1024),
    mp: Number(((w * h) / 1e6).toFixed(2)),
    brightness: Number(mean.toFixed(1)),
    contrast: Number(contrast.toFixed(1)),
    saturation: Number((satMean * 100).toFixed(1)),
    satSd: Number((satSd * 100).toFixed(1)),
    colorfulness: Number(colorfulness.toFixed(1)),
    sharpness: Number((lapSum / Math.max(1, lapCount)).toFixed(2)),
    noise: Number(median(flatResiduals).toFixed(2)),
    clipped: Number((((clipLow + clipHigh) / n) * 100).toFixed(2)),
  };
}

/** How far a photo is from the look of a real phone camera. */
export function polishScore(s, base) {
  const rel = (v, m) => (m ? v / m : 1);
  const parts = {
    saturation: rel(s.saturation, base.saturation),
    colorfulness: rel(s.colorfulness, base.colorfulness),
    contrast: rel(s.contrast, base.contrast),
    smoothness: base.noise ? Math.max(0, 1 - s.noise / base.noise) : 0,
    sharpness: rel(s.sharpness, base.sharpness),
  };
  // over-saturated, over-colourful, too smooth and over-sharp all mean "produced"
  const excess = [
    Math.max(0, parts.saturation - 1),
    Math.max(0, parts.colorfulness - 1) * 1.4,
    Math.max(0, parts.contrast - 1) * 0.8,
    parts.smoothness * 1.6,
    Math.max(0, parts.sharpness - 1) * 0.6,
  ].reduce((a, b) => a + b, 0);
  return Number((excess * 100).toFixed(0));
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
const args = isMain ? process.argv.slice(2) : [];
const files = args.filter((a) => !a.startsWith("--"));
if (!isMain) {
  // imported as a module: nothing to print
} else if (!files.length) {
  console.log("  pakai: node scripts/photostats.mjs <file> [file...]");
  process.exit(0);
}
if (isMain) {
  const rows = files.map((f) => {
    try {
      return stats(f);
    } catch (err) {
      return { file: path.basename(f), error: err.message.slice(0, 60) };
    }
  });
  const ok = rows.filter((r) => !r.error);
  console.log(
    "  " +
      ["file", "mp", "terang", "kontras", "sat", "warna", "tajam", "noise", "polos%"].map((h, i) => h.padEnd([34, 5, 7, 8, 6, 7, 7, 7, 7][i])).join(""),
  );
  for (const r of rows) {
    if (r.error) {
      console.log(`  ${r.file.slice(0, 32).padEnd(34)} GAGAL ${r.error}`);
      continue;
    }
    console.log(
      "  " +
        [
          r.file.slice(0, 32).padEnd(34),
          String(r.mp).padEnd(5),
          String(r.brightness).padEnd(7),
          String(r.contrast).padEnd(8),
          String(r.saturation).padEnd(6),
          String(r.colorfulness).padEnd(7),
          String(r.sharpness).padEnd(7),
          String(r.noise).padEnd(7),
          String(r.clipped).padEnd(7),
        ].join(""),
    );
  }
  const avg = (k) => (ok.length ? Number((ok.reduce((a, r) => a + r[k], 0) / ok.length).toFixed(1)) : 0);
  console.log(`\n  rata-rata: kontras ${avg("contrast")} · saturasi ${avg("saturation")}% · warna ${avg("colorfulness")} · tajam ${avg("sharpness")} · noise ${avg("noise")}`);

}
