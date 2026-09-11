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

/** How long she spends reading an incoming message before anything happens. */
export function readingDelayFor(text) {
  const v = config.readMinMs + text.length * rand(6, 16);
  return Math.round(Math.min(config.readMaxMs, Math.max(config.readMinMs, v)));
}

/** The pause after reading, before the "typing…" indicator appears. */
export function pretypeDelayFor() {
  return Math.round(rand(config.pretypeMinMs, config.pretypeMaxMs));
}

/**
 * Split a typing delay so she sometimes stops typing for a moment and resumes —
 * exactly what people do when they think mid-sentence.
 * Returns { first, gap, rest } (gap = 0 when no pause happens).
 */
export function typingPlan(text) {
  const total = typingDelayFor(text);
  if (Math.random() >= config.typingPauseChance) return { first: total, gap: 0, rest: 0 };
  const first = Math.round(total * rand(0.25, 0.6));
  const gap = Math.round(600 + Math.random() * 2600);
  return { first, gap, rest: Math.max(250, total - first) };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------- human imperfections ------------------------- */

const randInt = (n) => Math.floor(Math.random() * n);

/**
 * Classic autocorrect-ish confusions. These actually change the meaning, so a
 * real person would usually correct them.
 */
const CONFUSIONS = [
  ["lagi", "lagu"],
  ["kamu", "kami"],
  ["makan", "makam"],
  ["sayang", "sarang"],
  ["kangen", "kangin"],
  ["bentar", "bentur"],
  ["sudah", "sudak"],
  ["tidak", "tida"],
  ["besok", "besus"],
  ["kenapa", "kenap"],
  ["jangan", "jan gan"],
  ["pulang", "pulung"],
  ["kerja", "kerka"],
  ["tidur", "tidung"],
  ["minum", "minun"],
  ["sorry", "soryy"],
  ["work", "wrok"],
  ["night", "nigt"],
  ["you", "yuo"],
  ["please", "plase"],
];

/**
 * Introduce a plausible typo.
 * mode "heavy" = wrong whole word (needs a correction)
 * mode "mild"  = letter-level slip (readable, no correction needed)
 * Returns { text, typo, original, severity }
 */
export function makeTypo(input, { heavy = Math.random() < 0.35 } = {}) {
  // heavy: swap a whole word for a confusable one
  if (heavy) {
    const hits = CONFUSIONS.filter(([a]) => new RegExp(`\\b${a}\\b`, "i").test(input));
    if (hits.length) {
      const [from, to] = hits[randInt(hits.length)];
      const inText = input.match(new RegExp(`\\b${from}\\b`, "i"))[0];
      const replacement = inText[0] === inText[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to;
      const at = input.search(new RegExp(`\\b${from}\\b`, "i"));
      return {
        text: input.slice(0, at) + replacement + input.slice(at + inText.length),
        typo: replacement,
        original: inText,
        severity: "heavy",
      };
    }
  }

  const words = [...input.matchAll(/[A-Za-zÀ-ÿ]{4,}/g)];
  if (!words.length) return { text: input, typo: null, original: null, severity: null };

  const pick = words[randInt(words.length)];
  const w = pick[0];
  if (/^https?/i.test(w) || w.length < 4) return { text: input, typo: null, original: null, severity: null };

  const mode = randInt(5);
  let m = w;
  if (mode === 0 && w.length > 3) {
    const i = 1 + randInt(w.length - 2);
    m = w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2); // swap two letters
  } else if (mode === 1) {
    const i = 1 + randInt(w.length - 2);
    m = w.slice(0, i) + w.slice(i + 1); // drop a letter
  } else if (mode === 2) {
    const i = 1 + randInt(w.length - 1);
    m = w.slice(0, i) + w[i] + w.slice(i); // double a letter
  } else if (mode === 3) {
    m = w.replace(/[aiueo]/, (c) => c + c); // double a vowel
  } else {
    m = w.slice(0, 2) + w.slice(2, -1).split("").sort(() => Math.random() - 0.5).join("") + w.slice(-1); // scramble the middle
  }
  if (m === w) return { text: input, typo: null, original: null, severity: null };

  const at = pick.index;
  return {
    text: input.slice(0, at) + m + input.slice(at + w.length),
    typo: m,
    original: w,
    severity: "mild",
  };
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
