#!/usr/bin/env node
/**
 * character.mjs — create a character, guided by the model.
 *
 *   node scripts/character.mjs            (or: rp character)
 *   node scripts/character.mjs --list
 *   node scripts/character.mjs --use <slug>
 *
 * Modes:
 *   1) from a film / anime / game / book   -> give name + title, the model does the rest
 *   2) from a real public figure           -> person's public persona only
 *   3) from a free description
 *   4) build from scratch (short Q&A)
 *
 * The generation prompt is deliberately strict about canon fidelity so the
 * result actually feels like that character instead of a generic assistant.
 */
import fs from "node:fs";
import path from "node:path";
import { PERSONA_DIR, ROOT, envGet } from "../src/config.mjs";
import { parsePersonaFrontmatter } from "../src/prompt.mjs";
import { chat as llmChat } from "../src/llm.mjs";
import { createAsk } from "./_ask.mjs";
import { KNOBS, currentValues, applyValues, autoSuggest, askManually, setEnv, formatTable } from "./_settings.mjs";

const { ask, close } = createAsk();

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

function listPersonas() {
  const files = fs.readdirSync(PERSONA_DIR).filter((f) => f.endsWith(".md") && !f.startsWith("_"));
  if (!files.length) return console.log("  (no characters yet)");
  for (const f of files) {
    const slug = f.replace(/\.md$/, "");
    const meta = parsePersonaFrontmatter(fs.readFileSync(path.join(PERSONA_DIR, f), "utf8"));
    console.log(`  ${slug.padEnd(18)} ${(meta.emoji || "").padEnd(3)} ${meta.name || ""}`);
  }
}

const SYSTEM = `You write character cards for a private WhatsApp roleplay bot.
Your job: a card that is FAITHFUL to the source — not a friendlier version you invented.

STRICT RULES
1. Use CANON facts only. If something is unknown, pick whatever is most consistent with the popular canon, and do NOT invent contradicting traits.
2. If the character comes from a fictional work, name the source (title + medium) in the Snapshot.
3. Capture the details that matter:
   - Speech: pronouns, verbal habits, signature words, formal or not, which languages they mix.
   - Emotional range: how they get angry, upset, sad, embarrassed, scared, affectionate, playful — including what they HIDE.
   - Self-contradictions (this is what makes them feel real).
   - The starting relationship with the user and how fast they warm up.
   - Limits: what makes them sulk, disappear, or go cold.
4. Do NOT turn them into an assistant, always polite, always agreeable. Keep the real personality even if it is cold, blunt or unpleasant.
5. "Example chat rhythm" MUST be 8-10 lines and unmistakably theirs.
6. Frontmatter MUST use this format, every field filled:
---
name: <short name>
emoji: <1 emoji>
vibe: <one line>
language: <the language they chat in>
deflection: <an in-character line when accused of being an AI>
voice: <pick one: Aoede/Kore/Leda/Zephyr/Puck/Charon>
voice_eleven:
voice_tags: [tag1] [tag2] [tag3] [tag4] [tag5]
voice_style: <1-2 sentences on how their voice sounds>
active_hours: <when they are usually online, format 11-14,17-19,21-2>
chat_schedule: <hours when they tend to message first, format 11,12,13,17,18,19,20,22,23,0>
appearance: <appearance description for photo generation>
---

Then the card itself, with these sections:
# PERSONA CARD — <Name>
## Snapshot
## Texting habits (what makes them read as human)
### Example chat rhythm (REQUIRED)
## Personality
## History (canon)
## Character limits
## Canon facts (never violate)
## Voice rules (ElevenLabs v3)

Answer ONLY in this format:
<CARD>
...the complete card...
</CARD>`;

async function generate(brief) {
  const raw = await llmChat(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: brief },
    ],
    { temperature: 0.85, maxTokens: 6000 },
  );

  // tolerant extraction: the model may omit the closing tag if it runs long
  let t = raw;
  const open = t.search(/<CARD>/i);
  if (open !== -1) t = t.slice(open + "<CARD>".length);
  const close = t.search(/<\/CARD>/i);
  if (close !== -1) t = t.slice(0, close);
  let card = t
    .trim()
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  if (!card.startsWith("---")) {
    try {
      fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
      fs.writeFileSync(path.join(ROOT, "data", "last-character-raw.txt"), raw);
    } catch {
      /* ignore */
    }
    throw new Error("the model did not return a valid card");
  }
  return card;
}

async function buildBrief() {
  console.log(`
  How do you want to build the character?

   1) Film / anime / game / book   (give the name and the title)
   2) A real person / public figure
   3) Free description
   4) From scratch (short Q&A)
   5) Exit
`);
  const mode = await ask("  Choose [1-5]", "1");

  if (mode === "5") return null;

  const lang = await ask("  Language she chats in", "Casual English (with a little Indonesian)");
  const nick = await ask("  What she calls you", "");
  const nickLine = nick ? `What she calls the user: "${nick}".` : "What she calls the user: (not set — pick something natural).";

  if (mode === "1") {
    const name = await ask("  Character name");
    if (!name) return null;
    const title = await ask("  Source title (film/anime/game/book)");
    return `Write a character card for "${name}" from "${title}". ${nickLine} Chat language: ${lang}. Follow the canon of "${title}" as closely as possible.`;
  }

  if (mode === "2") {
    const name = await ask("  Public figure name");
    if (!name) return null;
    const field = await ask("  Field (musician/actor/athlete/streamer/etc.)", "");
    return (
      `Write a character card based on the PUBLIC persona of "${name}"${field ? ` (${field})` : ""}. ${nickLine} Chat language: ${lang}. ` +
      `Use their public speaking style and image. Do NOT invent claims about their non-public private life, and do not write anything defamatory or harmful.`
    );
  }

  if (mode === "3") {
    const desc = await ask("  Describe the character (free form)");
    if (!desc) return null;
    return `Write a character card from this description: ${desc}\n${nickLine} Chat language: ${lang}.`;
  }

  // mode 4 — scratch Q&A
  const name = await ask("  Name");
  if (!name) return null;
  const age = await ask("  Age");
  const place = await ask("  City / residence");
  const job = await ask("  Work / school");
  const traits = await ask("  3-5 traits (comma separated)");
  const typing = await ask("  Texting style (short/long, slang, capitals, emoji)");
  const anger = await ask("  What annoys her");
  const soft = await ask("  What softens her");
  const rel = await ask("  Relationship with you", "close, not official");
  return [
    "Write an ORIGINAL character card from this brief:",
    `Name: ${name}; Age: ${age}; Residence: ${place}; Work: ${job}.`,
    `Traits: ${traits}.`,
    `Texting style: ${typing}.`,
    `Annoyed by: ${anger}. Softened by: ${soft}.`,
    `Relationship with the user: ${rel}.`,
    nickLine,
    `Chat language: ${lang}.`,
  ].join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--list" || args[0] === "list") return listPersonas();
  if (args[0] === "--use" || args[0] === "use") {
    const slug = args[1];
    if (!slug || !fs.existsSync(path.join(PERSONA_DIR, `${slug}.md`))) {
      console.log("  character not found. See: rp character --list");
      return;
    }
    setEnv("PERSONA", slug);
    const meta = parsePersonaFrontmatter(fs.readFileSync(path.join(PERSONA_DIR, `${slug}.md`), "utf8"));
    if (meta.name) setEnv("BOT_NAME", meta.name);
    console.log(`  ✓ active: ${meta.name || slug}. Run: rp restart`);
    return;
  }

  if (!envGet("LLM_BASE_URL")) {
    console.log("\n  No model configured. Run first:  rp setup\n");
    return;
  }

  console.log(`
  ┌─────────────────────────────────────────────┐
  │  Understudy · create a character             │
  └─────────────────────────────────────────────┘`);

  const brief = await buildBrief();
  if (!brief) return console.log("  cancelled.");

  console.log("\n  The model is writing the character… (10-30 seconds)");
  let card;
  try {
    card = await generate(brief);
  } catch (err) {
    console.log(`  ✗ failed: ${err.message}`);
    return;
  }

  const meta = parsePersonaFrontmatter(card);
  const slug = slugify(meta.name || "character");
  console.log(`\n  ── preview (${slug}) ──\n`);
  console.log(
    card
      .split("\n")
      .slice(0, 42)
      .map((l) => "  " + l)
      .join("\n"),
  );
  console.log("\n  …\n");

  const save = (await ask("  Save this character? [y/N]", "y")).toLowerCase();
  if (save !== "y") return console.log("  cancelled.");

  const file = path.join(PERSONA_DIR, `${slug}.md`);
  fs.writeFileSync(file, card.endsWith("\n") ? card : card + "\n");
  setEnv("PERSONA", slug);
  if (meta.name) setEnv("BOT_NAME", meta.name);
  console.log(`  ✓ saved: personas/${slug}.md`);
  console.log(`  ✓ now active`);

  // ── settings: auto / manual / skip ────────────────────────────
  const current = currentValues();
  console.log(`
  Behaviour settings (voice notes, reactions, hours, sulking, etc.):

   1) Auto   — let the model tune them for this character  (recommended)
   2) Manual — set them one by one
   3) Skip   — keep the defaults
`);
  const mode = await ask("  Choose [1-3]", "1");

  try {
    if (mode === "1") {
      console.log("  The model is choosing settings…");
      const suggested = await autoSuggest({ card }, current);
      console.log(`\n  Proposal:\n${formatTable(suggested)}\n`);
      const ok = (await ask("  Apply? [y/N]", "y")).toLowerCase();
      if (ok === "y") {
        applyValues(suggested);
        setEnv("PERSONA", slug);
        console.log("  ✓ settings applied");
      }
    } else if (mode === "2") {
      const suggested = await autoSuggest({ card }, current).catch(() => current);
      const values = await askManually(rl, suggested);
      applyValues(values);
      console.log("  ✓ settings applied");
    }
  } catch (err) {
    console.log(`  ! automatic settings failed (${err.message}) — keeping the defaults`);
  }

  console.log(`\n  Done. Run:  rp restart\n`);
}

main()
  .catch((err) => console.error("failed:", err.message))
  .finally(() => close());
