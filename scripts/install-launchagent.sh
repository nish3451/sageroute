#!/bin/bash
#
# Install SageRoute as a macOS LaunchAgent.
#
#   ./scripts/install-launchagent.sh          install and start
#   ./scripts/install-launchagent.sh uninstall
#
# launchd owns the process rather than the shell that started it, so the router survives
# a closed terminal, a logout, and a reboot, and is restarted if it ever crashes. That is
# a stronger guarantee than a double-forked nohup, which any supervising harness is still
# free to reap along with the caller's process group.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${SAGEROUTE_STATE_DIR:-$HOME/.sageroute}"
LABEL="com.sageroute.proxy"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CONFIG="${CONFIG:-$ROOT/sageroute.daily.json}"
PORT="${PORT:-8787}"
DOMAIN="gui/$(id -u)"

if [ "${1:-install}" = "uninstall" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null
  rm -f "$PLIST"
  echo "uninstalled $LABEL"
  exit 0
fi

BUN="$(command -v bun)"
[ -n "$BUN" ] || { echo "bun not found on PATH"; exit 1; }
mkdir -p "$STATE" "$HOME/Library/LaunchAgents"

# The agent runs outside any login shell, so it cannot inherit an exported key. It reads
# the same stored env file that `setup.sh` writes, which keeps one source of truth.
if [ -n "${SAGE_API_KEY:-}" ] && [ ! -f "$STATE/env" ]; then
  printf 'SAGE_API_KEY=%s\n' "$SAGE_API_KEY" > "$STATE/env"
  chmod 600 "$STATE/env"
fi

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>[ -f '$STATE/env' ] &amp;&amp; . '$STATE/env'; export SAGE_API_KEY; cd '$ROOT'; exec '$BUN' run src/cli.ts serve --config '$CONFIG' --port $PORT</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$STATE/service.log</string>
  <key>StandardErrorPath</key><string>$STATE/service.log</string>
</dict>
</plist>
PLISTEOF

# bootout first so a re-run replaces the definition rather than failing on a stale one.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null
launchctl bootstrap "$DOMAIN" "$PLIST" || { echo "launchctl bootstrap failed"; exit 1; }

for _ in $(seq 1 60); do
  if curl -s --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "sageroute installed as $LABEL and answering on http://127.0.0.1:$PORT"
    echo "  plist   $PLIST"
    echo "  logs    $STATE/service.log"
    echo "  remove  $0 uninstall"
    exit 0
  fi
  sleep 0.25
done

echo "bootstrapped but /health never answered on port $PORT; last log lines:"
tail -15 "$STATE/service.log" 2>/dev/null
exit 1
