/**
 * photos.mjs — the photos she could actually take herself.
 *
 * Two rules decide whether a generated photo is believable, and neither is about the model:
 *
 * 1. **She is holding the camera.** A photo of her working, taken by someone standing across the
 *    desk, is not a photo that can exist — nobody asks a friend to photograph them while they
 *    answer email. So every scene here is a selfie (front camera, arm's length) or a view from
 *    where she is sitting, looking at her own table.
 * 2. **She does not know the camera is there**, or she plainly does not care. Absorbed, caught
 *    mid-movement, not looking up, edges slightly out of focus. "Posing" was what made the first
 *    desk and warung attempts score 3/10.
 *
 * The wardrobe rotates so she is not wearing the same shirt in every photo — a person's photos
 * from a week do not show one outfit seven times.
 */
import { config } from "./config.mjs";

/** Monochrome-leaning, because her card says so, but not one shirt forever. */
export const WARDROBE = [
  "an oversized white shirt",
  "a plain black t-shirt and loose jeans",
  "a grey hoodie with the sleeves pushed up",
  "a faded denim jacket over a black tee",
  "a loose dark long-sleeve shirt",
  "a black blazer over a plain white shirt (a client day)",
  "a washed-out band t-shirt",
  "a simple black dress with a thin cardigan",
];

/** From the character's own card when it lists one, otherwise the default rotation. */
export function wardrobeFor(persona) {
  const raw = String(persona?.wardrobe || "").trim();
  if (!raw) return WARDROBE;
  const list = raw.split("|").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : WARDROBE;
}

/** Deterministic per day and per photo, so a single day's photos do not all share one outfit. */
export function pickOutfit(persona, seed = 0) {
  const list = wardrobeFor(persona);
  const day = new Date();
  const dayIndex = day.getFullYear() * 372 + (day.getMonth() + 1) * 31 + day.getDate();
  return list[Math.abs(dayIndex + Number(seed || 0)) % list.length];
}

/** The shared rules, kept in one place so every scene obeys them. */
const SELF_RULES = `She took this photo herself on her phone and she is NOT posing — caught mid-movement, not looking properly at
the camera or not in a hurry to get the shot right, framing slightly crooked, edges mildly out of focus, mild
phone sensor noise, an ordinary lived-in room or street behind her, not tidy, no filter. A real snapshot sent to
a friend, not a produced or staged photo. No text, no watermark.

IMPOSSIBLE THINGS — never draw these, they prove the photo is fake:
- the phone that took this photo is NEVER visible: no phone in a hand, no phone screen, no second device, no
  camera, no reflection of a phone. The camera is where the photo is taken from.
- she is the only person in the photo. Nobody else's face, hands or body, not even partly.
- if her face is in the frame she is holding the phone at arm's length herself: we see her from the front and
  close, the background directly behind her, one arm stretched toward the lens. NOT a full-body shot from
  across a table, NOT from a distance, NOT posed for a photographer, no free hands doing something else.
- no mirror, no visible lens, no viewfinder, no screen glow on her face that comes from a screen in the frame.`;

const KEEPS_HER = `Keep the same woman as the reference photo — the same face, the same features, the same hair, the same age.
Do not change her face, do not beautify or stylise her. Only the outfit and the place change:`;

/**
 * Scenes, each with two prompts:
 *   prompt     — text-to-image (no reference): describes everything
 *   editPrompt — with her real photo attached: keeps the face, changes only the setting
 * `self` marks the ones where she holds the camera, `view` the ones where her face is not in frame.
 */
export const SCENES = {
  "meja-pagi": {
    kind: "view",
    aspect: "4:3",
    time: "morning",
    what: "her own desk, seen from her chair — iced coffee, open laptop, earphones, a hair tie",
    prompt: (outfit) => `A phone photo taken by a 20-year-old woman in Denpasar, Bali in the morning, looking down at her
own desk from where she is sitting: an iced coffee in a plastic cup, an open laptop, earphones, a hair tie, a few
papers. She is wearing ${outfit} but her face is NOT in the frame — at most her forearm and a sleeve edge.
No other people, no hands reaching in, nothing posed, the desk not tidy. ${SELF_RULES}`,
    editPrompt: (outfit) => `${KEEPS_HER} she is at her own desk in the morning, wearing ${outfit}, photographed by her own
hand from where she sits: iced coffee in a plastic cup, an open laptop, earphones, a hair tie. Her face is NOT in
the frame. Not tidy, nothing posed. ${SELF_RULES}`,
  },
  "warung-malam": {
    kind: "view",
    aspect: "4:3",
    time: "night",
    what: "her own table at a warung at night — nasi campur, iced tea, the street behind",
    prompt: (outfit) => `A phone photo taken by a 20-year-old woman in Denpasar, Bali at night, looking down at her own table at
a small outdoor warung: a plastic plate of nasi campur, a glass of iced tea, a crumpled napkin. She is wearing
${outfit} but her face is NOT in the frame. The light is one harsh bulb above the table, the street behind is
dark with a blurred motorbike and a lit shop sign. ${SELF_RULES}`,
    editPrompt: (outfit) => `${KEEPS_HER} she is at her own table at a small outdoor warung at night, wearing ${outfit},
photographed by her own hand from her seat: a plastic plate of nasi campur, a glass of iced tea. Her face is NOT in
the frame. One harsh bulb above the table, the dark street behind. ${SELF_RULES}`,
  },
  momo: {
    kind: "view",
    aspect: "4:3",
    time: "any",
    what: "her cat, from where she is sitting",
    prompt: (outfit) => `A phone photo taken by a 20-year-old woman in Denpasar, Bali of her own cat: a grey and white street cat
lying on a closed laptop on a wooden desk, one paw hanging off the edge, a half-full glass of iced tea beside it.
Photographed from where she is sitting, slightly above, her own hand or sleeve edge possibly in the corner but her
face NOT in the frame. She is wearing ${outfit}. Indoor daylight, mild noise. ${SELF_RULES}`,
    editPrompt: (outfit) => `${KEEPS_HER} she is wearing ${outfit}, photographing her own cat with her phone from where she
sits: a grey and white street cat on a closed laptop, one paw off the edge. Her face is NOT in the frame, at most
her hand or a sleeve edge. Indoor daylight. ${SELF_RULES}`,
  },
  "selfie-siang": {
    kind: "self",
    aspect: "3:4",
    time: "day",
    what: "front-camera selfie in her room, daylight",
    prompt: (outfit) => `A front-camera selfie taken at arm's length by a slim 20-year-old Indonesian woman in Denpasar, Bali in
the afternoon. She is wearing ${outfit}. Shoulder-length straight black hair, no makeup, visible skin texture, a
small mole on her cheek, flat unimpressed expression, not posing for it. Indoor daylight from a window on the left,
a plain lived-in room behind her, one arm stretched toward the camera. ${SELF_RULES}`,
    editPrompt: (outfit) => `${KEEPS_HER} she is wearing ${outfit}, holding the phone at arm's length for a front-camera
selfie in the afternoon in her room in Denpasar, indoor daylight from a window on the left, a plain lived-in room
behind her, one arm stretched toward the camera, no makeup, flat unimpressed expression. ${SELF_RULES}`,
  },
  "selfie-malam": {
    kind: "self",
    aspect: "3:4",
    time: "night",
    what: "front-camera selfie at night outside, screen light and a street lamp",
    prompt: (outfit) => `A front-camera selfie taken at arm's length by a slim 20-year-old Indonesian woman at night outside a cafe in
Denpasar, Bali. She is wearing ${outfit}. Shoulder-length straight black hair, no makeup, tired but relaxed, half a
smile at most, not posing. Lit by a warm street light and the glow of the phone screen, a dark noisy background with
a blurred motorbike and a lit shop sign, one arm stretched toward the camera. ${SELF_RULES}`,
    editPrompt: (outfit) => `${KEEPS_HER} she is wearing ${outfit}, holding the phone at arm's length at night outside a
cafe in Denpasar, lit by a warm street light and the phone screen, a dark noisy background with a blurred motorbike
and a lit shop sign, no makeup, tired relaxed face, half a smile at most. ${SELF_RULES}`,
  },
  "jalan-pulang": {
    kind: "view",
    aspect: "4:3",
    time: "evening",
    what: "looking down at her own feet on the lane home",
    prompt: (outfit) => `A phone photo taken by a 20-year-old woman in Denpasar, Bali while walking home in the late afternoon: looking
down at her own feet and the cracked paving of a narrow lane, the hem of ${outfit} visible at the top of the frame, a
scooter parked ahead, warm low sun and long shadows. Her face is NOT in the frame and this is an accidental-looking
shot taken in a hurry while walking. ${SELF_RULES}`,
    editPrompt: (outfit) => `${KEEPS_HER} looking down while walking home in the late afternoon in a narrow Denpasar lane: her
own feet and the cracked paving, the hem of ${outfit} at the top of the frame, a scooter ahead, warm low sun. Her face
is NOT in the frame. ${SELF_RULES}`,
  },
};

/** The prompt for one scene, with the outfit she is wearing today (or one you pass in). */
export function scenePrompt(sceneId, { persona = null, outfit = "", edit = false, seed = 0 } = {}) {
  const scene = SCENES[sceneId];
  if (!scene) return "";
  const wear = outfit || pickOutfit(persona, seed);
  const fn = edit ? scene.editPrompt : scene.prompt;
  return fn(wear);
}

/** What she is wearing today, for anything else that needs to know. */
export const __wardrobeForTests = () => ({ wardrobeFor, pickOutfit, WARDROBE });
export const sceneIds = () => Object.keys(SCENES);
