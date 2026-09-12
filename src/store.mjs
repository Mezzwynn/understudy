import fs from "node:fs";
import path from "node:path";
import { CHATS_DIR, DATA_DIR, STATE_FILE } from "./config.mjs";

const safe = (jid) => jid.replace(/[^a-zA-Z0-9._@+-]/g, "_");

function fileFor(jid) {
  return path.join(CHATS_DIR, `${safe(jid)}.json`);
}

export function defaultChat(jid) {
  const now = Date.now();
  return {
    jid,
    createdAt: now,
    // Full character (warm, media, proactive) or reserved stranger treatment?
    // New contacts start untrusted. Trusted numbers come from TRUSTED= in .env.
    trusted: false,
    lastInteraction: now,
    lastReplyAt: 0,
    lastProactiveAt: 0,
    coldUntil: 0,
    // proactive / sulking state machine
    proactive: { state: "idle", sentAt: 0, nudgedAt: 0, drySince: 0, dryCount: 0, lastDry: "", lastSlot: "" },
    // promises to follow up later: "nanti aku kabarin kalau udah selesai"
    commitments: [],
    // things she told THEM to do (eat, sleep, workout) — she checks up on those
  instructions: [],
  // temporary soft window: she melts for a while, then pulls back
  softUntil: 0,
  // the only things that cross the per-contact wall (links.mjs)
  crossNotes: [],
  vouches: [],
    // who this person is (per contact, never shared)
    profile: {
      name: "", // WhatsApp display name
      nick: "", // what the character calls them
      number: "",
      since: now,
      notes: "",
    },
    // optional per-contact character override (persona slug)
    persona: "",
    history: [],
    memory: {
      summary: "",
      relationship: "",
      facts: [],
      jokes: [],
      plans: [],
      boundaries: [],
    },
    mood: null, // initialised from mood.mjs baseline
    stats: { inbound: 0, outbound: 0 },
  };
}

/** Is this contact allowed the full character? */
export function isTrusted(chat) {
  return chat?.trusted === true;
}

export function loadChat(jid) {
  const f = fileFor(jid);
  if (!fs.existsSync(f)) return defaultChat(jid);
  try {
    const parsed = JSON.parse(fs.readFileSync(f, "utf8"));
    const base = defaultChat(jid);
    return {
      ...base,
      ...parsed,
      profile: { ...base.profile, ...(parsed.profile || {}) },
      proactive: { ...base.proactive, ...(parsed.proactive || {}) },
      commitments: Array.isArray(parsed.commitments) ? parsed.commitments : [],
      instructions: Array.isArray(parsed.instructions) ? parsed.instructions : [],
      memory: { ...base.memory, ...(parsed.memory || {}) },
    };
  } catch {
    return defaultChat(jid);
  }
}

export function saveChat(chat) {
  fs.mkdirSync(CHATS_DIR, { recursive: true });
  fs.writeFileSync(fileFor(chat.jid), JSON.stringify(chat, null, 2));
}

export function listChats() {  if (!fs.existsSync(CHATS_DIR)) return [];
  return fs
    .readdirSync(CHATS_DIR)
    // skip the semantic-memory sidecar files (<jid>.memory.json)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".memory.json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(CHATS_DIR, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/* ---------- global state (active persona etc.) ---------- */

export function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function saveState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/** Accumulate LLM token usage per provider, per day (for `rp status`). */export function recordUsage(label, tokensIn, tokensOut) {
  if (!tokensIn && !tokensOut) return;
  try {
    const st = loadState();
    const day = new Date().toISOString().slice(0, 10);
    if (st.usageDay !== day) {
      st.usageDay = day;
      st.usage = {};
    }
    st.usage = st.usage || {};
    const u = st.usage[label] || { calls: 0, in: 0, out: 0 };
    u.calls += 1;
    u.in += tokensIn || 0;
    u.out += tokensOut || 0;
    st.usage[label] = u;
    saveState(st);
  } catch {
    /* never break a reply because of stats */
  }
}

/* ------------------- semantic memory index (per contact) ------------------- */

import { cosine } from "./embed.mjs";

function memoryFile(jid) {
  return path.join(CHATS_DIR, `${safe(jid)}.memory.json`);
}

export function loadMemoryIndex(jid) {
  try {
    const j = JSON.parse(fs.readFileSync(memoryFile(jid), "utf8"));
    return Array.isArray(j.entries) ? j : { entries: [] };
  } catch {
    return { entries: [] };
  }
}

export function saveMemoryIndex(jid, idx) {
  try {
    fs.mkdirSync(CHATS_DIR, { recursive: true });
    fs.writeFileSync(memoryFile(jid), JSON.stringify(idx));
  } catch {
    /* ignore */
  }
}

/** Store a line of conversation in the semantic index. */
export function addMemory(jid, text, vec, { max = 400 } = {}) {
  const t = String(text || "").trim();
  if (!t || !vec) return;
  const idx = loadMemoryIndex(jid);
  if (!idx.entries.some((e) => e.text === t)) idx.entries.push({ text: t, vec, ts: Date.now() });
  if (idx.entries.length > max) idx.entries = idx.entries.slice(-max);
  saveMemoryIndex(jid, idx);
}

/** Top-K most similar past lines for this contact. */
export function recallMemory(jid, vec, { topK = 4, minScore = 0.6, exclude = "" } = {}) {
  if (!vec) return [];
  const idx = loadMemoryIndex(jid);
  if (!idx.entries.length) return [];
  return idx.entries
    .filter((e) => e.text !== exclude)
    .map((e) => ({ text: e.text, ts: e.ts, score: cosine(vec, e.vec) }))
    .filter((e) => e.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
