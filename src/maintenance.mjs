import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, config, log } from "./config.mjs";
import { loadState, saveState } from "./store.mjs";

/**
 * maintenance.mjs — daily backup of everything that matters.
 *
 * Saves chats, personas, stickers, prompt rules, .env and the WhatsApp auth
 * into one tarball in the Downloads folder, keeping the last N copies.
 * (The auth file means a restore does not need a fresh QR scan.)
 */

const DEFAULT_DIR = path.join(process.env.HOME || ROOT, "storage", "downloads", "understudy-backups");

function backupDir() {
  const dir = config.backupDir || DEFAULT_DIR;
  return dir.startsWith("~") ? path.join(process.env.HOME || "", dir.slice(1)) : dir;
}

export function runBackup() {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const out = path.join(dir, `understudy-${day}.tgz`);

  const items = ["data/chats", "data/state.json", "personas", "assets/stickers", "prompt", ".env"];
  if (fs.existsSync(path.join(ROOT, "data", "auth"))) items.push("data/auth");

  const r = spawnSync("tar", ["czf", out, ...items], { cwd: ROOT, encoding: "utf8" });
  // tar exits 1 for "some files unreadable" — still a usable archive
  const made = fs.existsSync(out) && fs.statSync(out).size > 1024;
  if (r.error || !made) {
    log(`backup failed: ${r.error?.message || r.stderr || r.status}`);
    return null;
  }

  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("understudy-") && f.endsWith(".tgz"))
      .sort();
    for (const old of files.slice(0, Math.max(0, files.length - config.backupKeep))) {
      fs.rmSync(path.join(dir, old), { force: true });
    }
  } catch {
    /* ignore pruning errors */
  }

  const size = (fs.statSync(out).size / 1024).toFixed(0);
  log(`backup → ${out} (${size} kb)`);
  return out;
}

export function startMaintenance() {
  if (!config.backup) {
    log("backup: off");
    return;
  }
  const check = () => {
    try {
      const st = loadState();
      const day = new Date().toISOString().slice(0, 10);
      if (st.backupDay === day) return;
      st.backupDay = day;
      saveState(st);
      runBackup();
    } catch (err) {
      log(`backup error: ${err.message}`);
    }
  };
  setTimeout(check, 60 * 1000); // shortly after boot
  setInterval(check, 60 * 60 * 1000); // then hourly (only fires once per day)
  log(`backup: on → ${backupDir()} (simpan ${config.backupKeep} terakhir)`);
}
