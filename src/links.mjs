/**
 * links.mjs — cross-chat context.
 *
 * Normally every contact is sealed: she never mixes up two people and never
 * tells one about the other. This module is the single, deliberate exception.
 *
 * Case it exists for: a stranger says "a friend gave me your number".
 *   1. the stranger's chat gets a note: waiting for them to confirm
 *   2. the referrer's chat gets a note: someone claims you gave them my number — ask him
 *   3. when they answer, whatever the answer is, it lands back in the
 *      stranger's chat: confirmed (gets treated as a friend of a friend) or
 *      denied (counts against them)
 *
 * It is deliberately general: any mention of another known contact creates a
 * note in that person's chat, not only referrals.
 */
import { chat as llmChat } from "./llm.mjs";
import { log, trackerProvider } from "./config.mjs";
import { listChats, loadChat, saveChat } from "./store.mjs";

/** Phrasing that means "someone sent me to you". */
const REFERRAL_RE =
  /(dapat|dapet|dikasih|diberi|dikirim|dari|sama|lewat|temen|teman|kenalan|kenal|kakak|adik|sepupu|saudara|teman|friend|friend of|got (?:your|the) number|got it from|gave me|referred|recommended|told me to|introduced|kenalin)/i;

const STRONG_REFERRAL_RE =
  /(nomor|number|kontak|contact|wa|whatsapp|kenalin|introduced|referred|recommended|told me to|temen|teman|friend)/i;

function norm(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Every contact she knows, except the one talking. */
export function candidates(excludeJid) {
  return listChats()
    .filter((c) => c.jid !== excludeJid)
    .map((c) => ({
      jid: c.jid,
      name: (c.profile?.name || "").trim(),
      nick: (c.profile?.nick || "").trim(),
      number: (c.profile?.number || c.jid.split("@")[0] || "").replace(/\D/g, ""),
    }))
    .filter((c) => c.name || c.nick || c.number);
}

/** Which of the names/numbers in this message belong to someone she knows? */
export function detectMention(chat, incoming, opts = {}) {
  const text = norm(incoming);
  if (!text || text.length < 4) return null;
  const list = candidates(chat.jid);
  const hits = [];
  for (const c of list) {
    const needles = [c.name, c.nick].filter((n) => n && n.length >= 3).map(norm);
    const digits = c.number ? c.number.replace(/^0+/, "") : "";
    const numHit = digits.length >= 8 && (text.includes(digits) || text.includes("0" + digits.slice(2)));
    const nameHit = needles.find((n) => new RegExp(`(^|[^a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(text));
    if (numHit || nameHit) hits.push({ ...c, matched: nameHit || c.number });
  }
  if (!hits.length) return null;
  const isReferral = REFERRAL_RE.test(text) && STRONG_REFERRAL_RE.test(text);
  const target = hits[0]; // closest match wins; one link per message is plenty
  return { target, all: hits, isReferral, text: incoming };
}

/**
 * Put a note in someone else's chat. These are the only things that cross the
 * per-contact wall, so they are kept short and factual.
 */
export function addCrossNote(target, { fromJid, fromName, kind, what, ref = null }) {
  target.crossNotes ||= [];
  const note = {
    at: Date.now(),
    kind, // referral | mention | answer
    fromJid,
    fromName: fromName || "someone",
    what: String(what).slice(0, 240),
    done: false,
    ref,
  };
  // do not repeat the same note twice
  const dup = target.crossNotes.some((n) => !n.done && n.kind === kind && n.fromJid === fromJid);
  if (dup) return null;
  target.crossNotes = [...target.crossNotes, note].slice(-6);
  log(`cross-note → ${target.jid}: [${kind}] ${note.what.slice(0, 60)}`);
  return note;
}

/** Notes she still has to act on, for the prompt. */
export function openNotes(chat, { max = 3 } = {}) {
  return (chat.crossNotes || []).filter((n) => !n.done).slice(-max);
}

/** What she is still waiting to hear about, from the stranger's side. */
export function openVouches(chat, { max = 3 } = {}) {
  return (chat.vouches || []).filter((v) => v.status === "pending").slice(-max);
}

export function addVouch(chat, referrer, claim) {
  chat.vouches ||= [];
  const dup = chat.vouches.some((v) => v.referrerJid === referrer.jid && v.status === "pending");
  if (dup) return null;
  const vouch = {
    referrerJid: referrer.jid,
    referrerName: referrer.name || referrer.nick || referrer.profile?.name || referrer.profile?.nick || "someone",
    claim: String(claim).slice(0, 200),
    askedAt: 0,
    answeredAt: 0,
    answer: "",
    status: "pending",
  };
  chat.vouches = [...chat.vouches, vouch].slice(-4);
  return vouch;
}

/** Once the referrer answers, close the loop on both sides. */
export function resolveVouch(strangerChat, referrerJid, { knew, answer }) {
  const vouch = (strangerChat.vouches || []).find((v) => v.referrerJid === referrerJid && v.status === "pending");
  if (!vouch) return null;
  vouch.answeredAt = Date.now();
  vouch.answer = String(answer || "").slice(0, 200);
  vouch.status = knew === true ? "confirmed" : knew === false ? "denied" : "unclear";
  log(`vouch ${vouch.status}: ${strangerChat.jid} ← ${vouch.referrerName}`);
  return vouch;
}

export function closeNote(target, fromJid, kind = null) {
  for (const n of target.crossNotes || []) {
    if (n.fromJid !== fromJid) continue;
    if (kind && n.kind !== kind) continue;
    n.done = true;
    n.doneAt = Date.now();
  }
}

/**
 * The referrer just replied. Work out whether that reply answers the open
 * question, and if so close the loop on the stranger's side too.
 */
export async function resolveNotes(chat, incoming) {
  const notes = (chat.crossNotes || []).filter((n) => !n.done && n.kind === "referral" && n.ref?.strangerJid);
  if (!notes.length) return [];
  const resolved = [];

  for (const note of notes) {
    note.tries = (note.tries || 0) + 1;
    let parsed = null;
    try {
      const raw = await llmChat(
        [
          {
            role: "system",
            content:
              "You read one reply and decide whether it answers a question. Return ONLY JSON: " +
              '{"answers":true|false,"knew":true|false,"answer":"their answer in their own words, max 12 words"}. ' +
              'answered=false when they did not address it at all. knew=false means they say they do NOT know that person.',
          },
          {
            role: "user",
            content: `THE QUESTION THEY WERE ASKED:\n${note.what}\n\nTHEIR REPLY:\n${String(incoming).slice(0, 500)}`,
          },
        ],
        { json: true, temperature: 0, maxTokens: 200, provider: trackerProvider() },
      );
      const a = raw.indexOf("{");
      const b = raw.lastIndexOf("}");
      parsed = JSON.parse(raw.slice(a, b + 1));
    } catch (err) {
      log(`vouch classify failed: ${err.message}`);
    }

    if (parsed && parsed.answered === undefined && typeof parsed.knew === "boolean") parsed.answered = true;
    if (!parsed || parsed.answered !== true) {
      if (note.tries >= 3) {
        note.done = true;
        note.doneAt = Date.now();
        note.note = "no clear answer";
      }
      continue;
    }

    note.done = true;
    note.doneAt = Date.now();
    const knew = parsed.knew === true;
    const answer = String(parsed.answer || "").slice(0, 120);

    const other = loadChat(note.ref.strangerJid);
    const vouch = resolveVouch(other, chat.jid, { knew, answer });
    const who = chat.profile?.name || chat.profile?.number || "that person";
    addCrossNote(other, {
      fromJid: chat.jid,
      fromName: who,
      kind: "answer",
      what: knew
        ? `${who} says they do know them: "${answer || "yes"}"`
        : `${who} says they do NOT know them: "${answer || "no"}"`,
    });
    if (vouch) {
      if (knew) {
        other.acquaintance = true;
        other.stranger ||= { strikes: 0, warnedAt: 0, blockedAt: 0, reasons: [], introAskedAt: 0 };
        other.stranger.vouchedBy = who;
      } else {
        other.stranger ||= { strikes: 0, warnedAt: 0, blockedAt: 0, reasons: [], introAskedAt: 0 };
        other.stranger.strikes = (other.stranger.strikes || 0) + 4;
        other.stranger.reasons = [...(other.stranger.reasons || []), `${who} denied knowing them`].slice(-8);
      }
    }
    saveChat(other);
    saveChat(chat);
    resolved.push({ jid: other.jid, knew, answer });
  }
  return resolved;
}
