// Terminal-safe normalization for text a remote party wrote and a
// terminal UI will draw (model output, tool results, file contents).
//
// Ported from Freebuff, Apache-2.0:
//   freebuff-source/common/src/util/terminal-safe-text.ts
//     (sanitizeTerminalText, sanitizeTerminalOutput)
//
// A terminal interprets bytes, not strings. Text that reaches it with
// an ESC or C1 control intact can write the user's clipboard (OSC 52),
// draw a link whose visible text is not its target (OSC 8), move the
// cursor and repaint other parts of the screen (CSI), retitle the
// window, or flip text direction so a reviewer and the user read
// different words. The renderer does not filter these, so every such
// string is cleaned before it is drawn. Newlines survive (CR and CRLF
// become `\n`); a tab becomes two spaces. Printable text is otherwise
// unchanged and NOT trimmed, so indentation in a diagram or a code
// sample keeps its shape.

const CSI = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g;
const OSC = /(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g;
const STRING_COMMAND =
  /(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x07|\x9c|$)/g;
const SHORT_ESCAPE = /\x1b[\x20-\x2f]*[\x30-\x7e]?/g;
/** C0 except `\n`, DEL, and C1. `\t` and `\r` are normalized before this. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * Unicode Default_Ignorable_Code_Point characters are invisible, so
 * they can split a prohibited word or change its display without
 * changing what a reviewer sees. Kept explicit rather than relying
 * on a runtime Unicode table, exactly as in the Freebuff source
 * (full property as of Unicode 16, including bidi controls, tags,
 * and both variation-selector blocks).
 */
const DEFAULT_IGNORABLE =
  /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￰-￻\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e0fff}]/gu;

/**
 * Strip every escape sequence (OSC, DCS/SOS/PM/APC, CSI, short ESC,
 * 7- and 8-bit forms), every other C0/C1 control, and the invisible
 * Unicode formatting characters.
 */
export function sanitizeTerminalText(input: string): string {
  return input
    .replace(OSC, "")
    .replace(STRING_COMMAND, "")
    .replace(CSI, "")
    .replace(SHORT_ESCAPE, "")
    .replace(DEFAULT_IGNORABLE, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(CONTROL, "");
}

/**
 * sanitizeTerminalText for captured process output (a tool's stdout,
 * a file the agent read) before a terminal UI draws it.
 *
 * One difference: a bare `\r` is a progress bar redrawing its line,
 * not a line break, so only the text after the last `\r` on each
 * line is kept — what a real terminal would show — instead of one
 * line per redraw.
 */
export function sanitizeTerminalOutput(input: string): string {
  const lines = input.split("\n").map((line) => {
    const lastCr = line.lastIndexOf("\r");
    return lastCr === -1 ? line : line.slice(lastCr + 1);
  });
  return sanitizeTerminalText(lines.join("\n"));
}
