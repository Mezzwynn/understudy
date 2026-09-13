# Photos — the plan, before any code

The hardest feature left, and the only one where being wrong is not a matter of opinion.

Text can be wrong and it still reads as a person. A photo is checked once, instantly, by a
brain that has looked at ten thousand photos. There is no second attempt.

This document is the plan. Nothing here is wired into the bot yet.

---

## 1. What we actually measured (not guessed)

Tests run on this device, 14 Sep, with the real key and the real models.

| Test | Result |
|---|---|
| Selfie, prompt written for realism (mess, noise, imperfect framing) | **9.5/10** — "a stranger would have zero reason to doubt this is a real person", no artifacts found |
| Table scene (coffee, food, laptop), same care | **6/10** — melted text on stickers, a fork that does not exist, "mushy" food, dreamy background people, repeating wood grain |
| Same woman, second scene, first photo passed as reference | **2/10** — "not the same person" |
| Same woman, second scene, reference + a written identity description + the pro model | **4/10** — still "not the same person", plus "AI hands" on the phone |

Cost and speed from those runs: **$0.067** per image (flash, 13-17s), **$0.139** (pro, 29s).

Three conclusions, and the third is the one that matters:

1. **A single photo is already good enough.** The "is this AI" problem is a prompt problem, and
   it is solvable. Realism comes from what is *wrong* in the frame: noise, a crooked angle, a
   shadow in the wrong place, a hair tie on the table. Ask for a clean photo and you get plastic.
2. **Identity does not hold.** Not with a reference photo, not with a reference plus a written
   facial description. The judge put it plainly: *"a friend would immediately notice these are
   not the same person; they might even say cousins"*. Two photos of the same fictional woman,
   taken a week apart, is exactly the case a real chat gets tested on.
3. **The judge is not a pass/fail instrument.** The same photo scored 9.5/10 when asked "does
   this read as real" and produced a list of faults when asked "find the tells". Any measurement
   here has to be **blind and comparative** — a stack of photos with real phone photos mixed in,
   "which of these are generated" — not a yes/no.

So the plan cannot be "generate a photo of her when she feels like it". That path fails on
identity, fails on cost (every photo paid for), and fails on consistency over months.

---

## 2. The plan: a library, not a generator

Real people do not generate new photos either. They send the same handful: three selfies, the
cat, the food they always order, one photo of the sunset they took last week. Repetition is
human; infinite novelty is not.

### Layer 0 — the profile picture (one image, do this first)

A real contact has an avatar; a blank one is the first tell, and for a client like Olivia it is
the only photo that gets looked at repeatedly. **One** image, so identity consistency does not
even apply. Highest realism gain per rupiah of the whole feature.

### Layer 1 — the texture library (no face, no identity problem)

Coffee, food, a desk, rain on a window, a street at night, the cat, a scooter, a pile of
laundry. These are what most photos in a real chat actually are — and they carry **no identity**,
so they cannot be "wrong" the way a face can. Cost per image is the same, but they are made once
and used forever.

**Come from two sources:**
- **The real camera.** The best photo is a real photo: zero AI tells, zero cost, no judge needed.
  A short list of what to photograph ("kopi, hujan, jalan malam, meja kerja, kucing") and one
  shooting session fills this library for good. *(Needs Hik's phone pointed at things, and his
  consent for each photo that leaves the device.)*
- **Generated**, for what cannot be photographed (her own food at a warung in Denpasar, a Bali
  street), reviewed and approved once.

### Layer 2 — the face library (curated, fixed)

Generate on demand only inside a **curation session** in the dashboard: make 6-10 candidates for
one shot, pick the one that is right, and it joins her permanent library. From then on she *sends*
those photos, she does not generate them.

- a selfie she sends when asked (once) — the tsundere version: *"yaampun. gini doang."*
- one "at the office, ugh" photo
- one "momo is on my laptop again"
- one morning / no-makeup photo
- one dressed-up-because-client photo

Five good photos, reused over months, is how people actually behave. And every one of them is a
photo the user has already seen and approved — nothing goes out unseen.

### Layer 3 — new photos of her, only when trained (optional, needs a decision)

The only reliable way to a *new* photo of the same fictional face is a dedicated model trained on
her: **15-20 approved images → a LoRA**. That needs a machine with a GPU (this phone cannot) and
a paid service (fal.ai / Replicate, roughly $2-10 once, then ~$0.01-0.04 an image). It also means
those 15-20 images have to come from Layer 2 first.

Verdict: **not now.** Layer 2 gives most of the value at a fraction of the cost. Revisit when
"she sent a photo I have not seen before" is actually missed.

---

## 3. The pipeline, when it exists

```
  trigger  →  pick from the library  →  the human-like dressing  →  send  →  log
             (or: generate, review, curate  — dashboard only)
```

**Triggers** (only these, all rare):
- a routine moment that is photographic and matches her current activity (from `routine.mjs`)
- mood: a terrible day is not the day for a selfie
- he asks — allowed **once**, then *"nanti ya"* (asking twice for a photo is itself a character
  choice: she is tsundere, she does not perform on demand)
- an event: sick → a blanket and a cup of tea, never her face
- never during quiet hours (same rule as voice notes and stickers)

**Dressing** (borrowed from how the text pipeline already pretends to be human):
- one photo per contact per day, at most, and ≈1 in 15 conversations
- send the photo *first*, then a short line — the way a person does
- sometimes a bad photo on purpose: blurry, thumb in the corner, *"eh kejepret hahaha"* — being
  bad is a stronger realism signal than being good
- the caption must not describe the photo ("ini kopi"): people send photos instead of describing
- reuse, and mention the reuse the way people do: *"yang ini dari kemarin"*
- **never**: documents, other people's faces, anything contradicting where she said she was, a
  perfect photo at an hour when the light cannot be perfect

**Re-encode before sending** (phone photo, not a render): resize the long edge to ~1600, JPEG
quality ~80, no metadata. WhatsApp re-compresses anyway, which helps, but the image should
already look like it went through a phone. Note: no image tools are installed on this device
(no ffmpeg, no ImageMagick, no sharp), so this step uses a pure-JS encoder or a package install —
decided at build time, not assumed.

**Reviewed before it goes**, with the reviewer's verdict shown in the dashboard, and — the honest
part — **measured as a blind test**: 10 real phone photos of the same kind, 5 generated, shuffled;
whoever is judging does not know which is which. Report the score like `rp eval` does for text. A
photo feature that cannot pass that test does not get switched on.

---

## 4. What I need from Hik before writing code

1. **Whose face?** I will only build this with a **synthetic** face. Using a real person's photos
   (scraped from anywhere) is impersonating a specific human being, and face search makes her
   findable — that is not a risk I will take quietly. If it is synthetic, I generate candidates
   and you pick the one that is her.
2. **Photos for Olivia?** She is a real person who does not know. Text is one thing; a face is
   what makes it a person to her. One photo changes the relationship more than a thousand
   messages. That is your call, not mine, but the dashboard will let you turn photos off
   **per contact** so the choice stays local.
3. **The camera session.** Two photos from the phone's camera already exist from my earlier test
   (`/sdcard/DCIM/Camera`, 13 Sep 19:37) — I will delete them if you want. For the texture
   library I need a small set of real photos, and I will ask before each thing leaves the device.
4. **Budget.** The library is a one-time spend: roughly **$1.50-3** for 20-40 images with retries.
   Runtime cost after that is **$0** per photo. The LoRA path (Layer 3) is a separate decision.

---

## 5. Order of work

| # | Step | Cost | Why first |
|---|---|---|---|
| 1 | Profile picture: generate, pick, set | ~$0.20 | One image, no consistency problem, biggest visible gain |
| 2 | The judge + the blind test harness | $0 | Without it, nobody can say whether this works |
| 3 | Texture library (real photos + a few generated) | ~$0.50 + a shooting session | Covers most real photo use, zero identity risk |
| 4 | In-chat sending rules (triggers, frequency, dressing) | $0 | The behaviour is where photos look human or not |
| 5 | Face library: a curation session in the dashboard | ~$1-2 | Faces are the minority of real photos, and the risky part |
| 6 | LoRA | $2-10 once | Only if new photos of her are actually missed |

Each step is verified the way the rest of this project is: real numbers, a reviewer that does not
know the answer, and `rp test` green before anything is claimed.

---

## 6. What this will not fix

- **A watermark exists.** Google images carry SynthID, an imperceptible mark that survives
  cropping and compression. WhatsApp does not scan or label photos and no ordinary person runs a
  detector — but I am not going to write "undetectable" anywhere, because it is not true.
- **The real tell is behaviour, not pixels**: how often, at what hour, in reply to what, with
  what caption, and whether the photo matches what she said she was doing. This plan spends most
  of its effort there, on purpose.
- **Identity cannot be perfect without training.** With a library it is perfect for the photos
  that exist, and absent for the photos that do not. That is the trade, and it is the right one.
