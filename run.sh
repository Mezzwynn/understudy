#!/usr/bin/env bash
# Run the roleplay agent in the foreground.
cd "$(dirname "$0")"
exec node src/index.mjs
