import { config, log, ROOT, PERSONA_DIR, PROMPT_DIR } from "./config.mjs";
import { listChats, saveChat, loadChat, loadState, saveState } from "./store.mjs";
import { loadPersona } from "./prompt.mjs";
import { generateProactive, generateNudge, generateFollowup, generateCheckup } from "./engine.mjs";
import { getSock, sendText, presence, setGlobalPresence } from "./whatsapp.mjs";
import { splitBubbles, typingDelayFor, sleep } from "./texting.mjs";
import { applyDeltas, normalize, isMoodLocked } from "./mood.mjs";
import { ensureToday, tickMoments, momentDeltas, saveRoutine, loadRoutine } from "./routine.mjs";
import { isPaused } from "./pause.mjs";
import { dueForEval, isEvalRunning, runAndRecord } from "./evals.mjs";
import { weekNotifyDue, markWeekNotified, weekText } from "./week.mjs";
import { watchFiles } from "./changes.mjs";
import { ensurePlan, dueStatus, markPosted, postStatus } from "./status.mjs";

/**
 * proactive.mjs — she has her own life.
 *
 * Two independent jobs:
 *  1. initiate : after a long silence, she texts first (respecting quiet hours).
 *  2. escalate : watches the "she texted first, no reply" state machine:
 *
 *        idle ──(long silence)──> awaiting ──(NUDGE_AFTER_MIN)──> nudged
 *                                     │                             │
 *                                     │ (user replies)              │ (DRY_AFTER_MIN)
 *                                     v                             v
 *                                   idle                          dry ──(user softens)──> idle
 *
 *     - awaiting : she texted first, waiting.
 *     - nudged   : she asked why they didn't reply.
 *     - dry      : "ok fine." then dry texting ("y.", "h", "k.") until they soften her.
 */

const DRY_OPEN = ["ok fine.", "fine.", "ok."];
const DRY_REPLIES = ["y.", "h.", "k.", "ok.", "sure.", "mhm.", "yeah.", "nothing."];

function inQuietHours() {
  const h = new Date().getHours();
  const { quietStart: s, quietEnd: e } = config;
  return s <= e ? h >= s && h < e : h >= s || h < e;
}

const mins = (ms) => ms / 60000;

let lastPresence = null;

/**
 * Let people see her come online during her own hours and go offline to sleep.
 * Presence is account-wide, so it is derived from the global persona schedule.
 */
async function updatePresence(sock) {
  if (!config.presence) return;
  const persona = loadPersona();
  const spec = persona.active_hours || config.proactiveWindows;
  const awake = !inQuietHours() && windowWeight(spec, new Date()) > 0;
  const next = awake ? "available" : "unavailable";
  if (next === lastPresence) return;
  lastPresence = next;
  await setGlobalPresence(sock, next);
  log(`presence → ${next}${awake ? " (online)" : " (offline/sleeping)"}`);
}

/**
 * How likely is she to be awake / on her phone at this hour?
 * spec: "11-14,17-19,21-2" or "12-14:0.6,20-1:1.5" (weights optional).
 * Returns 0 when outside every window, otherwise the best matching weight (default 1).
 */
export function windowWeight(spec, date = new Date()) {
  if (!spec || !String(spec).trim()) return 1;
  const h = date.getHours();
  let best = 0;
  for (const part of String(spec).split(",")) {
    const chunk = part.trim();
    if (!chunk) continue;
    const m = chunk.match(/^(\d{1,2})\s*-\s*(\d{1,2})(?:\s*:\s*([\d.]+))?$/);
    if (!m) continue;
    const start = Number(m[1]);
    const end = Number(m[2]);
    const weight = m[3] !== undefined ? Number(m[3]) : 1;
    const inside = start <= end ? h >= start && h < end : h >= start || h < end;
    if (inside) best = Math.max(best, Number.isFinite(weight) ? weight : 1);
  }
  return best;
}

/**
 * Fixed daily times she texts first.
 * spec: "12:30,19:00,23:30" (fixed minutes) or "11,12,13,17,18,19,20,22,23,0"
 * (hours only -> the minute is picked per day, so it differs every day but stays
 * stable within that day). A slot fires only inside its grace window and only if
 * she is eligible, so a missed slot is skipped rather than fired late.
 * Optional deterministic jitter: SCHEDULE_JITTER_MIN=5.
 */
function hashInt(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function dueSlot(spec, now = Date.now(), { jitterMin = 0, graceMin = 20, lastSlot = "" } = {}) {
  if (!spec || !String(spec).trim()) return null;
  const d = new Date(now);
  const day = localDay(d);
  for (const part of String(spec).split(",")) {
    // "12:30" = fixed minute · "12" or "12:*" = dynamic minute for that day
    const m = part.trim().match(/^(\d{1,2})(?::(\d{2}|\*))?$/);
    if (!m) continue;
    const hhNum = Number(m[1]);
    if (hhNum > 23) continue;
    const hh = String(hhNum).padStart(2, "0");
    const minute =
      m[2] && m[2] !== "*"
        ? Number(m[2])
        : hashInt(`${day} ${hh} min`) % 60; // same minute all day, different each day
    if (minute > 59) continue;
    const mm = String(minute).padStart(2, "0");
    const key = `${day} ${hh}:${mm}`;
    if (key === lastSlot) continue;
    const t = new Date(d);
    t.setHours(hhNum, minute, 0, 0);
    let fireAt = t.getTime();
    if (jitterMin > 0) {
      const span = Math.round(jitterMin * 2);
      fireAt += ((hashInt(key) % (span + 1)) - jitterMin) * 60000;
    }
    if (now >= fireAt && now - fireAt <= graceMin * 60000) return { key, at: fireAt, hour: hhNum, minute };
  }
  return null;
}

/**
 * WhatsApp Status: plan the day's arc once, then post each item when its time comes.
 * Never during quiet hours — a story at 4am is not a thing she would do.
 */
async function maybePostStatus(sock) {
  if (!config.waStatus || inQuietHours()) return;
  try {
    const persona = loadPersona();
    const slug = persona.slug || config.persona;
    const routine = loadRoutine(slug);
    await ensurePlan(persona, routine, null);
    const due = dueStatus(slug);
    if (!due) return;
    const ok = await postStatus(sock, due.text);
    if (ok) markPosted(slug, due);
  } catch (err) {
    log(`status tick failed: ${err.message}`);
  }
}

/** Sunday evening: a short recap of her week, for the owner. */
async function maybeWeekDigest() {
  const st = loadState();
  if (!weekNotifyDue(st)) return;
  markWeekNotified(st);
  saveState(st);
  try {
    const { execFile } = await import("node:child_process");
    execFile("termux-notification", ["-t", "Understudy — her week", "-c", weekText()], () => {});
  } catch {
    /* notification is best effort */
  }
}

/**
 * The weekly humanness check: run it in the background at a quiet hour, so the
 * score trend does not depend on someone remembering to run it.
 */
async function maybeRunEval() {
  if (!dueForEval() || isEvalRunning()) return;
  const hour = new Date().getHours();
  if (hour < 3 || hour > 6) return; // only in the small hours
  log("weekly humanness check starting");
  const { default: _ } = { default: null };
  const runner = async () => {
    const { execFile } = await import("node:child_process");
    return await new Promise((resolve, reject) => {
      execFile(process.execPath, ["scripts/eval.mjs", "--quick"], { cwd: ROOT, timeout: 15 * 60000 }, (err, stdout) => {
        if (err) return reject(err);
        const m = /suspicion\s*:\s*(\d+)\/100/.exec(stdout);
        if (!m) return reject(new Error("no score in the eval output"));
        resolve({ score: Number(m[1]), verdict: /→\s*(\w+)/.exec(stdout)?.[1] || "unsure", model: "scheduled", notes: "run from the scheduler" });
      });
    });
  };
  await runAndRecord(runner);
}

/**
 * Her day: make sure today's plan exists, then let the moments that have come
 * due move her mood. Stored privately per contact.
 */
async function tickRoutines() {
  if (!config.routine) return;
  const chats = listChats().filter((c) => c.trusted === true);
  if (!chats.length) return;

  // one day per character, applied to everyone she talks to
  const slugs = new Set(chats.map((c) => c.persona || config.persona));
  slugs.add(config.persona);

  for (const slug of slugs) {
    try {
      const persona = loadPersona(slug);
      const routine = await ensureToday(persona);
      if (!routine) continue;
      const fresh = !routine.createdAt || Date.now() - routine.createdAt < 5 * 60000;
      const fired = tickMoments(routine);
      if (fresh || fired.length) saveRoutine(slug, routine);
      if (!fired.length) continue;
      for (const chat of chats) {
        if ((chat.persona || config.persona) !== slug) continue;
        if (!isMoodLocked(chat)) {
          for (const m of fired) chat.mood = applyDeltas(normalize(chat.mood), momentDeltas(m));
        }
        saveChat(chat);
      }
    } catch (err) {
      log(`routine tick failed: ${err.message}`);
    }
  }
}

/** May she start a conversation right now? */
export function initiateEligible(chat, now = Date.now()) {
  const p = chat.proactive || {};
  // she only ever messages first the people she actually knows
  if (chat.trusted !== true) return false;
  if (p.state && p.state !== "idle") return false;
  if (mins(now - (chat.lastInteraction || 0)) < config.proactiveIdleMin) return false;
  if (mins(now - (chat.lastProactiveAt || 0)) < config.proactiveGapMin) return false;
  return true;
}

async function deliver(sock, chat, text) {
  const bubbles = splitBubbles(text);
  for (let i = 0; i < bubbles.length; i++) {
    await presence(sock, chat.jid, "composing");
    await sleep(typingDelayFor(bubbles[i]));
    try {
      await sendText(sock, chat.jid, bubbles[i]);
    } catch (err) {
      log(`proactive send failed: ${err.message}`);
      break;
    }
    chat.stats.outbound = (chat.stats.outbound || 0) + 1;
    if (i < bubbles.length - 1) await sleep(300 + Math.random() * 700);
  }
  await presence(sock, chat.jid, "paused");
}

function escalateKind(chat, now) {
  if (!config.sulking) return null; // sulking is switched off
  const p = chat.proactive || {};
  if (p.state === "awaiting" && p.sentAt && mins(now - p.sentAt) > config.nudgeAfterMin) return "nudge";
  if (p.state === "nudged" && p.nudgedAt && mins(now - p.nudgedAt) > config.dryAfterMin) return "dry";
  return null;
}

const SOFT_RETRACT = [
  "forget what i said.",
  "whatever. nothing.",
  "don't get used to it.",
  "ignore that.",
  "hm. never mind.",
];

/** The soft window ended — she pulls back, and sometimes retracts it out loud. */
async function checkSoft(sock) {
  if (!config.softMode) return;
  const now = Date.now();
  for (const chat of listChats()) {
    if (!chat.softUntil || chat.softUntil > now) continue;
    chat.softUntil = 0;
    if (!isMoodLocked(chat)) chat.mood = applyDeltas(normalize(chat.mood), {
      affection: -0.18,
      valence: -0.06,
      playfulness: -0.1,
    });
    saveChat(chat);
    log("soft window closed — pulling back");
    if (!inQuietHours() && Math.random() < config.softRetractChance) {
      const line = SOFT_RETRACT[Math.floor(Math.random() * SOFT_RETRACT.length)];
      await deliver(sock, chat, line);
      saveChat(chat);
      log(`retract → ${chat.jid}: ${line}`);
    }
    return;
  }
}

/** She told them to eat/sleep/workout — a few minutes later she checks. */
async function checkInstructions(sock) {
  if (!config.instructionFollowup || inQuietHours()) return;
  const now = Date.now();
  for (const chat of listChats()) {
    if (!/@(lid|s\.whatsapp\.net)$/.test(chat.jid)) continue;
    const due = (chat.instructions || []).find((i) => !i.done && i.due <= now);
    if (!due) continue;

    const persona = loadPersona(chat.persona || undefined);
    let text;
    try {
      text = await generateCheckup(chat, persona, due, {});
    } catch (err) {
      log(`checkup generate failed: ${err.message}`);
      due.due = Date.now() + 20 * 60000;
      saveChat(chat);
      continue;
    }
    if (!text) {
      due.due = Date.now() + 20 * 60000;
      saveChat(chat);
      continue;
    }

    await deliver(sock, chat, text);
    due.done = true;
    due.doneAt = Date.now();
    chat.proactive = {
      state: "awaiting",
      sentAt: Date.now(),
      nudgedAt: 0,
      drySince: 0,
      dryCount: 0,
      lastDry: "",
      lastSlot: "checkup",
    };
    chat.lastProactiveAt = Date.now();
    saveChat(chat);
    log(`check-up (${due.label}) → ${chat.jid}: ${text}`);
    return; // one thing per tick
  }
}

/** Promises she made to report back: "nanti aku kabarin kalau udah selesai". */
async function followUps(sock) {
  if (!config.commitments || inQuietHours()) return;
  const now = Date.now();
  for (const chat of listChats()) {
    if (!/@(lid|s\.whatsapp\.net)$/.test(chat.jid)) continue;
    const due = (chat.commitments || []).find((c) => !c.done && c.due <= now);
    if (!due) continue;

    const persona = loadPersona(chat.persona || undefined);
    let text;
    try {
      text = await generateFollowup(chat, persona, due, {});
    } catch (err) {
      log(`followup generate failed: ${err.message}`);
      due.due = Date.now() + 30 * 60000;
      saveChat(chat);
      continue;
    }
    if (!text) {
      due.due = Date.now() + 30 * 60000;
      saveChat(chat);
      continue;
    }

    await deliver(sock, chat, text);
    due.done = true;
    due.doneAt = Date.now();
    chat.proactive = {
      state: "awaiting",
      sentAt: Date.now(),
      nudgedAt: 0,
      drySince: 0,
      dryCount: 0,
      lastDry: "",
      lastSlot: "commitment",
    };
    chat.lastProactiveAt = Date.now();
    saveChat(chat);
    log(`follow-up (janji) → ${chat.jid}: ${text}`);
    return; // one thing per tick
  }
}

async function escalate(sock) {
  const now = Date.now();
  for (const chat of listChats()) {
    if (!/@(lid|s\.whatsapp\.net)$/.test(chat.jid)) continue;
    const kind = escalateKind(chat, now);
    if (!kind) continue;

    const persona = loadPersona(chat.persona || undefined);
    let text;
    if (kind === "nudge") {
      text = (await generateNudge(chat, persona, {})) || "kenapa ga dibales?";
    } else {
      text = DRY_OPEN[Math.floor(Math.random() * DRY_OPEN.length)];
    }

    await deliver(sock, chat, text);

    chat.proactive = { ...chat.proactive };
    if (kind === "nudge") {
      chat.proactive.state = "nudged";
      chat.proactive.nudgedAt = Date.now();
    } else {
      chat.proactive.state = "dry";
      chat.proactive.drySince = Date.now();
      chat.proactive.dryCount = 0;
      chat.coldUntil = Date.now() + 60 * 60 * 1000;
    }
    // being ignored hurts
    if (!isMoodLocked(chat)) chat.mood = applyDeltas(normalize(chat.mood), {
      valence: -0.12,
      patience: -0.15,
      affection: -0.05,
      arousal: 0.1,
    });
    saveChat(chat);
    log(`proactive ${kind} → ${chat.jid}: ${text}`);
    return; // one action per tick
  }
}

async function initiate(sock) {
  if (inQuietHours()) return;
  const now = Date.now();
  for (const chat of listChats()) {
    if (!/@(lid|s\.whatsapp\.net)$/.test(chat.jid)) continue;
    if (!initiateEligible(chat, now)) continue;

    const persona = loadPersona(chat.persona || undefined);
    const schedule = String(persona.chat_schedule || config.proactiveSchedule || "").trim();
    let slotKey = (chat.proactive && chat.proactive.lastSlot) || "";

    if (schedule) {
      // fixed daily times
      const slot = dueSlot(schedule, now, {
        jitterMin: config.scheduleJitterMin,
        graceMin: config.scheduleGraceMin,
        lastSlot: slotKey,
      });
      if (!slot) continue;
      slotKey = slot.key;
    } else {
      // fallback: her active hours + a small chance per check
      const weight = windowWeight(persona.active_hours || config.proactiveWindows, new Date(now));
      if (weight <= 0) continue;
      if (Math.random() > config.proactiveChancePerTick * weight) continue;
    }
    let text;
    try {
      text = await generateProactive(chat, persona, {});
    } catch (err) {
      log(`proactive generate failed: ${err.message}`);
      continue;
    }
    if (!text) continue;

    await deliver(sock, chat, text);
    chat.proactive = {
      state: "awaiting",
      sentAt: Date.now(),
      nudgedAt: 0,
      drySince: 0,
      dryCount: 0,
      lastDry: "",
      lastSlot: slotKey,
    };
    chat.lastProactiveAt = Date.now();
    saveChat(chat);
    log(`proactive → ${chat.jid}${slotKey ? ` [slot ${slotKey}]` : ""}: ${text}`);
    return;
  }
}

export function startProactive() {  if (!config.proactive) {
    log("proactive: off");
    return;
  }

  // one lightweight pass per tick: resolve pending escalation first, then
  // (maybe) start a conversation. No long random timer that can miss the window.
  setInterval(() => {
    const sock = getSock();
    if (!sock) return;
    (async () => {
      if (isPaused()) return; // switched off: nothing first, nothing scheduled
      if (config.presence) await updatePresence(sock);
      await tickRoutines();
      await checkSoft(sock);
      await checkInstructions(sock);
      await followUps(sock);
      await escalate(sock);
      await initiate(sock);
      await maybeRunEval();
      await maybeWeekDigest();
      watchFiles({ personaDir: PERSONA_DIR, promptDir: PROMPT_DIR, slug: config.persona });
      await maybePostStatus(sock);
    })().catch((err) => log(`proactive error: ${err.message}`));
  }, config.proactiveTickSec * 1000);

  log(
    `proactive: on (checks every ${config.proactiveTickSec}s; ` +
      (config.proactiveSchedule
        ? `schedule ${config.proactiveSchedule}`
        : "no global schedule (per-persona chat_schedule)") +
      `; idle >${config.proactiveIdleMin} min, min gap ${config.proactiveGapMin} min; ` +
      `nudge after ${config.nudgeAfterMin} min, dry after ${config.dryAfterMin} min; quiet ${config.quietStart}-${config.quietEnd})`,
  );
}

/** Force her to text first right now (dashboard button / testing). */
export async function forceProactiveNow(jid) {
  const sock = getSock();
  if (!sock) return { ok: false, reason: "WhatsApp belum tersambung" };
  const chats = jid ? [loadChat(jid)] : listChats().filter((c) => /@(lid|s\.whatsapp\.net)$/.test(c.jid));
  for (const chat of chats) {
    if (!/@(lid|s\.whatsapp\.net)$/.test(chat.jid)) continue;
    const persona = loadPersona(chat.persona || undefined);
    let text;
    try {
      text = await generateProactive(chat, persona, {});
    } catch (err) {
      return { ok: false, reason: err.message };
    }
    if (!text) return { ok: false, reason: "model memilih SKIP (nggak ada yang mau dikirim)" };
    await deliver(sock, chat, text);
    chat.proactive = {
      state: "awaiting",
      sentAt: Date.now(),
      nudgedAt: 0,
      drySince: 0,
      dryCount: 0,
      lastDry: "",
      lastSlot: "manual",
    };
    chat.lastProactiveAt = Date.now();
    saveChat(chat);
    log(`proactive (manual) → ${chat.jid}: ${text}`);
    return { ok: true, text };
  }
  return { ok: false, reason: "tidak ada kontak" };
}

export { DRY_REPLIES, escalateKind };
