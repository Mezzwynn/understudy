#!/usr/bin/env node
/**
 * setup.mjs — connect an AI model. Nothing else.
 *
 *   node scripts/setup.mjs      (or: rp setup)
 *
 * Asks for a provider + API key + model, tests it, writes .env. Character and
 * behaviour are configured later (`rp character`, `rp config`).
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT, envGet } from "../src/config.mjs";
import { createAsk } from "./_ask.mjs";

const ENV_FILE = path.join(ROOT, ".env");
const { ask, close } = createAsk();

const PROVIDERS = [
  {
    key: "gemini",
    name: "Google Gemini      (gratis mulai, bagus buat roleplay Indonesia)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    keyHint: "AIza... atau AQ... (Google AI Studio)",
    media: true,
  },
  {
    key: "deepseek",
    name: "DeepSeek           (paling murah, Indonesia bagus)",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    keyHint: "sk-... (platform.deepseek.com)",
  },
  {
    key: "openrouter",
    name: "OpenRouter         (satu key, banyak model: Claude, Hermes, dll)",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "anthropic/claude-sonnet-4.5",
    keyHint: "sk-or-v1-... (openrouter.ai)",
  },
  {
    key: "openai",
    name: "OpenAI             (GPT)",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    keyHint: "sk-... (platform.openai.com)",
  },
  {
    key: "custom",
    name: "Custom (OpenAI-compatible, mis. lokal/Ollama/LM Studio)",
    baseUrl: "",
    model: "",
    keyHint: "isi sendiri (boleh apa saja kalau lokal)",
  },
];

function setEnv(key, value) {
  let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (re.test(text)) text = text.replace(re, line);
  else text += (text.endsWith("\n") || !text ? "" : "\n") + line + "\n";
  fs.writeFileSync(ENV_FILE, text, { mode: 0o600 });
}

async function testProvider({ baseUrl, apiKey, model, temperature }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Balas satu kata: ok" }],
      max_tokens: 320,
      temperature,
      stream: false,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 240)}`);
  const json = JSON.parse(text);
  return (json.choices?.[0]?.message?.content || "").trim() || "(kosong)";
}

async function main() {
  console.log(`
  ┌─────────────────────────────────────────────┐
  │  Understudy · hubungkan model AI             │
  └─────────────────────────────────────────────┘
`);

  if (!fs.existsSync(ENV_FILE)) {
    fs.copyFileSync(path.join(ROOT, ".env.example"), ENV_FILE);
    fs.chmodSync(ENV_FILE, 0o600);
    console.log("  (.env created from .env.example)\n");
  }

  console.log("  Choose a provider:\n");
  PROVIDERS.forEach((p, i) => console.log(`   ${i + 1}) ${p.name}`));
  console.log();

  const pick = await ask(`  Nomor [1-${PROVIDERS.length}]`, "1");
  const provider = PROVIDERS[Number(pick) - 1] || PROVIDERS[0];
  console.log();

  let baseUrl = provider.baseUrl;
  if (provider.key === "custom") {
    baseUrl = await ask("  Base URL (contoh: http://localhost:11434/v1)");
    if (!baseUrl) {
      console.log("  cancelled.");
      close();
      return;
    }
  }

  const apiKey = await ask(`  API key (${provider.keyHint})`);
  if (!apiKey) {
    console.log("  cancelled — the API key is required.");
    close();
    return;
  }

  const model = await ask("  Model", provider.model || "isi model");
  if (!model) {
    console.log("  cancelled — the model name is required.");
    close();
    return;
  }

  const tempStr = await ask("  Temperature", "1.0");
  const temperature = Number.isFinite(Number(tempStr)) && tempStr !== "" ? Number(tempStr) : 1.0;

  let mediaKey = "";
  if (!provider.media) {
    const ans = (await ask("  Punya Google AI Studio key? (untuk lihat foto, dengar VN, kirim foto)", "n")).toLowerCase();
    if (ans === "y") mediaKey = await ask("  Google AI Studio key");
  } else {
    mediaKey = apiKey;
  }

  console.log("\n  Testing the connection…");
  try {
    const reply = await testProvider({ baseUrl, apiKey, model, temperature });
    console.log(`  ✓ connected — the model replied: ${reply.replace(/\s+/g, " ").slice(0, 60)}\n`);
  } catch (err) {
    console.log(`  ✗ failed: ${err.message}\n`);
    const force = (await ask("  Simpan tetap?", "n")).toLowerCase();
    if (force !== "y") {
      close();
      return;
    }
  }

  setEnv("LLM_LABEL", provider.key);
  setEnv("LLM_BASE_URL", baseUrl);
  setEnv("LLM_API_KEY", apiKey);
  setEnv("LLM_MODEL", model);
  setEnv("LLM_TEMPERATURE", String(temperature));

  // tracker + judge default to the same model (they can be overridden later)
  for (const prefix of ["TRACKER", "JUDGE"]) {
    setEnv(`${prefix}_LABEL`, provider.key);
    setEnv(`${prefix}_BASE_URL`, baseUrl);
    setEnv(`${prefix}_API_KEY`, apiKey);
    setEnv(`${prefix}_MODEL`, model);
    setEnv(`${prefix}_TEMPERATURE`, "0.2");
  }

  if (mediaKey) {
    setEnv("GEMINI_API_KEY", mediaKey);
    setEnv("VISION_MODEL", "gemini-2.5-flash");
    setEnv("TTS_MODEL", "gemini-2.5-flash-preview-tts");
    setEnv("IMAGE_MODEL", "gemini-2.5-flash-image");
  }

  console.log(`  ✓ saved to .env

  Next steps:

    1) connect WhatsApp   :  rp start        (scan the QR code)
    2) create a character :  rp character
    3) tune behaviour     :  rp config
`);
  close();
}

main().catch((err) => {
  console.error("\nfailed:", err.message);
  close();
  process.exit(1);
});
