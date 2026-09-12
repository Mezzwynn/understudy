/**
 * tasks.mjs — doing errands for the trusted contact, without forgetting.
 *
 * The case that broke other setups: the main user says "message this number for
 * me, order food". The bot sends it, then has no idea it ever happened, so it
 * cannot answer "did you send it?" and never reports the reply back.
 *
 * Here every errand is a record:
 *   chat.tasks[]        on the requester's chat: who, what text, when, status
 *   chat.history[]      the action is pushed as her own turn, so the context
 *                       survives summarising and never "forgets" it happened
 *   the target's chat   gets the actual message in its history plus a marker
 *   on reply            the requester gets a cross-note: "they replied: ..."
 *
 * Only trusted contacts may ask for this, and there is a daily cap.
 */
import { config, log } from "./config.mjs";
import { loadChat, saveChat } from "./store.mjs";
import { addCrossNote } from "./links.mjs";

const PHONE_RE = /^\+?\d{8,15}$/;

/** "+62 812-3456-789" -> "628123456789" */
export function normalizeNumber(raw) {
  const digits = String(raw || "").replace(/[^\d]/g, "");
  if (!digits) return "";
  if (digits.startsWith("0")) return "62" + digits.slice(1);
  if (digits.length <= 11 && !digits.startsWith("62")) return "62" + digits;
  if (digits.startsWith("620")) return "62" + digits.slice(3);
  return digits;
}

export function jidFor(number) {
  return `${number}@s.whatsapp.net`;
}

/** How many errands she has run for this chat today. */
function ranToday(chat) {
  const day = new Date().toISOString().slice(0, 10);
  return (chat.tasks || []).filter((t) => (t.day || "") === day).length;
}

/**
 * Validate a task the model asked to run. Returns { ok:true, task } or
 * { ok:false, reason } — the reason is fed back so she can say it out loud.
 */
export function validateTask(chat, raw) {
  if (!config.tasks) return { ok: false, reason: "tasks are disabled" };
  if (chat.trusted !== true) return { ok: false, reason: "only the owner can ask for this" };
  if (!raw || typeof raw !== "object") return { ok: false, reason: "no task given" };
  if (String(raw.type || "message") !== "message") return { ok: false, reason: "unsupported task type" };

  const number = normalizeNumber(raw.to);
  if (!PHONE_RE.test(number)) return { ok: false, reason: "that phone number does not look valid" };
  if (number === normalizeNumber(config.trusted[0] || "") && config.trusted.length === 1) {
    return { ok: false, reason: "that is their own number" };
  }

  const text = String(raw.text || "").trim();
  if (!text) return { ok: false, reason: "the message is empty" };
  if (text.length > 600) return { ok: false, reason: "the message is too long" };
  if (/(otp|password|pin|kode verifikasi|verification code)/i.test(text)) {
    return { ok: false, reason: "she will not send codes or passwords" };
  }

  if (ranToday(chat) >= config.taskDailyMax) {
    return { ok: false, reason: `daily limit of ${config.taskDailyMax} errands reached` };
  }

  return {
    ok: true,
    task: {
      to: number,
      jid: jidFor(number),
      text,
      why: String(raw.why || "").slice(0, 160),
      at: Date.now(),
      day: new Date().toISOString().slice(0, 10),
      status: "pending",
    },
  };
}

/**
 * Send it, then write the whole thing down: on the requester's chat, in her own
 * history, and on the target's chat.
 */
export async function runTask(sock, chat, task) {
  const target = loadChat(task.jid);
  try {
    await sock.sendMessage(task.jid, { text: task.text });
  } catch (err) {
    task.status = "failed";
    task.error = err.message;
    chat.tasks = [...(chat.tasks || []), task].slice(-20);
    log(`task failed → ${task.to}: ${err.message}`);
    return { ok: false, reason: `send failed: ${err.message}` };
  }

  task.status = "sent";
  task.sentAt = Date.now();
  chat.tasks = [...(chat.tasks || []), task].slice(-20);

  // she must remember doing it — as her own turn, and as a visible note
  const label = target.profile?.name ? `${target.profile.name} (${task.to})` : task.to;
  chat.history.push({
    role: "assistant",
    content: `(aku kirim pesan ke ${label}: "${task.text}")`,
    ts: Date.now(),
  });

  // the target's side: the message is really there, plus why it arrived
  target.history = [...(target.history || []), { role: "assistant", content: task.text, ts: Date.now(), viaTask: true }];
  target.profile ||= {};
  if (!target.profile.number) target.profile.number = task.to;
  target.tasksIn = [...(target.tasksIn || []), { from: chat.jid, at: Date.now(), text: task.text }].slice(-10);
  saveChat(target);

  saveChat(chat);
  log(`task sent → ${task.to}: ${task.text.slice(0, 60)}`);
  return { ok: true, task, label };
}

/**
 * The third party replied. Tell the requester — this is the part that usually
 * gets lost.
 */
export function notifyTaskReply(targetChat, incoming) {
  const hits = [];
  for (const t of (targetChat.tasksIn || []).slice(-5)) {
    const requester = loadChat(t.from);
    const open = (requester.tasks || []).filter((x) => x.jid === targetChat.jid && x.status === "sent");
    if (!open.length) continue;
    for (const task of open) {
      task.status = "replied";
      task.repliedAt = Date.now();
    }
    const who = targetChat.profile?.name || targetChat.profile?.number || targetChat.jid.split("@")[0];
    addCrossNote(requester, {
      fromJid: targetChat.jid,
      fromName: who,
      kind: "answer",
      what: `${who} replied to the message you asked me to send: "${String(incoming).slice(0, 140)}"`,
    });
    requester.history.push({
      role: "assistant",
      content: `(${who} bales pesan yang aku kirim buat kamu: "${String(incoming).slice(0, 140)}")`,
      ts: Date.now(),
    });
    saveChat(requester);
    log(`task reply → told ${requester.jid}: ${who}`);
    hits.push({ requester: requester.jid, who });
  }
  return hits;
}

/** Prompt block: what she recently did for this person. */
export function tasksBlock(chat) {
  const recent = (chat.tasks || []).filter((t) => Date.now() - (t.at || 0) < 24 * 3600 * 1000).slice(-3);
  if (!recent.length) return "";
  return [
    "## Yang BARU kamu lakuin buat dia",
    ...recent.map((t) => {
      const status = t.status === "replied" ? "sudah dibales" : t.status === "sent" ? "terkirim, belum ada balesan" : t.status;
      return `- Kamu kirim ke ${t.to}: "${t.text}" (${status}).`;
    }),
    "Kalau dia nanya, kamu TAHU kamu udah kirim itu. Jangan bilang lupa, jangan ngarang hasilnya.",
  ].join("\n");
}
