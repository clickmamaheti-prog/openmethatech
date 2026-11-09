#!/usr/bin/env python3
"""Raw-PTY probe: verify the TUI's first frame is truly full-screen.

Why a raw PTY instead of `tmux capture-pane -e`: tmux drops the
background attribute of trailing-space cells in its grid (a line of
spaces written with bg black followed by a bg reset comes back with
default bg in capture-pane, even with -N). The bytes Ink actually
emits are the ground truth for a real terminal (Termux included):
every frame line must carry a black background escape
(48;5;16 or 48;2;0;0;0), so no terminal background shows through.

Usage: python3 test/tui-bg-probe.py <cols> <rows>
Env: METATECH_CONFIG_DIR, METATECH_API_KEY, METATECH_API_BASE,
METATECH_CONSOLE_BASE (same as test/tui-pty.sh). Expects the mock
server already running. Exit 0 when all checks pass.
"""
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

COLS = int(sys.argv[1])
ROWS = int(sys.argv[2])

PASS = 0
FAIL = 0


def check(ok: bool, label: str, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        print(f"PASS: {label}")
        PASS += 1
    else:
        print(f"FAIL: {label} {detail}")
        FAIL += 1


pid, fd = pty.fork()
if pid == 0:
    # Child: set the pty size BEFORE exec, so Ink reads the right rows.
    # TERM must advertise 256 colors (the harness runs with TERM=dumb);
    # otherwise chalk disables all color and the bg check is meaningless.
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    os.environ["TERM"] = "xterm-256color"
    os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    os.execvp("node", ["node", "dist/cli.js"])

data = b""
deadline = time.time() + 5
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        data += chunk
        if b"Ctrl+C keluar" in data and data.count(b"\r\n") >= ROWS - 1:
            break

try:
    os.write(fd, b"\x03")
except OSError:
    pass
time.sleep(0.5)
try:
    os.kill(pid, signal.SIGKILL)
except ProcessLookupError:
    pass
try:
    os.waitpid(pid, 0)
except ChildProcessError:
    pass

# The frame after the last clear-screen: Ink's first full render.
idx = data.rfind(b"\x1b[2J")
frame = data[idx:] if idx >= 0 else data
lines = frame.split(b"\r\n")[:ROWS]

check(len(lines) == ROWS, f"bg-probe {COLS}x{ROWS}: frame has {ROWS} lines", f"(got {len(lines)})")


def plain(line: bytes) -> str:
    return re.sub(rb"\x1b\[[0-9;?]*[A-Za-z]", b"", line).decode("utf-8", "replace")


if len(lines) == ROWS:
    check("MethaTech" in plain(lines[0]), f"bg-probe {COLS}x{ROWS}: header on row 1")
    # Input box (Freebuff chat-input-bar): the bottom border sits on
    # row ROWS-2, the input text/placeholder one row above it
    # (row ROWS-3). The footer is two rows (model line + hint line).
    check("\u2570" in plain(lines[ROWS - 3]), f"bg-probe {COLS}x{ROWS}: input box bottom border on row {ROWS - 2}")
    check("Enter a coding task" in "".join(plain(l) for l in lines), f"bg-probe {COLS}x{ROWS}: placeholder inside the input box")
    check("Ctrl+C 2x keluar" in plain(lines[ROWS - 1]), f"bg-probe {COLS}x{ROWS}: footer on row {ROWS}")
    bad = [
        i + 1
        for i, line in enumerate(lines)
        if b"48;5;16" not in line and b"48;2;0;0;0" not in line
    ]
    check(not bad, f"bg-probe {COLS}x{ROWS}: every row carries black bg", f"(rows without black bg: {bad})")
    # No shell prompt left above the header.
    check("$ methatech" not in plain(lines[0]), f"bg-probe {COLS}x{ROWS}: no shell prompt above header")

print(f"bg-probe results: PASS={PASS} FAIL={FAIL}")
sys.exit(0 if FAIL == 0 else 1)
