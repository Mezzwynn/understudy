/**
 * sleep.mjs — she sleeps at night, like a person.
 *
 * Quiet hours used to stop only the proactive side: a message at 3am still got an
 * instant, fully coherent answer, which is the least human thing this bot did.
 *
 * Now, during quiet hours:
 *   - most messages get no reply at all (she is asleep, it can wait until morning)
 *   - if she does answer, she is groggy: short, flat, half-asleep, and she may
 *     fall back asleep mid-conversation
 *   - anything health or safety related always wakes her up properly
 *
 * The reply she leaves in the morning tends to own the gap ("saw this at 3am.
 * you're lucky i like you").
 */
import { config } from "./config.mjs";

/** Minutes since midnight, so a window crossing midnight works. */
function inWindow(hour, start, end) {
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

export function isSleeping(now = new Date()) {
  return inWindow(now.getHours(), config.quietStart, config.quietEnd);
}

/**
 * 0 = wide awake, 1 = deepest sleep.
 * Highest in the middle of the quiet window, tapering at both edges.
 */
export function sleepiness(now = new Date()) {
  if (!config.sleepMode) return 0;
  const { quietStart: s, quietEnd: e } = config;
  const hour = now.getHours() + now.getMinutes() / 60;
  const span = (e - s + 24) % 24 || 8;
  const elapsed = (hour - s + 24) % 24;
  if (elapsed >= span) return 0;
  // triangle: 0 at the edges, 1 in the middle
  const x = elapsed / span;
  return Math.round(Math.min(1, Math.sin(Math.PI * x) * 1.15) * 100) / 100;
}

/** Would she even pick up the phone for this? */
export function shouldIgnore(incoming, { worried = false, now = new Date() } = {}) {
  if (!config.sleepMode) return false;
  const sleep = sleepiness(now);
  if (sleep <= 0) return false;
  if (worried) return false; // a health scare always wakes her up
  // the deeper the sleep, the more likely she never sees it until morning
  const chance = config.sleepReplyChance * (1 - sleep * 0.75);
  return Math.random() > chance;
}

/** Prompt block for the nights she does answer. */
export function sleepPromptBlock(now = new Date()) {
  const sleep = sleepiness(now);
  if (sleep <= 0) return "";
  const hour = now.getHours();
  const depth = sleep > 0.75 ? "kamu tidur paling nyenyak" : sleep > 0.4 ? "tidur kamu agak terganggu" : "kamu baru mau tidur / hampir bangun";
  return [
    "## Kamu lagi tidur (baru kebangun)",
    `Sekarang jam ${hour}:00-an — ${depth}. Kamu baru kebangun karena HP-nya bunyi.`,
    "- Bales SEADANYA: pendek, lambat, setengah sadar. Jangan ngobrol panjang, jangan jadi rapi.",
    "- Boleh typo lebih banyak dari biasanya, boleh salah baca, boleh bingung sebentar.",
    "- Boleh ngambek kecil karena dibangunin, atau nyuruh dia tidur juga.",
    "- Jangan kirim voice note, jangan kirim stiker, jangan nyeritain hari kamu.",
    "- Kalau obrolannya lanjut, kamu boleh tiba-tiba ngantuk lagi dan berhenti bales.",
  ].join("\n");
}

/** In the morning she can own the gap instead of ignoring it. */
export function morningNote(chat, now = new Date()) {
  const last = chat.lastAsleepAt || 0;
  if (!last) return "";
  // compare against the passed clock, not the real one — otherwise this is
  // untestable and ignores whatever time the caller means
  const hours = (now.getTime() - last) / 3600000;
  if (hours > 8 || isSleeping(now)) return "";
  const mins = new Date(last).getMinutes();
  return `## Semalam\nDia nge-chat jam ${new Date(last).getHours()}:${String(mins).padStart(2, "0")} pas kamu tidur, dan kamu baru lihat sekarang.\nKalau nyambung, boleh disinggung sekali — sadar kamu telat bales, jangan minta maaf berlebihan.`;
}
