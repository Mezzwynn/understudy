import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT, PERSONA_DIR, config, envGet, STARTED_AT, log } from "./config.mjs";
import { listChats, loadChat, saveChat, loadState } from "./store.mjs";
import { loadPersona, parsePersonaFrontmatter } from "./prompt.mjs";
import { normalize, cohere, label as moodLabel, newMood, baselineFor, KEYS as MOOD_KEYS } from "./mood.mjs";
import { suggestMood } from "./affect.mjs";
import { isConnected, getSock } from "./whatsapp.mjs";
import { dueSlot } from "./proactive.mjs";
import { KNOBS, currentValues, applyValues, autoSuggest } from "../scripts/_settings.mjs";

/**
 * dashboard.mjs — tiny local web dashboard (no dependencies).
 * Bound to 127.0.0.1 by default; set DASHBOARD_HOST=0.0.0.0 + DASHBOARD_TOKEN
 * if you want to open it from another device.
 */

const HTML_FILE = path.join(ROOT, "dashboard", "index.html");
let elevenCache = { at: 0, data: null };

/* ------------------------------- helpers ------------------------------- */

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function setPersonaField(slug, key, value) {
  const file = path.join(PERSONA_DIR, `${slug}.md`);
  if (!fs.existsSync(file)) return false;
  let text = fs.readFileSync(file, "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return false;
  const re = new RegExp(`^${key}:.*$`, "m");
  const line = `${key}: ${value}`;
  const fm = re.test(m[1]) ? m[1].replace(re, line) : `${m[1]}\n${line}`;
  text = text.replace(m[0], `---\n${fm}\n---`);
  fs.writeFileSync(file, text);
  return true;
}

function logTail(n = 60) {
  try {
    const lines = fs.readFileSync(path.join(ROOT, "rp.log"), "utf8").split("\n");
    return lines
      .filter((l) => l && !/[█▄▀]/.test(l) && !/^[┌│└]/.test(l))
      .slice(-n);
  } catch {
    return [];
  }
}

async function elevenQuota() {
  if (!config.elevenlabsApiKey) return null;
  if (Date.now() - elevenCache.at < 60000) return elevenCache.data;
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": config.elevenlabsApiKey },
    });
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json();
    const data = {
      left: j.character_limit - j.character_count,
      limit: j.character_limit,
      used: j.character_count,
      reset: j.next_character_count_reset_unix
        ? new Date(j.next_character_count_reset_unix * 1000).toISOString().slice(0, 10)
        : null,
    };
    elevenCache = { at: Date.now(), data };
    return data;
  } catch {
    return null;
  }
}

function todaysSchedule(persona) {
  const spec = String(persona.chat_schedule || config.proactiveSchedule || "").trim();
  if (!spec) return [];
  const now = new Date();
  const at = (h, m) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0).getTime();
  const out = [];
  for (const part of spec.split(",")) {
    const h = Number(part.trim());
    if (!Number.isFinite(h)) continue;
    let minute = null;
    for (let m = 0; m < 60; m++) {
      if (dueSlot(String(h), at(h, m), { graceMin: 0, jitterMin: 0, lastSlot: "" })) {
        minute = m;
        break;
      }
    }
    if (minute === null) continue;
    const quiet = config.quietStart <= config.quietEnd
      ? h >= config.quietStart && h < config.quietEnd
      : h >= config.quietStart || h < config.quietEnd;
    out.push({
      time: `${String(h).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      hour: h,
      minute,
      quiet,
      passed: h < now.getHours() || (h === now.getHours() && minute <= now.getMinutes()),
    });
  }
  return out.sort((a, b) => a.hour - b.hour || a.minute - b.minute);
}

function personaList() {
  return fs
    .readdirSync(PERSONA_DIR)
    .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
    .map((f) => {
      const slug = f.replace(/\.md$/, "");
      const meta = parsePersonaFrontmatter(fs.readFileSync(path.join(PERSONA_DIR, f), "utf8"));
      return { slug, name: meta.name || slug, emoji: meta.emoji || "" };
    });
}

async function summary() {
  const persona = loadPersona();
  const st = loadState();
  const contacts = listChats().map((c) => ({
    jid: c.jid,
    name: c.profile?.name || "",
    nick: c.profile?.nick || "",
    number: c.profile?.number || c.jid.split("@")[0],
    persona: c.persona || "",
    inbound: c.stats?.inbound || 0,
    outbound: c.stats?.outbound || 0,
    mood: c.mood
      ? Object.fromEntries(["valence", "energy", "arousal", "affection", "patience", "playfulness"].map((k) => [k, Number(c.mood[k].toFixed(2))]))
      : null,
    state: c.proactive?.state || "idle",
    trusted: c.trusted === true,
    moodLabel: c.mood ? moodLabel(normalize(c.mood)) : "",
    dryCount: c.proactive?.dryCount || 0,
    commitments: (c.commitments || []).filter((x) => !x.done).map((x) => ({ what: x.what, due: x.due })),
    softMinutes:
      c.softUntil && c.softUntil > Date.now() ? Math.round((c.softUntil - Date.now()) / 60000) : 0,
    lastInteraction: c.lastInteraction || 0,
    lastProactiveAt: c.lastProactiveAt || 0,
  }));

  return {
    bot: {
      connected: isConnected(),
      number: getSock()?.user?.id ? String(getSock().user.id).split(":")[0].split("@")[0] : null,
      uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
      persona: { slug: persona.slug, name: persona.name, emoji: persona.emoji },
      presences: config.presence,
      quiet: [config.quietStart, config.quietEnd],
      idleMin: config.proactiveIdleMin,
      gapMin: config.proactiveGapMin,
    },
    contacts,
    personas: personaList(),
    settings: {
      knobs: KNOBS.map((k) => ({ key: k.key, label: k.label, kind: k.kind, value: currentValues()[k.key] })),
      activeHours: persona.active_hours || "",
      chatSchedule: persona.chat_schedule || "",
    },
    schedule: todaysSchedule(persona),
    quota: {
      usageDay: st.usageDay || null,
      usage: st.usage || {},
      photos: st.photoCount || 0,
      photoMax: config.photoGlobalDailyMax,
      ttsChars: st.elChars || 0,
      ttsMax: config.elevenlabsDailyChars,
      eleven: await elevenQuota(),
    },
    log: logTail(60),
  };
}

/* -------------------------------- server ------------------------------- */

function authorized(req, url) {
  if (config.dashboardHost === "127.0.0.1" || config.dashboardHost === "localhost") return true;
  const token = config.dashboardToken;
  if (!token) return true;
  return url.searchParams.get("token") === token || req.headers["x-dashboard-token"] === token;
}

export function startDashboard() {
  if (!config.dashboard) {
    log("dashboard: off");
    return;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    try {
      if (!authorized(req, url)) return json(res, 401, { error: "unauthorized" });

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const html = fs.readFileSync(HTML_FILE, "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(html);
      }

      if (req.method === "GET" && url.pathname === "/api/summary") {
        return json(res, 200, await summary());
      }

      if (req.method === "POST") {
        const body = await readBody(req);

        if (url.pathname === "/api/settings") {
          if (body.values && typeof body.values === "object") applyValues(body.values);
          const slug = loadPersona().slug;
          if (typeof body.activeHours === "string") setPersonaField(slug, "active_hours", body.activeHours);
          if (typeof body.chatSchedule === "string") setPersonaField(slug, "chat_schedule", body.chatSchedule);
          log("dashboard: settings updated");
          return json(res, 200, { ok: true, needsRestart: true });
        }

        if (url.pathname === "/api/auto") {
          const persona = loadPersona();
          const suggested = await autoSuggest(persona, currentValues());
          if (body.apply) {
            applyValues(suggested);
            log("dashboard: auto settings applied");
          }
          return json(res, 200, { ok: true, suggested });
        }

        if (url.pathname === "/api/persona") {
          if (!body.slug || !fs.existsSync(path.join(PERSONA_DIR, `${body.slug}.md`))) {
            return json(res, 400, { ok: false, error: "persona tidak ditemukan" });
          }
          const meta = parsePersonaFrontmatter(fs.readFileSync(path.join(PERSONA_DIR, `${body.slug}.md`), "utf8"));
          const { setEnv } = await import("../scripts/_settings.mjs");
          setEnv("PERSONA", body.slug);
          if (meta.name) setEnv("BOT_NAME", meta.name);
          log(`dashboard: persona → ${body.slug}`);
          return json(res, 200, { ok: true });
        }

        if (url.pathname === "/api/trust") {
          const chat = loadChat(body.jid);
          chat.trusted = body.trusted === true;
          if (!chat.trusted) {
            // losing trust also drops the pet name and any warmth she gave them
            chat.profile.nick = "";
            chat.softUntil = 0;
            chat.commitments = [];
            chat.instructions = [];
          } else if (!chat.profile.nick && config.defaultNick) {
            // gaining trust back restores the default pet name
            chat.profile.nick = config.defaultNick;
          }
          chat.mood = newMood(baselineFor(chat));
          saveChat(chat);
          log(`dashboard: trusted=${chat.trusted} for ${body.jid}`);
          return json(res, 200, { ok: true, trusted: chat.trusted, mood: chat.mood, nick: chat.profile.nick });
        }

        if (url.pathname === "/api/mood") {
          const chat = loadChat(body.jid);
          const m = normalize(chat.mood || newMood());
          for (const k of MOOD_KEYS) {
            if (body.mood && body.mood[k] !== undefined) {
              const n = Number(body.mood[k]);
              if (Number.isFinite(n)) m[k] = n;
            }
          }
          chat.mood = cohere(m);
          saveChat(chat);
          log(`dashboard: mood ${body.jid} → ${moodLabel(chat.mood)}`);
          return json(res, 200, { ok: true, mood: chat.mood, label: moodLabel(chat.mood) });
        }

        if (url.pathname === "/api/mood/auto") {
          const chat = loadChat(body.jid);
          const persona = loadPersona(chat.persona || undefined);
          let suggested = null;
          try {
            suggested = await suggestMood(chat, persona);
          } catch (err) {
            log(`dashboard: suggestMood failed ${err.message}`);
          }
          if (!suggested) return json(res, 400, { ok: false, error: "model tidak mengembalikan mood" });
          if (body.apply) {
            chat.mood = cohere({ ...normalize(chat.mood), ...suggested.mood });
            saveChat(chat);
            log(`dashboard: auto mood ${body.jid} → ${moodLabel(chat.mood)} (${suggested.reason})`);
          }
          return json(res, 200, { ok: true, suggested, mood: chat.mood, label: moodLabel(chat.mood) });
        }

        if (url.pathname === "/api/contact") {
          const chat = loadChat(body.jid);
          chat.profile = chat.profile || {};
          if (body.field === "persona") chat.persona = body.value;
          else if (["name", "nick", "number", "notes"].includes(body.field)) chat.profile[body.field] = body.value;
          saveChat(chat);
          return json(res, 200, { ok: true });
        }

        if (url.pathname === "/api/contact/reset") {
          const chat = loadChat(body.jid);
          chat.history = [];
          chat.coldUntil = 0;
          chat.lastSkipAt = 0;
          chat.proactive = { state: "idle", sentAt: 0, nudgedAt: 0, drySince: 0, dryCount: 0, lastDry: "", lastSlot: "" };
          if (body.mood) chat.mood = null;
          saveChat(chat);
          log(`dashboard: reset ${body.jid}`);
          return json(res, 200, { ok: true });
        }

        if (url.pathname === "/api/proactive") {
          const { forceProactiveNow } = await import("./proactive.mjs");
          const result = await forceProactiveNow(body.jid || undefined);
          return json(res, result.ok ? 200 : 400, result);
        }

        if (url.pathname === "/api/restart") {
          log("dashboard: restart requested");
          json(res, 200, { ok: true, message: "restarting…" });
          const child = spawn("bash", ["-c", "sleep 1; ./restart.sh"], { cwd: ROOT, detached: true, stdio: "ignore" });
          child.unref();
          return;
        }
      }

      return json(res, 404, { error: "not found" });
    } catch (err) {
      log(`dashboard error: ${err.message}`);
      return json(res, 500, { error: err.message });
    }
  });

  server.listen(config.dashboardPort, config.dashboardHost, () => {
    const host = config.dashboardHost === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
    log(`dashboard: http://${host}:${config.dashboardPort}`);
  });
  server.on("error", (err) => log(`dashboard failed: ${err.message}`));
}
