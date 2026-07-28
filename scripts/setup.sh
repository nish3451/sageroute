#!/bin/bash
#
# One-time SageRoute setup.
#
#   ./scripts/setup.sh
#
# Does every step needed to go from a fresh checkout to a router you can point a coding
# agent at: checks tooling, stores the Sage key so it survives this shell, adopts a
# subscription login if one exists, starts the daemon, and proves the whole path with a
# real turn before claiming success.
#
# Safe to re-run. Nothing here is destructive and an existing daemon is left alone.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${SAGEROUTE_STATE_DIR:-$HOME/.sageroute}"
CONFIG="${CONFIG:-./sageroute.daily.json}"
PORT="${PORT:-8787}"

cd "$ROOT"
mkdir -p "$STATE"

step() { printf '\n[%s] %s\n' "$1" "$2"; }
fail() { printf 'FAILED: %s\n' "$1"; exit 1; }

step 1 "checking required tools"
for tool in bun curl; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing required tool: $tool"
  echo "  ok  $tool"
done

step 2 "storing the Sage API key"
# The daemon outlives the shell that starts it, so an exported variable is not enough.
# The key is written once to a private file that every later `start` reads back.
if [ -n "${SAGE_API_KEY:-}" ]; then
  printf 'SAGE_API_KEY=%s\n' "$SAGE_API_KEY" > "$STATE/env"
  chmod 600 "$STATE/env"
  echo "  saved from the current environment to $STATE/env"
elif [ -f "$STATE/env" ] && grep -q '^SAGE_API_KEY=.' "$STATE/env"; then
  echo "  already stored at $STATE/env"
else
  echo "  no key found."
  echo "  Get one at https://docs.levanto.ai/ then run:"
  echo "    SAGE_API_KEY=lv_... ./scripts/setup.sh"
  echo "  Without it the router still runs, but decisions come from the offline stub"
  echo "  instead of real Sage verdicts."
fi

step 3 "checking model provider credentials"
if bun run src/cli.ts auth status 2>/dev/null | grep -q "expires at"; then
  bun run src/cli.ts auth status 2>/dev/null | sed 's/^/  /'
else
  echo "  none stored; trying to adopt a login from another CLI on this machine"
  # Reusing a login Codex or Claude Code already completed creates no new grant and
  # skips the browser flow, which is the slowest part of setup.
  bun run src/cli.ts auth import 2>&1 | sed 's/^/  /' \
    || echo "  no importable login found. Run: bun run src/cli.ts auth login openai"
fi

step 4 "validating config"
bun run src/cli.ts check --config "$CONFIG" 2>&1 | sed 's/^/  /' || fail "config did not validate"

step 5 "starting the router"
./scripts/sageroute-daemon.sh start --config "$CONFIG" --port "$PORT" 2>&1 | sed 's/^/  /'
./scripts/sageroute-daemon.sh status >/dev/null 2>&1 || fail "router did not stay up; see $STATE/daemon.log"

step 6 "proving it with a real turn"
# A router that boots is not a router that works. This sends a genuine request on the
# Anthropic wire and checks the routing headers came back, which is the only evidence
# that translation, auth, upstream dispatch, and the ladder all ran.
headers="$(mktemp)"
reply="$(curl -s --max-time 90 -D "$headers" "http://127.0.0.1:$PORT/v1/messages" \
  -H "content-type: application/json" \
  -H "x-api-key: unused" \
  -d '{"model":"sageroute","max_tokens":64,"messages":[{"role":"user","content":"Reply with exactly: SAGEROUTE OK"}]}')"

if printf '%s' "$reply" | grep -q "SAGEROUTE OK"; then
  echo "  live turn answered by $(grep -i '^x-sageroute-model:' "$headers" | tr -d '\r' | awk '{print $2}')"
  grep -i '^x-sageroute' "$headers" | tr -d '\r' | sed 's/^/  /'
  rm -f "$headers"
else
  echo "  the router is up but the test turn did not come back as expected:"
  printf '%s\n' "$reply" | head -5 | sed 's/^/  /'
  rm -f "$headers"
  fail "check credentials with: bun run src/cli.ts auth status"
fi

cat <<EOF

SageRoute is running on http://127.0.0.1:$PORT

Point a coding agent at it:

  ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT \\
  ANTHROPIC_API_KEY=unused \\
  ANTHROPIC_MODEL=sageroute \\
  claude

Watch what it decides:  http://127.0.0.1:$PORT/v1/sageroute/sessions
Logs:                   ./scripts/sageroute-daemon.sh logs
Stop:                   ./scripts/sageroute-daemon.sh stop
EOF
