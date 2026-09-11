#!/data/data/com.termux/files/usr/bin/env bash
# Start the roleplay agent in the background.
cd "$(dirname "$0")" || exit 1
mkdir -p data
PIDFILE="data/rp.pid"
LOG="$(pwd)/rp.log"

if [ -f "$PIDFILE" ]; then
  OLD="$(cat "$PIDFILE" 2>/dev/null)"
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
    echo "already running (pid $OLD)"
    exit 0
  fi
fi

# keep the phone from sleeping the process
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock 2>/dev/null

nohup node src/index.mjs >> "$LOG" 2>&1 < /dev/null &
PID=$!
echo "$PID" > "$PIDFILE"
sleep 1

if kill -0 "$PID" 2>/dev/null; then
  echo "started (pid $PID)"
  echo "log : $LOG"
  echo "tail: tail -f $LOG"
else
  echo "failed to start — check $LOG"
  exit 1
fi
