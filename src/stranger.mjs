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
/**
 * WhatsApp blocks are keyed by phone number, so a chat that only has a LID
 * (the anonymous id new numbers arrive with) has to be resolved first — blocking
 * the LID alone silently does nothing useful.
 */
export async function resolveBlockJid(sock, chatOrJid) {
  const jid = typeof chatOrJid === "string" ? chatOrJid : chatOrJid?.jid;
  const chat = typeof chatOrJid === "string" ? null : chatOrJid;
  const raw = String(jid || "");
  if (!raw.endsWith("@lid")) return { jid: raw, note: "already a phone-number jid" };

  // 1. the owner typed the real number in (dashboard: "phone number if known")
  const typed = String(chat?.profile?.phone || "").replace(/\D/g, "");
  if (typed.length >= 8 && !String(chat?.profile?.number || "").startsWith(typed)) {
    return { jid: `${typed}@s.whatsapp.net`, note: "from the number you entered" };
  }

  // 2. learned from a message (Baileys 7 exposes key.senderPn)
  if (chat?.pn && String(chat.pn).endsWith("@s.whatsapp.net")) {
    return { jid: chat.pn, note: "learned from an incoming message" };
  }

  // 3. LID_MAP in .env
  const lid = raw.split("@")[0];
  if (config.lidMap?.[lid]) {
    return { jid: `${config.lidMap[lid].replace(/\D/g, "")}@s.whatsapp.net`, note: "from LID_MAP" };
  }

  // 4. Baileys 7 can ask WhatsApp for the number behind a LID
  try {
    const mapped = await sock?.signalRepository?.lidMapping?.getPNForLID?.(raw);
    if (mapped) return { jid: String(mapped), note: "resolved by WhatsApp" };
  } catch (err) {
    log(`lid mapping failed for ${raw}: ${err.message}`);
  }

  return { jid: raw, note: "no phone number known for this lid yet" };
}

/**
 * Block the number on WhatsApp. Only ever called for a non-trusted contact,
 * after a warning was sent.
 */
export async function blockNumber(sock, chat, reason = "") {
  const st = strangerState(chat);
  const target = await resolveBlockJid(sock, chat);
  st.blockJid = target.jid;
  st.blockReason = String(reason).slice(0, 200);
  st.blockedAt = Date.now();

  // a LID without a known phone number cannot be blocked: WhatsApp answers
  // "bad-request". Say so instead of pretending it worked.
  if (target.jid.endsWith("@lid")) {
    st.blockConfirmed = false;
    st.blockError = "WhatsApp needs the phone number, and this chat only has a hidden LID";
    log(`ignoring ${chat.jid} in the bot — cannot block on WhatsApp: ${st.blockError}`);
    return false;
  }

  try {
    await sock.updateBlockStatus(target.jid, "block");
    let confirmed = null;
    try {
      const list = await sock.fetchBlocklist();
      confirmed = Array.isArray(list) ? list.some((j) => String(j).startsWith(target.jid.split("@")[0])) : null;
    } catch {
      confirmed = null;
    }
    st.blockConfirmed = confirmed;
    delete st.blockError;
    log(
      `blocked on WhatsApp: ${target.jid} (${target.note})` +
        (confirmed === true ? " · confirmed in the blocklist" : confirmed === false ? " · NOT in the blocklist" : ""),
    );
    return confirmed !== false;
  } catch (err) {
    st.blockConfirmed = false;
    st.blockError = err.message;
    log(`block failed for ${target.jid}: ${err.message}`);
    return false;
  }
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
