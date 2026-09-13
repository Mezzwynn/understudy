/**
 * traits.mjs — her sense of humour and what she is actually interested in.
 *
 * These belong to the character (not to a contact), so they live next to the card:
 * personas/<slug>.traits.json
 *
 *   humour    how she jokes, how often, what she will not joke about
 *   interest  how curious she is, what lights her up, what bores her
 *
 * Both can be written by hand (dashboard, agent) or generated from the card and
 * the backstory, and both feed the prompt as behaviour rather than as a mood.
 */
import fs from "node:fs";
import path from "node:path";
import { PERSONA_DIR, config, log } from "./config.mjs";
import { chat as llmChat } from "./llm.mjs";
import { languageDirective } from "./lang.mjs";

const EMPTY = {
  slug: "",
  humor: { on: true, style: "", chance: 0.35, dark: false, avoid: [], examples: [] },
  interest: { on: true, level: 0.6, topics: [], bored: [], curious: true },
  learned: [],
  generatedAt: 0,
  source: "",
};

const LIST_MAX = 10;

function fileFor(slug) {
  return path.join(PERSONA_DIR, `${String(slug || "character").replace(/[^\w.-]/g, "")}.traits.json`);
}

function cleanList(list, max = LIST_MAX) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const t = String(raw ?? "").trim().slice(0, 60);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

export function loadTraits(slug) {
  const f = fileFor(slug);
  if (!fs.existsSync(f)) return { ...EMPTY, slug };
  try {
    const t = JSON.parse(fs.readFileSync(f, "utf8"));
    return {
      ...EMPTY,
      ...t,
      humor: { ...EMPTY.humor, ...(t.humor || {}), avoid: cleanList(t.humor?.avoid), examples: cleanList(t.humor?.examples, 6) },
      interest: { ...EMPTY.interest, ...(t.interest || {}), topics: cleanList(t.interest?.topics), bored: cleanList(t.interest?.bored) },
      learned: cleanList(t.learned),
    };
  } catch {
    return { ...EMPTY, slug };
  }
}

export function saveTraits(slug, traits) {
  const clean = {
    slug,
    humor: {
      on: traits?.humor?.on !== false,
      style: String(traits?.humor?.style || "").slice(0, 240),
      chance: Math.max(0, Math.min(1, Number(traits?.humor?.chance ?? 0.35))),
      dark: traits?.humor?.dark === true,
      avoid: cleanList(traits?.humor?.avoid),
      examples: cleanList(traits?.humor?.examples, 6),
    },
    interest: {
      on: traits?.interest?.on !== false,
      level: Math.max(0, Math.min(1, Number(traits?.interest?.level ?? 0.6))),
      topics: cleanList(traits?.interest?.topics),
      bored: cleanList(traits?.interest?.bored),
      curious: traits?.interest?.curious !== false,
    },
    learned: cleanList(traits?.learned),
    generatedAt: traits?.generatedAt || Date.now(),
    source: String(traits?.source || "manual").slice(0, 40),
  };
  fs.writeFileSync(fileFor(slug), JSON.stringify(clean, null, 2));
  return clean;
}

export function traitsForChat(chat) {
  return loadTraits(chat?.persona || config.persona);
}

/** A topic the conversation showed she actually enjoys — kept, capped, no dupes. */
export function learnTopics(slug, topics) {
  const t = loadTraits(slug);
  const incoming = cleanList(topics, 6).filter((x) => !t.interest.topics.some((y) => y.toLowerCase() === x.toLowerCase()));
  if (!incoming.length) return t;
  const next = saveTraits(slug, { ...t, learned: [...t.learned, ...incoming] });
  log(`traits ${slug}: learned interests ${incoming.join(", ")}`);
  return next;
}

/* ------------------------------- generation ------------------------------ */

const SYSTEM = `You describe two traits of a roleplay character so she can be played consistently: her sense of humour and what she is genuinely interested in.

Return ONLY JSON:
{"humor":{"style":"...","chance":0.35,"dark":false,"avoid":["..."],"examples":["...","..."]},
 "interest":{"level":0.6,"topics":["...","..."],"bored":["..."],"curious":true}}

Rules:
- humor.style: 4-12 words describing HOW she jokes (dry, deadpan, teasing, absurd, wordplay, self-deprecating...). Match the character: a cold person does not tell cheerful jokes.
- humor.chance: 0-1, how often a reply contains a joke or a tease. Keep it believable: 0.15-0.45 for most characters, lower for a very serious one.
- humor.dark: true only if the character would actually go there.
- humor.avoid: 2-4 things she would never joke about (the other person's family, their job, their body...).
- humor.examples: 2-4 SHORT lines that sound like her — they are used as a flavour reference, not to be copied.
- interest.level: 0-1, how curious she is about the other person's life (what they do, how they feel).
- interest.topics: 3-6 concrete things she lights up about (hers, from the card and backstory).
- interest.bored: 2-4 things that make her switch off.
- interest.curious: does she ask questions, or mostly react?
- LANGUAGE: prose in the character's language; keep every item under 10 words.`;

export async function generateTraits(persona, world = null, { force = false } = {}) {
  const slug = persona?.slug || config.persona;
  const current = loadTraits(slug);
  if (!force && (current.humor.style || current.interest.topics.length)) return current;

  const user = [
    `CHARACTER CARD:\n${String(persona?.card || "").slice(0, 2800)}`,
    `LANGUAGE: ${languageDirective(persona?.language) || "match the card"}`,
    world?.backstory ? `BACKSTORY:\n${String(world.backstory).slice(0, 1200)}` : "",
    world?.cast?.length ? `PEOPLE AROUND HER: ${world.cast.map((c) => `${c.name} (${c.relation})`).join(", ")}` : "",
    current.interest.topics.length ? `ALREADY KNOWN INTERESTS: ${current.interest.topics.join(", ")}` : "",
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
      { json: true, temperature: 0.9, maxTokens: 1200 },
    );
  } catch (err) {
    log(`traits generation failed: ${err.message}`);
    return current;
  }

  const s = out.indexOf("{");
  const e = out.lastIndexOf("}");
  let parsed;
  try {
    parsed = JSON.parse(out.slice(s, e + 1));
  } catch {
    log("traits generation returned junk");
    return current;
  }

  const saved = saveTraits(slug, {
    humor: parsed.humor,
    interest: parsed.interest,
    learned: current.learned,
    generatedAt: Date.now(),
    source: "generated",
  });
  log(`traits ${slug}: humour "${saved.humor.style}" (${Math.round(saved.humor.chance * 100)}%), interests ${saved.interest.topics.length}`);
  return saved;
}

/* --------------------------------- prompt -------------------------------- */

export function humorPromptBlock(traits) {
  const h = traits?.humor;
  if (!h?.on) return "";
  const lines = [
    "## Humor kamu",
    h.style ? `Gaya humor kamu: ${h.style}.` : "",
    `Kira-kira ${Math.round(h.chance * 100)}% balasan kamu ada ledekan, sindiran halus, atau komentar lucu kering. Bukan tiap pesan.`,
    h.dark ? "Humor gelap boleh, tapi tetap tahu batas." : "Jangan humor gelap atau kasar.",
    h.examples?.length ? `Contoh rasa (jangan tiru isinya): ${h.examples.map((x) => `"${x}"`).join(" / ")}` : "",
    h.avoid?.length ? `JANGAN bercanda soal: ${h.avoid.join(", ")}.` : "",
    "Kalau dia lagi sedih atau serius, humor kamu mati dulu. Jangan lucu di saat yang salah.",
  ];
  return lines.filter(Boolean).join("\n");
}

export function interestPromptBlock(traits) {
  const i = traits?.interest;
  if (!i?.on) return "";
  const pct = Math.round(i.level * 100);
  const lines = [
    "## Ketertarikan kamu",
    `Kadar penasaran kamu ke dia: ${pct}%. ${
      pct >= 70 ? "Kamu suka nanya balik dan ngulik hidupnya." : pct >= 40 ? "Kadang nanya, tapi nggak ngulik." : "Kamu nggak banyak nanya. Dia yang harus menarik perhatianmu."
    }`,
    i.curious ? "" : "Kamu lebih banyak bereaksi daripada nanya.",
    i.topics?.length ? `Yang bikin kamu tertarik: ${i.topics.join(", ")}. Kalau obrolan ke situ, kamu jadi lebih hidup — lebih panjang, lebih banyak reaksi.` : "",
    i.bored?.length ? `Yang bikin kamu bosen: ${i.bored.join(", ")}. Kalau dia ngajak ngobrol soal itu, jawabanmu pendek dan datar.` : "",
    "Ketertarikan itu nggak boleh bohong: kalau dia cerita sesuatu yang penting buat dia, kamu dengerin walau topiknya bukan favoritmu.",
  ];
  return lines.filter(Boolean).join("\n");
}

/* --------------------------- topic sensitivity --------------------------- */

const STOP = new Set([
  "yang","dan","di","ke","aku","kamu","dia","itu","ini","suka","tidak","jangan","the","a","an","of","to","is","it",
  "my","your","his","her","about","with","for","on","in","and","or","soal","tentang","lagi","udah","sudah",
]);

function words(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** A few cross-language bridges, so an English topic still catches Indonesian chat. */
const SYNONYMS = {
  kucing: ["cat", "cats", "kitten"],
  cat: ["kucing", "cats"],
  lagu: ["music", "song", "playlist", "musik"],
  musik: ["music", "song", "lagu"],
  music: ["lagu", "musik", "song"],
  kopi: ["coffee"],
  coffee: ["kopi"],
  kerja: ["work", "job", "kerjaan"],
  kerjaan: ["work", "job", "kerja"],
  work: ["kerja", "kerjaan"],
  film: ["movie", "movies"],
  movie: ["film"],
  buku: ["book", "books", "baca"],
  book: ["buku", "baca"],
  gosip: ["gossip"],
  gossip: ["gosip"],
  desain: ["design"],
  design: ["desain"],
  masak: ["cook", "cooking", "masakan"],
  cooking: ["masak", "masakan"],
  hujan: ["rain", "rainy"],
  tidur: ["sleep", "sleeping"],
  fashion: ["fashion", "outfit", "baju"],
  playlist: ["playlist", "lagu", "musik"],
  campaign: ["campaign", "klien", "client"],
  klien: ["client", "campaign"],
};

/** Does the message touch one of a list of topics? Returns the matches. */
function matches(list, text) {
  const said = new Set(words(text));
  const hits = [];
  for (const entry of list || []) {
    const need = words(entry);
    if (!need.length) continue;
    let hit = 0;
    for (const w of need) {
      if (said.has(w)) {
        hit++;
        continue;
      }
      const alts = SYNONYMS[w] || [];
      if (alts.some((a) => said.has(a))) hit++;
    }
    // any matched word counts, including through a synonym: the topics list is
    // written by hand, so a hit on "cat" for "kucing oren" is the point. Stopwords
    // are already removed above, which keeps the false positives down.
    if (hit >= 1) hits.push(entry);
  }
  return hits;
}

/**
 * What this message lands on: her favourite subjects (she lights up) and the ones
 * that bore her (she answers flat). Also used for initiative: a favourite topic is
 * worth an extra message of her own.
 */
export function topicReaction(traits, incoming) {
  const i = traits?.interest;
  if (!i?.on) return { hot: [], bored: [] };
  return { hot: matches(i.topics, incoming), bored: matches(i.bored, incoming) };
}

/**
 * Things she must avoid — from her memory boundaries. Loud when the other person
 * walks straight into one, so she can react the way she would react.
 */
export function touchedBoundaries(chat, incoming) {
  const list = chat?.memory?.boundaries || [];
  return matches(list, incoming);
}
