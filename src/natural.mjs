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

/* ------------------------- the rest of being human ------------------------ */

const FILLER = new Set(["yang","dan","di","ke","aku","kamu","itu","ini","sih","deh","lah","kan","ya","a","the","and","of","to","is","it","my","your"]);

function keywords(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !FILLER.has(w)),
  );
}

/**
 * One topic, over and over. If the last stretch of chat keeps landing on the same
 * words, she notices — people do ("kita bahas ini terus ya").
 */
export function topicFatigue(chat, { window = 14, minMessages = 10 } = {}) {
  if (!config.topicFatigue) return "";
  const recent = (chat.history || []).slice(-window);
  if (recent.length < minMessages) return "";
  const counts = new Map();
  for (const m of recent) for (const w of keywords(m.content)) counts.set(w, (counts.get(w) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!top) return "";
  const share = top[1] / recent.length;
  if (share < 0.5) return "";
  return [
    "## Kalian udah lama di topik yang sama",
    `Topik "${top[0]}" udah keulang-ulang (${top[1]} dari ${recent.length} pesan terakhir).`,
    "Kamu mulai bosen. Boleh ganti arah, bahas hal lain, atau bilang singkat bahwa ini muter-muter.",
    "Jangan ceramah, jangan nyalahin. Cukup geser topiknya dengan wajar.",
  ].join("\n");
}

/**
 * They wrote hours ago and she is only answering now. People explain that, briefly.
 */
export function lateReplyNote(chat, now = new Date()) {
  if (!config.lateReplyNote) return "";
  const last = (chat.history || []).filter((h) => h.role === "user").slice(-1)[0];
  if (!last?.ts) return "";
  const mins = (now.getTime() - last.ts) / 60000;
  if (mins < config.lateReplyMinMin) return "";
  const hours = Math.floor(mins / 60);
  const when = new Date(last.ts).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
  return [
    "## Kamu telat bales",
    `Dia nulis jam ${when} (${hours >= 1 ? hours + " jam" : Math.round(mins) + " menit"} lalu), dan kamu baru bales sekarang.`,
    "Boleh disinggung sekali, singkat, dengan alasan yang wajar (sibuk, HP ketinggalan, ketiduran, lagi di luar).",
    "Jangan minta maaf berlebihan dan jangan njelasin panjang.",
  ].join("\n");
}

/** Writing at 4am is its own topic. */
export function oddHourNote(now = new Date()) {
  if (!config.oddHourNote) return "";
  const h = now.getHours();
  if (h < 0 || h >= 6) return "";
  return [
    "## Jam aneh",
    `Sekarang jam ${h}:00-an. Orang normal lagi tidur.`,
    "Kalau nyambung, kamu boleh nyindir soal jamnya sekali — kenapa masih bangun, atau nyuruh dia tidur.",
  ].join("\n");
}

/* ------------------------------ message edits ----------------------------- */

/** A little afterthought she adds by editing the message she just sent. */
export const EDIT_AFTERMATH = [
  "…oh and drink water.",
  "…and eat something.",
  "…jangan lupa tidur.",
  "…also: no.",
  "…don't reply to that.",
  "…kamu tau maksudku.",
];
