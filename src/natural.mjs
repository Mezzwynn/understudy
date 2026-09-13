/**
 * natural.mjs — the everyday unpredictability of a person.
 *
 * Two things that make her read as someone with a life rather than a service:
 *
 * 1. DAILY VARIANCE — some days she wakes up flat for no reason, some days she is
 *    fine. A small random offset per person per day, applied on the first message
 *    of the day, on top of yesterday's residue. Moods are not deterministic.
 *
 * 2. BUSY BLOCKS — her routine says what she is doing at this hour. If that is
 *    work, a meeting, a class or the gym, she does not drop everything to answer:
 *    she either says she cannot talk right now, or answers later — the way a person
 *    with a job does.
 */
import { config, log } from "./config.mjs";
import { currentBlock, nextBlock, loadRoutine } from "./routine.mjs";
import { applyDeltas, normalize, isMoodLocked, lockValue } from "./mood.mjs";

const BUSY_RE =
  /\b(kerja|work|meeting|rapat|zoom|call|kelas|class|pilates|gym|lari|run|klien|client|brief|deadline|lembur|syuting|shoot|interview|wawancara|ujian|exam|masak|cook)\b/i;
const IDLE_RE = /\b(santai|chill|scroll|rebahan|tidur|sleep|istirahat|relax|baca|book|nonton|series|jalan|walk|shower|mandi)\b/i;

/** Is this hour one where she cannot just answer? */
export function busyNow(chat, now = new Date()) {
  if (!config.busyBlocks) return null;
  const routine = loadRoutine(chat?.persona || config.persona);
  if (!routine) return null;
  const block = currentBlock(routine, now);
  if (!block) return null;
  const what = String(block.what || "");
  if (!BUSY_RE.test(what)) return null;

  const [h, m] = String(block.end).split(":").map(Number);
  const end = new Date(now);
  end.setHours(h, m || 0, 0, 0);
  if (end < now) end.setDate(end.getDate() + 1);
  const minutesLeft = Math.round((end - now) / 60000);
  return { block, minutesLeft, what };
}

/**
 * A small random mood offset for the day, per person. Applied once, on the first
 * message of the day.
 */
export function dailyVariance(chat, now = new Date()) {
  if (!config.dailyVariance || !chat?.mood) return null;
  const today = now.toDateString();
  if (chat.moodDay === today) return null;
  chat.moodDay = today;

  const spread = config.dailySpread;
  const r = (n) => (Math.random() * 2 - 1) * n;
  const deltas = {
    valence: r(spread),
    patience: r(spread * 1.2),
    energy: r(spread * 1.4),
    playfulness: r(spread),
  };
  if (isMoodLocked(chat)) return null;
  chat.mood = applyDeltas(normalize(chat.mood), deltas);
  const flavour =
    deltas.valence <= -spread * 0.5
      ? "woke up flat"
      : deltas.valence >= spread * 0.5
        ? "woke up fine"
        : "ordinary start";
  log(`daily variance for ${chat.jid}: ${flavour} (valence ${deltas.valence.toFixed(2)}, energy ${deltas.energy.toFixed(2)})`);
  return { deltas, flavour };
}

/** Prompt block: her mind is elsewhere right now. */
export function busyPromptBlock(chat, now = new Date()) {
  const busy = busyNow(chat, now);
  if (!busy) return "";
  const next = nextBlock(loadRoutine(chat?.persona || config.persona), now);
  return [
    "## Kamu lagi sibuk",
    `Sekarang kamu lagi: ${busy.what}. Kamu nggak sedang bebas.`,
    `Sisa ~${busy.minutesLeft} menit lagi${next ? `, abis itu: ${next.what}` : ""}.`,
    "- Bales seadanya: pendek, setengah fokus, boleh bilang kamu lagi sibuk/tengah kerja.",
    "- Jangan ngobrol panjang, jangan nanya balik banyak. Boleh bilang nanti lanjut.",
    next ? `- Kamu boleh bli bilang: nanti kamu kabarin lagi abis ${String(next.what).toLowerCase()}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The line she sends when she cannot talk — short, in character, no drama. */
export const BUSY_REPLIES = [
  "lagi kerja. nanti ya.",
  "in the middle of something. talk later.",
  "can't right now. busy.",
  "kerja dulu. i'll reply when i'm done.",
  "nggak bisa sekarang. nanti.",
];
