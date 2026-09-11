#!/usr/bin/env bash
# Understudy installer — one command to get everything ready.
#
#   ./install.sh
#
# It installs dependencies, creates .env, and checks the optional media tools.
# It does NOT touch your character or your WhatsApp account — do that after with:
#   rp setup        (connect a model)
#   rp start        (link WhatsApp via QR)
#   rp character    (create a character, guided by the model)

set -u
cd "$(dirname "$0")" || exit 1

say()  { printf '\033[1;36m%s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }

say "
  ┌─────────────────────────────────────────────┐
  │  Understudy · installer                      │
  └─────────────────────────────────────────────┘
"

# ── 1. Node ────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  warn "Node.js tidak ditemukan."
  echo "  Termux : pkg install nodejs"
  echo "  Lainnya: https://nodejs.org"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  warn "Node.js $NODE_MAJOR terlalu tua (butuh >=18)."
  exit 1
fi
ok "Node.js $(node -v)"

# ── 2. git (Baileys pulls a git dependency) ────────────────────
if command -v git >/dev/null 2>&1; then
  ok "git tersedia"
else
  warn "git tidak ditemukan — 'npm install' bisa gagal. Termux: pkg install git"
fi

# ── 3. dependencies ────────────────────────────────────────────
say "→ npm install"
if npm install --no-audit --no-fund; then
  ok "dependencies terpasang"
else
  warn "npm install gagal — cek pesan di atas"
  exit 1
fi

# ── 4. media tools (opsional) ──────────────────────────────────
install_tool() {
  local bin="$1" pkg="$2"
  if command -v "$bin" >/dev/null 2>&1; then
    ok "$bin tersedia"
    return
  fi
  if command -v pkg >/dev/null 2>&1; then
    say "→ pkg install $pkg (untuk $bin)"
    pkg install -y "$pkg" >/dev/null 2>&1 && ok "$bin terpasang" || warn "$bin gagal dipasang (voice note / sticker mati)"
  else
    warn "$bin tidak ada — install '$pkg' kalau mau voice note / sticker"
  fi
}
install_tool opusenc opus-tools
install_tool cwebp libwebp

# ── 5. .env ────────────────────────────────────────────────────
if [ -f .env ]; then
  ok ".env sudah ada (tidak ditimpa)"
else
  cp .env.example .env && chmod 600 .env
  ok ".env dibuat dari .env.example"
fi

# ── 6. data dir ────────────────────────────────────────────────
mkdir -p data/chats assets/stickers

cat <<'EOF'

  Selesai. Langkah berikutnya:

    1) hubungkan model AI   →  node scripts/setup.mjs      (atau: rp setup)
    2) hubungkan WhatsApp   →  ./start.sh                  lalu scan QR
    3) bikin karakter       →  node scripts/character.mjs  (atau: rp character)
    4) atur tingkah laku    →  node scripts/config.mjs     (auto / manual)

  Pasang perintah `rp` biar gampang (opsional):
       ln -sf "$(pwd)/rp" "$PREFIX/bin/rp"

EOF
