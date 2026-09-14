/**
 * lifestyle.mjs — what her money and her class actually look like in a day.
 *
 * The routine generator was told "blocks must fit HER life" and still put an upper-middle-class
 * character at a warung eating nasi campur — because "ordinary Indonesian 20-year-old" is the model's
 * default, and nothing in the prompt said otherwise. Class is not decoration: it decides where she
 * eats, how she moves, what she does at 6pm, and what she would never be caught doing.
 *
 * The card can carry two lines:
 *   class: menengah ke atas
 *   lifestyle: apartemen sendiri di Vasaka | mobil sendiri, ogah naik angkot | kopi 40rb tiap hari
 *              | brunch weekend | gym 3x seminggu | warung cuma kalau kangen masa SMA
 *
 * Everything downstream — routines, places, photos, statuses — reads from here, so one line in the
 * card changes all of it at once.
 */
import { config } from "./config.mjs";

/** Bands, from the tightest to the loosest, with what each one means in practice. */
export const BANDS = {
  "bawah": {
    label: "working class / struggling",
    eats: "warung kaki lima, nasi bungkus, masak sendiri, air galon isi ulang",
    moves: "angkot, ojek online kalau kepepet, jalan kaki, motor pinjaman",
    home: "ngontrak kamar, kadang bareng keluarga, kipas angin",
    spends: "hitung-hitung uang, diskon selalu dilihat, jarang jajan di kafe",
    never: "cafe tiap hari, mobil sendiri, gym berbayar, brunch, liburan mendadak",
  },
  "biasa": {
    label: "lower middle class",
    eats: "warung langganan, sesekali kafe, gofood kalau lagi mager",
    moves: "motor sendiri, ojek online",
    home: "rumah orang tua atau kontrakan kecil",
    spends: "masih lihat harga, kafe sesekali bukan kebiasaan",
    never: "cafe premium tiap hari, mobil sendiri, gym mahal",
  },
  "menengah": {
    label: "middle class",
    eats: "kafe lokal, restoran mall, sesekali warung",
    moves: "motor atau mobil keluarga",
    home: "rumah ortu yang nyaman atau kontrakan bagus",
    spends: "kopi 25-40rb normal, belanja online biasa",
    never: "ngangkot, nasi bungkus tiap hari, hitung koin",
  },
  "atas": {
    label: "upper middle class and above",
    eats: "kafe dan restoran, brunch weekend, kopi specialty, warung hanya kalau sengaja nostalgia",
    moves: "mobil sendiri, taksi online, nggak pernah angkot",
    home: "apartemen atau rumah sendiri di kompleks bagus",
    spends: "nggak lihat harga buat kopi dan skincare, langganan gym/pilates, pesan-antar",
    never: "angkat angkot, nasi bungkus kaki lima, ngontrak kamar, hitung uang receh",
  },
};

const KEYWORDS = [
  [/menengah\s+ke\s+atas|atas\b.*(kaya|mampu)|konglomerat|sultan/i, "atas"],
  [/kelas\s+atas|upper\s*middle|kaya|berada|mapan|affluent/i, "atas"],
  [/menengah\b/i, "menengah"],
  [/biasa|sederhana|pas-pasan|lower\s*middle/i, "biasa"],
  [/bawah|miskin|susah|struggling|kurang\s+mampu/i, "bawah"],
];

/** Which band the card describes, if any. */
export function bandOf(persona) {
  const raw = `${persona?.class || ""} ${persona?.lifestyle || ""} ${String(persona?.card || "").slice(0, 1200)}`;
  for (const [re, band] of KEYWORDS) if (re.test(raw)) return band;
  return "";
}

/** The block that goes into every generation prompt. Empty for a character with no class given. */
export function lifestyleBlock(persona) {
  const band = bandOf(persona);
  const notes = String(persona?.lifestyle || "").trim();
  if (!band && !notes) return "";
  const b = BANDS[band];
  return [
    "HER CLASS AND LIFESTYLE — this decides the small physical facts of the day:",
    persona?.class ? `class: ${persona.class}${b ? ` (${b.label})` : ""}` : "",
    notes ? `details: ${notes}` : "",
    b ? `where she eats: ${b.eats}` : "",
    b ? `how she moves: ${b.moves}` : "",
    b ? `where she lives: ${b.home}` : "",
    b ? `how she spends: ${b.spends}` : "",
    b ? `she would NEVER (writing any of this breaks the character): ${b.never}` : "",
    "Every block and every moment must be consistent with this. A cheap or a posh detail that does not match is a mistake, not a quirk.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Is the character's class given? */
export const hasClass = (persona) => !!bandOf(persona) || !!String(persona?.lifestyle || "").trim();

/** The band a photo or place belongs to, from its own text. Used to stop sending mismatched photos. */
export function classFitOf(text) {
  const t = String(text || "").toLowerCase();
  if (/(kaki lima|kaki-lima|angkot|becak|pasar\s+tumpah|kumuh|warung kecil|nasi bungkus|kost|kontrakan)/.test(t)) return "bawah";
  if (/(warung|pasar|pedagang|gerobak|sepeda|ojek|mikrolet)/.test(t)) return "biasa";
  if (/(kafe|cafe|coworking|mall|restoran|apartemen|gym|pilates|brunch|specialty|hotel|sedan|mobil)/.test(t)) return "menengah";
  if (/(rooftop|fine dining|resort|villa|yacht|private|butik|boutique|five star|bintang lima|valet)/.test(t)) return "atas";
  return "";
}

/** Order of the bands so "one step off" can be allowed and two steps cannot. */
const ORDER = ["bawah", "biasa", "menengah", "atas"];
const distance = (a, b) => Math.abs(ORDER.indexOf(a) - ORDER.indexOf(b));

/**
 * Would she plausibly send this photo? A warung photo from an upper-middle-class character is a tell
 * in the same way a wrong POV is — one cheap detail and the whole thing reads as invented.
 */
export function fitsPersonaClass(text, persona, { allowOneStep = false } = {}) {
  const band = bandOf(persona);
  if (!band) return true; // no class declared: nothing to contradict
  const fit = classFitOf(text);
  if (!fit) return true; // nothing class-specific in the text
  const d = distance(band, fit);
  return d === 0 || (allowOneStep && d === 1);
}
