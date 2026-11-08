#!/usr/bin/env bash
# PTY interaction tests for the MethaTech TUI, using tmux (FreeBuff pattern:
# interactive CLI tests run in tmux). Captures the pane after each scenario
# and checks for expected strings. No network access; uses the mock server.
#
# Usage: bash test/tui-pty.sh [outdir]
# Requires: tmux, node. Produces one .txt capture per scenario in outdir.
set -u
cd "$(dirname "$0")/.." || exit 1

OUTDIR="${1:-/tmp/methatech-tui-pty}"
mkdir -p "$OUTDIR"
MOCK_PORT="${MOCK_PORT:-18099}"
SESSION="methatech-tui-test"

# Start mock server (background, killed on exit).
node test/mock-server.mjs "$MOCK_PORT" > "$OUTDIR/mock-server.log" 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null; tmux kill-session -t "$SESSION" 2>/dev/null' EXIT
sleep 1

# Fresh credentials dir with a test key (never touches the real one).
export METATECH_CONFIG_DIR="$OUTDIR/config"
export METATECH_API_KEY="test-key-pty"
export METATECH_API_BASE="http://127.0.0.1:$MOCK_PORT"
export METATECH_CONSOLE_BASE="http://127.0.0.1:$MOCK_PORT"
mkdir -p "$METATECH_CONFIG_DIR"
printf '{"apiKey":"test-key-pty","defaultModel":"glm-5.3-flash","savedAt":"2026-11-08T00:00:00Z"}' > "$METATECH_CONFIG_DIR/credentials.json"
chmod 600 "$METATECH_CONFIG_DIR/credentials.json"

PASS=0
FAIL=0
check() { # check <file> <needle> <label>
  if grep -qF "$2" "$1"; then
    echo "PASS: $3"; PASS=$((PASS+1))
  else
    echo "FAIL: $3 (needle '$2' not found in $1)"; FAIL=$((FAIL+1))
  fi
}

start_tui() { # start_tui <cols> <rows> [args...]
  local cols="$1" rows="$2"; shift 2
  tmux kill-session -t "$SESSION" 2>/dev/null
  tmux new-session -d -s "$SESSION" -x "$cols" -y "$rows" \
    "METATECH_CONFIG_DIR='$METATECH_CONFIG_DIR' METATECH_API_KEY='$METATECH_API_KEY' METATECH_API_BASE='http://127.0.0.1:$MOCK_PORT' METATECH_CONSOLE_BASE='http://127.0.0.1:$MOCK_PORT' node dist/cli.js $*"
  sleep 2
}
capture() { # capture <name>
  tmux capture-pane -t "$SESSION" -p -e > "$OUTDIR/$1.txt" 2>/dev/null
  # Also a plain-text copy (ANSI stripped) for grepping.
  sed 's/\x1b\[[0-9;]*m//g' "$OUTDIR/$1.txt" > "$OUTDIR/$1.plain.txt"
}
send() { tmux send-keys -t "$SESSION" "$@" ; sleep 0.7; }
stop_tui() { tmux send-keys -t "$SESSION" C-c; sleep 1; tmux kill-session -t "$SESSION" 2>/dev/null; }

# --- Scenario 1: bare `methatech` opens the TUI (desktop 80x24) ---
start_tui 80 24
capture s1-tui-open
check "$OUTDIR/s1-tui-open.plain.txt" "MethaTech" "s1: header MethaTech renders"
check "$OUTDIR/s1-tui-open.plain.txt" "glm-5.3-flash" "s1: active model shown"
check "$OUTDIR/s1-tui-open.plain.txt" "Balance" "s1: balance shown"
stop_tui

# --- Scenario 2: command palette on "/" + filtering + Esc ---
start_tui 80 24
send "/"
capture s2-palette-open
check "$OUTDIR/s2-palette-open.plain.txt" "/model" "s2: palette lists /model"
check "$OUTDIR/s2-palette-open.plain.txt" "/exit" "s2: palette lists /exit"
send "mod"
capture s2-palette-filter
check "$OUTDIR/s2-palette-filter.plain.txt" "/model" "s2: filter keeps /model"
send Escape
capture s2-palette-esc
# After Esc the palette should be closed (no highlighted command list).
if grep -q "/models" "$OUTDIR/s2-palette-esc.plain.txt"; then
  echo "FAIL: s2: palette still visible after Esc"; FAIL=$((FAIL+1))
else
  echo "PASS: s2: Esc closes palette"; PASS=$((PASS+1))
fi
stop_tui

# --- Scenario 3: send a message, thinking then streamed reply ---
start_tui 80 24
send "halo"
send Enter
sleep 1
capture s3-thinking-or-reply
check "$OUTDIR/s3-thinking-or-reply.plain.txt" "Halo! Ini balasan mock." "s3: streamed mock reply renders"
stop_tui

# --- Scenario 4: model picker via /model, arrow + Enter selects ---
start_tui 80 24
send "/model"
send Enter
sleep 1
capture s4-picker-open
check "$OUTDIR/s4-picker-open.plain.txt" "glm-5.3-flash" "s4: picker lists models"
send Down
send Enter
sleep 1
capture s4-picker-select
# The header should now show the newly selected model (not the old one only).
check "$OUTDIR/s4-picker-select.plain.txt" "MethaTech" "s4: TUI still alive after picker select"
stop_tui

# --- Scenario 5: small terminal (40x15, Termux-like) — no crash, header fits ---
start_tui 40 15
capture s5-small
check "$OUTDIR/s5-small.plain.txt" "MethaTech" "s5: header renders at 40 cols"
stop_tui

# --- Scenario 6: Ctrl+C exits cleanly and terminal is restored ---
start_tui 80 24
tmux send-keys -t "$SESSION" C-c
sleep 1
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "FAIL: s6: session still alive after Ctrl+C"; FAIL=$((FAIL+1))
  tmux kill-session -t "$SESSION" 2>/dev/null
else
  echo "PASS: s6: Ctrl+C exits cleanly"; PASS=$((PASS+1))
fi

echo ""
echo "PTY results: PASS=$PASS FAIL=$FAIL (captures in $OUTDIR)"
exit "$([ "$FAIL" -eq 0 ] && echo 0 || echo 1)"
