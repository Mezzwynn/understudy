import { ensureDirs, config, providers, log } from "./config.mjs";
import { startWhatsApp } from "./whatsapp.mjs";
import { onMessage } from "./router.mjs";
import { loadPersona } from "./prompt.mjs";
import { startProactive } from "./proactive.mjs";
import { startDashboard } from "./dashboard.mjs";
import { startMaintenance } from "./maintenance.mjs";

ensureDirs();

const persona = loadPersona();
const p = providers()[0];

console.log(`
  ┌─────────────────────────────────────────────┐
  │  Understudy · WhatsApp roleplay agent        │
  └─────────────────────────────────────────────┘
  character : ${persona.name} ${persona.emoji}
  model     : ${p.model} @ ${p.baseUrl}
  allow     : ${config.allow.length ? config.allow.join(", ") : "everyone"}
  groups    : ${config.allowGroups ? "on" : "off"}
`);

if (!config.allow.length) {
  log("WARNING: ALLOW is empty — anyone who messages this number gets a reply.");
}

await startWhatsApp({
  onMessage,
  onReady: () => log(`listening. Send a DM to the linked number.`),
});

if (config.proactive) startProactive();
startDashboard();
startMaintenance();

process.on("SIGINT", () => {
  console.log("\nbye.");
  process.exit(0);
});
