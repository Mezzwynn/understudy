/**
 * mood.mjs — live emotional state, per chat.
 *
 * Six dimensions:
 *   valence    -1..1  (unhappy .. happy)
 *   energy      0..1  (drained .. wired)
 *   arousal     0..1  (calm .. wound up)
 *   affection   0..1  (distant .. attached, toward this person)
 *   patience    0..1  (short fuse .. endless)
 *   playfulness 0..1  (serious .. teasing)
 */

export const BASELINE = {
  valence: 0.15,
  energy: 0.6,
  arousal: 0.45,
  affection: 0.5,
  patience: 0.6,
  playfulness: 0.5,
};

export const KEYS = Object.keys(BASELINE);

const clamp = (k, v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return BASELINE[k];
  return k === "valence" ? Math.max(-1, Math.min(1, n)) : Math.max(0, Math.min(1, n));
};

export function newMood() {
  return { ...BASELINE, updatedAt: Date.now() };
}

export function normalize(mood) {
  const m = newMood();
  for (const k of KEYS) if (mood && Number.isFinite(Number(mood[k]))) m[k] = clamp(k, mood[k]);
  m.updatedAt = mood?.updatedAt || Date.now();
  return m;
}

/** Circadian / time-of-day offset. */
function circadian(date = new Date()) {
  const h = date.getHours();
  const d = { valence: 0, energy: 0, arousal: 0, affection: 0, patience: 0, playfulness: 0 };
  if (h >= 0 && h < 5) {
    d.energy -= 0.18;
    d.patience -= 0.1;
    d.valence -= 0.06;
    d.playfulness -= 0.05;
  } else if (h < 9) {
    d.energy -= 0.12;
    d.valence += 0.02;
  } else if (h < 12) {
    d.energy += 0.1;
    d.arousal += 0.05;
  } else if (h < 15) {
    d.valence += 0.05;
    d.energy -= 0.05;
  } else if (h < 18) {
    d.energy += 0.02;
  } else if (h < 22) {
    d.playfulness += 0.08;
    d.affection += 0.04;
    d.energy += 0.03;
  } else {
    d.energy -= 0.08;
    d.playfulness -= 0.03;
    d.valence -= 0.02;
  }
  return d;
}

/**
 * Drift the mood based on how long it has been since the last interaction.
 * Long silences pull energy/affection down a bit; time of day shifts the target.
 */
export function drift(mood, lastInteraction = Date.now(), now = Date.now()) {
  const m = normalize(mood);
  const mins = Math.max(0, (now - lastInteraction) / 60000);
  const c = circadian(new Date(now));

  // silence effect: for every 6h of no contact, a slight cooling
  const silence = Math.min(0.25, (mins / 360) * 0.12);

  // Move toward the target proportionally to elapsed time, so rapid
  // back-and-forth does not wash out the mood.
  const alpha = Math.min(0.25, 0.01 + (mins / 60) * 0.2);

  for (const k of KEYS) {
    let target = BASELINE[k] + (c[k] || 0);
    if (k === "affection") target -= silence;
    if (k === "valence") target -= silence * 0.4;
    if (k === "energy") target += 0;
    target = clamp(k, target);
    // gently move toward the target
    m[k] = clamp(k, m[k] + (target - m[k]) * alpha);
  }
  // very long silence also adds a bit of "restless" arousal
  if (mins > 720) m.arousal = clamp("arousal", m.arousal + 0.03);

  return cohere(m);
}

export function applyDeltas(mood, deltas = {}) {
  const m = normalize(mood);
  for (const [k, v] of Object.entries(deltas)) {
    if (!KEYS.includes(k)) continue;
    let d = Number(v || 0);
    // diminishing returns near the extremes: strong feelings stay possible,
    // but repeated pushes cannot pin her at -1 / +1 forever
    if (k === "valence") {
      if (m[k] <= -0.5 && d < 0) d *= 0.45;
      if (m[k] >= 0.6 && d > 0) d *= 0.5;
    } else if (m[k] <= 0.15 && d < 0) d *= 0.6;
    else if (m[k] >= 0.85 && d > 0) d *= 0.6;
    m[k] = clamp(k, m[k] + d);
  }
  return cohere(m);
}

/**
 * Keep the dimensions psychologically plausible — a person cannot be furious
 * and delighted at the same time. Called after every mood change.
 */
/**
 * Strong feelings are possible, but the resting range is less extreme: this
 * keeps -1 / +1 from becoming a permanent state.
 */
export function cohere(input) {
  const m = normalize(input);
  m.valence = Math.max(-0.85, Math.min(0.9, m.valence));
  if (m.valence <= -0.5) m.playfulness = Math.min(m.playfulness, 0.35);
  else if (m.valence <= -0.25) m.playfulness = Math.min(m.playfulness, 0.55);
  if (m.patience <= 0.15) {
    m.affection = Math.min(m.affection, 0.6);
    m.arousal = Math.max(m.arousal, 0.5);
    m.playfulness = Math.min(m.playfulness, 0.45);
  }
  if (m.valence >= 0.4) m.patience = Math.max(m.patience, 0.3);
  if (m.energy <= 0.25) m.playfulness = Math.min(m.playfulness, 0.55);
  m.patience = Math.max(m.patience, 0.03);
  m.updatedAt = Date.now();
  return m;
}

export function label(s) {
  const { valence: v, energy: e, arousal: ar, affection: af, patience: p, playfulness: pl } = s;
  if (v <= -0.4 && ar >= 0.5) return "Angry";
  if (v <= -0.4) return "Cold / bad mood";
  if (p <= 0.35 && v < 0.2) return "Short-tempered";
  if (v < -0.05 && p < 0.42) return "Short-tempered";
  if (af >= 0.75 && pl >= 0.65) return "Clingy & playful";
  if (af >= 0.75 && v >= 0.4) return "Affectionate";
  if (pl >= 0.7 && v >= 0.3) return "Cheerful & teasing";
  if (e <= 0.35 && v < 0.2) return "Drained";
  if (ar >= 0.7 && v >= 0.3) return "Wound up";
  if (v >= 0.45) return "Happy";
  if (v <= -0.05) return "Slightly annoyed";
  return "Neutral";
}

export function tone(s) {
  const out = [];
  if (s.energy <= 0.35) out.push("low energy — short, flat, unhurried replies");
  else if (s.energy >= 0.7) out.push("high energy — quick, expressive, lots of momentum");
  if (s.valence <= -0.25) out.push("bad mood — curt, snappy, easy to set off; do NOT be sweet right now");
  else if (s.valence <= -0.05) out.push("a bit off — drier and shorter than usual");
  else if (s.valence >= 0.45) out.push("good mood — warm and generous");
  if (s.patience <= 0.4) out.push("low patience — little tolerance for small talk or being pushed");
  if (s.playfulness >= 0.7) out.push("very playful — tease, joke, mess with them");
  else if (s.playfulness <= 0.28) out.push("not playful — take things literally/seriously");
  if (s.affection >= 0.72) out.push("affectionate — softer, warmer, more willing to be close");
  else if (s.affection <= 0.28) out.push("distant — guarded, keep some space");
  if (s.arousal >= 0.72) out.push("wound up / restless — intense, impatient or flustered");
  if (!out.length) out.push("calm and even — nothing strong either way");
  return out.join("; ") + ".";
}

export function snapshot(s) {
  const nums = KEYS.map((k) => `${k} ${s[k].toFixed(2)}`).join(" | ");
  return `Mood: ${label(s)}\n${nums}\nHow it shows: ${tone(s)}`;
}

export const NUDGES = {
  sweet: { valence: 0.08, affection: 0.1, playfulness: 0.05 },
  flirty: { valence: 0.08, affection: 0.08, arousal: 0.08, playfulness: 0.06 },
  compliment: { valence: 0.1, affection: 0.06, playfulness: 0.04 },
  joke: { valence: 0.08, playfulness: 0.12, energy: 0.05 },
  apologize: { valence: 0.12, patience: 0.1, affection: 0.05 },
  reconnect: { valence: 0.1, energy: 0.08, affection: 0.05 },
  fight: { valence: -0.22, patience: -0.15, affection: -0.08, arousal: 0.15 },
  rude: { valence: -0.18, patience: -0.12, arousal: 0.12 },
  ignored: { valence: -0.12, patience: -0.08, affection: -0.05 },
  jealous: { valence: -0.12, arousal: 0.12, patience: -0.06 },
  boring: { energy: -0.08, playfulness: -0.08, arousal: -0.05 },
  tired: { energy: -0.15, arousal: -0.08, playfulness: -0.05 },
  excited: { energy: 0.12, arousal: 0.12, valence: 0.08 },
};

/** Heuristic nudge based on what the user said — a gentle baseline in case
 *  the model forgets its control line. */
export function heuristicNudge(text) {
  const t = text.toLowerCase();
  const hits = {};
  const add = (ev, weight = 1) => {
    for (const [k, v] of Object.entries(NUDGES[ev])) hits[k] = (hits[k] || 0) + v * 0.7 * weight;
  };
  if (/(sayang|cinta|kangen|miss you|love you|peluk|cium|manis|tersayang)/.test(t)) add("sweet");
  if (/(jelek|bodoh|goblok|bego|diam|benci|hate you|bacot|nyebelin|menyebalkan)/.test(t)) add("rude");
  if (/(wkwk|haha|lucu|keren|anjir|gila|receh)/.test(t)) add("joke");
  if (/(maaf|sorry|salahku|aku khilaf|aku salah)/.test(t)) add("apologize");
  if (/(sibuk|lagi kerja|nanti ya|ga bisa|gabisa|jangan chat|skip dulu)/.test(t)) add("ignored", 0.6);
  if (/(sama siapa|cewek lain|cowok lain|selingkuh|cemburu|buruan jawab)/.test(t)) add("jealous");
  if (/(kok gitu|gitu doang|bosen|boring|yaudah|terserah)/.test(t)) add("boring", 0.6);
  if (/(ngantuk|capek|cape|jam 2|jam 3|insomnia|ga bisa tidur)/.test(t)) add("tired", 0.5);
  if (/(selamat|akhirnyaa|yes|berhasil|dapet|diterima|libur)/.test(t)) add("excited");
  return hits;
}
