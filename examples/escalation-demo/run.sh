#!/bin/bash
#
# Watch SageRoute escalate a real agent, live.
#
# Boots the router, then points a real Claude Code session at it and gives that session
# a task the cheap model cannot carry: write a backtracking regex engine from scratch,
# checked against 32 expectations generated from Python's own `re` module.
#
# The cheap model fails its own pytest runs, the router sees those failures as evidence,
# and Sage decides whether to hand the task up the ladder. Nothing here is simulated.
#
#   export SAGE_API_KEY=lv_...
#   ./examples/escalation-demo/run.sh
#
# Requires: bun, python3 with pytest, and the `claude` CLI on PATH.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PORT="${PORT:-8796}"
WORK="${WORK:-/tmp/sageroute-escalation-demo}"

if [ -z "${SAGE_API_KEY:-}" ]; then
  echo "SAGE_API_KEY is not set. Without it the router falls back to an offline stub"
  echo "and no real Sage verdict is made. Get a key at https://docs.levanto.ai/"
  exit 1
fi

for tool in bun python3 claude; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing required tool: $tool"; exit 1; }
done
python3 -c "import pytest" 2>/dev/null || { echo "missing python package: pytest"; exit 1; }

cd "$ROOT"
bun run src/cli.ts serve --port "$PORT" > "$WORK.log" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT

for _ in $(seq 1 80); do
  curl -s --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.25
done
if ! curl -s --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "router did not come up; see $WORK.log"
  exit 1
fi
echo "router up on http://127.0.0.1:$PORT"

rm -rf "$WORK" && mkdir -p "$WORK"
cp "$HERE/SPEC.md" "$HERE/test_engine.py" "$WORK"/
cd "$WORK"

echo
echo "=== real Claude Code, from-scratch regex engine, routed by SageRoute ==="
ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" \
ANTHROPIC_API_KEY=unused \
ANTHROPIC_MODEL=sageroute \
timeout 1500 claude -p "Read SPEC.md and implement engine.py so that 'python3 -m pytest -q' passes all 32 tests. You must write the matching engine yourself; importing re or any regex library is forbidden. Run the tests after every edit and keep fixing failures until the whole suite is green." \
  --allowedTools "Bash,Read,Write,Edit,Glob,Grep" 2>&1 | tail -20

echo
echo "=== did it cheat by importing a regex library? ==="
grep -nE "^[[:space:]]*(import|from)[[:space:]]+(re|regex|sre_|fnmatch)\b" engine.py 2>/dev/null \
  || echo "no regex library import found"

echo
echo "=== final test state ==="
python3 -m pytest -q 2>&1 | tail -3

echo
echo "=== what the router decided ==="
curl -s --max-time 5 "http://127.0.0.1:$PORT/v1/sageroute/sessions" | python3 -m json.tool 2>/dev/null | head -70

echo
echo "Full router log: $WORK.log"
