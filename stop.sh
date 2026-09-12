#!/data/data/com.termux/files/usr/bin/env bash
# Stop the roleplay agent. Kills the pidfile pid AND any stray instance, so we
# never end up with two bots answering the same message twice.
cd "$(dirname "$0")" || exit 1
PIDFILE="data/rp.pid"

fromfile=""
[ -f "$PIDFILE" ] && fromfile="$(cat "$PIDFILE" 2>/dev/null)"
# -f with ^ anchor so we only match the bot itself, not shells that mention it
stray="$(pgrep -f '^node src/index\.mjs' 2>/dev/null)"

all="$(printf '%s\n%s\n' "$fromfile" "$stray" | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -u)"
if [ -z "$all" ]; then
  echo "not running"
  rm -f "$PIDFILE"
  exit 0
fi

for p in $all; do kill "$p" 2>/dev/null; done
sleep 1
for p in $all; do kill -9 "$p" 2>/dev/null; done
rm -f "$PIDFILE"

left="$(pgrep -f '^node src/index\.mjs' 2>/dev/null | tr '\n' ' ')"
if [ -n "$left" ]; then
  echo "WARNING: processes still alive: $left"
  exit 1
fi
echo "stopped (pid $(echo $all | tr '\n' ' '))"
