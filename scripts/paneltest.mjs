/**
 * paneltest.mjs — run the dashboard's own script in a fake browser and report what breaks.
 *
 * Every time the panel misbehaved I could only guess: I cannot see Hik's screen, and a JavaScript error
 * leaves the page looking perfectly normal while every handler is dead. jsdom renders the page and runs the
 * script, so a fault becomes a line of output instead of a mystery.
 */
import fs from "node:fs";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";

const html = fs.readFileSync(path.join("dashboard", "index.html"), "utf8");
const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errors.push(`${e.message} :: ${(e.detail && e.detail.stack || "").split("\n").slice(0, 3).join(" | ")}`));
vc.on("error", (...a) => errors.push("console.error: " + a.join(" ")));
vc.on("warn", () => {});

// the panel fetches from its own server; give it a stub that answers like the real one
const summaryStub = fs.existsSync("data/_summary.json") ? fs.readFileSync("data/_summary.json", "utf8") : "{}";
const dom = new JSDOM(html, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  virtualConsole: vc,
  url: "http://127.0.0.1:8787/",
  beforeParse(win) {
    win.fetch = async (url) => ({
      ok: true,
      json: async () => (String(url).includes("/api/summary") ? JSON.parse(summaryStub) : { ok: true, photos: {}, ratings: [] }),
      text: async () => "",
    });
    win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    win.alert = () => {};
    win.confirm = () => true;
  },
});

await new Promise((r) => setTimeout(r, 1200));
const win = dom.window;
const doc = win.document;

const checks = [
  ["script jalan tanpa error", errors.length === 0],
  ["renderPhotos ada", typeof win.renderPhotos === "function"],
  ["tab Photos ada", !!doc.querySelector("#tab-photos")],
  ["tombol switch ada", doc.querySelectorAll(".switch").length > 0],
  ["kartu selfie ada", doc.documentElement.innerHTML.includes("Selfie terjadwal")],
  ["bisa render tab Photos", (() => { try { win.renderPhotos(); return true; } catch { return false; } })()],
  ["switch selfie ada setelah render", !!doc.querySelector('[data-ssw="SELFIE_ENABLED"]')],
  ["field baju ada", !!doc.querySelector("#selfie-outfit-text")],
];

console.log("  === panel test (jsdom) ===");
for (const [name, ok] of checks) console.log(`  ${ok ? "✓" : "✗"} ${name}`);
if (errors.length) {
  console.log("\n  ERROR yang ketangkap:");
  for (const e of errors.slice(0, 6)) console.log("   " + e.slice(0, 220));
} else {
  console.log("\n  tidak ada error JS ✓");
}
process.exit(checks.every(([, ok]) => ok) && !errors.length ? 0 : 1);
