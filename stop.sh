#!/data/data/com.termux/files/usr/bin/env bash
# Stop the roleplay agent.
cd "$(dirname "$0")" || exit 1
PIDFILE="data/rp.pid"

if [ ! -f "$PIDFILE" ]; then
  echo "not running (no pidfile)"
  exit 0
fi

PID="$(cat "$PIDFILE" 2>/dev/null)"
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  kill "$PID" 2>/dev/null
  sleep 1
  kill -9 "$PID" 2>/dev/null
  echo "stopped (pid $PID)"
else
  echo "process $PID not running"
fi
rm -f "$PIDFILE"
