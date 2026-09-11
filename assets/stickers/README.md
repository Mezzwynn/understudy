# Stickers

Drop `.webp` stickers here and the bot will occasionally send one at random
(controlled by `STICKER_CHANCE`).

Create a sticker from any image:

```bash
node scripts/sticker.mjs my-image.png cool-cat
```

Or generate one:

```bash
node scripts/sticker.mjs --generate "cat wearing sunglasses, cartoon" cool-cat
```

Requirements: `cwebp` (`pkg install libwebp` on Termux). Stickers are converted
to 512×512 webp automatically.

Files here are gitignored by default, so your personal sticker pack stays local.
