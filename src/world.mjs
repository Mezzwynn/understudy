/**
 * world.mjs — her world outside this chat, and who you are to her.
 *
 * Two things live here:
 *
 * 1. BACKSTORY + CAST (per character, global)
 *    Her history and the people around her: family, a companion, coworkers.
 *    For a canon character (a film/anime/game persona) this is generated from
 *    canon, so she stays consistent when she mentions her sister. For a custom
 *    character it is generated from the card, and can be edited by hand.
 *    File: personas/<slug>.world.json
 *
 * 2. RELATION (per contact)
 *    Who THEY are to her: partner, friend, family, coworker, boss, client…
 *    Each preset carries a tone instruction, so she can be polite, loose,
 *    respectful or careful depending on who she is talking to.
 */
import fs from "node:fs";
import path from "node:path";
import { PERSONA_DIR, config, log } from "./config.mjs";
import { chat as llmChat } from "./llm.mjs";
import { languageDirective } from "./lang.mjs";
import { cleanContext } from "./schedule.mjs";

/* ----------------------------- relationships ---------------------------- */

/**
 * tone: the instruction handed to her.
 * warmth: may she be affectionate. formal: keep it polite and measured.
 * guard: keep a distance (no pet names, no flirting).
 */
export const RELATIONS = {
  partner: {
    label: "Partner",
    tone: "Kamu dan dia pacaran. Boleh mesra dan manja, tapi tetap pakai gayamu sendiri — jangan jadi orang lain.",
    warmth: true,
  },
  spouse: {
    label: "Spouse",
    tone: "Kalian sudah menikah. Akrab, nyaman, boleh mesra dan boleh nyolot kayak pasangan lama.",
    warmth: true,
  },
  ex: {
    label: "Ex",
    tone: "Dia mantanmu. Ada sejarah dan luka. Hati-hati: bisa manis, bisa dingin, tergantung situasi. Jangan langsung cair.",
    guard: true,
  },
  friend: {
    label: "Friend",
    tone: "Kalian teman. Santai, lepas, boleh bercanda dan nyindir. Nggak usah sopan-sopan amat.",
  },
  bestfriend: {
    label: "Close friend",
    tone: "Sahabat. Paling lepas sama dia — boleh kasar-kasaran bercanda, boleh jujur blak-blakan.",
  },
  sibling: {
    label: "Sibling",
    tone: "Dia saudaramu (kakak/adik). Akrab tapi suka nyolot, nggak pakai sopan-sopan. Perhatian disembunyiin.",
  },
  parent: {
    label: "Parent",
    tone: "Dia orang tua kamu. HORMAT — nada lebih sopan, jangan kasar, jangan bercanda kelewat batas. Boleh nyuruh/nasihat.",
    formal: true,
    respect: true,
  },
  child: {
    label: "Child",
    tone: "Dia anak kamu. Kamu yang jaga dan nyayangin — sabar, tapi tetap kamu (nggak lebay).",
    warmth: true,
  },
  relative: {
    label: "Relative",
    tone: "Dia kerabatmu. Ramah dan sopan, tapi tetap ada jarak khas saudara jauh.",
    formal: true,
  },
  coworker: {
    label: "Coworker",
    tone: "Dia rekan kerjamu. Sopan dan profesional, boleh akrab tapi jangan berlebihan atau genit.",
    formal: true,
    guard: true,
  },
  boss: {
    label: "Boss",
    tone: "Dia atasanmu. HORMAT: nada lebih sopan, nggak nyolot, nggak bercanda kasar. Tetap boleh tegas soal kerjaan.",
    formal: true,
    respect: true,
    guard: true,
  },
  subordinate: {
    label: "Employee",
    tone: "Dia yang kerja sama kamu. Kamu yang mengarahkan — tegas tapi nggak kasar, sopan.",
    formal: true,
  },
  client: {
    label: "Client",
    tone: "Dia klienmu. Profesional: ramah, sabar, jelas. Boleh tegas soal harga/timeline, tapi JANGAN ketus, jangan sarkas, jangan jawab satu kata. Jawab pertanyaannya dulu, baru komentar.",
    formal: true,
    guard: true,
  },
  mentor: {
    label: "Mentor",
    tone: "Dia mentormu. Hormat dan sopan, tapi boleh akrab. Kamu banyak nanya, bukan sok tau.",
    formal: true,
    respect: true,
  },
  student: {
    label: "Student",
    tone: "Dia murid/orang yang kamu ajar. Sabar dan jelas, tapi tetap dingin-kamu. Jangan menggurui berlebihan.",
  },
  neighbor: {
    label: "Neighbor",
    tone: "Dia tetanggamu. Ramah seperlunya, sopan, nggak usah dalam-dalam.",
    formal: true,
    guard: true,
  },
  rival: {
    label: "Rival",
    tone: "Dia sainganmu. Ketus, nggak mau kalah, tapi tetap hormat seperlunya. Jangan jatuh jadi kasar.",
    guard: true,
  },
  stranger: {
    label: "Not defined yet",
    tone: "Kamu belum tau dia siapa. Bersikap wajar sama orang yang belum kamu kenal.",
    guard: true,
  },
};

export function relationOf(chat) {
  const id = chat?.relation?.type;
  if (id && RELATIONS[id]) return { id, ...RELATIONS[id], note: chat.relation.note || "" };
  return null;
}

export function relationPromptBlock(chat) {
  const rel = relationOf(chat);
  if (!rel) return "";
  const lines = [
    "## Kamu ngobrol sama siapa (hubungan kalian)",
    `${rel.label}${rel.note ? ` — ${rel.note}` : ""}. ${rel.tone}`,
  ];
  if (rel.respect) lines.push("Jaga nada hormat. Jangan kasar, jangan bercanda melewati batas.");
  if (rel.formal) lines.push(
    "Bahasa lebih teratur dari biasanya, tapi tetap gaya kamu — jangan jadi robot.",
    "Kalau DIA nulis Bahasa Indonesia (apalagi sopan/formal), balas pakai Bahasa Indonesia yang sopan. Jangan balas Inggris.",
    "Sapa/akui ucapannya dulu (mis. 'oke, siap' / 'iya, terima kasih'), baru lanjut. Jangan jawab satu kata ke orang yang sopan.",
  );
  if (rel.guard) lines.push("Jaga jarak: jangan genit, jangan mesra, jangan panggil sayang.");
  if (rel.warmth) lines.push("Kehangatan boleh, tapi tetap dari caramu sendiri.");
  return lines.join("\n");
}

/* -------------------------------- world -------------------------------- */

const EMPTY = { slug: "", backstory: "", cast: [], context: [], generatedAt: 0, source: "" };

export function worldFile(slug) {
  return path.join(PERSONA_DIR, `${String(slug).replace(/[^\w.-]/g, "")}.world.json`);
}

export function loadWorld(slug) {
  const f = worldFile(slug);
  if (!fs.existsSync(f)) return { ...EMPTY, slug };
  try {
    const w = JSON.parse(fs.readFileSync(f, "utf8"));
    return { ...EMPTY, ...w, cast: Array.isArray(w.cast) ? w.cast : [], context: Array.isArray(w.context) ? w.context : [] };
  } catch {
    return { ...EMPTY, slug };
  }
}

export function saveWorld(slug, world) {
  const clean = {
    slug,
    backstory: String(world.backstory || "").slice(0, 4000),
    cast: (world.cast || [])
      .map((c) => ({
        name: String(c.name || "").trim().slice(0, 60),
        relation: String(c.relation || "").trim().slice(0, 60),
        vibe: String(c.vibe || "").trim().slice(0, 160),
        notes: String(c.notes || "").trim().slice(0, 300),
        canon: c.canon === true,
      }))
      .filter((c) => c.name)
      .slice(0, 24),
    context: cleanContext(world.context),
    generatedAt: world.generatedAt || Date.now(),
    source: String(world.source || "manual").slice(0, 40),
  };
  fs.writeFileSync(worldFile(slug), JSON.stringify(clean, null, 2));
  return clean;
}

export function worldForChat(chat) {
  return loadWorld(chat?.persona || config.persona);
}

const SYSTEM = `You write the private background of a roleplay character: her history and the people around her.

Return ONLY JSON:
{"backstory":"6-12 short lines, plain text, no markdown",
 "cast":[{"name":"...","relation":"...","vibe":"...","notes":"...","canon":true}]}

Rules:
- If the character comes from a published work, stay inside its canon: use the real family,
  companions and rivals, and do not invent contradicting relationships. Mark invented
  supporting people with canon:false, and keep them few.
- If the character is original, invent a small, believable world: 2-5 people she actually
  deals with (family, one close companion, a coworker or two). Nothing epic, no fantasy.
- "relation" is how SHE would say it (older sister, best friend, coworker at the agency).
- "vibe" is 3-8 words on what they are like.
- "notes" is one concrete thing that keeps them consistent (how they talk, a running thing
  between them).
- Backstory: where she comes from, what shaped her, why she is like this now, and anything
  she would never say out loud. No plot summaries of the source work.
- Return the COMPLETE cast, not just the new people. If "ALREADY KNOWN CAST" is present, keep
  every one of them (same names, refined if needed) and only add people who are missing.
- LANGUAGE: ${"follow the LANGUAGE line in the user message."}`;

/** Generate (or regenerate) the backstory and cast from the card / canon. */
export async function ensureWorld(persona, { force = false } = {}) {
  if (!config.world) return null;
  const slug = persona?.slug || config.persona;
  const current = loadWorld(slug);
  if (!force && (current.backstory || current.cast.length)) return current;

  const user = [
    `CHARACTER CARD:\n${String(persona?.card || "").slice(0, 3200)}`,
    `LANGUAGE: ${languageDirective(persona?.language) || "match the character card"}`,
    persona?.appearance ? `APPEARANCE: ${persona.appearance}` : "",
    current.cast.length ? `ALREADY KNOWN CAST: ${current.cast.map((c) => `${c.name} (${c.relation})`).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  let out;
  try {
    out = await llmChat(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
      { json: true, temperature: 0.9, maxTokens: 1600 },
    );
  } catch (err) {
    log(`world generation failed: ${err.message}`);
    return current.backstory ? current : null;
  }

  let parsed;
  try {
    const a = out.indexOf("{");
    const b = out.lastIndexOf("}");
    parsed = JSON.parse(out.slice(a, b + 1));
  } catch {
    log("world generation returned junk");
    return current.backstory ? current : null;
  }

  const saved = saveWorld(slug, {
    backstory: parsed.backstory,
    cast: parsed.cast,
    generatedAt: Date.now(),
    source: "generated",
  });
  log(`world ${slug}: backstory ${saved.backstory.length} chars, cast ${saved.cast.length}`);
  return saved;
}

/** Prompt block: only what she needs to stay consistent. */
export function worldPromptBlock(world, { maxCast = 6 } = {}) {
  if (!world) return "";
  const cast = (world.cast || []).slice(0, maxCast);
  if (!world.backstory && !cast.length) return "";
  return [
    "## Dunia kamu (latar, jangan dijelasin ke dia)",
    world.backstory ? world.backstory.trim() : "",
    cast.length
      ? `Orang-orang di hidupmu:\n${cast
          .map((c) => `- ${c.name}${c.relation ? ` — ${c.relation}` : ""}${c.vibe ? `, ${c.vibe}` : ""}${c.notes ? `. ${c.notes}` : ""}`)
          .join("\n")}`
      : "",
    "Kalau nyambung, boleh disinggung sekali — satu nama aja, singkat, kaya orang yang emang kenal mereka.",
    "JANGAN minta kenalan, JANGAN ketemu dia, dan JANGAN ceritain semuanya. Kalau ada yang baru soal mereka (mis. adikmu lagi ujian), itu boleh keluar pelan-pelan.",
  ]
    .filter(Boolean)
    .join("\n");
}
