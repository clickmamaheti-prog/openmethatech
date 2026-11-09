// Full-screen layout logic — pure, no Ink/React. Unit-testable in
// isolation. The ChatApp component only renders what these functions
// return; all row budgeting, text wrapping, message flattening and
// history windowing live here.
//
// Freebuff pattern adapted (not copied): root flex column with a
// flexGrow scroll area + messages pinned to the bottom
// (freebuff-source/cli/src/chat.tsx: root box flexGrow 1, scrollbox
// flexGrow 1, content justifyContent flex-end), page scroll of 0.8
// viewport + "at bottom" threshold of 1 line
// (cli/src/hooks/use-scroll-management.ts: PAGE_SCROLL_FRACTION 0.8,
// SCROLL_NEAR_BOTTOM_THRESHOLD 1). Ink has no scrollbox, so the
// windowing is done manually here, in visual lines.

import { splitMessageParts } from "./syntax.js";
import { markdown, theme } from "../theme.js";

/** Input placeholder (Freebuff chat-input-bar.tsx: "Enter a coding task
    or / for commands"). Shown dimmed inside the bordered input box
    while the draft is empty. */
export const INPUT_PLACEHOLDER = "Enter a coding task or / for commands";

/**
 * Rows the bordered input box occupies (Freebuff chat-input-bar.tsx:
 * the input is a single rounded-border box; the suggestion menu renders
 * INSIDE the box above the input, one gap row between menu and input).
 * 2 = top + bottom border; inputContentRows = wrapped input/placeholder
 * rows; paletteRowsInside = menu rows + 1 gap row (0 when closed).
 */
export function inputBoxRowsFor(inputContentRows: number, paletteRowsInside: number): number {
  return 2 + inputContentRows + paletteRowsInside;
}
import { groupCatalog, visibleWindow } from "./picker.js";
import { suggestionWindow } from "./suggestions.js";
import { thinkingPreview } from "./thinking.js";
import type { Catalog } from "../models.js";

/** Width breakpoints, Freebuff-style (cli/src/chat.tsx breakpoints). */
export type WidthBreakpoint = "xs" | "sm" | "md" | "lg";
/** Height breakpoints. */
export type HeightBreakpoint = "xs" | "sm" | "md";

/**
 * Terminal size class. Width: xs < 50, sm 50-100, md 100-150, lg > 150.
 * Height: xs < 20, sm 20-40, md > 40.
 */
export function breakpoints(
  columns: number,
  rows: number,
): { width: WidthBreakpoint; height: HeightBreakpoint } {
  const width: WidthBreakpoint = columns < 50 ? "xs" : columns < 100 ? "sm" : columns <= 150 ? "md" : "lg";
  const height: HeightBreakpoint = rows < 20 ? "xs" : rows <= 40 ? "sm" : "md";
  return { width, height };
}

/**
 * Greedy word wrap of one string to at most `width` columns per line.
 * Newlines in the input start a new visual line; empty lines stay empty.
 * Words longer than `width` are hard-split. Multiple spaces collapse to
 * one (chat text; code lines are wrapped by splitSegments instead).
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [""];
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of raw.split(" ")) {
      if (word === "") continue;
      // Hard-split an over-long word into width-sized chunks.
      let rest = word;
      while (rest.length > width) {
        if (line !== "") {
          out.push(line);
          line = "";
        }
        out.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      if (line === "") line = rest;
      else if (line.length + 1 + rest.length <= width) line += " " + rest;
      else {
        out.push(line);
        line = rest;
      }
    }
    out.push(line);
  }
  return out;
}

/** How many visual lines `text` occupies at `width` columns. */
export function wrapLineCount(text: string, width: number): number {
  return wrapText(text, width).length;
}

/** One colored run inside a visual line. Colors are theme tokens. */
export interface VisualSegment {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  backgroundColor?: string;
}

/** One pre-wrapped visual line: renders as exactly one Ink <Text> row. */
export interface VisualLine {
  segments: VisualSegment[];
}

/** Plain-text visual line. */
export function plainLine(text: string, color?: string, bold?: boolean): VisualLine {
  return { segments: [{ text, color, bold }] };
}

/** Blank visual line (renders as one empty row). */
export function blankLine(): VisualLine {
  return { segments: [{ text: " " }] };
}

/**
 * Split pre-tokenized segments into chunks of at most `width` columns,
 * keeping each chunk's colors. Used for code lines, which must not go
 * through word wrap (indentation and tokens must survive).
 */
export function splitSegments(segments: VisualSegment[], width: number): VisualLine[] {
  if (width <= 0) return [{ segments }];
  const lines: VisualLine[] = [];
  let cur: VisualSegment[] = [];
  let curLen = 0;
  const flush = () => {
    lines.push({ segments: cur.length > 0 ? cur : [{ text: " " }] });
    cur = [];
    curLen = 0;
  };
  for (const seg of segments) {
    let rest = seg.text;
    while (rest.length > 0) {
      const room = width - curLen;
      if (room <= 0) {
        flush();
        continue;
      }
      const take = rest.slice(0, room);
      cur.push({ ...seg, text: take });
      curLen += take.length;
      rest = rest.slice(take.length);
      if (rest.length > 0) flush();
    }
  }
  flush();
  return lines;
}

/** Minimal message shape the layout needs (mirrors ChatApp's messages). */
export interface LayoutMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  kind: "chat" | "system" | "tool" | "todos";
  /** Epoch ms the message was created (renders as [HH:MM] above it). */
  ts?: number;
  /** Reasoning text received before the answer (delta.reasoning_content). */
  thinking?: string;
  /** True once the stream that produced the reasoning finished. */
  thinkingComplete?: boolean;
  /** To-do list for kind "todos" (Freebuff shape: {task, completed}). */
  todos?: { task: string; completed: boolean }[];
}

/** Format an epoch-ms timestamp as [HH:MM] (local time). */
export function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `[${hh}:${mm}]`;
}

/**
 * Inline Markdown for one wrapped line. Freebuff
 * cli/src/utils/markdown-renderer.tsx (dark theme palette from
 * theme-system.ts): **bold** = bold only; `code` = BOLD with a space
 * pad on each side, fg inlineCodeFg (#FF8534) on bg codeBackground
 * (#374151); [text](url) = fg linkFg (#3B82F6). Markers never span
 * lines (lines are wrapped first, then parsed).
 */
export function inlineSegments(line: string, baseColor?: string): VisualSegment[] {
  const segments: VisualSegment[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (
    text: string,
    color?: string,
    bold?: boolean,
    backgroundColor?: string,
  ) => {
    if (text.length === 0) return;
    segments.push({ text, color, bold, backgroundColor });
  };
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) push(line.slice(last, m.index), baseColor);
    const token = m[0];
    if (token.startsWith("**")) {
      push(token.slice(2, -2), baseColor, true);
    } else if (token.startsWith("`")) {
      // Freebuff: <span fg={inlineCodeFg} bg={codeBackground} BOLD>
      // with a space pad: ` ${content} `.
      push(` ${token.slice(1, -1)} `, markdown.inlineCodeFg, true, markdown.codeBackground);
    } else {
      // [text](url): the link text renders in link blue; the URL is
      // not shown (Freebuff renders the anchor text only).
      push(token.slice(1, token.indexOf("]")), markdown.linkFg);
    }
    last = m.index + token.length;
  }
  if (last < line.length) push(line.slice(last), baseColor);
  if (segments.length === 0) segments.push({ text: line, color: baseColor });
  return segments;
}

/**
 * One raw (unwrapped) text line as visual lines, handling the
 * line-level Markdown Freebuff renders: headings (#..######),
 * blockquotes (>), list bullets (- * + and N.), horizontal rules.
 * Everything else falls back to inlineSegments.
 */
export function markdownLines(rawLine: string, width: number): VisualLine[] {
  const out: VisualLine[] = [];
  const heading = /^(#{1,6})\s+(.*)$/.exec(rawLine);
  if (heading) {
    // Freebuff: headingFg #facc15 (yellow) + bold, every level.
    for (const w of wrapText(heading[2], width)) {
      out.push({ segments: [{ text: w, color: markdown.headingFg, bold: true }] });
    }
    return out;
  }
  const bq = /^>\s?(.*)$/.exec(rawLine);
  if (bq) {
    const inner = Math.max(1, width - 2);
    for (const w of wrapText(bq[1], inner)) {
      out.push({
        segments: [
          { text: "▎ ", color: markdown.blockquoteBorderFg },
          { text: w, color: markdown.blockquoteTextFg },
        ],
      });
    }
    return out;
  }
  const list = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(rawLine);
  if (list) {
    const indent = list[1];
    const marker = list[2];
    const prefix = `${indent}${marker} `;
    const cont = `${indent}${" ".repeat(marker.length + 1)}`;
    const inner = Math.max(1, width - prefix.length);
    const wrapped = wrapText(list[3], inner);
    wrapped.forEach((w, i) => {
      if (i === 0) {
        out.push({
          segments: [
            { text: indent },
            { text: marker, color: markdown.listBulletFg },
            { text: " " },
            { text: w, color: theme.text },
          ],
        });
      } else {
        out.push({ segments: [{ text: cont }, { text: w, color: theme.text }] });
      }
    });
    return out;
  }
  if (/^(---|\*\*\*|___)\s*$/.test(rawLine)) {
    out.push({ segments: [{ text: "─".repeat(Math.max(1, width)), color: markdown.dividerFg }] });
    return out;
  }
  for (const w of wrapText(rawLine, width)) out.push({ segments: inlineSegments(w, theme.text) });
  return out;
}

/**
 * Flatten messages into exact visual lines at `width` columns, in
 * display order. Every returned line is already wrapped, so rendering
 * one line per Ink row never re-wraps and the budget math stays exact.
 * Each message is followed by one blank line (its marginBottom —
 * Freebuff message-with-agents.tsx: paddingBottom 1 except the last).
 * User messages carry a 1-column solid left border (backgroundColor
 * theme.userLine + 1 gutter space, Freebuff message-with-agents.tsx)
 * and a muted [HH:MM] timestamp above the content; AI messages have
 * no border line and no timestamp. Assistant text keeps **bold** /
 * `code` inline Markdown (Freebuff palette: inline code orange on
 * dark gray, headings yellow, links blue); code blocks are Freebuff
 * monochrome on a dark-gray background with a "// lang" header.
 */
export function flattenMessages(
  messages: LayoutMessage[],
  width: number,
  opts: { thinkingExpanded?: boolean } = {},
): VisualLine[] {
  const lines: VisualLine[] = [];
  // Freebuff message-with-agents.tsx: the user block has a 1-wide
  // SOLID line column (backgroundColor) + 1 gutter space, not a "│"
  // glyph. The bar is a colored space, so the message text still
  // starts at column 2.
  const borderSegs: VisualSegment[] = [
    { text: " ", backgroundColor: theme.userLine },
    { text: " " },
  ];
  for (const m of messages) {
    const tsLine = m.ts !== undefined ? plainLine(formatTimestamp(m.ts), theme.muted) : null;
    if (m.kind === "tool") {
      // Agent tool call: preview line in neon, result lines muted.
      // Content is preformatted by the agent loop (preview + summary).
      const wrapped = wrapText(m.content, width);
      wrapped.forEach((w, i) => {
        lines.push(plainLine(w, i === 0 ? theme.accentSecondary : theme.muted));
      });
    } else if (m.kind === "todos") {
      // Freebuff cli/src/components/tools/write-todos.tsx: header
      // "• TODOs" (bullet + BOLD "TODOs", foreground); items indented
      // 2 spaces; completed = "✓ " in success + task in muted +
      // strikethrough; pending = "☐ " in foreground + task in
      // foreground. An empty list renders nothing.
      const todos = m.todos ?? [];
      if (todos.length > 0) {
        lines.push({
          segments: [
            { text: "• ", color: theme.text },
            { text: "TODOs", color: theme.text, bold: true },
          ],
        });
        for (const t of todos) {
          const wrapped = wrapText(t.task, Math.max(1, width - 4));
          wrapped.forEach((w, i) => {
            if (i === 0) {
              lines.push({
                segments: [
                  { text: "  " },
                  t.completed
                    ? { text: "✓ ", color: theme.success }
                    : { text: "☐ ", color: theme.text },
                  {
                    text: w,
                    color: t.completed ? theme.muted : theme.text,
                    strikethrough: t.completed === true,
                  },
                ],
              });
            } else {
              lines.push({
                segments: [
                  { text: "    " },
                  {
                    text: w,
                    color: t.completed ? theme.muted : theme.text,
                    strikethrough: t.completed === true,
                  },
                ],
              });
            }
          });
        }
      }
    } else if (m.kind === "system") {
      for (const w of wrapText(m.content, width)) lines.push(plainLine(w, theme.muted));
    } else if (m.role === "user") {
      // Freebuff single-block.tsx:102 — the whole user text block is
      // ITALIC (attributes={isUser ? ITALIC : undefined}). The "You: "
      // label stays bold non-italic; the message content is italic.
      if (tsLine) lines.push(tsLine);
      const inner = Math.max(1, width - 2);
      const wrapped = wrapText(`You: ${m.content}`, inner);
      wrapped.forEach((w, i) => {
        if (i === 0) {
          lines.push({
            segments: [
              ...borderSegs,
              { text: "You: ", color: theme.userLabel, bold: true },
              { text: w.slice(5), color: theme.text, italic: true },
            ],
          });
        } else {
          lines.push({ segments: [...borderSegs, { text: w, color: theme.text, italic: true }] });
        }
      });
    } else {
      // Freebuff message-block.tsx: the assistant block carries NO
      // timestamp (timestamps are a user-line thing). The thinking
      // block (reasoning) goes above the answer when present.
      // thinking.tsx): preview = last 5 visual lines, italic muted,
      // "..." prefix when cut; expanded = full reasoning. A lone
      // **bold** title renders nothing. Ctrl+T toggles all blocks.
      if (m.thinking !== undefined && m.thinking.length > 0) {
        const preview = thinkingPreview(
          m.thinking,
          width,
          opts.thinkingExpanded === true ? "expanded" : "preview",
          m.thinkingComplete === true,
        );
        if (preview.visible) {
          lines.push({
            segments: [
              { text: `${preview.toggle}Thinking`, color: theme.text, bold: true },
            ],
          });
          if (opts.thinkingExpanded === true) {
            for (const w of wrapText(m.thinking.replace(/\n\n+/g, "\n\n").trim(), Math.max(1, width - 2))) {
              lines.push({ segments: [{ text: `  ${w}`, color: theme.muted, italic: true }] });
            }
          } else {
            for (const w of preview.lines) {
              lines.push({
                segments: [
                  { text: `  ${(preview.hasMore && w === preview.lines[0] ? "..." : "") + w}`, color: theme.muted, italic: true },
                ],
              });
            }
          }
        }
      }
      for (const part of splitMessageParts(m.content)) {
        if (part.type === "code") {
          // Freebuff markdown-renderer.tsx: code blocks are MONOCHROME
          // (no per-token colors) — header "// lang" in codeHeaderFg,
          // body lines in codeTextFg on codeBackground.
          if (part.lang) lines.push(plainLine(`// ${part.lang}`, markdown.codeHeaderFg));
          const rawLines = part.content.split("\n");
          if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
          for (const raw of rawLines) {
            const segs: VisualSegment[] = [
              {
                text: raw === "" ? " " : raw,
                color: markdown.codeTextFg,
                backgroundColor: markdown.codeBackground,
              },
            ];
            for (const l of splitSegments(segs, width)) lines.push(l);
          }
        } else {
          for (const rawLine of part.content.split("\n")) {
            if (rawLine === "") {
              lines.push(blankLine());
              continue;
            }
            for (const l of markdownLines(rawLine, width)) lines.push(l);
          }
        }
      }
    }
    lines.push(blankLine());
  }
  return lines;
}

export interface LayoutBudgetInput {
  /** Terminal rows (from useStdout). */
  rows: number;
  /** Header rows (1 wide, 2 narrow). */
  headerRows: number;
  /** Input box rows (borders included: see inputBoxRowsFor). The
      palette renders INSIDE the box, so its rows live here too. */
  inputRows: number;
  /** Status-bar / footer rows (always 2). */
  footerRows: number;
  /** Thinking indicator rows (1 while waiting, else 0). */
  thinkingRows: number;
  /** Error block rows (wrapped error text, else 0). */
  errorRows: number;
  /** Model picker rows (0 when closed). */
  pickerRows: number;
  /** Command palette rows (0 when closed). DEPRECATED: the palette
      now renders inside the input box (see inputBoxRowsFor); callers
      pass 0 here and count the palette inside inputRows. */
  paletteRows: number;
}

export interface LayoutBudget {
  /** Rows consumed by fixed chrome (everything except messages). */
  fixedRows: number;
  /** Rows left for the message area. */
  available: number;
}

/** Rows left for messages after every fixed block is accounted for. */
export function layoutBudget(input: LayoutBudgetInput): LayoutBudget {
  const fixedRows =
    input.headerRows +
    input.inputRows +
    input.footerRows +
    input.thinkingRows +
    input.errorRows +
    input.pickerRows +
    input.paletteRows;
  return { fixedRows, available: Math.max(0, input.rows - fixedRows) };
}

/**
 * Picker row budget, dynamic (was a constant rows - 14): the picker
 * may use at most the rows left after fixed chrome minus its own
 * chrome (gap 1 + title 1 + hint 1 + up to 2 group headers + "more"
 * line 1 = 6), so an open picker can never push the input out of the
 * viewport. Floored at 1 model row so the picker stays usable on
 * very short terminals.
 */
export function pickerMaxRowsFor(rows: number, fixedRowsExcludingPicker: number): number {
  return Math.max(1, Math.min(16, rows - fixedRowsExcludingPicker - 6));
}

/** Scroll constants (Freebuff use-scroll-management.ts). */
export const PAGE_SCROLL_FRACTION = 0.8;
export const SCROLL_NEAR_BOTTOM_THRESHOLD = 1;
export const AUTO_SCROLL_DELAY_MS = 50;
/** Smooth-scroll animation (Freebuff use-scroll-management.ts:
 * 200ms, easeOutCubic, ~60fps frames). */
export const SCROLL_ANIMATION_DURATION_MS = 200;
export const SCROLL_ANIMATION_FRAME_MS = 16;

/** easeOutCubic (Freebuff use-scroll-management.ts). */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Scrollbar thumb range over the message-area rows (Freebuff
 * scrollbox vertical scrollbar, track width 1, shown only when the
 * content overflows): the thumb covers the visible window's share of
 * the total, at least one row, clamped inside [0, available).
 * Returns [start, end) row indexes; empty when there is no overflow.
 */
export function scrollbarThumbRange(
  total: number,
  available: number,
  startLine: number,
  endLine: number,
): { start: number; end: number } {
  if (total <= available || available <= 0) return { start: 0, end: 0 };
  const start = Math.floor((startLine / total) * available);
  const end = Math.max(start + 1, Math.ceil((endLine / total) * available));
  return { start: Math.max(0, start), end: Math.min(available, end) };
}

/**
 * Picker hint line: the full legend needs 48 columns; narrow
 * terminals get the short form so the hint never wraps to a second
 * row (the row budget counts it as exactly one row).
 */
export function pickerHint(maxWidth: number): string {
  return maxWidth >= 48
    ? "↑↓ pilih · Enter pakai · Esc batal · ▸ = model aktif"
    : "↑↓ pilih · Enter pakai · Esc batal";
}

/** Palette hint line: full form needs 37 columns, else the short form. */
export function paletteHint(maxWidth: number): string {
  return maxWidth >= 37 ? "↑↓ pilih · Enter jalankan · Esc tutup" : "↑↓ pilih · Enter · Esc";
}

/**
 * Exact rows the ModelPicker will render for this selection: margin 1
 * + title 1 + visible model rows + group headers inside the slice +
 * "N more" line when the list continues + hint rows + 1 detail line
 * under the selected row (Freebuff selector: every row is 2 lines —
 * name + detail; MethaTech keeps one line per row except the selected
 * one, so short terminals still fit many models). Must stay in sync
 * with ModelPicker.tsx (same visibleWindow + group-header rule, same
 * hint text via pickerHint).
 */
export function pickerRenderedRows(opts: {
  catalog: Catalog;
  selectedIndex: number;
  maxRows: number;
  /** Row width the picker renders at (content width). */
  maxWidth?: number;
}): number {
  const maxWidth = opts.maxWidth ?? Number.POSITIVE_INFINITY;
  const hintRows = wrapLineCount(pickerHint(maxWidth), maxWidth);
  const groups = groupCatalog(opts.catalog);
  const total = groups.reduce((n, g) => n + g.entries.length, 0);
  if (total === 0) return 1 + 1; // gap row + "no models" line (no title/hint)
  const { start, end } = visibleWindow(total, opts.selectedIndex, opts.maxRows);
  let offset = 0;
  let headers = 0;
  let lastTitle: string | null = null;
  for (const g of groups) {
    for (let i = 0; i < g.entries.length; i++) {
      const flatIdx = offset + i;
      if (flatIdx >= start && flatIdx < end && g.title !== lastTitle) {
        headers += 1;
        lastTitle = g.title;
      }
    }
    offset += g.entries.length;
  }
  const selectedVisible = opts.selectedIndex >= start && opts.selectedIndex < end ? 1 : 0;
  return 1 + 1 + (end - start) + headers + (end < total ? 1 : 0) + hintRows + selectedVisible;
}

/**
 * Palette row budget, dynamic like the picker: at most the rows left
 * after fixed chrome minus its chrome (margin 1 + hint 1), clamped to
 * 2..8 command rows.
 */
export function paletteMaxRowsFor(rows: number, fixedRowsExcludingPalette: number): number {
  return Math.max(2, Math.min(8, rows - fixedRowsExcludingPalette - 2));
}

/** Exact rows the CommandPalette will render (gap 1 + rows + hint rows).
 * Uses the centered suggestionWindow (suggestions.ts), same as the
 * component, so the budget never drifts from what is drawn. */
export function paletteRenderedRows(opts: {
  totalCommands: number;
  selectedIndex: number;
  maxRows: number;
  /** Row width the palette renders at (content width). */
  maxWidth?: number;
}): number {
  const maxWidth = opts.maxWidth ?? Number.POSITIVE_INFINITY;
  if (opts.totalCommands === 0) return 1 + 1; // gap row + empty line (no hint)
  const { visibleCount } = suggestionWindow(opts.totalCommands, opts.selectedIndex, opts.maxRows);
  return 1 + visibleCount + wrapLineCount(paletteHint(maxWidth), maxWidth);
}

export interface WindowedLines {
  lines: VisualLine[];
  /** First visible line index in the full list. */
  startLine: number;
  /** One past the last visible line index. */
  endLine: number;
  /** Lines hidden above the window. */
  hiddenAbove: number;
  /** Lines hidden below the window. */
  hiddenBelow: number;
  /** True when the window sits at (or within 1 line of) the bottom. */
  isAtBottom: boolean;
}

/**
 * Manual windowing (Ink has no scrollbox): show the last `available`
 * visual lines, shifted up by `scrollOffsetLines`. Offset 0 = bottom.
 */
export function windowLines(
  lines: VisualLine[],
  available: number,
  scrollOffsetLines: number,
): WindowedLines {
  const total = lines.length;
  const avail = Math.max(0, available);
  const maxOffset = Math.max(0, total - avail);
  const offset = Math.max(0, Math.min(scrollOffsetLines, maxOffset));
  const end = total - offset;
  const start = Math.max(0, end - avail);
  return {
    lines: lines.slice(start, end),
    startLine: start,
    endLine: end,
    hiddenAbove: start,
    hiddenBelow: total - end,
    isAtBottom: offset <= 1,
  };
}

/**
 * PgUp/PgDn step, Freebuff-style: one page is 0.8 of the message
 * viewport; clamps so the window never scrolls past either end.
 */
export function pageScrollOffset(
  current: number,
  direction: "up" | "down",
  available: number,
  totalLines: number,
): number {
  const page = Math.max(1, Math.floor(Math.max(0, available) * 0.8));
  const maxOffset = Math.max(0, totalLines - Math.max(0, available));
  if (direction === "up") return Math.min(maxOffset, current + page);
  return Math.max(0, current - page);
}

// ---------------------------------------------------------------------------
// Welcome / empty state — shown only while there are no messages yet.
// Freebuff fills its first screen with content (logo, info box,
// suggestions) instead of leaving the viewport empty; MethaTech does
// the same with its own identity. Pure functions, unit-tested.
// The result is EXACTLY `available` rows (top pad + content +
// bottom pad) so the root stays exactly `rows` tall.
// ---------------------------------------------------------------------------

/** 5-row block font for the MethaTech wordmark (desktop welcome). */
const BANNER_FONT: Record<string, string[]> = {
  M: ["M   M", "MM MM", "M M M", "M   M", "M   M"],
  E: ["EEEEE", "E    ", "EEEE ", "E    ", "EEEEE"],
  T: ["TTTTT", "  T  ", "  T  ", "  T  ", "  T  "],
  H: ["H   H", "H   H", "HHHHH", "H   H", "H   H"],
  A: ["  A  ", " A A ", "AAAAA", "A   A", "A   A"],
  C: [" CCCC", "C    ", "C    ", "C    ", " CCCC"],
};
const BANNER_ROWS = 5;

/** Block-letter rows for a word ("MethaTech" -> 5 rows, 53 cols). */
export function bannerLines(word: string): string[] {
  const rows: string[] = Array.from({ length: BANNER_ROWS }, () => "");
  for (const ch of word.toUpperCase()) {
    const glyph = BANNER_FONT[ch] ?? Array.from({ length: BANNER_ROWS }, () => "     ");
    for (let i = 0; i < BANNER_ROWS; i++) rows[i] += (rows[i] ? " " : "") + glyph[i];
  }
  return rows;
}

/** Plain-text length of a line (sum of its segments). */
function lineLength(line: VisualLine): number {
  return line.segments.reduce((n, s) => n + s.text.length, 0);
}

/** Center a line in `width` by left-padding with spaces. */
function centerLine(line: VisualLine, width: number): VisualLine {
  const pad = Math.max(0, Math.floor((width - lineLength(line)) / 2));
  return { segments: [{ text: " ".repeat(pad) }, ...line.segments] };
}

/** Center a plain string as a colored, optionally bold line. */
function centerText(text: string, width: number, color?: string, bold?: boolean): VisualLine {
  return centerLine({ segments: [{ text, color, bold }] }, width);
}

/**
 * Wrap content lines in a round-corner box, centered in `width`.
 * Falls back to plain centered lines when the box would not fit
 * (extremely narrow terminals).
 */
function boxLines(content: VisualLine[], width: number): VisualLine[] {
  const inner = Math.max(0, ...content.map(lineLength));
  const boxWidth = inner + 4; // 1 space pad + 1 border, each side
  if (boxWidth > width) return content.map((l) => centerLine(l, width));
  const leftPad = Math.max(0, Math.floor((width - boxWidth) / 2));
  const padSeg = { text: " ".repeat(leftPad) };
  const border = (left: string, fill: string, right: string): VisualLine => ({
    segments: [
      padSeg,
      { text: left + fill.repeat(inner + 2) + right, color: theme.accentSecondary },
    ],
  });
  const out: VisualLine[] = [border("╭", "─", "╮")];
  for (const line of content) {
    const gap = inner - lineLength(line);
    out.push({
      segments: [
        padSeg,
        { text: "│ ", color: theme.accentSecondary },
        ...line.segments,
        { text: " ".repeat(gap) + " │", color: theme.accentSecondary },
      ],
    });
  }
  out.push(border("╰", "─", "╯"));
  return out;
}

export interface WelcomeOptions {
  /** Rows the message area has (from layoutBudget). */
  available: number;
  /** Content width (columns - 4). */
  contentWidth: number;
  /** Active model id. */
  model: string;
  /** True when the active model is FREE. */
  free: boolean;
  /** e.g. "$0.25 / $1.00 per 1M" (null when no price). */
  priceText: string | null;
  /** Balance in dollars (null when unknown). */
  balanceUsd: number | null;
  /** Show the starter prompts (false once the first prompt was sent —
      Freebuff: suggestions vanish permanently after the first submit). */
  showStarters?: boolean;
}

/**
 * Starter prompts (Freebuff suggested-prompts.tsx: 3 items, shown
 * until the first prompt is submitted). Product copy is English
 * (MetaTech rule). Pressing 1/2/3 on the empty state sends one
 * directly. `label` is the short chip text, `prompt` is what is sent.
 */
export const STARTER_PROMPTS: readonly { label: string; shortLabel: string; prompt: string }[] = [
  {
    label: "Explain quantum computing in simple terms",
    shortLabel: "Explain quantum computing",
    prompt: "Explain quantum computing in simple terms.",
  },
  {
    label: "Write a Python function that sorts a list",
    shortLabel: "Write a Python sort function",
    prompt: "Write a Python function that sorts a list of numbers and explain how it works.",
  },
  {
    label: "Give me 5 side-project ideas for a developer",
    shortLabel: "5 side-project ideas",
    prompt: "Give me 5 side-project ideas for a developer who is learning AI.",
  },
];

export interface WelcomeLayout {
  /** Exactly `available` rows: top pad + content + bottom pad. */
  rows: VisualLine[];
  /** Whether the block-letter wordmark is used (false = plain text). */
  banner: boolean;
}

/**
 * Build the welcome / empty state. Full variant (block wordmark +
 * breathing blanks) when there is room; compact variant (plain
 * wordmark, no blanks) on short or narrow terminals. The content is
 * sliced if the terminal is shorter than the compact form.
 */
export function welcomeLayout(opts: WelcomeOptions): WelcomeLayout {
  const { available, contentWidth, model, free, priceText, balanceUsd } = opts;
  const showStarters = opts.showStarters !== false;
  const avail = Math.max(0, available);

  // Info box content: first message, active model (+ price), balance.
  const balanceText = balanceUsd === null ? "—" : `$${balanceUsd.toFixed(4)}`;
  const modelWide: VisualLine = {
    segments: [
      { text: "Model: ", color: theme.muted },
      { text: model, color: theme.text, bold: true },
      { text: " · ", color: theme.muted },
      free
        ? { text: "FREE $0.00", color: theme.accent, bold: true }
        : priceText
          ? { text: priceText, color: theme.accent }
          : { text: "harga —", color: theme.muted },
    ],
  };
  const modelNarrow: VisualLine = {
    segments: [
      { text: "Model: ", color: theme.muted },
      { text: model, color: theme.text, bold: true },
    ],
  };
  const infoContent: VisualLine[] = [
    { segments: [{ text: "Pesan pertama memulai sesi.", color: theme.text }] },
    modelWide,
    {
      segments: [
        { text: "Balance: ", color: theme.muted },
        { text: balanceText, color: theme.text },
      ],
    },
  ];
  // Use the wide model line only if the box still fits the width.
  const wideInner = Math.max(0, ...infoContent.map(lineLength));
  if (wideInner + 4 > contentWidth) infoContent[1] = modelNarrow;

  const suggestions: VisualLine[] = showStarters
    ? (contentWidth >= 60 ? STARTER_PROMPTS : STARTER_PROMPTS.slice(0, 2)).map((s, i) => ({
        segments: [
          { text: `${i + 1}. `, color: theme.accent, bold: true },
          { text: contentWidth >= 60 ? s.label : s.shortLabel, color: theme.text },
        ],
      }))
    : [];

  const banner = bannerLines("MethaTech");
  const bannerWidth = banner[0]?.length ?? 0;
  const useBanner = avail >= 16 && bannerWidth <= contentWidth;
  const label: VisualLine = {
    segments: [{ text: "Try:", color: theme.secondary, bold: true }],
  };
  // Short command hint (keeps /model + /models discoverable on the
  // empty state). Short form on narrow terminals so it never wraps.
  const hint: VisualLine =
    contentWidth >= 60
      ? {
          segments: [
            { text: "Type ", color: theme.muted },
            { text: "/model", color: theme.accentSecondary, bold: true },
            { text: " to switch models · ", color: theme.muted },
            { text: "/models", color: theme.accentSecondary, bold: true },
            { text: " to see prices", color: theme.muted },
          ],
        }
      : {
          segments: [
            { text: "/model", color: theme.accentSecondary, bold: true },
            { text: " switch · ", color: theme.muted },
            { text: "/models", color: theme.accentSecondary, bold: true },
            { text: " prices", color: theme.muted },
          ],
        };

  let content: VisualLine[];
  if (useBanner) {
    content = [
      ...banner.map((row) => centerText(row, contentWidth, theme.accent, true)),
      blankLine(),
      ...boxLines(infoContent, contentWidth),
      blankLine(),
      ...(showStarters
        ? [
            centerLine(label, contentWidth),
            ...suggestions.map((s) => centerLine(s, contentWidth)),
            centerLine(hint, contentWidth),
          ]
        : []),
    ];
  } else {
    content = [
      centerText("MethaTech", contentWidth, theme.accent, true),
      ...boxLines(infoContent, contentWidth),
      ...(showStarters
        ? [
            centerLine(label, contentWidth),
            ...suggestions.map((s) => centerLine(s, contentWidth)),
            centerLine(hint, contentWidth),
          ]
        : []),
    ];
  }

  const slack = avail - content.length;
  // Ceil: an odd slack row goes on top, so the wordmark banner stays
  // centered (row 3 at 80x24) instead of dropping to row 2 when the
  // input box grows by one row.
  const topPad = Math.max(0, Math.ceil(slack / 2));
  const bottomPad = Math.max(0, slack - topPad);
  const rows: VisualLine[] = [
    ...Array.from({ length: topPad }, () => blankLine()),
    ...content.slice(0, avail - topPad),
    ...Array.from({ length: bottomPad }, () => blankLine()),
  ].slice(0, avail);
  // Exact budget: pad the tail with blanks if slicing cut rows.
  while (rows.length < avail) rows.push(blankLine());
  return { rows, banner: useBanner };
}
