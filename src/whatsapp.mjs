import {
  useMultiFileAuthState,
  makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  jidNormalizedUser,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import pino from "pino";
import fs from "node:fs";
import path from "node:path";
import { AUTH_DIR, DATA_DIR, log } from "./config.mjs";

const silent = pino({ level: "silent" });
let currentSock = null;
export const getSock = () => currentSock;

const fullJid = (jid) => {
  if (!jid) return jid;
  if (jid.endsWith("@s.whatsapp.net") || jid.endsWith("@g.us")) return jid;
  return jidNormalizedUser(jid);
};

export function phoneFromJid(jid) {
  return String(jid || "").split("@")[0].split(":")[0];
}

export async function sendText(sock, jid, text, quoted) {
  return sock.sendMessage(jid, { text }, quoted ? { quoted } : undefined);
}

export async function sendReaction(sock, jid, key, emoji) {
  return sock.sendMessage(jid, { react: { text: emoji, key } });
}

export async function sendVoice(sock, jid, buffer) {
  return sock.sendMessage(jid, {
    audio: buffer,
    mimetype: "audio/ogg; codecs=opus",
    ptt: true,
  });
}

export async function sendImage(sock, jid, buffer, mimetype = "image/png", caption) {
  return sock.sendMessage(jid, { image: buffer, mimetype, caption });
}

export async function sendSticker(sock, jid, buffer) {
  return sock.sendMessage(jid, { sticker: buffer, mimetype: "image/webp" });
}

export async function presence(sock, jid, state) {
  try {
    await sock.sendPresenceUpdate(state, jid);
  } catch {
    /* ignore */
  }
}

/** Account-wide presence: "available" (online) / "unavailable" (offline). */
export async function setGlobalPresence(sock, state) {
  try {
    await sock.sendPresenceUpdate(state);
  } catch {
    /* ignore */
  }
}

export async function subscribePresence(sock, jid) {
  try {
    await sock.presenceSubscribe(jid);
  } catch {
    /* ignore */
  }
}

export async function markRead(sock, keys) {
  try {
    await sock.readMessages(keys);
  } catch {
    /* ignore */
  }
}

export async function downloadMedia(message) {
  return downloadMediaMessage(message, "buffer", {}, { logger: silent });
}

/**
 * Connect to WhatsApp. Reconnects automatically until logged out.
 * Returns the live socket (may be replaced on reconnect).
 */
export async function startWhatsApp({ onMessage, onReady } = {}) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  let attempts = 0;

  const connect = async () => {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: silent,
      browser: Browsers.ubuntu("Chrome"),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined,
    });

    sock.ev.on("creds.update", saveCreds);
    currentSock = sock;

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("\nScan this QR with WhatsApp (Linked devices):\n");
        qrcode.generate(qr, { small: true }, (out) => {
          console.log(out);
          try {
            fs.writeFileSync(path.join(DATA_DIR, "qr.txt"), out);
          } catch {
            /* ignore */
          }
        });
        console.log("\n");
        const png = path.join(DATA_DIR, "qr.png");
        QRCode.toFile(png, qr, { width: 640, margin: 2 }, (err) => {
          if (!err) log(`QR also saved: ${png} and data/qr.txt`);
        });
      }

      if (connection === "open") {
        attempts = 0;
        try {
          fs.rmSync(path.join(DATA_DIR, "qr.png"), { force: true });
        } catch {
          /* ignore */
        }
        log(`WhatsApp connected as ${phoneFromJid(sock.user?.id)}`);
        onReady?.(sock);
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        if (loggedOut) {
          log("WhatsApp logged out. Delete data/auth and restart to relink.");
          return;
        }
        attempts += 1;
        const wait = Math.min(30000, 1500 * attempts);
        log(`WhatsApp closed (code ${code}). Reconnecting in ${wait}ms…`);
        setTimeout(connect, wait);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) {
        try {
          await onMessage?.(sock, m);
        } catch (err) {
          log(`message handler error: ${err.stack || err.message}`);
        }
      }
    });

    return sock;
  };

  return connect();
}

export { fullJid };
