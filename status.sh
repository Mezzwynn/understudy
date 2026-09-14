#!/data/data/com.termux/files/usr/bin/env bash
# Show whether the agent is running + recent activity + quota.
cd "$(dirname "$0")" || exit 1
PIDFILE="data/rp.pid"

# pgrep -c prints "0" AND exits 1 when nothing matches, so `|| echo 0` used to
# append a second 0 → count became "0\n0", which broke the status branch.
count="$(pgrep -cf '^node src/index\.mjs' 2>/dev/null)"
count="${count:-0}"
if [ "$count" = "0" ]; then
  echo "status: STOPPED"
elif [ "$count" = "1" ]; then
  echo "status: RUNNING (pid $(pgrep -f '^node src/index\.mjs' | head -1))"
else
  echo "status: RUNNING — $count INSTANCES (clean up with: rp restart)"
  pgrep -af '^node src/index\.mjs'
fi

echo "number: $(grep -a 'connected as' rp.log 2>/dev/null | tail -1 | sed 's/.*as //')"
echo "--- last activity ---"
grep -av '█\|▄\|┌\|│\|└' rp.log 2>/dev/null | grep -aE '←|→|ignored|failed|connected|left on read|reacted|dry|silent|proactive|presence' | tail -8

node scripts/stats.mjs 2>/dev/null
