#!/data/data/com.termux/files/usr/bin/env bash
# Show whether the agent is running + recent activity + quota.
cd "$(dirname "$0")" || exit 1
PIDFILE="data/rp.pid"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "status: RUNNING (pid $(cat "$PIDFILE"))"
else
  PID="$(pgrep -f "node src/index.mjs" 2>/dev/null | head -1)"
  if [ -n "$PID" ]; then
    echo "status: RUNNING (pid $PID, no pidfile)"
  else
    echo "status: STOPPED"
  fi
fi

echo "number: $(grep -a 'connected as' rp.log 2>/dev/null | tail -1 | sed 's/.*as //')"
echo "--- last activity ---"
grep -av '█\|▄\|┌\|│\|└' rp.log 2>/dev/null | grep -aE '←|→|ignored|failed|connected|left on read|reacted|dry|silent|proactive|presence' | tail -8

node scripts/stats.mjs 2>/dev/null
