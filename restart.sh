#!/data/data/com.termux/files/usr/bin/env bash
# Restart the roleplay agent.
cd "$(dirname "$0")" || exit 1
./stop.sh
sleep 1
./start.sh
