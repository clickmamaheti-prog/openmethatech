#!/usr/bin/env bash
# PTY interaction tests for the MethaTech coding agent, using tmux + the
# mock server in MOCK_AGENT mode (scripted tool calls, no live panel).
#
# Usage: bash test/agent-pty.sh [outdir]
# Requires: tmux, node. Produces one .txt capture per scenario in outdir.
set -u
cd "$(dirname "$0")/.." || exit 1

OUTDIR="${1:-/tmp/methatech-agent-pty}"
mkdir -p "$OUTDIR"
MOCK_PORT="${MOCK_PORT:-18098}"
SESSION="methatech-agent-test"

# Fake project the agent works in (its cwd): a file to read + AGENTS.md.
PROJ="$OUTDIR/proj"
rm -rf "$PROJ"
mkdir -p "$PROJ"
printf 'isi hello untuk agen\n' > "$PROJ/hello.txt"
printf '# AGENTS.md\n\nProyek uji agen.\n' > "$PROJ/AGENTS.md"

# Start mock server in agent mode (background, killed on exit).
MOCK_AGENT=1 node test/mock-server.mjs "$MOCK_PORT" > "$OUTDIR/mock-server.log" 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null; tmux kill-session -t "$SESSION" 2>/dev/null' EXIT
sleep 1

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
check_absent() { # check_absent <file> <needle> <label>
  if grep -qF "$2" "$1"; then
    echo "FAIL: $3 (needle '$2' unexpectedly found in $1)"; FAIL=$((FAIL+1))
  else
    echo "PASS: $3"; PASS=$((PASS+1))
  fi
}
restart_mock() {
  kill $MOCK_PID 2>/dev/null
  MOCK_AGENT=1 node test/mock-server.mjs "$MOCK_PORT" > "$OUTDIR/mock-server.log" 2>&1 &
  MOCK_PID=$!
  sleep 1
}
start_tui() { # start_tui <cols> <rows>
  local cols="$1" rows="$2"
  tmux kill-session -t "$SESSION" 2>/dev/null
  tmux new-session -d -s "$SESSION" -x "$cols" -y "$rows" \
    "cd '$PROJ' && METATECH_CONFIG_DIR='$METATECH_CONFIG_DIR' METATECH_API_KEY='$METATECH_API_KEY' METATECH_API_BASE='http://127.0.0.1:$MOCK_PORT' METATECH_CONSOLE_BASE='http://127.0.0.1:$MOCK_PORT' node $PWD/dist/cli.js"
  sleep 2
}
capture() { # capture <name>
  tmux capture-pane -t "$SESSION" -p -e > "$OUTDIR/$1.txt" 2>/dev/null
  sed 's/\x1b\[[0-9;]*m//g' "$OUTDIR/$1.txt" > "$OUTDIR/$1.plain.txt"
}
send() { tmux send-keys -t "$SESSION" "$@" ; sleep 0.7; }
stop_tui() { tmux send-keys -t "$SESSION" C-c; sleep 1; tmux kill-session -t "$SESSION" 2>/dev/null; }

# --- Scenario A1: agent runs BY DEFAULT (no /agent toggle — Freebuff has
# none: router.ts:480 "send to agent"), mode in footer, tool call renders,
# shell runs directly (no gate) ---
# 40 rows: the 6-step script (todos + read + edit + shell + final text
# with heading/inline code/link) fits without scrolling out of view.
start_tui 80 40
capture a1-welcome
check "$OUTDIR/a1-welcome.plain.txt" "Agent: Default" "a1: footer shows Agent: Default on the welcome screen (agent is default)"
send "baca hello.txt dan jalankan echo"
send Enter
sleep 5
capture a1-toolcall
check "$OUTDIR/a1-toolcall.plain.txt" "TODOs" "a1: to-do list header renders (Freebuff write-todos)"
check "$OUTDIR/a1-toolcall.plain.txt" "Baca hello.txt" "a1: to-do item renders"
check "$OUTDIR/a1-toolcall.plain.txt" "Read hello.txt" "a1: read_files tool preview renders"
check "$OUTDIR/a1-toolcall.plain.txt" "isi hello untuk agen" "a1: tool result (file content) renders"
check "$OUTDIR/a1-toolcall.plain.txt" "Edit hello.txt" "a1: str_replace tool preview renders"
check "$OUTDIR/a1-toolcall.plain.txt" "touch agent-ran.txt" "a1: shell tool preview renders"
check "$OUTDIR/a1-toolcall.plain.txt" "hello-agent" "a1: shell ran directly, no confirmation box"
check "$OUTDIR/a1-toolcall.plain.txt" "line4 / hello-agent" "a1: shell result shows last 3 lines (Freebuff tool-branch)"
check_absent "$OUTDIR/a1-toolcall.plain.txt" "Konfirmasi agen" "a1: no confirmation box (Freebuff has no gate)"
check_absent "$OUTDIR/a1-toolcall.plain.txt" "Allow once" "a1: no Allow once option"
sleep 6
capture a1-done
if [ -f "$PROJ/agent-ran.txt" ]; then
  echo "PASS: a1: shell created agent-ran.txt without confirmation"; PASS=$((PASS+1))
else
  echo "FAIL: a1: agent-ran.txt missing"; FAIL=$((FAIL+1))
fi
if grep -q "isi hello sudah diedit agen" "$PROJ/hello.txt"; then
  echo "PASS: a1: str_replace edited hello.txt (replacements array)"; PASS=$((PASS+1))
else
  echo "FAIL: a1: hello.txt was not edited"; FAIL=$((FAIL+1))
fi
check "$OUTDIR/a1-done.plain.txt" "Selesai" "a1: final heading renders after task_completed"
check "$OUTDIR/a1-done.plain.txt" "hello.txt" "a1: final text with inline code renders"
check "$OUTDIR/a1-done.plain.txt" "npm test" "a1: final text inline code (command) renders"
check "$OUTDIR/a1-done.plain.txt" "docs" "a1: final text link renders"
check "$OUTDIR/a1-done.plain.txt" "// sh" "a1: final text code block header renders (Freebuff)"
check_absent "$OUTDIR/a1-done.plain.txt" "codebuff_tool_call" "a1: tool-call XML never leaks into chat"
stop_tui

# --- Scenario A2: /mode plan — shell tool is removed at the toolset level ---
restart_mock
start_tui 80 24
send "/mode plan"
send Enter
sleep 1
capture a2-plan-on
check "$OUTDIR/a2-plan-on.plain.txt" "Mode agen: Plan" "a2: /mode plan switches mode"
check "$OUTDIR/a2-plan-on.plain.txt" "Agent: Plan" "a2: footer shows Agent: Plan"
send "baca hello.txt dan jalankan echo"
send Enter
sleep 6
capture a2-plan-run
check "$OUTDIR/a2-plan-run.plain.txt" "Read hello.txt" "a2: read still works in Plan mode"
check "$OUTDIR/a2-plan-run.plain.txt" "unavailable tool in this mode" "a2: shell rejected at the toolset level"
stop_tui

# --- Scenario A3: /init + /export work from the TUI ---
start_tui 80 24
send "/init"
send Enter
sleep 1
capture a3-init
# The /init summary is long, so its first line scrolls out of the
# 24-row window; the real assertion is that AGENTS.md was NOT
# overwritten (it still holds the project's own text).
if grep -q "Proyek uji agen" "$PROJ/AGENTS.md"; then
  echo "PASS: a3: /init did not overwrite existing AGENTS.md"; PASS=$((PASS+1))
else
  echo "FAIL: a3: AGENTS.md was overwritten by /init"; FAIL=$((FAIL+1))
fi
check "$OUTDIR/a3-init.plain.txt" "## Conventions" "a3: /init summary renders in chat"
send "/export"
send Enter
sleep 1
capture a3-export
check "$OUTDIR/a3-export.plain.txt" "diekspor ke" "a3: /export reports the file"
if ls "$PROJ"/metatech-export-*.md >/dev/null 2>&1; then
  echo "PASS: a3: export file exists in the project folder"; PASS=$((PASS+1))
else
  echo "FAIL: a3: export file missing in the project folder"; FAIL=$((FAIL+1))
fi
stop_tui

echo ""
echo "Agent PTY results: PASS=$PASS FAIL=$FAIL (captures in $OUTDIR)"
exit "$([ "$FAIL" -eq 0 ] && echo 0 || echo 1)"
