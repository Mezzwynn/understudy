/**
 * lang.mjs — turn the persona card's free-text `language:` field into a blunt
 * order the model cannot misread.
 *
 * "English-dominant, casual, dengan sisipan Bahasa Indonesia" was being read as
 * "Indonesian with English sprinkles", so she drifted into Indonesian even
 * though her card says otherwise. This is used by the system prompt and by the
 * daily-routine generator.
 */
export function languageDirective(language) {
  const l = String(language || "").trim();
  if (!l) return "";
  const hasId = /indonesia|bahasa/i.test(l);
  if (/english[- ]dominant|dominan inggris|mostly english|english first/i.test(l)) {
    return hasId
      ? "Write in ENGLISH. Bahasa Indonesia only as a rare sprinkle — at most one short word or phrase per message, and never a whole sentence."
      : "Write in ENGLISH only.";
  }
  if (/indonesian[- ]dominant|bahasa indonesia/i.test(l) && !/english[- ]dominant/i.test(l)) {
    return /english/i.test(l)
      ? "Write in BAHASA INDONESIA (casual). English only as a rare sprinkle — at most one short word per message."
      : "Write in BAHASA INDONESIA (casual).";
  }
  if (/bilingual|mix|campur/i.test(l)) {
    return "Mix both languages naturally the way she does, but keep one of them clearly dominant per message.";
  }
  return `Write in: ${l}.`;
}

/**
 * Cheap language detection for the incoming message: enough to know whether she
 * should mirror it. A client writing polite Indonesian should not get clipped
 * English back — that reads as arrogance.
 */
const ID_WORDS =
  /\b(kak|saya|aku|kamu|anda|bisa|boleh|terima kasih|makasih|baik|iya|tidak|nggak|gak|sudah|udah|belum|apa|apakah|bagaimana|gimana|kalau|jika|silakan|tolong|maaf|besok|hari|jam|nanti|mau|ada|ini|itu|untuk|dengan|dari|ke|dan|yang|di|suka|kenal|nama)\b/gi;
const EN_WORDS = /\b(the|you|your|are|is|can|could|would|thanks|thank you|please|sorry|hello|hey|what|how|when|where|why|i'm|im|dont|don't|u|ya)\b/gi;

export function detectLanguage(text) {
  const t = String(text || "");
  if (t.trim().length < 3) return null;
  const id = (t.match(ID_WORDS) || []).length;
  const en = (t.match(EN_WORDS) || []).length;
  if (id === 0 && en === 0) return null;
  if (id > en) return "id";
  if (en > id) return "en";
  return null;
}

/** Is this message written in a formal/respectful register? */
export function isFormalRegister(text) {
  return /\b(anda|saya|kak|bapak|ibu|pak|bu|terima kasih|silakan|mohon|maaf sebelumnya|dengan hormat)\b/i.test(String(text || ""));
}
