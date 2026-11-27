#!/usr/bin/env bash
# Starts a throwaway anvil on a free port, runs spike.mjs against it, and stops it.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
port="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
anvil --host 127.0.0.1 --port "$port" --config-out "$work/anvil.json" >"$work/anvil.log" 2>&1 &
anvil_pid=$!
trap 'kill "$anvil_pid" 2>/dev/null || true; wait "$anvil_pid" 2>/dev/null || true; rm -rf "$work"' EXIT
for _ in $(seq 1 50); do [ -s "$work/anvil.json" ] && grep -q Listening "$work/anvil.log" && break; sleep 0.2; done
ANVIL_URL="http://127.0.0.1:$port" ANVIL_CONFIG="$work/anvil.json" node "$here/spike.mjs"
