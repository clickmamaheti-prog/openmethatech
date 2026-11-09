// Unit tests for the full-screen layout logic (src/ui/layout.ts).
// Run after build: npm run build && npm test
import test from "node:test";
import assert from "node:assert/strict";
import {
  bannerLines,
  breakpoints,
  wrapText,
  wrapLineCount,
  flattenMessages,
  inputBoxRowsFor,
  layoutBudget,
  pickerHint,
  paletteHint,
  pickerMaxRowsFor,
  pickerRenderedRows,
  paletteMaxRowsFor,
  paletteRenderedRows,
  welcomeLayout,
  windowLines,
  pageScrollOffset,
  easeOutCubic,
  scrollbarThumbRange,
  SCROLL_ANIMATION_DURATION_MS,
  SCROLL_ANIMATION_FRAME_MS,
} from "../dist/ui/layout.js";
import { theme } from "../dist/theme.js";

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
  // User lines carry the 1-column SOLID left border (Freebuff user
  // line): a colored space + 1 gutter space, not a "│" glyph.
  assert.deepEqual(texts, ["sys msg", " ", "  You: hi", " ", "hello there", " "]);
  // Border segment first (solid bar, userLine bg), then gutter space,
  // then the "You: " label with its own color.
  assert.equal(lines[2].segments[0].text, " ");
  assert.equal(lines[2].segments[0].backgroundColor, theme.userLine);
  assert.equal(lines[2].segments[1].text, " ");
  assert.equal(lines[2].segments[2].text, "You: ");
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
    "New conversation started (session: 2026-11-08T21-00-00.000Z).",
    "Model set to glm-5.3-flash · FREE $0.00 · Balance $0.0000.",
    " ",
  ]);
  assert.equal(lines[0].segments[0].color, theme.muted);
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
  assert.ok(texts[0].match(/^\[\d\d:\d\d\]$/), `timestamp line: ${texts[0]}`);
  assert.ok(texts.includes("  You: hi"));
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

test("flattenMessages: code block is Freebuff monochrome on gray + // lang header", () => {
  const lines = flattenMessages(
    [{ role: "assistant", content: "```js\nconst x = 1;\n```", kind: "chat" }],
    40,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.equal(texts[0], "// js");
  assert.ok(texts[1].includes("const"));
  // Body: one color, one background, no per-token colors.
  assert.ok(lines[1].segments.every((s) => s.color === "#f1f5f9"));
  assert.ok(lines[1].segments.every((s) => s.backgroundColor === "#374151"));
});

test("flattenMessages: to-do list renders Freebuff-style (header, boxes, strikethrough)", () => {
  const lines = flattenMessages(
    [
      {
        role: "assistant",
        content: "",
        kind: "todos",
        todos: [
          { task: "Baca hello.txt", completed: true },
          { task: "Jalankan perintah", completed: false },
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
    [{ role: "assistant", content: "", kind: "todos", todos: [] }],
    40,
  );
  // Only the trailing blank line from the message separator.
  assert.ok(lines.every((l) => l.segments.every((s) => s.text.trim() === "")));
});

test("flattenMessages: assistant block has NO timestamp (Freebuff message-block)", () => {
  const lines = flattenMessages(
    [{ role: "assistant", content: "answer", kind: "chat", ts: Date.UTC(2026, 10, 8, 12, 35) }],
    40,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.ok(!texts.some((t) => /^\[\d\d:\d\d\]$/.test(t)), "no timestamp line on the assistant block");
  assert.ok(!texts.some((t) => t.includes("Muse:")), "no Muse: label on the assistant block (Freebuff shows the answer directly)");
  assert.equal(texts[0], "answer");
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
  assert.ok(texts.some((t) => t.startsWith("  ...")), "cut-off preview is prefixed ...");
  assert.ok(!texts.some((t) => t.includes("reasoning line 1")), "first lines are cut from the preview");
  assert.ok(!texts.includes("Muse:"), "no Muse: label before the answer");
  assert.ok(texts.includes("answer"));
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
  assert.equal(texts[3], "answer");
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
  assert.ok(texts.includes("answer"));
});

test("flattenMessages: code block keeps lang line + token colors", () => {
  const lines = flattenMessages(
    [{ role: "assistant", content: "```js\nconst x = 1;\n```", kind: "chat" }],
    40,
  );
  const texts = lines.map((l) => l.segments.map((s) => s.text).join(""));
  assert.equal(texts[0], "// js");
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

test("bannerLines: MethaTech wordmark, 5 rows, uniform width", () => {
  const rows = bannerLines("MethaTech");
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.length === 53), `banner rows must be 53 wide, got ${rows.map((r) => r.length)}`);
  assert.ok(rows[0].includes("M   M"));
  assert.ok(rows[2].includes("HHHHH"));
});

test("welcomeLayout: desktop 80x24 — exact budget, banner, content", () => {
  const w = welcomeLayout({
    available: 21,
    contentWidth: 76,
    model: "glm-5.3-flash",
    free: true,
    priceText: null,
    balanceUsd: 0.4855,
  });
  assert.equal(w.rows.length, 21, "welcome must fill exactly the message budget");
  assert.equal(w.banner, true);
  const text = w.rows.map((l) => l.segments.map((s) => s.text).join("")).join("\n");
  assert.ok(text.includes("M   M"), "block wordmark renders");
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

test("welcomeLayout: small 40x15 — exact budget, plain wordmark, no overflow", () => {
  const w = welcomeLayout({
    available: 11,
    contentWidth: 36,
    model: "glm-5.3-flash",
    free: true,
    priceText: null,
    balanceUsd: 0.4855,
  });
  assert.equal(w.rows.length, 11);
  assert.equal(w.banner, false);
  const lines = w.rows.map((l) => l.segments.map((s) => s.text).join(""));
  const text = lines.join("\n");
  assert.ok(text.includes("MethaTech"));
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
  // Narrow-but-tall: banner does not fit, plain wordmark is used.
  const narrow = welcomeLayout({
    available: 21,
    contentWidth: 44,
    model: "glm-5.3-flash",
    free: true,
    priceText: null,
    balanceUsd: 0.4855,
  });
  assert.equal(narrow.banner, false);
  assert.equal(narrow.rows.length, 21);
});

test("easeOutCubic: Freebuff's scroll easing (0 -> 0, 1 -> 1, fast start)", () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.ok(easeOutCubic(0.5) > 0.5); // cubic ease-out covers most distance early
  assert.equal(SCROLL_ANIMATION_DURATION_MS, 200);
  assert.equal(SCROLL_ANIMATION_FRAME_MS, 16);
});

test("scrollbarThumbRange: proportional thumb, at least one row, empty without overflow", () => {
  assert.deepEqual(scrollbarThumbRange(5, 10, 0, 5), { start: 0, end: 0 }); // fits
  const top = scrollbarThumbRange(100, 10, 0, 10);
  assert.equal(top.start, 0);
  assert.ok(top.end >= 1);
  const mid = scrollbarThumbRange(100, 10, 45, 55);
  assert.ok(mid.start > 0 && mid.end > mid.start);
  const bottom = scrollbarThumbRange(100, 10, 90, 100);
  assert.equal(bottom.end, 10);
  assert.ok(bottom.start < bottom.end);
});
