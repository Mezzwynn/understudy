/**
 * photo-check.mjs — the specific things that give a generated photo away.
 *
 * Hik caught the one that matters: a selfie where **her phone is visible in her hand**. If the phone
 * took the photo, the phone cannot be in the photo — seeing it means the image is a picture *of*
 * someone holding a phone, taken from somewhere else. It is the clearest proof of a third-person
 * point of view, and no amount of "make it look natural" in the prompt prevents it.
 *
 * So every photo is checked against a short list of impossible things before it can be sent, and the
 * library can be audited with the same list.
 */
import fs from "node:fs";

const JUDGE = "google/gemini-3.1-flash-lite";

const CHECK = `This photo is either (a) a photo a young woman took of her own things — her desk, her food, her cat, a street — with her own phone, or (b) a photo she took of herself at arm's length.

First decide which case it is, THEN judge only what applies.

{"has_person": true|false, "phone_visible": true|false, "third_person": true|false, "professional": true|false, "problems": ["..."], "note": "one line"}

Rules:
- has_person: is a person visible in the photo (other than a stranger far in a blurred background)?
- If has_person is FALSE, third_person must be FALSE and phone_visible should normally be FALSE: a photo of a table or a cat cannot show the phone that took it, but there is no point of view to get wrong either. Judge only: does it look like an ordinary snapshot (not a professional, wide, composed or brochure photograph), and are the objects physically possible?
- If has_person is TRUE, apply all of it: phone_visible (is a phone, hand holding a phone, screen or camera visible in the frame? it cannot be — the phone took the photo), third_person (does it look like somebody else stood there and photographed her: full body from across a table, posed for the camera, both hands free, front view from a distance?).
- professional: bright, wide, composed, "editorial" or brochure-like rather than an off-hand phone snapshot.
- problems: physical impossibilities only (deformed hands, extra fingers, a keyboard that makes no sense, mirrored text, impossible reflections, floating objects).`;

async function ask(file, key, avatarFile = null) {
  const b64 = fs.readFileSync(file).toString("base64");
  // with her avatar first, the checker can tell "a stranger in the frame" from "SHE is in the frame"
  const withFace = !!(avatarFile && fs.existsSync(avatarFile));
  const facePart = withFace
    ? [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(avatarFile).toString("base64")}` } }]
    : [];
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(90000),
    body: JSON.stringify({
      model: JUDGE,
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: [
            ...facePart,
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
            {
              type: "text",
              text: withFace
                ? `Photo 1 is the woman in question (her face, for reference). Photo 2 is the photo being checked.\nAnswer "has_person": whether SHE (photo 1) is in photo 2. Other people in photo 2 are strangers and do not count — strangers in the frame are normal and fine. Only if SHE is in the frame do the point-of-view rules apply.\n\n${CHECK}`
                : CHECK,
            },
          ],
        },
      ],
    }),
  });
  const j = await r.json();
  const txt = j.choices?.[0]?.message?.content || "";
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, problems: ["pemeriksa tidak menjawab"], note: txt.slice(0, 120) };
  try {
    const v = JSON.parse(m[0]);
    const problems = Array.isArray(v.problems) ? v.problems.filter(Boolean) : [];
    return {
      ...v,
      problems,
      ok: !v.phone_visible && !v.third_person && v.pov_ok !== false,
    };
  } catch {
    return { ok: false, problems: ["jawaban tidak terbaca"], note: "" };
  }
}

/** Check one photo. Returns { ok, phone_visible, third_person, problems, note }. */
export async function checkPhoto(file, { apiKey = null, avatar = null } = {}) {
  const key =
    apiKey ||
    (() => {
      try {
        return (fs.readFileSync(".env", "utf8").match(/^OPENROUTER_API_KEY=(.+)$/m) || [])[1]?.trim();
      } catch {
        return "";
      }
    })();
  if (!key) return { ok: true, problems: [], note: "no checker key — skipped" };
  if (!fs.existsSync(file)) return { ok: false, problems: ["file missing"], note: "" };
  return ask(file, key, avatar);
}
