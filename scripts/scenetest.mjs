/**
 * scenetest.mjs — the same five scenes through both chosen models, judged side by side.
 *
 * The scenario is set by Hik's decision that photos must match her place and her routine: Denpasar,
 * her desk, a warung at night, her cat, and two selfies (afternoon and night). Two of the five have
 * her face, which is the hard part — those are also checked against the avatar she ships with, so
 * identity drift is visible rather than assumed.
 *
 *   node scripts/scenetest.mjs [--scenes a,b,c] [--models m1,m2] [--out DIR]
 */
import fs from "node:fs";
import path from "node:path";
import { SCENES } from "./imagetest.mjs";
import { generateImage, writeImage } from "../src/image-engine.mjs";
import { avatarPath } from "../src/face.mjs";

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const OR = (fs.readFileSync(path.join(process.cwd(), ".env"), "utf8").match(/^OPENROUTER_API_KEY=(.+)$/m) || [])[1]?.trim();
const WANT = String(arg("scenes", "pagi-kerja,warung-malam,momo,selfie-siang,selfie-malam")).split(",").filter(Boolean);
const MODELS = String(arg("models", "google/nano-banana-pro/text-to-image-developer,bytedance/seedream-v5.0-pro/text-to-image")).split(",").filter(Boolean);
const OUT = arg("out", "/sdcard/Download/Understudy/scenario-test");
const JUDGE = arg("judge", "google/gemini-3.1-flash-lite");
const AVATAR = avatarPath("fiona");
// --reference: pakai foto asli sebagai acuan (base64, jadi tidak perlu hosting publik)
const REF_FILE = arg("reference", "");
const REF = REF_FILE && fs.existsSync(REF_FILE) ? `data:image/jpeg;base64,${fs.readFileSync(REF_FILE).toString("base64")}` : "";
const slug = (m) => m.replace(/[^\w.-]+/g, "_");
const short = (m) => m.split("/").slice(-2).join("/").replace(/\/text-to-image(-developer)?$/, "");

/** One call that scores the image, and — when she is in the frame — compares her to the avatar. */
async function judge(file, refFile) {
  const img = (f) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(f).toString("base64")}` } });
  const content = [];
  if (refFile) content.push(img(refFile));
  content.push(img(file));
  content.push({
    type: "text",
    text: `${
      refFile
        ? "Photo 1 is her approved face (her WhatsApp avatar). Photo 2 is a generated photo of the same character.\n"
        : ""
    }Photo ${refFile ? 2 : 1} is meant to be a casual photo a 20-year-old woman in Denpasar, Bali sent on WhatsApp: a normal phone snapshot, not a produced image.

Answer with JSON only:
{"score":0-10,"what":"what is actually in the photo, one line","real":"does it read as a real phone photo, one line","tells":["exact thing that gives it away"],${refFile ? '"same_person":"yes/no — is the person in photo 2 the woman in photo 1, one line",' : ""}"note":"one blunt sentence"}
Score 10 only if nothing in the frame would make anyone doubt it. A clean, shiny, professional or composed image is a low score even if it is pretty.`,
  });
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OR}` },
    signal: AbortSignal.timeout(90000),
    body: JSON.stringify({ model: JUDGE, max_tokens: 500, messages: [{ role: "user", content }] }),
  });
  const j = await r.json();
  const txt = j.choices?.[0]?.message?.content || "";
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return { score: null, tells: [], what: "", real: "", note: txt.slice(0, 160) };
  try {
    return JSON.parse(m[0]);
  } catch {
    return { score: null, tells: [], what: "", real: "", note: "unreadable verdict" };
  }
}

async function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const rows = [];
  for (const sceneName of WANT) {
    const scene = SCENES[sceneName];
    if (!scene) {
      console.log(`  ✗ unknown scene: ${sceneName}`);
      continue;
    }
    const hasFace = /selfie|portrait|wajah/i.test(sceneName);
    for (const model of MODELS) {
      process.stdout.write(`  ${sceneName.padEnd(14)} ${short(model).padEnd(26)} `);
      // dengan referensi: pakai prompt gaya edit, yang menyuruh menjaga wajahnya, bukan mendeskripsikannya
      const promptText = REF && scene.editPrompt ? scene.editPrompt : scene.prompt;
      const res = await generateImage({ model, prompt: promptText, aspect: scene.aspect, images: REF ? [REF] : [] });
      if (!res.ok) {
        console.log(`GAGAL (${res.error.slice(0, 50)})`);
        rows.push({ scene: sceneName, model, ok: false, error: res.error, hasFace });
        continue;
      }
      const file = writeImage(path.join(OUT, `${sceneName}-${slug(short(model))}`), res.buf);
      const v = await judge(file, hasFace && AVATAR ? AVATAR : null);
      console.log(`${String(Math.round(res.seconds) + "s").padEnd(5)} skor ${String(v.score ?? "?").padStart(2)}/10${hasFace ? `  identitas: ${String(v.same_person || "?").slice(0, 3)}` : ""}`);
      rows.push({
        scene: sceneName,
        model,
        modelShort: short(model),
        ok: true,
        seconds: res.seconds,
        price: res.price,
        kb: Math.round(res.buf.length / 1024),
        file: path.basename(file),
        url: res.url,
        hasFace,
        judge: v,
      });
    }
  }

  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ at: Date.now(), mode: REF ? "edit (reference image)" : "text-to-image", avatar: AVATAR, reference: REF_FILE, scenes: WANT, models: MODELS, rows }, null, 2));

  const md = [
    "# 5 skenario × 2 model pilihan Hik",
    "",
    `Model: ${MODELS.map((m) => `\`${m}\``).join(" · ")}`,
    "",
    AVATAR ? `Identitas dicek terhadap avatar yang diupload: \`${path.basename(AVATAR)}\`` : "Tidak ada avatar untuk dicek.",
    "",
    "| skenario | model | skor | identitas | apa yang kelihatan |",
    "|---|---|---|---|---|",
    ...rows.filter((r) => r.ok).map((r) => `| ${r.scene} | \`${short(r.model)}\` | **${r.judge?.score ?? "?"}/10** | ${r.hasFace ? String(r.judge?.same_person || "?").slice(0, 40) : "—"} | ${String(r.judge?.what || "").slice(0, 60)} |`),
    "",
    "## Yang bikin ketahuan",
    "",
    ...rows.filter((r) => r.ok).flatMap((r) => [
      `**${r.scene} — ${short(r.model)}** (${r.judge?.score ?? "?"}/10)`,
      `  catatan: ${r.judge?.note || "-"}`,
      ...((r.judge?.tells || []).slice(0, 3).map((t) => `  - ${t}`)),
      "",
    ]),
    ...rows.filter((r) => !r.ok).map((r) => `Gagal: ${r.scene} / ${short(r.model)} — ${r.error}`),
  ].join("\n");
  fs.writeFileSync(path.join(OUT, "results.md"), md);

  const byScene = WANT.map((s) => ({ scene: s, rows: rows.filter((r) => r.scene === s && r.ok) })).filter((s) => s.rows.length);
  const html = `<!doctype html><meta charset="utf-8"><title>5 skenario × 2 model</title>
<style>
body{background:#131109;color:#f3e6d2;font:15px/1.5 system-ui,sans-serif;margin:0;padding:20px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:26px 0 10px}sub{color:#b39a78}
p.sub{color:#b39a78;margin:0 0 16px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:700px){.pair{grid-template-columns:1fr}}
.card{background:#1c1810;border:1px solid #33291c;border-radius:14px;overflow:hidden}
.card img{width:100%;display:block;background:#000;aspect-ratio:4/3;object-fit:cover}
.card.face img{aspect-ratio:3/4}
.body{padding:10px 12px}
.m{font-weight:700;font-size:12.5px}
.sc{float:right;font-weight:800;padding:1px 9px;border-radius:9px;font-size:13px}
.s8,.s9,.s10{background:#1f4d2b;color:#a8f0bd}.s6,.s7{background:#4d3f14;color:#ffd479}.s0,.s1,.s2,.s3,.s4,.s5{background:#4d1a1a;color:#ff9a9a}
.q{font-size:12.5px;color:#e8d6bb;margin-top:6px}
.tells{margin:8px 0 0;padding-left:16px;color:#e2c9a5;font-size:12px}.tells li{margin:3px 0}
.id{font-size:12px;margin-top:6px;padding:5px 8px;border-radius:8px;background:#241e14;color:#ffcf9e}
.ref{display:flex;gap:12px;align-items:center;background:#1c1810;border:1px solid #33291c;border-radius:14px;padding:12px;margin-bottom:18px}
.ref img{width:84px;height:84px;border-radius:50%;object-fit:cover}
</style>
<h1>5 skenario × 2 model pilihanmu</h1>
<p class="sub">${REF ? "pakai FOTO ASLI sebagai referensi (mode edit) · " : ""}Prompt identik per skenario · juri vision yang sama · ${new Date().toLocaleString("id-ID")}</p>
${AVATAR ? `<div class="ref"><img src="${path.basename(AVATAR)}"><div><b>Avatar yang kamu upload</b><br><span style="color:#b39a78;font-size:13px">Dua skenario selfie dicek identitasnya terhadap foto ini — jadi kelihatan kalau wajahnya melenceng.</span></div></div>` : ""}
${byScene
  .map(
    (s) => `<h2>${s.scene}</h2><div class="pair">${s.rows
      .map(
        (r) => `<div class="card ${r.hasFace ? "face" : ""}">
  <img src="${r.file}" loading="lazy">
  <div class="body"><div class="m">${short(r.model)}<span class="sc s${r.judge?.score ?? 0}">${r.judge?.score ?? "?"}/10</span>
    <div class="m" style="color:#b39a78;font-weight:500;font-size:11.5px;margin-top:3px">$${(r.price || 0).toFixed(3)} · ${r.seconds}s · ${r.kb} KB</div></div>
  <div class="q">${String(r.judge?.what || "")}</div>
  ${r.hasFace && r.judge?.same_person ? `<div class="id">identitas: ${String(r.judge.same_person).slice(0, 150)}</div>` : ""}
  ${(r.judge?.tells || []).length ? `<ul class="tells">${r.judge.tells.map((t) => `<li>${String(t)}</li>`).join("")}</ul>` : ""}
  </div></div>`,
      )
      .join("")}</div>`,
  )
  .join("")}
`;
  fs.writeFileSync(path.join(OUT, "index.html"), html);
  if (AVATAR && fs.existsSync(AVATAR)) fs.copyFileSync(AVATAR, path.join(OUT, path.basename(AVATAR)));

  if (REF_FILE) console.log(`\n  referensi: ${path.basename(REF_FILE)} (${Math.round(REF.length/1024)} kb base64)`);
  console.log(`\n  hasil di ${OUT}`);
  console.log(`  ${OUT}/index.html`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
