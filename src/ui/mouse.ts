// Mouse wheel input for the MethaTech TUI — SGR mouse reporting,
// adopted from Freebuff's renderer (OpenTUI 0.3.4).
//
// WHY THIS EXISTS
// ---------------
// Freebuff scrolls with the mouse wheel for free: its renderer
// (OpenTUI) enables mouse tracking and its ScrollBox consumes wheel
// events (packages/core/src/renderables/ScrollBox.ts `onMouseEvent`,
// `LinearScrollAccel` = 1 line per wheel tick). Ink has NO mouse
// input at all — the "mouse wheel" gap was a documented forced
// difference since 0.1.6. This module closes it without leaving Ink:
//
// 1. The app enables mouse reporting with the SAME DECSET set OpenTUI
//    writes (packages/core/src/zig/terminal.zig `setMouseMode`,
//    movement=false): disable-any-event first (some terminals treat
//    1000/1002/1003 as one family and let the last sequence win),
//    then 1000h (press/release) + 1002h (button-event/drag) + 1006h
//    (SGR encoding). Disable mirrors OpenTUI's
//    `writeMouseDisableSequences`: 1003l, 1002l, 1000l, 1006l.
// 2. The terminal then reports wheel notches as SGR sequences
//    `ESC [ < Cb ; Cx ; Cy M` (press) — wheel up is button 64,
//    wheel down is 65 (OpenTUI lib/parse.mouse.ts `decodeSgrEvent`:
//    scroll = button & 64, direction = button & 3: 0 up, 1 down).
// 3. Ink DOES deliver those sequences intact to useInput: its
//    input-parser splits CSI sequences at their final byte and its
//    keypress parser leaves unknown sequences whole, so the handler
//    receives e.g. "[<64;10;5M" (one leading ESC stripped by Ink).
//    Verified empirically 2026-11-09 with a minimal Ink probe in
//    tmux (wheel up/down, tap click press/release, plain keys).
// 4. Termux translates a finger swipe into exactly these events:
//    TerminalView.doScroll sends one MOUSE_WHEELUP (64) /
//    WHEELDOWN (65) event per row dragged while mouse tracking is
//    active, and TerminalEmulator.sendMouseEvent encodes them SGR
//    when 1006h is set. With mouse tracking OFF the same swipe
//    instead sends DPAD_UP/DOWN arrow keys in the alternate screen
//    (which is why swipe today changes the model / recalls history
//    instead of scrolling). A tap with mouse tracking on arrives as
//    a left-click press+release — swallowed here, never typed.
// 5. A fling keeps sending wheel events with inertia (Termux
//    Scroller → doScroll), so fast swipes scroll fast.
//
// WHAT IS *NOT* SUPPORTED
// ------------------------
// - X10 mouse encoding (`ESC [ M` + 3 bytes): Ink's input-parser
//   ends the CSI at the `M` final byte and delivers the 3 payload
//   bytes as separate plain-text input, so X10 sequences cannot be
//   recognised reliably. Every modern terminal sends SGR once 1006h
//   is on, so this only affects pre-SGR terminals.
// - Horizontal wheel (buttons 66/67): consumed silently, no
//   horizontal scrolling exists in the TUI.
// - Mouse motion / drag (button-event tracking reports them):
//   consumed silently. Only wheel notches move anything.
// - A wheel event split across two stdin reads with a gap between
//   them: Ink flushes the partial CSI after one event-loop turn, so
//   the app sees e.g. "[<64;1" then "0;5M". Both fragments are
//   swallowed (see parseMouseInput's fragmentPending) instead of
//   being typed into the draft. In practice terminals write the
//   whole sequence atomically, so this is a rare defensive path.

/** DECSET sequences OpenTUI writes to enable mouse reporting. */
export const MOUSE_ENABLE = "\x1b[?1003l\x1b[?1000h\x1b[?1002h\x1b[?1006h";
/** DECSET sequences OpenTUI writes to disable mouse reporting. */
export const MOUSE_DISABLE = "\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1006l";

/** Lines scrolled per wheel event (Freebuff LinearScrollAccel = 1). */
export const WHEEL_LINES = 1;

export type MouseWheelDirection = "up" | "down";

export interface ParsedMouseInput {
  /** Wheel notches in arrival order ("up" = older content). */
  wheels: MouseWheelDirection[];
  /** The input with every mouse sequence removed (may be ""). */
  rest: string;
  /**
   * True when the input ended mid-SGR-sequence: the next input that
   * looks like the continuation (`digits/semicolons + M/m`) is the
   * second half of the same event and must be swallowed too.
   */
  fragmentPending: boolean;
}

// Complete SGR mouse sequence, with or without the leading ESC (Ink
// strips exactly one). Button;column;row, terminated by M (press) or
// m (release). Only the button code matters here; coordinates are
// the gesture anchor (Termux reports the touch-down cell for every
// wheel event of one swipe) and the TUI scrolls the whole history
// regardless of where the finger is.
const SGR_RE = /\x1b?\[<(\d+);(\d+);(\d+)([Mm])/g;
// An SGR sequence cut off before its terminator (Ink flushed a
// partial CSI after one event-loop turn).
const SGR_PREFIX_RE = /^\x1b?\[<\d*(;\d*){0,2}$/;
// The second half of a cut-off SGR sequence.
const SGR_CONTINUATION_RE = /^[\d;]+[Mm]$/;

/**
 * Pull mouse events out of one useInput delivery. Wheel notches are
 * returned in order; every other mouse sequence (click, drag, motion,
 * horizontal wheel, release) is consumed silently; anything that is
 * not a mouse sequence is returned untouched in `rest` for the
 * normal keyboard path.
 */
export function parseMouseInput(
  input: string,
  fragmentPending: boolean,
): ParsedMouseInput {
  const wheels: MouseWheelDirection[] = [];

  // Second half of a sequence Ink delivered in two pieces.
  if (fragmentPending && SGR_CONTINUATION_RE.test(input)) {
    return { wheels, rest: "", fragmentPending: false };
  }
  if (fragmentPending && !SGR_PREFIX_RE.test(input)) {
    // Not a continuation: the fragment was something else; stop
    // waiting for it and process this input normally.
    fragmentPending = false;
  }

  let rest = input;
  let pending = false;
  let matched = false;
  SGR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SGR_RE.exec(input)) !== null) {
    matched = true;
    const button = Number(match[1]);
    const terminator = match[4];
    const isScroll = (button & 64) !== 0;
    if (isScroll && terminator === "M") {
      const dir = button & 3;
      if (dir === 0) wheels.push("up");
      else if (dir === 1) wheels.push("down");
      // dir 2/3 = horizontal wheel: consumed, no horizontal scroll.
    }
    // Clicks, drags, motion and releases: consumed, no action.
  }
  if (matched) {
    rest = input.replace(SGR_RE, "");
  }

  // A trailing partial SGR sequence (no terminator yet): swallow it
  // and remember to swallow its continuation, so neither half can
  // ever land in the input draft as garbage text.
  if (rest !== "" && SGR_PREFIX_RE.test(rest)) {
    rest = "";
    pending = true;
  }

  return { wheels, rest, fragmentPending: pending };
}
