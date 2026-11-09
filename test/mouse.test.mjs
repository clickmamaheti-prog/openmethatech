// Unit tests for SGR mouse input (src/ui/mouse.ts) — the wheel path
// that lets a Termux finger swipe scroll the history.
// Run after build: npm run build && npm test
import test from "node:test";
import assert from "node:assert/strict";
import {
  MOUSE_ENABLE,
  MOUSE_DISABLE,
  WHEEL_LINES,
  parseMouseInput,
} from "../dist/ui/mouse.js";

test("enable/disable sequences match OpenTUI's DECSET set", () => {
  // terminal.zig setMouseMode (movement=false): 1003l first, then
  // 1000h + 1002h + 1006h. writeMouseDisableSequences: 1003l, 1002l,
  // 1000l, 1006l. Any-event tracking (1003h) is never enabled:
  // mouse motion must not flood the input stream.
  assert.equal(MOUSE_ENABLE, "\x1b[?1003l\x1b[?1000h\x1b[?1002h\x1b[?1006h");
  assert.equal(MOUSE_DISABLE, "\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1006l");
  assert.equal(WHEEL_LINES, 1); // Freebuff LinearScrollAccel = 1
});

test("wheel up (64) and wheel down (65) parse, with or without ESC", () => {
  // Ink strips one leading ESC, so the handler usually sees "[<…".
  assert.deepEqual(parseMouseInput("[<64;10;5M", false), {
    wheels: ["up"], rest: "", fragmentPending: false,
  });
  assert.deepEqual(parseMouseInput("[<65;10;5M", false), {
    wheels: ["down"], rest: "", fragmentPending: false,
  });
  // Defensive: the raw sequence (ESC intact) parses identically.
  assert.deepEqual(parseMouseInput("\x1b[<64;10;5M", false), {
    wheels: ["up"], rest: "", fragmentPending: false,
  });
  assert.deepEqual(parseMouseInput("\x1b[<65;20;6M", false), {
    wheels: ["down"], rest: "", fragmentPending: false,
  });
});

test("a fling burst parses in order", () => {
  // One tmux/tmux write can carry several wheel events at once.
  assert.deepEqual(
    parseMouseInput("[<64;10;5M[<64;10;5M[<65;10;5M", false),
    { wheels: ["up", "up", "down"], rest: "", fragmentPending: false },
  );
});

test("clicks, drags, motion and releases are consumed, never typed", () => {
  // Tap (Termux sends press+release with mouse tracking on).
  assert.deepEqual(parseMouseInput("[<0;10;5M", false), {
    wheels: [], rest: "", fragmentPending: false,
  });
  assert.deepEqual(parseMouseInput("[<0;10;5m", false), {
    wheels: [], rest: "", fragmentPending: false,
  });
  // Drag (button 32) and motion (button 35, from 1002h tracking).
  assert.deepEqual(parseMouseInput("[<32;10;5M", false), {
    wheels: [], rest: "", fragmentPending: false,
  });
  assert.deepEqual(parseMouseInput("[<35;10;5M", false), {
    wheels: [], rest: "", fragmentPending: false,
  });
  // Wheel RELEASE (m) is not a scroll: Termux sends wheel with M only.
  assert.deepEqual(parseMouseInput("[<64;10;5m", false), {
    wheels: [], rest: "", fragmentPending: false,
  });
  // Horizontal wheel (66/67): consumed, no horizontal scroll exists.
  assert.deepEqual(parseMouseInput("[<66;10;5M[<67;10;5M", false), {
    wheels: [], rest: "", fragmentPending: false,
  });
});

test("non-mouse text passes through untouched", () => {
  assert.deepEqual(parseMouseInput("a", false), {
    wheels: [], rest: "a", fragmentPending: false,
  });
  assert.deepEqual(parseMouseInput("halo", false), {
    wheels: [], rest: "halo", fragmentPending: false,
  });
  assert.deepEqual(parseMouseInput("\x1b[A", false), {
    wheels: [], rest: "\x1b[A", fragmentPending: false,
  });
  assert.deepEqual(parseMouseInput("", false), {
    wheels: [], rest: "", fragmentPending: false,
  });
});

test("wheel + typed text in one delivery splits correctly", () => {
  // Ink's input-parser already splits CSI from text, but a delivery
  // carrying both must still yield the text for the keyboard path.
  assert.deepEqual(parseMouseInput("[<65;20;6Mx", false), {
    wheels: ["down"], rest: "x", fragmentPending: false,
  });
  assert.deepEqual(parseMouseInput("x[<64;10;5M", false), {
    wheels: ["up"], rest: "x", fragmentPending: false,
  });
});

test("a sequence split across two reads is swallowed, never typed", () => {
  // Ink flushes a partial CSI after one event-loop turn, so a slow
  // writer delivers "[<64;1" then "0;5M" as two inputs. Both halves
  // must be consumed, never land in the input draft.
  const first = parseMouseInput("[<64;1", false);
  assert.deepEqual(first, { wheels: [], rest: "", fragmentPending: true });
  assert.deepEqual(parseMouseInput("0;5M", first.fragmentPending), {
    wheels: [], rest: "", fragmentPending: false,
  });
  // A non-continuation clears the pending flag and is processed.
  const pending = parseMouseInput("[<64;1", false);
  assert.equal(pending.fragmentPending, true);
  assert.deepEqual(parseMouseInput("halo", pending.fragmentPending), {
    wheels: [], rest: "halo", fragmentPending: false,
  });
});

test("modifier wheel buttons still scroll (Ctrl/Shift add 4/8/16)", () => {
  // SGR button = 64 + modifiers: 68 = wheel-up + Ctrl, 72 = +Shift.
  assert.deepEqual(parseMouseInput("[<68;10;5M", false), {
    wheels: ["up"], rest: "", fragmentPending: false,
  });
  assert.deepEqual(parseMouseInput("[<73;10;5M", false), {
    wheels: ["down"], rest: "", fragmentPending: false,
  });
});
