// Unit tests for the terminal-safe sanitizer (src/ui/terminal-safe.ts).
// Port of Freebuff common/src/util/terminal-safe-text.ts (Apache-2.0):
// text a remote party wrote (model output, tool results, file contents)
// must never reach the terminal with an escape sequence intact — one
// ESC can write the clipboard (OSC 52), fake a link (OSC 8), repaint
// the screen (CSI), or flip text direction (bidi controls).
// Run after build: npm run build && npm test
import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeTerminalText, sanitizeTerminalOutput } from "../dist/ui/terminal-safe.js";

test("sanitizeTerminalText: plain text passes through untouched", () => {
  assert.equal(sanitizeTerminalText("hello world\nsecond line"), "hello world\nsecond line");
  assert.equal(sanitizeTerminalText("  indented code"), "  indented code");
  assert.equal(sanitizeTerminalText(""), "");
});

test("sanitizeTerminalText: CSI color codes are stripped, text kept", () => {
  assert.equal(sanitizeTerminalText("\x1b[31mred\x1b[0m plain"), "red plain");
  assert.equal(sanitizeTerminalText("\x1b[1;32mbold green\x1b[m"), "bold green");
  assert.equal(sanitizeTerminalText("a\x9bb\x1b[31mc"), "ac");
});

test("sanitizeTerminalText: OSC 52 clipboard write and OSC 8 link are removed whole", () => {
  // OSC 52: \x1b]52;c;<base64>\x07 — the payload must not survive.
  assert.equal(sanitizeTerminalText("x\x1b]52;c;c2VjcmV0\x07y"), "xy");
  // OSC 8 hyperlink: the escape (and its target) is dropped; the
  // visible text survives, now pointing nowhere.
  assert.equal(sanitizeTerminalText("click \x1b]8;;https://evil.example\x1b\\here\x1b]8;;\x1b\\ now"), "click here now");
});

test("sanitizeTerminalText: bidi overrides and invisible formatting chars are stripped", () => {
  assert.equal(sanitizeTerminalText("a\u202eb\u202cc"), "abc");
  assert.equal(sanitizeTerminalText("a\u200bb\u200cc"), "abc");
  assert.equal(sanitizeTerminalText("a\ufeff\u00adb"), "ab");
});

test("sanitizeTerminalText: newlines survive, CRLF becomes LF, tab becomes two spaces", () => {
  assert.equal(sanitizeTerminalText("a\r\nb\rc"), "a\nb\nc");
  assert.equal(sanitizeTerminalText("a\tb"), "a  b");
});

test("sanitizeTerminalText: other C0 controls are stripped", () => {
  // \x1b followed by one printable char is a short escape sequence
  // (Freebuff SHORT_ESCAPE), so the "d" goes with the ESC.
  assert.equal(sanitizeTerminalText("a\x00b\x07c\x1bd"), "abc");
  assert.equal(sanitizeTerminalText("a\x00b\x07c"), "abc");
});

test("sanitizeTerminalOutput: bare CR keeps only the text after the last CR (progress bar redraw)", () => {
  assert.equal(sanitizeTerminalOutput("downloading 10%\rdownloading 50%\rdone\n"), "done\n");
  assert.equal(sanitizeTerminalOutput("line1\nprog\rfinal\n"), "line1\nfinal\n");
});

test("sanitizeTerminalOutput: escapes are stripped like in sanitizeTerminalText", () => {
  assert.equal(sanitizeTerminalOutput("\x1b[32mok\x1b[0m\n"), "ok\n");
});

test("sanitizeTerminalText: a split escape sequence is only safe once reassembled", () => {
  // Per-chunk sanitizing would strip "\x1b[" from chunk 1 and leak
  // "31m" from chunk 2 as visible text — the render boundary
  // sanitizes the full reassembled content, where the CSI is whole.
  assert.equal(sanitizeTerminalText("\x1b[31mred"), "red");
  assert.equal(sanitizeTerminalText("a\x1b[" + "31mb"), "ab");
});
