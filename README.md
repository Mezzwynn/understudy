# Understudy

![Understudy](dashboard/logo.png)


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

## When it stops being roleplay

`CRISIS_WATCH` looks for signals that someone is in danger (self-harm, talk of not wanting to be
here, in Indonesian and English). It is a keyword detector, not a clinical tool, and it does
exactly two things:

1. **She drops everything.** Gengsi, sulking, silent mode and her sleep schedule all stand down;
   she is told to stay present, ask where they are, and not to lecture, counsel, or recite
   hotlines. Her first reply is short and real — *"hey. hey. / don't say that / what happened.
   talk to me"* — and she stays thawed for half an hour.
2. **The owner gets a phone notification** with the message, so a human can actually act
   (`CRISIS_NOTIFY`). That is the point: a bot can keep someone company, only a person can help.

Verified in the smoke suite: a crisis message while she is in silent mode still gets an answer
(1 of 5 cases, `rp smoke --live`).

## Human imperfections

- `MOOD_RESIDUE` — yesterday does not vanish overnight. A day that ended furious or glowing
  starts halfway back to normal: `valence -0.60 → -0.15, patience 0.15 → 0.38`, and the log says
  which chat carried what.
- `MISREMEMBER_CHANCE` — occasionally she is fuzzy about small things (a time, which day, the
  order of events) or asks again about a minor detail. Never about names, health, boundaries or
  anything sensitive; the prompt says so.

## Regenerating her day

"Regenerate" used to roll a whole new day and throw away the morning you had already
lived through. Now it keeps the blocks that are over and the moments that already
fired, asks the model to plan **only from the current time onward**, and trims
overlapping blocks (the model sometimes produced 22:30-23:30 and 23:00-00:30 for the
same evening).

## Topic reactions

Two lists per character (Humor & interest) that are matched against every incoming
message, with a few cross-language bridges so an English topic still catches Indonesian
chat ("cat" ⟷ "kucing"):

- **a favourite topic** → she gets livelier, writes a bit more, teases, may ask a follow-up
- **a boring topic** → flat and short, no pretending to care
- **a memory boundary** is touched → she visibly goes colder and changes the subject,
  without ever explaining why

## Her week

`WEEK_DIGEST` builds a recap from data she already has: the themes of her last days, the
moments she still remembers, and the real events that happened. It shows up as a card in
the Character tab, as a Sunday-evening phone notification, and as two private lines in her
prompt — so she can say *"this week was mostly client stuff"* like a person with a life
instead of only ever reacting.

## She sleeps

Quiet hours used to silence only the proactive side: a message at 3am still got an instant,
fully composed answer, which is the least human thing this bot did. Now (`SLEEP_MODE`):

- during quiet hours **most messages get no reply at all** — she is asleep and it waits until
  morning (the chance she stirs is `SLEEP_REPLY_CHANCE`, and it drops the deeper the sleep)
- **anything health or safety related always wakes her up**
- if she does answer, she is groggy: short, slow, half-awake, may misread, may doze off again,
  and she will not send a voice note or a sticker at 4am
- in the morning she can own the gap instead of ignoring it: *"you messaged at 3:30. i saw it
  now."* — the prompt tells her, so she does not pretend nothing happened

## Not asking the same thing twice

Her own questions are recorded (`chat.asked`) and the prompt lists the ones from the last week
with "do not ask this again — ask a different side of it, or wait for them to tell you". People
do not re-ask what they asked on Tuesday.

## Cost safety valve

`BUDGET_GUARD` counts model calls per day across every provider and stops at
`LLM_DAILY_CALLS_MAX` (400 by default), logging and sending a phone notification once. A stuck
retry loop cannot drain a prepaid balance overnight while you sleep — it just goes quiet until
the next day.

## Real things happen to her

Conversations are not the only input. `src/events.mjs` records things that happen *to her*,
and they change her state immediately rather than being shrugged off:

| Event | When it fires |
|---|---|
| `spam` / `blocked` | a stranger sends something weird; and again if it ends in a block |
| `ai_accused` | someone asks her straight out whether she is an AI |
| `health_scare` | you tell her you are not okay |
| `promoted` | a stranger behaves and turns out to be alright |
| `milestone` / `errand` | anniversaries, and errands she ran for you |

Each one nudges the mood of **every** trusted chat (a manual mood lock still wins), can drop a
**live moment into today's routine** — so "someone weird messaged me" becomes part of her day
rather than a footnote — and is fed to the prompt for the next few hours, so she can bring it up
with anyone, in her own words. Durable events also land in memory through the tracker.

```bash
rp events                       # what has happened to her
rp events --add "the neighbour started drilling" spam
rp events --clear
```

The Character tab shows the same list. `LIFE_EVENTS` in Features switches the whole thing off.

## Humour and interest

Two character traits that shape how she talks, stored per character in
`personas/<slug>.traits.json` and visible in the Character tab.

**Humour** — style (dry, deadpan, teasing…), how often a reply carries a joke (a percentage,
so it is a flavour and not a stand-up routine), whether dark humour is allowed, lines that
sound like her (reference only), and the things she must never joke about. She is told not to
be funny at the wrong moment: if you are upset, the humour switches off first.

**Interest** — how curious she is about your life (a percentage: ask questions and dig, or
mostly react), whether she asks at all, what lights her up, and what bores her (she answers
those flat and short). She is also told that interest must not be fake — if something matters
to you, she listens even when the topic is not hers.

Both are **manual** (edit the fields), **automatic** (`Generate` works them out from the card
and the backstory, or just ask the agent: "make her joke more", "what would she care about?"),
and **switchable** off entirely from Features.

Interests also **learn**: the tracker may add a topic you brought up that she clearly enjoyed,
and those appear under "learned from your conversations".

## Reading and steering her head

**Chat tab** — the whole stored conversation per contact, searchable, with day separators and
markers for what she deleted or sent on your behalf. (Older messages get folded into the
running summary, so what you see is what she can still recall verbatim.)

**Memory editor** — the same tab, under the conversation: her facts, boundaries, plans and
jokes, each one deletable, plus the relationship note and the running summary. Press ★ to **pin**
an entry — pinned lines survive the automatic memory rewrite, so a fact you care about cannot be
quietly dropped when the transcript ages out.

## Taking her offline

Settings → **Take her offline**: pause for an hour, eight hours, a day or three days, with an
optional reason. While paused she reads but never answers, never messages first and stops all
check-ups. The reason is remembered, so when you switch her back on she knows she was away
("out of town, bad signal") instead of pretending nothing happened.

```bash
rp pause 8h "out of town"     # or 30m, 2d
rp resume
```

## Humanness check

`rp eval` runs a short adversarial conversation through the real reply path and has an
independent judge score how detectable she is (lower is better). The score is stored, so the
dashboard shows a trend in the Usage tab, and a **weekly automatic run** happens in the small
hours unless you switch `EVAL_WEEKLY` off.

```
suspicion : 22/100  →  human
tells     : deflects the accusation with a joke instead of earnestly denying
            short, clipped replies ("hm", "lol", "fine.") with high length variance
            stonewalls a conflict ("then stop texting me") instead of de-escalating
```

## Feature switches

Settings → **Features**: twenty switches, each of which actually gates its code path rather than
just the wording of the prompt.

| Switch | Off means |
|---|---|
| Backstory & cast | she has no past to reference |
| Her own daily routine | no generated day, no moments |
| Routine affects mood | a bad client does not sour her |
| She may message first | she only ever replies |
| Sulking & going silent | no nudge, no cold replies, no silence — she just answers |
| Soft window | no sudden warmth, no "forget what i said" |
| Promises & follow-ups | nothing to report back on |
| Checks up on eat / sleep | she stops asking whether you ate |
| Cross-chat notes | contacts stay fully sealed from each other |
| Errands | you cannot ask her to message a third number |
| Guard & block strangers | no spam scoring, no warnings, no blocking |
| Semantic memory | facts still stored, but no recall by meaning |
| Milestones / presence / read receipts / mood-driven media / sticker reuse | as named |
| Prompt-injection guard | only turn this off while testing |

Booleans are written to `.env` as `true`/`false`, and `1`/`on`/`yes` are still accepted if you
hand-edit the file. `rp test` includes `scripts/featuretest.mjs`, which proves each switch really
changes the prompt (it once did not: `.env` said `WORLD=true` while the running process read
`false`, because the dashboard wrote `1` and the config compared against the string `"true"`).

## Dashboard

`rp dash` → http://127.0.0.1:8787, a single-file dark UI (no CDN, works offline).

- **Contacts** — per contact: avatar, tier badge, live stats, a mood **radar**, the six
  dimensions as bars, a collapsible valence history, the last few messages rendered as
  chat bubbles, where her day is right now, pending errands and cross-chat notes. Mood has
  two modes: **Auto** (the tracker decides) and **Manual** (sliders that LOCK her mood until
  you press Auto). Editing never fights the auto-refresh.
- **Character** — identity fields, the full personality card, backstory & cast, extra
  context notes, today's routine, and export/import/delete.
- **Agent** — the OOC setup assistant (see above).
- **Schedule** — a 24-hour timeline (awake window, quiet hours, the slots she may message
  first, a marker for now) plus the editor and auto-generate.
- **Settings** — every behaviour knob, grouped and searchable, with unit hints.
- **Usage** — rings for photos, voice characters and ElevenLabs remaining, plus per-provider
  token usage. **Log** — colour-coded, filterable.

**Look**: one fixed palette — a soft dark warm theme (deep charcoal-brown with amber and
yellow accents). No theme switching, no colour pickers: fewer moving parts, nothing to break.

Saving applies immediately: `reloadConfig()` re-reads `.env` into the running process and the
persona card is read from disk on every reply, so there is no restart step. The only restart
button is in Settings.

## Schedule and extra context

**Message-first schedule** (per character). The Schedule tab is an editor now: add or remove
slots freely, with `11` meaning "a random minute inside that hour, different every day" and
`20:30` meaning that exact minute. **Auto-generate** asks the model for a pattern that fits her
waking hours, her job and her personality, and explains why. Active hours and work hours are
editable there too.

**Extra context** (per character, in the Character tab) — free-form notes you want her to keep
in mind: *"she is moving house this month"*, *"it is rainy season here"*, with an optional
expiry date. They are injected as **additive** context, and the prompt says so explicitly: the
character card, the live mood, the relationship and every other rule still win. She is also
told not to announce them or use them as an excuse to break character.

Both, plus the backstory, the cast and the relationships, can also be set by telling the agent
("move her schedule later", "she is touring this week", "let the model pick the hours").

## Backstory, cast and relationships

Two things keep her consistent across a long conversation (and across contacts):

**Her world** (`src/world.mjs`, stored in `personas/<slug>.world.json`)
- a backstory: where she comes from, what shaped her, what she would never say out loud
- a cast: the people she actually deals with — family, a companion, coworkers — each with how
  she would describe them and one detail that keeps them from drifting
- for a **canon character** it is generated from the source material (real family, companions),
  for an **original character** it is invented from the card. Both can be edited by hand in the
  Character tab, or by asking the agent. Exports carry it, so a shared character keeps its world.

**Who you are to her** (per contact, `chat.relation`)

| | |
|---|---|
| chat | partner, spouse, ex, friend, best friend, sibling, parent, child, relative |
| work | coworker, boss, employee, client, mentor, student |
| other | neighbour, rival, not defined yet |

Each preset carries a tone instruction, so she is warm with a partner, professional with a
client, respectful with a parent or a boss, guarded with an ex or a rival — without turning into
a different person. Set it from the dashboard contact card, or just tell the agent
("make Hik my partner", "she should be polite with this one").

Both are injected into the system prompt as private context: she may mention her sister once if
it fits, and she must never dump her whole backstory or introduce her cast to you.

## Her own day (routine)

Every day she gets a generated day plan: hour blocks (what she is doing, where) and a
handful of emotional moments at specific times (`fun`, `annoyed`, `sad`, `scared`,
`proud`, `tired`, `sweet`, `awkward`).

- The plan is **global per character** — one person has one Monday, so everyone she talks
  to sees the same day (`data/routine/<slug>.json`).
- A moment that comes due nudges her mood (gently, once) for **every** chat she is in.
- It gives her something new to talk about, so she stops recycling "did you eat?".
- Storage: today's plan, the last 3 days (`ROUTINE_KEEP_DAYS`) and then only the
  **highlights** survive. Ordinary days are deleted.
- `rp routine` · `rp routine --new` · `rp routine --history`

## Three tiers: stranger → acquaintance → trusted

| | stranger | acquaintance | trusted |
|---|---|---|---|
| tone | cold, guarded | normal, still distant | the full character |
| pet names | never | never | yes, mood-gated |
| voice notes / stickers / photos | no | no | yes |
| messages first | no | no | yes |
| remembers your business | no | partly | yes |

A brand new number gets asked **who they are** ("hey / who's this", "i asked first") until
they introduce themselves. Say who you are, behave, and after
`STRANGER_PROMOTE_AFTER` messages she treats you like someone she just met.

**Spam gets warned, then blocked.** Every message from a non-trusted contact is scored
(links +2, scam/loan/gambling words +3, asking for a code +4, sexual solicitation +3,
broadcast wording +2, repeating itself +2, flooding +2). At `STRANGER_WARN_SCORE` she sends
**one** warning; at `STRANGER_BLOCK_SCORE` the number is blocked on WhatsApp. Trusted
contacts are never auto-blocked.

## Cross-chat context (referrals)

Contacts are sealed by default — she never mixes two people up and never gossips. The single
deliberate exception: when someone says *"a friend gave me your number"*, she asks that friend.

1. the stranger's chat records: waiting for them to confirm
2. the referrer's chat gets a note: someone claims you gave them my number — ask them
3. whatever the answer is, it lands back in the stranger's chat (confirmed → they become an
   acquaintance; denied → it counts against them)

Any mention of another known contact creates a note in that person's chat, not only referrals.

## Errands (message a third number for you)

Say *"order food for me on this number"* and she does it — and remembers doing it:

- the action is written into her own history, so summarising can never lose it
- the target's chat gets the real message plus why it arrived
- when they reply, you get a note: *"Warung Geprek replied: iya kak, 25 menit lagi"*

Only trusted contacts can ask, codes/passwords are refused, and there is a daily cap
(`TASK_DAILY_MAX`).

## Sharing characters

```bash
rp persona export fiona             # -> fiona.character.json
rp persona import fiona.character.json --apply-settings
rp persona delete fiona             # moved to personas/.trash/
rp persona trash / restore <file>
```
The dashboard has Export / Import / Delete buttons in the **Character** tab. A bundle carries
the card **and** the behaviour settings tuned for it; stickers and chat data are never
included. Import validates the format, and a taken name gets a `-2` suffix instead of
overwriting. Delete is always recoverable from `.trash/`.

## Text and voice are separate

Voice rules used to live inside the character card, so they leaked into every text reply and
she started writing `[soft]` in normal messages. Now:

- `prompt/voice.md` — the engine-level voice rules, injected **only** when a voice note is
  actually being made
- the card's `## Voice rules` section is split out at load time (`persona.card` vs
  `persona.voiceCard`)
- **a voice note is never one or two words** — spoken out loud that sounds broken. Aim for
  2–5 sentences. Short belongs in text.
- the exception: genuine nerves. `a— aku... [pause] no, forget it.` is allowed and welcome.
- a code guard (`voiceLongEnough()`) sends a planned voice note as **text** if it comes out
  under 7 words with no stammer, so you never receive a weird two-word voice note.

## The config agent (OOC)

A dashboard tab where you talk to the setup assistant in plain language ("make her reply less
often", "inject a routine for today", "add to her personality: she loves black coffee").

It can change behaviour settings, the personality card, the routine, schedules, the active
character and per-contact nicknames. It **cannot** touch code, files, API keys, ALLOW/TRUSTED
lists, or delete anything — that is enforced in code by an allowlist, not by the prompt.

## Testing

```bash
rp test            # everything below
rp lint            # identifiers that are called but never imported/defined
                   #   (also checks that every element id the dashboard script
                   #    uses still exists in the markup)
rp smoke           # the whole reply path with a fake socket, no model calls
rp smoke --live    # same, with the real model (costs a few calls)
rp turing          # humanness eval against an independent judge
```

`rp lint` exists because of a real incident: a missing import
(`ReferenceError: decide is not defined`) passed `node --check` and every unit test, and the
only symptom was that she silently stopped answering anyone — the bot looked alive.

The config agent runs as a background job: the request returns immediately and the page polls
for the result, so a slow model can never look like a timeout (the UI shows the elapsed
seconds and how long the finished job took).

`rp smoke` pushes real messages (owner, new stranger, spam, a mention of another contact)
through the actual router with a fake WhatsApp socket, using a throwaway
`UNDERSTUDY_DATA_DIR`, and fails if a case throws or produces no reply. It also asserts the
persona actually loaded, after a botched edit left `persona.name === undefined`.

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
src/
  index.mjs         entry point (WhatsApp + schedulers + dashboard)
  router.mjs        decides what happens to an incoming message
  engine.mjs        builds a reply, applies the tracker control block
  prompt.mjs        the system prompt (state, mood, memory, routine, cross-chat)
  mood.mjs          six-dimension mood + circadian drift
  affect.mjs        the separate tracker model (mood, memory, tasks)
  routine.mjs       her own day, global per character
  stranger.mjs      stranger/acquaintance tiers, spam scoring, blocking
  links.mjs         cross-chat notes (referrals)
  tasks.mjs         errands: message a third number and remember it
  persona-io.mjs    export / import / delete characters
  admin.mjs         the OOC config agent (allowlisted actions)
  texting.mjs       bubbles, typing, typos, delays
  voice.mjs         ElevenLabs / Gemini TTS + toSpeakable()
  guard.mjs         injection, meta-leak, filler-tic guard
  image.mjs vision.mjs embed.mjs store.mjs llm.mjs whatsapp.mjs
  dashboard.mjs     the local web dashboard
prompt/engine.md    global roleplay rules (text)
prompt/voice.md     rules for spoken replies (voice only)
personas/           character cards (character.md is the blank starter)
dashboard/          the dashboard UI (single html file)
scripts/            setup, character, config, contacts, mood, routine, voice, sticker, persona
assets/stickers/    .webp stickers sent at random
data/               auth, chats, routines, state (gitignored)
install.sh          one-command installer
rp                  the CLI (symlink it anywhere)
.env.example        all settings with defaults
```

Commands:

```bash
rp start | stop | restart | status | log | last | number
rp character        create a character (guided by the model)
rp config           behaviour settings (auto / manual)
rp routine          her day: today | --new | --history | --at HH:MM
rp persona          list | use | new | export | import | delete | trash | restore
rp contacts | mood | sticker | voice | stats | doctor
rp test | turing | bench | dash | sync | boot | watchdog
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
