import { config } from "./config.mjs";

const rand = (min, max) => min + Math.random() * (max - min);

/** Split a reply into natural WhatsApp bubbles. */
export function splitBubbles(text, { maxChars = config.bubbleMaxChars, maxBubbles = config.maxBubbles } = {}) {
  const trimmed = text.trim();
  if (!trimmed) return [];

  let chunks = trimmed.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);

  // A long paragraph becomes sentence groups.
  const expanded = [];
  for (const c of chunks) {
    if (c.length <= maxChars) {
      expanded.push(c);
      continue;
    }
    const sentences = c.split(/(?<=[.!?…])\s+/);
    let buf = "";
    for (const s of sentences) {
      if (!buf) buf = s;
      else if ((buf + " " + s).length <= maxChars) buf += " " + s;
      else {
        expanded.push(buf);
        buf = s;
      }
    }
    if (buf) expanded.push(buf);
  }

  // Hard-split anything still too long.
  const final = [];
  for (const c of expanded) {
    if (c.length <= maxChars * 1.6) {
      final.push(c);
      continue;
    }
    for (let i = 0; i < c.length; i += maxChars) final.push(c.slice(i, i + maxChars).trim());
  }

  // Respect the bubble cap by merging the overflow into the last bubble.
  if (final.length > maxBubbles) {
    const head = final.slice(0, maxBubbles - 1);
    const tail = final.slice(maxBubbles - 1).join(" ");
    head.push(tail);
    return head.filter(Boolean);
  }
  return final.filter(Boolean);
}

/** How long the character "types" before a bubble. */
export function typingDelayFor(text) {
  const base = config.minTypingMs + text.length * rand(14, 30);
  return Math.round(Math.min(config.maxTypingMs, Math.max(config.minTypingMs, base)));
}

/** How long it takes to read an incoming message. */
export function readingDelayFor(text) {
  return Math.round(Math.min(3500, 400 + text.length * rand(8, 18)));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------- human imperfections ------------------------- */

const randInt = (n) => Math.floor(Math.random() * n);

/** Introduce a plausible typo into one word. Returns { text, typo, original } */
export function makeTypo(input) {
  const words = [...input.matchAll(/[A-Za-zÀ-ÿ]{4,}/g)];
  if (!words.length) return { text: input, typo: null, original: null };

  // prefer a middle/longer word, not a URL
  const pick = words[randInt(words.length)];
  const w = pick[0];
  if (/^https?/i.test(w) || w.length < 4) return { text: input, typo: null, original: null };

  const mode = randInt(4);
  let m = w;
  if (mode === 0 && w.length > 3) {
    const i = 1 + randInt(w.length - 2);
    m = w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2); // swap
  } else if (mode === 1) {
    const i = 1 + randInt(w.length - 2);
    m = w.slice(0, i) + w.slice(i + 1); // drop a char
  } else if (mode === 2) {
    const i = 1 + randInt(w.length - 1);
    m = w.slice(0, i) + w[i] + w.slice(i); // double a char
  } else {
    m = w.replace(/[aiueo]/, (c) => c + c); // double a vowel
  }
  if (m === w) return { text: input, typo: null, original: null };

  const at = pick.index;
  const text = input.slice(0, at) + m + input.slice(at + w.length);
  return { text, typo: m, original: w };
}

/** A correction follow-up, the way people actually do it. */
export function correctionFor(original) {
  const styles = [`*${original}`, `maksudku ${original}`, `${original}*`, `bukan, ${original}`];
  return styles[randInt(styles.length)];
}

const REACTIONS = ["🍒", "😭", "🫠", "🥲", "😹", "😂", "❤️", "👍"];
export function pickReaction() {
  return REACTIONS[randInt(REACTIONS.length)];
}

/** Split one long bubble into a natural one-two burst. */
export function maybeBurst(bubbles, chance) {
  if (bubbles.length !== 1 || Math.random() > chance) return bubbles;
  const only = bubbles[0];
  if (only.length < 45) return bubbles;
  const m = only.match(/^(.{15,60}?[.!?…])\s+(.+)$/s);
  if (!m) return bubbles;
  return [m[1], m[2]];
}

/** Long, distracted pause before replying. */
export function maybeLongDelay() {
  if (Math.random() > config.longDelayChance) return 0;
  const { longDelayMinMs: a, longDelayMaxMs: b } = config;
  return Math.round(a + Math.random() * (b - a));
}
