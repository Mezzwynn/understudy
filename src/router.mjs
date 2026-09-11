import { config, log } from "./config.mjs";
import { loadChat, saveChat, loadState, saveState } from "./store.mjs";
import { generateReply, generateDryReply } from "./engine.mjs";
import { loadPersona } from "./prompt.mjs";
import { splitBubbles, typingDelayFor, typingPlan, readingDelayFor, pretypeDelayFor, sleep, makeTypo, correctionFor, pickReaction, maybeBurst, maybeLongDelay } from "./texting.mjs";
import { describeImage, transcribeAudio } from "./vision.mjs";
import { synthesize, toSpeakable } from "./voice.mjs";
import { stripAudioTags, detectInjection } from "./guard.mjs";
import { applyDeltas, normalize } from "./mood.mjs";
import { generateImage, randomSticker, saveUserSticker } from "./image.mjs";
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
  const incoming = p.parts.join("\n").trim();
  if (!incoming) return;

  const chat = loadChat(jid);

  // keep the per-contact profile current (never shared between contacts)
  const rawUser = phoneFromJid(jid);
  const number = config.lidMap[rawUser] || rawUser;
  if (!chat.profile.number || config.lidMap[chat.profile.number]) chat.profile.number = number;
  const push = (p.pushName || "").trim();
  if (!chat.profile.name && push) chat.profile.name = push;
  if (!chat.profile.nick && config.defaultNick) chat.profile.nick = config.defaultNick;

  const persona = loadPersona(chat.persona || undefined);
  const isMedia = incoming.startsWith("[");
  const bare = isMedia ? "" : incoming.replace(/\s/g, "");
  const mm = moodMultipliers(chat.mood);
  detectMilestones(chat, incoming);
  const injection = config.injectionGuard && detectInjection(incoming);
  if (injection) log(`possible prompt-injection from ${jid}`);

  // sulking chain: dry (contextual short replies) -> silent (no reply at all)
  const pstate = (chat.proactive ||= { state: "idle", sentAt: 0, nudgedAt: 0, drySince: 0, dryCount: 0, lastDry: "", lastSlot: "" });
  let thawed = false;
  const worried = HEALTH_CUE.test(incoming);
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
    chat.mood = applyDeltas(normalize(chat.mood), {
      valence: worried ? 0.02 : 0.2,
      patience: worried ? 0.05 : 0.18,
      affection: 0.06,
      arousal: worried ? 0.12 : -0.05,
    });
    thawed = true;
    log(worried ? `thawing (health scare) → ${jid}` : `thawing after apology → ${jid}`);
  }

  // read receipts are not instant
  scheduleRead(sock, p.keys);
  await subscribePresence(sock, jid);
  // sometimes she just reads it and doesn't reply
  // never leave a health message on read
  if (!worried && shouldSkip(chat, incoming)) {
    chat.stats.skips = (chat.stats.skips || 0) + 1;
    chat.lastSkipAt = Date.now();
    saveChat(chat);
    log(`left on read: ${incoming}`);
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

  // sometimes she gets distracted for a while before answering
  const distracted = maybeLongDelay();
  if (distracted) {
    await presence(sock, jid, "paused");
    log(`distracted for ${Math.round(distracted / 1000)}s`);
    await sleep(distracted);
    await presence(sock, jid, "composing");
  }

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
  try {
    replyText = await generateReply(chat, incoming, persona, {
      displayName: p.pushName,
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
  const wantsPhoto = /(foto|selfie|potret|pap|gambar).{0,24}(kamu|kmu|dirimu|dong|sini)|kirim foto|foto dong|selfie dong|liat foto|lihat foto/i.test(
    incoming,
  );
  const today = new Date().toISOString().slice(0, 10);
  if (chat.stats.photoDay !== today) {
    chat.stats.photoDay = today;
    chat.stats.photoCount = 0;
  }
  let sentMedia = false;
  if (
    (wantsPhoto || Math.random() < config.photoChance) &&
    (chat.stats.photoCount || 0) < config.photoDailyMax &&
    takePhotoBudget()
  ) {
    const look = persona.appearance || "cewek Indonesia umur 20-an, gaya casual";
    const prompt =
      `Foto HP candid ${persona.name}, ${look}. ` +
      `Suasana: ${toSpeakable(chatText).slice(0, 120)}. ` +
      `Natural, tidak berpose, pencahayaan alami, sedikit blur, seperti foto yang dikirim lewat WhatsApp.`;
    const img = await generateImage(prompt);
    if (img) {
      await presence(sock, jid, "composing");
      await sleep(1500 + Math.random() * 2000);
      try {
        const caption = chatText.length <= 180 ? chatText : undefined;
        await sendImage(sock, jid, img.buffer, img.mimetype, caption);
        chat.stats.outbound = (chat.stats.outbound || 0) + 1;
        chat.stats.photoCount = (chat.stats.photoCount || 0) + 1;
        sentMedia = true;
        log(`photo → ${jid} (${chat.stats.photoCount}/${config.photoDailyMax} today)`);
      } catch (err) {
        log(`photo send failed: ${err.message}`);
      }
    }
  }

  // ── sticker: can be the whole reply, or an addition to text/voice ──
  const stickerRoll =
    config.stickerChance > 0 && Math.random() < Math.min(0.95, config.stickerChance * mm.sticker);
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
    if (speakable.length >= 12) {
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
          if (config.debug) log(`→ ${jid} (teks sebelum VN): ${opening}`);
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

  if (!sentMedia) {
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

  // ── sticker as an addition (text/voice already sent) ──
  if (stickerPick && !stickerAlone) {
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
  if (!allowed(jid, senderPhone)) {
    log(`ignored message from ${senderPhone} (not allowed) jid=${jid}`);
    return;
  }

  const text = await toText(sock, msg);
  if (!text) return;

  if (config.debug) log(`← ${senderPhone}: ${text}`);
  schedule(sock, jid, { text, key: msg.key, pushName: msg.pushName || "", msg });
}
