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
  # NOTE: `--` before the needle — a needle starting with "-" (e.g.
  # "- [x]") must not be parsed as a grep option. Without it the
  # check "passes" vacuously because grep errors out.
  if grep -qF -- "$2" "$1"; then
    echo "PASS: $3"; PASS=$((PASS+1))
  else
    echo "FAIL: $3 (needle '$2' not found in $1)"; FAIL=$((FAIL+1))
  fi
}
check_absent() { # check_absent <file> <needle> <label>
  if grep -qF -- "$2" "$1"; then
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
lead_spaces() { # lead_spaces <file> <needle> -> leading spaces of first row containing needle, or NOTFOUND
  local row
  row=$(grep -m1 -F -- "$2" "$1") || { echo "NOTFOUND"; return; }
  printf '%s' "$row" | sed 's/[^ ].*//' | tr -d '\n' | wc -c
}
check_lead() { # check_lead <file> <needle> <expected> <label>
  local got
  got=$(lead_spaces "$1" "$2")
  if [ "$got" = "$3" ]; then echo "PASS: $4"; PASS=$((PASS+1)); else echo "FAIL: $4 (leading spaces '${got:-none}', expected $3)"; FAIL=$((FAIL+1)); fi
}
dash_run() { # dash_run <file> -> number of ─ chars on the divider row (spaces + dashes + optional scrollbar char)
  # NOTE: grep -E "^ +─+ *$" does NOT work here — in the C locale the
  # `+` applies to the last BYTE of the 3-byte ─, so the pattern never
  # matches. awk's gsub on the whole ─ string counts correctly. The
  # row used to carry a trailing scrollbar char (│/█) while the
  # scrollbar showed — 0.1.9 §4q removed the scrollbar, so no
  # trailing char is expected anymore; the strip stays as a guard.
  awk '{ n=gsub(/─/, "─"); rest=$0; gsub(/[ ─│█]/, "", rest); if (n>0 && rest=="") { print n; exit } }' "$1"
}
check_dash_run() { # check_dash_run <file> <expected> <label>
  local got
  got=$(dash_run "$1")
  if [ "$got" = "$2" ]; then echo "PASS: $3"; PASS=$((PASS+1)); else echo "FAIL: $3 (divider run $got, expected $2)"; FAIL=$((FAIL+1)); fi
}
check_no_track() { # check_no_track <file> <label> — no message-area row ends with a scrollbar char (│/█)
  # Rows above the input box top border (first ╭ row) are the message
  # area; the input box itself legitimately ends its middle row with
  # │, and the footer below it is out of scope. Trailing spaces are
  # trimmed before testing the last character. 0.1.9 §4q: the
  # scrollbar is gone, so no message-area row may end with │ or █.
  local bad
  bad=$(awk 'NR==1{input=9999} /╭/ && input==9999 {input=NR} { line=$0; sub(/ +$/, "", line); if (NR < input && line ~ /[│█]$/) { print NR; exit } }' "$1")
  if [ -z "$bad" ]; then echo "PASS: $2"; PASS=$((PASS+1)); else echo "FAIL: $2 (message-area row $bad ends with a scrollbar char)"; FAIL=$((FAIL+1)); fi
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
wheel() { # wheel <up|down> <count> — inject N SGR mouse-wheel events in one
  # tmux write (button 64 = wheel up, 65 = wheel down, SGR 1006;
  # coordinates 10,5 — the gesture anchor, unused by the TUI).
  # Ink splits the burst into one useInput event per sequence, so the
  # app sees N separate wheel ticks, exactly like a Termux fling.
  local b2=34 i
  [ "${1:-up}" = down ] && b2=35
  local args=()
  for i in $(seq 1 "${2:-1}"); do args+=(1b 5b 3c 36 "$b2" 3b 31 30 3b 35 4d); done
  tmux send-keys -t "$SESSION" -H "${args[@]}"; sleep 1
}
tap() { # tap — inject one SGR left-click press+release (a Termux tap
  # with mouse tracking on); the TUI must swallow it, never type it.
  tmux send-keys -t "$SESSION" -H 1b 5b 3c 30 3b 31 30 3b 35 4d 1b 5b 3c 30 3b 31 30 3b 35 6d; sleep 1
}
paste_bracketed() { # paste_bracketed <file> — inject a file's bytes as
  # ONE bracketed paste (ESC[200~ ... ESC[201~) via send-keys -H,
  # exactly what a terminal sends once the app enabled 2004h
  # (verified against the Ink probe 2026-11-09: the markers arrive
  # as separate useInput calls, the payload possibly split across
  # calls — the assembler must handle both).
  local hex
  hex=$(python3 -c "
import sys
data = open(sys.argv[1], 'rb').read()
out = ['1b', '5b', '32', '30', '30', '7e']
out += [format(b, '02x') for b in data]
out += ['1b', '5b', '32', '30', '31', '7e']
print(' '.join(out))
" "$1")
  # shellcheck disable=SC2086
  tmux send-keys -t "$SESSION" -H $hex; sleep 1
}
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
check_absent "$OUTDIR/s10-pageup.plain.txt" "█" "s10: no scrollbar thumb while scrolled up (removed §4q, scroll still works)"
check_no_track "$OUTDIR/s10-pageup.plain.txt" "s10: no scrollbar track at the right edge while scrolled up (§4q)"
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
check_absent "$OUTDIR/s10-pagedown.plain.txt" "█" "s10: no scrollbar thumb at the bottom while history overflows (§4q)"
check_no_track "$OUTDIR/s10-pagedown.plain.txt" "s10: no scrollbar track at the right edge at the bottom (§4q)"
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
# 0.1.9 §4o: welcome is TOP-anchored (Freebuff chat.tsx flex-start) —
# the banner is the first content row of the message area (row 2,
# directly below the header), the empty space sits below the block.
banner_row=$(row_of "$OUTDIR/s13-welcome-desktop.plain.txt" "M   M")
if [ "$banner_row" = "2" ]; then
  echo "PASS: s13: banner top-anchored (row 2)"; PASS=$((PASS+1))
else
  echo "FAIL: s13: banner not top-anchored (row '${banner_row:-none}', expected 2)"; FAIL=$((FAIL+1))
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
# The recalled text must sit on the input row (20: the centered
# middle row of the 5-row composer, 0.1.9 §4o — was 21 with the
# 3-row box), not just in the log above.
if sed -n '20p' "$OUTDIR/s15-history-up.plain.txt" | grep -q "pesan history"; then
  echo "PASS: s15: Up recalls last message into the input"; PASS=$((PASS+1))
else
  echo "FAIL: s15: Up did not recall into the input"; FAIL=$((FAIL+1))
fi
send Down
capture s15-history-down
if sed -n '20p' "$OUTDIR/s15-history-down.plain.txt" | grep -q "pesan history"; then
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
check_row "$OUTDIR/s21-chatbox-desktop.plain.txt" "Enter a coding task" 20 "s21: placeholder on the centered input row 20 at 80x24 (0.1.9 §4o: 5-row composer, middle row)"
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

# --- Scenario 25: text rendering showcase (0.1.8, Freebuff markdown
# renderer adoption) ---
# MOCK_MARKDOWN=1 makes the mock answer with a showcase of every
# Markdown feature the TUI renders. Assert the markers are GONE
# (rendered, not raw) and the rendered shapes are present: heading,
# task checkboxes, blockquote "> ", table box borders, inline code,
# link text. The mock server is a long-running child: it reads the
# env per request, but only the env it started with — so restart it
# after exporting MOCK_MARKDOWN.
export MOCK_MARKDOWN=1
restart_mock
reset_credentials
start_tui 80 24
send "tampilkan ringkasan"
send Enter
sleep 2
capture s25-markdown
# Bottom view: the heading scrolled out (the Freebuff-faithful
# renderer puts a blank line after every list/quote/table/divider,
# so the message is 22 lines in an 18-row area — see s26/80).
# Everything below the heading is in the bottom view; the heading
# itself is checked in the top capture after one PgUp.
check "$OUTDIR/s25-markdown.plain.txt" "[x] tulis tes" "s25: task list checkbox renders"
check "$OUTDIR/s25-markdown.plain.txt" "[ ] verifikasi manual" "s25: unchecked task renders"
check "$OUTDIR/s25-markdown.plain.txt" "> Catatan: cek README.md dulu." "s25: blockquote renders with '> '"
check "$OUTDIR/s25-markdown.plain.txt" "│ Model │ Harga │" "s25: table header renders in box borders"
check "$OUTDIR/s25-markdown.plain.txt" "┌" "s25: table top border renders"
check "$OUTDIR/s25-markdown.plain.txt" "npm test" "s25: inline code renders"
check "$OUTDIR/s25-markdown.plain.txt" "docs" "s25: link text renders"
check_absent "$OUTDIR/s25-markdown.plain.txt" "**README.md**" "s25: no raw **bold** markers"
check_absent "$OUTDIR/s25-markdown.plain.txt" "~~yang lama~~" "s25: no raw ~~strike~~ markers"
check_absent "$OUTDIR/s25-markdown.plain.txt" "|---|---|" "s25: no raw table separator row"
check_absent "$OUTDIR/s25-markdown.plain.txt" "- [x]" "s25: no raw '- [x]' list marker"
check_absent "$OUTDIR/s25-markdown.plain.txt" "# Ringkasan" "s25: no raw '# ' heading marker"
send PageUp
capture s25-markdown-top
check "$OUTDIR/s25-markdown-top.plain.txt" "Ringkasan" "s25: heading renders (top view)"
stop_tui
unset MOCK_MARKDOWN

# --- Scenario 26: horizontal gutter (0.1.8, Freebuff SIDE_GUTTER) ---
# Same markdown showcase, measured at 80 / 40 / 120 columns. Freebuff
# layering (scrollbox 1 + message SIDE_GUTTER 1): message text at col
# 2, header text at col 2, user line at col 4 (gutter + bar + space),
# footer/status at col 1, input border at col 1 with text at col 3.
# Divider follows the content width (74 at 80 cols when the scrollbar
# shows, 34 at 40 cols, capped at 80 at 120 cols) and never touches
# either edge.
export MOCK_MARKDOWN=1
restart_mock
reset_credentials
start_tui 80 24
send "tampilkan ringkasan"
send Enter
sleep 2
capture s26-gutter-80
check_lead "$OUTDIR/s26-gutter-80.plain.txt" "MethaTech" 2 "s26/80: header text at col 2 (root 1 + header 1)"
check_lead "$OUTDIR/s26-gutter-80.plain.txt" "┌" 2 "s26/80: table top border at col 2"
check_lead "$OUTDIR/s26-gutter-80.plain.txt" "Agent: Default" 1 "s26/80: footer at col 1 (status-bar layer)"
check_lead "$OUTDIR/s26-gutter-80.plain.txt" "╭" 1 "s26/80: input border at col 1"
check "$OUTDIR/s26-gutter-80.plain.txt" " │ ▋Enter a coding task" "s26/80: input placeholder after border + padding (cursor col 3, text col 4; box unchanged)"
# Divider is 75, the full messageWidth: the Freebuff-faithful renderer
# puts a blank line after every list/quote/table/divider (0.1.8 §4h),
# so this message is 22 lines in an 18-row area and history overflows.
# 0.1.9 §4q removed the scrollbar, so lines no longer re-wrap 1 column
# narrower for a track — the reclaimed column goes back to the text.
check_dash_run "$OUTDIR/s26-gutter-80.plain.txt" 75 "s26/80: divider is 75 wide (full messageWidth, no scrollbar re-wrap §4q)"
# The heading and user line scrolled out of the bottom view (4 lines
# hidden); one PgUp reaches the top.
send PageUp
capture s26-gutter-80-top
check_lead "$OUTDIR/s26-gutter-80-top.plain.txt" "Ringkasan" 2 "s26/80: heading at col 2 (root 1 + gutter 1)"
check_lead "$OUTDIR/s26-gutter-80-top.plain.txt" "You:" 4 "s26/80: user line at col 4 (gutter + bar + space)"
stop_tui
start_tui 40 15
send "tampilkan ringkasan"
send Enter
sleep 2
capture s26-gutter-40
check_lead "$OUTDIR/s26-gutter-40.plain.txt" "MethaTech" 2 "s26/40: header text at col 2 on narrow terminal"
# At 40x15 the message area holds ~6 rows. The divider IS in the
# bottom view; it is 35 wide, the full messageWidth — 0.1.9 §4q
# removed the scrollbar, so there is no 1-column re-wrap for a track
# anymore (the user line is gutter + bar + space + text, and the
# divider follows the wrap width).
check_dash_run "$OUTDIR/s26-gutter-40.plain.txt" 35 "s26/40: divider is 35 wide (full messageWidth, no scrollbar re-wrap §4q)"
# The message is 24 lines at 40 cols. One PgUp lands 1 line short
# of the table top (13 hidden above); a second PgUp shows it.
# Two more PgUps reach the top (3 hidden above after 3 PgUps).
send PageUp
send PageUp
capture s26-gutter-40-mid
check_lead "$OUTDIR/s26-gutter-40-mid.plain.txt" "┌" 2 "s26/40: table stays inside the content area"
send PageUp
send PageUp
capture s26-gutter-40-top
check_lead "$OUTDIR/s26-gutter-40-top.plain.txt" "Ringkasan" 2 "s26/40: heading at col 2 on narrow terminal"
check_lead "$OUTDIR/s26-gutter-40-top.plain.txt" "You:" 4 "s26/40: user line at col 4 on narrow terminal"
stop_tui
start_tui 120 36
send "tampilkan ringkasan"
send Enter
sleep 2
capture s26-gutter-120
check_lead "$OUTDIR/s26-gutter-120.plain.txt" "MethaTech" 2 "s26/120: header text at col 2 on wide terminal"
check_lead "$OUTDIR/s26-gutter-120.plain.txt" "Ringkasan" 2 "s26/120: heading at col 2 on wide terminal"
check_lead "$OUTDIR/s26-gutter-120.plain.txt" "┌" 2 "s26/120: table top border at col 2"
check_lead "$OUTDIR/s26-gutter-120.plain.txt" "You:" 4 "s26/120: user line at col 4 on wide terminal"
check_dash_run "$OUTDIR/s26-gutter-120.plain.txt" 80 "s26/120: divider capped at 80, content never spans edge to edge"
stop_tui
unset MOCK_MARKDOWN

# s27 — full Markdown showcase (0.1.8 §4h), streamed in 17-char
# chunks. Proves the parse-first renderer: no raw markers anywhere
# (bold/italic/strike/code/fence/table), at 80 and at 40 cols where
# the ~~ span is forced to straddle a wrap (§4g regression, live).
export MOCK_MARKDOWN_FULL=1
restart_mock
reset_credentials
start_tui 80 24
send "tampilkan panduan"
send Enter
sleep 3
capture s27-markdown-80-bottom
check "$OUTDIR/s27-markdown-80-bottom.plain.txt" "// js" "s27/80: fenced code block renders with // lang header"
check "$OUTDIR/s27-markdown-80-bottom.plain.txt" "console.log(x);" "s27/80: code block body renders"
check_absent "$OUTDIR/s27-markdown-80-bottom.plain.txt" "\`\`\`" "s27/80: no raw fence markers"
send PageUp
send PageUp
send PageUp
capture s27-markdown-80-top
check "$OUTDIR/s27-markdown-80-top.plain.txt" "Panduan Lengkap" "s27/80: H1 renders"
check "$OUTDIR/s27-markdown-80-top.plain.txt" "teks tebal" "s27/80: bold text renders"
check "$OUTDIR/s27-markdown-80-top.plain.txt" "1. pertama" "s27/80: numbered list renders"
check_absent "$OUTDIR/s27-markdown-80-top.plain.txt" "**teks tebal**" "s27/80: no raw **bold** markers"
check_absent "$OUTDIR/s27-markdown-80-top.plain.txt" "~~teks dicoret~~" "s27/80: no raw ~~strike~~ markers"
# 0.1.9 §4o: the blockquote sits on flat line 17, but the message area
# at 80x24 is now 16 rows (5-row centered composer), so even at the
# very top the blockquote is 1 row below the fold — it can no longer
# share one frame with the H1. One PageDown from the top lands the
# window on lines 12-27, where the blockquote renders. The renderer
# is unchanged; only the viewport is smaller, exactly as Freebuff's.
send PageDown
capture s27-markdown-80-mid
check "$OUTDIR/s27-markdown-80-mid.plain.txt" "> Kutipan penting" "s27/80: blockquote renders (one page down from the top)"
stop_tui
start_tui 40 15
send "tampilkan panduan"
send Enter
sleep 3
send PageUp
send PageUp
send PageUp
send PageUp
send PageUp
send PageUp
send PageUp
# 0.1.9 §4o: the struck span sits on flat line 7, and the 7-row
# message area at 40x15 shows lines 1-6 from the 7-PageUp landing —
# 1 row short of it. The landing itself varies by a row across runs
# (PageUp clamp/animation), so one PageDown after it pins the window
# deterministically onto lines 5-11, where the struck line renders.
# The renderer is unchanged; this only re-aims the viewport.
send PageDown
capture s27-markdown-40-top
check "$OUTDIR/s27-markdown-40-top.plain.txt" "teks dicoret" "s27/40: struck text survives the wrap"
check_absent "$OUTDIR/s27-markdown-40-top.plain.txt" "~~" "s27/40: no raw ~~ markers at narrow width (§4g)"
check_absent "$OUTDIR/s27-markdown-40-top.plain.txt" "**" "s27/40: no raw ** markers at narrow width"
stop_tui
# s28 — mouse wheel scrolling (0.1.8 §4i): Termux swipe / desktop
# wheel arrives as SGR events (button 64 up / 65 down) once the TUI
# enables mouse reporting. Wheel = 1 line per tick (Freebuff
# LinearScrollAccel), applied immediately, no page animation; PgUp
# behaviour is unchanged (s23/s26/s27 still cover it). A tap is
# swallowed, never typed into the draft. Scrolling up during a
# stream must NOT yank the view back to the bottom.
#
# NOTE on the indicator numbers: the "↑ N baris di atas" row shows
# hiddenAbove = startLine of the window, and showing the row costs
# one line of message budget — so while scrolled up,
# hiddenAbove = maxOffset - offset + 1. At the very top
# (offset = maxOffset) it is always exactly 1, whatever the total;
# wheeling DOWN N from the top makes it exactly N+1. The checks
# below anchor on the top for that reason instead of hardcoding a
# maxOffset that depends on the mock text.
export MOCK_MARKDOWN_FULL=1
restart_mock
reset_credentials
start_tui 80 24
send "tampilkan panduan"
send Enter
sleep 3
capture s28-wheel-80-bottom
check "$OUTDIR/s28-wheel-80-bottom.plain.txt" "console.log(x);" "s28/80: bottom view shows the code block tail"
check_absent "$OUTDIR/s28-wheel-80-bottom.plain.txt" "Panduan Lengkap" "s28/80: H1 is above the bottom view"
# Wheel to the top (clamped at max offset): the indicator reads
# exactly 1, and the H1 is visible. Then down 12 (indicator 13),
# up 5 (indicator 8) — proving 1 line per wheel event in both
# directions — and all the way back to the bottom.
wheel up 100
capture s28-wheel-80-top
check "$OUTDIR/s28-wheel-80-top.plain.txt" "↑ 1 baris di atas" "s28/80: wheel reaches the top (indicator reads 1)"
check "$OUTDIR/s28-wheel-80-top.plain.txt" "Panduan Lengkap" "s28/80: H1 visible at the top"
wheel down 12
capture s28-wheel-80-down12
check "$OUTDIR/s28-wheel-80-down12.plain.txt" "↑ 13 baris di atas" "s28/80: 12 wheel-downs from the top = indicator 13"
check "$OUTDIR/s28-wheel-80-down12.plain.txt" "Enter a coding task" "s28/80: draft untouched after wheel (placeholder still there)"
check_absent "$OUTDIR/s28-wheel-80-down12.plain.txt" "[<65" "s28/80: no wheel-down fragment typed into the draft"
check_absent "$OUTDIR/s28-wheel-80-down12.plain.txt" "[<64" "s28/80: no wheel-up fragment typed into the draft"
wheel up 5
capture s28-wheel-80-up5
check "$OUTDIR/s28-wheel-80-up5.plain.txt" "↑ 8 baris di atas" "s28/80: 5 wheel-ups back = indicator 8"
wheel down 100
capture s28-wheel-80-back
check "$OUTDIR/s28-wheel-80-back.plain.txt" "console.log(x);" "s28/80: wheel-downs return to the bottom"
check_absent "$OUTDIR/s28-wheel-80-back.plain.txt" "baris di atas" "s28/80: no scroll indicator at the bottom"
# A tap (click press+release) must change nothing and type nothing.
tap
capture s28-wheel-80-tap
check "$OUTDIR/s28-wheel-80-tap.plain.txt" "console.log(x);" "s28/80: tap does not move the view"
check "$OUTDIR/s28-wheel-80-tap.plain.txt" "Enter a coding task" "s28/80: tap does not type into the draft"
check_absent "$OUTDIR/s28-wheel-80-tap.plain.txt" "[<0" "s28/80: no click fragment typed into the draft"
stop_tui
# Streaming while scrolled up: wheel up mid-stream, let the stream
# finish — the view must stay scrolled up, not yanked to the bottom.
start_tui 80 24
send "tampilkan panduan"
send Enter
sleep 1
wheel up 15
sleep 3
capture s28-wheel-80-streaming
check "$OUTDIR/s28-wheel-80-streaming.plain.txt" "baris di atas" "s28/80: still scrolled up after the stream finished (no yank)"
check_absent "$OUTDIR/s28-wheel-80-streaming.plain.txt" "console.log(x);" "s28/80: bottom content still out of view after streaming"
stop_tui
# Narrow terminal: wheel works at 40 cols too (same top anchor).
start_tui 40 15
send "tampilkan panduan"
send Enter
sleep 3
wheel up 100
capture s28-wheel-40-top
check "$OUTDIR/s28-wheel-40-top.plain.txt" "↑ 1 baris di atas" "s28/40: wheel reaches the top on a narrow terminal"
wheel down 8
capture s28-wheel-40-down8
check "$OUTDIR/s28-wheel-40-down8.plain.txt" "↑ 9 baris di atas" "s28/40: 8 wheel-downs from the top = indicator 9"
check_absent "$OUTDIR/s28-wheel-40-down8.plain.txt" "~~" "s28/40: no raw ~~ markers after wheel at narrow width"
stop_tui
unset MOCK_MARKDOWN_FULL

# s29 — status-bar layout + assistant foreground (0.1.9 §4k): the
# status row is Freebuff's status bar (status-bar.tsx) — its own root
# box carries paddingLeft/Right 1, so the indicator lands on the same
# column as the message text; the right cluster (Agent step + timer +
# ■ Esc) is separate flex items with gap 1 in theme.secondary, the
# Esc button in its own padded cell. The assistant reply renders in
# theme.text (message-block.tsx textColor ?? foreground), not the
# terminal default (gray on Reza's Termux).
export MOCK_AGENT=1
restart_mock 5000
reset_credentials
start_tui 80 24
send "halo"
send Enter
sleep 0.5
capture s29-status-80-thinking
check "$OUTDIR/s29-status-80-thinking.plain.txt" "thinking..." "s29/80: thinking... shows while waiting"
check_lead "$OUTDIR/s29-status-80-thinking.plain.txt" "thinking..." 2 "s29/80: indicator at 2 leading spaces, aligned with message text (was 1)"
check_lead "$OUTDIR/s29-status-80-thinking.plain.txt" "MethaTech" 2 "s29/80: header still at 2 leading spaces"
check "$OUTDIR/s29-status-80-thinking.plain.txt" "Agent step 1" "s29/80: agent step shows while waiting"
check "$OUTDIR/s29-status-80-thinking.plain.txt" "■ Esc" "s29/80: Esc stop hint shows while waiting"
check_absent "$OUTDIR/s29-status-80-thinking.plain.txt" "· ■ Esc" "s29/80: no dot-joined Esc (cluster is separate flex items)"
# The status row itself carries no "·" separators anymore (the footer
# line below still does — so check the row, not the file).
if grep -F "thinking..." "$OUTDIR/s29-status-80-thinking.plain.txt" | grep -q "·"; then
  echo "FAIL: s29/80: status row still has · separators"; FAIL=$((FAIL+1))
else
  echo "PASS: s29/80: status row has no · separators"; PASS=$((PASS+1))
fi
# First delta lands at 5s, the first agent stream runs ~0.9s; capture
# mid-stream for the working... phase.
sleep 4.2
capture s29-status-80-working
check "$OUTDIR/s29-status-80-working.plain.txt" "working..." "s29/80: working... shows while streaming"
check_lead "$OUTDIR/s29-status-80-working.plain.txt" "working..." 2 "s29/80: working indicator at 2 leading spaces"
check "$OUTDIR/s29-status-80-working.plain.txt" "Buat daftar tugas dulu." "s29/80: agent reply streams in"
# The reply line carries the foreground color (tmux maps theme.text
# #F5F5F5 to 256-color 255); before the fix the line had NO color
# escape at all (terminal default = gray on Reza's Termux).
if grep -F "Buat daftar tugas dulu." "$OUTDIR/s29-status-80-working.txt" | grep -q "38;5;255"; then
  echo "PASS: s29/80: assistant reply renders in foreground #F5F5F5 (38;5;255)"; PASS=$((PASS+1))
else
  echo "FAIL: s29/80: assistant reply has no foreground color escape"; FAIL=$((FAIL+1))
fi
stop_tui
# Narrow terminal: short "Step N" form, same alignment, no overflow.
start_tui 40 15
send "halo"
send Enter
sleep 0.5
capture s29-status-40-thinking
check_lead "$OUTDIR/s29-status-40-thinking.plain.txt" "thinking..." 2 "s29/40: indicator at 2 leading spaces on narrow terminal"
check "$OUTDIR/s29-status-40-thinking.plain.txt" "Step 1" "s29/40: narrow form uses Step N"
check "$OUTDIR/s29-status-40-thinking.plain.txt" "■ Esc" "s29/40: Esc hint survives on narrow terminal"
check_absent "$OUTDIR/s29-status-40-thinking.plain.txt" "Agent step" "s29/40: no long Agent step form on narrow terminal"
stop_tui
unset MOCK_AGENT

# s30 — timestamp placement (0.1.9 §4p, koreksi Reza atas §4l): NO blank
# line — the [HH:MM] timestamp sits DIRECTLY above the "You:" body
# (Freebuff message-block.tsx:187-194, root column has no gap), and
# the green bar runs alongside the timestamp line too (Freebuff
# message-with-agents.tsx:236-252, vertical line marginTop/bottom 0).
# §4l's one blank line was "kejauhan" (too far); the pre-§4l floating
# timestamp with no bar was "dempet". The bar makes the timestamp the
# header of the bordered block.
export MOCK_AGENT=1
restart_mock 5000
reset_credentials
start_tui 80 24
send "halo"
send Enter
sleep 0.5
capture s30-ts-80-thinking
ts_row=$(grep -n -m1 -E "^ +\[[0-9]{2}:[0-9]{2}\]" "$OUTDIR/s30-ts-80-thinking.plain.txt" | cut -d: -f1)
you_row=$(row_of "$OUTDIR/s30-ts-80-thinking.plain.txt" "You: halo")
if [ -n "$ts_row" ] && [ -n "$you_row" ] && [ "$you_row" = "$((ts_row + 1))" ]; then
  echo "PASS: s30/80: You: is 1 row below timestamp (no blank line, Freebuff placement)"; PASS=$((PASS+1))
else
  echo "FAIL: s30/80: You: on row '${you_row:-none}', timestamp on row '${ts_row:-none}' (expected +1)"; FAIL=$((FAIL+1))
fi
ts_lead=$(sed -n "${ts_row}p" "$OUTDIR/s30-ts-80-thinking.plain.txt" | sed 's/[^ ].*//' | tr -d '\n' | wc -c)
if [ "$ts_lead" = "4" ]; then
  echo "PASS: s30/80: timestamp row has 4 leading spaces (root padding 1 + gutter 1 + bar 1 + space 1)"; PASS=$((PASS+1))
else
  echo "FAIL: s30/80: timestamp row has '${ts_lead:-none}' leading spaces (expected 4)"; FAIL=$((FAIL+1))
fi
stop_tui
# Narrow terminal: same placement, no overflow.
start_tui 40 15
send "halo"
send Enter
sleep 0.5
capture s30-ts-40-thinking
ts_row=$(grep -n -m1 -E "^ +\[[0-9]{2}:[0-9]{2}\]" "$OUTDIR/s30-ts-40-thinking.plain.txt" | cut -d: -f1)
you_row=$(row_of "$OUTDIR/s30-ts-40-thinking.plain.txt" "You: halo")
if [ -n "$ts_row" ] && [ -n "$you_row" ] && [ "$you_row" = "$((ts_row + 1))" ]; then
  echo "PASS: s30/40: You: is 1 row below timestamp on narrow terminal"; PASS=$((PASS+1))
else
  echo "FAIL: s30/40: You: on row '${you_row:-none}', timestamp on row '${ts_row:-none}' (expected +1)"; FAIL=$((FAIL+1))
fi
stop_tui
unset MOCK_AGENT

# s31 — tool-result wall (0.1.9 §4m): read_files on a 60-line file must
# show only `Read big.txt` (Freebuff read-files.tsx: paths only, never
# contents). Before the fix the block also showed a 120-char snippet of
# the file contents; after the fix no content line reaches the screen,
# while the model still gets the full file (unit test, agent.test.mjs).
export MOCK_AGENT=1 MOCK_AGENT_BIG=1
restart_mock 5000
reset_credentials
# Big file in the TUI's cwd (repo root): 60 lines, marker on line 42.
# Created here, removed at the end of this scenario — never committed.
for i in $(seq 1 60); do
  if [ "$i" = 42 ]; then echo "MARKER_LINE_42_RAHASIA_DAPUR";
  else printf 'BARIS BESAR %02d isi baris besar untuk tes tampilan tool\n' "$i"; fi;
done > big.txt
start_tui 80 24
send "baca big.txt"
send Enter
sleep 13
capture s31-toolwall-80
check "$OUTDIR/s31-toolwall-80.plain.txt" "Read big.txt" "s31/80: read preview shows the path"
check_absent "$OUTDIR/s31-toolwall-80.plain.txt" "BARIS BESAR 01" "s31/80: no content snippet of the big file (was 120 chars)"
check_absent "$OUTDIR/s31-toolwall-80.plain.txt" "MARKER_LINE_42_RAHASIA_DAPUR" "s31/80: marker line 42 never reaches the screen"
check "$OUTDIR/s31-toolwall-80.plain.txt" "Selesai" "s31/80: agent run completes"
stop_tui
# Narrow terminal: same, no overflow. 40x20 (not 40x15): the test is
# about narrow WIDTH (wrapping), and the turn is taller since the
# TUI interaction fix (one blank line between blocks, Freebuff
# message-block.tsx gap 1) — at 15 rows the "Read big.txt" preview
# scrolls off the top of the 7-row message area.
# 0.1.9 §4o harness fix: the mock's agentReq is stateful per process —
# the 80-col run above already consumed texts[0] (read) and texts[1]
# (complete), so without a restart the 40-col run would get texts[1]
# for its FIRST request (no read_files call, no "Read big.txt" preview
# at all) and the check could never pass. Restart resets agentReq.
restart_mock 5000
start_tui 40 20
send "baca big.txt"
send Enter
sleep 13
capture s31-toolwall-40
check "$OUTDIR/s31-toolwall-40.plain.txt" "Read big.txt" "s31/40: read preview shows the path on narrow terminal"
check_absent "$OUTDIR/s31-toolwall-40.plain.txt" "BARIS BESAR 01" "s31/40: no content snippet on narrow terminal"
check_absent "$OUTDIR/s31-toolwall-40.plain.txt" "MARKER_LINE_42_RAHASIA_DAPUR" "s31/40: marker line 42 never reaches the screen on narrow terminal"
stop_tui
rm -f big.txt
unset MOCK_AGENT MOCK_AGENT_BIG

# s32 — large-paste attachment (0.1.9 §4n): a >2000-char bracketed
# paste becomes a compact card (title + type + line count), NOT
# thousands of chars in the composer; the FULL content reaches the
# agent as a [Pasted Text] block (verified via the mock capture
# file, including a middle sentinel + a Unicode line). Short pastes
# still go straight into the draft.
export MOCK_ATTACHMENT=1 MOCK_CAPTURE_FILE="$OUTDIR/attachment-capture.jsonl"
restart_mock
rm -f "$OUTDIR/attachment-capture.jsonl"
printf 'halo pendek' > "$OUTDIR/paste-short.txt"
python3 - "$OUTDIR/paste-doc.md" <<'PYEOF'
import sys
lines = ["# LAPORAN LAMPIRAN", "", "Dokumen ini ditempel untuk menguji kartu lampiran.", ""]
lines.append("SENTINEL_TENGAH_LAMPIRAN_12345 ada di tengah dokumen.")
lines.append("Baris unicode: emoji \U0001f468\u200d\U0001f469\u200d\U0001f467 caf\u00e9 \u2014 \u201ckutip\u201d dan aksara \u65e5\u672c\u8a9e\u3002")
for i in range(1, 61):
    lines.append(f"BARIS LAMPIRAN {i:02d} isi baris lampiran untuk menguji paste panjang")
open(sys.argv[1], "w", encoding="utf-8").write("\n".join(lines) + "\n")
PYEOF
start_tui 80 24
# A. Short bracketed paste goes straight into the draft, no card.
paste_bracketed "$OUTDIR/paste-short.txt"
capture s32-short-paste
check "$OUTDIR/s32-short-paste.plain.txt" "halo pendek" "s32: short paste lands in the draft"
check_absent "$OUTDIR/s32-short-paste.plain.txt" "lampiran: Ctrl+E" "s32: short paste creates no attachment card"
tmux send-keys -t "$SESSION" C-c; sleep 0.7
# B. Long bracketed paste becomes a card; the content stays out of the composer.
paste_bracketed "$OUTDIR/paste-doc.md"
capture s32-card-80
check "$OUTDIR/s32-card-80.plain.txt" "LAPORAN LAMPIRAN" "s32/80: card shows the doc title"
check "$OUTDIR/s32-card-80.plain.txt" "Markdown · 66 baris" "s32/80: card shows type + line count"
check_absent "$OUTDIR/s32-card-80.plain.txt" "BARIS LAMPIRAN 03" "s32/80: pasted content does NOT flood the composer"
check "$OUTDIR/s32-card-80.plain.txt" "lampiran: Ctrl+E edit" "s32/80: footer shows edit/remove hints"
# B2. Ctrl+X removes the card (nothing orphaned stays pending).
tmux send-keys -t "$SESSION" C-x; sleep 0.7
capture s32-removed
check_absent "$OUTDIR/s32-removed.plain.txt" "Markdown · 66 baris" "s32/80: Ctrl+X removes the card"
check_absent "$OUTDIR/s32-removed.plain.txt" "lampiran: Ctrl+E" "s32/80: hint disappears with the last card"
# C. Ctrl+E expands the card back into the draft; sending it sends
# the edited text inline (no [Pasted Text] marker — it is draft
# text now), with the full content intact.
paste_bracketed "$OUTDIR/paste-doc.md"
tmux send-keys -t "$SESSION" C-e; sleep 0.7
send Enter
sleep 2
capture s32-edit-send
check "$OUTDIR/s32-edit-send.plain.txt" "Tidak ada lampiran yang diterima." "s32/80: edited text sends as plain draft (no attachment)"
if tail -1 "$OUTDIR/attachment-capture.jsonl" | grep -q "SENTINEL_TENGAH_LAMPIRAN_12345"; then
  echo "PASS: s32/80: edited send still carries the full content"; PASS=$((PASS+1))
else
  echo "FAIL: s32/80: edited send lost the pasted content"; FAIL=$((FAIL+1))
fi
if tail -1 "$OUTDIR/attachment-capture.jsonl" | grep -q "Pasted Text"; then
  echo "FAIL: s32/80: edited send wrongly carries a [Pasted Text] block"; FAIL=$((FAIL+1))
else
  echo "PASS: s32/80: edited send has no [Pasted Text] block"; PASS=$((PASS+1))
fi
# D. Attachments-only send (empty draft + card): the agent receives
# the whole attachment; the screen never shows the content.
paste_bracketed "$OUTDIR/paste-doc.md"
send Enter
sleep 2
capture s32-attach-send
check "$OUTDIR/s32-attach-send.plain.txt" "Lampiran diterima:" "s32/80: agent confirms the attachment arrived"
check "$OUTDIR/s32-attach-send.plain.txt" "66 baris" "s32/80: receipt states the line count"
check "$OUTDIR/s32-attach-send.plain.txt" "📎 LAPORAN LAMPIRAN · Markdown · 66 baris" "s32/80: history shows the sent card line"
check_absent "$OUTDIR/s32-attach-send.plain.txt" "BARIS LAMPIRAN 03" "s32/80: pasted content never renders on screen"
if grep -q "SENTINEL_TENGAH_LAMPIRAN_12345" "$OUTDIR/attachment-capture.jsonl"; then
  echo "PASS: s32/80: capture holds the middle sentinel (full content arrived)"; PASS=$((PASS+1))
else
  echo "FAIL: s32/80: middle sentinel missing from capture"; FAIL=$((FAIL+1))
fi
if grep -q $'caf\xc3\xa9 \xe2\x80\x94 \xe2\x80\x9ckutip\xe2\x80\x9d' "$OUTDIR/attachment-capture.jsonl"; then
  echo "PASS: s32/80: Unicode line survived byte-identically"; PASS=$((PASS+1))
else
  echo "FAIL: s32/80: Unicode line mangled in capture"; FAIL=$((FAIL+1))
fi
if grep -q "Pasted Text" "$OUTDIR/attachment-capture.jsonl"; then
  echo "PASS: s32/80: [Pasted Text] block present in the sent prompt"; PASS=$((PASS+1))
else
  echo "FAIL: s32/80: [Pasted Text] block missing from the sent prompt"; FAIL=$((FAIL+1))
fi
stop_tui
# Narrow terminal: the card still fits, no overflow.
start_tui 40 15
paste_bracketed "$OUTDIR/paste-doc.md"
capture s32-card-40
check "$OUTDIR/s32-card-40.plain.txt" "LAPORAN LAMPIRAN" "s32/40: card title fits on narrow terminal"
check "$OUTDIR/s32-card-40.plain.txt" "Markdown · 66 baris" "s32/40: card meta fits on narrow terminal"
stop_tui
unset MOCK_ATTACHMENT MOCK_CAPTURE_FILE

# s33 — full viewport + composer height (0.1.9 §4o): conversation
# top-anchored (Freebuff chat.tsx flex-start), composer 5 rows at rest
# with the input vertically centered (chat-input-bar.tsx +
# chat.tsx:2122-2123), box grows with multiline drafts, frame fills
# the terminal at 80x24, 40x15 and 120x40.
reset_credentials
start_tui 80 24
capture s33-welcome-80
check_last_row "$OUTDIR/s33-welcome-80.plain.txt" "╭" 18 "s33/80: input top border on row 18 (5-row composer at rest)"
check_last_row "$OUTDIR/s33-welcome-80.plain.txt" "╰" 22 "s33/80: input bottom border on row 22"
check_row "$OUTDIR/s33-welcome-80.plain.txt" "Enter a coding task" 20 "s33/80: placeholder on the centered middle row 20"
banner33=$(row_of "$OUTDIR/s33-welcome-80.plain.txt" "M   M")
if [ "$banner33" = "2" ]; then
  echo "PASS: s33/80: welcome banner top-anchored (row 2, no void above)"; PASS=$((PASS+1))
else
  echo "FAIL: s33/80: welcome banner not top-anchored (row '${banner33:-none}', expected 2)"; FAIL=$((FAIL+1))
fi
send "halo"
send Enter
sleep 1
capture s33-chat-80
ts33=$(grep -n -m1 -E "^ +\\[[0-9]{2}:[0-9]{2}\\]" "$OUTDIR/s33-chat-80.plain.txt" | cut -d: -f1)
if [ "$ts33" = "2" ]; then
  echo "PASS: s33/80: first message starts on row 2 (top-anchored, no void above)"; PASS=$((PASS+1))
else
  echo "FAIL: s33/80: first message on row '${ts33:-none}' (expected 2)"; FAIL=$((FAIL+1))
fi
you33=$(row_of "$OUTDIR/s33-chat-80.plain.txt" "You: halo")
if [ "$you33" = "3" ]; then
  echo "PASS: s33/80: You: on row 3 (timestamp directly above, §4p — no blank gap row)"; PASS=$((PASS+1))
else
  echo "FAIL: s33/80: You: on row '${you33:-none}' (expected 3)"; FAIL=$((FAIL+1))
fi
check_last_row "$OUTDIR/s33-chat-80.plain.txt" "╰" 22 "s33/80: input bottom border stays on row 22 after a message"
check_last_row "$OUTDIR/s33-chat-80.plain.txt" "╭" 18 "s33/80: composer stays 5 rows after a message"
# Multiline draft: 300 chars wrap to 5 content rows, the box grows
# 5 -> 7 rows (top border moves up 18 -> 16, bottom stays 22).
send "$(python3 -c "print('a'*100)")"
send "$(python3 -c "print('a'*100)")"
send "$(python3 -c "print('a'*100)")"
sleep 0.5
capture s33-multiline-80
check_last_row "$OUTDIR/s33-multiline-80.plain.txt" "╭" 16 "s33/80: input top border moves to row 16 with a 5-row draft (7-row box)"
check_last_row "$OUTDIR/s33-multiline-80.plain.txt" "╰" 22 "s33/80: input bottom border stays on row 22 with a long draft"
check_row "$OUTDIR/s33-multiline-80.plain.txt" "Ctrl+C 2x keluar" 24 "s33/80: footer stays on the last row with a long draft"
# Ctrl+C clears the draft (priority 3) and the composer returns to 5 rows.
send C-c
sleep 0.5
capture s33-cleared-80
check_last_row "$OUTDIR/s33-cleared-80.plain.txt" "╭" 18 "s33/80: composer back to 5 rows after Ctrl+C clears the draft"
check_row "$OUTDIR/s33-cleared-80.plain.txt" "Enter a coding task" 20 "s33/80: placeholder back on the centered row 20"
stop_tui
# Narrow terminal: placeholder wraps to 2 rows, so the composer is NOT
# centered — box is 4 rows (2 borders + 2 content rows).
start_tui 40 15
capture s33-welcome-40
check_last_row "$OUTDIR/s33-welcome-40.plain.txt" "╰" 13 "s33/40: input bottom border on row 13"
check_last_row "$OUTDIR/s33-welcome-40.plain.txt" "╭" 10 "s33/40: input top border on row 10 (4-row box, placeholder wraps to 2)"
check_row "$OUTDIR/s33-welcome-40.plain.txt" "Enter a coding task" 11 "s33/40: placeholder first row on row 11"
stop_tui
# Tall desktop terminal: frame fills 120x40, banner top-anchored,
# composer still 5 rows at rest, footer on the last row.
start_tui 120 40
capture s33-welcome-120
check_last_row "$OUTDIR/s33-welcome-120.plain.txt" "╰" 38 "s33/120: input bottom border on row 38"
check_last_row "$OUTDIR/s33-welcome-120.plain.txt" "╭" 34 "s33/120: input top border on row 34 (5-row composer)"
check_row "$OUTDIR/s33-welcome-120.plain.txt" "Enter a coding task" 36 "s33/120: placeholder on the centered row 36"
check_row "$OUTDIR/s33-welcome-120.plain.txt" "Ctrl+C 2x keluar" 40 "s33/120: footer on the last row 40"
banner33b=$(row_of "$OUTDIR/s33-welcome-120.plain.txt" "M   M")
if [ "$banner33b" = "2" ]; then
  echo "PASS: s33/120: welcome banner top-anchored (row 2) at 120x40"; PASS=$((PASS+1))
else
  echo "FAIL: s33/120: welcome banner not top-anchored (row '${banner33b:-none}', expected 2)"; FAIL=$((FAIL+1))
fi
stop_tui

# --- Scenario 34: no scrollbar (0.1.9 §4q, Reza's order) — the track/thumb
# column is gone, the scroll FUNCTION is untouched: PgUp/PgDn, wheel,
# indicator and footer affordance all still work; no message-area row
# may end with │ or █ (check_no_track), and the thumb char █ appears
# nowhere in the capture.
start_tui 80 24
for i in $(seq 1 30); do
  send "pesan $(printf %02d $i)" Enter
done
sleep 1
capture s34-noscroll-80-bottom
check_absent "$OUTDIR/s34-noscroll-80-bottom.plain.txt" "█" "s34/80: no scrollbar thumb at the bottom while history overflows"
check_no_track "$OUTDIR/s34-noscroll-80-bottom.plain.txt" "s34/80: no scrollbar track at the right edge at the bottom"
send PageUp
sleep 0.3
capture s34-noscroll-80-up
check "$OUTDIR/s34-noscroll-80-up.plain.txt" "baris di atas" "s34/80: scroll indicator shown while scrolled up (function kept)"
check "$OUTDIR/s34-noscroll-80-up.plain.txt" "↓ PgDn" "s34/80: scroll-to-bottom affordance in the footer while scrolled up"
check_absent "$OUTDIR/s34-noscroll-80-up.plain.txt" "█" "s34/80: no scrollbar thumb while scrolled up"
check_no_track "$OUTDIR/s34-noscroll-80-up.plain.txt" "s34/80: no scrollbar track at the right edge while scrolled up"
wheel up 10
sleep 0.3
capture s34-noscroll-80-wheel
check "$OUTDIR/s34-noscroll-80-wheel.plain.txt" "baris di atas" "s34/80: wheel still scrolls without a scrollbar"
check_absent "$OUTDIR/s34-noscroll-80-wheel.plain.txt" "█" "s34/80: no scrollbar thumb after wheel"
check_no_track "$OUTDIR/s34-noscroll-80-wheel.plain.txt" "s34/80: no scrollbar track at the right edge after wheel"
stop_tui
start_tui 40 15
for i in $(seq 1 30); do
  send "pesan $(printf %02d $i)" Enter
done
sleep 1
send PageUp
sleep 0.3
capture s34-noscroll-40-up
check "$OUTDIR/s34-noscroll-40-up.plain.txt" "baris di atas" "s34/40: scroll indicator shown while scrolled up on a narrow terminal"
check_absent "$OUTDIR/s34-noscroll-40-up.plain.txt" "█" "s34/40: no scrollbar thumb on a narrow terminal"
check_no_track "$OUTDIR/s34-noscroll-40-up.plain.txt" "s34/40: no scrollbar track at the right edge on a narrow terminal"
stop_tui

# --- Scenario 35: turn block order (TUI interaction fix, Freebuff
# ContentBlock model) — one assistant message per turn, blocks in
# arrival order (text, tool, text, tool...). Before the fix ALL turn
# text rendered ABOVE all tool calls; after the fix the order is the
# true arrival order, each tool result sits under its own tool block,
# the TODOs list sits at its chronological position (upsert replaces
# in place, one list only), nothing duplicates, the input stays in
# the input area while streaming, and a redraw after completion is
# byte-identical. Uses the default MOCK_AGENT 6-step script.
# NOTE on the last step: the loop emits the step's text event BEFORE
# it parses the tool call at step end, so the final "# Selesai" text
# correctly renders ABOVE the "Task completed" tool block — the TUI
# renders the loop's arrival order, it does not reorder it.
export MOCK_AGENT=1
restart_mock
reset_credentials
# Agent cwd is the repo root (like s31's big.txt): the script reads
# and edits hello.txt, then runs the shell command there. Created
# here, removed at the end of this scenario — never committed.
printf 'isi hello untuk agen\n' > hello.txt
# 56 rows: the completed 6-step turn is 52 rows tall (header + user
# + 11 blocks with Freebuff gap-1 + status/input/footer), so 50 rows
# would scroll the user message off the top once the final
# task_completed block lands — the turn must fit whole for the
# no-position-shift checks below to mean anything.
start_tui 80 56
send "baca hello.txt dan jalankan echo"
send Enter
sleep 3
capture s35-mid-80
check_row "$OUTDIR/s35-mid-80.plain.txt" "You: baca hello.txt" 3 "s35/80: user message stays on row 3 mid-stream (streaming does not move messages)"
check "$OUTDIR/s35-mid-80.plain.txt" "■ Esc" "s35/80: status row with Esc visible while streaming"
check_last_row "$OUTDIR/s35-mid-80.plain.txt" "╰" 54 "s35/80: input bottom border stays on row 54 mid-stream (input stays in the input area)"
sleep 10
capture s35-done-80
check_row "$OUTDIR/s35-done-80.plain.txt" "You: baca hello.txt" 3 "s35/80: user message still on row 3 after the turn (no position shift)"
check_last_row "$OUTDIR/s35-done-80.plain.txt" "╰" 54 "s35/80: input bottom border stays on row 54 after the turn"
check_absent "$OUTDIR/s35-done-80.plain.txt" "working..." "s35/80: status row gone after the turn (status never enters the transcript)"
check_order() { # check_order <file> <earlier> <later> <label>
  local a b
  a=$(row_of "$1" "$2"); b=$(row_of "$1" "$3")
  if [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]; then
    echo "PASS: $4"; PASS=$((PASS+1))
  else
    echo "FAIL: $4 (rows '${a:-none}' vs '${b:-none}', expected '$2' above '$3')"; FAIL=$((FAIL+1))
  fi
}
check_count() { # check_count <file> <needle> <expected> <label>
  local n
  n=$(grep -c -F -- "$2" "$1")
  if [ "$n" = "$3" ]; then echo "PASS: $4"; PASS=$((PASS+1)); else echo "FAIL: $4 (count $n, expected $3)"; FAIL=$((FAIL+1)); fi
}
check_order "$OUTDIR/s35-done-80.plain.txt" "Buat daftar tugas dulu." "TODOs" "s35/80: first text above the TODOs list (arrival order)"
check_order "$OUTDIR/s35-done-80.plain.txt" "TODOs" "Membaca file dulu." "s35/80: TODOs list above the next text (not floating above newer content)"
check_order "$OUTDIR/s35-done-80.plain.txt" "Membaca file dulu." "Read hello.txt" "s35/80: text above its tool call"
check_order "$OUTDIR/s35-done-80.plain.txt" "Read hello.txt" "Edit file." "s35/80: tool call above the text written after it (was: all text on top)"
check_order "$OUTDIR/s35-done-80.plain.txt" "Edit file." "edited hello.txt (1 replacement)" "s35/80: str_replace result under its own preview"
check_order "$OUTDIR/s35-done-80.plain.txt" "edited hello.txt (1 replacement)" "Tandai yang sudah selesai." "s35/80: next text below the edit result"
check_order "$OUTDIR/s35-done-80.plain.txt" "Sekarang jalankan perintah." "touch agent-ran.txt" "s35/80: text above the shell call"
check_order "$OUTDIR/s35-done-80.plain.txt" "touch agent-ran.txt" "hello-agent" "s35/80: shell result under its own preview"
check_order "$OUTDIR/s35-done-80.plain.txt" "hello-agent" "Selesai" "s35/80: final text below the shell result"
check_order "$OUTDIR/s35-done-80.plain.txt" "Selesai" "Task completed" "s35/80: task_completed block after the final text (loop emits text before parsing the call)"
check_count "$OUTDIR/s35-done-80.plain.txt" "Buat daftar tugas dulu." 1 "s35/80: first text appears exactly once (no redraw duplication)"
check_count "$OUTDIR/s35-done-80.plain.txt" "Read hello.txt" 1 "s35/80: tool preview appears exactly once"
check_count "$OUTDIR/s35-done-80.plain.txt" "TODOs" 1 "s35/80: one TODOs list only (upsert replaces in place)"
check_count "$OUTDIR/s35-done-80.plain.txt" "Update to-dos" 2 "s35/80: two write_todos tool blocks (one per call)"
# Redraw stability: two captures 1s apart after completion must be
# byte-identical (no timer, no spinner left running).
sleep 1
capture s35-done-80b
if diff -q "$OUTDIR/s35-done-80.plain.txt" "$OUTDIR/s35-done-80b.plain.txt" > /dev/null; then
  echo "PASS: s35/80: redraw after completion is byte-identical (no shifting or duplication)"; PASS=$((PASS+1))
else
  echo "FAIL: s35/80: redraw after completion differs"; FAIL=$((FAIL+1))
fi
# Long-conversation scroll: the 56-row leg fits the whole turn, so
# PgUp there is a no-op (nothing above to scroll to, no indicator —
# correct behavior). Scroll is verified on a second leg at 80x24,
# where the 44-line turn overflows the 16-row message area: PgUp
# must show the indicator, and the visible slice must still be in
# arrival order.
stop_tui
restart_mock
reset_credentials
printf 'isi hello untuk agen\n' > hello.txt
start_tui 80 24
send "baca hello.txt dan jalankan echo"
send Enter
sleep 13
send PageUp
sleep 0.3
capture s35-up-80
check "$OUTDIR/s35-up-80.plain.txt" "baris di atas" "s35/80: scroll indicator shown while scrolled up"
check_order "$OUTDIR/s35-up-80.plain.txt" "Tandai yang sudah selesai." "Sekarang jalankan perintah." "s35/80: order kept while scrolled up"
stop_tui
rm -f hello.txt agent-ran.txt
unset MOCK_AGENT

echo ""
echo "PTY results: PASS=$PASS FAIL=$FAIL (captures in $OUTDIR)"
exit "$([ "$FAIL" -eq 0 ] && echo 0 || echo 1)"
