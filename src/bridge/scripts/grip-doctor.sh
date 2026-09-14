#!/usr/bin/env bash
# Capture forensics on a wedged grip bridge.
# Use when `grip_diagnose` over MCP can't get through (bridge unresponsive).
# Output goes to ~/.grip-doctor-<ts>.txt.
set -u
TS=$(date +%s)
OUT="$HOME/.grip-doctor-$TS.txt"
{
  echo "=== grip-doctor $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  echo
  echo "=== port :7777 owner ==="
  lsof -i:7777 -P 2>&1 | grep -v -i figma || true
  echo
  PID=$(lsof -tiTCP:7777 -sTCP:LISTEN 2>/dev/null | head -1)
  if [ -n "${PID:-}" ]; then
    echo "=== bridge proc (pid $PID) ==="
    ps -p "$PID" -o pid,ppid,pcpu,etime,time,rss,command
    echo
    echo "=== sample(5s) ==="
    sample "$PID" 5 -file "/tmp/grip-sample-$TS.txt" >/dev/null 2>&1 && \
      grep -E "v8::|RegExp::|Builtins_|JSON|net::|uv_|Parser" "/tmp/grip-sample-$TS.txt" \
        | sort | uniq -c | sort -rn | head -25
    echo "  (full sample: /tmp/grip-sample-$TS.txt)"
  else
    echo "no bridge listening on :7777"
  fi
  echo
  echo "=== ipc socket ==="
  ls -la "$TMPDIR/grip-bridge.sock" 2>&1 || echo "(no socket)"
  echo
  echo "=== status file ==="
  cat "$HOME/.grip-bridge.status" 2>&1 || echo "(no status file)"
  echo
  echo "=== last 60 log lines ==="
  tail -60 "$HOME/.grip-bridge.log" 2>&1 || echo "(no log)"
  echo
  echo "=== claude mcp list grip ==="
  claude mcp list 2>&1 | grep -i grip || true
  echo
  echo "=== latest forensic dumps ==="
  ls -lt "$HOME"/.grip-bridge.dump-*.json 2>/dev/null | head -3 || echo "(none)"
} > "$OUT" 2>&1
echo "wrote $OUT"
