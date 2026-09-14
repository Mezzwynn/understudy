import fs from "node:fs";
import path from "node:path";
import { config, log, DATA_DIR } from "./config.mjs";
import { chat as llmChat } from "./llm.mjs";
import { loadChat, saveChat, loadState, saveState, listChats } from "./store.mjs";
import { isPaused, pausedFor } from "./pause.mjs";
import { recordEvent } from "./events.mjs";
import { isSleeping, shouldIgnore, sleepiness } from "./sleep.mjs";
import { detectCrisis, alertOwner } from "./crisis.mjs";
import { worthReplying } from "./worth.mjs";
import { dailyVariance, busyNow, EDIT_AFTERMATH_PROMPT } from "./natural.mjs";
import { generateReply, generateDryReply } from "./engine.mjs";
import { loadPersona } from "./prompt.mjs";
import { splitBubbles, typingDelayFor, typingPlan, readingDelayFor, pretypeDelayFor, sleep, makeTypo, correctionFor, pickReaction, maybeBurst } from "./texting.mjs";
import { describeImage, transcribeAudio } from "./vision.mjs";
import { synthesize, toSpeakable } from "./voice.mjs";
import { stripAudioTags, detectInjection } from "./guard.mjs";
import { applyDeltas, normalize, isMoodLocked, baselineFor, KEYS as MOOD_KEYS } from "./mood.mjs";
import { generateImage, randomSticker, saveUserSticker } from "./image.mjs";
import { shouldSendPhoto, markSent } from "./photo-library.mjs";
import { makeSelfie } from "./selfie.mjs";
import {
  decide,
  promoteIfReady,
  needsIntroduction,
  markIntroAsked,
  blockNumber,
  tierOf,
  WARN_LINES,
} from "./stranger.mjs";
import { detectMention, addCrossNote, addVouch, resolveNotes } from "./links.mjs";
import { traitsForChat, topicReaction } from "./traits.mjs";
import { runTask, notifyTaskReply } from "./tasks.mjs";
import { ensureToday, tickMoments, momentDeltas, saveRoutine, loadRoutine } from "./routine.mjs";
import {
  phoneFromJid,
  sendText,
  sendReaction,
  sendVoice,
  sendImage,
  sendSticker,
  presence,
  subscribePresence,
  markRead,
  downloadMedia,
} from "./whatsapp.mjs";

/** The few things a busy person still answers: a question, health, an apology, a crisis. */
function mustAnswerSomething(text) {
  const t = String(text || "").toLowerCase();
  if (/\?/.test(t)) return true;
  if (/\b(kenapa|gimana|bagaimana|kapan|dimana|di mana|berapa|siapa|kok|apa)\b/.test(t)) return true;
  if (/\b(makan|makanan|sehat|sakit|demam|obat|tidur|istirahat|minum|rumah sakit|dokter|puskesmas)\b/.test(t)) return true;
  if (/\b(sorry|maaf|sori|forgive|sayang|kangen|rindu|miss you)\b/.test(t)) return true;
  // a photo request is a direct ask: never leave it on read because she is working
  if (/\b(foto|photo|pic|pics|selfie|potret|gambar)\b/.test(t)) return true;
  return false;
}

/* ------------------------------- helpers ------------------------------- */

function unwrap(message) {
  let m = message;
  for (let i = 0; i < 5 && m; i++) {
    if (m.ephemeralMessage) m = m.ephemeralMessage.message;
    else if (m.viewOnceMessage) m = m.viewOnceMessage.message;
    else if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
    else if (m.viewOnceMessageV2Extension) m = m.viewOnceMessageV2Extension.message;
    else if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
    else break;
  }
  return m || {};
}

function plainText(c) {
  return (
    c.conversation ||
    c.extendedTextMessage?.text ||
    c.imageMessage?.caption ||
    c.videoMessage?.caption ||
    c.documentMessage?.caption ||
    c.buttonsResponseMessage?.selectedDisplayText ||
    c.listResponseMessage?.title ||
    null
  );
}

function allowed(jid, senderPhone) {
  const isGroup = jid.endsWith("@g.us");
  if (isGroup) {
    if (!config.allowGroups) return false;
    if (config.groupAllow.length) return config.groupAllow.includes(jid) || config.groupAllow.includes(jid.split("@")[0]);
    return true;
  }
  if (!config.allow.length) return true;
  const withPlus = senderPhone.startsWith("+") ? senderPhone : `+${senderPhone}`;
  return config.allow.includes(senderPhone) || config.allow.includes(withPlus) || config.allow.includes("*");
}

/** Turn a WhatsApp message into text the character can react to. */
async function toText(sock, msg) {
  const c = unwrap(msg.message);
  const caption = plainText(c);
  const base = caption ? caption.trim() : "";

  if (c.imageMessage) {
    let desc = null;
    try {
      const buf = await downloadMedia(msg);
      desc = await describeImage(buf, c.imageMessage.mimetype);
    } catch (err) {
      log(`image download failed: ${err.message}`);
    }
    if (desc) return `[dia ngirim foto: ${desc}${base ? ` — caption: "${base}"` : ""}]`;
    return `[dia ngirim foto tapi fotonya ga muncul di hp kamu${base ? `, katanya "${base}"` : ""}]`;
  }

  if (c.audioMessage) {
    let tr = null;
    try {
      const buf = await downloadMedia(msg);
      tr = await transcribeAudio(buf, c.audioMessage.mimetype);
    } catch (err) {
      log(`audio download failed: ${err.message}`);
    }
    if (tr && tr !== "[no speech]") return `[voice note dari dia: "${tr}"]`;
    return `[dia ngirim voice note tapi ga keplay di hp kamu]`;
  }

  if (c.videoMessage) return `[dia ngirim video${base ? `, caption: "${base}"` : ""}]`;
  if (c.stickerMessage) {
    if (config.saveUserStickers) {
      try {
        const buf = await downloadMedia(msg);
        saveUserSticker(buf);
      } catch (err) {
        log(`sticker download failed: ${err.message}`);
      }
    }
    return `[dia ngirim stiker]`;
  }
  if (c.documentMessage) return `[dia ngirim file${c.documentMessage.fileName ? `: ${c.documentMessage.fileName}` : ""}${base ? ` — "${base}"` : ""}]`;
  if (c.locationMessage || c.liveLocationMessage) return `[dia ngirim lokasi]`;
  if (c.contactMessage || c.contactsArrayMessage) return `[dia ngirim kontak]`;
  if (c.reactionMessage) return null;

  return base || null;
}

/* ------------------------------- queueing ------------------------------ */

const pending = new Map();
const chains = new Map();

function enqueue(jid, fn) {
  const prev = chains.get(jid) || Promise.resolve();
  const next = prev.then(fn).catch((err) => log(`queue error [${jid}]: ${err.stack || err.message}`));
  chains.set(jid, next);
}

function schedule(sock, jid, item) {
  let p = pending.get(jid);
  if (!p) {
    p = { parts: [], keys: [], pushName: "", msg: null, firstAt: Date.now() };
    pending.set(jid, p);
  }
  p.parts.push(item.text);
  if (item.key) p.keys.push(item.key);
  if (item.pushName) p.pushName = item.pushName;
  if (item.msg) p.msg = item.msg;

  // wait for them to stop typing… but never longer than DEBOUNCE_MAX_MS since
  // the first message of the burst (a chatty user shouldn't delay her forever)
  clearTimeout(p.timer);
  const capLeft = p.firstAt + config.debounceMaxMs - Date.now();
  const wait = Math.max(0, Math.min(config.debounceMs, capLeft));
  p.timer = setTimeout(() => {
    pending.delete(jid);
    enqueue(jid, () => respond(sock, jid, p));
  }, wait);
}

/* ------------------------------- respond ------------------------------- */

const INSULT = /(goblok|bego|bodoh|tolol|idiot|bangsat|anjing|kontol|memek|sialan|otak ?(?:nya|mu|lu|kmu)? ?(?:ga|gak|nggak|engga|ngga) (?:sampai|nyampe)|dasar|malesin|nyebelin banget)/i;

export function shouldSkip(chat, incoming) {
  if (config.skipChance <= 0) return false;
  const isMedia = incoming.startsWith("[");
  const bare = isMedia ? "" : incoming.replace(/\s/g, "");
  const insult = INSULT.test(incoming);

  // if they just came back after a long silence, always answer
  const cameBack = Date.now() - (chat.lastInteraction || 0) > 3 * 3600 * 1000;

  // being insulted: walk away (and sulk for a while)
  if (insult && !APOLOGY.test(incoming)) {
    if (chat.mood && chat.mood.patience < 0.35) {
      chat.coldUntil = Date.now() + (8 + Math.random() * 25) * 60000;
      return true;
    }
    if (Math.random() < 0.5) {
      chat.coldUntil = Date.now() + (5 + Math.random() * 15) * 60000;
      return true;
    }
  }

  // still sulking: mostly ignore, unless they apologise or it is important
  if (chat.coldUntil && Date.now() < chat.coldUntil) {
    if (APOLOGY.test(incoming)) {
      chat.coldUntil = 0;
      return false;
    }
    if (bare.length <= 40 && !cameBack) return Math.random() < 0.7;
  }

  if (bare.length > 8) return false;
  if (cameBack) return false;
  // never skip twice in a row / too often
  if (chat.lastSkipAt && Date.now() - chat.lastSkipAt < 6 * 3600 * 1000) return false;

  let chance = config.skipChance;
  if (chat.mood) {
    if (chat.mood.energy < 0.4) chance += 0.06;
    if (chat.mood.valence < -0.1) chance += 0.06;
  }
  return Math.random() < chance;
}

// "genuine" apology = real words, not a bare "maaf"
const APOLOGY = /(maaf|sorry|sori|aku salah|aku khilaf|minta maaf|i'?m sorry|my bad|forgive me|jangan marah|nggak gitu maksudku|aku nyesel)/i;
const SWEET = /(sayang|kangen|miss you|please|plis|jangan gitu|aku cinta|love you)/i;
const SOFTEN = new RegExp(`${APOLOGY.source}|${SWEET.source}`, "i");

/** Mood influences which kind of reply she reaches for. */
function moodMultipliers(mood) {
  if (!config.moodMedia || !mood) return { sticker: 1, reaction: 1, voice: 1, typo: 1 };
  const { valence = 0, energy = 0.6, patience = 0.6, playfulness = 0.5 } = mood;
  return {
    sticker: (playfulness > 0.6 ? 1.6 : 1) * (patience < 0.3 ? 0.5 : 1),
    reaction: (playfulness > 0.6 ? 1.4 : 1) * (valence < -0.2 ? 0.6 : 1),
    voice: (patience < 0.3 ? 1.5 : 1) * (energy < 0.35 ? 1.3 : 1),
    typo: energy < 0.4 ? 1.4 : 1,
  };
}

const MILESTONES = [
  [/\b(aku sayang kamu|aku cinta kamu|i love you|love u)\b/i, "love", "Dia bilang sayang/cinta pertama kali"],
  [/\b(kangen|miss you|miss u)\b/i, "miss", "Dia bilang kangen pertama kali"],
  [APOLOGY, "apology", "Dia minta maaf pertama kali"],
  [INSULT, "fight", "Pertama kali dia kasar / kalian berantem"],
];

/** Record a "first time" once — she can reference these later. */
function recordMilestone(chat, key, label) {
  if (!config.milestones) return false;
  chat.memory.milestones = chat.memory.milestones || [];
  if (chat.memory.milestones.some((m) => m.key === key)) return false;
  chat.memory.milestones.push({ key, label, ts: Date.now() });
  log(`milestone (${chat.jid}): ${label}`);
  return true;
}

function detectMilestones(chat, incoming) {
  for (const [re, key, label] of MILESTONES) {
    if (re.test(incoming)) recordMilestone(chat, key, label);
  }
  if (/^\[voice note/i.test(incoming)) recordMilestone(chat, "first_voice", "Dia kirim voice note pertama kali");
  if (/^\[dia ngirim foto/i.test(incoming)) recordMilestone(chat, "first_photo", "Dia kirim foto pertama kali");
}

/** Which vibes would fit this reply? Used to choose a sticker that matches. */
function stickerVibe(text, mood) {
  const t = String(text || "").toLowerCase();
  const want = [];
  if (/(wkwk|haha|hihi|lucu|geli|receh|anjir|njir)/.test(t)) want.push("lucu", "ketawa");
  if (/(males|capek|cape|bosen|rebahan|ngantuk|insomnia)/.test(t)) want.push("males", "capek", "santai");
  if (/(kesel|marah|bete|nyebelin|jangan|terserah|dih|ah|yaudah)/.test(t)) want.push("kesel", "sinis", "cuek");
  if (/(sayang|kangen|miss|manja|love|geli|sayang)/.test(t)) want.push("sayang", "manja", "kangen");
  if (/(hmm|hah|bingung|gimana|maksudnya|apaansi)/.test(t)) want.push("bingung", "cuek");
  if (/(takut|kaget|panik|gatau|ga tau)/.test(t)) want.push("panik", "kaget", "bingung");
  if (/(sedih|nangis|hiks|huhu|galau)/.test(t)) want.push("sedih", "nangis");
  if (mood) {
    if (mood.playfulness > 0.65) want.push("lucu", "ketawa");
    if (mood.valence < -0.2 || mood.patience < 0.3) want.push("kesel", "sinis");
    if (mood.affection > 0.7) want.push("sayang", "manja");
    if (mood.energy < 0.35) want.push("capek", "males");
  }
  return [...new Set(want)];
}

const DELETE_COVERS = ["nothing.", "lupa.", "gak jadi.", "eh salah.", "nothing, forget it."];

// health/safety signals always break through sulking
const HEALTH_CUE =
  /(sakit|pusing|demam|panas dingin|mual|muntah|gak enak badan|nggak enak badan|lemes|lemas|sesak|darah|dirawat|rumah sakit|opname|kecelakaan|kena musibah|jatuh|belum makan|belum tidur|insomnia|ga bisa tidur|gak bisa tidur|overdosis|nyeri)/i;

export function isGenuineApology(text) {
  if (!APOLOGY.test(text)) return false;
  return text.replace(/\s/g, "").length >= 8; // bare "maaf" is not enough
}
const DRY_LINES = ["y.", "h.", "k.", "ok.", "sure.", "mhm.", "yeah.", "nothing."];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Life events land on every chat she has, and can join today's routine. */
function lifeEvent(kind, what, source = "", personaSlug = null) {
  if (!config.lifeEvents) return;
  return recordEvent({
    kind,
    what,
    source,
    applyToChats: () =>
      listChats()
        .filter((c) => c.trusted === true && c.jid !== source)
        .map((c) => loadChat(c.jid)),
    saveChats: (chats) => chats.forEach((c) => saveChat(c)),
    addMoment: ({ what: w, kind: mkind }) => {
      const slug = personaSlug || config.persona;
      const routine = loadRoutine(slug);
      if (!routine || routine.date !== new Date().toISOString().slice(0, 10)) return;
      routine.moments = [...(routine.moments || []), { at: nowHHMM(), kind: mkind, what: w, intensity: 0.6, share: true, firedAt: Date.now(), live: true }].slice(-8);
      routine.highlights = [...(routine.highlights || []), { date: routine.date, kind: mkind, what: w, intensity: 0.6 }].slice(-10);
      saveRoutine(slug, routine);
    },
  });
}
const nowHHMM = () => `${String(new Date().getHours()).padStart(2, "0")}:${String(new Date().getMinutes()).padStart(2, "0")}`;

/**
 * A voice note that is too short sounds broken when spoken out loud — short
 * belongs in a text message. The exception is a genuinely flustered delivery:
 * a stammer or a breath ("a— aku...", "[pause] ...no.") is allowed to be short.
 */
function voiceLongEnough(text) {
  const words = String(text).split(/\s+/).filter(Boolean).length;
  if (words >= 7) return true;
  const flustered = /—|\[pause\]|\[sighs\]|\[breath|\[whispers\]|\[almost inaudible\]/i.test(String(text));
  return flustered && words >= 3;
}

function pickDryLine(p) {
  let v;
  let guard = 0;
  do {
    v = DRY_LINES[Math.floor(Math.random() * DRY_LINES.length)];
  } while (v === p.lastDry && ++guard < 8);
  p.lastDry = v;
  return v;
}

function scheduleRead(sock, keys) {
  if (!config.markRead || !keys?.length) return;
  const span = Math.max(0, config.readDelayMaxMs - config.readDelayMinMs);
  const delay = config.readDelayMinMs + Math.random() * span;
  setTimeout(() => {
    markRead(sock, keys).catch(() => {});
  }, delay);
}

/** Global cost guard: photos across ALL contacts per day. */
function takePhotoBudget() {
  const st = loadState();
  const today = new Date().toISOString().slice(0, 10);
  if (st.photoDay !== today) {
    st.photoDay = today;
    st.photoCount = 0;
  }
  if ((st.photoCount || 0) >= config.photoGlobalDailyMax) return false;
  st.photoCount = (st.photoCount || 0) + 1;
  saveState(st);
  return true;
}

async function respond(sock, jid, p) {
  const incomingText = p.parts.filter(Boolean).join("\n").trim();

  // ── crisis first: it overrides sleep, sulking and everything else ──
  const crisisHit = detectCrisis(incomingText);

  // ── sleep: it is the middle of her night ──
  let sleepy = false;
  if (isSleeping()) {
    const worriedNow = HEALTH_CUE.test(incomingText) || Boolean(crisisHit);
    if (shouldIgnore(incomingText, { worried: worriedNow })) {
      const asleep = loadChat(jid);
      asleep.history.push({ role: "user", content: incomingText, ts: Date.now() });
      asleep.stats.inbound = (asleep.stats.inbound || 0) + 1;
      asleep.lastAsleepAt = Date.now();
      saveChat(asleep);
      log(`asleep (${Math.round(sleepiness() * 100)}% deep) — saw it, did not answer → ${jid}`);
      return;
    }
    sleepy = true;
    log(`woken up (${Math.round(sleepiness() * 100)}% deep) → ${jid}`);
  }

  // ── switched off (out of town, on a trip…): read it, answer nothing ──
  if (isPaused()) {
    const paused = loadChat(jid);
    paused.history.push({ role: "user", content: incomingText, ts: Date.now() });
    paused.stats.inbound = (paused.stats.inbound || 0) + 1;
    paused.lastInteraction = Date.now();
    saveChat(paused);
    log(`paused (${pausedFor()} min left) — read, no reply → ${jid}`);
    return;
  }

  const incoming = incomingText;
  if (!incoming) return;

  const chat = loadChat(jid);
  chat.lastIncoming = incoming.slice(0, 400);

  if (crisisHit) {
    recordEvent({ kind: "health_scare", what: "someone i talk to wrote something that scared me", source: jid });
    alertOwner({ who: chat.profile?.name || chat.profile?.number || jid, text: incoming, hit: crisisHit });
    chat.crisisAt = Date.now();
  }
  // a crisis keeps her present for half an hour, whatever her mood was doing
  const crisisActive = Boolean(chat.crisisAt && Date.now() - chat.crisisAt < 30 * 60000);

  // ── today's mood for no particular reason (once per day, per person) ──
  dailyVariance(chat);

  // ── her routine says she is busy right now ──
  // She does NOT send a line about it. A canned "nggak bisa sekarang" is a system message wearing her
  // voice, and nobody announces that they are busy — they just do not answer. Anything that must be
  // answered (a question, anything about health, a crisis) still gets through.
  if (!crisisActive) {
    const busy = busyNow(chat);
    // Being busy must not mean being gone for three hours. She goes quiet once, and after that
    // window she answers even mid-shift — a person at work still replies to a friend eventually.
    const sinceLastSkip = Date.now() - Number(chat.stats.lastBusySkipAt || 0);
    const mayGoQuiet = sinceLastSkip > Number(config.busyMaxMin || 40) * 60000;
    if (busy && mayGoQuiet && !mustAnswerSomething(incoming)) {
      chat.busyUntil = Date.now() + Math.min(busy.minutesLeft, Number(config.busyMaxMin || 40)) * 60000;
      chat.stats.lastBusySkipAt = Date.now();
      chat.stats.skips = (chat.stats.skips || 0) + 1;
      chat.lastSkipAt = Date.now();
      saveChat(chat);
      log(`left on read (busy — ${busy.what}; quiet at most ${config.busyMaxMin}m) — ${String(incoming).slice(0, 40)}`);
      return;
    }
  }


  // ── a new day: yesterday's mood does not vanish overnight ──
  {
    const today = new Date().toDateString();
    if (chat.lastMoodDay !== today) {
      chat.lastMoodDay = today;
      if (config.moodResidue && chat.mood && chat.stats?.inbound > 3) {
        const anchor = baselineFor(chat);
        const before = { ...chat.mood };
        const strong =
          Math.abs(before.valence - anchor.valence) > 0.25 || Math.abs(before.patience - anchor.patience) > 0.25;
        if (strong) {
          for (const k of MOOD_KEYS) chat.mood = applyDeltas(chat.mood, { [k]: (anchor[k] - before[k]) * 0.5 });
          log(
            `carrying yesterday into today: valence ${before.valence.toFixed(2)} → ${chat.mood.valence.toFixed(2)}, patience ${before.patience.toFixed(2)} → ${chat.mood.patience.toFixed(2)}`,
          );
        }
      }
    }
  }

  // keep the per-contact profile current (never shared between contacts)
  const rawUser = phoneFromJid(jid);
  const number = config.lidMap[rawUser] || rawUser;
  if (!chat.profile.number || config.lidMap[chat.profile.number]) chat.profile.number = number;
  const push = (p.pushName || "").trim();
  if (!chat.profile.name && push) chat.profile.name = push;
  // trust: only numbers listed in TRUSTED get the full character. Never
  // downgrade someone who already earned it (the dashboard can revoke).
  if (!chat.trusted && config.trusted.length) {
    const bare = number.replace(/^\+/, "");
    if (config.trusted.includes("*") || config.trusted.includes(number) || config.trusted.includes(bare)) {
      chat.trusted = true;
      log(`trusted → ${number}`);
    }
  }
  const trusted = chat.trusted === true;
  // the pet name is only for people she actually knows
  if (!chat.profile.nick && config.defaultNick && trusted) chat.profile.nick = config.defaultNick;

  const persona = loadPersona(chat.persona || undefined);

  // ── strangers: warn first, block only if it keeps going ──────────────────
  const strangerVerdict = decide(chat, incoming);
  if (strangerVerdict.action === "blocked") {
    log(`ignored message from blocked contact ${chat.jid}`);
    saveChat(chat);
    return;
  }
  if (strangerVerdict.action === "block") {
    const line = WARN_LINES.length ? pick(WARN_LINES) : "";
    if (line) {
      try {
        await sendText(sock, chat.jid, line);
        chat.history.push({ role: "assistant", content: line, ts: Date.now() });
        chat.stats.outbound = (chat.stats.outbound || 0) + 1;
      } catch (err) {
        log(`warn send failed: ${err.message}`);
      }
    }
    await blockNumber(sock, chat, strangerVerdict.reasons.join(", "));
    lifeEvent("blocked", `someone weird messaged me (${strangerVerdict.reasons.slice(0, 2).join(", ")}) and i blocked them`, chat.jid);
    saveChat(chat);
    return;
  }
  if (strangerVerdict.action === "warn" && !chat.stranger?.warnedAt) {
    lifeEvent("spam", "a stranger sent me something that looked like spam", chat.jid);
    const line = pick(WARN_LINES);
    chat.stranger.warnedAt = Date.now();
    try {
      await sendText(sock, chat.jid, line);
      chat.history.push({ role: "assistant", content: line, ts: Date.now() });
      chat.stats.outbound = (chat.stats.outbound || 0) + 1;
    } catch (err) {
      log(`warn send failed: ${err.message}`);
    }
    saveChat(chat);
    return;
  }

  // ── cross-chat: someone mentioned another contact, or answered about one ──
  if (config.crossChat) try {
    await resolveNotes(chat, incoming);
    const mention = detectMention(chat, incoming);
    if (mention) {
      const who = chat.profile?.name || chat.profile?.number || "someone";
      const target = loadChat(mention.target.jid);
      if (mention.isReferral) {
        const note = addCrossNote(target, {
          fromJid: chat.jid,
          fromName: who,
          kind: "referral",
          what: `${who} (not a contact yet) says they got my number from you: "${String(incoming).slice(0, 120)}"`,
          ref: { strangerJid: chat.jid, strangerName: who },
        });
        if (note) {
          addVouch(chat, mention.target, String(incoming).slice(0, 160));
          saveChat(target);
          log(`referral: ${who} → ${mention.target.name || mention.target.jid}`);
        }
      } else {
        if (addCrossNote(target, { fromJid: chat.jid, fromName: who, kind: "mention", what: `${who} mentioned you: "${String(incoming).slice(0, 120)}"` })) {
          saveChat(target);
        }
      }
    }
  } catch (err) {
    log(`cross-chat failed: ${err.message}`);
  }

  // her own day (global, shared by everyone she talks to): make sure today
  // exists, then let the moments that came due move THIS chat's mood
  if (chat.trusted === true && config.routine) {
    try {
      const routine = await ensureToday(persona, { mood: chat.mood });
      const fired = tickMoments(routine);
      if (fired.length && !isMoodLocked(chat)) {
        for (const m of fired) chat.mood = applyDeltas(normalize(chat.mood), momentDeltas(m));
      }
      if (fired.length) saveRoutine(routine.slug, routine);
    } catch (err) {
      log(`routine failed: ${err.message}`);
    }
  }

  const isMedia = incoming.startsWith("[");
  const bare = isMedia ? "" : incoming.replace(/\s/g, "");
  const mm = moodMultipliers(chat.mood);
  if (config.milestones) detectMilestones(chat, incoming);
  if (/\b(ai|bot|robot|chatbot|gpt|mesin)\b/i.test(incoming) && /\b(kamu|you|u|lu|kamu ini|are you)\b/i.test(incoming) && /(\?|ya\b|kan\b|bukan|really|serius)/i.test(incoming)) {
    lifeEvent("ai_accused", "someone asked me straight out if i'm an ai. annoying.", chat.jid);
  }
  if (HEALTH_CUE.test(incoming)) {
    lifeEvent("health_scare", "he told me he's not okay and i can't do anything about it from here", chat.jid);
  }
  const injection = config.injectionGuard && detectInjection(incoming);
  if (injection) log(`possible prompt-injection from ${jid}`);

  // sulking chain: dry (contextual short replies) -> silent (no reply at all)
  const pstate = (chat.proactive ||= { state: "idle", sentAt: 0, nudgedAt: 0, drySince: 0, dryCount: 0, lastDry: "", lastSlot: "" });
  // SULKING=0: she never goes cold or silent, she just answers
  if (!config.sulking && pstate.state !== "idle") {
    pstate.state = "idle";
    pstate.dryCount = 0;
    chat.coldUntil = 0;
  }
  let thawed = false;
  const worried = HEALTH_CUE.test(incoming) || crisisActive;
  if (pstate.state === "dry" || pstate.state === "silent") {
    const apology = isGenuineApology(incoming);
    const soft = SOFTEN.test(incoming);
    // health issues break through pride: she stays cold-ish but clearly cares
    const thawOk = pstate.state === "silent" ? apology || worried : apology || soft || worried;

    if (!thawOk) {
      if (pstate.state === "silent") {
        // she is done talking. Read it, do not answer, until a real apology.
        if (config.markRead && p.keys.length) await markRead(sock, p.keys);
        chat.lastInteraction = Date.now();
        saveChat(chat);
        log(`silent: read, no reply → ${jid}`);
        return;
      }
      // dry tier: short, but still answers what they actually said
      const line =
        (await generateDryReply(chat, incoming, persona, { displayName: p.pushName })) || pickDryLine(pstate);
      await presence(sock, jid, "composing");
      await sleep(typingDelayFor(line));
      try {
        await sendText(sock, jid, line);
        chat.stats.outbound = (chat.stats.outbound || 0) + 1;
        chat.lastInteraction = Date.now();
        // she sent it, so she has to remember sending it
        chat.history.push({ role: "assistant", content: stripAudioTags(line), ts: Date.now() });
        pstate.dryCount = (pstate.dryCount || 0) + 1;
        if (pstate.dryCount >= config.drySilentAfter) {
          pstate.state = "silent";
          log(`dry → silent after ${pstate.dryCount} replies → ${jid}`);
        }
        saveChat(chat);
        log(`dry reply → ${jid}: ${line}`);
      } catch (err) {
        log(`dry send failed: ${err.message}`);
      }
      return;
    }

    // she is being softened
    pstate.state = "idle";
    pstate.drySince = 0;
    pstate.dryCount = 0;
    chat.coldUntil = 0;
    if (!isMoodLocked(chat)) chat.mood = applyDeltas(normalize(chat.mood), {
      valence: worried ? 0.02 : 0.12,
      patience: worried ? 0.05 : 0.12,
      affection: 0.05,
      arousal: worried ? 0.12 : -0.05,
    });
    thawed = true;
    log(worried ? `thawing (health scare) → ${jid}` : `thawing after apology → ${jid}`);
  }

  // a stranger who behaves and introduces themselves becomes an acquaintance
  promoteIfReady(chat);

  // the third party replied to an errand she ran — tell the owner right away
  try {
    notifyTaskReply(chat, incoming);
  } catch (err) {
    log(`task reply notify failed: ${err.message}`);
  }

  // read receipts are not instant
  scheduleRead(sock, p.keys);
  await subscribePresence(sock, jid);
  // sometimes she just reads it and doesn't reply
  // never leave a health message on read
  // A photo request is worked out here, before anything decides to stay quiet: it used to be computed
  // further down, so the skip rules (short ping, short fuse, busy) could throw the message away and the
  // photo path never ran — which reads as her refusing.
  const wantsPhoto = /\b(foto|photo|photograph|pic|pics|picture|selfie|potret|pap|gambar|muka|wajah)\b/i.test(
    String(incoming || ""),
  );

  const worth = worthReplying(chat, incoming, {
    mood: chat.mood,
    worried,
    crisis: crisisActive,
    cameBack: pstate.state === "awaiting" || pstate.state === "nudged",
  });
  if (!worried && worth.skip && !wantsPhoto) {
    chat.stats.skips = (chat.stats.skips || 0) + 1;
    chat.lastSkipAt = Date.now();
    saveChat(chat);
    log(`left on read (${worth.chance * 100}%): ${worth.reason} — ${String(incoming).slice(0, 40)}`);
    return;
  }

  // sometimes a reaction is the whole reply
  if (
    config.reactionChance > 0 &&
    p.keys.length &&
    bare.length <= 14 &&
    Math.random() < Math.min(0.9, config.reactionChance * mm.reaction)
  ) {
    try {
      await sendReaction(sock, jid, p.keys[p.keys.length - 1], pickReaction());
      chat.lastInteraction = Date.now();
      saveChat(chat);
      log(`reacted to ${jid}`);
      return;
    } catch (err) {
      log(`reaction failed: ${err.message}`);
    }
  }

  // she has opened the chat now, so the ticks go blue before she types
  if (config.markRead && p.keys.length) await markRead(sock, p.keys);
  // …she reads it first…
  await sleep(readingDelayFor(incoming));
  if (config.replyDelayMs) await sleep(config.replyDelayMs);
  // …then a pause before she actually starts typing (the indicator appears late)
  await sleep(pretypeDelayFor());
  await presence(sock, jid, "composing");


  // decide the reply format up front, so a voice note can be written for speech.
  // An explicit request overrides the dice: "kirim vn dong" -> voice, "text aja" -> text.
  const asksVoice =
    /(\bvoice\b|\bvn\b|voice ?note|voice ?message|kirim suara|pake suara|pakai suara|rekam suara|dengerin suara|bicara dong|ngomong dong|ngomongin dong|don'?t text|jangan text|jangan ngetik|stop texting|\baudio\b)/i.test(
      incoming,
    );
  const asksText = /(text aja|chat aja|ketik aja|jangan voice|no voice|ga usah voice|gausah voice|males dengerin)/i.test(incoming);
  // if they sent a voice note, she usually answers with one too
  const incomingVoice = /^\[voice note/i.test(incoming);
  const mirrorVoice = incomingVoice && Math.random() < config.voiceMirrorChance;
  const wantVoice =
    !sleepy &&
    trusted &&
    !asksText &&
    (asksVoice ||
      mirrorVoice ||
      (config.voiceChance > 0 && Math.random() < Math.min(0.95, config.voiceChance * mm.voice)));

  // she texted first and they finally replied: react to that
  const startedIt = pstate.state === "awaiting" || pstate.state === "nudged";
  if (startedIt) {
    pstate.state = "idle";
    pstate.nudgedAt = 0;
  }

  let replyText;
  const reaction = topicReaction(traitsForChat(chat), incoming);
  if (reaction.hot.length) log(`hot topic (${reaction.hot.join(", ")}) → she will be livelier`);
  try {
    replyText = await generateReply(chat, incoming, persona, {
      displayName: p.pushName,
      sleepy: crisisActive ? false : sleepy,
      crisis: crisisActive,
      hotTopic: reaction.hot,
      boredTopic: reaction.bored,
      voice: wantVoice,
      startedIt,
      thawed,
      injection,
      worried,
    });
  } catch (err) {
    log(`generate failed: ${err.stack || err.message}`);
    await presence(sock, jid, "paused");
    return;
  }

  // what the user would actually read (audio tags removed)
  let chatText = stripAudioTags(replyText);

  // a very human typo, sometimes corrected on the next line
  let correction = null;
  if (Math.random() < Math.min(0.6, config.typoChance * mm.typo)) {
    const { text, original, typo, severity } = makeTypo(chatText);
    if (typo) {
      chatText = text;
      // only correct typos that actually change the meaning (wrong word) —
      // a letter slip is still readable, people don't bother correcting those
      if (severity === "heavy" && Math.random() < config.correctionChance) {
        correction = correctionFor(original);
      }
    }
  }

  // photo: when she's asked, or rarely on her own (daily cap per contact)
  const today = new Date().toISOString().slice(0, 10);
  if (chat.stats.photoDay !== today) {
    chat.stats.photoDay = today;
    chat.stats.photoCount = 0;
  }
  let sentMedia = false;
  const textKeys = [];
  // no daily cap and no minimum gap any more: she sends because something fits, or because he asked
  if (!sleepy && (wantsPhoto || config.photoSend)) {
    // From the library, matched to what she is doing right now — not generated on the spot.
    // Generation is off by default: it costs money every time and the face does not hold.
    const moment = (() => {
      try {
        const r = loadRoutine(persona.slug || config.persona);
        return (r.moments || [])[(r.moments || []).length - 1] || null;
      } catch {
        return null;
      }
    })();
    const decision = shouldSendPhoto({ chat, moment, sleepy, force: wantsPhoto });
    // When he asks, sometimes she takes a NEW one at the mirror instead of picking an old photo out of the
    // library — a person asked for a photo does not scroll through their camera roll.
    let freshSelfie = null;
    if (wantsPhoto && config.selfieEnabled && Math.random() < 0.5) {
      try {
        const made = await makeSelfie(persona, { slug: persona.slug || config.persona, style: "casual", why: "she just took it, for him" });
        if (made.ok) freshSelfie = made;
        else log(`fresh selfie failed: ${made.error}`);
      } catch (err) {
        log(`fresh selfie failed: ${err.message}`);
      }
    }
    if (freshSelfie || decision.ok) {
      const photo = freshSelfie ? freshSelfie.photo : decision.photo;
      try {
        const file = path.join(DATA_DIR, "photos", "library", String(persona.slug || config.persona), photo.file);
        if (fs.existsSync(file)) {
          await presence(sock, jid, "composing");
          await sleep(1200 + Math.random() * 1800);
          // a photo goes first, and the line that follows never describes the picture
          let caption = chatText.length <= 160 ? chatText : undefined;
          if (freshSelfie && Math.random() < 0.4) {
            try {
              const recent = chat.history.slice(-4).map((m) => `${m.role === "assistant" ? "her" : "him"}: ${String(m.content || "").slice(0, 90)}`).join("\n");
              const line = await llmChat(
                [
                  {
                    role: "system",
                    content: `You just took a mirror selfie and are sending it. Add ONE very short line, in the language you two are using, max 6 words — dry, low effort, like "outfit check." or "this one ok?" or "capek.". No emoji. No money. If nothing fits, answer NONE.`,
                  },
                  { role: "user", content: recent },
                ],
                { temperature: 1.0, maxTokens: 20 },
              );
              const cl = String(line || "").trim().split("\n")[0].slice(0, 40);
              if (cl && !/^none$/i.test(cl)) caption = cl;
            } catch {
              /* a caption is optional */
            }
          }
          await sendImage(sock, jid, fs.readFileSync(file), "image/jpeg", caption);
          chat.stats.outbound = (chat.stats.outbound || 0) + 1;
          chat.stats.photoCount = (chat.stats.photoCount || 0) + 1;
          chat.stats.photoDay = today;
          chat.stats.lastPhotoAt = Date.now();
          sentMedia = true;
          markSent(persona.slug || config.persona, photo.id, jid);
          log(`photo → ${jid} "${photo.scene}" (${chat.stats.photoCount} today) · ${photo.why}`);
        }
      } catch (err) {
        log(`photo send failed: ${err.message}`);
      }
    } else if (wantsPhoto && decision.reason !== "chance (5%)") {
      log(`photo not sent (${decision.reason})`);
    }
  }

  if (wantsPhoto && config.photoGenerateOnDemand && !sentMedia) {
    const look = persona.appearance || "cewek Indonesia umur 20-an, gaya casual";
    const prompt =
      `Foto HP candid ${persona.name}, ${look}. ` +
      `Suasana: ${toSpeakable(chatText).slice(0, 120)}. ` +
      `Natural, tidak berpose, pencahayaan alami, sedikit blur, seperti foto yang dikirim lewat WhatsApp.`;
    const img = await generateImage(prompt);
    if (img) {
      try {
        await sendImage(sock, jid, img.buffer, img.mimetype, chatText.length <= 180 ? chatText : undefined);
        chat.stats.photoCount = (chat.stats.photoCount || 0) + 1;
        chat.stats.photoDay = today;
        chat.stats.lastPhotoAt = Date.now();
        sentMedia = true;
        log(`photo generated on demand → ${jid}`);
      } catch (err) {
        log(`photo send failed: ${err.message}`);
      }
    }
  }

  // ── sticker: can be the whole reply, or an addition to text/voice ──
  const stickerRoll =
    !sleepy &&
    trusted && config.stickerChance > 0 && Math.random() < Math.min(0.95, config.stickerChance * mm.sticker);
  const stickerAlone = stickerRoll && !sentMedia && Math.random() < config.stickerOnlyChance;
  const stickerPick = stickerRoll
    ? randomSticker({
        want: stickerVibe(chatText, chat.mood),
        avoid: chat.lastSticker ? [chat.lastSticker] : [],
      })
    : null;

  if (stickerAlone && stickerPick) {
    await presence(sock, jid, "composing");
    await sleep(600 + Math.random() * 1500);
    try {
      await sendSticker(sock, jid, stickerPick.buffer);
      chat.stats.outbound = (chat.stats.outbound || 0) + 1;
      chat.lastReplyAt = Date.now();
      chat.lastSticker = stickerPick.name;
      sentMedia = true;
      log(`sticker (sendiri) → ${jid}: ${stickerPick.name} [${stickerPick.tags.join(",")}]`);
    } catch (err) {
      log(`sticker send failed: ${err.message}`);
    }
  }

  // ── voice note(s): the whole reply, split in two, or text-then-voice ──
  if (!sentMedia && wantVoice) {
    const speakable = toSpeakable(replyText);
    if (speakable.length >= 12 && voiceLongEnough(speakable)) {
      const sentences = speakable.split(/(?<=[.!?…])\s+/).filter(Boolean);
      let opening = null;
      let chunks = [speakable];

      if (sentences.length >= 2 && Math.random() < config.textThenVoiceChance) {
        opening = sentences[0];
        chunks = [sentences.slice(1).join(" ")];
      } else if (sentences.length >= 2 && Math.random() < config.voiceSplitChance) {
        const mid = Math.ceil(sentences.length / 2);
        const a = sentences.slice(0, mid).join(" ");
        const b = sentences.slice(mid).join(" ");
        if (a.length >= 8 && b.length >= 8) chunks = [a, b];
      }

      // short text first ("iya aku juga" …) then the voice note
      if (opening && opening.length <= 120) {
        await presence(sock, jid, "composing");
        await sleep(typingDelayFor(opening));
        try {
          await sendText(sock, jid, opening);
          chat.stats.outbound = (chat.stats.outbound || 0) + 1;
          if (config.debug) log(`→ ${jid} (text before the voice note): ${opening}`);
        } catch (err) {
          log(`send failed: ${err.message}`);
        }
      }

      let sentAnyVoice = false;
      for (let vi = 0; vi < chunks.length; vi++) {
        const chunk = chunks[vi];
        if (chunk.length < 8) continue;
        const ogg = await synthesize(chunk, persona, { ignoreBudget: asksVoice });
        if (!ogg) continue;
        await presence(sock, jid, "recording");
        await sleep(Math.min(12000, 1200 + chunk.length * 55));
        try {
          await sendVoice(sock, jid, ogg);
          chat.stats.outbound = (chat.stats.outbound || 0) + 1;
          chat.stats.voice = (chat.stats.voice || 0) + 1;
          chat.lastReplyAt = Date.now();
          sentAnyVoice = true;
          log(
            `voice note ${(ogg.length / 1024).toFixed(0)}kb → ${jid}` +
              (chunks.length > 1 ? ` (${vi + 1}/${chunks.length})` : ""),
          );
        } catch (err) {
          log(`voice send failed: ${err.message}`);
        }
        if (vi < chunks.length - 1) await sleep(400 + Math.random() * 900);
      }
      if (opening || sentAnyVoice) sentMedia = true;
    }
  }

  // is a plain text reply still going out? (one garnish per reply: never
  // photo + sticker + voice note stacked on top of each other)
  const willSendText = !sentMedia;
  if (willSendText) {
    const bubbles = maybeBurst(splitBubbles(chatText), config.burstChance);
    const quoted =
      config.quoteChance > 0 && p.msg && Math.random() < config.quoteChance ? p.msg : undefined;
    for (let i = 0; i < bubbles.length; i++) {
      await presence(sock, jid, "composing");
      const plan = typingPlan(bubbles[i]);
      await sleep(plan.first);
      if (plan.gap) {
        await presence(sock, jid, "paused");
        await sleep(plan.gap);
        await presence(sock, jid, "composing");
        await sleep(plan.rest);
      }
      try {
        const sent = await sendText(sock, jid, bubbles[i], i === 0 ? quoted : undefined);
        if (sent?.key) textKeys.push({ key: sent.key, text: bubbles[i] });
        chat.stats.outbound = (chat.stats.outbound || 0) + 1;
        chat.lastReplyAt = Date.now();
        if (config.debug) log(`→ ${jid}${i === 0 && quoted ? " (quote)" : ""}: ${bubbles[i]}`);

        // "almost said something honest, then deleted it"
        if (
          i === 0 &&
          bubbles.length <= 2 &&
          sent?.key &&
          config.deleteChance > 0 &&
          Math.random() < config.deleteChance
        ) {
          const delay = config.deleteMinMs + Math.random() * (config.deleteMaxMs - config.deleteMinMs);
          const original = bubbles[i];
          setTimeout(async () => {
            try {
              await sock.sendMessage(jid, { delete: sent.key });
              const c = loadChat(jid);
              // rewrite the entry: the message is gone, they never read it
              for (let i = c.history.length - 1; i >= 0; i--) {
                const h = c.history[i];
                if (h.role === "assistant" && typeof h.content === "string" && h.content.includes(original)) {
                  h.content = `[pesan ini kamu hapus sebelum dia baca] "${original}"`;
                  h.deleted = true;
                  break;
                }
              }
              saveChat(c);
              log(`deleted own message → ${jid}`);
              if (Math.random() < config.deleteCoverChance) {
                const cover = DELETE_COVERS[Math.floor(Math.random() * DELETE_COVERS.length)];
                await presence(sock, jid, "composing");
                await sleep(700 + Math.random() * 1800);
                await sendText(sock, jid, cover);
                log(`deleted-message cover-up → ${jid}: ${cover}`);
              }
            } catch (err) {
              log(`delete failed: ${err.message}`);
            }
          }, delay);
        }
      } catch (err) {
        log(`send failed: ${err.message}`);
        break;
      }
      if (i < bubbles.length - 1) await sleep(250 + Math.random() * 800);
    }

    if (correction) {
      await presence(sock, jid, "composing");
      await sleep(typingDelayFor(correction));
      try {
        await sendText(sock, jid, correction);
        chat.stats.outbound = (chat.stats.outbound || 0) + 1;
        if (config.debug) log(`→ ${jid}: ${correction}  (koreksi)`);
      } catch (err) {
        log(`correction send failed: ${err.message}`);
      }
    }
  }

  // ── errands the owner asked for: send them now, and write them down ──
  if ((chat.pendingTasks || []).length) {
    for (const task of chat.pendingTasks) {
      const r = await runTask(sock, chat, task);
      if (!r.ok) log(`task not sent: ${r.reason}`);
      else if (config.debug) log(`task ok → ${task.to}`);
    }
    chat.pendingTasks = [];
    saveChat(chat);
  }

  // ── an afterthought: she edits the message she just sent ──
  if (textKeys.length && config.editChance > 0 && Math.random() < config.editChance) {
    try {
      const lastOne = textKeys[textKeys.length - 1];
      // she writes it herself, in the language of the conversation
      const recent = chat.history
        .slice(-6)
        .map((m) => `${m.role === "assistant" ? "her" : "him"}: ${String(m.content || "").slice(0, 120)}`)
        .join("\n");
      let extra = "";
      try {
        const out = await llmChat(
          [
            { role: "system", content: EDIT_AFTERMATH_PROMPT },
            { role: "user", content: `${recent}\n\nHer last message was: ${String(lastOne.text).slice(0, 200)}` },
          ],
          { temperature: 0.9, maxTokens: 30 },
        );
        extra = String(out || "").trim().split("\n")[0].slice(0, 60);
      } catch (err) {
        log(`afterthought skipped: ${err.message}`);
      }
      if (!extra || /^none$/i.test(extra) || extra.length < 3) {
        log("afterthought: nothing worth adding");
        return;
      }
      const edited = `${lastOne.text.replace(/\s+$/, "")}\n${extra}`;
      await sleep(1500 + Math.random() * 4000);
      await sock.sendMessage(jid, { text: edited, edit: lastOne.key });
      chat.history.push({ role: "assistant", content: edited, ts: Date.now(), edited: true });
      saveChat(chat);
      log(`edited her own message: +${extra}`);
    } catch (err) {
      log(`edit failed (older client?): ${err.message}`);
    }
  }

  // ── sticker as an addition (only on top of a text reply) ──
  if (stickerPick && !stickerAlone && willSendText) {
    await presence(sock, jid, "composing");
    await sleep(500 + Math.random() * 1200);
    try {
      await sendSticker(sock, jid, stickerPick.buffer);
      chat.stats.outbound = (chat.stats.outbound || 0) + 1;
      chat.lastReplyAt = Date.now();
      chat.lastSticker = stickerPick.name;
      log(`sticker (+pesan) → ${jid}: ${stickerPick.name} [${stickerPick.tags.join(",")}]`);
    } catch (err) {
      log(`sticker send failed: ${err.message}`);
    }
  }

  await presence(sock, jid, "paused");
  saveChat(chat);
}

/* ------------------------------ entrypoint ----------------------------- */

export async function onMessage(sock, msg) {
  const jid = msg.key?.remoteJid;
  if (!jid) return;
  if (msg.key.fromMe) return;
  if (jid === "status@broadcast") return;
  if (jid.endsWith("@broadcast") || jid.endsWith("@newsletter")) return;

  const senderJid = msg.key.participant || jid;
  const senderPhone = phoneFromJid(senderJid);
  if (config.debug) log(`inbound key: ${JSON.stringify(msg.key)}`);
  // Baileys 7 tells us the phone number behind a LID — keep it, it is what
  // WhatsApp needs to block someone who only arrives as an anonymous id
  const senderPn = msg.key?.senderPn || msg.key?.participantPn || msg.senderPn;
  if (senderPn && String(senderPn).endsWith("@s.whatsapp.net")) {
    const c = loadChat(jid);
    if (c.pn !== senderPn) {
      c.pn = senderPn;
      saveChat(c);
      log(`learned phone number for ${jid}: ${senderPn}`);
    }
  }
  if (!allowed(jid, senderPhone)) {
    log(`ignored message from ${senderPhone} (not allowed) jid=${jid}`);
    return;
  }

  const text = await toText(sock, msg);
  if (!text) return;

  if (config.debug) log(`← ${senderPhone}: ${text}`);
  schedule(sock, jid, { text, key: msg.key, pushName: msg.pushName || "", msg });
}
