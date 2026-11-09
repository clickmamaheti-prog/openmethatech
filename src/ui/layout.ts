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
import { sanitizeTerminalOutput, sanitizeTerminalText } from "./terminal-safe.js";
import { cellWidth, textWidth } from "./cells.js";
import { parseMarkdown, renderInlineText, renderMarkdownText, renderTable, wrapSegments } from "./markdown.js";
import type { Table } from "mdast";

// Cell widths live in cells.ts (moved out of this file so markdown.ts
// can measure text without a circular import); re-exported here so
// existing imports (tests, ChatApp) keep working.
export { cellWidth, textWidth };

/**
 * Horizontal gutter, Freebuff message-with-agents.tsx:105 —
 * `SIDE_GUTTER = 1`. The message box adds 1 column of padding on
 * each side, ON TOP of the scroll container's own padding
 * (chat.tsx scrollbox contentOptions: `paddingLeft: 1, paddingRight:
 * 2`, where the right 2 = 1 gutter + 1 scrollbar track; chat-header
 * and status-bar add their own `paddingLeft: 1` on top of the scroll
 * container too).
 *
 * MethaTech (Ink) layering that mirrors it:
 * - scroll container = the root Box in ChatApp.tsx (`paddingX={1}`);
 * - message box = flattenMessages, which prepends this 1-column
 *   gutter to every flattened line (left side) and wraps at
 *   `contentWidth - SIDE_GUTTER` (right side — the spare column
 *   already subtracted in contentWidth).
 * Result: message text sits at column 2 from the terminal edge and
 * wraps so its right edge never moves — exactly Freebuff's text
 * column (scroll 1 + message 1 = col 2). The header gets its own
 * +1 via paddingLeft on its Box (Freebuff chat-header.tsx:46-47);
 * the footer/status row stays at col 1 (Freebuff status-bar.tsx:41,
 * root-level padding 1); the input box keeps its border at col 1
 * with 1 space inside (Freebuff chat-input-bar.tsx:485-499 puts the
 * border at col 0 with padding 1 inside — MethaTech deliberately
 * keeps the border inset 1 so it never touches the edge).
 */
export const SIDE_GUTTER = 1;

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

// Cell widths (cellWidth, textWidth) live in cells.ts now — see the
// re-export at the top of this file.

/**
 * Greedy word wrap of one string to at most `width` columns per line.
 * Newlines in the input start a new visual line; empty lines stay empty.
 * Words longer than `width` are hard-split. Multiple spaces collapse to
 * one (chat text; code lines are wrapped by splitSegments instead).
 * Widths are terminal cells (textWidth), not JS string length, so
 * wide CJK/emoji chars wrap at the right column (Freebuff wrapText
 * uses string-width for the same reason).
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
      // Hard-split an over-long word into width-sized chunks
      // (by terminal cells, so a wide char never straddles a break).
      let rest = word;
      while (textWidth(rest) > width) {
        if (line !== "") {
          out.push(line);
          line = "";
        }
        let chunk = "";
        let chunkW = 0;
        for (const ch of rest) {
          const w = cellWidth(ch);
          if (chunkW + w > width && chunk !== "") break;
          chunk += ch;
          chunkW += w;
        }
        out.push(chunk);
        rest = rest.slice(chunk.length);
      }
      if (line === "") line = rest;
      else if (textWidth(line) + 1 + textWidth(rest) <= width) line += " " + rest;
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
  /** DIM attribute (Freebuff markdown delete `~~text~~` renders DIM). */
  dim?: boolean;
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
    // Split by code points so a wide char is never cut in half and
    // its 2-cell width is counted (Freebuff wrapText: string-width).
    const chars = [...seg.text];
    let i = 0;
    while (i < chars.length) {
      const room = width - curLen;
      if (room <= 0) {
        flush();
        continue;
      }
      let take = "";
      let takeW = 0;
      while (i < chars.length) {
        const w = cellWidth(chars[i] as string);
        if (takeW + w > room && take !== "") break;
        take += chars[i];
        takeW += w;
        i++;
      }
      cur.push({ ...seg, text: take });
      curLen += takeW;
      if (i < chars.length) flush();
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
  /**
   * Structured tool call for kind "tool" (Freebuff ToolCallItem +
   * TerminalCommandDisplay semantics). The preview line renders BOLD
   * in foreground; a shell preview renders `$ ` in success green +
   * the command BOLD; each result line renders ✓ in success green
   * or ✗ in error red, so a failed call is never painted as a
   * success. `preview`/`results` are plain text (no ANSI — external
   * text is sanitized before it reaches the layout).
   */
  tool?: {
    name: string;
    preview: string;
    /** True for run_terminal_command (Freebuff `$ ` + bold command). */
    shell: boolean;
    results: { ok: boolean; text: string }[];
  };
}

/** Format an epoch-ms timestamp as [HH:MM] (local time). */
export function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `[${hh}:${mm}]`;
}

// Markdown rendering (inlineSegments, markdownLines, tableLines'
// box-drawing) moved to markdown.ts: the text is now parsed FIRST
// into an mdast AST (unified + remark-parse + remark-gfm +
// remark-breaks — the same packages Freebuff uses) and wrapped as
// styled segments, so a wrap can never fall inside a **bold** /
// *italic* / ~~strike~~ / `code` span and leak raw markers (docs
// §4g). flattenMessages below calls renderMarkdownText for text
// parts; tableLines stays here as a thin adapter for raw row
// strings (tests + legacy callers).

/**
 * Box-drawing table from raw Markdown row strings. Parses the rows
 * with the real Markdown parser and renders via markdown.ts
 * renderTable — identical output to the AST path inside
 * renderMarkdownText, no duplicated box-drawing code.
 */
export function tableLines(rows: string[], width: number): VisualLine[] {
  const root = parseMarkdown(rows.join("\n"));
  const table = root.children.find((c) => c.type === "table");
  if (!table) return [];
  return renderTable(table as Table, width);
}

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
  for (const raw of messages) {
    // Render boundary: EVERYTHING that reaches the terminal passes
    // through here, so this is where external text is made safe
    // (Freebuff common/src/util/terminal-safe-text.ts). The stored
    // message keeps its raw text — the agent history in loop.ts and
    // /compact need the real tool output — but the drawn copy is
    // cleaned. Sanitizing here (not per stream chunk) also keeps a
    // split escape sequence whole: chunk 1 may end mid-CSI and chunk
    // 2 carry the rest, and only the reassembled content is safe to
    // judge. Tool output uses sanitizeTerminalOutput (a bare \r is
    // a progress-bar redraw, not a line break); everything else
    // uses sanitizeTerminalText.
    const m: LayoutMessage = {
      ...raw,
      content: sanitizeTerminalText(raw.content),
      thinking: raw.thinking === undefined ? undefined : sanitizeTerminalText(raw.thinking),
      todos: raw.todos?.map((t) => ({ ...t, task: sanitizeTerminalText(t.task) })),
      tool:
        raw.tool === undefined
          ? undefined
          : {
              ...raw.tool,
              preview: sanitizeTerminalText(raw.tool.preview),
              results: raw.tool.results.map((r) => ({ ...r, text: sanitizeTerminalOutput(r.text) })),
            },
    };
    const tsLine = m.ts !== undefined ? plainLine(formatTimestamp(m.ts), theme.muted) : null;
    if (m.kind === "tool") {
      // Agent tool call — Freebuff ToolCallItem + TerminalCommandDisplay:
      // the header is the tool preview BOLD in foreground; a shell
      // preview renders `$ ` in success green + the command BOLD
      // (TerminalCommandDisplay); each result line renders ✓ in
      // success green or ✗ in error red, so a failed call is never
      // painted as a success. Unstructured legacy tool messages
      // (plain content string) keep the old neon-first-line look.
      const tool = m.tool;
      if (tool) {
        // Word-wrap the preview (never split a word mid-token the
        // way a hard split would: "$ ... echo lin/e4"). First line
        // carries the `$ ` prefix (shell) or the plain preview;
        // continuation lines indent 2 spaces under the command.
        const wrappedPreview = wrapText(tool.preview, width);
        wrappedPreview.forEach((w, i) => {
          if (tool.shell && tool.preview.startsWith("$ ")) {
            if (i === 0) {
              lines.push({
                segments: [
                  { text: "$ ", color: theme.success, bold: true },
                  { text: w.slice(2), color: theme.text, bold: true },
                ],
              });
            } else {
              lines.push({
                segments: [
                  { text: "  " },
                  { text: w, color: theme.text, bold: true },
                ],
              });
            }
          } else {
            lines.push({ segments: [{ text: w, color: theme.text, bold: true }] });
          }
        });
        for (const r of tool.results) {
          const wrapped = wrapText(r.text, Math.max(1, width - 4));
          wrapped.forEach((w, i) => {
            lines.push({
              segments:
                i === 0
                  ? [
                      { text: "  " },
                      { text: r.ok ? "✓ " : "✗ ", color: r.ok ? theme.success : theme.error, bold: true },
                      { text: w, color: r.ok ? theme.muted : theme.error },
                    ]
                  : [
                      { text: "    " },
                      { text: w, color: r.ok ? theme.muted : theme.error },
                    ],
            });
          });
        }
      } else {
        const wrapped = wrapText(m.content, width);
        wrapped.forEach((w, i) => {
          lines.push(plainLine(w, i === 0 ? theme.accentSecondary : theme.muted));
        });
      }
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
      // Freebuff also renders user content through its markdown
      // renderer (UserBlockTextWithInlineCopy), so **bold** / `code` /
      // links inside a user message render instead of showing raw
      // markers. Parse first, wrap after: each raw line is parsed
      // as inline Markdown (renderInlineText) and wrapped as styled
      // segments (wrapSegments), so a span can never leak across a
      // wrap boundary. The "You: " label (5 cols) comes out of the
      // first line's budget; continuation lines keep the border only.
      if (tsLine) lines.push(tsLine);
      const inner = Math.max(1, width - 2);
      const labelW = 5; // "You: "
      let firstLine = true;
      for (const rawLine of m.content.split("\n")) {
        const segs = renderInlineText(rawLine, theme.text).map((s) => ({ ...s, italic: true }));
        const wrapped = wrapSegments(segs.length > 0 ? segs : [{ text: " " }], Math.max(1, inner - (firstLine ? labelW : 0)));
        wrapped.forEach((wl, i) => {
          lines.push({
            segments: [
              ...borderSegs,
              ...(firstLine && i === 0
                ? [{ text: "You: ", color: theme.userLabel, bold: true } as VisualSegment]
                : []),
              ...wl.segments,
            ],
          });
        });
        firstLine = false;
      }
    } else {
      // Freebuff message-block.tsx: the assistant block carries NO
      // timestamp (timestamps are a user-line thing). The thinking
      // block (reasoning) goes above the answer when present.
      // thinking.tsx): preview = last 5 visual lines, italic muted,
      // "..." prefix when cut; expanded = full reasoning. A lone
      // **bold** title renders nothing. Ctrl+T toggles all blocks.
      let thinkingRendered = false;
      if (m.thinking !== undefined && m.thinking.length > 0) {
        const preview = thinkingPreview(
          m.thinking,
          width,
          opts.thinkingExpanded === true ? "expanded" : "preview",
          m.thinkingComplete === true,
        );
        if (preview.visible) {
          thinkingRendered = true;
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
      // Freebuff message-block.tsx:275 — the blocks container inside
      // one message has gap: 1 (one blank line between the Thinking
      // block and the answer text that follows). Without it the
      // Thinking preview runs straight into the answer and the whole
      // assistant block reads as one cramped blob of chat text
      // ("dempet" on a narrow Termux screen). The gap appears only
      // when there IS answer content after the thinking; a
      // still-streaming message with reasoning but no text yet keeps
      // just the message's own trailing blank line (Freebuff renders
      // empty text blocks as null).
      if (thinkingRendered && m.content.trim().length > 0) {
        lines.push(blankLine());
      }
      // Freebuff single-block.tsx: an empty text block renders null
      // (no lines at all). Without this guard an empty assistant
      // message (the streaming placeholder, or a turn whose model
      // only thought) emits one blank line from its empty content
      // PLUS the message's trailing blank line — two blank rows.
      // pendingBlank lives at the parts level: a text part that ends
      // with blank lines hands the break to the NEXT part — a code
      // block keeps the paragraph break (it is not a tight
      // followup), while a trailing blank at the end of the message
      // is dropped (the message's own trailing blank line follows).
      const parts = m.content.trim().length === 0 ? [] : splitMessageParts(m.content);
      let pendingBlank = false;
      let emitted = false;
      parts.forEach((part, pi) => {
        if (part.type === "code") {
          if (pendingBlank) {
            lines.push(blankLine());
            pendingBlank = false;
          }
          emitted = true;
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
          // Parse-first Markdown (markdown.ts renderMarkdownText):
          // the whole text part goes through remark into an mdast
          // AST, blocks render from the AST, inline spans wrap as
          // styled segments. A pending blank is the part-boundary
          // rule only — paragraph spacing INSIDE the part is the
          // AST renderer's own job (blank after a paragraph unless
          // the next block is a tight followup: list / blockquote /
          // heading / divider / table). A text part that starts or
          // ends with a blank line hands the break to the neighbour
          // part (a code block keeps the paragraph break; a trailing
          // blank at the end of the message is dropped — the
          // message's own trailing blank line follows). The gap is
          // emitted once content has been emitted in this message,
          // so a leading newline never grows a leading blank line.
          const rendered = renderMarkdownText(part.content, width);
          if (rendered.lines.length === 0) {
            if ((rendered.endsBlank || rendered.startsBlank) && (emitted || pi > 0)) {
              pendingBlank = true;
            }
          } else {
            if ((pendingBlank || rendered.startsBlank) && (emitted || pi > 0) && !rendered.startsTight) {
              lines.push(blankLine());
            }
            pendingBlank = false;
            emitted = true;
            for (const l of rendered.lines) lines.push(l);
            pendingBlank = rendered.endsBlank;
          }
        }
      });
    }
    lines.push(blankLine());
  }
  // Message-box gutter (SIDE_GUTTER): every flattened line gets one
  // leading space, so the message text sits at column 2 from the
  // terminal edge (root padding 1 + message gutter 1), exactly like
  // Freebuff (scrollbox 1 + SIDE_GUTTER 1). Blank separator lines get
  // the gutter too — they are spaces either way, and keeping the
  // prefix uniform means no line ever starts at column 1. The `width`
  // the caller passes is the TEXT width (already minus SIDE_GUTTER),
  // so dividers/tables keep their right edge where it was.
  return lines.map((l) => ({ segments: [{ text: " ".repeat(SIDE_GUTTER) }, ...l.segments] }));
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

/**
 * Mouse-wheel step (Freebuff ScrollBox onMouseEvent with the default
 * LinearScrollAccel: 1 line per wheel tick — one Termux swipe row
 * sends exactly one wheel event, so finger and content track 1:1).
 * Unlike PgUp/PgDn this is applied immediately, with no 200ms
 * animation: a fling sends many events in a burst and animating
 * each one would lag behind the finger. Clamps like pageScrollOffset.
 */
export function wheelScrollOffset(
  current: number,
  direction: "up" | "down",
  lines: number,
  available: number,
  totalLines: number,
): number {
  const maxOffset = Math.max(0, totalLines - Math.max(0, available));
  if (direction === "up") return Math.min(maxOffset, current + Math.max(0, lines));
  return Math.max(0, current - Math.max(0, lines));
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

/** Terminal cell width of a line (sum of its segments). */
function lineLength(line: VisualLine): number {
  return line.segments.reduce((n, s) => n + textWidth(s.text), 0);
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
