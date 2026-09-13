/**
 * week.mjs — what her week looked like.
 *
 * Built from data she already has (routine days, highlights, life events), so it
 * costs nothing to produce. Used in two places: a card in the dashboard, and a
 * couple of lines in the prompt so she can talk about her own week the way a person
 * does — "this week was mostly client stuff" — instead of only ever reacting.
 */
import { config, log } from "./config.mjs";
import { loadRoutine } from "./routine.mjs";
import { listEvents } from "./events.mjs";
import { listChats } from "./store.mjs";

const DAY = 24 * 3600 * 1000;

export function buildWeekDigest(slug = config.persona, { days = 7, now = Date.now() } = {}) {
  const routine = loadRoutine(slug) || {};
  const since = now - days * DAY;

  const past = (routine.history || []).filter((d) => Date.parse(`${d.date}T00:00:00`) >= since);
  const today = routine.date ? [{ date: routine.date, weekday: routine.weekday, theme: routine.theme, moments: routine.moments || [] }] : [];

  const highlights = (routine.highlights || [])
    .filter((h) => Date.parse(`${h.date}T00:00:00`) >= since)
    .sort((a, b) => (b.intensity || 0) - (a.intensity || 0));

  const events = listEvents().filter((e) => e.at >= since);

  const themes = [...past, ...today]
    .map((d) => ({ date: d.date, weekday: d.weekday || "", theme: d.theme || "" }))
    .filter((d) => d.theme);

  return {
    from: new Date(since).toISOString().slice(0, 10),
    to: new Date(now).toISOString().slice(0, 10),
    days: themes.length,
    themes,
    highlights: highlights.slice(0, 6).map((h) => ({ date: h.date, kind: h.kind, what: h.what, intensity: h.intensity })),
    events: events.slice(-6).map((e) => ({ at: e.at, kind: e.kind, what: e.what })),
    contacts: listChats().filter((c) => c.trusted === true).length,
    busy: highlights.filter((h) => h.kind === "annoyed" || h.kind === "tired").length,
  };
}

/** Two lines she can drop into a conversation about her own week. */
export function weekPromptBlock(slug = config.persona) {
  if (!config.weekDigest) return "";
  const d = buildWeekDigest(slug);
  if (!d.highlights.length && !d.themes.length) return "";
  const lines = [];
  if (d.themes.length) {
    const t = d.themes[d.themes.length - 1];
    lines.push(`Beberapa hari terakhir: ${d.themes.slice(-3).map((x) => `"${x.theme}"`).join(" · ")}.`);
  }
  const top = d.highlights.slice(0, 2);
  if (top.length) lines.push(`Yang paling kamu inget: ${top.map((h) => h.what).join(" / ")}.`);
  return [
    "## Minggu kamu (konteks pribadi, jangan dilaporin)",
    ...lines,
    "Boleh disinggung sesekali kalau nyambung — satu hal aja. Jangan nyeritain semuanya.",
  ].join("\n");
}

/** A short human-readable digest, for the notification and the dashboard. */
export function weekText(slug = config.persona) {
  const d = buildWeekDigest(slug);
  const parts = [];
  if (d.themes.length) parts.push(`${d.days} hari tercatat, tema terakhir: ${d.themes[d.themes.length - 1].theme}`);
  if (d.highlights.length) parts.push(`momen terkuat: ${d.highlights[0].what}`);
  if (d.events.length) parts.push(`${d.events.length} kejadian nyata`);
  return parts.join(" · ") || "no recorded life this week";
}

/** Once a week, tell the owner what she has been up to. */
export function weekNotifyDue(state, now = Date.now()) {
  if (!config.weekDigest) return false;
  const last = state.weekNotifiedAt || 0;
  if (now - last < 6 * DAY) return false;
  const d = new Date(now);
  return d.getDay() === 0 && d.getHours() >= 19; // Sunday evening
}

export function markWeekNotified(state, now = Date.now()) {
  state.weekNotifiedAt = now;
  log(`week digest sent: ${weekText()}`);
  return state;
}
