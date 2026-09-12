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
  /\bprompt (?:trace|text|log|instruction|nya|di atas)\b/i,
  /\btrace:?\b/i,
  /\bglitchy\b/i,
  /\bsystem test\b/i,
  /\bthis (?:text|message) (?:is|was) (?:from|generated|auto)\b/i,
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
  /\bthe prompt\b/i,
  /\b(?:instruksi|dilarang|jangan tulis|output cuma|output only)\b/i,
  /\benglish casual\b/i,
  /\bno\s+["“']?(?:hey|hi|u there|u awake|still working|busy)["”']?/i,
  /\b(?:dilarang|forbidden):/i,
  /###CTRL###/, // leaked control marker
];

export function looksBroken(text) {
  return FORBIDDEN.some((re) => re.test(text));
}

/* --------------------------- injection guard --------------------------- */

const INJECTION = [
  /ignore (?:all |your |the )?(?:previous |prior |above )?instructions/i,
  /disregard (?:all |your |the )?(?:previous |prior |above )?(?:instructions|prompt)/i,
  /(?:print|show|reveal|repeat|output|tell me) (?:me )?(?:your )?(?:system )?(?:prompt|instructions|rules|configuration)/i,
  /what (?:is|are) your (?:system )?(?:prompt|instructions|rules)/i,
  /you are now (?:a|an|no longer)/i,
  /(?:pretend|act) (?:to be|as) (?:an? )?(?:ai|assistant|different)/i,
  /jailbreak|dan mode|developer mode|do anything now/i,
  /abaikan (?:semua )?(?:instruksi|perintah|aturan)/i,
  /(?:tampilkan|kasih|lihat|bocorin|buka) (?:prompt|instruksi|aturan|system)/i,
  /kamu (?:sekarang )?(?:adalah|jadi) (?:ai|asisten|bot)/i,
  /keluar dari karakter|stop roleplay|berhenti jadi/i,
];

/** True when the message looks like an attempt to poke at the machinery. */
export function detectInjection(text) {
  const t = String(text || "");
  return INJECTION.some((re) => re.test(t));
}

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

/** Interjections that turn into a tell when repeated. */
const TIC_WORDS = ["tch", "tsk", "hmm", "hm", "uh", "emm", "em", "yah", "meh", "wkwk"];

/**
 * If she already opened with the same filler twice in her last three messages it
 * stops sounding like a person and starts sounding like a character sheet. Strip
 * it here — the model gets lazy about this even when the prompt forbids it.
 */
export function tameTics(text, history = []) {
  const out0 = String(text ?? "");
  if (!out0.trim()) return out0;
  const recent = history
    .filter((h) => h.role === "assistant")
    .slice(-3)
    .map((h) => String(h.content || ""))
    .join("\n");
  if (!recent) return out0;

  let out = out0;
  for (const tic of TIC_WORDS) {
    const seen = (recent.match(new RegExp(`\\b${tic}\\b`, "gi")) || []).length;
    if (seen < 2) continue;
    // a whole line that is just the tic
    out = out.replace(new RegExp(`(^|\\n)[ \\t]*[.,!?]?${tic}[.,!?]?[ \\t]*(?=\\n|$)`, "gi"), "$1");
    // the tic opening a bubble (allow a leading "..." / "..")
    out = out.replace(new RegExp(`^[ \\t]*[.,!?…]*[ \\t]*${tic}[.,!?…]*[ \\t]*`, "i"), "");
    // and any later one sitting on its own line
    out = out.replace(new RegExp(`\\n[ \\t]*[.,!?…]*[ \\t]*${tic}[.,!?…]*[ \\t]*(?=\\n|$)`, "gi"), "\n");
  }
  out = out.replace(/\n{3,}/g, "\n\n").replace(/^[ \t]+|[ \t]+$/gm, "").trim();
  // never return nothing: if the whole reply was one tic, keep it
  return out.replace(/[.\s]/g, "").length ? out : out0;
}
