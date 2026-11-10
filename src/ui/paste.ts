// Bracketed paste assembly for the MethaTech TUI.
//
// WHY THIS EXISTS
// ---------------
// Freebuff gets paste events for free: its renderer (OpenTUI) emits a
// `paste` event with the whole payload (cli/src/components/
// multiline-input.tsx:1052-1078 — a global keyHandler 'paste'
// listener, plus a backup onPaste prop; the payload arrives as bytes
// and is decoded with decodePasteBytes, then ANSI-stripped). Ink
// 6.8.0 has NO paste support at all — no bracketed-paste mode, no
// paste event (grep for `2004` in node_modules/ink/build returns
// nothing). So MethaTech enables bracketed paste itself
// (DECSET 2004, see PASTE_ENABLE below, written next to
// MOUSE_ENABLE in commands.ts) and assembles the payload here.
//
// WHAT INK ACTUALLY DELIVERS (verified empirically 2026-11-09 with
// a minimal Ink probe under a pty AND through tmux `send-keys -H`):
// - `ESC [ 200 ~` arrives as its own useInput call with input
//   `"[200~"` (Ink strips exactly one leading ESC, the same way it
//   delivers mouse SGR sequences as `"[<64;10;5M"` — see mouse.ts).
// - The payload arrives as one or MORE further calls: a chunked
//   paste splits mid-payload, so the payload MUST be accumulated
//   across deliveries until the end marker.
// - `ESC [ 201 ~` arrives as its own call `"[201~"`.
// - A paste followed by Enter arrives as `"[201~"` THEN a separate
//   `"\r"` call with key.return true — the Enter is never glued
//   inside the payload, so submitting after a paste works naturally.
// - A plain multi-char delivery (no markers — a terminal that
//   ignored 2004h) arrives as one call with the whole string,
//   including any embedded `\n`/`\r` (key.return false). That is
//   the fallback path: ChatApp treats a long plain delivery as a
//   paste BEFORE the atomic key splitter, because the splitter
//   would otherwise turn the embedded newlines into submits.
//
// The assembler is a pure state machine: feed() takes one useInput
// delivery and returns the plain (non-paste) text in it, any
// completed pastes, and whether a paste is still open. It never
// touches the draft itself — ChatApp decides what a completed paste
// becomes (short text -> draft, long text -> attachment).

/** DECSET: enable bracketed paste (terminal wraps pastes in ESC[200~ ... ESC[201~). */
export const PASTE_ENABLE = "\x1b[?2004h";
/** DECSET: disable bracketed paste again. */
export const PASTE_DISABLE = "\x1b[?2004l";

// Markers as Ink delivers them (one leading ESC already stripped).
// The `\x1b` variants are accepted too, in case a delivery ever
// keeps the ESC (defensive only — the probe never showed it).
const START = "[200~";
const END = "[201~";
const START_ESC = "\x1b[200~";
const END_ESC = "\x1b[201~";

export interface PasteFeedResult {
  /** Non-paste text in this delivery (typed chars before a start
      marker / after an end marker). Feed it to the mouse parser and
      the keyboard path as usual. */
  plain: string;
  /** Paste payloads completed by this delivery (ANSI-stripped). */
  pastes: string[];
  /** True while a paste is open and its end marker has not arrived
      yet: swallow the whole delivery — a half paste must never
      reach the draft. */
  collecting: boolean;
}

/**
 * Strip ANSI escape sequences from pasted text (Freebuff
 * utils/strings.ts: `Bun.stripANSI(eventText)` — the paste path
 * strips ANSI only, NOT the full terminal-safe sanitizer: the
 * content that reaches the agent must stay byte-identical apart
 * from escapes, so visible Unicode (emoji, ZWJ sequences, CJK)
 * is preserved untouched).
 */
export function stripAnsi(input: string): string {
  return input
    .replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]?/g, "");
}

// Length of the longest suffix of `text` that is a proper prefix of
// `marker` (a marker split across two stdin deliveries — Ink flushes
// a partial CSI after one event-loop turn, the same hazard mouse.ts
// handles with fragmentPending). The suffix is held and prepended
// to the next delivery instead of being typed.
function trailingPartialMarkerLength(text: string, marker: string): number {
  const max = Math.min(text.length, marker.length - 1);
  for (let n = max; n >= 1; n--) {
    if (marker.startsWith(text.slice(text.length - n))) return n;
  }
  return 0;
}

export interface PasteAssembler {
  feed(input: string): PasteFeedResult;
  /** True while a paste is open (end marker not yet seen). */
  readonly collecting: boolean;
  /** Drop any half-assembled paste (safety valve, e.g. on unmount). */
  reset(): void;
}

export function createPasteAssembler(): PasteAssembler {
  let collecting = false;
  let buffer = "";
  // Held tail of the previous delivery that may be the first half
  // of a start/end marker.
  let pending = "";

  return {
    get collecting() {
      return collecting;
    },
    reset() {
      collecting = false;
      buffer = "";
      pending = "";
    },
    feed(rawInput: string): PasteFeedResult {
      // Normalize the ESC-prefixed marker spellings first, so the
      // scanner below only deals with one form.
      let input = pending + rawInput.replaceAll(START_ESC, START).replaceAll(END_ESC, END);
      pending = "";
      let plain = "";
      const pastes: string[] = [];
      let i = 0;

      while (i < input.length) {
        if (!collecting) {
          const start = input.indexOf(START, i);
          if (start === -1) {
            // No start marker ahead — but the tail may be the first
            // half of one split across deliveries; hold it.
            const tailLen = trailingPartialMarkerLength(input.slice(i), START);
            const end = tailLen > 0 ? input.length - tailLen : input.length;
            plain += input.slice(i, end);
            if (tailLen > 0) pending = input.slice(end);
            i = input.length;
            break;
          }
          plain += input.slice(i, start);
          collecting = true;
          buffer = "";
          i = start + START.length;
        } else {
          const end = input.indexOf(END, i);
          if (end === -1) {
            const tailLen = trailingPartialMarkerLength(input.slice(i), END);
            const cut = tailLen > 0 ? input.length - tailLen : input.length;
            buffer += input.slice(i, cut);
            if (tailLen > 0) pending = input.slice(cut);
            i = input.length;
            break;
          }
          buffer += input.slice(i, end);
          pastes.push(stripAnsi(buffer));
          collecting = false;
          buffer = "";
          i = end + END.length;
        }
      }

      // A lone end marker with no open paste is a stray control
      // sequence (terminal glitch), not user text: it was already
      // skipped above only when it terminates a paste; an END that
      // appears while idle is consumed by the scanner as plain text
      // only if it is not at a marker boundary — see note in feed:
      // the idle branch looks for START only, so a bare END lands
      // in `plain`. Strip it out: pasting never produces a bare
      // "[201~" a user typed (a user typing it literally would be
      // inside a paste itself).
      if (plain.includes(END)) {
        plain = plain.replaceAll(END, "");
      }
      return { plain, pastes, collecting };
    },
  };
}
