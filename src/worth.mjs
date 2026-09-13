/**
 * worth.mjs — does this message deserve a reply at all?
 *
 * A person does not answer everything. They answer because it matters, because
 * they are curious, because they have the energy, or because not answering would
 * be rude. They do not answer because: it was a one-word ping, it was boring, the
 * other person is spamming, they are out of energy, or the conversation had already
 * ended.
 *
 * This replaces the old "short ping only" rule with a scored decision. Every skip
 * logs WHY, so the behaviour is inspectable instead of mysterious.
 *
 * Hard rules that always win: a direct question, health/safety, a crisis, and an
 * apology after a fight are never skipped.
 */
import { config } from "./config.mjs";
import { topicReaction, traitsForChat } from "./traits.mjs";

const TERMINAL_RE =
  /^(ok(ay)?|oke|oh|ohh+|sip|siap|yoi|yup|yes|ya|yaa+|iya+|hmm+|wkwk+|hehe+|lol|nice|good|mantap|thanks|thank you|makasih|thx|santai|no problem|np|bye|dadah|nanti|gtg|good night|gn|selamat malam|udah|udh|sudah|alright|fine|noted)[.! ]*$/i;
const QUESTION_RE = /(\?|\b(kenapa|kok|apa|apakah|gimana|bagaimana|siapa|kapan|di ?mana|berapa|emang|why|what|how|who|when|where|which)\b)/i;
const ACK_AFTER_QUESTION_RE = /^(iya|ya|udah|sudah|belum|boleh|gak|nggak|no|yes|ok)\b/i;

/** A quick read of what kind of message this is. */
export function classify(chat, incoming) {
  const text = String(incoming || "").trim();
  const bare = text.replace(/\s/g, "");
  const isMedia = text.startsWith("[");
  const recent = (chat.history || []).filter((h) => h.role === "user").slice(-8);
  const mine = (chat.history || []).filter((h) => h.role === "assistant").slice(-4);

  const identical = recent.filter((h) => String(h.content || "").trim().toLowerCase() === text.toLowerCase()).length;
  const perMinute = (chat.history || []).filter((h) => h.role === "user" && Date.now() - (h.ts || 0) < 60000).length;

  return {
    text,
    isMedia,
    bare,
    short: bare.length <= 12,
    terminal: TERMINAL_RE.test(text),
    question: QUESTION_RE.test(text),
    identical,
    perMinute,
    mine,
    // she has sent the last several messages with no answer in between
    carrying: mine.length >= 3 && recent.length === 0,
  };
}

/**
 * @returns {{skip:boolean, reason:string, chance:number}}
 */
export function worthReplying(chat, incoming, { mood, worried = false, crisis = false, cameBack = false } = {}) {
  const c = classify(chat, incoming);
  const m = mood || chat.mood || {};

  // never skip these
  if (crisis) return { skip: false, reason: "crisis", chance: 0 };
  if (worried) return { skip: false, reason: "health", chance: 0 };
  if (cameBack) return { skip: false, reason: "they came back after a sulk", chance: 0 };
  if (c.question) return { skip: false, reason: "direct question", chance: 0 };
  if (config.skipChance <= 0) return { skip: false, reason: "skipping disabled", chance: 0 };

  const reasons = [];
  let chance = 0;

  // 1. a ping that needs nothing back
  if (c.terminal) {
    chance = Math.max(chance, config.skipTerminalChance);
    reasons.push("just an acknowledgement");
  } else if (c.short) {
    chance = Math.max(chance, config.skipChance);
    reasons.push("short ping");
  }

  // 2. boring: nothing in it that interests her, no hook
  const traits = traitsForChat(chat);
  const react = topicReaction(traits, c.text);
  const interesting = react.hot.length > 0 || (m.affection ?? 0.5) >= 0.6;
  if (!interesting && !c.terminal && c.bare.length < 80) {
    chance = Math.max(chance, config.skipBoredChance);
    reasons.push("nothing in it for her");
  }
  if (react.bored.length) {
    chance = Math.max(chance, config.skipBoredChance * 1.6);
    reasons.push(`boring topic (${react.bored[0]})`);
  }

  // 3. spam: the same thing again, or a flood
  if (c.identical >= 2) {
    chance = Math.max(chance, 0.8);
    reasons.push(`same message ${c.identical + 1}x`);
  }
  if (c.perMinute >= config.skipFloodPerMin) {
    chance = Math.max(chance, 0.75);
    reasons.push(`${c.perMinute} messages in a minute`);
  }

  // 4. no energy left
  if ((m.energy ?? 0.6) < 0.3) {
    chance = Math.max(chance, config.skipLowEnergyChance);
    reasons.push("out of energy");
  }
  // and when she is cold, she simply does not feel like it
  if ((m.patience ?? 0.6) < 0.3) {
    chance = Math.max(chance, config.skipColdChance);
    reasons.push("short fuse");
  }

  // 5. the conversation already ended, or she is the only one talking
  if (c.carrying) {
    chance = Math.max(chance, config.skipCarryingChance);
    reasons.push("she has been carrying the conversation");
  }
  // they never answered her last question
  const askedLast = /\?\s*$/.test(String(c.mine?.[c.mine.length - 1]?.content || "").trim());
  if (askedLast && recent.length === 0) {
    chance = Math.max(chance, 0.35);
    reasons.push("they never answered her question");
  }

  const skip = Math.random() < chance;
  return { skip, reason: reasons.join(" · ") || "no reason to skip", chance: Math.round(chance * 100) / 100 };
}
