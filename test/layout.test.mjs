// Unit tests for the full-screen layout logic (src/ui/layout.ts).
// Run after build: npm run build && npm test
import test from "node:test";
import assert from "node:assert/strict";
import {
  breakpoints,
  wrapText,
  wrapLineCount,
  flattenMessages,
  tableLines,
  textWidth,
  inputBoxRowsFor,
  layoutBudget,
  pickerHint,
  paletteHint,
  pickerMaxRowsFor,
  pickerRenderedRows,
  paletteMaxRowsFor,
  paletteRenderedRows,
  welcomeLayout,
  headerLayout,
  composerIsCentered,
  COMPOSER_CENTERED_CONTENT_ROWS,
  windowLines,
  pageScrollOffset,
  wheelScrollOffset,
  easeOutCubic,
  SIDE_GUTTER,
  SCROLL_ANIMATION_DURATION_MS,
  SCROLL_ANIMATION_FRAME_MS,
} from "../dist/ui/layout.js";
// Markdown rendering lives in markdown.ts now (parse-first AST
// pipeline, Freebuff's unified + remark stack); the old
// inlineSegments/markdownLines regex layer is deleted.
import {
  parseMarkdown,
  renderInlineText,
  renderMarkdownText,
  wrapSegments,
} from "../dist/ui/markdown.js";
import { splitMessageParts } from "../dist/ui/syntax.js";
import { theme, markdown } from "../dist/theme.js";

const CATALOG = {
  entries: [
    { id: "a-free", free: true, price: null },
    { id: "b-free", free: true, price: null },
    { id: "c-paid", free: false, price: { input: 1, output: 2 } },
    { id: "d-paid", free: false, price: { input: 2, output: 4 } },
  ],
};

test("breakpoints: Freebuff-style width/height classes", () => {
  assert.deepEqual(breakpoints(40, 15), { width: "xs", height: "xs" });
  assert.deepEqual(breakpoints(49, 19), { width: "xs", height: "xs" });
  assert.deepEqual(breakpoints(50, 20), { width: "sm", height: "sm" });
  assert.deepEqual(breakpoints(80, 24), { width: "sm", height: "sm" });
  assert.deepEqual(breakpoints(100, 40), { width: "md", height: "sm" });
  assert.deepEqual(breakpoints(151, 41), { width: "lg", height: "md" });
});

test("wrapText: word wrap, newlines, empty lines, long words", () => {
  assert.deepEqual(wrapText("hello world", 20), ["hello world"]);
  assert.deepEqual(wrapText("hello world foo", 8), ["hello", "world", "foo"]);
  assert.deepEqual(wrapText("a\n\nb", 10), ["a", "", "b"]);
  assert.deepEqual(wrapText("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  assert.deepEqual(wrapText("", 10), [""]);
  assert.equal(wrapLineCount("hello world foo bar", 8), 3);
});

test("flattenMessages: system/user/assistant lines + blank separator", () => {
  const lines = flattenMessages(
    [
      { role: "assistant", content: "sys msg", kind: "system" },
      { role: "user", content: "hi", kind: "chat" },
      { role: "assistant", content: "hello there", kind: "chat" },
    ],
    40,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  // Every line carries the 1-column SIDE_GUTTER prefix (Freebuff
  // message-with-agents.tsx:105); the user line is gutter + bar +
  // space, so "You:" starts 3 spaces in. User lines carry the
  // 1-column SOLID left border (Freebuff user line): a colored space
  // + 1 gutter space, not a "│" glyph.
  assert.deepEqual(texts, [" sys msg", "  ", "   You: hi", "  ", " hello there", "  "]);
  // Gutter first (plain space), then the border segment (solid bar,
  // userLine bg), then the gutter space after the bar, then the
  // "You: " label with its own color.
  assert.equal(lines[2].segments[0].text, " ");
  assert.equal(lines[2].segments[0].backgroundColor, undefined);
  assert.equal(lines[2].segments[1].text, " ");
  assert.equal(lines[2].segments[1].backgroundColor, theme.userLine);
  assert.equal(lines[2].segments[2].text, " ");
  assert.equal(lines[2].segments[3].text, "You: ");
});

test("flattenMessages: session-start system block (2 lines, muted, no label)", () => {
  // VectorHead-style session announcement: session id + model + FREE
  // price + balance, as one multi-line system message. Renders as
  // plain muted text — no label, no border, no timestamp.
  const lines = flattenMessages(
    [
      {
        role: "assistant",
        content:
          "New conversation started (session: 2026-11-08T21-00-00.000Z).\nModel set to glm-5.3-flash · FREE $0.00 · Balance $0.0000.",
        kind: "system",
      },
    ],
    80,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.deepEqual(texts, [
    " New conversation started (session: 2026-11-08T21-00-00.000Z).",
    " Model set to glm-5.3-flash · FREE $0.00 · Balance $0.0000.",
    "  ",
  ]);
  assert.equal(lines[0].segments[1].color, theme.muted, "content segment after the gutter is muted");
  assert.ok(!texts.join("\n").includes("Muse:"));
});

test("flattenMessages: user message content is italic (Freebuff single-block)", () => {
  const lines = flattenMessages(
    [{ role: "user", content: "halo apa kabar", kind: "chat", ts: Date.UTC(2026, 10, 8, 12, 34) }],
    40,
  );
  const contentSeg = lines.flatMap((l) => l.segments).find((s) => s.text === "halo apa kabar");
  assert.ok(contentSeg, "user content renders");
  assert.equal(contentSeg.italic, true);
  const labelSeg = lines.flatMap((l) => l.segments).find((s) => s.text === "You: ");
  assert.equal(labelSeg.italic, undefined, "the You: label itself is not italic");
});

test("flattenMessages: timestamp [HH:MM] above a message + inline Markdown", () => {
  const lines = flattenMessages(
    [
      { role: "user", content: "hi", kind: "chat", ts: Date.UTC(2026, 10, 8, 12, 34) },
      { role: "assistant", content: "a **bold** and `code` word", kind: "chat", ts: Date.UTC(2026, 10, 8, 12, 35) },
    ],
    40,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.ok(texts[0].match(/^   \[\d\d:\d\d\]$/), `timestamp line: ${texts[0]}`);
  // §4p (koreksi Reza: §4l "kejauhan"): NO blank line — Freebuff
  // message-block.tsx:187-194 has no gap, the timestamp sits directly
  // above the text. The bar runs alongside the timestamp line too
  // (message-with-agents.tsx:236-252, marginTop/bottom 0), so the
  // timestamp is the header of the bordered block, not a floating line.
  assert.equal(texts[1], "   You: hi");
  assert.ok(texts.includes("   You: hi"));
  const boldLine = lines.find((l) => l.segments.some((s) => s.bold === true && s.text === "bold"));
  assert.ok(boldLine, "inline **bold** becomes a bold segment");
  // Freebuff markdown-renderer.tsx: inline `code` is BOLD, space-padded,
  // fg #FF8534 on bg #374151.
  const codeSeg = lines.flatMap((l) => l.segments).find((s) => s.text === " code ");
  assert.ok(codeSeg, "inline `code` becomes a space-padded segment");
  assert.equal(codeSeg.color, "#FF8534");
  assert.equal(codeSeg.backgroundColor, "#374151");
  assert.equal(codeSeg.bold, true);
});

test("flattenMessages: timestamp directly above You:, bar spans the timestamp line (Freebuff)", () => {
  // §4p: a user message WITH a timestamp renders [HH:MM] DIRECTLY
  // above the "You:" body (no blank line — Freebuff message-block
  // root has no gap), and the green bar runs alongside the timestamp
  // line too (Freebuff message-with-agents vertical line, marginTop
  // 0 / marginBottom 0). A user message WITHOUT a timestamp renders
  // the body directly (no leading blank line added).
  const withTs = flattenMessages(
    [{ role: "user", content: "halo", kind: "chat", ts: Date.UTC(2026, 10, 8, 12, 34) }],
    40,
  );
  const withTsTexts = withTs.map((l) => l.segments.map((s) => s.text).join(""));
  assert.ok(withTsTexts[0].match(/^   \[\d\d:\d\d\]$/), `timestamp line: ${withTsTexts[0]}`);
  assert.deepEqual(withTsTexts.slice(1), ["   You: halo", "  "]);
  // Bar on the timestamp line: gutter, then the green-background bar
  // space, then a space, then the timestamp text.
  const tsSegs = withTs[0].segments;
  assert.equal(tsSegs[0].text, " ");
  assert.equal(tsSegs[1].backgroundColor, theme.userLine);
  assert.equal(tsSegs[1].text, " ");
  assert.ok(/^\[\d\d:\d\d\]$/.test(tsSegs[3].text), `timestamp text: ${tsSegs[3].text}`);
  const noTs = flattenMessages([{ role: "user", content: "halo", kind: "chat" }], 40);
  const noTsTexts = noTs.map((l) => l.segments.map((s) => s.text).join(""));
  assert.deepEqual(noTsTexts, ["   You: halo", "  "]);
});

test("flattenMessages: heading is yellow + bold, link is blue (Freebuff palette)", () => {
  const lines = flattenMessages(
    [{ role: "assistant", content: "# Hasil\nLihat [docs](https://example.com) ya.", kind: "chat" }],
    40,
  );
  const segs = lines.flatMap((l) => l.segments);
  const heading = segs.find((s) => s.text === "Hasil");
  assert.ok(heading, "heading text renders");
  assert.equal(heading.color, "#facc15");
  assert.equal(heading.bold, true);
  const link = segs.find((s) => s.text === "docs");
  assert.ok(link, "link text renders without the URL");
  assert.equal(link.color, "#3B82F6");
});

test("flattenMessages: assistant plain paragraph is foreground, not terminal default (Freebuff message-block textColor)", () => {
  // Root cause of the gray reply: renderMarkdownText passed no baseColor,
  // so plain paragraphs carried NO color and Ink fell back to the terminal
  // default foreground (gray on Reza's Termux). Freebuff threads
  // textColor ?? theme.foreground into its blocks renderer instead.
  const lines = flattenMessages(
    [{ role: "assistant", content: "Halo! Saya GLM, model bahasa besar.\n\nParagraf kedua tetap jelas.", kind: "chat" }],
    40,
  );
  const segs = lines.flatMap((l) => l.segments);
  const plain = segs.find((s) => s.text === "Halo! Saya GLM, model bahasa besar.");
  assert.ok(plain, "plain paragraph renders");
  assert.equal(plain.color, theme.text, "main reply uses the foreground token");
  const plain2 = segs.find((s) => s.text === "Paragraf kedua tetap jelas.");
  assert.ok(plain2, "second paragraph renders");
  assert.equal(plain2.color, theme.text);
  // Semantic colors are untouched: bold keeps foreground + bold, inline
  // code keeps orange, blockquote keeps its own text color.
  const boldLines = flattenMessages(
    [{ role: "assistant", content: "Cek **panduan** dan `npm test` dulu.\n\n> catatan penting", kind: "chat" }],
    40,
  );
  const boldSegs = boldLines.flatMap((l) => l.segments);
  const bold = boldSegs.find((s) => s.text === "panduan");
  assert.equal(bold.color, theme.text);
  assert.equal(bold.bold, true);
  const code = boldSegs.find((s) => s.text === " npm test ");
  assert.equal(code.color, "#FF8534");
  const quote = boldSegs.find((s) => s.text === "catatan penting");
  assert.equal(quote.color, markdown.blockquoteTextFg);
});

test("flattenMessages: code block is Freebuff monochrome on gray + // lang header", () => {
  const lines = flattenMessages(
    [{ role: "assistant", content: "```js\nconst x = 1;\n```", kind: "chat" }],
    40,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.equal(texts[0], " // js");
  assert.ok(texts[1].includes("const"));
  // Body: one color, one background, no per-token colors (segments[0]
  // is the plain SIDE_GUTTER space, so the body is segments[1..]).
  assert.ok(lines[1].segments.slice(1).every((s) => s.color === "#f1f5f9"));
  assert.ok(lines[1].segments.slice(1).every((s) => s.backgroundColor === "#374151"));
});

test("flattenMessages: to-do list renders Freebuff-style (header, boxes, strikethrough)", () => {
  const lines = flattenMessages(
    [
      {
        role: "assistant",
        content: "",
        kind: "chat",
        blocks: [
          {
            type: "todos",
            todos: [
              { task: "Baca hello.txt", completed: true },
              { task: "Jalankan perintah", completed: false },
            ],
          },
        ],
      },
    ],
    40,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.ok(texts[0].includes("TODOs"), "header • TODOs");
  assert.ok(lines[0].segments.some((s) => s.text === "TODOs" && s.bold === true));
  assert.ok(texts.some((t) => t.includes("✓") && t.includes("Baca hello.txt")), "completed item shows ✓");
  assert.ok(texts.some((t) => t.includes("☐") && t.includes("Jalankan perintah")), "pending item shows ☐");
  const doneSeg = lines.flatMap((l) => l.segments).find((s) => s.text === "Baca hello.txt");
  assert.equal(doneSeg.strikethrough, true, "completed task is struck through");
  assert.equal(doneSeg.color, "#acb3bf", "completed task is muted");
  const pendingSeg = lines.flatMap((l) => l.segments).find((s) => s.text === "Jalankan perintah");
  assert.equal(pendingSeg.strikethrough, false);
});

test("flattenMessages: empty to-do list renders nothing", () => {
  const lines = flattenMessages(
    [{ role: "assistant", content: "", kind: "chat", blocks: [{ type: "todos", todos: [] }] }],
    40,
  );
  // Only the trailing blank line from the message separator.
  assert.ok(lines.every((l) => l.segments.every((s) => s.text.trim() === "")));
});

// TUI interaction fix (Freebuff ContentBlock model): one assistant
// message per turn holds its blocks in ARRIVAL order, so text the
// model wrote AFTER a tool call renders BELOW that tool call —
// before this change all turn text rendered above all tool calls.
test("flattenMessages: assistant blocks render in arrival order (text, tool, text)", () => {
  const lines = flattenMessages(
    [
      {
        role: "assistant",
        // content keeps the concatenated turn text (for /export);
        // the layout must render the BLOCKS, not this field.
        content: "Membaca file dulu.File sudah dibaca.",
        kind: "chat",
        blocks: [
          { type: "text", content: "Membaca file dulu." },
          { type: "tool", name: "read_files", preview: "Read hello.txt", shell: false, results: [], done: true },
          { type: "text", content: "File sudah dibaca." },
        ],
      },
    ],
    40,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  const row = (needle) => texts.findIndex((t) => t.includes(needle));
  assert.ok(row("Membaca file dulu.") >= 0, "first text renders");
  assert.ok(row("Read hello.txt") > row("Membaca file dulu."), "tool renders below the text that preceded it");
  assert.ok(row("File sudah dibaca.") > row("Read hello.txt"), "text written after the tool renders BELOW the tool");
  assert.equal(texts.filter((t) => t.includes("Membaca file dulu.")).length, 1, "no duplicated text");
  assert.equal(texts.filter((t) => t.includes("Read hello.txt")).length, 1, "no duplicated tool preview");
});

test("flattenMessages: todos block keeps its position between text blocks", () => {
  const lines = flattenMessages(
    [
      {
        role: "assistant",
        content: "",
        kind: "chat",
        blocks: [
          { type: "text", content: "Buat daftar tugas dulu." },
          {
            type: "todos",
            todos: [
              { task: "Baca hello.txt", completed: false },
              { task: "Edit hello.txt", completed: false },
            ],
          },
          { type: "text", content: "Tandai yang sudah selesai." },
        ],
      },
    ],
    40,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  const row = (needle) => texts.findIndex((t) => t.includes(needle));
  assert.ok(row("TODOs") > row("Buat daftar tugas dulu."), "todos render below the preceding text");
  assert.ok(row("Tandai yang sudah selesai.") > row("TODOs"), "text after the todos renders below the list");
  assert.ok(row("Baca hello.txt") > row("TODOs"), "todo items render under the header");
});

test("flattenMessages: each tool block keeps its own result (parallel-wave order)", () => {
  const lines = flattenMessages(
    [
      {
        role: "assistant",
        content: "",
        kind: "chat",
        blocks: [
          { type: "tool", name: "read_files", preview: "Read hello.txt", shell: false, results: [], done: true },
          {
            type: "tool",
            name: "run_terminal_command",
            preview: "$ touch agent-ran.txt",
            shell: true,
            results: [{ ok: true, text: "line4 / hello-agent" }],
            done: true,
          },
        ],
      },
    ],
    40,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  const row = (needle) => texts.findIndex((t) => t.includes(needle));
  assert.ok(row("Read hello.txt") >= 0, "first tool renders");
  assert.ok(row("$ touch agent-ran.txt") > row("Read hello.txt"), "second tool renders below the first");
  assert.ok(row("hello-agent") > row("$ touch agent-ran.txt"), "shell result renders under its own preview, not under the read");
  assert.ok(!texts[row("Read hello.txt") + 1]?.includes("hello-agent"), "no result leaks onto the read block");
});

test("flattenMessages: assistant message without blocks falls back to content", () => {
  const lines = flattenMessages(
    [{ role: "assistant", content: "jawaban lama tanpa block", kind: "chat" }],
    40,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.deepEqual(texts, [" jawaban lama tanpa block", "  "]);
});

test("flattenMessages: assistant block has NO timestamp (Freebuff message-block)", () => {
  const lines = flattenMessages(
    [{ role: "assistant", content: "answer", kind: "chat", ts: Date.UTC(2026, 10, 8, 12, 35) }],
    40,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.ok(!texts.some((t) => /^ \[\d\d:\d\d\]$/.test(t)), "no timestamp line on the assistant block");
  assert.ok(!texts.some((t) => t.includes("Muse:")), "no Muse: label on the assistant block (Freebuff shows the answer directly)");
  assert.equal(texts[0], " answer");
});

test("inputBoxRowsFor: 2 borders + content rows + palette rows inside", () => {
  assert.equal(inputBoxRowsFor(1, 0), 3);
  assert.equal(inputBoxRowsFor(2, 0), 4);
  assert.equal(inputBoxRowsFor(1, 8), 11);
});

test("flattenMessages: reasoning renders as a Thinking block before the answer", () => {
  const thinking = Array.from({ length: 8 }, (_, i) => `reasoning line ${i + 1} with some extra words here`).join("\n");
  const lines = flattenMessages(
    [{ role: "assistant", content: "answer", kind: "chat", thinking, thinkingComplete: true }],
    40,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.ok(texts[0].includes("Thinking"), `first line is the block header: ${texts[0]}`);
  // Preview = last 5 visual lines, earlier lines cut off with "...".
  assert.ok(texts.some((t) => t.includes("line 8")));
  assert.ok(texts.some((t) => t.startsWith("   ...")), "cut-off preview is prefixed ...");
  assert.ok(!texts.some((t) => t.includes("reasoning line 1")), "first lines are cut from the preview");
  assert.ok(!texts.includes("Muse:"), "no Muse: label before the answer");
  assert.ok(texts.includes(" answer"));
});

test("flattenMessages: one blank line between the Thinking block and the answer (Freebuff message-block gap: 1)", () => {
  const thinking = "short reasoning";
  const lines = flattenMessages(
    [{ role: "assistant", content: "answer", kind: "chat", thinking, thinkingComplete: true }],
    40,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  // Header, preview line, blank gap, answer, trailing blank.
  assert.ok(texts[0].includes("Thinking"));
  assert.ok(texts[1].includes("short reasoning"));
  assert.equal(texts[2].trim(), "", "blank line separates the Thinking block from the answer");
  assert.equal(texts[3], " answer");
});

test("flattenMessages: no gap blank line when the answer is empty (still streaming)", () => {
  const lines = flattenMessages(
    [{ role: "assistant", content: "", kind: "chat", thinking: "short reasoning", thinkingComplete: false }],
    40,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.ok(texts[0].includes("Thinking"));
  assert.ok(texts[1].includes("short reasoning"));
  // Only the message's own trailing blank line follows.
  assert.equal(texts.filter((t) => t.trim() === "").length, 1);
});

test("flattenMessages: lone **bold** reasoning under 100 chars is hidden", () => {
  const lines = flattenMessages(
    [{ role: "assistant", content: "answer", kind: "chat", thinking: "**Just a title**", thinkingComplete: true }],
    40,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.ok(!texts.some((t) => t.includes("Thinking")));
  assert.ok(texts.includes(" answer"));
});

test("flattenMessages: code block keeps lang line + token colors", () => {
  const lines = flattenMessages(
    [{ role: "assistant", content: "```js\nconst x = 1;\n```", kind: "chat" }],
    40,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.equal(texts[0], " // js");
  assert.ok(texts[1].includes("const"));
  assert.ok(lines[1].segments.some((s) => s.color));
});

test("layoutBudget: fixed rows subtracted from terminal rows", () => {
  assert.deepEqual(
    layoutBudget({ rows: 24, headerRows: 1, inputRows: 1, footerRows: 1, thinkingRows: 0, errorRows: 0, pickerRows: 0, paletteRows: 0 }),
    { fixedRows: 3, available: 21 },
  );
  assert.deepEqual(
    layoutBudget({ rows: 15, headerRows: 2, inputRows: 1, footerRows: 1, thinkingRows: 1, errorRows: 2, pickerRows: 5, paletteRows: 0 }),
    { fixedRows: 12, available: 3 },
  );
  // Never negative.
  assert.equal(
    layoutBudget({ rows: 5, headerRows: 2, inputRows: 1, footerRows: 1, thinkingRows: 1, errorRows: 0, pickerRows: 5, paletteRows: 0 }).available,
    0,
  );
});

test("pickerMaxRowsFor: dynamic budget, never pushes input out", () => {
  // Desktop 80x24, fixed chrome 3 rows: 24-3-6 = 15 model rows.
  assert.equal(pickerMaxRowsFor(24, 3), 15);
  // Small 40x15, fixed chrome 4 rows: 15-4-6 = 5 model rows.
  assert.equal(pickerMaxRowsFor(15, 4), 5);
  // Tiny terminal: floor of 1 model row.
  assert.equal(pickerMaxRowsFor(8, 4), 1);
  // Picker chrome (6) + fixed chrome + model rows always fit the viewport.
  for (const rows of [15, 20, 24, 40, 50]) {
    const fixed = 4;
    const maxRows = pickerMaxRowsFor(rows, fixed);
    const total = pickerRenderedRows({ catalog: CATALOG, selectedIndex: 0, maxRows });
    assert.ok(fixed + total <= rows, `picker fits in ${rows} rows`);
  }
});

test("pickerHint / paletteHint: short form on narrow terminals", () => {
  assert.equal(pickerHint(36), "↑↓ pilih · Enter pakai · Esc batal");
  assert.equal(pickerHint(80), "↑↓ pilih · Enter pakai · Esc batal · ▸ = model aktif");
  assert.equal(paletteHint(36), "↑↓ pilih · Enter · Esc");
  assert.equal(paletteHint(80), "↑↓ pilih · Enter jalankan · Esc tutup");
  // Both forms fit on one row at their width.
  assert.equal(wrapLineCount(pickerHint(36), 36), 1);
  assert.equal(wrapLineCount(paletteHint(36), 36), 1);
});

test("pickerRenderedRows: margin + title + rows + headers + hint + selected detail", () => {
  // 4 models, maxRows 16: all visible, 2 group headers, no "more" line,
  // + 1 detail line under the selected row.
  assert.equal(pickerRenderedRows({ catalog: CATALOG, selectedIndex: 0, maxRows: 16 }), 1 + 1 + 4 + 2 + 0 + 1 + 1);
  // maxRows 2: window of 2, 1 header in slice, "more" line present, + detail.
  assert.equal(pickerRenderedRows({ catalog: CATALOG, selectedIndex: 0, maxRows: 2 }), 1 + 1 + 2 + 1 + 1 + 1 + 1);
});

test("paletteMaxRowsFor / paletteRenderedRows", () => {
  assert.equal(paletteMaxRowsFor(24, 3), 8);
  assert.equal(paletteMaxRowsFor(15, 4), 8); // 15-4-2 = 9, capped at 8
  assert.equal(paletteMaxRowsFor(8, 4), 2);
  assert.equal(paletteRenderedRows({ totalCommands: 8, selectedIndex: 0, maxRows: 8 }), 1 + 8 + 1);
  assert.equal(paletteRenderedRows({ totalCommands: 8, selectedIndex: 0, maxRows: 3 }), 1 + 3 + 1);
  assert.equal(paletteRenderedRows({ totalCommands: 0, selectedIndex: 0, maxRows: 8 }), 2);
});

test("windowLines: bottom-anchored, offset shifts up, clamps", () => {
  const lines = Array.from({ length: 30 }, (_, i) => ({ segments: [{ text: `l${i}` }] }));
  const bottom = windowLines(lines, 10, 0);
  assert.deepEqual(bottom.lines.map((l) => l.segments[0].text), ["l20", "l21", "l22", "l23", "l24", "l25", "l26", "l27", "l28", "l29"]);
  assert.equal(bottom.hiddenAbove, 20);
  assert.equal(bottom.hiddenBelow, 0);
  assert.equal(bottom.isAtBottom, true);

  const up = windowLines(lines, 10, 8);
  assert.equal(up.lines[0].segments[0].text, "l12");
  assert.equal(up.hiddenBelow, 8);
  assert.equal(up.isAtBottom, false);

  // Offset past the top clamps to the first page.
  const over = windowLines(lines, 10, 999);
  assert.equal(over.lines[0].segments[0].text, "l0");
  assert.equal(over.hiddenBelow, 20);

  // Short history: everything fits, offset ignored.
  const short = windowLines(lines.slice(0, 5), 10, 0);
  assert.equal(short.lines.length, 5);
  assert.equal(short.isAtBottom, true);
});

test("pageScrollOffset: 0.8 viewport page, clamped both ends", () => {
  assert.equal(pageScrollOffset(0, "up", 10, 30), 8);
  assert.equal(pageScrollOffset(8, "up", 10, 30), 16);
  assert.equal(pageScrollOffset(18, "up", 10, 30), 20); // max offset = 30-10
  assert.equal(pageScrollOffset(20, "down", 10, 30), 12);
  assert.equal(pageScrollOffset(3, "down", 10, 30), 0);
  assert.equal(pageScrollOffset(0, "down", 10, 30), 0);
  assert.equal(pageScrollOffset(0, "up", 10, 5), 0); // fits already
});

test("wheelScrollOffset: 1 line per wheel tick, clamped both ends", () => {
  // Freebuff LinearScrollAccel: one wheel event = one line. A fling
  // sends many events; each applies one step from the live offset.
  assert.equal(wheelScrollOffset(0, "up", 1, 10, 30), 1);
  assert.equal(wheelScrollOffset(1, "up", 1, 10, 30), 2);
  assert.equal(wheelScrollOffset(19, "up", 1, 10, 30), 20); // max = 30-10
  assert.equal(wheelScrollOffset(20, "up", 1, 10, 30), 20); // clamped
  assert.equal(wheelScrollOffset(20, "down", 1, 10, 30), 19);
  assert.equal(wheelScrollOffset(1, "down", 1, 10, 30), 0);
  assert.equal(wheelScrollOffset(0, "down", 1, 10, 30), 0); // clamped
  assert.equal(wheelScrollOffset(0, "up", 1, 10, 5), 0); // fits already
  assert.equal(wheelScrollOffset(5, "up", 3, 10, 30), 8); // burst of 3
  assert.equal(wheelScrollOffset(5, "down", 3, 10, 30), 2);
  assert.equal(wheelScrollOffset(0, "up", 0, 10, 30), 0); // 0 lines = noop
});
test("welcomeLayout: desktop 80x24 — exact budget, card, content (no ASCII banner, Reza 2026-11-10)", () => {
  const w = welcomeLayout({
    available: 21,
    contentWidth: 76,
    model: "glm-5.3-flash",
    free: true,
    priceText: null,
    balanceUsd: 0.4855,
  });
  assert.equal(w.rows.length, 21, "welcome must fill exactly the message budget");
  const text = w.rows.map((l) => l.segments.map((s) => s.text).join("")).join("\n");
  assert.ok(!text.includes("M   M"), "no ASCII banner rows");
  assert.ok(!text.includes("EEEEE"), "no ASCII banner rows");
  assert.ok(text.includes("Pesan pertama memulai sesi."));
  assert.ok(text.includes("glm-5.3-flash"));
  assert.ok(text.includes("FREE $0.00"));
  assert.ok(text.includes("Balance: $0.4855"));
  assert.ok(text.includes("Try:"));
  assert.ok(text.includes("Explain quantum computing in simple terms"));
  assert.ok(text.includes("/model"));
  assert.ok(text.includes("/models"));
  assert.ok(text.includes("╭"), "info box has a round border");
});

test("welcomeLayout: small 40x15 — exact budget, plain card, no overflow", () => {
  const w = welcomeLayout({
    available: 11,
    contentWidth: 36,
    model: "glm-5.3-flash",
    free: true,
    priceText: null,
    balanceUsd: 0.4855,
  });
  assert.equal(w.rows.length, 11);
  const lines = w.rows.map((l) => l.segments.map((s) => s.text).join(""));
  const text = lines.join("\n");
  assert.ok(!text.includes("M   M"), "no ASCII banner rows on narrow terminals");
  assert.ok(text.includes("Pesan pertama memulai sesi."));
  assert.ok(text.includes("Try:"));
  for (const line of lines) {
    assert.ok(line.length <= 36, `welcome line overflows 36 cols: ${JSON.stringify(line)}`);
  }
});

test("welcomeLayout: starters disappear permanently after the first prompt", () => {
  const w = welcomeLayout({
    available: 21,
    contentWidth: 76,
    model: "glm-5.3-flash",
    free: true,
    priceText: null,
    balanceUsd: 0.4855,
    showStarters: false,
  });
  assert.equal(w.rows.length, 21);
  const text = w.rows.map((l) => l.segments.map((s) => s.text).join("")).join("\n");
  assert.ok(!text.includes("Try:"));
  assert.ok(!text.includes("Explain quantum computing"));
  assert.ok(text.includes("Pesan pertama memulai sesi."));
});

test("welcomeLayout: paid model shows price, unknown balance shows dash", () => {
  const w = welcomeLayout({
    available: 21,
    contentWidth: 76,
    model: "command-r-08-2024",
    free: false,
    priceText: "$0.25 / $1.00 per 1M",
    balanceUsd: null,
  });
  const text = w.rows.map((l) => l.segments.map((s) => s.text).join("")).join("\n");
  assert.ok(text.includes("command-r-08-2024"));
  assert.ok(text.includes("$0.25 / $1.00 per 1M"));
  assert.ok(text.includes("Balance: —"));
  assert.ok(!text.includes("FREE $0.00"));
});

test("welcomeLayout: bottom-anchored (Reza's order 2026-11-10, Freebuff chat.tsx:2273 flex-end)", () => {
  // Tall terminal: the slack sits ABOVE the welcome content and the
  // block is pinned right above the composer — never a void below the
  // hint row. Reversal of 0.1.9 §4o (top-anchored, slack below).
  const w = welcomeLayout({
    available: 36,
    contentWidth: 116,
    model: "glm-5.3-flash",
    free: true,
    priceText: null,
    balanceUsd: 0.4855,
  });
  assert.equal(w.rows.length, 36, "welcome must fill exactly the message budget");
  const lines = w.rows.map((l) => l.segments.map((s) => s.text).join(""));
  assert.ok(lines[0].trim() === "", "first row is blank slack above the content");
  assert.equal(lines.findIndex((l) => l.includes("╭")), 26, "info card top border sits at row 26 (36 - 10 content rows)");
  assert.ok(lines[lines.length - 1].includes("/models"), "last row is the hint row, pinned above the composer");
  assert.ok(lines.join("\n").includes("Pesan pertama memulai sesi."), "info box is the first content");
});

test("welcomeLayout: content fits the 80x24 message area (0.1.9 §4o, no banner)", () => {
  // With the 5-row centered composer the message area at 80x24 is
  // 16 rows (24 - 1 header - 5 input - 2 footer). The welcome content
  // is 10 rows (5 card + 1 Try + 3 starters + 1 hint), so the hint
  // row (Type /model ... /models ...) is never sliced off the bottom.
  const w = welcomeLayout({
    available: 16,
    contentWidth: 76,
    model: "glm-5.3-flash",
    free: true,
    priceText: null,
    balanceUsd: 0.4855,
  });
  assert.equal(w.rows.length, 16, "welcome must fill exactly the message budget");
  const text = w.rows.map((l) => l.segments.map((s) => s.text).join("")).join("\n");
  assert.ok(text.includes("/models"), "hint row with /models survives at 80x24");
  assert.ok(text.includes("Try:"), "starters label survives at 80x24");
  assert.ok(!text.includes("M   M"), "no ASCII banner rows");
});

test("headerLayout: persistent conversation header is the info card alone (Freebuff chat.tsx:2243)", () => {
  // Empty state: the card invites the first message.
  const empty = headerLayout({
    contentWidth: 76,
    model: "glm-5.3-flash",
    free: true,
    priceText: null,
    balanceUsd: 0.4855,
    hasMessages: false,
  });
  assert.equal(empty.length, 5, "header is exactly the 5-row info box");
  const emptyText = empty.map((l) => l.segments.map((s) => s.text).join("")).join("\n");
  assert.ok(emptyText.includes("Pesan pertama memulai sesi."));
  assert.ok(emptyText.includes("glm-5.3-flash"));
  assert.ok(emptyText.includes("Balance: $0.4855"));
  assert.ok(!emptyText.includes("M   M"), "no ASCII banner rows in the header");
  assert.ok(!emptyText.includes("EEEEE"), "no ASCII banner rows in the header");
  assert.ok(!emptyText.includes("Try:"), "starters are NOT part of the persistent header");
  // Conversation running: the session line switches to active
  // (Freebuff freebuff-chat-header.tsx conditional), the card stays.
  const running = headerLayout({
    contentWidth: 76,
    model: "glm-5.3-flash",
    free: true,
    priceText: null,
    balanceUsd: 0.4855,
    hasMessages: true,
  });
  assert.equal(running.length, 5, "header stays 5 rows once the conversation exists");
  const runningText = running.map((l) => l.segments.map((s) => s.text).join("")).join("\n");
  assert.ok(runningText.includes("Sesi aktif."));
  assert.ok(!runningText.includes("Pesan pertama memulai sesi."), "stale invite line must not linger above a running conversation");
  assert.ok(runningText.includes("glm-5.3-flash"));
});

test("composerIsCentered: Freebuff rest height (chat.tsx:2122-2123)", () => {
  assert.equal(composerIsCentered(1, false), true, "single-line draft, palette closed -> centered");
  assert.equal(composerIsCentered(0, false), true, "empty draft counts as single-line");
  assert.equal(composerIsCentered(2, false), false, "multiline draft hugs content");
  assert.equal(composerIsCentered(1, true), false, "palette open hugs content");
  assert.equal(COMPOSER_CENTERED_CONTENT_ROWS, 3, "centered content area is 3 rows");
  assert.equal(
    inputBoxRowsFor(COMPOSER_CENTERED_CONTENT_ROWS, 0),
    5,
    "bordered composer is 5 rows tall at rest (3 content + 2 borders)",
  );
});

test("welcomeLayout: tiny terminal degrades without breaking the budget", () => {
  for (const avail of [6, 3, 1, 0]) {
    const w = welcomeLayout({
      available: avail,
      contentWidth: 36,
      model: "glm-5.3-flash",
      free: true,
      priceText: null,
      balanceUsd: 0.4855,
    });
    assert.equal(w.rows.length, avail, `rows must equal available=${avail}`);
  }
  // Narrow-but-tall: the card still renders, no ASCII art anywhere.
  const narrow = welcomeLayout({
    available: 21,
    contentWidth: 44,
    model: "glm-5.3-flash",
    free: true,
    priceText: null,
    balanceUsd: 0.4855,
  });
  assert.equal(narrow.rows.length, 21);
  const narrowText = narrow.rows.map((l) => l.segments.map((s) => s.text).join("")).join("\n");
  assert.ok(!narrowText.includes("M   M"), "no ASCII banner rows on narrow terminals");
  assert.ok(narrowText.includes("Pesan pertama memulai sesi."));
});

test("easeOutCubic: Freebuff's scroll easing (0 -> 0, 1 -> 1, fast start)", () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.ok(easeOutCubic(0.5) > 0.5); // cubic ease-out covers most distance early
  assert.equal(SCROLL_ANIMATION_DURATION_MS, 200);
  assert.equal(SCROLL_ANIMATION_FRAME_MS, 16);
});

// 0.1.9 §4q: the scrollbar is removed (Reza's order) —
// scrollbarThumbRange is deleted with it, so its test goes too.
// The scroll FUNCTION (offset, wheel, PgUp/PgDn, auto-scroll,
// easeOutCubic) is untouched and covered by the scroll tests below
// and the PTY scenarios (s10/s28/s33).

// ---------------------------------------------------------------------------
// Horizontal gutter (0.1.8): Freebuff message-with-agents.tsx:105
// SIDE_GUTTER = 1 on top of the scroll container padding.
// ---------------------------------------------------------------------------

test("SIDE_GUTTER: 1 column, same as Freebuff message-with-agents.tsx:105", () => {
  assert.equal(SIDE_GUTTER, 1);
});

test("flattenMessages: every line starts with exactly the SIDE_GUTTER prefix", () => {
  const lines = flattenMessages(
    [
      { role: "user", content: "tampilkan ringkasan", kind: "chat", ts: Date.UTC(2026, 10, 9, 12, 0) },
      {
        role: "assistant",
        content: "# Ringkasan\nHasil *pemeriksaan* selesai.\n\n---\n| A | B |\n|---|---|\n| 1 | 2 |",
        kind: "chat",
      },
    ],
    40,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  // Assistant text, heading, divider, table — all start 1 space in;
  // the user line starts gutter + bar + space (3 spaces before You:).
  for (const t of texts) assert.ok(t.startsWith(" "), `line misses the gutter: ${JSON.stringify(t)}`);
  assert.ok(texts.some((t) => t.startsWith(" Ringkasan")), "heading starts after the gutter");
  assert.ok(texts.some((t) => t.startsWith(" ┌")), "table top border starts after the gutter");
  assert.ok(texts.some((t) => /^ ─+$/.test(t)), "divider starts after the gutter");
  assert.ok(texts.some((t) => t.startsWith("   You: ")), "user line is gutter + bar + space");
  assert.ok(texts.some((t) => t.startsWith("   [")), "timestamp is gutter + bar + space, like the You: line");
  // The gutter is a plain segment (no color), so it never changes the
  // palette — colors live on the content segments after it.
  assert.ok(lines.every((l) => l.segments[0].text === " " && l.segments[0].color === undefined));
});

test("flattenMessages: gutter never pushes a line past width + SIDE_GUTTER", () => {
  // Narrow terminal (40 cols): long words still wrap inside the text
  // width, so the visual line (gutter + text) never exceeds width + 1.
  const lines = flattenMessages(
    [{ role: "assistant", content: "kata yang sangat panjang sekali dan terus berlanjut", kind: "chat" }],
    20,
  );
  for (const l of lines) {
    const w = textWidth(l.segments.map((s) => s.text).join(""));
    assert.ok(w <= 20 + SIDE_GUTTER, `line overflows: ${w} > ${20 + SIDE_GUTTER}`);
  }
  // Tiny width: wrap still terminates, no empty-line blowup.
  const tiny = flattenMessages([{ role: "assistant", content: "abcdefghij", kind: "chat" }], 4);
  assert.ok(tiny.length > 0 && tiny.length < 10);
});

// ---------------------------------------------------------------------------
// Text rendering adoption (0.1.8): Freebuff markdown renderer, semantic
// colors, typography — cli/src/utils/markdown-renderer.tsx +
// theme-system.ts (dark theme palette).
// ---------------------------------------------------------------------------

test("textWidth: wide CJK/emoji chars count 2 cells, combining marks 0", () => {
  assert.equal(textWidth("abc"), 3);
  assert.equal(textWidth("你好"), 4);
  assert.equal(textWidth("a😀b"), 4);
  assert.equal(textWidth("é"), 1); // e + combining acute
  assert.equal(textWidth("✓"), 1);
});

test("wrapText: wide chars wrap at the right column, never split mid-char", () => {
  assert.deepEqual(wrapText("你好世界", 4), ["你好", "世界"]);
  assert.deepEqual(wrapText("ab你好cd", 4), ["ab你", "好cd"]);
});

test("renderInlineText: *italic* and _italic_ render ITALIC, **bold** stays bold", () => {
  const segs = renderInlineText("a *miring* b _juga_ c **tebal** d");
  const italic = segs.filter((s) => s.italic === true).map((s) => s.text);
  assert.deepEqual(italic, ["miring", "juga"]);
  const bold = segs.filter((s) => s.bold === true).map((s) => s.text);
  assert.deepEqual(bold, ["tebal"]);
  // Markers never leak into the visible text.
  assert.ok(!segs.some((s) => s.text.includes("*") || s.text.includes("_")));
});

test("renderInlineText: ~~strike~~ renders DIM (Freebuff delete case)", () => {
  const segs = renderInlineText("hapus ~~ini~~ saja");
  const dim = segs.filter((s) => s.dim === true).map((s) => s.text);
  assert.deepEqual(dim, ["ini"]);
});

test("renderInlineText: ***bold+italic*** is both, __bold__ is bold", () => {
  const both = renderInlineText("***keduanya***").find((s) => s.text === "keduanya");
  assert.equal(both.bold, true);
  assert.equal(both.italic, true);
  const under = renderInlineText("__garis__ bawah").find((s) => s.text === "garis");
  assert.equal(under.bold, true);
});

test("renderInlineText: intraword _ stays literal, * follows CommonMark (Freebuff parity)", () => {
  // Behaviour CHANGE from the old hand-rolled regex (docs §4h):
  // remark follows CommonMark — `_` between word characters can
  // never open emphasis, but `*` can, so a*b*c italicises the b
  // exactly like Freebuff renders it. `2*3` has no closing marker
  // and stays literal.
  const segs = renderInlineText("some_variable dan a*b*c dan 2*3");
  // Markers are consumed by the parse (the joined text has no
  // asterisks left around the b); the visible text is the input
  // minus its emphasis markers.
  assert.equal(segs.map((s) => s.text).join(""), "some_variable dan abc dan 2*3");
  assert.ok(!segs.some((s) => s.text.includes("_") && (s.italic === true || s.bold === true)));
  const italic = segs.filter((s) => s.italic === true).map((s) => s.text);
  assert.deepEqual(italic, ["b"]);
  assert.ok(segs.some((s) => s.text.includes("2*3")));
});

test("renderInlineText: inline code is orange bold on gray (Freebuff palette)", () => {
  const segs = renderInlineText("pakai `npm test` ya");
  const code = segs.find((s) => s.text === " npm test ");
  assert.ok(code, "code segment is space-padded");
  assert.equal(code.color, markdown.inlineCodeFg);
  assert.equal(code.backgroundColor, markdown.codeBackground);
  assert.equal(code.bold, true);
});

test("renderInlineText: Freebuff inline fallback parses Other**.github/**", () => {
  // remark leaves this as one literal text node (CommonMark rules);
  // Freebuff's parseInlineFallback splits it into bold (ported).
  const segs = renderInlineText("Other**.github/** end");
  const bold = segs.find((s) => s.text === ".github/");
  assert.ok(bold && bold.bold === true, "fallback bold span renders");
  assert.ok(!segs.some((s) => s.text.includes("**")));
});

test("renderInlineText: unclosed ** stays literal (streaming transient), closed renders bold", () => {
  const open = renderInlineText("ini **tebal belum tutup");
  assert.equal(open.map((s) => s.text).join(""), "ini **tebal belum tutup");
  assert.ok(!open.some((s) => s.bold === true));
  const closed = renderInlineText("ini **tebal** sudah");
  const bold = closed.find((s) => s.text === "tebal");
  assert.ok(bold && bold.bold === true);
  assert.ok(!closed.some((s) => s.text.includes("**")));
});

test("renderInlineText: escapes stay literal, autolink renders blue", () => {
  const esc = renderInlineText("bintang \\* literal dan \\`backtick\\`.");
  assert.equal(esc.map((s) => s.text).join(""), "bintang * literal dan `backtick`.");
  const auto = renderInlineText("Kunjungi https://example.com ya.");
  const link = auto.find((s) => s.text === "https://example.com");
  assert.ok(link && link.color === markdown.linkFg);
});

test("renderMarkdownText: heading parses inline code inside (Freebuff: heading span + inline nodes)", () => {
  const { lines } = renderMarkdownText("## Pakai `npm test` dulu", 40);
  const code = lines.flatMap((l) => l.segments).find((s) => s.text === " npm test ");
  assert.ok(code, "inline code inside a heading renders as code");
  assert.equal(code.color, markdown.inlineCodeFg);
  // Every heading segment is bold + yellow.
  assert.ok(lines.flatMap((l) => l.segments).every((s) => s.bold === true));
  assert.ok(lines.flatMap((l) => l.segments).every((s) => s.color === markdown.inlineCodeFg || s.color === markdown.headingFg));
});

test("renderMarkdownText: blockquote uses '> ' in border color (Freebuff renderBlockquote)", () => {
  const { lines } = renderMarkdownText("> catatan penting", 40);
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.deepEqual(texts, ["> catatan penting"]);
  assert.equal(lines[0].segments[0].text, "> ");
  assert.equal(lines[0].segments[0].color, markdown.blockquoteBorderFg);
  assert.equal(lines[0].segments[1].color, markdown.blockquoteTextFg);
});

test("renderMarkdownText: blockquote parses inline markdown inside", () => {
  const { lines } = renderMarkdownText("> baca **panduan** dulu", 40);
  const bold = lines.flatMap((l) => l.segments).find((s) => s.text === "panduan");
  assert.ok(bold && bold.bold === true);
});

test("renderMarkdownText: task list checkboxes + inline parsing in list items", () => {
  const { lines: done } = renderMarkdownText("- [x] tulis **tes** dulu", 40);
  const texts = done.map((l) => l.segments.map((s) => s.text).join(""));
  assert.deepEqual(texts, ["[x] tulis tes dulu"]);
  const bold = done.flatMap((l) => l.segments).find((s) => s.text === "tes");
  assert.ok(bold && bold.bold === true);
  const { lines: todo } = renderMarkdownText("- [ ] belum dikerjakan", 40);
  assert.equal(todo.map((l) => l.segments.map((s) => s.text).join(""))[0], "[ ] belum dikerjakan");
});

test("renderMarkdownText: nested lists indent under their parent item", () => {
  const { lines } = renderMarkdownText("- induk\n  - anak satu\n  - anak dua\n- induk dua", 40);
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.deepEqual(texts, ["- induk", "  - anak satu", "  - anak dua", "- induk dua"]);
});

test("renderMarkdownText: ordered list numbers from its start", () => {
  const { lines } = renderMarkdownText("3. ketiga\n4. keempat", 40);
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.deepEqual(texts, ["3. ketiga", "4. keempat"]);
});

test("renderMarkdownText: divider is capped at 80 (Freebuff thematicBreak)", () => {
  const { lines } = renderMarkdownText("---", 120);
  const text = lines[0].segments.map((s) => s.text).join("");
  assert.equal(text.length, 80);
  assert.ok(/^─+$/.test(text));
});

// §4h — the leak that motivated this whole task (docs §4g): the old
// wrap-first renderer leaked raw ~~ markers whenever the wrap fell
// inside a span, at widths 34, 35 and 36. Parse-first must not leak
// at ANY width.
test("renderMarkdownText: no raw ~~ markers leak at widths 34, 35, 36 (§4g regression)", () => {
  for (const w of [34, 35, 36, 40, 80]) {
    const { lines } = renderMarkdownText("Hasil pemeriksaan dan ~~yang lama~~ sudah diperbarui.", w);
    const joined = lines.map((l) => l.segments.map((s) => s.text).join("")).join("\n");
    assert.ok(!joined.includes("~~"), `width ${w}: no raw ~~ in ${JSON.stringify(joined)}`);
    assert.ok(joined.includes("yang lama"), `width ${w}: struck text survives`);
    const dim = lines.flatMap((l) => l.segments).filter((s) => s.dim === true).map((s) => s.text);
    assert.ok(dim.join("").includes("yang lama"), `width ${w}: strike renders DIM`);
  }
});

test("renderMarkdownText: no raw ** markers leak when a bold span wraps", () => {
  for (const w of [20, 25, 30, 34, 40]) {
    const { lines } = renderMarkdownText("Periksa **panduan instalasi lengkap** sebelum lanjut.", w);
    const joined = lines.map((l) => l.segments.map((s) => s.text).join("")).join("\n");
    assert.ok(!joined.includes("**"), `width ${w}: no raw ** in ${JSON.stringify(joined)}`);
  }
});

test("renderMarkdownText: no raw `code` markers leak when inline code wraps", () => {
  for (const w of [20, 24, 30, 40]) {
    const { lines } = renderMarkdownText("Jalankan `npm run build --workspace api` dulu.", w);
    const joined = lines.map((l) => l.segments.map((s) => s.text).join("")).join("\n");
    assert.ok(!joined.includes("`"), `width ${w}: no raw backtick in ${JSON.stringify(joined)}`);
  }
});

test("wrapSegments: over-long word hard-splits by cells, styles survive", () => {
  const lines = wrapSegments([{ text: "abcdefghij", bold: true }], 4);
  assert.deepEqual(
    lines.map((l) => l.segments.map((s) => s.text).join("")),
    ["abcd", "efgh", "ij"],
  );
  assert.ok(lines.every((l) => l.segments.every((s) => s.bold === true)));
});

test("wrapSegments: first/cont prefixes come out of the line budget", () => {
  const lines = wrapSegments([{ text: "satu dua tiga empat" }], 10, {
    firstPrefix: [{ text: "- " }],
    contPrefix: [{ text: "  " }],
  });
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.deepEqual(texts, ["- satu dua", "  tiga", "  empat"]);
});

test("tableLines: box-drawing table, header bold yellow, borders divider color", () => {
  const lines = tableLines(["| Model | Harga |", "|---|---|", "| glm | $0.00 |", "| qwen | $0.10 |"], 40);
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.deepEqual(texts, [
    "┌───────┬───────┐",
    "│ Model │ Harga │",
    "├───────┼───────┤",
    "│ glm   │ $0.00 │",
    "│ qwen  │ $0.10 │",
    "└───────┴───────┘",
  ]);
  // Header cells bold + heading color.
  const headerSeg = lines[1].segments.find((s) => s.text === "Model");
  assert.equal(headerSeg.bold, true);
  assert.equal(headerSeg.color, markdown.headingFg);
  // Border lines in divider color.
  assert.equal(lines[0].segments[0].color, markdown.dividerFg);
});

test("tableLines: long cells wrap and shrink to fit the terminal width", () => {
  const lines = tableLines(
    ["| A | B |", "|---|---|", "| kata yang sangat panjang sekali | pendek |"],
    30,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  for (const t of texts) assert.ok(textWidth(t) <= 30, `row fits: ${t}`);
  assert.ok(texts.some((t) => t.includes("kata yang")));
  assert.ok(texts.some((t) => t.includes("panjang sekali")));
});

test("tableLines: right-aligned column pads on the left", () => {
  const lines = tableLines(["| Item | Harga |", "|---|---:|", "| a | $1 |"], 30);
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.ok(texts.some((t) => t.includes("│    $1 │")), `right-aligned: ${JSON.stringify(texts)}`);
});

test("flattenMessages: no blank line between a paragraph and a following list (Freebuff tight followup)", () => {
  const lines = flattenMessages(
    [{ role: "assistant", content: "Langkahnya:\n- satu\n- dua", kind: "chat" }],
    40,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.deepEqual(texts, [" Langkahnya:", " - satu", " - dua", "  "]);
});

test("flattenMessages: no blank line before a blockquote or a heading either", () => {
  const lines = flattenMessages(
    [{ role: "assistant", content: "Catatan:\n> hati-hati\n\nJudul berikut:\n## Bagian", kind: "chat" }],
    40,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.deepEqual(texts, [" Catatan:", " > hati-hati", "  ", " Judul berikut:", " Bagian", "  "]);
});

test("flattenMessages: paragraph-to-paragraph keeps exactly one blank line", () => {
  const lines = flattenMessages(
    [{ role: "assistant", content: "Paragraf satu.\n\nParagraf dua.", kind: "chat" }],
    40,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.deepEqual(texts, [" Paragraf satu.", "  ", " Paragraf dua.", "  "]);
});

test("flattenMessages: a table renders inline, tight after its intro line", () => {
  const lines = flattenMessages(
    [{ role: "assistant", content: "Perbandingan:\n| A | B |\n|---|---|\n| 1 | 2 |", kind: "chat" }],
    40,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.deepEqual(texts, [" Perbandingan:", " ┌───┬───┐", " │ A │ B │", " ├───┼───┤", " │ 1 │ 2 │", " └───┴───┘", "  "]);
});

test("flattenMessages: long shell preview word-wraps, never splits mid-word", () => {
  const lines = flattenMessages(
    [
      {
        role: "assistant",
        content: "",
        kind: "chat",
        blocks: [
          {
            type: "tool",
            name: "run_terminal_command",
            preview: "$ touch agent-ran.txt && echo line1 && echo line2 && echo line3 && echo line4 && echo hello-agent",
            shell: true,
            results: [],
            done: true,
          },
        ],
      },
    ],
    40,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.deepEqual(texts, [
    " $ touch agent-ran.txt && echo line1 &&",
    "   echo line2 && echo line3 && echo line4",
    "   && echo hello-agent",
    "  ",
  ]);
  // The "$ " prefix is green + bold on the first line only.
  const dollar = lines.flatMap((l) => l.segments).find((s) => s.text === "$ ");
  assert.equal(dollar.color, theme.success);
  assert.equal(dollar.bold, true);
});

test("flattenMessages: structured tool message — shell preview $ green + bold, ✓ green / ✗ red", () => {
  const lines = flattenMessages(
    [
      {
        role: "assistant",
        content: "",
        kind: "chat",
        blocks: [
          {
            type: "tool",
            name: "run_terminal_command",
            preview: "$ ls -la",
            shell: true,
            results: [
              { ok: true, text: "README.md" },
              { ok: false, text: "permission denied" },
            ],
            done: true,
          },
        ],
      },
    ],
    40,
  );
  const segs = lines.flatMap((l) => l.segments);
  const dollar = segs.find((s) => s.text === "$ ");
  assert.ok(dollar, "$ prefix renders");
  assert.equal(dollar.color, theme.success);
  assert.equal(dollar.bold, true);
  const cmd = segs.find((s) => s.text === "ls -la");
  assert.equal(cmd.bold, true);
  const ok = segs.find((s) => s.text === "✓ ");
  assert.equal(ok.color, theme.success);
  const bad = segs.find((s) => s.text === "✗ ");
  assert.equal(bad.color, theme.error);
  const badText = segs.find((s) => s.text === "permission denied");
  assert.equal(badText.color, theme.error);
  // No raw markers or duplicated prefixes in the visible text.
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.deepEqual(texts, [" $ ls -la", "   ✓ README.md", "   ✗ permission denied", "  "]);
});

test("flattenMessages: structured non-shell tool preview is bold foreground", () => {
  const lines = flattenMessages(
    [
      {
        role: "assistant",
        content: "",
        kind: "chat",
        blocks: [
          {
            type: "tool",
            name: "read_files",
            preview: "Read README.md",
            shell: false,
            results: [{ ok: true, text: "120 lines" }],
            done: true,
          },
        ],
      },
    ],
    40,
  );
  const preview = lines.flatMap((l) => l.segments).find((s) => s.text === "Read README.md");
  assert.equal(preview.bold, true);
  assert.equal(preview.color, theme.text);
});

test("flattenMessages: user message parses inline markdown (Freebuff user markdown)", () => {
  const lines = flattenMessages(
    [{ role: "user", content: "cek **README.md** dan `package.json`", kind: "chat" }],
    40,
  );
  const bold = lines.flatMap((l) => l.segments).find((s) => s.text === "README.md");
  assert.ok(bold && bold.bold === true && bold.italic === true, "user bold stays italic too");
  const code = lines.flatMap((l) => l.segments).find((s) => s.text === " package.json ");
  assert.ok(code, "user inline code renders");
  assert.equal(code.italic, true);
  const label = lines.flatMap((l) => l.segments).find((s) => s.text === "You: ");
  assert.equal(label.italic, undefined, "the You: label itself is not italic");
});

test("flattenMessages: ANSI escapes in model text never reach the terminal", () => {
  const lines = flattenMessages(
    [
      {
        role: "assistant",
        content: "hasilnya \x1b[31mmerah\x1b[0m dan \x1b]8;;https://evil.example\x1b\\tautan\x1b]8;;\x1b\\ palsu",
        kind: "chat",
      },
    ],
    60,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.deepEqual(texts, [" hasilnya merah dan tautan palsu", "  "]);
  assert.ok(!texts.join("").includes("\x1b"), "no escape byte survives");
});

test("flattenMessages: ANSI escapes in tool output never reach the terminal", () => {
  const lines = flattenMessages(
    [
      {
        role: "assistant",
        content: "",
        kind: "chat",
        blocks: [
          {
            type: "tool",
            name: "run_terminal_command",
            preview: "$ cat file",
            shell: true,
            results: [{ ok: true, text: "clean\x1b[31mred\x1b[0m text" }],
            done: true,
          },
        ],
      },
    ],
    40,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.deepEqual(texts, [" $ cat file", "   ✓ cleanred text", "  "]);
});

test("flattenMessages: one blank line between intro text and a following code block", () => {
  const lines = flattenMessages(
    [{ role: "assistant", content: "Contohnya:\n```js\nconst a = 1;\n```", kind: "chat" }],
    40,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.deepEqual(texts, [" Contohnya:", "  ", " // js", " const a = 1;", "  "]);
});

test("splitMessageParts: unclosed fence is a code part (Freebuff pending fence renders raw)", () => {
  const parts = splitMessageParts("Intro **tebal**\n```js\nconst a = 1;\n// **bukan bold**");
  assert.equal(parts.length, 2);
  assert.equal(parts[0].type, "text");
  assert.equal(parts[1].type, "code");
  assert.equal(parts[1].lang, "js");
  assert.ok(parts[1].content.includes("// **bukan bold**"));
  // And the fence content is never markdown-parsed by the layout.
  const lines = flattenMessages(
    [{ role: "assistant", content: "Intro **tebal**\n```js\nconst a = 1;\n// **bukan bold**", kind: "chat" }],
    40,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.ok(texts.includes(" // js"), "pending fence shows its // lang header");
  assert.ok(!lines.flatMap((l) => l.segments).some((s) => s.text === "bukan bold" && s.bold === true));
});
