#!/usr/bin/env node
/**
 * persona.mjs — list / use / create character cards.
 *
 *   node scripts/persona.mjs list
 *   node scripts/persona.mjs use mychar
 *   node scripts/persona.mjs new mychar
 *   node scripts/persona.mjs current
 */
import fs from "node:fs";
import path from "node:path";
import { PERSONA_DIR, ROOT } from "../src/config.mjs";
import { parsePersonaFrontmatter } from "../src/prompt.mjs";

const ENV_FILE = path.join(ROOT, ".env");

function list() {
  const files = fs.readdirSync(PERSONA_DIR).filter((f) => f.endsWith(".md") && !f.startsWith("_"));
  if (!files.length) return console.log("No personas yet. Run: node scripts/persona.mjs new <name>");
  const current = currentSlug();
  console.log("Personas:");
  for (const f of files) {
    const slug = f.replace(/\.md$/, "");
    const meta = parsePersonaFrontmatter(fs.readFileSync(path.join(PERSONA_DIR, f), "utf8"));
    const mark = slug === current ? "  <- active" : "";
    console.log(`  ${slug.padEnd(16)} ${(meta.emoji || "").padEnd(3)} ${meta.name || slug}${mark}`);
  }
}

function readEnv() {
  return fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
}

function currentSlug() {
  const m = readEnv().match(/^PERSONA=(.*)$/m);
  return m ? m[1].trim() : "";
}

function setEnv(key, value) {
  let env = readEnv();
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(env)) env = env.replace(re, `${key}=${value}`);
  else env += `\n${key}=${value}\n`;
  fs.writeFileSync(ENV_FILE, env, { mode: 0o600 });
}

function use(slug) {
  const file = path.join(PERSONA_DIR, `${slug}.md`);
  if (!fs.existsSync(file)) {
    console.error(`No such persona: ${slug}`);
    process.exit(1);
  }
  const meta = parsePersonaFrontmatter(fs.readFileSync(file, "utf8"));
  setEnv("PERSONA", slug);
  if (meta.name) setEnv("BOT_NAME", meta.name);
  console.log(`✓ active persona: ${meta.name || slug} ${meta.emoji || ""}`);
  console.log(`  restart the agent for it to take effect`);
}

function create(slug) {
  const dest = path.join(PERSONA_DIR, `${slug}.md`);
  if (fs.existsSync(dest)) {
    console.error(`Already exists: ${dest}`);
    process.exit(1);
  }
  fs.copyFileSync(path.join(PERSONA_DIR, "_TEMPLATE.md"), dest);
  console.log(`✓ created ${dest}\n  edit it, then: node scripts/persona.mjs use ${slug}`);
}

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case "list":
  case "ls":
  case undefined:
    list();
    break;
  case "use":
    if (!arg) throw new Error("usage: persona.mjs use <name>");
    use(arg);
    break;
  case "new":
    if (!arg) throw new Error("usage: persona.mjs new <name>");
    create(arg);
    break;
  case "current":
    console.log(currentSlug() || "(none)");
    break;
  default:
    console.log("usage: persona.mjs [list|use <name>|new <name>|current]");
}
