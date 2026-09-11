/**
 * guard.mjs — keeps the character from leaking meta/narrative voice and
 * strips the hidden control line + markdown.
 */

const FORBIDDEN = [
  /\bas an ai\b/i,
  /\bi(?:'m| am) an ai\b/i,
  /\bai assistant\b/i,
  /\blanguage model\b/i,
  /\bartificial intelligence\b/i,
  /\bchatbot\b/i,
  /\bchat bot\b/i,
  /\bsystem prompt\b/i,
  /\bmy (?:instructions|programming|prompt|guardrails|guidelines)\b/i,
  /\bi (?:was|am) program(?:med|ed)\b/i,
  /\bi (?:cannot|can't|am unable to) (?:help|assist|do that|continue)\b/i,
  /\bsebagai (?:ai|asisten ai)\b/i,
  /\baku (?:ini )?(?:ai|bot)\b/i,
  /\bsaya (?:ini )?(?:ai|bot)\b/i,
  /\bmodel bahasa\b/i,
  /\bprogram saya\b/i,
  /\binstruksi saya\b/i,
  /\broleplay(?:ing)?\b/i,
  /\bberperan sebagai\b/i,
  /\bscenario\b/i,
  /\bpseudocode\b/i,
  /###CTRL###/, // leaked control marker
];

export function looksBroken(text) {
  return FORBIDDEN.some((re) => re.test(text));
}

/** Remove markdown so it reads like a phone message. */
// ElevenLabs v3 audio tags can be freeform, e.g. [soft, barely audible].
// Outgoing model text never legitimately contains bracketed notes, so strip
// any short bracketed segment.
const AUDIO_TAG = /\s*\[[^\[\]\n]{0,60}\]\s*/g;

/** Remove ElevenLabs v3 audio tags from visible chat text. */
export function stripAudioTags(text) {
  return text
    .replace(AUDIO_TAG, " ")
    .replace(/\[[^\]\n]*$/g, " ") // dangling, unclosed tag at the end
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^ +| +$/gm, "");
}

/** Remove markdown so it reads like a phone message. */
/** Remove markdown so it reads like a phone message. */
export function stripMarkdown(text) {
  return stripAudioTags(stripBase(text));
}

/** Same, but keeps ElevenLabs v3 audio tags (for voice-note scripts). */
export function stripMarkdownKeepingTags(text) {
  return stripBase(text);
}

function stripBase(text) {
  return text
    .replace(/<\|[^|>]*\|>/g, "") // leaked special tokens like <|reserved_special_token_57|>
    .replace(/<\|\|?[a-z_]+\|?\|?>/gi, "")
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?]|$)/g, "$1$2")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1")
    .replace(/[ \t]+\n/g, "\n");
}

const CTRL_RE = /^[ \t]*###CTRL###[ \t]*(\{[\s\S]*\})[ \t]*$/m;
const CTRL_JSON_RE = /^[ \t]*###CTRL###[ \t]*\n+[ \t]*(\{[\s\S]*?\})[ \t]*$/m;

/** Split the hidden control line off the visible reply. */
export function extractControl(text) {
  let control = null;
  let visible = text;
  for (const re of [CTRL_RE, CTRL_JSON_RE]) {
    const m = visible.match(re);
    if (m) {
      try {
        control = JSON.parse(m[1]);
      } catch {
        control = null;
      }
      visible = visible.replace(m[0], "");
      break;
    }
  }
  // If a malformed control marker exists, drop the trailing line anyway.
  visible = visible.replace(/^[ \t]*###CTRL###.*$/gm, "");
  return { text: visible, control };
}

/** Final cleanup before the text is split into bubbles. */
export function clean(text, personaName = "", opts = {}) {
  let out = (opts.keepAudioTags ? stripMarkdownKeepingTags(text) : stripMarkdown(text)).trim();
  if (personaName) {
    const re = new RegExp(`^${personaName}\\s*[:\\-–]\\s*`, "i");
    out = out.replace(re, "");
  }
  out = out.replace(/^["“']([\s\S]*)["”']$/, "$1").trim();
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

const GENERIC_DEFLECTIONS = [
  "hah? apaan sih wkwk",
  "maksudnya?",
  "ngaco ya kamu",
  "ga ngerti aku",
  "eh, serius?",
];

/** Used only when regeneration still fails the guard. */
export function deflection(personaName, custom) {
  if (custom) return custom;
  return GENERIC_DEFLECTIONS[Math.floor(Math.random() * GENERIC_DEFLECTIONS.length)];
}
