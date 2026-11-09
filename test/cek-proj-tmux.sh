#!/usr/bin/env bash
# Manual tmux verification: "cek project kita" with NO /agent toggle.
# Proves the default chat runs the agent loop (tools) against the mock.
# Produces .txt captures + .png renders in OUTDIR.
set -u
cd "$(dirname "$0")/.." || exit 1
OUTDIR="${1:-/tmp/mt-cek-proj-caps}"
mkdir -p "$OUTDIR"
MOCK_PORT="${MOCK_PORT:-18101}"
SESSION="methatech-cek-proj"

export METATECH_CONFIG_DIR="$OUTDIR/config"
export METATECH_API_KEY="test-key-pty"
export METATECH_API_BASE="http://127.0.0.1:$MOCK_PORT"
export METATECH_CONSOLE_BASE="http://127.0.0.1:$MOCK_PORT"
mkdir -p "$METATECH_CONFIG_DIR"
printf '{"apiKey":"test-key-pty","defaultModel":"glm-5.3-flash","savedAt":"2026-11-08T00:00:00Z"}' > "$METATECH_CONFIG_DIR/credentials.json"
chmod 600 "$METATECH_CONFIG_DIR/credentials.json"

# Mock in AGENT mode (scripted tool calls: todos, read, edit, shell).
MOCK_AGENT=1 node test/mock-server.mjs "$MOCK_PORT" > "$OUTDIR/mock-server.log" 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null; tmux kill-session -t "$SESSION" 2>/dev/null' EXIT
sleep 1

capture() { # capture <name>
  tmux capture-pane -t "$SESSION" -p -e > "$OUTDIR/$1.txt" 2>/dev/null
  sed 's/\x1b\[[0-9;]*m//g' "$OUTDIR/$1.txt" > "$OUTDIR/$1.plain.txt"
  python3 test/render-ansi-png.py "$OUTDIR/$1.txt" "$OUTDIR/$1.png" 2>/dev/null || true
}

# --- Run A: 80x24 (Termux size), project dir as cwd ---
tmux kill-session -t "$SESSION" 2>/dev/null
tmux new-session -d -s "$SESSION" -x 80 -y 24 \
  "cd /tmp/mt-cek-proj && METATECH_CONFIG_DIR='$METATECH_CONFIG_DIR' METATECH_API_KEY='test-key-pty' METATECH_API_BASE='http://127.0.0.1:$MOCK_PORT' METATECH_CONSOLE_BASE='http://127.0.0.1:$MOCK_PORT' node $PWD/dist/cli.js"
sleep 2
capture cek-welcome-small
tmux send-keys -t "$SESSION" "cek project kita" Enter
sleep 10
capture cek-done-small
tmux send-keys -t "$SESSION" C-c; sleep 1; tmux kill-session -t "$SESSION" 2>/dev/null

# --- Run B: 120x32 (desktop), same prompt ---
tmux new-session -d -s "$SESSION" -x 120 -y 32 \
  "cd /tmp/mt-cek-proj && METATECH_CONFIG_DIR='$METATECH_CONFIG_DIR' METATECH_API_KEY='test-key-pty' METATECH_API_BASE='http://127.0.0.1:$MOCK_PORT' METATECH_CONSOLE_BASE='http://127.0.0.1:$MOCK_PORT' node $PWD/dist/cli.js"
sleep 2
capture cek-welcome-desktop
tmux send-keys -t "$SESSION" "cek project kita" Enter
sleep 10
capture cek-done-desktop
tmux send-keys -t "$SESSION" C-c; sleep 1; tmux kill-session -t "$SESSION" 2>/dev/null

echo "--- checks ---"
for f in cek-done-small cek-done-desktop; do
  for needle in "cek project kita" "Read hello.txt" "Selesai" "hello.txt" "Agent: Default"; do
    if grep -qF "$needle" "$OUTDIR/$f.plain.txt"; then echo "PASS: $f contains '$needle'"; else echo "FAIL: $f missing '$needle'"; fi
  done
  if grep -qF "codebuff_tool_call" "$OUTDIR/$f.plain.txt"; then echo "FAIL: $f leaks tool-call XML"; else echo "PASS: $f no tool-call XML leak"; fi
done
echo "--- project effects ---"
cat /tmp/mt-cek-proj/hello.txt
ls /tmp/mt-cek-proj/agent-ran.txt 2>/dev/null && echo "agent-ran.txt EXISTS (shell ran)" || echo "agent-ran.txt MISSING"
ls "$OUTDIR"
