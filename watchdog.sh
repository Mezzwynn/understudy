#!/data/data/com.termux/files/usr/bin/env bash
# watchdog.sh — keep the bot alive; notify when it had to restart it.
#
#   ./watchdog.sh          (or: rp watchdog)
#
# Loop: every WATCHDOG_INTERVAL seconds (default 60) check that the bot process
# is alive. If it died, start it again and send a Termux notification.

cd "$(dirname "$0")" || exit 1
INTERVAL="${WATCHDOG_INTERVAL:-60}"
mkdir -p data
echo $$ > data/watchdog.pid

# stop any previous watchdog
if [ -f data/watchdog.pid ]; then
  OLD="$(cat data/watchdog.pid 2>/dev/null)"
  if [ -n "$OLD" ] && [ "$OLD" != "$$" ] && kill -0 "$OLD" 2>/dev/null; then
    kill "$OLD" 2>/dev/null
  fi
fi
echo $$ > data/watchdog.pid

echo "[$(date '+%F %T')] watchdog start (interval ${INTERVAL}s, pid $$)" >> watchdog.log

while true; do
  if ! pgrep -f "node src/index.mjs" >/dev/null 2>&1; then
    echo "[$(date '+%F %T')] bot mati — restart" >> watchdog.log
    ./start.sh >> watchdog.log 2>&1
    if command -v termux-notification >/dev/null 2>&1; then
      termux-notification -t "Understudy" -c "Bot mati, sudah di-restart." --priority high >/dev/null 2>&1
    fi
  fi
  sleep "$INTERVAL"
done
