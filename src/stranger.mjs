/**
 * stranger.mjs — how she treats people she does not know yet.
 *
 * Three tiers:
 *   stranger      brand new: cold, guarded, asks who they are. No pet names,
 *                 no media, no messages first, no promises.
 *   acquaintance  they introduced themselves and the chat stayed normal, so she
 *                 talks to them like a person she just met. Still no pet names,
 *                 no flirting, no media, no messages first.
 *   trusted       the full character (TRUSTED= in .env, or the dashboard).
 *
 * Spam and weird chats get a WARNING first; if it continues, the number is
 * blocked (never a trusted contact, and never without a warning).
 */
import { log } from "./config.mjs";
import { config } from "./config.mjs";

/* ------------------------------ signals ------------------------------- */

const LINK_RE = /(https?:\/\/|www\.|t\.me\/|wa\.me\/|bit\.ly\/|tinyurl)/i;
const SCAM_RE =
  /\b(investasi|invest|profit|cuan|untung besar|pinjol|pinjaman online|judi|slot|gacor|bandar|togel|kasino|casino|betting|taruhan|giveaway|hadiah|pemenang|klaim|promo|diskon besar|open jasa|jasa joki|murah banget|dp dulu|transfer dulu|top ?up murah|saldo|dana cepat|kerja dari rumah|part.?time|admin akan|cek bio|cek link|klik link)\b/i;
const CODE_RE = /\b(otp|kode verifikasi|verification code|password|sandi|pin ?atm|kode sms)\b/i;
const SEXUAL_RE =
  /\b(vcs|video call sex|sexting|open ?bo|onlyfans|jual konten|koleksi video|bugil|telanjang|toket|nude|horny banget|main yuk berapa)\b/i;
const MASS_RE = /\b(selamat (pagi|siang|malam|sore) (semua|bapak|ibu)|dear (customer|pelanggan)|bapak\/ibu|hai kak, kami|perkenalkan kami)/i;

/** Same message over and over, or asking the same thing in a flood. */
function repeats(chat, incoming) {
  const text = String(incoming || "").trim().toLowerCase();
  if (!text) return 0;
  const recent = (chat.history || [])
    .filter((h) => h.role === "user")
    .slice(-8)
    .map((h) => String(h.content || "").trim().toLowerCase());
  return recent.filter((t) => t === text).length;
}

/** Messages inside the last minute — flood detection. */
function perMinute(chat) {
  const now = Date.now();
  return (chat.history || []).filter((h) => h.role === "user" && now - (h.ts || 0) < 60000).length + 1;
}

/**
 * How suspicious is this message? Returns { score, reasons }.
 * Score carries over between messages via chat.stranger.strikes.
 */
export function assess(chat, incoming) {
  const text = String(incoming || "");
  const reasons = [];
  let score = 0;

  if (LINK_RE.test(text)) {
    score += 2;
    reasons.push("sent a link");
  }
  if (SCAM_RE.test(text)) {
    score += 3;
    reasons.push("spam or scam wording");
  }
  if (CODE_RE.test(text)) {
    score += 4;
    reasons.push("asked for a code or password");
  }
  if (SEXUAL_RE.test(text)) {
    score += 3;
    reasons.push("sexual solicitation");
  }
  if (MASS_RE.test(text)) {
    score += 2;
    reasons.push("mass broadcast wording");
  }

  const rep = repeats(chat, incoming);
  if (rep >= 2) {
    score += 2;
    reasons.push(`repeated the same message ${rep + 1}x`);
  }

  const flood = perMinute(chat);
  if (flood >= config.strangerFloodPerMin) {
    score += 2;
    reasons.push(`flooding (${flood} messages in a minute)`);
  }

  // wall of text from a stranger is usually an advert
  if (text.length > 600 && chat.stats?.inbound < 4) {
    score += 1;
    reasons.push("long wall of text on first contact");
  }

  return { score, reasons };
}

/* ------------------------------- tiers -------------------------------- */

export function tierOf(chat) {
  if (chat?.trusted === true) return "trusted";
  if (chat?.acquaintance === true) return "acquaintance";
  return "stranger";
}

export function strangerState(chat) {
  chat.stranger ||= { strikes: 0, warnedAt: 0, blockedAt: 0, reasons: [], introAskedAt: 0 };
  return chat.stranger;
}

/**
 * What should happen with this message from a non-trusted contact?
 *   allow | warn | block
 */
export function decide(chat, incoming) {
  if (!config.strangerGuard) return { action: "allow", reasons: [] };
  if (tierOf(chat) === "trusted") return { action: "allow", reasons: [] };

  const st = strangerState(chat);
  if (st.blockedAt) return { action: "blocked", reasons: [] };

  const { score, reasons } = assess(chat, incoming);
  if (score > 0) {
    st.strikes += score;
    st.reasons = [...st.reasons, ...reasons].slice(-8);
  }

  if (st.strikes >= config.strangerBlockScore) {
    return { action: "block", reasons: st.reasons };
  }
  if (st.strikes >= config.strangerWarnScore) {
    return { action: "warn", reasons: st.reasons, warned: Boolean(st.warnedAt) };
  }
  return { action: "allow", reasons };
}

/** She gets to know people: safe chat + a name + enough back and forth. */
export function promoteIfReady(chat) {
  if (tierOf(chat) !== "stranger") return false;
  const st = strangerState(chat);
  if (st.strikes > 0) return false; // any weirdness at all and she stays guarded
  const inbound = chat.stats?.inbound || 0;
  if (inbound < config.strangerPromoteAfter) return false;
  if (!chat.profile?.name) return false; // still does not know who they are
  chat.acquaintance = true;
  st.promotedAt = Date.now();
  log(`stranger → acquaintance: ${chat.jid} (${chat.profile.name})`);
  return true;
}

/** Does she still need to ask who this is? */
export function needsIntroduction(chat) {
  if (tierOf(chat) !== "stranger") return false;
  if (chat.profile?.name) return false;
  const st = strangerState(chat);
  const asked = st.introAskedAt || 0;
  const inbound = chat.stats?.inbound || 0;
  // ask on the first contact, then roughly every third message until she knows
  if (!asked) return true;
  if (inbound - (st.introAtCount || 0) >= 3) return true;
  return false;
}

export function markIntroAsked(chat) {
  const st = strangerState(chat);
  st.introAskedAt = Date.now();
  st.introAtCount = chat.stats?.inbound || 0;
}

/* ------------------------------- block -------------------------------- */

/**
 * Block the number on WhatsApp. Only ever called for a non-trusted contact,
 * after a warning was sent.
 */
export async function blockNumber(sock, chat, reason = "") {
  const st = strangerState(chat);
  try {
    await sock.updateBlockStatus(chat.jid, "block");
  } catch (err) {
    log(`block failed for ${chat.jid}: ${err.message}`);
  }
  st.blockedAt = Date.now();
  st.blockReason = String(reason).slice(0, 200);
  log(`BLOCKED ${chat.jid} — ${st.blockReason}`);
  return true;
}

export function unblock(chat) {
  const st = strangerState(chat);
  st.blockedAt = 0;
  st.strikes = 0;
  st.warnedAt = 0;
  st.reasons = [];
  return true;
}

/** The line she sends right before blocking. */
export const WARN_LINES = [
  "you're a stranger and this reads like spam. stop.",
  "i don't know you. one more message like that and i'm blocking you.",
  "seriously. whatever this is, i'm not interested.",
];
