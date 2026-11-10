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
import { truncateEnd } from "./attachments.js";
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

/**
 * Freebuff composer rest height (chat-input-bar.tsx: the inner content
 * box has `minHeight: shouldCenterInputVertically ? 3 : undefined` and
 * `justifyContent: shouldCenterInputVertically ? "center" : "flex-start"`,
 * chat.tsx:2122-2123: shouldCenterInputVertically = !hasSuggestionMenu
 * && !isMultilineInput). At rest — single-line draft, no suggestion menu
 * open — the composer content area is 3 rows with the input line
 * vertically centered, so the bordered box is 5 rows tall (3 + 2 borders).
 * As soon as the draft wraps to 2+ rows or the palette opens, the box
 * hugs the content instead. Callers pass the EFFECTIVE content rows
 * (3 when centered, else the wrapped rows) to inputBoxRowsFor, so the
 * budget math and the render agree exactly.
 */
export const COMPOSER_CENTERED_CONTENT_ROWS = 3;

/** Whether the composer content area uses the centered 3-row rest height. */
export function composerIsCentered(inputContentRows: number, paletteOpen: boolean): boolean {
  return !paletteOpen && inputContentRows <= 1;
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

/**
 * One ordered block inside a single assistant turn message (Freebuff
 * ChatMessage.blocks / ContentBlock, cli/src/types/chat.ts +
 * components/blocks/blocks-renderer.tsx). A turn is ONE assistant
 * message whose blocks grow append-only in arrival order — text,
 * tool, text, tool — so the turn reads in true chronological order.
 * Before this change, tool calls and to-dos were separate top-level
 * messages appended AFTER the assistant message, so ALL assistant
 * text (including text produced AFTER the tools ran) rendered ABOVE
 * all tool calls. Blocks fix that at the data-model level.
 */
export type AssistantBlock =
  | { type: "text"; content: string }
  | {
      type: "tool";
      name: string;
      preview: string;
      /** True for run_terminal_command (Freebuff `$ ` + bold command). */
      shell: boolean;
      results: { ok: boolean; text: string }[];
      /**
       * True once this call's result arrived (even when the summary
       * is null, e.g. a successful read_files shows no result line
       * — §4m). The TUI matches a tool_result to the earliest
       * UNRESOLVED block of that tool, so a null-summary result
       * must still mark its block resolved or a later result for
       * the same tool would attach to the wrong block.
       */
      done: boolean;
    }
  | { type: "todos"; todos: { task: string; completed: boolean }[] };

/** Minimal message shape the layout needs (mirrors ChatApp's messages). */
export interface LayoutMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  kind: "chat" | "system";
  /** Epoch ms the message was created (renders as [HH:MM] above it). */
  ts?: number;
  /** Reasoning text received before the answer (delta.reasoning_content). */
  thinking?: string;
  /** True once the stream that produced the reasoning finished. */
  thinkingComplete?: boolean;
  /**
   * Ordered blocks of one assistant turn (see AssistantBlock).
   * User and system messages do not carry blocks — they render
   * `content`. An assistant message WITHOUT blocks falls back to
   * rendering `content` as a single text block (legacy fixtures).
   */
  blocks?: AssistantBlock[];
  /**
   * Attachments sent with this user message (compact metadata only
   * — the full content lives in the agent history). Rendered as one
   * `📎 title · Type · N baris` line per attachment under the user
   * block (Freebuff message-block.tsx renders its textAttachments
   * as cards under the message).
   */
  attachments?: {
    title: string;
    contentType: string;
    lineCount: number;
    charCount: number;
  }[];
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
      blocks: raw.blocks?.map((b) =>
        b.type === "text"
          ? { ...b, content: sanitizeTerminalText(b.content) }
          : b.type === "tool"
            ? {
                ...b,
                preview: sanitizeTerminalText(b.preview),
                results: b.results.map((r) => ({ ...r, text: sanitizeTerminalOutput(r.text) })),
              }
            : { ...b, todos: b.todos.map((t) => ({ ...t, task: sanitizeTerminalText(t.task) })) },
      ),
      attachments: raw.attachments?.map((a) => ({ ...a, title: sanitizeTerminalText(a.title) })),
    };
    const tsLine = m.ts !== undefined ? plainLine(formatTimestamp(m.ts), theme.muted) : null;
    if (m.kind === "system") {
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
      // Freebuff message-block.tsx:187-194 — the MessageBlock root
      // column has NO gap: its timestamp sits DIRECTLY above the
      // text (single-block.tsx: marginTop={0}, marginBottom={0}).
      // §4l added a blank line here ("gap 1") and Reza said it is
      // TOO FAR ("kejauhan") — the timestamp must come down closer
      // to the "You:" body. The element that keeps Freebuff's
      // adjacency from reading cramped ("dempet") is the continuous
      // vertical line: message-with-agents.tsx:236-252 renders the
      // user bar with marginTop: 0, marginBottom: 0, so it spans the
      // FULL message height INCLUDING the timestamp line — the
      // timestamp is the header of the bordered block, not a floating
      // line above it. MethaTech's bar previously started at the
      // "You:" line only, so the timestamp floated bare above the
      // block. Fix: no blank line (Freebuff placement, diff=1) AND
      // the bar runs alongside the timestamp line too.
      if (tsLine) {
        lines.push({ segments: [...borderSegs, ...tsLine.segments] });
      }
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
      // Attachments sent with this message: one compact card line
      // each, under the user text (Freebuff message-block.tsx
      // renders textAttachments as cards under the message). The
      // full content is NOT re-rendered here — it lives in the
      // agent history; the history shows only the card line.
      for (const a of m.attachments ?? []) {
        const label = `📎 ${truncateEnd(a.title, Math.max(10, inner - 4))} · ${a.contentType} · ${a.lineCount} baris`;
        lines.push({ segments: [...borderSegs, { text: label, color: theme.muted }] });
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
      // Blocks (Freebuff ContentBlock, append-only, arrival order):
      // one assistant message per turn; text and tool/todos blocks
      // render in the order they arrived, so text the model wrote
      // AFTER a tool call renders BELOW that tool call. An assistant
      // message without blocks falls back to `content` as a single
      // text block (legacy fixtures / plain chat).
      const blocks: AssistantBlock[] =
        m.blocks ??
        (m.content.trim().length > 0 ? [{ type: "text" as const, content: m.content }] : []);
      // One blank line between blocks inside one message (Freebuff
      // message-block.tsx:275 gap: 1) — the same rhythm the old
      // separate top-level messages had via their trailing blank
      // line. The Thinking block counts as an emitted block, so the
      // gap after it is the same rule, not a special case.
      let emittedAny = thinkingRendered;
      const blockWillEmit = (b: AssistantBlock): boolean =>
        b.type === "tool" ||
        (b.type === "todos" && b.todos.length > 0) ||
        (b.type === "text" && b.content.trim().length > 0);
      for (const block of blocks) {
        if (!blockWillEmit(block)) continue;
        if (emittedAny) lines.push(blankLine());
        if (block.type === "text") {
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
          const parts = block.content.trim().length === 0 ? [] : splitMessageParts(block.content);
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
              // The assistant body renders in theme.text (Freebuff
              // message-block.tsx:188: textColor ?? theme.foreground):
              // without it plain paragraphs carry NO color and fall back
              // to the terminal default foreground, which reads gray on
              // Reza's Termux. Semantic elements keep their own colors
              // (heading / inline code / link / blockquote / code block).
              const rendered = renderMarkdownText(part.content, width, theme.text);
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
        } else if (block.type === "tool") {
          // Agent tool call — Freebuff ToolCallItem +
          // TerminalCommandDisplay: the preview renders BOLD in
          // foreground; a shell preview renders `$ ` in success
          // green + the command BOLD; each result line renders ✓
          // in success green or ✗ in error red, so a failed call
          // is never painted as a success.
          const tool = block;
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
          // Freebuff cli/src/components/tools/write-todos.tsx:
          // header "• TODOs" (bullet + BOLD "TODOs", foreground);
          // items indented 2 spaces; completed = "✓ " in success
          // + task in muted + strikethrough; pending = "☐ " in
          // foreground + task in foreground. An empty list renders
          // nothing.
          const todos = block.todos;
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
        }
        emittedAny = true;
      }
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

// 0.1.9 §4q: the scrollbar is removed (Reza's order — no track/thumb
// column at the right edge). scrollbarThumbRange lived here (Freebuff
// scrollbox vertical scrollbar, track width 1, proportional thumb);
// it is deleted with the rendering. Freebuff's own scrollbox hides
// its scrollbar too (chat.tsx:2246 scrollbarOptions visible: false).
// The scroll FUNCTION (offset, wheel, PgUp/PgDn, auto-scroll,
// easeOutCubic) is untouched.

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
// the same with its own identity (info box + suggestions, no ASCII
// art — the block-letter wordmark was REMOVED entirely on Reza's
// order 2026-11-10 "gausah pake code ASCII lah, hapus aja").
// Pure functions, unit-tested.
// The result is EXACTLY `available` rows (top pad + content +
// bottom pad) so the root stays exactly `rows` tall.
// ---------------------------------------------------------------------------

/** Terminal cell width of a line (sum of its segments). */
function lineLength(line: VisualLine): number {
  return line.segments.reduce((n, s) => n + textWidth(s.text), 0);
}

/** Center a line in `width` by left-padding with spaces. */
function centerLine(line: VisualLine, width: number): VisualLine {
  const pad = Math.max(0, Math.floor((width - lineLength(line)) / 2));
  return { segments: [{ text: " ".repeat(pad) }, ...line.segments] };
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
}

/** Options for the persistent conversation header (headerLayout). */
export interface HeaderOptions {
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
  /** True once at least one message exists in the conversation. */
  hasMessages: boolean;
}

/**
 * Info box content lines (shared by the welcome block and the
 * persistent header): session line, active model (+ price), balance.
 * The session line follows Freebuff's FreebuffChatHeader conditional
 * (freebuff-chat-header.tsx: session active -> 'Session active',
 * else 'Your first message starts the session.'): before the first
 * message it invites the user in; once the conversation exists it
 * states the session is active — the old "Pesan pertama memulai
 * sesi." must not linger above a running conversation.
 * The wide model line is used only when the box still fits the width.
 */
function infoBoxContent(opts: HeaderOptions): VisualLine[] {
  const { contentWidth, model, free, priceText, balanceUsd, hasMessages } = opts;
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
    { segments: [{ text: hasMessages ? "Sesi aktif." : "Pesan pertama memulai sesi.", color: theme.text }] },
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
  return infoContent;
}

/**
 * Persistent conversation header (Freebuff chat.tsx:2243-2275 — the
 * header is a PERMANENT first child of the scrollbox, not an
 * empty-state-only branch: it stays above the messages and only
 * scrolls away naturally once the conversation overflows the
 * viewport). The header is the welcome card alone — the ASCII
 * wordmark was removed entirely on Reza's order 2026-11-10 — so it
 * is exactly the 5-row info box (top border, 3 content lines,
 * bottom border). ChatApp prepends these rows to the flattened
 * message lines before windowing, so PgUp/PgDn, auto-scroll and the
 * scroll indicator treat the header as the first lines of the
 * scrollable content, exactly like Freebuff's header inside the
 * scrollbox. Never used for /export or /compact (those read the
 * message list, not the rendered lines).
 */
export function headerLayout(opts: HeaderOptions): VisualLine[] {
  return boxLines(infoBoxContent(opts), opts.contentWidth);
}

/**
 * Build the welcome / empty state: the info box (headerLayout, no
 * messages yet) + the "Try:" starter prompts + the short /model +
 * /models hint, top-anchored. The content is sliced if the terminal
 * is shorter than the compact form.
 */
export function welcomeLayout(opts: WelcomeOptions): WelcomeLayout {
  const { available, contentWidth, model, free, priceText, balanceUsd } = opts;
  const showStarters = opts.showStarters !== false;
  const avail = Math.max(0, available);

  const suggestions: VisualLine[] = showStarters
    ? (contentWidth >= 60 ? STARTER_PROMPTS : STARTER_PROMPTS.slice(0, 2)).map((s, i) => ({
        segments: [
          { text: `${i + 1}. `, color: theme.accent, bold: true },
          { text: contentWidth >= 60 ? s.label : s.shortLabel, color: theme.text },
        ],
      }))
    : [];

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

  // 0.1.9 §4o: NO blank row between the info box and the "Try:"
  // label — the content is 10 rows while the message area at 80x24
  // is 16 rows, so the block fits with slack below.
  const content: VisualLine[] = [
    ...headerLayout({ contentWidth, model, free, priceText, balanceUsd, hasMessages: false }),
    ...(showStarters
      ? [
          centerLine(label, contentWidth),
          ...suggestions.map((s) => centerLine(s, contentWidth)),
          centerLine(hint, contentWidth),
        ]
      : []),
  ];
  const slack = avail - content.length;
  // Freebuff top-anchors the welcome header: it is the FIRST child of
  // the scrollbox (chat.tsx:2243 <scrollbox ...> — Header above the
  // messages, justifyContent flex-start), so the empty space sits BELOW
  // the welcome block, inside the conversation viewport, never above it.
  // 0.1.9 §4o: topPad was ceil(slack/2) (vertically centered welcome —
  // the void split above AND below the wordmark at tall terminals).
  const topPad = 0;
  const bottomPad = Math.max(0, slack - topPad);
  const rows: VisualLine[] = [
    ...Array.from({ length: topPad }, () => blankLine()),
    ...content.slice(0, avail - topPad),
    ...Array.from({ length: bottomPad }, () => blankLine()),
  ].slice(0, avail);
  // Exact budget: pad the tail with blanks if slicing cut rows.
  while (rows.length < avail) rows.push(blankLine());
  return { rows };
}
