# Understudy

A standalone **WhatsApp roleplay agent** — no framework, just Node + Baileys + any
OpenAI-compatible LLM.

Built to be *hard to tell apart from a person*: a strong persona, a live mood,
human texting habits and a sulking streak — and it **never breaks character**,
even when someone asks if it is an AI.

```
you:  are you AI?
understudy: u do?
you:  serius, buktiin dong
understudy: u first.
```

---

## Install (4 steps, no character writing)

```bash
git clone <Mezzwynn> understudy
cd understudy
./install.sh                 
```
```bash

rp setup                     # 1. connect an AI model (API key only)
rp start                     # 2. link WhatsApp (scan the QR)
rp character                 # 3. create the character (the model writes it)
rp config                    # 4. behaviour settings: auto or manual
```

You only ever paste **an API key**, scan **a QR**, and type **a name** — the model
writes the character and picks the settings.

---

## 1 · Connect a model (`rp setup`)

```
  1) Google Gemini      (free tier, great Indonesian roleplay)
  2) DeepSeek           (cheapest, strong Indonesian)
  3) OpenRouter         (one key, many models: Claude, Hermes, …)
  4) OpenAI             (GPT)
  5) Custom             (any OpenAI-compatible: local, Ollama, LM Studio)
```

It tests the connection and writes `.env` (model + tracker + judge). A Google AI
Studio key is optional but unlocks **reading photos, transcribing voice notes,
sending voice notes, and selfies**.

---

## 2 · Link WhatsApp (`rp start`)

Prints a QR — scan it from **WhatsApp → Linked devices**.

```bash
rp start | rp status | rp log | rp stop | rp restart
rp boot        # auto-start after reboot (Termux:Boot app)
```

---

## 3 · Create the character (`rp character`)

The model writes the whole card, and the prompt is deliberately **strict about
fidelity** — the result should feel like the real character, not a friendly
assistant.

```
  Mau bikin karakter dari mana?
   1) Film / anime / game / buku   (kasih nama + judulnya)
   2) Orang nyata / tokoh publik
   3) Deskripsi bebas
   4) Bikin dari nol (tanya-jawab singkat)
```

For **1** and **2** you only type the name and the source — the model does the
rest:

```
Nama karakter : <nama>
Judul karya   : <film / anime / game / buku>
```

What gets generated:

- speech habits (pronouns, verbal tics, slang, language mix)
- **emotional range** — how they get angry, sad, shy, loving, and what they hide
- contradictions that make them feel real
- relationship with you, and how easily they warm up
- limits: what makes them sulk, disappear or go cold
- 8–10 example lines that actually sound like them
- voice settings (ElevenLabs v3 audio tags, voice style, appearance for photos)
- `active_hours` + a 10-slot `chat_schedule` in their own rhythm

Saved to `personas/<slug>.md` and activated immediately.

> Fully custom characters work too — mode 3 and 4 just take a short brief.

---

## 4 · Behaviour settings (`rp config`)

- **Auto** — the model reads the card and proposes values: a cold character gets
  fewer emojis and longer sulks, a busy one gets fewer proactive messages and
  longer delays. It prints the table, you confirm.
- **Manual** — one prompt per setting, with the auto suggestion as the default.

```bash
rp config show | rp config auto | rp config manual | rp config reset
```

Covers: voice-note chance, reactions, quoting, typos, bubbles, long delays,
photos, stickers, sulk timings, and how long a silence is before she texts first.

---

## 5 · Dashboard (`rp dash`)

A tiny local web UI (no dependencies, bound to `127.0.0.1`) so you can manage
everything from the phone instead of the CLI:

```bash
rp dash          # prints the URL and opens it
# or open http://127.0.0.1:8787 manually
```

| Tab | What you can do |
|---|---|
| **Kontak** | live mood bars + sulk state · **mood: Auto (the model reads the chat) → press Manual and the same block turns into sliders that LOCK her mood until you press Auto again** · trusted toggle · nickname & per-contact character · search · "chat duluan sekarang" · reset context |
| **Setting** | edit all behaviour knobs, `active_hours`, `chat_schedule`, switch character, **Auto (model decides)**, **Restart bot** |
| **Jadwal** | today's resolved chat slots (dynamic minutes) and which one is next |
| **Kuota** | tokens per provider today, photo/TTS budget, ElevenLabs quota |
| **Log** | last 60 log lines |

Want it from another device? Set in `.env`:

```ini
DASHBOARD_HOST=0.0.0.0
DASHBOARD_TOKEN=some-long-secret     # then use http://<phone-ip>:8787/?token=...
```

> After changing settings, hit **Restart bot** (or `rp restart`) so they take effect.

---

## Features

**Character**
- Persona card as permanent canon, generated from a name + source.
- Identity lock + a **guard** that regenerates (or deflects in-character) if the
  model leaks AI/meta language.
- Short, messy WhatsApp texting: lowercase, slang, no markdown.

**Live mood**
- Six dimensions: `valence`, `energy`, `arousal`, `affection`, `patience`,
  `playfulness` — drifting with the time of day and how long you've been silent.
- Updated by a **separate JSON tracker** call, so it stays reliable even on
  small character models.

**Human behaviour**
- 1–3 short bubbles with real typing pauses; occasional typos, sometimes
  self-corrected.
- Sometimes **leaves you on read**, sometimes just **reacts**.
- Random distracted delays, non-instant read receipts, quoted replies.
- **Texts first** on her own schedule (with jitter, quiet hours and her own
  active hours), then escalates: *nudge* → `ok fine.` → **dry texting**
  (`y.` `h.` `k.`) → total silence until you genuinely apologise.
- Walks away when insulted; the nickname disappears while she's cold.

**Media**
- In: photos described, voice notes transcribed.
- Out: voice notes (ElevenLabs v3 with tags like `[sighs]` `[dryly]`, or Gemini
  TTS), photos, stickers.
- Shows **online only during her active hours**.

**Per-contact everything**
- Each contact has their own profile (name, nickname, number, notes), history,
  mood and memory. Contacts never mix.
- Optional different character per contact: `rp contacts set <number> persona <slug>`.

**Ops**
- `rp status` / `rp stats` — token usage, photo/TTS budget, ElevenLabs quota.
- `rp test` — offline brain test (sends nothing).
- `rp turing` — adversarial humanness test judged by an independent model.
- `rp bench` — compare character models with the same judge.

---

## Requirements

- **Node.js 18+** (tested on Node 26, Android/Termux)
- **git** (Baileys pulls `libsignal` from GitHub)
- Optional media tools: `opusenc` (`pkg install opus-tools`), `cwebp` (`pkg install libwebp`)
- A phone with WhatsApp
- Any OpenAI-compatible LLM API key

> Termux/Android: use **Baileys 6.7.x**. Baileys 7.x needs the native
> `whatsapp-rust-bridge`, which is painful on Android.

---

## All commands

```bash
rp setup | rp character | rp config        # the guided setup
rp start | rp stop | rp restart | rp status
rp log | rp last [n] | rp number | rp boot
rp stats                                   # quota + usage

rp persona list | rp persona use <slug> | rp persona new <name>
rp contacts list | rp contacts set <num> name|nick|persona|notes <value>
rp mood list | rp mood nudge <num> fight|sweet|ignored | rp mood set <num> affection 0.8
rp reset <num|all> [--mood] [--all]

rp voice "teks"                            # preview a voice note
rp sticker --generate "prompt" [name]
rp test | rp turing | rp bench
```

Install `rp` globally (optional):

```bash
ln -sf "$(pwd)/rp" "$PREFIX/bin/rp"        # Termux
sudo ln -sf "$(pwd)/rp" /usr/local/bin/rp
```

---

## How it works

```
WhatsApp (Baileys)
   └─ router      filter → allowlist → debounce → media → text
        └─ engine  prompt → LLM → guard → mood/memory
             ├─ prompt.mjs   engine + persona + live state
             ├─ guard.mjs    anti-break-character, markdown/audio-tag stripper
             ├─ affect.mjs   mood + memory (separate JSON call)
             ├─ voice.mjs    TTS → Ogg/Opus PTT
             └─ image.mjs    photos, stickers
   └─ proactive    texts first on schedule + sulk escalation
```

State is plain JSON under `data/chats/<jid>.json` — easy to inspect and back up.

Key design choices:

- **Short, voice-first prompt.** Long rule lists make models sound like
  assistants; `prompt/engine.md` is compact and full of `BAD vs GOOD` examples.
- **Separate tracker.** Character model for the persona, a second cheap call
  (`TRACKER_*`) for structured mood/memory JSON.
- **Separate judge.** `JUDGE_*` independent from the character, so tests are fair.
- **Per-provider temperature.** Some models degenerate above ~1.0.

---

## Repo layout

```
src/                the agent (config, whatsapp, router, engine, mood, media…)
prompt/engine.md    global roleplay rules
personas/           character cards (character.md is the blank starter)
scripts/            setup, character, config, contacts, mood, voice, sticker, tests, bench
assets/stickers/    .webp stickers sent at random
data/               auth, chats, state (gitignored)
install.sh          one-command installer
rp                  the CLI (symlink it anywhere)
.env.example        all settings with defaults
```

---

## Notes, limits, ethics

- Baileys (WhatsApp Web) is **unofficial** and can break when WhatsApp changes
  its protocol.
- This links as an **additional device**. Don't run two bots on one number.
- If `ALLOW` is empty, **anyone** who messages the number gets a reply.
- Keep `.env` private (`chmod 600`) — it holds API keys.
- `DEBUG=true` logs conversation content to `rp.log`.
- The agent has **no file or shell tools** — a malicious message cannot reach
  your filesystem.
- Use it responsibly: don't impersonate real people for deception, and respect
  local law and platform terms.

---

## License

MIT — see [LICENSE](LICENSE).

## Memory hygiene

Long-term memory is rewritten, not just appended to:

- `remember` only accepts **durable** facts about the person (work, habits, health, family,
  preferences). Quotes of what they said and "he reacted annoyed" style trivia are filtered
  out in code, so a week of chatting doesn't bury the facts in noise.
- The periodic consolidation pass rebuilds the summary **and** the fact/plan/boundary/joke
  lists, merging near-duplicates ("don't call me honey" x5 becomes one line), dropping what
  is no longer true, and never inventing a name (the contact's real name is injected into
  the prompt).
- Bottoms up: facts ≤ 20, boundaries ≤ 12, plans ≤ 10, jokes ≤ 8. Fuzzy dedupe compares word
  sets, so reworded duplicates collapse instead of piling up.

## Language

`language:` in the persona frontmatter is now actually injected into the prompt
("BAHASA: …"). Before, it was parsed and ignored — she ended up copying whatever language
the prompt examples were written in.

## Trusted vs stranger

Two tiers, so a shared bot number does not treat the whole internet like a best friend.

```env
TRUSTED=628123456789           # comma separated, E.164. "*" = everyone
TRUST_STRANGERS=false          # true = old behaviour (everyone trusted)
BASELINE_TRUSTED=0.30,0.60,0.45,0.68,0.60,0.50
```

| | trusted | stranger |
|---|---|---|
| resting mood | warm (`Warm`) | flat and guarded (`Reserved`) |
| pet names | yes, mood-gated | **never** — not even if the model tries |
| voice notes / stickers / photos | yes | no |
| soft window (melting, then pulling back) | yes | no |
| promises & check-ups ("did you eat?") | yes | no |
| messages first (proactive) | yes | no |

New contacts start untrusted. Anyone listed in `TRUSTED=` is upgraded on their next
message (never downgraded automatically) — or flip it per contact from the dashboard.

**Why the resting mood matters:** it is where she drifts back to when nothing is
happening, so it defines what "normal" feels like for that person. A stranger rests at
`affection 0.30` (below the pet-name gate), so warmth has to be *earned*. Put it too high
and every contact starts out soft — which throws away the melting, the sulking and the
"don't call me that" moments.

```bash
rp restart      # one instance only: stop.sh also cleans up stray processes
rp status       # warns if more than one instance is alive (double replies!)
```
