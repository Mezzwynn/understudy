/**
 * imagetest.mjs — put the same photo prompt through several image models and judge them.
 *
 * The point is comparability: one prompt, one reviewer, one verdict format. Every image goes
 * out to a folder with its price, its generation time and the judge's reading, so the choice
 * of engine is made by looking at results instead of by trusting a model card.
 *
 * Usage:
 *   node scripts/imagetest.mjs --scene selfie --models a,b,c [--out DIR]
 */
import fs from "node:fs";
import path from "node:path";

const KEY = (fs.readFileSync(path.join(process.cwd(), ".env"), "utf8").match(/^ATLAS_API_KEY=(.+)$/m) || [])[1]?.trim();
const OR = (fs.readFileSync(path.join(process.cwd(), ".env"), "utf8").match(/^OPENROUTER_API_KEY=(.+)$/m) || [])[1]?.trim();
const BASE = "https://api.atlascloud.ai";
const H = { authorization: `Bearer ${KEY}`, "content-type": "application/json", "X-Atlas-Client": "understudy" };

/** The two scenes that matter: a face, and an ordinary table. */
export const SCENES = {
  selfie: {
    aspect: "3:4",
    prompt: `A candid front-camera selfie taken by a slim 20-year-old Indonesian woman in Denpasar, Bali.
Shoulder-length straight black hair, plain oversized white shirt, no makeup, flat unimpressed expression,
no smile, visible skin texture and a small mole on her left cheek, slightly tired eyes. Indoor daylight
from a window on the left, ordinary room wall behind her, mildly noisy phone sensor, slightly crooked
framing, imperfect and unposed. A real phone snapshot sent to a friend, not a produced photo.
No text, no watermark.`,
  },
  warung: {
    aspect: "4:3",
    prompt: `A casual phone photo taken by a 20-year-old in Denpasar, Bali at 10am: an iced coffee in a plastic
cup with condensation, a half-eaten plate of pisang goreng, and a closed laptop on a wooden table,
photographed from slightly above at an angle, no people and no hands in frame. Harsh morning daylight
through a window, hard shadow across the table, slightly crooked framing, mild sensor noise, a few crumbs
and a hair tie on the table, not tidy. A normal snapshot sent to a friend, not a produced photo.
No text, no watermark.`,
  },
};

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const sceneName = arg("scene", "selfie");
const scene = SCENES[sceneName];
const MODELS = String(arg("models", "")).split(",").filter(Boolean);
const OUT = arg("out", `/sdcard/Download/Understudy/model-test`);
const JUDGE = arg("judge", "google/gemini-3.1-flash-lite");
if (!KEY) throw new Error("ATLAS_API_KEY missing from .env");
if (!scene) throw new Error(`unknown scene ${sceneName}`);
if (!MODELS.length) throw new Error("--models is required");

const slug = (m) => m.replace(/[^\w.-]+/g, "_");

async function catalog() {
  const cache = path.join(process.cwd(), "data", "_models.json");
  if (fs.existsSync(cache) && Date.now() - fs.statSync(cache).mtimeMs < 3600e3) return JSON.parse(fs.readFileSync(cache, "utf8"));
  const r = await fetch(`${BASE}/api/v1/models`, { headers: H, signal: AbortSignal.timeout(45000) });
  const j = await r.json();
  const data = j.data || j;
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, JSON.stringify(data));
  return data;
}

/** Read the model's own OpenAPI schema instead of guessing its parameters. */
async function schemaFor(model) {
  const cat = await catalog();
  const entry = cat.find((m) => m.model === model);
  if (!entry) return { props: {}, required: [], price: 0, display: model, found: false };
  let props = {};
  let required = [];
  if (entry.schema) {
    try {
      const r = await fetch(entry.schema, { signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      const input = j?.components?.schemas?.Input || {};
      props = input.properties || {};
      required = input.required || [];
    } catch {
      /* schema is a convenience, not a requirement */
    }
  }
  return {
    props,
    required,
    price: Number(entry.price?.actual?.base_price || 0),
    display: entry.displayName || model,
    found: true,
  };
}

async function generate(model, meta) {
  const body = { model, prompt: scene.prompt };
  for (const key of meta.required) {
    if (key === "model" || key === "prompt") continue;
    if (key === "images") body.images = [];
    else if (key === "video_clips") body.video_clips = [];
  }
  if (meta.props.aspect_ratio) body.aspect_ratio = scene.aspect;
  if (meta.props.resolution) body.resolution = "1k";
  const t0 = Date.now();
  const sub = await fetch(`${BASE}/api/v1/model/generateImage`, { method: "POST", headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const sj = await sub.json();
  if ((sj.code && sj.code !== 200) || !(sj?.data?.id || sj?.id)) {
    return { ok: false, error: JSON.stringify(sj).slice(0, 200), seconds: (Date.now() - t0) / 1000 };
  }
  const id = sj.data?.id || sj.id;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const r = await fetch(`${BASE}/api/v1/model/prediction/${id}`, { headers: H, signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    const d = j.data || j;
    const st = String(d.status || "?");
    if (st === "completed" || st === "succeeded") {
      const url = [].concat(d.outputs || d.output || []).map((o) => (typeof o === "string" ? o : o?.url)).filter(Boolean)[0] || "";
      if (!url) return { ok: false, error: "no output url", seconds: (Date.now() - t0) / 1000 };
      const img = await fetch(url, { signal: AbortSignal.timeout(90000) });
      const buf = Buffer.from(await img.arrayBuffer());
      return { ok: true, buf, url, seconds: (Date.now() - t0) / 1000, billed: d.price ?? null };
    }
    if (st === "failed" || st === "error") return { ok: false, error: String(d.error || st).slice(0, 200), seconds: (Date.now() - t0) / 1000 };
  }
  return { ok: false, error: "timeout", seconds: (Date.now() - t0) / 1000 };
}

/** The same blunt reviewer used for everything else, asked in the same words every time. */
async function judge(file, model) {
  const b64 = fs.readFileSync(file).toString("base64");
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OR}` },
    signal: AbortSignal.timeout(60000),
    body: JSON.stringify({
      model: JUDGE,
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
            {
              type: "text",
              text: `This is meant to be a casual photo a 20-year-old woman in Denpasar, Bali sent on WhatsApp: a normal phone snapshot, not a produced image. Answer with JSON only:
{"score":0-10,"what":"what is actually in the photo, one line","real":"does it read as a real phone photo, one line","tells":["exact thing that gives it away", "..."]}
Score 10 only if nothing in the frame would make anyone doubt it. Be blunt; a produced, clean, professional or shiny image is a low score even if it is pretty.`,
            },
          ],
        },
      ],
    }),
  });
  const j = await r.json();
  const txt = j.choices?.[0]?.message?.content || "";
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return { score: null, tells: [], real: "", what: "", raw: txt.slice(0, 200), model };
  try {
    return { ...JSON.parse(m[0]), model, judge: JUDGE };
  } catch {
    return { score: null, tells: [], real: "", what: "", raw: txt.slice(0, 200), model };
  }
}

async function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const results = [];
  console.log(`  scene: ${sceneName} · ${MODELS.length} model · hasil ke ${OUT}\n`);
  for (const model of MODELS) {
    const meta = await schemaFor(model);
    if (!meta.found) {
      console.log(`  ✗ ${model} — tidak ada di katalog`);
      results.push({ model, ok: false, error: "not in catalogue" });
      continue;
    }
    process.stdout.write(`  ${model.padEnd(46)} $${meta.price.toFixed(3).padEnd(6)} `);
    const gen = await generate(model, meta);
    if (!gen.ok) {
      console.log(`GAGAL (${gen.error.slice(0, 60)})`);
      results.push({ model, display: meta.display, price: meta.price, ok: false, error: gen.error, seconds: gen.seconds });
      continue;
    }
    const file = path.join(OUT, `${sceneName}-${slug(model)}.jpg`);
    fs.writeFileSync(file, gen.buf);
    const v = await judge(file, model);
    console.log(`${String(gen.seconds.toFixed(0) + "s").padEnd(5)} skor ${String(v.score ?? "?").padStart(2)}/10  ${String(v.what || "").slice(0, 40)}`);
    results.push({
      model,
      display: meta.display,
      price: meta.price,
      ok: true,
      seconds: Number(gen.seconds.toFixed(1)),
      kb: Math.round(gen.buf.length / 1024),
      url: gen.url,
      file: path.basename(file),
      judge: { score: v.score, what: v.what, real: v.real, tells: v.tells || [] },
    });
  }

  const byScore = [...results].filter((r) => r.ok).sort((a, b) => (b.judge?.score ?? 0) - (a.judge?.score ?? 0));
  fs.writeFileSync(path.join(OUT, `results-${sceneName}.json`), JSON.stringify({ scene: sceneName, prompt: scene.prompt, at: Date.now(), results }, null, 2));

  const md = [
    `# Image model test — ${sceneName}`,
    "",
    `Prompt used for every model (identical, no per-model tuning):`,
    "",
    "```",
    scene.prompt.trim(),
    "```",
    "",
    `Judge: \`${JUDGE}\` — "score 10 only if nothing in the frame would make anyone doubt it".`,
    "",
    "| model | $/image | time | judge | what it actually produced |",
    "|---|---|---|---|---|",
    ...byScore.map((r) => `| \`${r.model}\` | $${r.price.toFixed(3)} | ${r.seconds}s | **${r.judge?.score ?? "?"}/10** | ${String(r.judge?.what || "").replace(/\|/g, "/").slice(0, 70)} |`),
    "",
    "## What the judge said gives them away",
    "",
    ...byScore.flatMap((r) => [
      `**${r.model}** — ${r.judge?.score ?? "?"}/10 · ${String(r.judge?.real || "").slice(0, 90)}`,
      ...((r.judge?.tells || []).slice(0, 4).map((t) => `  - ${t}`)),
      "",
    ]),
    ...results.filter((r) => !r.ok).map((r) => `Failed: \`${r.model}\` — ${r.error}`),
  ].join("\n");
  fs.writeFileSync(path.join(OUT, `results-${sceneName}.md`), md);

  const html = `<!doctype html><meta charset="utf-8"><title>Image models — ${sceneName}</title>
<style>
body{background:#131109;color:#f3e6d2;font:15px/1.5 system-ui,sans-serif;margin:0;padding:22px}
h1{font-size:20px;margin:0 0 6px}p.sub{color:#b39a78;margin:0 0 18px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
.card{background:#1c1810;border:1px solid #33291c;border-radius:14px;overflow:hidden}
.card img{width:100%;display:block;background:#000}
.body{padding:10px 12px}
.model{font-weight:700;font-size:13px;word-break:break-all}
.row{display:flex;gap:8px;align-items:center;margin:6px 0;font-size:12px;color:#b39a78}
.score{margin-left:auto;font-size:16px;font-weight:800;padding:1px 9px;border-radius:9px}
.s8,.s9,.s10{background:#1f4d2b;color:#a8f0bd}.s6,.s7{background:#4d3f14;color:#ffd479}.s0,.s1,.s2,.s3,.s4,.s5{background:#4d1a1a;color:#ff9a9a}
.tells{margin:8px 0 0;padding-left:16px;color:#e2c9a5;font-size:12px}
.tells li{margin:3px 0}
.prompt{white-space:pre-wrap;background:#1c1810;border:1px solid #33291c;border-radius:12px;padding:12px;color:#c9b191;font-size:12px;margin-bottom:18px}
a{color:#ffb257}
</style>
<h1>Image models — ${sceneName}</h1>
<p class="sub">Satu prompt identik untuk semua model · dinilai juri vision yang sama · ${new Date().toLocaleString("id-ID")}</p>
<div class="prompt">${scene.prompt.trim().replace(/</g, "&lt;")}</div>
<div class="grid">
${byScore.map((r) => `<div class="card">
  <img src="${r.file}" loading="lazy">
  <div class="body">
    <div class="model">${r.model}</div>
    <div class="row"><span>$${r.price.toFixed(3)}</span><span>${r.seconds}s</span><span>${r.kb} KB</span><span class="score s${r.judge?.score ?? 0}">${r.judge?.score ?? "?"}/10</span></div>
    <div style="font-size:12.5px;color:#e8d6bb">${String(r.judge?.what || "").replace(/</g, "&lt;")}</div>
    ${r.judge?.real ? `<div style="font-size:12px;color:#b39a78;margin-top:6px">${r.judge.real.replace(/</g, "&lt;")}</div>` : ""}
    ${(r.judge?.tells || []).length ? `<ul class="tells">${r.judge.tells.map((t) => `<li>${String(t).replace(/</g, "&lt;")}</li>`).join("")}</ul>` : ""}
  </div></div>`).join("")}
</div>
${results.filter((r) => !r.ok).length ? `<h1 style="margin-top:26px">Gagal</h1><ul class="tells">${results.filter((r) => !r.ok).map((r) => `<li>${r.model} — ${r.error}</li>`).join("")}</ul>` : ""}
`;
  fs.writeFileSync(path.join(OUT, `index-${sceneName}.html`), html);

  console.log(`\n  peringkat (${sceneName}):`);
  for (const r of byScore) console.log(`   ${String(r.judge?.score ?? "?").padStart(2)}/10  $${r.price.toFixed(3).padEnd(6)} ${r.seconds}s  ${r.model}`);
  console.log(`\n  ${OUT}/index-${sceneName}.html`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
