// Unit tests for the tool-result display summary (src/ui/tool-summary.ts).
// Freebuff: tool-branch.tsx (shell = last 3 lines, "..." prefix when
// more) + read-files.tsx (paths only, contents never shown).
// Run after build: npm run build && npm test
import test from "node:test";
import assert from "node:assert/strict";
import { summarizeToolResult } from "../dist/ui/tool-summary.js";

const shellJson = (stdout, stderr = "") =>
  JSON.stringify({ command: "echo hi", stdout, stderr, exitCode: 0 });

test("summary: shell shows the last 3 lines with ... prefix when more", () => {
  const out = shellJson("line1\nline2\nline3\nline4\nline5\n");
  assert.equal(summarizeToolResult("run_terminal_command", out, true), "... line3 / line4 / line5");
});

test("summary: shell with 3 or fewer lines has no ... prefix", () => {
  assert.equal(summarizeToolResult("run_terminal_command", shellJson("line1\nline2\n"), true), "line1 / line2");
  assert.equal(summarizeToolResult("run_terminal_command", shellJson("only\n"), true), "only");
});

test("summary: shell stderr is appended after stdout", () => {
  const out = shellJson("out1\nout2\n", "err1\n");
  assert.equal(summarizeToolResult("run_terminal_command", out, true), "out1 / out2 / err1");
});

test("summary: shell falls back to raw output when not JSON", () => {
  assert.equal(
    summarizeToolResult("run_terminal_command", "a\nb\nc\nd\n", true),
    "... b / c / d",
  );
});

test("summary: read_files success shows no result line (Freebuff: paths only)", () => {
  const big = Array.from({ length: 60 }, (_, i) => `line ${i + 1} of the file`).join("\n");
  assert.equal(summarizeToolResult("read_files", big, true), null);
});

test("summary: read_files failure still shows its short error", () => {
  const s = summarizeToolResult("read_files", "read_files: cannot read missing.txt: ENOENT", false);
  assert.ok(s !== null && s.includes("cannot read missing.txt"));
});

test("summary: other tools collapse to one line, max 120 chars, with line count", () => {
  const out = Array.from({ length: 10 }, (_, i) => `entry number ${i + 1} with some text`).join("\n");
  const s = summarizeToolResult("list_directory", out, true);
  assert.ok(s !== null);
  assert.ok(s.length <= 120 + " (+10 baris)".length);
  assert.ok(s.endsWith("(+10 baris)"), s);
  assert.ok(!s.includes("\n"));
});

test("summary: single-line output gets no line-count suffix", () => {
  assert.equal(summarizeToolResult("write_file", "Wrote 12 lines to hello.txt", true), "Wrote 12 lines to hello.txt");
});

test("summary: empty output stays empty", () => {
  assert.equal(summarizeToolResult("glob", "", true), "");
});
