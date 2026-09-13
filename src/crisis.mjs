/**
 * crisis.mjs — when someone says something that is not a roleplay anymore.
 *
 * This is a keyword detector, not a clinical tool. Its only job: make the
 * character drop everything else and be present, and make sure a human (the owner)
 * finds out. It never tries to counsel anyone.
 *
 * She stays in character — she does not mention hotlines like a script and she does
 * not turn into a therapist. She is simply not cold about it, and she does not go
 * quiet on it, whatever her mood is doing.
 */
import { config, log } from "./config.mjs";

const PATTERNS = [
  /\b(bunuh diri|bunuhdiri|suicide|kill myself|kill my self|end my life|ending my life)\b/i,
  /\b(mau|pengen|ingin|want to|wanna|going to)\s+(mati|meninggal|die|dying|end it all)\b/i,
  /\b(gak|nggak|ga|tidak|udah)\s+(mau|pengen|ingin)\s+(hidup|live)\b/i,
  /\b(nyakitin|menyakiti|melukai|hurt)\s+(diri|myself|my self)\b/i,
  /\b(self[- ]?harm|cutting myself|potong (tangan|nadi)|overdosis|overdose|gantung diri|loncat)\b/i,
  /\b(better off dead|udahan aja hidup|capek hidup|lelah hidup)\b/i,
  /\b(nggak|gak|ga|tidak)\s+(sanggup|kuat)\s+(lagi|hidup)\b/i,
];

/** Is this a crisis message? Returns the matched phrase, or null. */
export function detectCrisis(text) {
  if (!config.crisisWatch) return null;
  const t = String(text || "");
  if (t.length < 3) return null;
  for (const re of PATTERNS) {
    const m = t.match(re);
    if (m) return m[0];
  }
  return null;
}

/**
 * Tell the owner. Best effort: a notification is a nice-to-have, the character's
 * response is not.
 */
export async function alertOwner({ who, text, hit }) {
  const message = `${who || "someone"}: …${String(text).slice(0, 160)}…`;
  log(`CRISIS signal (${hit}) → notifying owner: ${message.slice(0, 120)}`);
  if (!config.crisisNotify) return;
  try {
    const { execFile } = await import("node:child_process");
    execFile("termux-notification", ["-t", "Understudy — someone needs a human", "-c", message, "--priority", "high"], () => {});
  } catch {
    /* notification is best effort */
  }
}

/** Prompt block: care first, no lecture, no hotline script. */
export function crisisPromptBlock() {
  return [
    "## DIA SEDANG TIDAK AMAN",
    "Yang dia tulis itu serius — bukan becanda, bukan drama. Gengsi, mood, ngambek, semua diem dulu.",
    "- Tetap jadi kamu: nggak usah sok terapis, jangan ceramah, jangan ngasih daftar saran panjang.",
    "- Yang kamu lakuin: tetap di situ, tanya dia ada di mana / lagi sama siapa, bilang kamu peduli (dengan caramu), dan jangan tinggalin dia.",
    "- Jangan ngilang, jangan jawab satu kata, jangan ganti topik.",
    "- Jangan janji yang nggak bisa kamu tepatin, dan jangan nyuruh dia 'tenang' doang.",
  ].join("\n");
}
