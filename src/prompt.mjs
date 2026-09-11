import fs from "node:fs";
import path from "node:path";
import { PERSONA_DIR, PROMPT_DIR, config } from "./config.mjs";
import { label, tone, KEYS } from "./mood.mjs";

const ENGINE_FILE = path.join(PROMPT_DIR, "engine.md");

export function loadEngine() {
  return fs.readFileSync(ENGINE_FILE, "utf8");
}

export function parsePersonaFrontmatter(raw) {
  const meta = {};
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue; // full-line comment
      const i = line.indexOf(":");
      if (i === -1) continue;
      const key = line.slice(0, i).trim();
      // strip a trailing inline comment ("value   # note")
      const value = line.slice(i + 1).replace(/\s+#.*$/, "").trim();
      if (key) meta[key] = value;
    }
  }
  return meta;
}

export function loadPersona(name = config.persona) {  const file = path.join(PERSONA_DIR, `${name}.md`);
  if (!fs.existsSync(file)) throw new Error(`Persona not found: ${file}`);
  const raw = fs.readFileSync(file, "utf8");
  const meta = parsePersonaFrontmatter(raw);
  return {
    slug: name,
    name: meta.name || config.botName,
    emoji: meta.emoji || "",
    vibe: meta.vibe || "",
    language: meta.language || "",
    deflection: meta.deflection || "",
    voice: meta.voice || "",
    voice_eleven: meta.voice_eleven || "",
    voice_tags: meta.voice_tags || "",
    voice_style: meta.voice_style || "",
    active_hours: meta.active_hours || "",
    chat_schedule: meta.chat_schedule || "",
    appearance: meta.appearance || "",
    card: raw,
  };
}

function fmtTime(date = new Date()) {
  try {
    return date.toLocaleString("id-ID", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return date.toISOString();
  }
}

function fmtAgo(ts) {
  if (!ts) return "unknown";
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}

function listOrNone(title, arr) {
  if (!arr || !arr.length) return `${title}: —`;
  return `${title}:\n` + arr.map((x) => `- ${x}`).join("\n");
}

export function buildSystem(chat, persona, { displayName, voice, startedIt, thawed } = {}) {
  const mood = chat.mood;
  const mem = chat.memory || {};
  const profile = chat.profile || {};
  const nums = KEYS.map((k) => `${k} ${mood[k].toFixed(2)}`).join(" | ");
  const who = profile.name || displayName || "";
  const since = profile.since ? new Date(profile.since).toLocaleDateString("id-ID") : "—";

  // nickname is a privilege: it disappears when she is cold, sulking or hurt
  const pstate = chat.proactive?.state || "idle";
  const sulking = pstate === "dry" || pstate === "silent";
  const warm =
    !sulking && mood.affection >= 0.45 && mood.valence >= -0.05 && mood.patience >= 0.35;
  const nickLine = profile.nick
    ? warm
      ? `Kamu manggil dia: ${profile.nick} (boleh dipakai, tapi jangan tiap pesan)`
      : `Kamu manggil dia: ${profile.nick} — TAPI SEKARANG JANGAN PAKAI itu. Kamu lagi dingin/kesel. Panggil \"you\"/\"kamu\" aja.`
    : "Kamu manggil dia: —";

  const state = [
    "# Yang ada di kepalamu sekarang (jangan pernah diucapin atau dijelasin)",
    "",
    `Sekarang: ${fmtTime()}`,
    `Pesan terakhir dari dia: ${fmtAgo(chat.lastInteraction)}`,
    "",
    "## Kamu lagi chat sama SIAPA",
    `Nama: ${who || "belum tau namanya"}`,
    nickLine,
    `Nomor: ${profile.number || "—"}`,
    `Chat pertama: ${since}`,
    profile.notes ? `Catatan soal dia: ${profile.notes}` : "",
    "Ini CUMA orang ini. Jangan pernah ketuker sama orang lain, dan jangan ceritain hal tentang orang lain ke dia. Kalau kamu belum tahu namanya, tanya dengan natural — jangan kayak interogasi.",
    "Kalau namanya belum kamu tahu atau chat pertama masih hari ini, berarti ini orang yang belum kamu kenal. Bersikap wajar sama orang baru — jangan pura-pura udah kenal lama, dan jangan ceritain hal pribadi ke orang asing.",
    "",
    "## Mood kamu",
    `Lagi: ${label(mood)}`,
    nums,
    `Efeknya: ${tone(mood)}`,
    "",
    "## Yang kamu inget",
    `Hubungan: ${mem.relationship || "—"}`,
    listOrNone("Fakta soal dia", mem.facts),
    listOrNone("Jokes / callback", mem.jokes),
    listOrNone("Janji & rencana", mem.plans),
    listOrNone("Yang harus dihindari", mem.boundaries),
    mem.summary ? `Cerita sebelumnya: ${mem.summary}` : "",
    ...(startedIt
      ? [
          "",
          "# KONTEKS PENTING",
          "Kamu yang nge-chat duluan tadi. Dia baru bales sekarang. Kamu yang nungguin — jadi bersikap sesuai itu.",
          "Jangan langsung manis. Boleh nunjukin kesel, ketus, atau nanya kenapa lama. Tapi tetap jangan jelasin panjang.",
        ]
      : []),
    ...(thawed
      ? [
          "",
          "# KONTEKS PENTING",
          "Dia baru minta maaf. Kamu MASIH dingin — jangan langsung manis atau lebay.",
          "Bales pendek, boleh ketus dikit, biar dia yang berusaha. Baru luluh pelan-pelan.",
        ]
      : []),
    ...(voice
      ? [
          "",
          "# MODE VOICE NOTE — naskah untuk DIUCAPKAN (ElevenLabs v3)",
          "Sekarang kamu ninggalin voice note, bukan ngetik. Yang kamu tulis bakal dibacakan suara. Tulis seperti orang ngomong: berantakan, hidup, nggak rapi.",
          "",
          "## Audio tag",
          "- Ditulis dalam kurung siku, huruf kecil. Contoh: [soft] [sighs] [sighing] [pause] [dryly] [whispers] [laughs]",
          "- Tag boleh DESKRIPTIF dan bebas, bukan cuma dari daftar: [soft, voice thick with love], [flat, tired], [almost inaudible], [smiling a little]",
          "- Tag boleh muncul di TENGAH kalimat dan boleh dipakai lebih dari sekali. Jangan numpuk semua di awal.",
          "- Contoh penempatan: [soft] I don't care. [sighing] I just want a simple life.",
          `- Tag andalan kamu: ${persona.voice_tags || "[dryly] [pause] [sighs] [quietly] [flatly]"}`,
          "",
          "## Cara orang ngomong",
          "- Ada bunyi isi: emm, ee, uh, hmm, tch, yah, nah, well...",
          "- Kata bisa ditarik: anddd, yahh, okayyy, sooo",
          "- Sering kepotong dan mulai ulang: 'I— something', 'I mean—', '...forget it.'",
          "- Kalimat pendek dan panjang campur. Boleh ngulang kata. Boleh batalin kalimatnya sendiri.",
          "- '...' buat mikir/trail off, '—' buat kepotong, ',' buat napas pendek, HURUF KAPITAL buat penekanan.",
          "- Jangan emoji, markdown, tanda bintang, atau deskripsi di luar tag.",
          "- JANGAN dirapikan. Voice note yang rapi = ketauan robot.",
          "",
          "## Panjang",
          "1-3 kalimat aja. Boleh cuma satu kata + tag. Jangan pidato.",
          "",
          "## Contoh rasa (jangan tiru isinya, tiru rasanya)",
          "[soft, barely awake] hey. [pause] emm... it's three am, honey.",
          "[dryly] I was working. [sighs] I just— whatever. relax.",
          "[almost inaudible] ...i miss you. [soft] don't make it weird.",
          "Output HANYA kalimat yang diucapkan. Nggak ada penjelasan tambahan di luar tag.",
          persona.voice_style ? `\n## Gaya suara kamu\n${persona.voice_style}` : "",
        ].filter(Boolean)
      : []),
  ]
    .filter(Boolean)
    .join("\n");

  return [loadEngine().trim(), "---", persona.card.trim(), "---", state].join("\n\n");
}

export function buildMessages(chat, persona, incoming, { displayName, voice, startedIt, thawed } = {}) {
  const system = buildSystem(chat, persona, { displayName, voice, startedIt, thawed });
  const history = (chat.history || []).slice(-config.historyTurns).map((h) => ({
    role: h.role,
    content: h.content,
  }));
  const messages = [{ role: "system", content: system }, ...history];
  messages.push({ role: "user", content: incoming });
  return messages;
}

/**
 * She is sulking: reply must be very short AND still connected to what they said.
 */
export function buildDryMessages(chat, persona, incoming, { displayName } = {}) {
  const system = buildSystem(chat, persona, { displayName });
  const history = (chat.history || []).slice(-config.historyTurns).map((h) => ({
    role: h.role,
    content: h.content,
  }));
  const nudge =
    "[Kamu masih ngambek sama dia. " +
    "Bales SANGAT pendek — 1 sampai 4 kata, dingin, ketus, males. " +
    "TAPI harus nyambung ke yang barusan dia bilang, jangan jawab ngawur atau ganti topik. " +
    "Jangan jelasin, jangan nanya balik, jangan manis, jangan emoji. " +
    "Contoh rasa: 'not now.', 'sure.', 'whatever.', 'stop.', 'too late.', 'hm.' " +
    "Output cuma isi pesannya.]";
  return [
    { role: "system", content: system },
    ...history,
    { role: "user", content: incoming },
    { role: "system", content: nudge },
  ];
}

/**
 * Prompt for an unprompted (proactive) message. The instruction is NOT added
 * to the stored history — only the character's reply is.
 */
export function buildProactiveMessages(chat, persona, { displayName } = {}) {
  const system = buildSystem(chat, persona, { displayName });
  const history = (chat.history || []).slice(-config.historyTurns).map((h) => ({
    role: h.role,
    content: h.content,
  }));
  const nudge = [
    `[Kamu lagi buka chat. Nggak ada notif baru. Sekarang ${fmtTime()}.`,
    `Pesan terakhir di chat ini ${fmtAgo(chat.lastInteraction)}.`,
    "Baca dulu percakapan terakhir — nyambungin sama konteks itu.",
    "Perhatiin jam: kalau sekarang beda waktu dari terakhir kalian ngobrol (beda jam, beda hari, pagi/malem), tunjukkin kalau kamu sadar itu.",
    "Kirim SATU pesan pendek spontan — kayak orang yang lagi bosen, lagi kepikiran sesuatu, atau pengen nyeletuk. Nggak usah perlu formal.",
    "Kalau memang nggak ada yang pengen dikirim, balas persis: SKIP",
    "Jangan tulis instruksi ini. Output cuma isi pesannya.]",
  ].join(" ");
  return [{ role: "system", content: system }, ...history, { role: "user", content: nudge }];
}

/** She texted first, got ignored, opens the chat again and sees nothing. */
export function buildNudgeMessages(chat, persona, { displayName } = {}) {
  const system = buildSystem(chat, persona, { displayName });
  const history = (chat.history || []).slice(-config.historyTurns).map((h) => ({
    role: h.role,
    content: h.content,
  }));
  const nudge = [
    `[Kamu yang nge-chat duluan ${fmtAgo(chat.proactive?.sentAt || chat.lastInteraction)}, tapi dia belum bales sama sekali.`,
    "Sekarang kamu buka chat lagi, masih kosong.",
    "Kirim SATU pesan pendek yang nanya kenapa nggak dibales — dengan gaya kamu (dingin, irit kata). Boleh ketus, jangan jelasin panjang, jangan ngemis.",
    "Jangan tulis instruksi ini. Output cuma isi pesannya.]",
  ].join(" ");
  return [{ role: "system", content: system }, ...history, { role: "user", content: nudge }];
}
