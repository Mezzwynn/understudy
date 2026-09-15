/**
 * humanize.mjs — take the shine off a generated photo.
 *
 * The judge said the same thing about every image in the last run: *"too technically perfect"*,
 * *"flawless skin"*, *"looks like high-quality AI photography for an ad or portfolio rather than a
 * casual snapshot"*. That is not a prompt problem you can fully fix by asking — asking produces
 * clean images with better manners. The finish has to be taken off afterwards, which is what a
 * phone already does to every real photo: downscale, compress hard, and leave a little noise.
 *
 * Everything runs locally with pure-JS codecs (jpeg-js, pngjs): no upload, no cost, no service.
 */
import jpeg from "jpeg-js";
import { PNG } from "pngjs";

const decode = (buf) => {
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    const p = PNG.sync.read(buf);
    return { width: p.width, height: p.height, data: p.data };
  }
  return jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
};

/** Deterministic pseudo-random in [0,1) so the same photo always gets the same grain. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

/** Box-filter downscale — soft enough to lose micro-detail, which is the point. */
function downscale(img, maxSide) {
  const { width: w, height: h, data } = img;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  if (scale >= 1) return img;
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const out = Buffer.alloc(nw * nh * 4);
  const step = w / nw;
  for (let y = 0; y < nh; y++) {
    const sy0 = Math.floor(y * (h / nh));
    const sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * (h / nh)));
    for (let x = 0; x < nw; x++) {
      const sx0 = Math.floor(x * step);
      const sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * step));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * w + sx) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n++;
        }
      }
      const o = (y * nw + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { width: nw, height: nh, data: out };
}

/** One pass of a 3x3 box blur — cheap, and it takes the razor edge off a generated photo. */
function boxBlur(img, radius = 1) {
  const { width: w, height: h, data } = img;
  const out = Buffer.alloc(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const i = (yy * w + xx) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * @param {Buffer} buf        a jpeg or png
 * @param {object} opts       maxSide: longest edge after downscaling (a phone photo is not 4k)
 *                            quality: jpeg quality; WhatsApp re-compresses, so start low
 *                            grain: luminance noise amplitude; 1-2 is visible but not dirty
 *                            warmth / lift: small colour and black-level nudges
 */
/**
 * Targets measured from real photos taken on this phone (see scripts/photostats.mjs):
 *   contrast 43 · saturation 26 · noise 2.2 · sharpness 4.0
 * A generated photo arrives around contrast 70-75, saturation 30-34, noise 1.0-2.0. The gap in
 * contrast is the one the eye reads as "clean and shiny", so it is pulled towards the real number
 * rather than guessed at with a filter.
 */
/**
 * Camera profiles. "which phone is she using" is not cosmetic: a Pixel and an Oppo do not produce the
 * same photo, and a character's photos should all come from one phone she owns.
 *   grain     — sensor noise amplitude
 *   bloom     — how much bright highlights glow into their surroundings (cheap lenses glow)
 *   contrast / saturation — pulled towards these instead of the generic target
 *   warmth    — red up, blue down
 */
export const PHONE_PROFILES = {
  pixel: { label: "Pixel (seimbang, sedikit berbutir)", grain: 10, bloom: 0.06, contrast: 46, saturation: 27, warmth: 3 },
  iphone: { label: "iPhone (kontras, dingin, tajam)", grain: 7, bloom: 0.04, contrast: 52, saturation: 25, warmth: 0 },
  samsung: { label: "Samsung (terang, saturasi tinggi)", grain: 8, bloom: 0.09, contrast: 50, saturation: 33, warmth: 2 },
  oppo: { label: "Oppo (hangat, highlight glowing)", grain: 11, bloom: 0.14, contrast: 44, saturation: 30, warmth: 6 },
  vivo: { label: "Vivo (hangat, kulit halus)", grain: 12, bloom: 0.13, contrast: 45, saturation: 31, warmth: 7 },
  xiaomi: { label: "Xiaomi (kontras, hangat)", grain: 9, bloom: 0.08, contrast: 49, saturation: 29, warmth: 4 },
  biasa: { label: "HP biasa (berbutir, apa adanya)", grain: 14, bloom: 0.10, contrast: 43, saturation: 26, warmth: 4 },
};

export const profileFor = (name) => PHONE_PROFILES[String(name || "").toLowerCase()] || null;

export const REAL_PHOTO_TARGET = { contrast: 46, saturation: 27, noise: 2.2 };

export function humanize(buf, { maxSide = 1280, quality = 74, grain = null, warmth = null, lift = 2, seed = 7, calibrate = true, bloom = null, profile = null, soften = true, vignette = 0.16, chroma = 0.55 } = {}) {
  const prof = profileFor(profile);
  if (prof) {
    grain = grain ?? prof.grain;
    warmth = warmth ?? prof.warmth;
    bloom = bloom ?? prof.bloom;
  }
  warmth = warmth ?? 3;
  bloom = bloom ?? 0.06;
  let small = downscale(decode(buf), maxSide);
  // a phone lens is never tack sharp: one soft pass kills the AI "crispness"
  if (soften) small = boxBlur(small, 1);
  const { width: w, height: h, data } = small;
  const grainAmount = grain === null ? 10 : grain; // enough noise to land near a real photo
  const target = { contrast: prof?.contrast ?? REAL_PHOTO_TARGET.contrast, saturation: prof?.saturation ?? REAL_PHOTO_TARGET.saturation };
  const rand = rng(seed);
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const n = (rand() - 0.5) * 2 * grainAmount;
      // chroma noise: sensors add colour noise in the shadows, AI never does
      const nr = (rand() - 0.5) * 2 * grainAmount * chroma;
      const ng = (rand() - 0.5) * 2 * grainAmount * chroma;
      const nb = (rand() - 0.5) * 2 * grainAmount * chroma;
      out[i] = Math.max(0, Math.min(255, data[i] + warmth + n + nr + lift));
      out[i + 1] = Math.max(0, Math.min(255, data[i + 1] + n * 0.9 + ng + lift));
      out[i + 2] = Math.max(0, Math.min(255, data[i + 2] - warmth * 0.5 + n * 0.8 + nb + lift));
      out[i + 3] = 255;
    }
  }
  // bloom: bright areas bleed into their surroundings, the way a small phone lens does
  if (bloom > 0) {
    const src = Buffer.from(out);
    const blur = new Float32Array(w * h);
    const radius = 3;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let n = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const i = (yy * w + xx) * 4;
            sum += 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
            n++;
          }
        }
        blur[y * w + x] = sum / Math.max(1, n);
      }
    }
    for (let i = 0, p = 0; i < out.length; i += 4, p++) {
      const y0 = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
      if (y0 < 150) continue; // only highlights bloom
      const amount = ((y0 - 150) / 105) * bloom * 255;
      for (let c = 0; c < 3; c++) out[i + c] = Math.max(0, Math.min(255, out[i + c] + amount * (blur[p] / 255)));
    }
  }

  // vignette: every small phone lens darkens the corners a little
  if (vignette > 0) {
    const cx = w / 2;
    const cy = h / 2;
    const maxD = Math.sqrt(cx * cx + cy * cy) || 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)) / maxD;
        const f = 1 - vignette * d * d;
        const i = (y * w + x) * 4;
        out[i] *= f;
        out[i + 1] *= f;
        out[i + 2] *= f;
      }
    }
  }

  // pull contrast and saturation towards what a real phone photo measures
  if (calibrate) {
    const grab = (src) => {
      let sum = 0;
      let sumSq = 0;
      let satSum = 0;
      const n = src.length / 4;
      for (let i = 0; i < src.length; i += 4) {
        const y = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
        sum += y;
        sumSq += y * y;
        const mx = Math.max(src[i], src[i + 1], src[i + 2]);
        const mn = Math.min(src[i], src[i + 1], src[i + 2]);
        satSum += mx === 0 ? 0 : (mx - mn) / mx;
      }
      return { mean: sum / n, contrast: Math.sqrt(Math.max(0, sumSq / n - (sum / n) ** 2)), saturation: (satSum / n) * 100 };
    };
    const now = grab(out);
    const cScale = Math.min(1.2, Math.max(0.4, target.contrast / Math.max(1, now.contrast)));
    const sScale = Math.min(1.8, Math.max(0.6, target.saturation / Math.max(1, now.saturation)));
    // contrast first, saturation second — the other order drops saturation twice
    for (let i = 0; i < out.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        out[i + c] = Math.max(0, Math.min(255, now.mean + (out[i + c] - now.mean) * cScale));
      }
    }
    const after = grab(out);
    const s2 = Math.min(1.8, Math.max(0.5, target.saturation / Math.max(1, after.saturation)));
    for (let i = 0; i < out.length; i += 4) {
      const grey = 0.299 * out[i] + 0.587 * out[i + 1] + 0.114 * out[i + 2];
      for (let c = 0; c < 3; c++) {
        out[i + c] = Math.max(0, Math.min(255, grey + (out[i + c] - grey) * s2));
      }
    }
  }

  let encoded = jpeg.encode({ data: out, width: w, height: h }, quality);

  // JPEG itself pulls saturation and contrast down again, so measure the ENCODED result and correct
  // once — measuring the in-memory buffer overstated it and the photos came out washed out
  if (calibrate) {
    const back = decode(encoded.data);
    const fin = (() => {
      let sum = 0;
      let sumSq = 0;
      let satSum = 0;
      const n = back.data.length / 4;
      for (let i = 0; i < back.data.length; i += 4) {
        const y = 0.299 * back.data[i] + 0.587 * back.data[i + 1] + 0.114 * back.data[i + 2];
        sum += y;
        sumSq += y * y;
        const mx = Math.max(back.data[i], back.data[i + 1], back.data[i + 2]);
        const mn = Math.min(back.data[i], back.data[i + 1], back.data[i + 2]);
        satSum += mx === 0 ? 0 : (mx - mn) / mx;
      }
      return { mean: sum / n, contrast: Math.sqrt(Math.max(0, sumSq / n - (sum / n) ** 2)), saturation: (satSum / n) * 100 };
    })();
    const cFix = Math.min(1.8, Math.max(0.6, target.contrast / Math.max(1, fin.contrast)));
    const sFix = Math.min(2.4, Math.max(0.7, target.saturation / Math.max(1, fin.saturation)));
    if (Math.abs(1 - cFix) > 0.05 || Math.abs(1 - sFix) > 0.05) {
      const fixed = Buffer.alloc(back.data.length);
      for (let i = 0; i < back.data.length; i += 4) {
        const grey = 0.299 * back.data[i] + 0.587 * back.data[i + 1] + 0.114 * back.data[i + 2];
        for (let c = 0; c < 3; c++) {
          const satAdj = grey + (back.data[i + c] - grey) * sFix;
          fixed[i + c] = Math.max(0, Math.min(255, fin.mean + (satAdj - fin.mean) * cFix));
        }
        fixed[i + 3] = 255;
      }
      encoded = jpeg.encode({ data: fixed, width: back.width, height: back.height }, quality);
    }
  }
  return { buf: encoded.data, width: w, height: h, kb: Math.round(encoded.data.length / 1024) };
}

export const __humanizeInternals = { decode, downscale };
