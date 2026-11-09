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
check_absent() { # check_absent <file> <needle> <label>
  if grep -qF "$2" "$1"; then
    echo "FAIL: $3 (needle '$2' unexpectedly found in $1)"; FAIL=$((FAIL+1))
  else
    echo "PASS: $3"; PASS=$((PASS+1))
  fi
}
row_of() { # row_of <file> <needle> -> 1-based line number of first match
  grep -n -m1 -F "$2" "$1" | cut -d: -f1
}
check_row() { # check_row <file> <needle> <expected-row> <label>
  local got
  got=$(row_of "$1" "$2")
  if [ "$got" = "$3" ]; then
    echo "PASS: $4"; PASS=$((PASS+1))
  else
    echo "FAIL: $4 (needle '$2' on row '${got:-none}', expected $3)"; FAIL=$((FAIL+1))
  fi
}
row_of_last() { # row_of_last <file> <needle> -> 1-based line number of LAST match
  grep -n -F "$2" "$1" | tail -1 | cut -d: -f1
}
check_last_row() { # check_last_row <file> <needle> <expected-row> <label>
  local got
  got=$(row_of_last "$1" "$2")
  if [ "$got" = "$3" ]; then
    echo "PASS: $4"; PASS=$((PASS+1))
  else
    echo "FAIL: $4 (needle '$2' last on row '${got:-none}', expected $3)"; FAIL=$((FAIL+1))
  fi
}
reset_credentials() { # reset_credentials — fresh credentials without firstPromptSubmitted
  printf '{"apiKey":"test-key-pty","defaultModel":"glm-5.3-flash","savedAt":"2026-11-08T00:00:00Z"}' > "$METATECH_CONFIG_DIR/credentials.json"
  chmod 600 "$METATECH_CONFIG_DIR/credentials.json"
}

restart_mock() { # restart_mock [first-delay-ms] — restart mock server, optionally slow SSE
  kill $MOCK_PID 2>/dev/null
  if [ -n "${1:-}" ]; then
    MOCK_SSE_FIRST_DELAY_MS="$1" node test/mock-server.mjs "$MOCK_PORT" > "$OUTDIR/mock-server.log" 2>&1 &
  else
    node test/mock-server.mjs "$MOCK_PORT" > "$OUTDIR/mock-server.log" 2>&1 &
  fi
  MOCK_PID=$!
  sleep 1
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
# The agent is the default chat (Freebuff: no plain-chat mode), so the
# footer always shows the agent mode — no /agent toggle needed.
start_tui 80 24
capture s1-tui-open
check "$OUTDIR/s1-tui-open.plain.txt" "MethaTech" "s1: header MethaTech renders"
check "$OUTDIR/s1-tui-open.plain.txt" "glm-5.3-flash" "s1: active model shown"
check "$OUTDIR/s1-tui-open.plain.txt" "Balance" "s1: balance shown"
check "$OUTDIR/s1-tui-open.plain.txt" "Agent: Default" "s1: footer shows Agent: Default (agent is the default chat)"
stop_tui

# --- Scenario 2: command palette on "/" + filtering + Esc ---
# NOTE: the palette shows a scrolling window of 8 rows (paletteMaxRowsFor
# clamp), and there are now 12 commands — /exit sits below the fold on
# first open and only appears after paging Down to it. That is the
# pre-existing window behaviour, not a regression.
start_tui 80 24
send "/"
capture s2-palette-open
check "$OUTDIR/s2-palette-open.plain.txt" "/model" "s2: palette lists /model"
check_absent "$OUTDIR/s2-palette-open.plain.txt" "/agent" "s2: palette does NOT list /agent (Freebuff has no agent toggle)"
for _ in $(seq 1 11); do tmux send-keys -t "$SESSION" Down; sleep 0.2; done
capture s2-palette-down
check "$OUTDIR/s2-palette-down.plain.txt" "/exit" "s2: paging Down reveals /exit below the fold"
send "mod"
capture s2-palette-filter
check "$OUTDIR/s2-palette-filter.plain.txt" "/model" "s2: filter keeps /model"
send Escape
capture s2-palette-esc
# After Esc the palette should be closed (no highlighted command list).
# NOTE: "/models" is also a welcome suggestion, so check "/exit" instead —
# it only exists in the palette.
if grep -q "/exit" "$OUTDIR/s2-palette-esc.plain.txt"; then
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

# --- Scenario 6: Ctrl+C double-tap exits (Freebuff use-exit-handler) ---
# First Ctrl+C on an empty idle draft only WARNS ("Press Ctrl-C again
# to exit" in the status bar, theme.secondary) and arms the exit; the
# session stays alive. The second Ctrl+C within 2s exits cleanly and
# the terminal is restored.
start_tui 80 24
tmux send-keys -t "$SESSION" C-c
sleep 0.5
capture s6-ctrlc-warning
check "$OUTDIR/s6-ctrlc-warning.plain.txt" "Press Ctrl-C again to exit" "s6: first Ctrl+C shows the exit warning"
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "PASS: s6: session still alive after first Ctrl+C (warning only)"; PASS=$((PASS+1))
else
  echo "FAIL: s6: session died after first Ctrl+C (must only warn)"; FAIL=$((FAIL+1))
fi
tmux send-keys -t "$SESSION" C-c
sleep 1
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "FAIL: s6: session still alive after second Ctrl+C"; FAIL=$((FAIL+1))
  tmux kill-session -t "$SESSION" 2>/dev/null
else
  echo "PASS: s6: second Ctrl+C exits cleanly"; PASS=$((PASS+1))
fi

# --- Scenario 7: input pinned to rows-2 + footer on last row, all sizes ---
for size in "40 15" "48 20" "80 24" "120 40" "200 50"; do
  set -- $size
  start_tui "$1" "$2"
  capture "s7-pos-${1}x${2}"
  check_row "$OUTDIR/s7-pos-${1}x${2}.plain.txt" "MethaTech" 1 "s7 ${1}x${2}: header on row 1 (no shell prompt above)"
  check_last_row "$OUTDIR/s7-pos-${1}x${2}.plain.txt" "╰" "$(( $2 - 2 ))" "s7 ${1}x${2}: input box bottom border on row $(( $2 - 2 ))"
  check "$OUTDIR/s7-pos-${1}x${2}.plain.txt" "Enter a coding task" "s7 ${1}x${2}: placeholder inside the input box"
  check_row "$OUTDIR/s7-pos-${1}x${2}.plain.txt" "Ctrl+C 2x keluar" "$2" "s7 ${1}x${2}: footer on last row $2"
  stop_tui
done

# --- Scenario 8: full black background (raw PTY bytes) ---
# NOTE: tmux capture-pane -e cannot show this — tmux drops the bg
# attribute of trailing-space cells in its grid. test/tui-bg-probe.py
# reads the raw bytes Ink emits instead (every frame line must carry
# a black-bg escape). It also re-checks header/input/footer rows.
export METATECH_CONFIG_DIR METATECH_API_KEY METATECH_API_BASE METATECH_CONSOLE_BASE
if python3 test/tui-bg-probe.py 80 24; then
  echo "PASS: s8: raw PTY 80x24 all-black + positions"; PASS=$((PASS+1))
else
  echo "FAIL: s8: raw PTY 80x24 all-black + positions"; FAIL=$((FAIL+1))
fi
if python3 test/tui-bg-probe.py 40 15; then
  echo "PASS: s8: raw PTY 40x15 all-black + positions"; PASS=$((PASS+1))
else
  echo "FAIL: s8: raw PTY 40x15 all-black + positions"; FAIL=$((FAIL+1))
fi

# --- Scenario 9: resize mid-session (keyboard open/close: 80x24 -> 80x15 -> 80x24) ---
start_tui 80 24
tmux resize-window -t "$SESSION" -x 80 -y 15
sleep 1
capture s9-resize-small
check_last_row "$OUTDIR/s9-resize-small.plain.txt" "╰" 13 "s9: input box bottom border still on row 13 after shrink to 80x15"
check_last_row "$OUTDIR/s9-resize-small.plain.txt" "Ctrl+C 2x keluar" 15 "s9: footer on last row after shrink"
tmux resize-window -t "$SESSION" -x 80 -y 24
sleep 1
capture s9-resize-back
check_last_row "$OUTDIR/s9-resize-back.plain.txt" "╰" 22 "s9: input box bottom border back on row 22 after grow to 80x24"
stop_tui

# --- Scenario 10: long conversation — windowing + PgUp/PgDn ---
start_tui 80 24
for i in $(seq 1 30); do
  send "pesan $(printf %02d $i)" Enter
done
sleep 1
capture s10-long
check_last_row "$OUTDIR/s10-long.plain.txt" "╰" 22 "s10: input box bottom border stays on row 22 after 30 messages"
check "$OUTDIR/s10-long.plain.txt" "Ini balasan mock." "s10: latest reply visible"
check_absent "$OUTDIR/s10-long.plain.txt" "│ You: pesan 01" "s10: oldest message scrolled out of view"
check_absent "$OUTDIR/s10-long.plain.txt" "baris di atas" "s10: no scroll indicator at the bottom (Freebuff shows affordances only when scrolled up)"
send PageUp
sleep 0.3
capture s10-pageup
check "$OUTDIR/s10-pageup.plain.txt" "pesan 27" "s10: one PgUp shows history one page up"
check "$OUTDIR/s10-pageup.plain.txt" "baris di atas" "s10: scroll indicator shown while scrolled up"
check "$OUTDIR/s10-pageup.plain.txt" "↓ PgDn" "s10: scroll-to-bottom affordance in the footer while scrolled up"
check "$OUTDIR/s10-pageup.plain.txt" "█" "s10: scrollbar thumb track visible while scrolled up"
check_last_row "$OUTDIR/s10-pageup.plain.txt" "╰" 22 "s10: input box bottom border stays on row 22 while scrolled up"
for _ in $(seq 1 9); do tmux send-keys -t "$SESSION" PageUp; sleep 0.2; done
sleep 0.3
capture s10-pageup-top
check "$OUTDIR/s10-pageup-top.plain.txt" "pesan 01" "s10: repeated PgUp reaches the oldest history"
for _ in $(seq 1 10); do tmux send-keys -t "$SESSION" PageDown; sleep 0.2; done
sleep 0.3
capture s10-pagedown
check "$OUTDIR/s10-pagedown.plain.txt" "Ini balasan mock." "s10: PgDn returns to latest reply"
check_absent "$OUTDIR/s10-pagedown.plain.txt" "│ You: pesan 01" "s10: back at bottom, old history hidden again"
check_absent "$OUTDIR/s10-pagedown.plain.txt" "↓ PgDn" "s10: no scroll-to-bottom affordance once back at the bottom"
check "$OUTDIR/s10-pagedown.plain.txt" "│" "s10: scrollbar track still visible at the bottom while history overflows (thumb sits at the bottom)"
stop_tui

# --- Scenario 11: picker + palette on a short terminal (40x15) ---
start_tui 40 15
send "/model"
send Enter
sleep 1
capture s11-picker-short
check "$OUTDIR/s11-picker-short.plain.txt" "Pilih model" "s11: picker opens at 40x15"
check_last_row "$OUTDIR/s11-picker-short.plain.txt" "╰" 13 "s11: input box bottom border on row 13 with picker open"
send Escape
capture s11-picker-esc
check_last_row "$OUTDIR/s11-picker-esc.plain.txt" "╰" 13 "s11: input box bottom border back on row 13 after Esc"
send "/"
capture s11-palette-short
check "$OUTDIR/s11-palette-short.plain.txt" "/model" "s11: palette opens at 40x15"
check_last_row "$OUTDIR/s11-palette-short.plain.txt" "╰" 13 "s11: input box bottom border on row 13 with palette open"
send Escape
capture s11-palette-esc
check_last_row "$OUTDIR/s11-palette-esc.plain.txt" "╰" 13 "s11: input box bottom border back on row 13 after palette Esc"
stop_tui

# --- Scenario 12: Thinking + streaming keep input/footer stable ---
restart_mock 3000
start_tui 80 24
send "halo"
send Enter
sleep 0.5
capture s12-thinking
check "$OUTDIR/s12-thinking.plain.txt" "thinking..." "s12: thinking... shows while waiting for first delta (Freebuff lowercase)"
check "$OUTDIR/s12-thinking.plain.txt" "■ Esc" "s12: Esc stop hint shows while waiting"
check_absent "$OUTDIR/s12-thinking.plain.txt" "Esc to stop" "s12: no long Esc to stop text (Freebuff uses exactly ■ Esc)"
check_absent "$OUTDIR/s12-thinking.plain.txt" "0s" "s12: elapsed timer hidden while 0s (Freebuff hides it at 0)"
check_last_row "$OUTDIR/s12-thinking.plain.txt" "╰" 22 "s12: input box bottom border stable on row 22 during Thinking"
sleep 4
capture s12-streamed
check "$OUTDIR/s12-streamed.plain.txt" "Halo! Ini balasan mock." "s12: streamed reply arrives after Thinking"
check_last_row "$OUTDIR/s12-streamed.plain.txt" "╰" 22 "s12: input box bottom border stable on row 22 after streaming"
stop_tui

# --- Scenario 13: welcome / empty state fills the middle (0 messages) ---
# Earlier scenarios already sent a first prompt (persisted), so reset
# the credentials to see the starters again.
reset_credentials
start_tui 80 24
capture s13-welcome-desktop
check "$OUTDIR/s13-welcome-desktop.plain.txt" "Pesan pertama memulai sesi" "s13: welcome info box shows at 80x24"
check "$OUTDIR/s13-welcome-desktop.plain.txt" "Try:" "s13: welcome suggestions label shows"
check "$OUTDIR/s13-welcome-desktop.plain.txt" "/models" "s13: welcome suggests /models"
check_row "$OUTDIR/s13-welcome-desktop.plain.txt" "MethaTech" 1 "s13: header still on row 1 with welcome"
check_last_row "$OUTDIR/s13-welcome-desktop.plain.txt" "╰" 22 "s13: input box bottom border on row 22 with welcome"
# The wordmark banner sits in the middle of the message area, not at the top.
banner_row=$(row_of "$OUTDIR/s13-welcome-desktop.plain.txt" "M   M")
if [ -n "$banner_row" ] && [ "$banner_row" -gt 2 ] && [ "$banner_row" -lt 12 ]; then
  echo "PASS: s13: banner vertically centered (row $banner_row)"; PASS=$((PASS+1))
else
  echo "FAIL: s13: banner not centered (row '${banner_row:-none}', expected 3-11)"; FAIL=$((FAIL+1))
fi
stop_tui
start_tui 40 15
capture s13-welcome-small
check "$OUTDIR/s13-welcome-small.plain.txt" "Pesan pertama memulai sesi" "s13: welcome info box shows at 40x15"
check "$OUTDIR/s13-welcome-small.plain.txt" "Try:" "s13: welcome suggestions show at 40x15"
check_last_row "$OUTDIR/s13-welcome-small.plain.txt" "╰" 13 "s13: input box bottom border on row 13 with welcome at 40x15"
stop_tui

# --- Scenario 14: welcome disappears after the first message ---
restart_mock
start_tui 80 24
send "halo"
send Enter
sleep 1
capture s14-welcome-gone
check_absent "$OUTDIR/s14-welcome-gone.plain.txt" "Pesan pertama memulai sesi" "s14: welcome info gone after first message"
check_absent "$OUTDIR/s14-welcome-gone.plain.txt" "Try:" "s14: welcome suggestions gone after first message"
check "$OUTDIR/s14-welcome-gone.plain.txt" "Halo! Ini balasan mock." "s14: reply renders after welcome leaves"
stop_tui

# --- Scenario 15: history — Up recalls the last sent message into the draft ---
start_tui 80 24
send "pesan history"
send Enter
sleep 1
send Up
capture s15-history-up
# The recalled text must sit on the input row (21: the box
# content row, one above the bottom border), not just in the log above.
if sed -n '21p' "$OUTDIR/s15-history-up.plain.txt" | grep -q "pesan history"; then
  echo "PASS: s15: Up recalls last message into the input"; PASS=$((PASS+1))
else
  echo "FAIL: s15: Up did not recall into the input"; FAIL=$((FAIL+1))
fi
send Down
capture s15-history-down
if sed -n '21p' "$OUTDIR/s15-history-down.plain.txt" | grep -q "pesan history"; then
  echo "FAIL: s15: Down did not clear the recalled draft"; FAIL=$((FAIL+1))
else
  echo "PASS: s15: Down past newest clears the draft"; PASS=$((PASS+1))
fi
stop_tui

# --- Scenario 16: Esc interrupts a live stream ---
restart_mock 3000
start_tui 80 24
send "halo"
send Enter
sleep 0.5
tmux send-keys -t "$SESSION" Escape
sleep 1
capture s16-interrupt
check "$OUTDIR/s16-interrupt.plain.txt" "dibatalkan" "s16: Esc interrupts the stream"
check "$OUTDIR/s16-interrupt.plain.txt" "MethaTech" "s16: TUI stays alive after interrupt"
stop_tui

# --- Scenario 17: "?" shows help, Tab opens the picker ---
start_tui 80 24
send "?"
sleep 1
capture s17-help
check "$OUTDIR/s17-help.plain.txt" "/models" "s17: ? shows the help lines"
send Escape
send Tab
sleep 1
capture s17-tab-picker
check "$OUTDIR/s17-tab-picker.plain.txt" "Pilih model" "s17: Tab opens the model picker"
check "$OUTDIR/s17-tab-picker.plain.txt" "FREE" "s17: picker shows the FREE group"
stop_tui

# --- Scenario 18: starter key "1" sends a starter prompt directly ---
reset_credentials
restart_mock
start_tui 80 24
send "1"
sleep 1
capture s18-starter
check "$OUTDIR/s18-starter.plain.txt" "Halo! Ini balasan mock." "s18: starter key sends and the reply streams"
check_absent "$OUTDIR/s18-starter.plain.txt" "Try:" "s18: starters gone after the first prompt"
stop_tui

# --- Scenario 19: footer line 1 carries model + cwd + Chat name ---
start_tui 80 24
capture s19-footer
check "$OUTDIR/s19-footer.plain.txt" "/model to change" "s19: footer line 1 has /model to change"
check "$OUTDIR/s19-footer.plain.txt" "Chat: New chat" "s19: footer shows Chat: New chat on empty state"
check_row "$OUTDIR/s19-footer.plain.txt" "Ctrl+C 2x keluar" 24 "s19: hint line still on the last row"
stop_tui

# --- Scenario 20: reasoning delta renders as a Thinking block before the answer ---
MOCK_REASONING=1 restart_mock
start_tui 80 24
send "halo"
send Enter
sleep 1
capture s20-thinking-block
check "$OUTDIR/s20-thinking-block.plain.txt" "Thinking" "s20: Thinking block renders"
check "$OUTDIR/s20-thinking-block.plain.txt" "mock reasoning here" "s20: reasoning text renders before the answer"
check "$OUTDIR/s20-thinking-block.plain.txt" "Halo! Ini balasan mock." "s20: answer still renders after the block"
stop_tui

# --- Scenario 21: bordered input box + message blocks (Freebuff chat-input-bar / message-block) ---
reset_credentials
start_tui 80 24
capture s21-chatbox-desktop
check "$OUTDIR/s21-chatbox-desktop.plain.txt" "╭" "s21: input box top border renders at 80x24"
check "$OUTDIR/s21-chatbox-desktop.plain.txt" "╰" "s21: input box bottom border renders at 80x24"
check "$OUTDIR/s21-chatbox-desktop.plain.txt" "Enter a coding task or / for commands" "s21: placeholder inside the input box at 80x24"
check_last_row "$OUTDIR/s21-chatbox-desktop.plain.txt" "╰" 22 "s21: input box bottom border on row 22 at 80x24"
check_row "$OUTDIR/s21-chatbox-desktop.plain.txt" "Enter a coding task" 21 "s21: placeholder on the input row 21 at 80x24"
send "halo"
send Enter
sleep 1
capture s21-chatbox-chat
check "$OUTDIR/s21-chatbox-chat.plain.txt" "You:" "s21: user block has the You: label"
check_absent "$OUTDIR/s21-chatbox-chat.plain.txt" "Muse:" "s21: assistant block has NO Muse: label (Freebuff shows the answer directly)"
check "$OUTDIR/s21-chatbox-chat.plain.txt" "Halo! Ini balasan mock." "s21: reply streams in the assistant block"
check_last_row "$OUTDIR/s21-chatbox-chat.plain.txt" "╰" 22 "s21: input box stays on row 22 after a message"
stop_tui
start_tui 40 15
capture s21-chatbox-small
check "$OUTDIR/s21-chatbox-small.plain.txt" "╭" "s21: input box top border renders at 40x15"
check "$OUTDIR/s21-chatbox-small.plain.txt" "╰" "s21: input box bottom border renders at 40x15"
check "$OUTDIR/s21-chatbox-small.plain.txt" "Enter a coding task" "s21: placeholder inside the input box at 40x15"
check_last_row "$OUTDIR/s21-chatbox-small.plain.txt" "╰" 13 "s21: input box bottom border on row 13 at 40x15"
stop_tui

# --- Scenario 22: no session-start block (removed 2026-11-08) ---
# The "New conversation started (session: ...) / Model set to ..."
# block came from VectorHead, NOT Freebuff — Freebuff has no such
# text block (AGENT-ADOPTION.md §10.1), and Reza's standing rule is
# to adopt from the original Freebuff source only. The block was
# removed; the welcome already shows model / FREE / balance in its
# info box. Assert the block is gone in both states, and the chat
# still works with no "Muse:" label.
reset_credentials
start_tui 80 24
capture s22-session-start
check "$OUTDIR/s22-session-start.plain.txt" "Pesan pertama memulai sesi" "s22: welcome still shows at TUI open"
check_absent "$OUTDIR/s22-session-start.plain.txt" "New conversation started" "s22: no session-start block at TUI open"
send "halo"
send Enter
sleep 1
capture s22-session-chat
check_absent "$OUTDIR/s22-session-chat.plain.txt" "New conversation started (session:" "s22: no session-start line in the history"
check_absent "$OUTDIR/s22-session-chat.plain.txt" "Model set to glm-5.3-flash" "s22: no Model set to line in the history"
check "$OUTDIR/s22-session-chat.plain.txt" "Halo! Ini balasan mock." "s22: reply still streams without the session block"
check_absent "$OUTDIR/s22-session-chat.plain.txt" "Pesan pertama memulai sesi" "s22: welcome gone after first message"
check_absent "$OUTDIR/s22-session-chat.plain.txt" "Muse:" "s22: still no Muse: label"
stop_tui

# --- Scenario 23: PgUp/PgDn scroll the chat even with the picker open ---
# Freebuff scrolls the chat history with PgUp/PgDn regardless of the
# model picker being open (keyboard-actions.ts priority 14, before the
# picker branch); the picker only handles arrows + Enter. MethaTech
# used to swallow every unhandled key while the picker was open.
# NOTE: 80x40, not 80x24 — at 24 rows the open picker leaves ~1 row
# for history (pre-existing picker budget), so one PgUp moves a
# single line and nothing is visible; at 40 rows the message area
# stays ~18 rows and the scrolled history is actually readable.
reset_credentials
start_tui 80 40
for i in $(seq 1 8); do
  send "pesan $(printf %02d $i)" Enter
done
sleep 1
send Tab
sleep 0.3
capture s23-picker-open
check "$OUTDIR/s23-picker-open.plain.txt" "deepseek-v4-flash" "s23: model picker is open (other model ids listed)"
send PageUp
sleep 0.3
capture s23-picker-pageup
check "$OUTDIR/s23-picker-pageup.plain.txt" "deepseek-v4-flash" "s23: picker STILL open after PgUp (PgUp scrolls, does not close it)"
check "$OUTDIR/s23-picker-pageup.plain.txt" "pesan 01" "s23: PgUp with picker open scrolls the chat to older history"
check "$OUTDIR/s23-picker-pageup.plain.txt" "baris di atas" "s23: scroll indicator shows while scrolled up with picker open"
send PageDown
sleep 0.3
capture s23-picker-pagedown
check "$OUTDIR/s23-picker-pagedown.plain.txt" "Ini balasan mock." "s23: PgDn with picker open returns to the latest reply"
stop_tui

# --- Scenario 24: Ctrl+C clears a draft, interrupts a stream, warning expires ---
# Freebuff priority order: Ctrl+C with text clears the input (priority
# 3, BEFORE interrupt); Ctrl+C with an empty draft while streaming
# interrupts (priority 4); the exit warning resets after 2s, so a
# Ctrl+C pressed after the window only warns again instead of exiting.
start_tui 80 24
send "hello world"
sleep 0.3
tmux send-keys -t "$SESSION" C-c
sleep 0.3
capture s24-ctrlc-clears
check_absent "$OUTDIR/s24-ctrlc-clears.plain.txt" "hello world" "s24: Ctrl+C with a draft clears it instead of exiting"
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "PASS: s24: session alive after Ctrl+C on a draft"; PASS=$((PASS+1))
else
  echo "FAIL: s24: session died after Ctrl+C on a draft"; FAIL=$((FAIL+1))
fi
# Slow the mock's first SSE chunk to 3000ms (same as s16) so the
# stream is still waiting when Ctrl+C is pressed at 0.5s.
restart_mock 3000
send "halo"
send Enter
sleep 0.5
tmux send-keys -t "$SESSION" C-c
sleep 1
capture s24-ctrlc-interrupt
check "$OUTDIR/s24-ctrlc-interrupt.plain.txt" "dibatalkan" "s24: Ctrl+C with empty draft while streaming interrupts (same as Esc)"
check "$OUTDIR/s24-ctrlc-interrupt.plain.txt" "MethaTech" "s24: TUI stays alive after Ctrl+C interrupt"
tmux send-keys -t "$SESSION" C-c
sleep 0.5
capture s24-ctrlc-warning
check "$OUTDIR/s24-ctrlc-warning.plain.txt" "Press Ctrl-C again to exit" "s24: Ctrl+C after interrupt warns (draft empty, idle)"
sleep 2.5
tmux send-keys -t "$SESSION" C-c
sleep 0.5
capture s24-ctrlc-warning-again
check "$OUTDIR/s24-ctrlc-warning-again.plain.txt" "Press Ctrl-C again to exit" "s24: Ctrl+C after the 2s window only warns again (flag expired, no exit)"
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "PASS: s24: session alive after expired-window Ctrl+C"; PASS=$((PASS+1))
else
  echo "FAIL: s24: session died after expired-window Ctrl+C (must only warn)"; FAIL=$((FAIL+1))
fi
tmux send-keys -t "$SESSION" C-c
sleep 1
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "FAIL: s24: session still alive after second Ctrl+C in the window"; FAIL=$((FAIL+1))
  tmux kill-session -t "$SESSION" 2>/dev/null
else
  echo "PASS: s24: second Ctrl+C in the window exits"; PASS=$((PASS+1))
fi

echo ""
echo "PTY results: PASS=$PASS FAIL=$FAIL (captures in $OUTDIR)"
exit "$([ "$FAIL" -eq 0 ] && echo 0 || echo 1)"
