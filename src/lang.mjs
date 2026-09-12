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
