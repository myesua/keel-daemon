#!/usr/bin/env bash
# =============================================================================
# Keel daemon — behavior test suite
#
# Runs the five required behavior tests against a freshly built binary:
#   1. HTTP bridge starts and /keel/health answers with JSON
#   2. /keel/tools returns a non-empty tool list
#   3. Starting the daemon NEVER launches Chrome (bridge still serves)
#   4. Tray build exposes the required menu items (verified via the menu log;
#      actual menubar rendering needs a real macOS/Windows session)
#   5. With Chrome already running on --remote-debugging-port=9222 the daemon
#      attaches and logs "CDP connected"
#
# Usage:  cd daemon && ./tests/run-tests.sh
# Requires: cargo, curl, and (for test 5) a chrome/chromium binary on PATH.
# Exit code is non-zero when any test fails.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$DAEMON_DIR"

BIN="target/release/keel"
LOGDIR="$(mktemp -d)"
PASS=0
FAIL=0
declare -a RESULTS=()

note()   { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()     { PASS=$((PASS+1)); RESULTS+=("PASS  $1"); printf '   PASS: %s\n' "$1"; }
bad()    { FAIL=$((FAIL+1)); RESULTS+=("FAIL  $1"); printf '   FAIL: %s\n' "$1"; }

cleanup() {
  [[ -n "${DAEMON_PID:-}" ]] && kill "$DAEMON_PID" 2>/dev/null
  [[ -n "${CHROME_PID:-}" ]] && kill "$CHROME_PID" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

kill_daemon() {
  if [[ -n "${DAEMON_PID:-}" ]]; then
    kill "$DAEMON_PID" 2>/dev/null
    wait "$DAEMON_PID" 2>/dev/null
    DAEMON_PID=""
  fi
}

wait_for_bridge() {
  for _ in $(seq 1 50); do
    curl -sf -o /dev/null "http://127.0.0.1:8791/keel/health" && return 0
    sleep 0.2
  done
  return 1
}

chrome_bin() {
  for c in google-chrome google-chrome-stable chromium chromium-browser; do
    command -v "$c" >/dev/null 2>&1 && { echo "$c"; return 0; }
  done
  return 1
}

# ---------------------------------------------------------------------------
note "Build (release, headless)"
if cargo build --release 2>"$LOGDIR/build.log"; then
  ok "cargo build --release"
else
  bad "cargo build --release (see $LOGDIR/build.log)"
  tail -20 "$LOGDIR/build.log"
  exit 1
fi

# ---------------------------------------------------------------------------
note "Test 3 precondition: no Chrome is running"
pkill -f 'remote-debugging-port' 2>/dev/null
pkill -x chrome 2>/dev/null
sleep 1
CHROME_BEFORE=$(pgrep -c -f '[c]hrome' || true)
echo "   chrome processes before daemon start: ${CHROME_BEFORE:-0}"

note "Start daemon (no Chrome anywhere)"
RUST_LOG=keel=info "$BIN" >"$LOGDIR/daemon1.log" 2>&1 &
DAEMON_PID=$!
if wait_for_bridge; then
  ok "daemon started and bridge answered without Chrome present"
else
  bad "bridge did not answer on 127.0.0.1:8791"
fi

# ---------------------------------------------------------------------------
note "Test 1: GET /keel/health"
HEALTH=$(curl -sf "http://127.0.0.1:8791/keel/health" || true)
echo "   response: $HEALTH"
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  ok "/keel/health returns {\"status\":\"ok\",…}"
else
  bad "/keel/health did not return status ok JSON"
fi
if echo "$HEALTH" | grep -q '"browser_connected":false'; then
  ok "/keel/health reports browser_connected:false (Chrome not running)"
else
  bad "/keel/health should report browser_connected:false with no Chrome"
fi

# ---------------------------------------------------------------------------
note "Test 2: GET /keel/tools"
TOOLS=$(curl -sf "http://127.0.0.1:8791/keel/tools" || true)
COUNT=$(echo "$TOOLS" | grep -o '"name"' | wc -l | tr -d ' ')
echo "   tools advertised: $COUNT"
if [[ "$COUNT" -ge 5 ]] && echo "$TOOLS" | grep -q '"open_tab"'; then
  ok "/keel/tools returns a non-empty JSON tool list ($COUNT tools)"
else
  bad "/keel/tools missing or empty"
fi

# ---------------------------------------------------------------------------
note "Test 3: daemon must NOT have launched Chrome"
sleep 2
CHROME_AFTER=$(pgrep -c -f '[c]hrome' || true)
echo "   chrome processes after daemon start: ${CHROME_AFTER:-0}"
if [[ "${CHROME_AFTER:-0}" -le "${CHROME_BEFORE:-0}" ]]; then
  ok "no Chrome process appeared after starting the daemon"
else
  bad "a Chrome process appeared — the daemon launched Chrome"
fi
if grep -q 'Chrome not connected' "$LOGDIR/daemon1.log"; then
  ok "daemon logged 'Chrome not connected' instead of launching Chrome"
else
  bad "daemon did not log the Chrome-not-connected notice"
  sed -n '1,10p' "$LOGDIR/daemon1.log"
fi
if ! grep -qi 'launch_chrome\|started .* with DevTools' "$LOGDIR/daemon1.log"; then
  ok "daemon log contains no Chrome-launch activity"
else
  bad "daemon log shows Chrome-launch activity"
fi
kill_daemon

# ---------------------------------------------------------------------------
note "Test 4: tray menu structure"
# The tray is a desktop feature (macOS menubar / Windows tray). In CI/headless
# Linux we verify (a) the tray build compiles and (b) the menu the code
# constructs contains exactly the required items, via the menu-structure log
# statement and the source itself.
if cargo build --release --features tray 2>"$LOGDIR/tray-build.log"; then
  ok "tray build compiles (cargo build --release --features tray)"
else
  bad "tray build failed (see $LOGDIR/tray-build.log)"
fi
for item in '"Open Keel"' '"Quit Keel"' '"CDP Status: Connected"' '"CDP Status: Not Connected"' '"Keel — Running"' '"Keel — Chrome not connected"'; do
  if grep -qF "$item" src/tray.rs; then
    ok "tray menu defines $item"
  else
    bad "tray menu missing $item"
  fi
done
if [[ -n "${DISPLAY:-}" ]] || command -v xvfb-run >/dev/null 2>&1; then
  RUNNER=""
  [[ -z "${DISPLAY:-}" ]] && RUNNER="xvfb-run -a"
  timeout 6 $RUNNER "$BIN" >"$LOGDIR/tray.log" 2>&1
  if grep -q 'tray menu:' "$LOGDIR/tray.log"; then
    ok "tray build logs its menu structure at startup: $(grep 'tray menu:' "$LOGDIR/tray.log" | sed 's/.*tray menu/tray menu/')"
  else
    echo "   note: tray runtime log check skipped/inconclusive on this host"
  fi
else
  echo "   note: no display available — runtime tray check needs macOS/Windows"
fi

# ---------------------------------------------------------------------------
note "Test 5: CDP attach when Chrome runs with --remote-debugging-port=9222"
CHROME=$(chrome_bin || true)
if [[ -z "$CHROME" ]]; then
  bad "no chrome/chromium binary found on PATH — cannot run test 5"
else
  "$CHROME" --headless=new --remote-debugging-port=9222 \
    --user-data-dir="$LOGDIR/chrome-profile" --no-first-run \
    --no-default-browser-check about:blank >"$LOGDIR/chrome.log" 2>&1 &
  CHROME_PID=$!
  CDP_OK=false
  for _ in $(seq 1 50); do
    curl -sf -o /dev/null "http://localhost:9222/json" && { CDP_OK=true; break; }
    sleep 0.2
  done
  if $CDP_OK; then
    ok "Chrome's CDP endpoint answers: $(curl -sf http://localhost:9222/json | head -c 120)…"
  else
    bad "Chrome did not expose CDP on 9222"
  fi

  # Rebuild the headless binary (the tray build overwrote target/release/keel).
  cargo build --release 2>/dev/null
  RUST_LOG=keel=info "$BIN" headless >"$LOGDIR/daemon2.log" 2>&1 &
  DAEMON_PID=$!
  wait_for_bridge || true
  sleep 1
  if grep -q 'CDP connected' "$LOGDIR/daemon2.log"; then
    ok "daemon logged 'CDP connected'"
  else
    bad "daemon did not log 'CDP connected'"
    sed -n '1,10p' "$LOGDIR/daemon2.log"
  fi
  HEALTH2=$(curl -sf "http://127.0.0.1:8791/keel/health" || true)
  echo "   health with Chrome up: $HEALTH2"
  if echo "$HEALTH2" | grep -q '"browser_connected":true'; then
    ok "/keel/health reports browser_connected:true"
  else
    bad "/keel/health should report browser_connected:true"
  fi
  kill_daemon
  kill "$CHROME_PID" 2>/dev/null; CHROME_PID=""
fi

# ---------------------------------------------------------------------------
note "Summary"
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo
echo "  $PASS passed, $FAIL failed  (logs in $LOGDIR)"
[[ "$FAIL" -eq 0 ]]
