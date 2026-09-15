import http from "node:http";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT, PERSONA_DIR, DATA_DIR, config, envGet, STARTED_AT, log, reloadConfig } from "./config.mjs";

/** Where the model-comparison photos live — the rating page reads and serves them. */
/**
 * The settings the panel renders, taken from the switch list and read straight from .env.
 * Hand-listing them was the bug behind "it resets a few seconds later": the card saves fine, the panel then
 * refreshes from this payload, and any key missing here came back empty and overwrote what was on screen.
 */
function panelSettings() {
  // Everything the photos tab renders. The three model keys do not start with PHOTO_, which is how they
  // ended up missing from the payload and the panel drew them empty.
  const MODEL_KEYS = ["IMAGE_ENGINE", "FACE_MODEL", "SCENE_MODEL", "EDIT_MODEL"];
  const wanted = (k) => k.startsWith("PHOTO_") || k.startsWith("SELFIE_") || MODEL_KEYS.includes(k);
  return Object.fromEntries(
    FEATURES.filter((f) => wanted(f.key)).map((f) => {
      const raw = envGet(f.key, f.def);
      // .env holds strings. "false" is a truthy string, so a switch rendered from it came back ON after every
      // save — the panel redrew itself from these values and the toggle looked like it reset itself.
      if (f.kind === "bool") return [f.key, /^(1|true|on|yes)$/i.test(String(raw))];
      if (f.kind === "int" || f.kind === "float") return [f.key, Number(raw)];
      return [f.key, raw];
    }),
  );
}

/** The photo rules in one line, for the panel to show. */
function photoRule() {
  return `izin per kontak · library ${config.photoLibrary ? "on" : "off"} · belajar ${config.photoLearn ? "on" : "off"}`;
}

const PHOTO_TEST_DIR = envGet("PHOTO_TEST_DIR", "/sdcard/Download/Understudy/model-test");
/** Semua folder hasil tes foto: dinilai dalam satu halaman. */
const PHOTO_TEST_DIRS = envGet("PHOTO_TEST_DIRS", "model-test,scenario-test,face-test")
  .split(",")
  .map((d) => path.join("/sdcard/Download/Understudy", d.trim()))
  .filter(Boolean);

/** Hik's verdicts on generated photos: the ground truth for the photo pipeline. */
const ratingsFile = () => path.join(DATA_DIR, "photos", "ratings.json");
function readRatings() {
  try {
    return JSON.parse(fs.readFileSync(ratingsFile(), "utf8"));
  } catch {
    return { ratings: [] };
  }
}
function writeRating(entry) {
  const store = readRatings();
  store.ratings = (store.ratings || []).filter((r) => r.file !== entry.file);
  store.ratings.push(entry);
  fs.mkdirSync(path.dirname(ratingsFile()), { recursive: true });
  fs.writeFileSync(ratingsFile(), JSON.stringify(store, null, 2));
  return store.ratings.length;
}

import { listChats, loadChat, saveChat, loadState } from "./store.mjs";
import { loadPersona, parsePersonaFrontmatter } from "./prompt.mjs";
import { librarySummary, loadLibrary, pickPhoto, removePhoto, markSent, photoHistory, rateSent, sceneScores } from "./photo-library.mjs";
import { PHONE_PROFILES } from "./humanize.mjs";
import { wardrobeFor, loadWardrobe, addWardrobeItem, updateWardrobeItem, removeWardrobeItem, setWardrobeImage, TIMES, STYLES } from "./photos.mjs";
import { selfieSettings, selfieMoments, makeSelfie, generateSelfieReason, poseRefGroups, FRAMING_GROUPS } from "./selfie.mjs";
import { describeOutfit } from "./photo-check.mjs";
import {
  loadFace,
  saveFace,
  faceDir,
  candidatesDir,
  listCandidates,
  avatarPath,
  facePrompt,
  generateCandidates,
  approveCandidate,
  rejectCandidate,
  pushAvatar,
  currentAvatarUrl,
} from "./face.mjs";
import { runAdmin } from "./admin.mjs";
import { exportPersona, importPersona, deletePersona, listSlugs, trashContents, restoreFromTrash } from "./persona-io.mjs";
import { tierOf, strangerState, unblock } from "./stranger.mjs";
import { loadPause, pauseFor, resume as resumeBot, pausedFor } from "./pause.mjs";
import { evalSummary, isEvalRunning, dueForEval } from "./evals.mjs";
import { loadTraits, saveTraits, generateTraits } from "./traits.mjs";
import { listEvents, recentEvents, clearEvents } from "./events.mjs";
import { buildWeekDigest } from "./week.mjs";
import { listChanges } from "./changes.mjs";
import {
  loadPlan,
  ensurePlan,
  postStatus,
  statusAudience,
  markPosted,
  revokeStatus,
  forgetHistory,
  upsertItem,
  removeItem,
  clearPlan,
  copyPlanForward,
  saveMedia,
  statusState,
  STATUS_COLORS,
} from "./status.mjs";
import { RELATIONS, loadWorld, saveWorld, ensureWorld, worldFile } from "./world.mjs";
import { resolveBlockJid } from "./stranger.mjs";
import { generateSchedule, formatSchedule, parseSchedule, addContext, cleanContext } from "./schedule.mjs";
import { currentBlock, nextBlock, ensureToday, tickMoments, saveRoutine, prune, loadRoutine } from "./routine.mjs";
import { normalize, cohere, label as moodLabel, newMood, baselineFor, KEYS as MOOD_KEYS } from "./mood.mjs";
import { suggestMood } from "./affect.mjs";
import { isConnected, getSock } from "./whatsapp.mjs";
import { dueSlot } from "./proactive.mjs";
import { KNOBS, FEATURES, currentValues, applyValues, autoSuggest, setEnv } from "../scripts/_settings.mjs";

/**
 * dashboard.mjs — tiny local web dashboard (no dependencies).
 * Bound to 127.0.0.1 by default; set DASHBOARD_HOST=0.0.0.0 + DASHBOARD_TOKEN
 * if you want to open it from another device.
 */

const HTML_FILE = path.join(ROOT, "dashboard", "index.html");
let elevenCache = { at: 0, data: null };

/* ------------------------------- helpers ------------------------------- */

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function setPersonaField(slug, key, value) {
  const file = path.join(PERSONA_DIR, `${slug}.md`);
  if (!fs.existsSync(file)) return false;
  let text = fs.readFileSync(file, "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return false;
  const re = new RegExp(`^${key}:.*$`, "gm");
  const line = `${key}: ${value}`;
  const fm = re.test(m[1]) ? m[1].replace(re, line).replace(new RegExp(`^${key}: ${value}\n(?=[\\s\\S]*^${key}:)`, "gm"), "") : `${m[1]}\n${line}`;
  text = text.replace(m[0], `---\n${fm}\n---`);
  fs.writeFileSync(file, text);
  return true;
}

function logTail(n = 60) {
  try {
    const lines = fs.readFileSync(path.join(ROOT, "rp.log"), "utf8").split("\n");
    return lines
      .filter((l) => l && !/[█▄▀]/.test(l) && !/^[┌│└]/.test(l))
      .slice(-n);
  } catch {
    return [];
  }
}

async function elevenQuota() {
  if (!config.elevenlabsApiKey) return null;
  if (Date.now() - elevenCache.at < 60000) return elevenCache.data;
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": config.elevenlabsApiKey },
    });
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json();
    const data = {
      left: j.character_limit - j.character_count,
      limit: j.character_limit,
      used: j.character_count,
      reset: j.next_character_count_reset_unix
        ? new Date(j.next_character_count_reset_unix * 1000).toISOString().slice(0, 10)
        : null,
    };
    elevenCache = { at: Date.now(), data };
    return data;
  } catch {
    return null;
  }
}

function todaysSchedule(persona) {
  const spec = String(persona.chat_schedule || config.proactiveSchedule || "").trim();
  if (!spec) return [];
  const now = new Date();
  const at = (h, m) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0).getTime();
  const out = [];
  for (const part of spec.split(",")) {
    const h = Number(part.trim());
    if (!Number.isFinite(h)) continue;
    let minute = null;
    for (let m = 0; m < 60; m++) {
      if (dueSlot(String(h), at(h, m), { graceMin: 0, jitterMin: 0, lastSlot: "" })) {
        minute = m;
        break;
      }
    }
    if (minute === null) continue;
    const quiet = config.quietStart <= config.quietEnd
      ? h >= config.quietStart && h < config.quietEnd
      : h >= config.quietStart || h < config.quietEnd;
    out.push({
      time: `${String(h).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      hour: h,
      minute,
      quiet,
      passed: h < now.getHours() || (h === now.getHours() && minute <= now.getMinutes()),
    });
  }
  return out.sort((a, b) => a.hour - b.hour || a.minute - b.minute);
}

function personaList() {
  return fs
    .readdirSync(PERSONA_DIR)
    .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
    .map((f) => {
      const slug = f.replace(/\.md$/, "");
      const meta = parsePersonaFrontmatter(fs.readFileSync(path.join(PERSONA_DIR, f), "utf8"));
      return { slug, name: meta.name || slug, emoji: meta.emoji || "" };
    });
}

let contacts = [];
let SETTINGS_LOADED_HINT = false;

/**
 * The config agent can take a while (a routine injection makes two model calls).
 * Holding an HTTP request open for that long is what makes a dashboard look like
 * it "timed out", so the request starts a job and returns immediately; the page
 * polls for the result.
 */
const adminJobs = new Map();
let adminJobSeq = 0;
function startAdminJob(fn) {
  const id = `job${++adminJobSeq}-${Date.now().toString(36)}`;
  const job = { id, status: "running", startedAt: Date.now(), result: null, error: null };
  adminJobs.set(id, job);
  // keep the map from growing
  if (adminJobs.size > 20) {
    const old = [...adminJobs.values()].sort((a, b) => a.startedAt - b.startedAt).slice(0, adminJobs.size - 20);
    for (const j of old) adminJobs.delete(j.id);
  }
  Promise.resolve()
    .then(fn)
    .then((r) => {
      job.status = "done";
      job.result = r;
      job.finishedAt = Date.now();
    })
    .catch((err) => {
      job.status = "error";
      job.error = err.message;
      job.finishedAt = Date.now();
      log(`admin job failed: ${err.message}`);
    });
  return job;
}

let APP_VERSION = null;
const isPausedDash = () => loadPause().until > Date.now();
/** Version from package.json — shown in the header. */
function appVersion() {
  if (APP_VERSION) return APP_VERSION;
  try {
    APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    APP_VERSION = "0.0.0";
  }
  return APP_VERSION;
}

async function summary() {
  const persona = loadPersona();
  const st = loadState();
  const activeSlug = persona.slug;
  const activeRoutine = loadRoutine(activeSlug);
  const routineSummary = activeRoutine
    ? {
        slug: activeSlug,
        date: activeRoutine.date,
        weekday: activeRoutine.weekday || "",
        theme: activeRoutine.theme,
        now: currentBlock(activeRoutine) || null,
        next: nextBlock(activeRoutine) || null,
        blocks: activeRoutine.blocks || [],
        moments: (activeRoutine.moments || []).map((m) => ({ at: m.at, kind: m.kind, what: m.what, intensity: m.intensity, lived: Boolean(m.firedAt) })),
        highlights: (activeRoutine.highlights || []).slice(-8),
        history: (activeRoutine.history || []).slice(-3).map((d) => ({ date: d.date, theme: d.theme })),
      }
    : null;
  contacts = listChats().map((c) => ({
    jid: c.jid,
    name: c.profile?.name || "",
    nick: c.profile?.nick || "",
    number: c.profile?.number || c.jid.split("@")[0],
    persona: c.persona || "",
    inbound: c.stats?.inbound || 0,
    outbound: c.stats?.outbound || 0,
    mood: c.mood
      ? Object.fromEntries(["valence", "energy", "arousal", "affection", "patience", "playfulness"].map((k) => [k, Number(c.mood[k].toFixed(2))]))
      : null,
    state: c.proactive?.state || "idle",
    trusted: c.trusted === true,
    tier: tierOf(c),
    blocked: Boolean(c.stranger?.blockedAt),
    strikes: c.stranger?.strikes || 0,
    phone: c.profile?.phone || "",
    blockConfirmed: c.stranger?.blockConfirmed !== false,
    blockError: c.stranger?.blockError || "",
    relation: c.relation?.type || "",
    recent: (c.history || []).slice(-5).map((h) => ({ role: h.role, text: String(h.content || "").slice(0, 180), ts: h.ts || 0 })),
    moodHistory: (c.moodHistory || []).slice(-48),
    personaLabels: { name: persona.name, emoji: persona.emoji },
    relationNote: c.relation?.note || "",
    tasks: (c.tasks || []).slice(-3).map((t) => ({ to: t.to, text: t.text, status: t.status })),
    crossNotes: (c.crossNotes || []).filter((n) => !n.done).map((n) => ({ kind: n.kind, from: n.fromName, what: n.what })),
    vouches: (c.vouches || []).filter((v) => v.status === "pending").map((v) => ({ with: v.referrerName, status: v.status })),
    blockReason: c.stranger?.blockReason || "",
    moodLabel: c.mood ? moodLabel(normalize(c.mood)) : "",
    moodMode: c.moodLock?.locked ? "manual" : "auto",
    routineTheme: routineSummary?.theme || "",
    routineNow: routineSummary?.now || null,
    moodLockedAt: c.moodLock?.locked ? c.moodLock.at || 0 : 0,
    baseline: baselineFor(c),
    dryCount: c.proactive?.dryCount || 0,
    commitments: (c.commitments || []).filter((x) => !x.done).map((x) => ({ what: x.what, due: x.due })),
    softMinutes:
      c.softUntil && c.softUntil > Date.now() ? Math.round((c.softUntil - Date.now()) / 60000) : 0,
    lastInteraction: c.lastInteraction || 0,
    lastProactiveAt: c.lastProactiveAt || 0,
  }));

  return {
    routine: routineSummary,
    version: appVersion(),
    traits: loadTraits(activeSlug),
    events: { recent: recentEvents(24).slice(-8), total: listEvents().length },
    week: buildWeekDigest(activeSlug),
    changes: listChanges().slice(-12).reverse(),
    status: { ...statusState(activeSlug), audienceCount: statusAudience().length },
    statusAudienceCount: statusAudience().length,
    statusColors: STATUS_COLORS,
    photos: (() => {
      const slug = loadPersona().slug;
      const lib = librarySummary(slug);
      return {
        ...lib,
        history: photoHistory(slug)
          .slice(-40)
          .reverse()
          .map((h) => {
            const p = lib.photos.find((x) => x.id === h.photoId);
            return { ...h, url: p ? `/photo?d=library/${slug}&f=${encodeURIComponent(p.file)}` : "" };
          }),
        scores: sceneScores(slug),
        wardrobeTimes: TIMES,
        wardrobeStyles: STYLES,
        selfie: { ...selfieSettings(loadPersona(slug)), moments: selfieMoments(slug) },
        contacts: listChats().map((c) => ({ jid: c.jid, name: c.profile?.name || c.name || String(c.jid).split("@")[0], trusted: c.trusted === true, allowed: c.photoAllowed !== false && (c.photoAllowed === true || c.trusted === true), sentCount: (c.stats?.photoCount || 0), lastAt: c.stats?.lastPhotoAt || 0 })),
        profiles: Object.fromEntries(Object.entries(PHONE_PROFILES).map(([k, v]) => [k, v.label])),
        wardrobe: wardrobeFor(loadPersona(slug)),
        settings: panelSettings(),
      };
    })(),
    face: (() => {
      const slug = loadPersona().slug;
      const face = loadFace(slug);
      return {
        hasAvatar: !!avatarPath(slug),
        avatarMeta: face.updatedAt ? new Date(face.updatedAt).toLocaleString("id-ID") : "",
        approved: (face.approved || []).length,
        rejected: (face.rejected || []).length,
        candidates: listCandidates(slug),
        faceModel: config.faceModel,
        photoCandidateCount: config.photoCandidateCount,
        prompt: facePrompt(loadPersona(slug)),
      };
    })(),
    evals: { ...evalSummary(), running: isEvalRunning(), due: dueForEval(), everyDays: config.evalEveryDays },
    paused: { active: isPausedDash(), minutesLeft: pausedFor(), reason: loadPause().reason || "" },
    featureKeys: FEATURES.map((f) => f.key),
    // what the RUNNING process actually has switched on (not just what's in .env)
    liveFlags: {
      world: config.world,
      routine: config.routine,
      routineMood: config.routineMood,
      proactive: config.proactive,
      sulking: config.sulking,
      softMode: config.softMode,
      commitments: config.commitments,
      instructionFollowup: config.instructionFollowup,
      crossChat: config.crossChat,
      tasks: config.tasks,
      strangerGuard: config.strangerGuard,
      presence: config.presence,
      markRead: config.markRead,
      memoryEmbeddings: config.memoryEmbeddings,
      milestones: config.milestones,
      moodMedia: config.moodMedia,
      saveUserStickers: config.saveUserStickers,
      injectionGuard: config.injectionGuard,
      backup: config.backup,
    },
    bot: {
      connected: isConnected(),
      number: getSock()?.user?.id ? String(getSock().user.id).split(":")[0].split("@")[0] : null,
      uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
      persona: { slug: persona.slug, name: persona.name, emoji: persona.emoji },
      presences: config.presence,
      quiet: [config.quietStart, config.quietEnd],
      idleMin: config.proactiveIdleMin,
      gapMin: config.proactiveGapMin,
    },
    contacts,
    personas: personaList(),
    relations: Object.entries(RELATIONS).map(([id, r]) => ({ id, label: r.label })),
    world: loadWorld(activeSlug),
    scheduleInfo: { spec: persona.chat_schedule || "", slots: parseSchedule(persona.chat_schedule || ""), activeHours: persona.active_hours || "", workHours: persona.work_hours || "" },
    settings: {
      knobs: KNOBS.map((k) => ({ key: k.key, label: k.label, kind: k.kind, value: currentValues()[k.key] })),
      activeHours: persona.active_hours || "",
      chatSchedule: persona.chat_schedule || "",
    },
    schedule: todaysSchedule(persona),
    quota: {
      usageDay: st.usageDay || null,
      usage: st.usage || {},
      photos: st.photoCount || 0,
      photoMax: config.photoGlobalDailyMax,
      ttsChars: st.elChars || 0,
      ttsMax: config.elevenlabsDailyChars,
      eleven: await elevenQuota(),
    },
    log: logTail(60),
  };
}

/* -------------------------------- server ------------------------------- */

function authorized(req, url) {
  if (config.dashboardHost === "127.0.0.1" || config.dashboardHost === "localhost") return true;
  const token = config.dashboardToken;
  if (!token) return true;
  return url.searchParams.get("token") === token || req.headers["x-dashboard-token"] === token;
}

export function startDashboard() {
  if (!config.dashboard) {
    log("dashboard: off");
    return;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    try {
      if (!authorized(req, url)) return json(res, 401, { error: "unauthorized" });

      // static files from the dashboard folder (logo, favicon) — whitelisted only
      const staticFiles = {
        "/logo.png": "image/png",
        "/favicon.ico": "image/png",
        "/manifest.webmanifest": "application/manifest+json",
        "/sw.js": "text/javascript",
      };
      if (req.method === "GET" && staticFiles[url.pathname]) {
        const name = url.pathname === "/favicon.ico" ? "logo.png" : url.pathname.slice(1);
        const file = path.join(ROOT, "dashboard", name);
        if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: "not found" });
        if (url.pathname === "/sw.js" || url.pathname === "/manifest.webmanifest") {
          log(`dashboard: ${url.pathname} served (panel being installed / refreshed)`);
        }
        const headers = { "content-type": staticFiles[url.pathname], "cache-control": "public, max-age=600" };
        // a service worker may only control the scope it is served from
        if (url.pathname === "/sw.js") headers["service-worker-allowed"] = "/";
        res.writeHead(200, headers);
        return res.end(fs.readFileSync(file));
      }

      // rating page: Hik's eye is the ground truth for photos, so it gets a page
      // The page compares its own build stamp against this and reloads itself when they differ, so a
      // browser that keeps a stale copy of the panel corrects itself within a second.
      if (req.method === "GET" && url.pathname === "/build-stamp.js") {
        const stamp = String(Math.round(fs.statSync(HTML_FILE).mtimeMs));
        res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
        return res.end(`window.__SERVER_BUILD__ = "${stamp}";\n`);
      }

      // What the browser actually sees: load the panel in an iframe and report any JS error it throws.
      if (req.method === "GET" && url.pathname === "/diag") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<body style="background:#131109;color:#f3e6d2;font:14px/1.6 system-ui;padding:16px">
<h1 style="font-size:18px;margin:0 0 8px">Diagnosa panel</h1>
<p style="color:#b39a78;margin:0 0 10px">Halaman ini membuka panel di dalam iframe dan menangkap error JavaScript-nya.</p>
<pre id="out" style="white-space:pre-wrap;background:#1c1810;border:1px solid #33291c;border-radius:12px;padding:12px;min-height:100px">memuat…</pre>
<iframe id="f" src="/?diag=1" style="width:100%;height:60vh;border:1px solid #33291c;border-radius:12px;background:#000;margin-top:10px"></iframe>
<script>
const out = document.getElementById("out");
const lines = [];
const say = (t) => { lines.push(t); out.textContent = lines.join("\n"); };
const f = document.getElementById("f");
f.addEventListener("load", () => {
  say("panel dimuat: " + new Date().toLocaleTimeString("id-ID"));
  try {
    const w = f.contentWindow;
    w.addEventListener("error", (e) => say("ERROR: " + e.message + " @ " + String(e.filename||"").split("/").pop() + ":" + e.lineno));
    w.addEventListener("unhandledrejection", (e) => say("REJECT: " + (e.reason && e.reason.message || e.reason)));
    const d = w.document;
    const stamp = d.querySelector("script") && /BUILD_STAMP = "([^"]+)"/.exec(w.document.documentElement.innerHTML);
    say("build: " + (stamp ? stamp[1] : "tidak terbaca"));
    say("tombol switch di halaman: " + d.querySelectorAll(".switch").length);
    say("kartu selfie ada: " + (d.documentElement.innerHTML.includes("Selfie terjadwal") ? "ya" : "TIDAK"));
    say("tab Photos ada: " + (d.querySelector("#tab-photos") ? "ya" : "TIDAK"));
    say("handler 'photos' terpasang: " + (typeof w.renderPhotos === "function" ? "ya" : "TIDAK"));
    try { w.renderPhotos && w.renderPhotos(); say("renderPhotos() jalan tanpa error ✓"); }
    catch (err) { say("renderPhotos() ERROR: " + err.message); }
  } catch (err) { say("tidak bisa memeriksa isi iframe: " + err.message); }
});
</script>`);
      }

      // escape hatch: open /reset-sw once when the panel keeps showing an old version
      if (req.method === "GET" && url.pathname === "/reset-sw") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<body style="background:#131109;color:#f3e6d2;font:16px/1.6 system-ui;padding:24px">
<h1 style="font-size:19px">Menyegarkan panel…</h1>
<p id=s style="color:#b39a78">Menghapus cache lama dan service worker.</p>
<script>
(async ()=>{
  const out=[];
  try{ const regs=await navigator.serviceWorker.getRegistrations(); for(const r of regs){ await r.unregister(); out.push("service worker dibuang"); } }catch(e){ out.push("sw: "+e.message); }
  try{ const keys=await caches.keys(); for(const k of keys){ await caches.delete(k); out.push("cache "+k+" dibuang"); } }catch(e){ out.push("cache: "+e.message); }
  document.getElementById("s").textContent = out.join(" · ") || "tidak ada yang perlu dibuang";
  setTimeout(()=>location.replace("/?t="+Date.now()), 1200);
})();
</script>
<p style="color:#ffb257">Sebentar lagi kamu dibawa ke panel versi baru.</p>`);
      }

      if (req.method === "GET" && (url.pathname === "/rate" || url.pathname === "/rate.html")) {
        const file = path.join(ROOT, "dashboard", "rate.html");
        if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: "not found" });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(fs.readFileSync(file));
      }
      if (req.method === "GET" && url.pathname === "/wardrobe") {
        const slug2 = loadPersona().slug;
        const want = String(url.searchParams.get("id") || url.searchParams.get("i") || "");
        const item = loadWardrobe(slug2).items.find((x) => x.id === want || String(x.id) === want);
        const file = item?.image || "";
        if (!file || !fs.existsSync(file)) return json(res, 404, { ok: false, error: "not found" });
        res.writeHead(200, { "content-type": /\.png$/i.test(file) ? "image/png" : "image/jpeg", "cache-control": "no-store" });
        return res.end(fs.readFileSync(file));
      }
      if (req.method === "GET" && url.pathname === "/spot") {
        const slug2 = loadPersona().slug;
        const file = String(loadPersona(slug2).mirror_spot_image || "");
        if (!file || !fs.existsSync(file)) return json(res, 404, { ok: false, error: "not found" });
        res.writeHead(200, { "content-type": /\.png$/i.test(file) ? "image/png" : "image/jpeg", "cache-control": "no-store" });
        return res.end(fs.readFileSync(file));
      }
      if (req.method === "GET" && url.pathname === "/photo") {
        const name = path.basename(String(url.searchParams.get("f") || ""));
        const dir = path.basename(String(url.searchParams.get("d") || "model-test"));
        const file = path.join("/sdcard/Download/Understudy", dir, name);
        if (!name || !fs.existsSync(file)) return json(res, 404, { ok: false, error: "not found" });
        res.writeHead(200, { "content-type": /\.png$/i.test(name) ? "image/png" : "image/jpeg", "cache-control": "public, max-age=3600" });
        return res.end(fs.readFileSync(file));
      }
      if (req.method === "GET" && url.pathname === "/api/rate") {
        return json(res, 200, readRatings());
      }
      if (req.method === "GET" && url.pathname === "/api/ratelist") {
        const list = [];
        for (const dir of PHOTO_TEST_DIRS) {
          if (!fs.existsSync(dir)) continue;
          const group = path.basename(dir);
          for (const f of fs.readdirSync(dir)) {
            if (!/\.(jpg|jpeg|png)$/i.test(f)) continue;
            if (f === "avatar.jpg" || f === "logo.png") continue;
            let stats = null;
            try {
              const out = execFileSync("node", [path.join(ROOT, "scripts", "photostats.mjs"), path.join(dir, f)], { encoding: "utf8", timeout: 30000 });
              const line = out.split("\n").find((l) => l.includes(f.slice(0, 18)));
              if (line) {
                const parts = line.trim().split(/\s+/);
                stats = { mp: parts[1], contrast: parts[3], saturation: parts[4], colorfulness: parts[5], sharpness: parts[6], noise: parts[7] };
              }
            } catch {
              /* measurements are a nice-to-have */
            }
            list.push({ file: f, group, url: `/photo?d=${encodeURIComponent(group)}&f=${encodeURIComponent(f)}`, stats });
          }
        }
        const slug = loadPersona().slug;
        const av = avatarPath(slug);
        return json(res, 200, {
          photos: list.sort((a, b) => a.group.localeCompare(b.group) || a.file.localeCompare(b.file)),
          avatar: av ? `/face?f=avatar` : "",
        });
      }

      // her face: the avatar and the candidates, served from her own folder
      if (req.method === "GET" && url.pathname === "/face") {
        const slug = loadPersona().slug;
        const name = String(url.searchParams.get("f") || "avatar");
        let file = "";
        if (name === "avatar") file = avatarPath(slug);
        else if (name.startsWith("cand-")) file = path.join(candidatesDir(slug), path.basename(name));
        if (!file || !fs.existsSync(file)) return json(res, 404, { ok: false, error: "not found" });
        res.writeHead(200, { "content-type": /\.png$/i.test(file) ? "image/png" : "image/jpeg", "cache-control": "no-store" });
        return res.end(fs.readFileSync(file));
      }
      if (req.method === "GET" && url.pathname === "/api/photos") {
        const slug = loadPersona().slug;
        const persona = loadPersona(slug);
        const lib = librarySummary(slug);
        const history = photoHistory(slug)
          .slice(-40)
          .reverse()
          .map((h) => ({ ...h, url: (() => { const p = loadLibrary(slug).photos.find((x) => x.id === h.photoId); return p ? `/photo?d=library/${slug}&f=${encodeURIComponent(p.file)}` : ""; })() }));
        return json(res, 200, {
          ...lib,
          wardrobeTimes: TIMES,
          wardrobeStyles: STYLES,
          selfie: { ...selfieSettings(loadPersona(slug)), moments: selfieMoments(slug) },
          contacts: listChats().map((c) => ({ jid: c.jid, name: c.profile?.name || c.name || String(c.jid).split("@")[0], trusted: c.trusted === true, allowed: c.photoAllowed !== false && (c.photoAllowed === true || c.trusted === true), sentCount: (c.stats?.photoCount || 0), lastAt: c.stats?.lastPhotoAt || 0 })),
          history,
          scores: sceneScores(slug),
          profiles: Object.fromEntries(Object.entries(PHONE_PROFILES).map(([k, v]) => [k, v.label])),
          wardrobe: wardrobeFor(persona),
          settings: panelSettings(),
        });
      }

      if (req.method === "GET" && url.pathname === "/api/face") {
        const slug = loadPersona().slug;
        const face = loadFace(slug);
        let whatsappUrl = "";
        try {
          const { getSock } = await import("./whatsapp.mjs");
          whatsappUrl = await currentAvatarUrl(getSock());
        } catch {
          /* WhatsApp may not be up yet */
        }
        return json(res, 200, {
          slug,
          hasAvatar: !!avatarPath(slug),
          avatarMeta: face.updatedAt ? new Date(face.updatedAt).toLocaleString("id-ID") : "",
          approved: (face.approved || []).length,
          rejected: (face.rejected || []).length,
          candidates: listCandidates(slug),
          whatsappUrl,
          faceModel: config.faceModel,
          photoCandidateCount: config.photoCandidateCount,
          prompt: facePrompt(loadPersona(slug)),
        });
      }
      // the test galleries live in the Download folder; this serves them to the browser
      if (req.method === "GET" && url.pathname === "/gallery") {
        const rel = String(url.searchParams.get("p") || "");
        const file = path.join("/sdcard/Download/Understudy", rel);
        const safe = path.resolve(file).startsWith(path.resolve("/sdcard/Download/Understudy"));
        if (!rel || !safe || !fs.existsSync(file) || !/\.html$/i.test(file)) return json(res, 404, { ok: false, error: "not found" });
        const dir = path.posix.dirname(rel);
        let html = fs.readFileSync(file, "utf8");
        html = html.replace(/(src|href)="(?!http|\/|#)([^"]+)"/g, (_m, attr, target) => `${attr}="/gallery-file?p=${encodeURIComponent(path.posix.join(dir, target))}"`);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(html);
      }
      if (req.method === "GET" && url.pathname === "/gallery-file") {
        const rel = String(url.searchParams.get("p") || "");
        const file = path.join("/sdcard/Download/Understudy", rel);
        const safe = path.resolve(file).startsWith(path.resolve("/sdcard/Download/Understudy"));
        if (!rel || !safe || !fs.existsSync(file)) return json(res, 404, { ok: false, error: "not found" });
        const type = /\.png$/i.test(file)
          ? "image/png"
          : /\.md$/i.test(file)
            ? "text/markdown; charset=utf-8"
            : /\.json$/i.test(file)
              ? "application/json"
              : "image/jpeg";
        res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=300" });
        return res.end(fs.readFileSync(file));
      }

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const html = fs.readFileSync(HTML_FILE, "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(html);
      }

      if (req.method === "GET" && url.pathname === "/api/summary") {
        return json(res, 200, await summary());
      }

        if (req.method === "GET" && url.pathname === "/api/persona/card") {
        const slug = url.searchParams.get("slug") || config.persona;
        const file = path.join(PERSONA_DIR, `${slug}.md`);
        if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: "persona not found" });
        const raw = fs.readFileSync(file, "utf8");
        const meta = parsePersonaFrontmatter(raw);
        const body = raw.replace(/^---[\s\S]*?\n---\s*\n?/, "");
        return json(res, 200, { ok: true, slug, frontmatter: meta, body, raw });
      }


      if (req.method === "GET" && url.pathname === "/api/admin/job") {
        const job = adminJobs.get(url.searchParams.get("id") || "");
        if (!job) return json(res, 404, { ok: false, error: "unknown job" });
        return json(res, 200, {
          ok: true,
          status: job.status,
          elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
          say: job.result?.say || "",
          applied: job.result?.applied || [],
          refused: job.result?.refused || [],
          degraded: job.result?.degraded === true,
          error: job.error || "",
        });
      }

      if (req.method === "GET" && url.pathname === "/api/persona/export") {
        const slug = url.searchParams.get("slug") || config.persona;
        const withSettings = url.searchParams.get("settings") !== "0";
        let bundle;
        try {
          bundle = exportPersona(slug, { withSettings });
        } catch (err) {
          return json(res, 404, { ok: false, error: err.message });
        }
        const body = JSON.stringify(bundle, null, 2);
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${bundle.slug}.character.json"`,
          "cache-control": "no-store",
        });
        return res.end(body);
      }

      if (req.method === "GET" && url.pathname === "/api/lidcheck") {
        const sock = getSock();
        if (!sock) return json(res, 200, { ok: false, error: "not connected" });
        const sig = sock.signalRepository || {};
        const out = {
          ok: true,
          signalRepository: Object.keys(sig),
          hasLidMapping: Boolean(sig.lidMapping),
          lidMappingMethods: sig.lidMapping ? Object.keys(sig.lidMapping) : [],
          hasStore: Boolean(sock.store),
          storeKeys: sock.store ? Object.keys(sock.store).slice(0, 20) : [],
        };
        try {
          if (sig.lidMapping?.getPNForLID) out.sample = await sig.lidMapping.getPNForLID("276931085860958@lid");
        } catch (err) {
          out.sampleError = err.message;
        }
        return json(res, 200, out);
      }

      if (req.method === "GET" && url.pathname === "/api/memory") {
        const jid = url.searchParams.get("jid") || "";
        if (!jid) return json(res, 400, { ok: false, error: "jid is required" });
        const chat = loadChat(jid);
        const m = chat.memory || {};
        const world = loadWorld(chat.persona || config.persona);
        return json(res, 200, {
          ok: true,
          summary: m.summary || "",
          relationship: m.relationship || "",
          facts: m.facts || [],
          boundaries: m.boundaries || [],
          plans: m.plans || [],
          jokes: m.jokes || [],
          pinned: m.pinned || [],
          factDates: m.factDates || {},
          highlights: (world.highlights || []).slice(-12),
          vouches: (chat.vouches || []).map((v) => ({ with: v.referrerName, status: v.status, answer: v.answer || "" })),
          tasks: (chat.tasks || []).slice(-5).map((t) => ({ to: t.to, text: t.text, status: t.status })),
        });
      }

      if (req.method === "GET" && url.pathname === "/api/chat") {
        const jid = url.searchParams.get("jid") || "";
        if (!jid) return json(res, 400, { ok: false, error: "jid is required" });
        const chat = loadChat(jid);
        const q = (url.searchParams.get("q") || "").trim().toLowerCase();
        const limit = Math.min(1000, Number(url.searchParams.get("limit")) || 400);
        let msgs = (chat.history || []).map((h) => ({
          role: h.role,
          text: String(h.content || ""),
          ts: h.ts || 0,
          deleted: Boolean(h.deleted),
          viaTask: Boolean(h.viaTask),
        }));
        const total = msgs.length;
        if (q) msgs = msgs.filter((m) => m.text.toLowerCase().includes(q));
        const trimmed = msgs.slice(-limit);
        return json(res, 200, {
          ok: true,
          total,
          shown: trimmed.length,
          matched: q ? msgs.length : total,
          contact: {
            jid,
            name: chat.profile?.name || "",
            number: chat.profile?.number || jid.split("@")[0],
            nick: chat.profile?.nick || "",
            persona: chat.persona || "",
          },
          messages: trimmed,
        });
      }

      if (req.method === "GET" && url.pathname === "/api/blocklist") {
        const sock = getSock();
        if (!sock) return json(res, 200, { ok: false, error: "WhatsApp is not connected", list: [] });
        let list = [];
        try {
          list = await sock.fetchBlocklist();
        } catch (err) {
          return json(res, 200, { ok: false, error: err.message, list: [] });
        }
        const numbers = (Array.isArray(list) ? list : []).map((j) => String(j).split("@")[0]);
        return json(res, 200, {
          ok: true,
          list,
          numbers,
          // which stored contacts are blocked on WhatsApp right now, and whether a
          // LID-only chat can be mapped to a real number (needed to block it)
          contacts: await Promise.all(
            listChats().map(async (c) => {
              const resolves = String(c.jid).endsWith("@lid") ? await resolveBlockJid(sock, c) : null;
              return {
                jid: c.jid,
                blocked: numbers.includes(String(c.jid).split("@")[0]),
                blockTarget: resolves ? resolves.jid : c.jid,
                blockNote: resolves ? resolves.note : "",
                inBlocklist: numbers.includes(String(resolves?.jid || c.jid).split("@")[0]),
              };
            }),
          ),
        });
      }

      if (req.method === "GET" && url.pathname === "/api/persona/trash") {
        return json(res, 200, { ok: true, files: trashContents() });
      }

      if (req.method === "POST") {
        const body = await readBody(req);

        if (url.pathname === "/api/photos") {
          const slug = loadPersona().slug;
          const act = String(body.action || "");
          if (act === "contact") {
            const chat2 = loadChat(String(body.jid || ""));
            if (!chat2?.jid) return json(res, 404, { ok: false, error: "contact not found" });
            if (body.allowed === null || body.allowed === undefined) delete chat2.photoAllowed;
            else chat2.photoAllowed = !!body.allowed;
            saveChat(chat2);
            log(`photo permission: ${body.jid} → ${chat2.photoAllowed === undefined ? "default" : chat2.photoAllowed}`);
            return json(res, 200, { ok: true });
          }
          if (act === "selfie-now") {
            const persona = loadPersona(slug);
            const r = await makeSelfie(persona, { slug, style: String(body.style || "casual"), outfit: String(body.outfit || "") });
            if (!r.ok) return json(res, 400, { ok: false, error: r.error });
            const photo = loadWardrobe ? null : null;
            const lib = loadLibrary(slug);
            const file = path.join(DATA_DIR, "photos", "library", slug, r.photo.file);
            let sent = 0;
            if (body.send !== false && fs.existsSync(file)) {
              const { getSock, sendImage } = await import("./whatsapp.mjs");
              const sock = getSock();
              if (sock) {
                for (const c of listChats()) {
                  if (c.photoAllowed === false) continue;
                  if (c.photoAllowed !== true && c.trusted !== true) continue;
                  try {
                    await sendImage(sock, c.jid, fs.readFileSync(file), "image/jpeg");
                    markSent(slug, r.photo.id, c.jid, { why: "selfie manual dari panel" });
                    sent++;
                  } catch (err) {
                    log(`selfie manual gagal ke ${c.jid}: ${err.message}`);
                  }
                }
              }
            }
            return json(res, 200, { ok: true, photo: r.photo, seconds: r.seconds, price: r.price, sent });
          }
          if (act === "selfie-settings") {
            // the selfie card sends only its own fields, so an empty outfit really means "rotate again" —
            // applyValues() skips empty strings on purpose, so it is written directly here
            if (body.values && "SELFIE_OUTFIT" in body.values) setEnv("SELFIE_OUTFIT", String(body.values.SELFIE_OUTFIT || "").trim().slice(0, 120));
            if (body.values && "SELFIE_WHY" in body.values) setEnv("SELFIE_WHY", String(body.values.SELFIE_WHY || "").trim().slice(0, 140));
            applyValues(body.values || {});
            if (typeof body.spot === "string") setPersonaField(slug, "mirror_spot", body.spot.slice(0, 300));
            reloadConfig();
            log("dashboard: setelan selfie diperbarui");
            return json(res, 200, { ok: true, selfie: selfieSettings(loadPersona(slug)) });
          }
          if (act === "selfie-reason") {
            const r = await generateSelfieReason(loadPersona(slug));
            return json(res, 200, { ok: true, reason: r.reason, place: r.place });
          }
          if (act === "pose-ref-upload") {
            const group = String(body.group || "full").toLowerCase().replace(/[^a-z]/g, "") || "full";
            const ext = String(body.ext || "jpg").replace(/[^a-z]/gi, "") || "jpg";
            const dir = path.join(DATA_DIR, "photos", "pose", slug, group);
            fs.mkdirSync(dir, { recursive: true });
            const data = String(body.data || "").replace(/^data:[^,]+,/, "");
            if (!data || data.length < 100) return json(res, 400, { ok: false, error: "upload kosong" });
            const target = path.join(dir, `${Date.now()}.${ext}`);
            fs.writeFileSync(target, Buffer.from(data, "base64"));
            log(`dashboard: pose ref ditambah ke ${group}`);
            const counts = Object.fromEntries(Object.entries(poseRefGroups(slug)).map(([g, f]) => [g, f.length]));
            return json(res, 200, { ok: true, frameRefs: counts });
          }
          if (act === "pose-ref-clear") {
            const group = String(body.group || "").toLowerCase().replace(/[^a-z]/g, "");
            if (group) fs.rmSync(path.join(DATA_DIR, "photos", "pose", slug, group), { recursive: true, force: true });
            const counts = Object.fromEntries(Object.entries(poseRefGroups(slug)).map(([g, f]) => [g, f.length]));
            return json(res, 200, { ok: true, frameRefs: counts });
          }

          if (act === "wardrobe-add") {
            const r = addWardrobeItem(slug, { name: body.name, times: body.times || [], styles: body.styles || [] });
            return json(res, r.ok ? 200 : 400, { ...r, wardrobe: loadWardrobe(slug).items });
          }
          if (act === "wardrobe-update") {
            const r = updateWardrobeItem(slug, String(body.id || ""), { name: body.name, description: body.description, times: body.times, styles: body.styles });
            return json(res, r.ok ? 200 : 400, { ...r, wardrobe: loadWardrobe(slug).items });
          }
          if (act === "wardrobe-remove") {
            const r = removeWardrobeItem(slug, String(body.id || ""));
            return json(res, r.ok ? 200 : 400, { ...r, wardrobe: loadWardrobe(slug).items });
          }
          if (act === "wardrobe-image") {
            const id = String(body.id || "");
            const ext = String(body.ext || "jpg").replace(/[^a-z]/gi, "") || "jpg";
            const dir = path.join(DATA_DIR, "photos", "wardrobe", slug);
            fs.mkdirSync(dir, { recursive: true });
            const target = path.join(dir, `${id}.${ext}`);
            const data = String(body.data || "").replace(/^data:[^,]+,/, "");
            if (!data || data.length < 100) return json(res, 400, { ok: false, error: "upload kosong" });
            fs.writeFileSync(target, Buffer.from(data, "base64"));
            setWardrobeImage(slug, id, target);
            // The picture is saved and answered right away. Reading the clothes off it is a vision
            // round-trip that can be slow or down — it must never hold up (or fail) the upload itself,
            // which is exactly what made "upload gambar baju" look broken.
            if (body.describe !== false) {
              describeOutfit(target)
                .then((auto) => {
                  if (!auto.ok) return log(`wardrobe: deskripsi otomatis dilewati untuk ${id} (${auto.error || "?"})`);
                  const before = loadWardrobe(slug).items.find((i) => i.id === id) || {};
                  updateWardrobeItem(slug, id, {
                    description: auto.description,
                    times: (before.times || []).length ? before.times : auto.times,
                    styles: (before.styles || []).length ? before.styles : auto.styles,
                  });
                  log(`wardrobe: deskripsi otomatis untuk ${id} — ${auto.description.slice(0, 60)}`);
                })
                .catch((err) => log(`wardrobe: deskripsi otomatis gagal untuk ${id}: ${err.message}`));
            }
            return json(res, 200, {
              ok: true,
              auto: { ok: false, pending: true },
              wardrobe: loadWardrobe(slug).items,
            });
          }
          if (act === "spot-image") {
            const ext = String(body.ext || "jpg").replace(/[^a-z]/gi, "") || "jpg";
            const dir = path.join(DATA_DIR, "photos", "spot");
            fs.mkdirSync(dir, { recursive: true });
            const data = String(body.data || "").replace(/^data:[^,]+,/, "");
            if (!data || data.length < 100) return json(res, 400, { ok: false, error: "upload kosong" });
            // one spot picture per character: replace whichever extension was there before
            for (const f of fs.readdirSync(dir)) if (f.startsWith(`${slug}.`)) fs.rmSync(path.join(dir, f), { force: true });
            const target = path.join(dir, `${slug}.${ext}`);
            fs.writeFileSync(target, Buffer.from(data, "base64"));
            setPersonaField(slug, "mirror_spot_image", target);
            log("dashboard: foto referensi tempat disimpan");
            return json(res, 200, { ok: true, spotImage: "/spot" });
          }
          if (act === "spot-image-remove") {
            const cur = String(loadPersona(slug).mirror_spot_image || "");
            if (cur && fs.existsSync(cur)) fs.rmSync(cur, { force: true });
            setPersonaField(slug, "mirror_spot_image", "");
            log("dashboard: foto referensi tempat dihapus");
            return json(res, 200, { ok: true });
          }
          if (act === "rate") {
            const r = rateSent(slug, String(body.id || ""), { rating: body.rating, weird: body.weird, note: body.note });
            return json(res, r.ok ? 200 : 400, { ...r, scores: sceneScores(slug) });
          }
          if (act === "settings") {
            applyValues(body.values || {});
            reloadConfig();
            log("dashboard: photo settings updated (applied live)");
            return json(res, 200, { ok: true });
          }
          if (act === "wardrobe") {
            setPersonaField(slug, "wardrobe", String(body.wardrobe || "").slice(0, 800));
            log("dashboard: wardrobe updated");
            return json(res, 200, { ok: true, wardrobe: wardrobeFor(loadPersona(slug)) });
          }
          const { getSock } = await import("./whatsapp.mjs");
          if (act === "remove") {
            const r = removePhoto(slug, String(body.id || ""));
            return json(res, r.ok ? 200 : 400, { ...r, ...librarySummary(slug) });
          }
          if (act === "send") {
            const sock = getSock();
            if (!sock) return json(res, 400, { ok: false, error: "WhatsApp is not connected" });
            const jid = String(body.jid || "");
            if (!jid) return json(res, 400, { ok: false, error: "no contact given" });
            const hour = Number(body.hour);
            const now = Number.isFinite(hour) ? new Date(new Date().setHours(hour, 0, 0, 0)) : new Date();
            const photo = body.id
              ? loadLibrary(slug).photos.find((p) => p.id === body.id)
              : pickPhoto({ slug, chat: { jid, trusted: true, mood: { valence: 0.6 } }, now });
            if (!photo) return json(res, 400, { ok: false, error: "nothing in the library fits right now" });
            const file = path.join(DATA_DIR, "photos", "library", slug, photo.file);
            if (!fs.existsSync(file)) return json(res, 400, { ok: false, error: "file missing" });
            try {
              const { sendImage } = await import("./whatsapp.mjs");
              await sendImage(sock, jid, fs.readFileSync(file), "image/jpeg", String(body.caption || "") || undefined);
              markSent(slug, photo.id, jid);
              log(`photo (manual test) → ${jid} "${photo.scene}"`);
              return json(res, 200, { ok: true, sent: photo.scene, why: photo.why || "dipilih manual" });
            } catch (err) {
              return json(res, 400, { ok: false, error: err.message.slice(0, 140) });
            }
          }
          return json(res, 400, { ok: false, error: "unknown action" });
        }

        if (url.pathname === "/api/face") {
          const slug = loadPersona().slug;
          const act = String(body.action || "");
          const { getSock } = await import("./whatsapp.mjs");

          if (act === "gen") {
            const persona = loadPersona(slug);
            const r = await generateCandidates(persona, { count: body.count, slug });
            return json(res, r.ok ? 200 : 400, { ...r, candidates: listCandidates(slug) });
          }
          if (act === "pick") {
            const r = await approveCandidate(slug, body.file, getSock());
            return json(res, r.ok ? 200 : 400, {
              ...r,
              candidates: listCandidates(slug),
              note: r.ok
                ? r.whatsapp?.ok
                  ? "Saved — and her WhatsApp profile picture is updated too."
                  : `Saved here, but WhatsApp refused the picture: ${r.whatsapp?.error || "unknown"}. The photo is still on file.`
                : "",
            });
          }
          if (act === "discard") {
            const r = rejectCandidate(slug, body.file);
            return json(res, r.ok ? 200 : 400, { ...r, candidates: listCandidates(slug) });
          }
          if (act === "upload") {
            const file = saveMedia(body.data, String(body.ext || "jpg"));
            if (!file) return json(res, 400, { ok: false, error: "could not read that file" });
            const target = path.join(faceDir(slug), `avatar.${String(body.ext || "jpg").replace(/[^a-z]/gi, "") || "jpg"}`);
            fs.copyFileSync(file, target);
            for (const ext of ["jpg", "jpeg", "png"]) {
              const other = path.join(faceDir(slug), `avatar.${ext}`);
              if (other !== target) fs.rmSync(other, { force: true });
            }
            const face = loadFace(slug);
            saveFace(slug, { ...face, avatar: target, reference: target });
            const pushed = body.push === false ? { ok: false, error: "not sent" } : await pushAvatar(getSock(), target);
            return json(res, 200, {
              ok: true,
              whatsapp: pushed,
              note: pushed.ok ? "Uploaded and set as her WhatsApp profile picture." : `Uploaded. WhatsApp: ${pushed.error}`,
            });
          }
          if (act === "push") {
            const file = avatarPath(slug);
            const r = await pushAvatar(getSock(), file);
            return json(res, r.ok ? 200 : 400, { ...r, note: r.ok ? "Profile picture updated on WhatsApp." : `WhatsApp refused: ${r.error}` });
          }
          return json(res, 400, { ok: false, error: "unknown action" });
        }

        if (url.pathname === "/api/rate") {
          const name = String(body.file || "");
          if (!name) return json(res, 400, { ok: false, error: "file is required" });
          const count = writeRating({
            file: name,
            verdict: String(body.verdict || ""),
            note: String(body.note || "").slice(0, 300),
            stats: body.stats || null,
            at: Date.now(),
          });
          log(`rating: ${name} → ${body.verdict} (${count} total)`);
          return json(res, 200, { ok: true, count });
        }

        if (url.pathname === "/api/settings") {
          if (body.values && typeof body.values === "object") applyValues(body.values);
          const slug = loadPersona().slug;
          if (typeof body.activeHours === "string") setPersonaField(slug, "active_hours", body.activeHours);
          if (typeof body.chatSchedule === "string") setPersonaField(slug, "chat_schedule", body.chatSchedule);
          // the running bot reads .env through the config object — refresh it in
          // place so a settings change applies immediately, no restart
          reloadConfig();
          log("dashboard: settings updated (applied live)");
          return json(res, 200, { ok: true, needsRestart: false });
        }

        if (url.pathname === "/api/auto") {
          const persona = loadPersona();
          const suggested = await autoSuggest(persona, currentValues());
          if (body.apply) {
            applyValues(suggested);
            log("dashboard: auto settings applied");
          }
          return json(res, 200, { ok: true, suggested });
        }

        if (url.pathname === "/api/events") {
          if (body.clear) {
            clearEvents();
            return json(res, 200, { ok: true, events: [] });
          }
          return json(res, 200, { ok: true, events: recentEvents(24).slice(-12) });
        }

        if (url.pathname === "/api/status") {
          const slug = String(body.slug || config.persona).replace(/[^\w.-]/g, "");
          const persona = loadPersona(slug);
          const act = String(body.action || "state");
          const sock = async () => {
            const { getSock } = await import("./whatsapp.mjs");
            return getSock();
          };

          if (act === "plan") {
            await ensurePlan(persona, null, null, { force: true });
            return json(res, 200, { ok: true, status: statusState(slug) });
          }
          if (act === "update" || act === "add") {
            const r = upsertItem(slug, body.item || body);
            return json(res, r.ok ? 200 : 400, { ...r, status: statusState(slug) });
          }
          if (act === "remove") {
            const r = removeItem(slug, body.id);
            return json(res, r.ok ? 200 : 400, { ...r, status: statusState(slug) });
          }
          if (act === "clear") {
            clearPlan(slug);
            return json(res, 200, { ok: true, status: statusState(slug) });
          }
          if (act === "copy") {
            const r = copyPlanForward(slug);
            return json(res, r.ok ? 200 : 400, { ...r, status: statusState(slug) });
          }
          if (act === "upload") {
            if (!config.statusMedia) return json(res, 400, { ok: false, error: "STATUS_MEDIA is off" });
            const file = saveMedia(body.data, body.ext || "jpg");
            if (!file) return json(res, 400, { ok: false, error: "could not read that file" });
            return json(res, 200, { ok: true, path: file });
          }
          if (act === "revoke") {
            const plan = loadPlan(slug);
            const entry = (plan.history || []).find((h) => Number(h.at) === Number(body.at));
            if (!entry) return json(res, 404, { ok: false, error: "that status is not in the history" });
            const s2 = await sock();
            if (!s2) return json(res, 400, { ok: false, error: "WhatsApp is not connected" });
            const gone = entry.key ? await revokeStatus(s2, entry.key) : false;
            forgetHistory(slug, body.at);
            return json(res, 200, {
              ok: true,
              deletedFromWhatsApp: gone,
              note: gone ? "deleted from WhatsApp too" : "removed from the list only — WhatsApp still shows it",
              status: statusState(slug),
            });
          }
          if (act === "settings") {
            const v = body.values || {};
            applyValues(v);
            reloadConfig();
            log("dashboard: status settings updated (applied live)");
            return json(res, 200, { ok: true, status: statusState(slug) });
          }
          if (act === "post") {
            const s2 = await sock();
            if (!s2) return json(res, 400, { ok: false, error: "WhatsApp is not connected" });
            const item = body.id ? (loadPlan(slug).items || []).find((i) => i.id === body.id) : null;
            const text = String(body.text ?? item?.text ?? "").trim();
            const media = String(body.media ?? item?.media ?? "");
            if (!text && !media) return json(res, 400, { ok: false, error: "nothing to post" });
            const key = await postStatus(s2, text, {
              audience: body.everyone ? null : statusAudience(),
              color: body.color || item?.color || "",
              font: Number(body.font) || item?.font || 1,
              media,
            });
            // posting a planned item by hand should tick it off the plan
            if (key && item) markPosted(slug, item, key);
            return json(res, 200, { ok: !!key, posted: key ? text : "", status: statusState(slug) });
          }
          return json(res, 200, { ok: true, status: statusState(slug) });
        }

        if (url.pathname === "/api/traits") {
          const slug = String(body.slug || config.persona).replace(/[^\w.-]/g, "");
          const current = loadTraits(slug);
          const saved = saveTraits(slug, {
            humor: body.humor !== undefined ? { ...current.humor, ...body.humor } : current.humor,
            interest: body.interest !== undefined ? { ...current.interest, ...body.interest } : current.interest,
            learned: current.learned,
            source: "manual",
          });
          log(`dashboard: traits ${slug} saved (humour ${Math.round(saved.humor.chance * 100)}%, interest ${Math.round(saved.interest.level * 100)}%)`);
          return json(res, 200, { ok: true, traits: saved });
        }

        if (url.pathname === "/api/traits/gen") {
          const slug = String(body.slug || config.persona).replace(/[^\w.-]/g, "");
          const p = loadPersona(slug);
          const t = await generateTraits(p, loadWorld(slug), { force: true });
          return json(res, 200, { ok: true, traits: t });
        }

        if (url.pathname === "/api/persona/import") {
          const bundle = typeof body.bundle === "string" ? JSON.parse(body.bundle) : body.bundle;
          const r = importPersona(bundle, {
            overwrite: body.overwrite === true,
            applySettings: body.applySettings === true,
            setEnvFn: setEnv,
          });
          if (!r.ok) return json(res, 400, { ok: false, error: r.reason });
          if (r.settingsApplied) reloadConfig();
          log(`dashboard: imported character ${r.slug}${r.renamed ? " (renamed)" : ""}`);
          return json(res, 200, r);
        }

        if (url.pathname === "/api/persona/delete") {
          const r = deletePersona(String(body.slug || ""), { setEnvFn: setEnv });
          if (!r.ok) return json(res, 400, { ok: false, error: r.reason });
          reloadConfig();
          log(`dashboard: character ${r.slug} moved to .trash${r.switchedTo ? ` (now using ${r.switchedTo})` : ""}`);
          return json(res, 200, r);
        }

        if (url.pathname === "/api/persona/restore") {
          const r = restoreFromTrash(String(body.file || ""), { setEnvFn: setEnv });
          if (!r.ok) return json(res, 400, { ok: false, error: r.reason });
          return json(res, 200, r);
        }

        if (url.pathname === "/api/persona/save") {
          const slug = String(body.slug || config.persona).replace(/[^\w.-]/g, "");
          const file = path.join(PERSONA_DIR, `${slug}.md`);
          if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: "persona not found" });
          const fm = body.frontmatter && typeof body.frontmatter === "object" ? body.frontmatter : {};
          const lines = Object.entries(fm)
            .filter(([k]) => /^[a-z_]+$/i.test(k))
            .map(([k, v]) => `${k}: ${String(v).replace(/\n/g, " ").trim()}`);
          const text = `---\n${lines.join("\n")}\n---\n\n${String(body.body || "").trim()}\n`;
          fs.writeFileSync(file, text);
          log(`dashboard: persona ${slug} saved (${lines.length} fields)`);
          return json(res, 200, { ok: true, slug });
        }

        if (url.pathname === "/api/admin") {
          const msg = String(body.message || "").trim();
          if (!msg) return json(res, 400, { ok: false, error: "empty message" });
          const run = () =>
            runAdmin({
              message: msg,
              history: Array.isArray(body.history) ? body.history : [],
              context: { personas: personaList().map((p) => p.slug), contacts },
            }).then((r) => {
              if (r.reload) SETTINGS_LOADED_HINT = true;
              return r;
            });

          // sync=1 for scripts and tests; the dashboard polls instead
          if (body.sync === true) {
            const r = await run();
            return json(res, 200, { ok: r.ok, say: r.say, applied: r.applied, refused: r.refused, degraded: r.degraded === true });
          }
          const job = startAdminJob(run);
          return json(res, 202, { ok: true, jobId: job.id, status: "running" });
        }

        if (url.pathname === "/api/world") {
          const slug = String(body.slug || config.persona).replace(/[^\w.-]/g, "");
          const w = saveWorld(slug, {
            backstory: body.backstory,
            cast: Array.isArray(body.cast) ? body.cast : [],
            context: body.context !== undefined ? cleanContext(body.context) : loadWorld(slug).context,
            generatedAt: Date.now(),
            source: "manual",
          });
          log(`dashboard: world ${slug} saved (${w.cast.length} people)`);
          return json(res, 200, { ok: true, world: w });
        }

        if (url.pathname === "/api/world/gen") {
          const slug = String(body.slug || config.persona).replace(/[^\w.-]/g, "");
          const p = loadPersona(slug);
          const w = await ensureWorld(p, { force: true });
          if (!w || (!w.backstory && !w.cast.length)) {
            return json(res, 400, { ok: false, error: "the model could not build a world" });
          }
          return json(res, 200, { ok: true, world: w });
        }

        if (url.pathname === "/api/schedule") {
          const slug = String(body.slug || config.persona).replace(/[^\w.-]/g, "");
          if (!fs.existsSync(path.join(PERSONA_DIR, `${slug}.md`))) {
            return json(res, 404, { ok: false, error: "character not found" });
          }
          const spec = typeof body.slots === "string" ? body.slots : formatSchedule(body.slots);
          const parsed = parseSchedule(spec);
          setPersonaField(slug, "chat_schedule", spec);
          if (typeof body.activeHours === "string") setPersonaField(slug, "active_hours", body.activeHours);
          if (typeof body.workHours === "string") setPersonaField(slug, "work_hours", body.workHours);
          log(`dashboard: schedule ${slug} → ${spec} (${parsed.length} slots)`);
          return json(res, 200, { ok: true, slots: spec, count: parsed.length });
        }

        if (url.pathname === "/api/schedule/gen") {
          const slug = String(body.slug || config.persona).replace(/[^\w.-]/g, "");
          const p = loadPersona(slug);
          const r = await generateSchedule(p, {
            count: Number(body.count) || 5,
            current: p.chat_schedule || "",
            quiet: [config.quietStart, config.quietEnd],
          });
          if (!r) return json(res, 400, { ok: false, error: "the model could not build a schedule" });
          if (body.apply !== false) setPersonaField(slug, "chat_schedule", r.spec);
          log(`dashboard: schedule generated for ${slug} → ${r.spec} (${r.why})`);
          return json(res, 200, { ok: true, ...r });
        }

        if (url.pathname === "/api/memory") {
          const chat = loadChat(body.jid);
          chat.memory ||= {};
          const m = chat.memory;
          const list = ["facts", "boundaries", "plans", "jokes"].includes(body.list) ? body.list : "";
          const value = String(body.value || "").trim().slice(0, 300);
          m[list] ||= [];
          m.pinned ||= [];

          if (body.action === "add" && list && value) {
            if (!m[list].some((x) => String(x).toLowerCase() === value.toLowerCase())) m[list].push(value);
          } else if (body.action === "delete" && list) {
            const i = Number(body.index);
            if (Number.isFinite(i) && i >= 0) {
              const [gone] = m[list].splice(i, 1);
              m.pinned = m.pinned.filter((p) => !(p.list === list && p.text === gone));
            }
          } else if (body.action === "pin" && list && value) {
            if (!m.pinned.some((p) => p.list === list && p.text === value)) m.pinned.push({ list, text: value });
            if (!m[list].some((x) => String(x) === value)) m[list].push(value);
          } else if (body.action === "unpin" && list && value) {
            m.pinned = m.pinned.filter((p) => !(p.list === list && p.text === value));
          } else if (body.action === "summary") {
            m.summary = String(body.value || "").slice(0, 1200);
          } else if (body.action === "relationship") {
            m.relationship = String(body.value || "").slice(0, 200);
          } else if (body.action === "clear" && list) {
            m[list] = [];
            m.pinned = m.pinned.filter((p) => p.list !== list);
          } else {
            return json(res, 400, { ok: false, error: "unknown memory action" });
          }
          saveChat(chat);
          log(`dashboard: memory ${body.action} ${list || ""} for ${body.jid}`);
          return json(res, 200, { ok: true, memory: { facts: m.facts, boundaries: m.boundaries, plans: m.plans, jokes: m.jokes, pinned: m.pinned, summary: m.summary, relationship: m.relationship } });
        }

        if (url.pathname === "/api/context") {
          const slug = String(body.slug || config.persona).replace(/[^\w.-]/g, "");
          const world = loadWorld(slug);
          if (body.action === "remove") {
            const list = cleanContext(world.context).filter((c) => c.text !== String(body.text || ""));
            saveWorld(slug, { ...world, context: list });
            return json(res, 200, { ok: true, context: list });
          }
          const list = addContext(world, body.text, body.until);
          saveWorld(slug, { ...world, context: list });
          log(`dashboard: context added to ${slug}: ${String(body.text).slice(0, 60)}`);
          return json(res, 200, { ok: true, context: list });
        }

        if (url.pathname === "/api/routine/new") {
          const slug = String(body.slug || config.persona).replace(/[^\w.-]/g, "");
          const p = loadPersona(slug);
          const fresh = await ensureToday(p, { force: true });
          if (!fresh) return json(res, 400, { ok: false, error: "the model could not build a routine" });
          tickMoments(fresh);
          saveRoutine(slug, prune(fresh));
          return json(res, 200, { ok: true, routine: fresh });
        }

        if (url.pathname === "/api/persona") {
          if (!body.slug || !fs.existsSync(path.join(PERSONA_DIR, `${body.slug}.md`))) {
            return json(res, 400, { ok: false, error: "persona not found" });
          }
          const meta = parsePersonaFrontmatter(fs.readFileSync(path.join(PERSONA_DIR, `${body.slug}.md`), "utf8"));
          const { setEnv } = await import("../scripts/_settings.mjs");
          setEnv("PERSONA", body.slug);
          if (meta.name) setEnv("BOT_NAME", meta.name);
          log(`dashboard: persona → ${body.slug}`);
          return json(res, 200, { ok: true });
        }

        if (url.pathname === "/api/block") {
          const chat = loadChat(body.jid);
          if (chat.trusted === true) return json(res, 400, { ok: false, error: "trusted contacts are never blocked" });
          let confirmed = null;
          if (body.block) {
            const { getSock } = await import("./whatsapp.mjs");
            const sock = getSock();
            if (!sock) return json(res, 400, { ok: false, error: "WhatsApp is not connected" });
            const { blockNumber } = await import("./stranger.mjs");
            confirmed = await blockNumber(sock, chat, "manual, from the dashboard");
          } else {
            unblock(chat);
            try {
              const { getSock } = await import("./whatsapp.mjs");
              await getSock()?.updateBlockStatus(chat.jid, "unblock");
            } catch (err) {
              log(`unblock on WhatsApp failed: ${err.message}`);
            }
          }
          saveChat(chat);
          log(`dashboard: blocked=${Boolean(body.block)} for ${body.jid}`);
          return json(res, 200, {
            ok: true,
            blocked: Boolean(body.block),
            onWhatsApp: confirmed !== false,
            error: confirmed === false ? chat.stranger?.blockError || "WhatsApp refused the block" : "",
          });
        }

        if (url.pathname === "/api/trust") {
          const chat = loadChat(body.jid);
          chat.trusted = body.trusted === true;
          if (!chat.trusted) {
            // losing trust also drops the pet name and any warmth she gave them
            chat.profile.nick = "";
            chat.softUntil = 0;
            chat.commitments = [];
            chat.instructions = [];
          } else if (!chat.profile.nick && config.defaultNick) {
            // gaining trust back restores the default pet name
            chat.profile.nick = config.defaultNick;
          }
          chat.moodLock = null;
          chat.mood = newMood(baselineFor(chat));
          saveChat(chat);
          log(`dashboard: trusted=${chat.trusted} for ${body.jid}`);
          return json(res, 200, { ok: true, trusted: chat.trusted, mood: chat.mood, nick: chat.profile.nick });
        }

        if (url.pathname === "/api/mood") {
          const chat = loadChat(body.jid);
          const m = normalize(chat.mood || newMood(baselineFor(chat)));
          for (const k of MOOD_KEYS) {
            if (body.mood && body.mood[k] !== undefined) {
              const n = Number(body.mood[k]);
              if (Number.isFinite(n)) m[k] = n;
            }
          }
          chat.mood = cohere(m);
          // manual mode is sticky: she keeps exactly these numbers until
          // "Auto mood" is pressed again
          if (body.lock === true) {
            chat.moodLock = { locked: true, at: Date.now(), value: { ...chat.mood } };
            if (chat.moodLock.value.updatedAt) delete chat.moodLock.value.updatedAt;
          }
          saveChat(chat);
          log(`dashboard: mood ${body.jid} → ${moodLabel(chat.mood)}${body.lock ? " (locked)" : ""}`);
          return json(res, 200, { ok: true, mood: chat.mood, label: moodLabel(chat.mood), locked: chat.moodLock?.locked === true });
        }

        if (url.pathname === "/api/mood/auto") {
          const chat = loadChat(body.jid);
          const persona = loadPersona(chat.persona || undefined);
          let suggested = null;
          try {
            suggested = await suggestMood(chat, persona);
          } catch (err) {
            log(`dashboard: suggestMood failed ${err.message}`);
          }
          if (!suggested) return json(res, 400, { ok: false, error: "the model returned no mood" });
          if (body.apply) {
            // leaving manual mode: hand the mood back to the tracker
            chat.moodLock = null;
            chat.mood = cohere({ ...normalize(chat.mood), ...suggested.mood });
            saveChat(chat);
            log(`dashboard: auto mood ${body.jid} → ${moodLabel(chat.mood)} (${suggested.reason})`);
          }
          return json(res, 200, { ok: true, suggested, mood: chat.mood, label: moodLabel(chat.mood), locked: false });
        }

        if (url.pathname === "/api/contact") {
          const chat = loadChat(body.jid);
          chat.profile = chat.profile || {};
          if (body.field === "persona") chat.persona = body.value;
          else if (body.field === "relation") {
            const type = String(body.value || "");
            chat.relation = { type: RELATIONS[type] ? type : "", note: String(body.note || chat.relation?.note || "").slice(0, 160) };
          } else if (body.field === "relationNote") {
            chat.relation = { type: chat.relation?.type || "", note: String(body.value || "").slice(0, 160) };
          } else if (body.field === "phone") chat.profile.phone = String(body.value || "").replace(/[^\d+]/g, "");
          else if (["name", "nick", "number", "notes"].includes(body.field)) chat.profile[body.field] = body.value;
          saveChat(chat);
          return json(res, 200, { ok: true });
        }

        if (url.pathname === "/api/contact/reset") {
          const chat = loadChat(body.jid);
          chat.history = [];
          chat.coldUntil = 0;
          chat.lastSkipAt = 0;
          chat.proactive = { state: "idle", sentAt: 0, nudgedAt: 0, drySince: 0, dryCount: 0, lastDry: "", lastSlot: "" };
          if (body.mood) chat.mood = null;
          saveChat(chat);
          log(`dashboard: reset ${body.jid}`);
          return json(res, 200, { ok: true });
        }

        if (url.pathname === "/api/proactive") {
          const { forceProactiveNow } = await import("./proactive.mjs");
          const result = await forceProactiveNow(body.jid || undefined);
          return json(res, result.ok ? 200 : 400, result);
        }

        if (url.pathname === "/api/eval") {
          if (isEvalRunning()) return json(res, 200, { ok: false, error: "already running" });
          const { execFile } = await import("node:child_process");
          log("dashboard: humanness check started");
          execFile(process.execPath, ["scripts/eval.mjs", "--quick"], { cwd: ROOT, timeout: 20 * 60000 }, (err, stdout) => {
            if (err) log(`dashboard eval failed: ${err.message}`);
            else {
              const m = /suspicion\s*:\s*(\d+)\/100/.exec(stdout);
              log(`dashboard eval done: ${m ? m[1] + "/100" : "no score"}`);
            }
          });
          return json(res, 202, { ok: true, started: true });
        }

        if (url.pathname === "/api/pause") {
          if (body.resume) {
            const st = resumeBot();
            return json(res, 200, { ok: true, paused: false, wasAway: st.lastReason || "" });
          }
          const minutes = Number(body.minutes) || 0;
          if (minutes <= 0) return json(res, 400, { ok: false, error: "minutes must be greater than zero" });
          const st = pauseFor(minutes, body.reason);
          return json(res, 200, { ok: true, paused: true, until: st.until, minutes, reason: st.reason });
        }

        if (url.pathname === "/api/restart") {
          log("dashboard: restart requested");
          json(res, 200, { ok: true, message: "restarting…" });
          const child = spawn("bash", ["-c", "sleep 1; ./restart.sh"], { cwd: ROOT, detached: true, stdio: "ignore" });
          child.unref();
          return;
        }
      }

      return json(res, 404, { error: "not found" });
    } catch (err) {
      log(`dashboard error: ${err.message}`);
      return json(res, 500, { error: err.message });
    }
  });

  server.listen(config.dashboardPort, config.dashboardHost, () => {
    const host = config.dashboardHost === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
    log(`dashboard: http://${host}:${config.dashboardPort}`);
  });
  server.on("error", (err) => log(`dashboard failed: ${err.message}`));
}
