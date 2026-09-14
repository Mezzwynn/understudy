/**
 * persona-io.mjs — export / import / delete characters, so people can share them.
 *
 * A shared character is ONE json file that carries everything that defines it:
 * the card (frontmatter + body) and, optionally, the behaviour settings that
 * were tuned for it. Stickers and chat data are never included.
 *
 * Deleting never really deletes: the file is moved to personas/.trash/ (and the
 * character's routine to data/routine/.trash/), so a wrong click is recoverable.
 */
import fs from "node:fs";
import path from "node:path";
import { PERSONA_DIR, ROOT, config } from "./config.mjs";
import { parsePersonaFrontmatter } from "./prompt.mjs";
import { KNOBS, currentValues } from "../scripts/_settings.mjs";
import { loadWorld, saveWorld, worldFile } from "./world.mjs";

export const BUNDLE_FORMAT = "understudy-character";
export const BUNDLE_VERSION = 1;

const TRASH = path.join(PERSONA_DIR, ".trash");
const ROUTINE_DIR = path.join(ROOT, "data", "routine");
const ROUTINE_TRASH = path.join(ROUTINE_DIR, ".trash");

export function slugify(name) {
  return String(name || "character")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "character";
}

export function personaFile(slug) {
  return path.join(PERSONA_DIR, `${slugify(slug)}.md`);
}

export function listSlugs() {
  if (!fs.existsSync(PERSONA_DIR)) return [];
  return fs
    .readdirSync(PERSONA_DIR)
    .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
    .map((f) => f.replace(/\.md$/, ""));
}

export function readCard(slug) {
  const file = personaFile(slug);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf8");
  return {
    slug: slugify(slug),
    frontmatter: parsePersonaFrontmatter(raw),
    body: raw.replace(/^---[\s\S]*?\n---\s*\n?/, ""),
  };
}

/* -------------------------------- export ------------------------------ */

/**
 * @param {string} slug
 * @param {{withSettings?: boolean, notes?: string}} opts
 */
export function exportPersona(slug, { withSettings = true, notes = "" } = {}) {
  const card = readCard(slug);
  if (!card) throw new Error(`character "${slug}" not found`);
  const values = currentValues();
  const settings = {};
  if (withSettings) {
    for (const k of KNOBS) if (values[k.key] !== undefined) settings[k.key] = values[k.key];
  }
  const world = loadWorld(card.slug);
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    slug: card.slug,
    frontmatter: card.frontmatter,
    body: card.body.trim(),
    settings,
    // her history and the people around her, so a shared character keeps its world
    world: world.backstory || world.cast.length ? { backstory: world.backstory, cast: world.cast } : null,
    notes: String(notes || "").slice(0, 400),
  };
}

/* -------------------------------- import ------------------------------ */

/** Cheap sanity check so junk files fail early with a readable reason. */
export function validateBundle(obj) {
  if (!obj || typeof obj !== "object") return { ok: false, reason: "not a JSON object" };
  if (obj.format !== BUNDLE_FORMAT) {
    return { ok: false, reason: `not an Understudy character file (format: ${JSON.stringify(obj.format ?? null)})` };
  }
  if (Number(obj.version) > BUNDLE_VERSION) {
    return { ok: false, reason: `file is from a newer version (v${obj.version})` };
  }
  const body = String(obj.body || "").trim();
  if (body.length < 80) return { ok: false, reason: "the card body is empty or far too short" };
  const fm = obj.frontmatter && typeof obj.frontmatter === "object" ? obj.frontmatter : {};
  if (!fm.name) return { ok: false, reason: "the card has no name" };
  return { ok: true, body, frontmatter: fm };
}

/**
 * Writes the character to personas/<slug>.md.
 * @returns {{ok:boolean, slug?:string, reason?:string, renamed?:boolean, settingsApplied?:number}}
 */
export function importPersona(obj, { overwrite = false, applySettings = false, setEnvFn = null } = {}) {
  const check = validateBundle(obj);
  if (!check.ok) return check;

  let slug = slugify(obj.slug || check.frontmatter.name);
  let renamed = false;
  if (fs.existsSync(personaFile(slug)) && !overwrite) {
    let i = 2;
    while (fs.existsSync(personaFile(`${slug}-${i}`))) i++;
    slug = `${slug}-${i}`;
    renamed = true;
  }

  const lines = Object.entries(check.frontmatter)
    .filter(([k, v]) => /^[a-z_]+$/i.test(k) && v !== undefined && String(v).length < 1200)
    .map(([k, v]) => `${k}: ${String(v).replace(/\n/g, " ").trim()}`);
  // carry EVERY frontmatter key, not a fixed list: a rebuild silently dropped class/lifestyle/wardrobe
  const known = new Set(lines.map((l) => l.split(":")[0].trim()));
  const extra = Object.entries(meta || {})
    .filter(([k]) => !known.has(k))
    .map(([k, val]) => `${k}: ${val}`);
  fs.writeFileSync(personaFile(slug), `---\n${[...lines, ...extra].join("\n")}\n---\n\n${check.body}\n`);

  let worldSaved = false;
  if (obj.world && (obj.world.backstory || (obj.world.cast || []).length)) {
    saveWorld(slug, { backstory: obj.world.backstory, cast: obj.world.cast, source: "import" });
    worldSaved = true;
  }

  // only keys this install actually knows about
  let settingsApplied = 0;
  if (applySettings && obj.settings && typeof obj.settings === "object") {
    if (typeof setEnvFn === "function") {
      for (const k of KNOBS) {
        if (obj.settings[k.key] === undefined) continue;
        setEnvFn(k.key, String(obj.settings[k.key]));
        settingsApplied++;
      }
    }
  }

  return { ok: true, slug, renamed, settingsApplied, worldSaved, name: check.frontmatter.name };
}

/* -------------------------------- delete ------------------------------ */

/**
 * Move a character to personas/.trash/ (never a hard delete) and, if it was the
 * active one, switch to something else so the bot never starts with nothing.
 */
export function deletePersona(slug, { setEnvFn = null } = {}) {
  const s = slugify(slug);
  const file = personaFile(s);
  if (!fs.existsSync(file)) return { ok: false, reason: `character "${s}" not found` };

  fs.mkdirSync(TRASH, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.renameSync(file, path.join(TRASH, `${s}-${stamp}.md`));

  const world = worldFile(s);
  if (fs.existsSync(world)) {
    fs.mkdirSync(TRASH, { recursive: true });
    fs.renameSync(world, path.join(TRASH, `${s}-${stamp}.world.json`));
  }

  const routine = path.join(ROUTINE_DIR, `${s}.json`);
  if (fs.existsSync(routine)) {
    fs.mkdirSync(ROUTINE_TRASH, { recursive: true });
    fs.renameSync(routine, path.join(ROUTINE_TRASH, `${s}-${stamp}.json`));
  }

  let switchedTo = null;
  const remaining = listSlugs();
  if (config.persona === s) {
    if (remaining.length && typeof setEnvFn === "function") {
      setEnvFn("PERSONA", remaining[0]);
      const card = readCard(remaining[0]);
      if (card?.frontmatter?.name) setEnvFn("BOT_NAME", card.frontmatter.name);
      switchedTo = remaining[0];
    }
  }

  return { ok: true, slug: s, switchedTo, remaining };
}

export function trashContents() {
  if (!fs.existsSync(TRASH)) return [];
  return fs.readdirSync(TRASH).filter((f) => f.endsWith(".md"));
}

export function restoreFromTrash(fileName, { setEnvFn = null } = {}) {
  const src = path.join(TRASH, fileName);
  if (!fs.existsSync(src)) return { ok: false, reason: "not in trash" };
  const slug = slugify(fileName.replace(/-\d{4}-.*\.md$/, "").replace(/\.md$/, ""));
  const dest = personaFile(slug);
  if (fs.existsSync(dest)) return { ok: false, reason: `"${slug}" already exists` };
  fs.renameSync(src, dest);
  return { ok: true, slug };
}
