#!/bin/bash
#
# Run SageRoute as a background daemon for day-to-day use.
#
#   ./scripts/sageroute-daemon.sh start [--config <path>] [--port <n>]
#   ./scripts/sageroute-daemon.sh status
#   ./scripts/sageroute-daemon.sh logs
#   ./scripts/sageroute-daemon.sh stop
#
# A foreground `serve` dies with its terminal, which is fine for a demo and wrong for a
# router you actually code against all day. This detaches the process, records its pid,
# and waits for /health before reporting success, so `start` returning 0 means the router
# is genuinely answering rather than merely spawned.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${SAGEROUTE_STATE_DIR:-$HOME/.sageroute}"
PIDFILE="$STATE/daemon.pid"
LOGFILE="$STATE/daemon.log"
CONFIG="./sageroute.daily.json"
PORT=""

CMD="${1:-status}"
shift 2>/dev/null || true
while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) echo "unknown option: $1"; exit 1 ;;
  esac
done

mkdir -p "$STATE"

running_pid() {
  [ -f "$PIDFILE" ] || return 1
  local pid
  pid="$(cat "$PIDFILE" 2>/dev/null)"
  [ -n "$pid" ] || return 1
  # kill -0 probes liveness without signalling, so a stale pidfile is detected rather
  # than trusted. A pid can be recycled, so this is a liveness check, not an identity one.
  kill -0 "$pid" 2>/dev/null || return 1
  echo "$pid"
}

case "$CMD" in
  start)
    if pid="$(running_pid)"; then
      echo "already running (pid $pid). Use 'stop' first, or 'status' to inspect."
      exit 0
    fi
    if [ -z "${SAGE_API_KEY:-}" ]; then
      echo "warning: SAGE_API_KEY is unset; the router will use its offline decision stub"
      echo "         and no real Sage verdicts will be made."
    fi
    cd "$ROOT"
    set -- serve --config "$CONFIG"
    [ -n "$PORT" ] && set -- "$@" --port "$PORT"
    # Double fork. The inner subshell detaches from this shell's job control, so the
    # router is not torn down when the launching shell exits or when a supervising
    # harness reaps the caller's process group. `nohup` alone only ignores SIGHUP,
    # which is a weaker guarantee than it looks.
    ( nohup bun run src/cli.ts "$@" >> "$LOGFILE" 2>&1 & echo $! > "$PIDFILE" ) &
    # Give the inner shell a moment to write the pidfile before it is read back.
    sleep 0.3

    probe_port="${PORT:-$(grep -o '"port"[[:space:]]*:[[:space:]]*[0-9]*' "$CONFIG" | grep -o '[0-9]*$')}"
    probe_port="${probe_port:-8787}"
    for _ in $(seq 1 60); do
      if curl -s --max-time 2 "http://127.0.0.1:$probe_port/health" >/dev/null 2>&1; then
        echo "sageroute running on http://127.0.0.1:$probe_port (pid $(cat "$PIDFILE"))"
        echo "  logs   $LOGFILE"
        echo "  stop   $0 stop"
        exit 0
      fi
      sleep 0.25
    done
    echo "started but /health never answered on port $probe_port; last log lines:"
    tail -15 "$LOGFILE"
    exit 1
    ;;

  stop)
    if pid="$(running_pid)"; then
      kill "$pid" 2>/dev/null
      rm -f "$PIDFILE"
      echo "stopped (pid $pid)"
    else
      rm -f "$PIDFILE"
      echo "not running"
    fi
    ;;

  status)
    if pid="$(running_pid)"; then
      echo "running (pid $pid)"
      echo "logs: $LOGFILE"
    else
      echo "not running"
      exit 1
    fi
    ;;

  logs)
    [ -f "$LOGFILE" ] && tail -40 "$LOGFILE" || echo "no log yet at $LOGFILE"
    ;;

  *)
    echo "usage: $0 {start|stop|status|logs} [--config <path>] [--port <n>]"
    exit 1
    ;;
esac
