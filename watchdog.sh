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

# stop any previous watchdog (read the pid BEFORE overwriting the file)
OLD="$(cat data/watchdog.pid 2>/dev/null)"
if [ -n "$OLD" ] && [ "$OLD" != "$$" ] && kill -0 "$OLD" 2>/dev/null; then
  kill "$OLD" 2>/dev/null
fi
echo $$ > data/watchdog.pid

echo "[$(date '+%F %T')] watchdog start (interval ${INTERVAL}s, pid $$)" >> watchdog.log

last_dup=0
while true; do
  count="$(pgrep -cf '^node src/index\.mjs' 2>/dev/null || echo 0)"
  if [ "$count" = "0" ]; then
    echo "[$(date '+%F %T')] bot mati — restart" >> watchdog.log
    ./start.sh >> watchdog.log 2>&1
    if command -v termux-notification >/dev/null 2>&1; then
      termux-notification -t "Understudy" -c "Bot mati, sudah di-restart." --priority high >/dev/null 2>&1
    fi
  elif [ "$count" -gt 1 ]; then
    # two bots would answer every message twice — kill them all, start one
    echo "[$(date '+%F %T')] $count instance jalan — bersihin" >> watchdog.log
    ./stop.sh >> watchdog.log 2>&1
    ./start.sh >> watchdog.log 2>&1
    now="$(date +%s)"
    if [ $((now - last_dup)) -gt 900 ] && command -v termux-notification >/dev/null 2>&1; then
      last_dup="$now"
      termux-notification -t "Understudy" -c "Ada $count bot jalan sekaligus — sudah dibersihin." --priority high >/dev/null 2>&1
    fi
  fi
  sleep "$INTERVAL"
done
