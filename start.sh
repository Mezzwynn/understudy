#!/data/data/com.termux/files/usr/bin/env bash
# Start the roleplay agent in the background (single instance only).
cd "$(dirname "$0")" || exit 1
mkdir -p data
PIDFILE="data/rp.pid"
LOG="$(pwd)/rp.log"

# 1. already running according to the pidfile?
if [ -f "$PIDFILE" ]; then
  OLD="$(cat "$PIDFILE" 2>/dev/null)"
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
    echo "already running (pid $OLD)"
    exit 0
  fi
fi

# 2. any stray instance? never start a second bot — it would double every reply
STRAY="$(pgrep -f '^node src/index\.mjs' 2>/dev/null | tr '\n' ' ')"
if [ -n "$STRAY" ]; then
  echo "already running (pid $STRAY)"
  echo "$STRAY" | awk '{print $1}' > "$PIDFILE"
  exit 0
fi

# keep the phone from sleeping the process
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock 2>/dev/null

nohup node src/index.mjs >> "$LOG" 2>&1 < /dev/null &
PID=$!
echo "$PID" > "$PIDFILE"
sleep 2

if kill -0 "$PID" 2>/dev/null; then
  echo "started (pid $PID)"
  echo "log : $LOG"
  echo "tail: tail -f $LOG"
else
  echo "failed to start — check $LOG"
  exit 1
fi
