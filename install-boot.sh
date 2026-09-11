#!/data/data/com.termux/files/usr/bin/env bash
# Auto-start Understudy after the phone reboots (requires the Termux:Boot app).
set -e

BOOT_DIR="$HOME/.termux/boot"
mkdir -p "$BOOT_DIR"

cat > "$BOOT_DIR/understudy.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock 2>/dev/null
cd "$HOME/understudy" || exit 1
nohup node src/index.mjs >> rp.log 2>&1 < /dev/null &
EOF
chmod +x "$BOOT_DIR/understudy.sh"

echo "✓ installed: $BOOT_DIR/understudy.sh"
echo
echo "To activate it:"
echo "  1. Install the 'Termux:Boot' app (F-Droid)."
echo "  2. Open Termux:Boot once so Android registers it."
echo "  3. Reboot — the agent starts automatically."
