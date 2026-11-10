// Markdown rendering — Freebuff's pipeline, ported to MethaTech's
// VisualLine model.
//
// Freebuff cli/src/utils/markdown-renderer.tsx parses the WHOLE reply
// into an mdast AST with unified + remark-parse + remark-gfm +
// remark-breaks (the same packages, same majors, as Freebuff's
// cli/package.json), then renders blocks from the AST: strong → BOLD,
// emphasis → ITALIC, delete → DIM, inlineCode → orange bold on gray,
// heading → bold + yellow, link → blue label, table → box-drawing
// with column widths from plain-text cell widths, code → monochrome
// block with a "// lang" header.
//
// MethaTech used to do it backwards: wrapText FIRST (raw text, with
// the markers counted as visible width), then a regex inline parser
// per wrapped line (inlineSegments) — so any wrap falling inside a
// **bold** / *italic* / ~~strike~~ / `code` span leaked raw markers
// (docs §4g: proven at widths 34, 35, 36). This module parses FIRST
// and wraps only styled segments, so a marker can never survive
// parsing: remark consumes it, or — when unclosed, e.g. mid-stream —
// leaves it as literal text that resolves the moment the closing
// marker arrives (exactly Freebuff's streaming behaviour: the tail
// is re-parsed on every flush, renderStreamingMarkdown).
//
// Streaming note (Freebuff renderStreamingMarkdown): an open fenced
// code block is rendered raw and never markdown-parsed mid-stream.
// MethaTech already does that one level up — splitMessageParts
// (syntax.ts) treats an unclosed fence as a CODE part. What this
// module adds is the same guarantee for emphasis: a half-written
// `**bold` is literal text for one flush, then bold once `**`
// arrives; nothing ever sticks.

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import type {
  Blockquote,
  Code,
  Content,
  Definition,
  Delete,
  Emphasis,
  Heading,
  Html,
  Image,
  InlineCode,
  Link,
  LinkReference,
  List,
  ListItem,
  Paragraph,
  Root,
  Strong,
  Table,
  TableCell,
  TableRow,
  Text,
} from "mdast";
import { markdown } from "../theme.js";
import { cellWidth, textWidth } from "./cells.js";
import type { VisualLine, VisualSegment } from "./layout.js";

/** The Freebuff processor, verbatim: unified + remark-parse + GFM + breaks. */
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkBreaks);

/** Parse Markdown text into an mdast AST (Freebuff: processor.parse). */
export function parseMarkdown(text: string): Root {
  return processor.parse(text) as Root;
}

type MarkdownNode = Content | Root;
type InlineFallbackNode = Text | Strong | Emphasis;

/**
 * Freebuff's inline fallback, ported verbatim in behaviour
 * (markdown-renderer.tsx parseInlineFallback): remark follows
 * CommonMark emphasis rules, which ignore some practical patterns
 * (e.g. `Other**.github/**`). This splits leftover text nodes on
 * emphasis markers so those still render as bold/italic. Unclosed
 * markers stay literal text — during streaming that is the transient
 * state, resolved when the closing marker arrives.
 */
function parseInlineFallback(value: string): InlineFallbackNode[] {
  if (!value || !hasUnescapedMarker(value)) {
    return [{ type: "text", value }];
  }
  const nodes: InlineFallbackNode[] = [];
  let buffer = "";
  const flushBuffer = () => {
    if (buffer.length > 0) {
      nodes.push({ type: "text", value: buffer });
      buffer = "";
    }
  };
  let index = 0;
  while (index < value.length) {
    const char = value[index] as string;
    if (char === "*") {
      const isDouble = index + 1 < value.length && value[index + 1] === "*";
      const marker = isDouble ? "**" : "*";
      const markerLength = marker.length;
      let backslashes = 0;
      for (let offset = index - 1; offset >= 0 && value[offset] === "\\"; offset -= 1) {
        backslashes += 1;
      }
      if (backslashes % 2 === 1) {
        buffer += marker;
        index += markerLength;
        continue;
      }
      const closing = findClosingDelimiter(value, index + markerLength, marker);
      if (closing === -1) {
        buffer += marker;
        index += markerLength;
        continue;
      }
      const inner = value.slice(index + markerLength, closing);
      flushBuffer();
      const children = parseInlineFallback(inner).filter(
        (node) => !(node.type === "text" && node.value.length === 0),
      );
      nodes.push(
        isDouble
          ? { type: "strong", children }
          : { type: "emphasis", children },
      );
      index = closing + markerLength;
      continue;
    }
    buffer += char;
    index += 1;
  }
  flushBuffer();
  if (nodes.length === 0) return [{ type: "text", value }];
  return nodes;
}

function hasUnescapedMarker(value: string): boolean {
  if (!value) return false;
  const markers = ["**", "*"];
  return markers.some((marker) => {
    let idx = value.indexOf(marker);
    while (idx !== -1) {
      let backslashes = 0;
      for (let offset = idx - 1; offset >= 0 && value[offset] === "\\"; offset -= 1) {
        backslashes += 1;
      }
      if (backslashes % 2 === 0) return true;
      idx = value.indexOf(marker, idx + marker.length);
    }
    return false;
  });
}

function findClosingDelimiter(value: string, start: number, marker: string): number {
  let idx = start;
  while (idx < value.length) {
    idx = value.indexOf(marker, idx);
    if (idx === -1) return -1;
    let backslashes = 0;
    for (let offset = idx - 1; offset >= 0 && value[offset] === "\\"; offset -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) return idx;
    idx += marker.length;
  }
  return -1;
}

/** Freebuff applyInlineFallbackFormatting: rewrite text nodes in place. */
function applyInlineFallbackFormatting(node: MarkdownNode): void {
  if (!node || typeof node !== "object") return;
  const mutable = node as { children?: MarkdownNode[] };
  if (!Array.isArray(mutable.children)) return;
  const nextChildren: MarkdownNode[] = [];
  mutable.children.forEach((child) => {
    if (child.type === "text") {
      const replacements = parseInlineFallback((child as Text).value);
      const hasChanges =
        replacements.length !== 1 ||
        replacements[0].type !== "text" ||
        (replacements[0] as Text).value !== (child as Text).value;
      if (hasChanges) {
        replacements.forEach((replacement) => {
          if (replacement.type === "text") {
            nextChildren.push(replacement);
          } else {
            applyInlineFallbackFormatting(replacement as unknown as MarkdownNode);
            nextChildren.push(replacement as unknown as MarkdownNode);
          }
        });
        return;
      }
    } else {
      applyInlineFallbackFormatting(child as MarkdownNode);
    }
    nextChildren.push(child as MarkdownNode);
  });
  mutable.children = nextChildren;
}

/**
 * Plain text of a node, markers stripped (Freebuff nodeToPlainText).
 * Used for table column widths and for unknown-node fallbacks.
 */
export function nodeToPlainText(node: MarkdownNode): string {
  switch (node.type) {
    case "root":
      return ((node as Root).children as MarkdownNode[]).map(nodeToPlainText).join("");
    case "paragraph":
    case "heading":
    case "listItem":
    case "tableCell":
      return ((node as { children: MarkdownNode[] }).children ?? []).map(nodeToPlainText).join("");
    case "text":
      return (node as Text).value;
    case "inlineCode":
      return (node as InlineCode).value;
    case "code":
      return (node as Code).value;
    case "link": {
      const link = node as Link;
      return link.children.length > 0
        ? link.children.map((c) => nodeToPlainText(c as MarkdownNode)).join("")
        : link.url;
    }
    case "linkReference": {
      const ref = node as LinkReference;
      return ref.children.length > 0
        ? ref.children.map((c) => nodeToPlainText(c as MarkdownNode)).join("")
        : ref.label ?? "";
    }
    case "image":
      return (node as Image).alt ?? "";
    case "list": {
      const list = node as List;
      return list.children
        .map((item, idx) => {
          const marker = list.ordered ? `${(list.start ?? 1) + idx}. ` : "- ";
          return marker + nodeToPlainText(item as MarkdownNode).trimEnd();
        })
        .join("\n");
    }
    case "blockquote":
      return ((node as Blockquote).children as MarkdownNode[])
        .map((child) => nodeToPlainText(child).replace(/^/gm, "> "))
        .join("");
    case "table":
      return (node as Table).children
        .map((row) =>
          ((row as TableRow).children as TableCell[]).map((cell) => nodeToPlainText(cell)).join(" | "),
        )
        .join("\n");
    case "thematicBreak":
      return "---";
    case "break":
      return "\n";
    case "html":
      return (node as Html).value;
    default: {
      const anyNode = node as { children?: MarkdownNode[] };
      if (Array.isArray(anyNode.children)) {
        return anyNode.children.map(nodeToPlainText).join("");
      }
      return "";
    }
  }
}

/**
 * Inline mdast children → styled segments. `break` nodes become a
 * single space here (flat rendering: table cells, user lines); the
 * block renderer uses inlineGroupsFromNodes instead, which splits
 * at breaks into separate visual line groups.
 * Freebuff renderNode cases: strong → BOLD, emphasis → ITALIC,
 * delete → DIM, inlineCode → BOLD + space pad + orange on gray,
 * link → linkFg label only (URL never shown), linkReference →
 * plain label (Freebuff renders it via the plain-text fallback),
 * image → nothing (Freebuff's render path drops images: the
 * nodeToPlainText fallback of an image is empty).
 */
export function inlineSegmentsFromNodes(
  nodes: MarkdownNode[],
  baseColor?: string,
): VisualSegment[] {
  const segments: VisualSegment[] = [];
  const push = (text: string, style: Partial<VisualSegment> = {}) => {
    if (text.length === 0) return;
    segments.push({ text, color: baseColor, ...style });
  };
  const walk = (node: MarkdownNode, style: Partial<VisualSegment>) => {
    switch (node.type) {
      case "text":
        push((node as Text).value, style);
        return;
      case "strong":
        ((node as Strong).children as MarkdownNode[]).forEach((c) =>
          walk(c, { ...style, bold: true }),
        );
        return;
      case "emphasis":
        ((node as Emphasis).children as MarkdownNode[]).forEach((c) =>
          walk(c, { ...style, italic: true }),
        );
        return;
      case "delete":
        ((node as Delete).children as MarkdownNode[]).forEach((c) =>
          walk(c, { ...style, dim: true }),
        );
        return;
      case "inlineCode": {
        const value = (node as InlineCode).value || " ";
        push(` ${value} `, {
          ...style,
          color: markdown.inlineCodeFg,
          backgroundColor: markdown.codeBackground,
          bold: true,
        });
        return;
      }
      case "link": {
        const link = node as Link;
        const label = link.children.length > 0 ? link.children : null;
        if (label) {
          (label as MarkdownNode[]).forEach((c) =>
            walk(c, { ...style, color: markdown.linkFg }),
          );
        } else {
          push(link.url, { ...style, color: markdown.linkFg });
        }
        return;
      }
      case "linkReference": {
        const ref = node as LinkReference;
        (ref.children as MarkdownNode[]).forEach((c) => walk(c, style));
        return;
      }
      case "image":
        // Freebuff parity: images render as nothing in chat.
        return;
      case "break":
        push(" ", style);
        return;
      case "html":
        push((node as Html).value, style);
        return;
      default: {
        const anyNode = node as { children?: MarkdownNode[] };
        if (Array.isArray(anyNode.children)) {
          anyNode.children.forEach((c) => walk(c, style));
        }
        return;
      }
    }
  };
  nodes.forEach((n) => walk(n, {}));
  return segments;
}

/** Inline children split into groups at `break` nodes (hard line breaks). */
export function inlineGroupsFromNodes(
  nodes: MarkdownNode[],
  baseColor?: string,
): VisualSegment[][] {
  const groups: VisualSegment[][] = [[]];
  const pushGroup = (text: string, style: Partial<VisualSegment> = {}) => {
    if (text.length === 0) return;
    (groups[groups.length - 1] as VisualSegment[]).push({ text, color: baseColor, ...style });
  };
  const walk = (node: MarkdownNode, style: Partial<VisualSegment>) => {
    if (node.type === "break") {
      groups.push([]);
      return;
    }
    if (node.type === "text") {
      pushGroup((node as Text).value, style);
      return;
    }
    if (node.type === "strong" || node.type === "emphasis" || node.type === "delete") {
      const next =
        node.type === "strong"
          ? { ...style, bold: true }
          : node.type === "emphasis"
            ? { ...style, italic: true }
            : { ...style, dim: true };
      ((node as { children: MarkdownNode[] }).children ?? []).forEach((c) => walk(c, next));
      return;
    }
    if (node.type === "inlineCode") {
      const value = (node as InlineCode).value || " ";
      pushGroup(` ${value} `, {
        ...style,
        color: markdown.inlineCodeFg,
        backgroundColor: markdown.codeBackground,
        bold: true,
      });
      return;
    }
    if (node.type === "link") {
      const link = node as Link;
      if (link.children.length > 0) {
        (link.children as MarkdownNode[]).forEach((c) =>
          walk(c, { ...style, color: markdown.linkFg }),
        );
      } else {
        pushGroup(link.url, { ...style, color: markdown.linkFg });
      }
      return;
    }
    if (node.type === "linkReference") {
      ((node as LinkReference).children as MarkdownNode[]).forEach((c) => walk(c, style));
      return;
    }
    if (node.type === "image") return;
    if (node.type === "html") {
      pushGroup((node as Html).value, style);
      return;
    }
    const anyNode = node as { children?: MarkdownNode[] };
    if (Array.isArray(anyNode.children)) {
      anyNode.children.forEach((c) => walk(c, style));
    }
  };
  nodes.forEach((n) => walk(n, {}));
  // A trailing break leaves an empty last group; drop empty groups
  // except when the whole paragraph is empty (caller skips those).
  return groups.filter((g) => g.length > 0);
}

/**
 * Parse a short fragment (table cell, user line) as inline Markdown
 * and return its styled segments. The fragment is parsed as a full
 * document; when it is a single paragraph its children are the
 * inline nodes. Anything block-shaped falls back to plain text, so
 * a cell containing a heading marker never grows a heading.
 */
export function renderInlineText(text: string, baseColor?: string): VisualSegment[] {
  if (text.length === 0) return [];
  const root = parseMarkdown(text);
  applyInlineFallbackFormatting(root);
  const first = root.children[0] as MarkdownNode | undefined;
  if (root.children.length === 1 && first?.type === "paragraph") {
    return inlineSegmentsFromNodes((first as Paragraph).children as MarkdownNode[], baseColor);
  }
  return [{ text: nodeToPlainText(root).replace(/\n+/g, " "), color: baseColor }];
}

/**
 * Wrap styled segments into visual lines at `width` columns —
 * the parse-first counterpart of layout.ts wrapText. Words are
 * never split unless a single word is wider than the line; then it
 * is hard-split by terminal cells (wide CJK/emoji chars are never
 * cut in half). Whitespace between words collapses to one space.
 * firstPrefix/contPrefix are prepended to the first / continuation
 * lines (list markers, blockquote `> `) and their widths come out
 * of the line budget.
 */
export function wrapSegments(
  segments: VisualSegment[],
  width: number,
  opts: { firstPrefix?: VisualSegment[]; contPrefix?: VisualSegment[] } = {},
): VisualLine[] {
  const prefixWidth = (segs?: VisualSegment[]): number =>
    (segs ?? []).reduce((n, s) => n + textWidth(s.text), 0);
  const firstW = prefixWidth(opts.firstPrefix);
  const contW = prefixWidth(opts.contPrefix);
  if (width <= 0) return [{ segments }];
  // Atoms: { text, seg } — one word, one whitespace run, or "\n"
  // (forced break). A segment's style rides along with its atoms.
  interface Atom {
    text: string;
    seg: VisualSegment;
    space: boolean;
    br: boolean;
  }
  const atoms: Atom[] = [];
  for (const seg of segments) {
    const parts = seg.text.split(/(\s+)/);
    for (const part of parts) {
      if (part.length === 0) continue;
      if (part.includes("\n")) {
        // Newlines inside a segment (escaped text, multi-line
        // values) force a line break, like a `break` node.
        const sub = part.split("\n");
        sub.forEach((s, i) => {
          if (s.length > 0) atoms.push({ text: s, seg, space: /^\s+$/.test(s), br: false });
          if (i < sub.length - 1) atoms.push({ text: "", seg, space: false, br: true });
        });
      } else {
        atoms.push({ text: part, seg, space: /^\s+$/.test(part), br: false });
      }
    }
  }
  if (atoms.length === 0) return [];
  const lines: VisualLine[] = [];
  let cur: VisualSegment[] = [];
  let curW = 0;
  let lineIdx = 0;
  const budget = (): number => Math.max(1, width - (lineIdx === 0 ? firstW : contW));
  const sameStyle = (a: VisualSegment, b: VisualSegment): boolean =>
    a.color === b.color &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.dim === b.dim &&
    a.strikethrough === b.strikethrough &&
    a.backgroundColor === b.backgroundColor;
  // Push text onto the current line, merging into the previous
  // segment when the style matches — so one styled run stays one
  // segment (like the old inlineSegments), instead of fragmenting
  // into one segment per word.
  const pushStyled = (text: string, style: VisualSegment) => {
    const last = cur[cur.length - 1];
    if (last !== undefined && sameStyle(last, style)) {
      last.text += text;
    } else {
      cur.push({ ...style, text });
    }
    curW += textWidth(text);
  };
  const flush = (force = false) => {
    if (cur.length > 0 || force) {
      // A space atom pushed before a word that then did not fit
      // leaves a trailing space — trim it (wrapText trimmed line
      // ends the same way). Inline-code segments keep their pad
      // (backgroundColor set): the trailing space of ` code ` is
      // part of the code styling, not a wrap artifact.
      while (cur.length > 0) {
        const last = cur[cur.length - 1] as VisualSegment;
        if (last.backgroundColor !== undefined) break;
        const trimmed = last.text.replace(/ +$/, "");
        if (trimmed === last.text) break;
        if (trimmed === "") {
          cur.pop();
          continue;
        }
        last.text = trimmed;
        break;
      }
      const prefix = lineIdx === 0 ? opts.firstPrefix : opts.contPrefix;
      lines.push({ segments: [...(prefix ?? []), ...cur] });
      cur = [];
      curW = 0;
      lineIdx += 1;
    }
  };
  const pushAtom = (atom: Atom) => {
    pushStyled(atom.text, atom.seg);
  };
  let i = 0;
  while (i < atoms.length) {
    const atom = atoms[i] as Atom;
    if (atom.br) {
      flush();
      i += 1;
      continue;
    }
    if (atom.space) {
      // Whitespace between words becomes exactly one space when
      // the next word fits, and is dropped at line starts/ends —
      // EXCEPT when the space is part of a styled segment (the
      // inline-code pad ` code `): the pad's spaces are styling,
      // not wrap artifacts, so a leading/trailing pad space is
      // kept whenever a word follows or precedes it on the line.
      const next = atoms[i + 1];
      const isPad = atom.seg.backgroundColor !== undefined;
      if (curW === 0) {
        if (isPad && next !== undefined && !next.br) pushAtom(atom);
        i += 1;
        continue;
      }
      if (next === undefined || next.br) {
        if (isPad) pushAtom(atom);
        i += 1;
        continue;
      }
      if (curW + 1 <= budget()) {
        pushAtom({ ...atom, text: " " });
      } else {
        flush();
      }
      i += 1;
      continue;
    }
    const w = textWidth(atom.text);
    if (w > budget() && curW === 0) {
      // Single over-long word: hard-split by cells (Freebuff
      // wrapText falls back to character-level breaking).
      let rest = atom.text;
      while (textWidth(rest) > budget()) {
        let chunk = "";
        let chunkW = 0;
        for (const ch of rest) {
          const cw = cellWidth(ch);
          if (chunkW + cw > budget() && chunk !== "") break;
          chunk += ch;
          chunkW += cw;
        }
        pushStyled(chunk, atom.seg);
        flush();
        rest = rest.slice(chunk.length);
      }
      if (rest.length > 0) {
        pushStyled(rest, atom.seg);
      }
      i += 1;
      continue;
    }
    if (curW + w > budget()) {
      flush();
      continue;
    }
    pushAtom(atom);
    i += 1;
  }
  flush();
  return lines;
}

/** Block types that suppress the blank line before them (layout.ts rule). */
export function isTightFollowupType(type: string): boolean {
  return type === "blockquote" || type === "list" || type === "heading" || type === "thematicBreak" || type === "table";
}

/** One blank visual line (renders as one empty row). */
function blankLine(): VisualLine {
  return { segments: [{ text: " " }] };
}

interface BlockOpts {
  baseColor?: string;
  /** Inside a list item: no blank lines between blocks. */
  compact?: boolean;
}

function renderBlocks(
  children: MarkdownNode[],
  width: number,
  opts: BlockOpts,
): VisualLine[] {
  const out: VisualLine[] = [];
  const pushBlank = () => {
    if (out.length === 0) return;
    const last = out[out.length - 1] as VisualLine;
    const lastText = last.segments.map((s) => s.text).join("");
    if (lastText.trim() !== "") out.push(blankLine());
  };
  children.forEach((child, idx) => {
    const next = children[idx + 1] as MarkdownNode | undefined;
    switch (child.type) {
      case "paragraph": {
        const groups = inlineGroupsFromNodes(
          (child as Paragraph).children as MarkdownNode[],
          opts.baseColor,
        );
        for (const group of groups) {
          for (const l of wrapSegments(group, width)) out.push(l);
        }
        if (groups.length === 0) break;
        if (!opts.compact && next && !isTightFollowupType(next.type)) pushBlank();
        break;
      }
      case "heading": {
        const heading = child as Heading;
        const groups = inlineGroupsFromNodes(heading.children as MarkdownNode[], markdown.headingFg);
        for (const group of groups) {
          const bolded = group.map((s) => ({ ...s, bold: true }));
          for (const l of wrapSegments(bolded, width)) out.push(l);
        }
        if (groups.length > 0 && !opts.compact) pushBlank();
        break;
      }
      case "list": {
        for (const l of renderList(child as List, width, opts)) out.push(l);
        if (!opts.compact) pushBlank();
        break;
      }
      case "blockquote": {
        const inner = renderBlocks((child as Blockquote).children as MarkdownNode[], Math.max(1, width - 2), {
          baseColor: markdown.blockquoteTextFg,
        });
        for (const l of inner) {
          const text = l.segments.map((s) => s.text).join("");
          if (text.trim() === "") continue; // Freebuff skips empty lines in quotes
          out.push({
            segments: [{ text: "> ", color: markdown.blockquoteBorderFg }, ...l.segments],
          });
        }
        if (!opts.compact) pushBlank();
        break;
      }
      case "code": {
        const code = child as Code;
        if (code.lang) {
          out.push({ segments: [{ text: `// ${code.lang}`, color: markdown.codeHeaderFg }] });
        }
        const rawLines = code.value.split("\n");
        if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
        for (const raw of rawLines) {
          out.push({
            segments: [
              {
                text: raw === "" ? " " : raw,
                color: markdown.codeTextFg,
                backgroundColor: markdown.codeBackground,
              },
            ],
          });
        }
        if (!opts.compact) pushBlank();
        break;
      }
      case "table": {
        for (const l of renderTable(child as Table, width)) out.push(l);
        if (!opts.compact) pushBlank();
        break;
      }
      case "thematicBreak": {
        const w = Math.max(10, Math.min(width, 80));
        out.push({ segments: [{ text: "─".repeat(w), color: markdown.dividerFg }] });
        if (!opts.compact) pushBlank();
        break;
      }
      case "html": {
        for (const raw of (child as Html).value.split("\n")) {
          if (raw.trim() === "") continue;
          for (const l of wrapSegments([{ text: raw, color: opts.baseColor }], width)) out.push(l);
        }
        break;
      }
      case "definition":
        // Link definitions are invisible (Freebuff renders nothing).
        break;
      default: {
        const text = nodeToPlainText(child).trim();
        if (text.length > 0) {
          for (const l of wrapSegments([{ text, color: opts.baseColor }], width)) out.push(l);
          if (!opts.compact && next && !isTightFollowupType(next.type)) pushBlank();
        }
        break;
      }
    }
  });
  return out;
}

function renderList(list: List, width: number, opts: BlockOpts): VisualLine[] {
  const out: VisualLine[] = [];
  const start = list.start ?? 1;
  list.children.forEach((item, idx) => {
    const listItem = item as ListItem;
    const marker =
      listItem.checked === true
        ? "[x]"
        : listItem.checked === false
          ? "[ ]"
          : list.ordered
            ? `${start + idx}.`
            : "-";
    const markerText = `${marker} `;
    const contentWidth = Math.max(1, width - markerText.length);
    const itemLines = renderBlocks(listItem.children as MarkdownNode[], contentWidth, {
      ...opts,
      compact: true,
    });
    if (itemLines.length === 0) {
      out.push({
        segments: [
          { text: marker, color: markdown.listBulletFg },
          { text: " " },
        ],
      });
      return;
    }
    itemLines.forEach((l, li) => {
      if (li === 0) {
        out.push({
          segments: [
            { text: marker, color: markdown.listBulletFg },
            { text: " " },
            ...l.segments,
          ],
        });
      } else {
        out.push({
          segments: [{ text: " ".repeat(markerText.length) }, ...l.segments],
        });
      }
    });
  });
  return out;
}

type TableAlign = "left" | "center" | "right";

/**
 * Box-drawing table (Freebuff markdown-renderer.tsx renderTable).
 * Borders ┌┬┐├┼┤└┴┘ in dividerFg, header row bold in headingFg,
 * body cells in text color. Cells are parsed FIRST (inline AST →
 * segments), then wrapped per column width — the old layout.ts
 * tableLines wrapped raw cell text and parsed inline per wrapped
 * line, so a wrap inside **bold** leaked markers here too.
 * Column alignment comes from mdast's table.align (parsed from the
 * separator row: `:---`, `---:`, `:---:`). Proportional shrink
 * when the table is wider than the terminal (Freebuff renderTable).
 */
export function renderTable(table: Table, width: number): VisualLine[] {
  const aligns: TableAlign[] = (table.align ?? []).map((a) =>
    a === "center" ? "center" : a === "right" ? "right" : "left",
  );
  const rows = table.children as TableRow[];
  if (rows.length === 0) return [];
  // Cells as styled segments (parsed first — no markers survive).
  const cellSegs: VisualSegment[][][] = rows.map((row) =>
    (row.children as TableCell[]).map((cell) =>
      inlineSegmentsFromNodes(cell.children as MarkdownNode[]),
    ),
  );
  const cols = Math.max(0, ...rows.map((r) => r.children.length));
  if (cols === 0) return [];
  const cellAt = (row: VisualSegment[][], i: number): VisualSegment[] => row[i] ?? [];
  const segWidth = (segs: VisualSegment[]): number =>
    segs.reduce((n, s) => n + textWidth(s.text), 0);
  const natural: number[] = [];
  for (let i = 0; i < cols; i++) {
    let m = 1;
    for (const row of cellSegs) m = Math.max(m, segWidth(cellAt(row, i)));
    natural.push(m);
  }
  const available = Math.max(cols, width - (3 * cols + 1));
  const colW = [...natural];
  if (colW.reduce((a, b) => a + b, 0) > available) {
    const total = colW.reduce((a, b) => a + b, 0);
    for (let i = 0; i < cols; i++) {
      colW[i] = Math.max(1, Math.floor((colW[i] as number) * (available / total)));
    }
    let sum = colW.reduce((a, b) => a + b, 0);
    while (sum > available) {
      let widest = -1;
      for (let i = 0; i < cols; i++) {
        if ((colW[i] as number) > 1 && (widest === -1 || (colW[i] as number) > (colW[widest] as number))) widest = i;
      }
      if (widest === -1) break;
      colW[widest] = (colW[widest] as number) - 1;
      sum -= 1;
    }
    let leftover = available - colW.reduce((a, b) => a + b, 0);
    while (leftover > 0) {
      let target = -1;
      for (let i = 0; i < cols; i++) {
        if ((colW[i] as number) < (natural[i] as number) && (target === -1 || (natural[i] as number) - (colW[i] as number) > (natural[target] as number) - (colW[target] as number))) target = i;
      }
      if (target === -1) break;
      colW[target] = (colW[target] as number) + 1;
      leftover -= 1;
    }
  }
  const border = (left: string, mid: string, right: string): VisualLine => ({
    segments: [
      {
        text: left + colW.map((w) => "─".repeat(w + 2)).join(mid) + right,
        color: markdown.dividerFg,
      },
    ],
  });
  const out: VisualLine[] = [border("┌", "┬", "┐")];
  const renderRow = (row: VisualSegment[][], isHeader: boolean) => {
    const wrappedCells: VisualLine[][] = [];
    let height = 1;
    for (let i = 0; i < cols; i++) {
      const rawSegs = cellAt(row, i);
      // Header cells: plain segments go bold + heading yellow;
      // inline code keeps its orange on gray, links keep blue
      // (same rule as the old layout.ts tableLines).
      const segs = isHeader
        ? rawSegs.map((s) =>
            s.backgroundColor !== undefined
              ? s
              : { ...s, bold: true, color: s.color ?? markdown.headingFg },
          )
        : rawSegs;
      const wrapped = wrapSegments(segs, colW[i] as number);
      wrappedCells.push(wrapped.length > 0 ? wrapped : [{ segments: [{ text: " " }] }]);
      height = Math.max(height, wrapped.length > 0 ? wrapped.length : 1);
    }
    for (let li = 0; li < height; li++) {
      const segments: VisualSegment[] = [{ text: "│ ", color: markdown.dividerFg }];
      for (let i = 0; i < cols; i++) {
        const lineSegs = ((wrappedCells[i] as VisualLine[])[li] ?? { segments: [{ text: " " }] }).segments;
        const visW = lineSegs.reduce((n, s) => n + textWidth(s.text), 0);
        const pad = Math.max(0, (colW[i] as number) - visW);
        const align = aligns[i] ?? "left";
        const lead = align === "right" ? pad : align === "center" ? Math.floor(pad / 2) : 0;
        const trail = pad - lead;
        segments.push({ text: " ".repeat(lead) });
        segments.push(...lineSegs);
        segments.push({ text: " ".repeat(trail) });
        segments.push({ text: i < cols - 1 ? " │ " : " │", color: markdown.dividerFg });
      }
      out.push({ segments });
    }
  };
  rows.forEach((row, ri) => {
    renderRow(cellSegs[ri] as VisualSegment[][], ri === 0);
    if (ri === 0 && rows.length > 1) out.push(border("├", "┼", "┤"));
  });
  out.push(border("└", "┴", "┘"));
  return out;
}

export interface MarkdownTextResult {
  lines: VisualLine[];
  /** First block is a tight followup (list/blockquote/heading/divider/table). */
  startsTight: boolean;
  /** Text part starts with a blank line (leading newline). */
  startsBlank: boolean;
  /** Text part ends with a blank line (trailing newline). */
  endsBlank: boolean;
}

/**
 * Render one TEXT part (fenced code already split off by
 * splitMessageParts) into visual lines at `width` columns.
 * Parse-first: the whole part goes through remark, blocks render
 * from the AST, inline spans wrap as styled segments. No raw
 * Markdown marker can leak, at any width.
 *
 * `baseColor` is the message's foreground: Freebuff
 * message-block.tsx:188 passes `textColor ?? theme.foreground`
 * into its blocks renderer, and plain `text` nodes inherit it
 * (markdown-renderer.tsx case 'text' returns the raw string with
 * no color of its own). Without it the plain paragraph segments
 * carry NO color and Ink renders the terminal default foreground
 * (gray on Reza's Termux) — only semantic elements (heading,
 * inline code, link, blockquote, code block) set their own colors.
 */
export function renderMarkdownText(text: string, width: number, baseColor?: string): MarkdownTextResult {
  const startsBlank = /^\s*\n/.test(text);
  const endsBlank = /\n\s*$/.test(text);
  const root = parseMarkdown(text);
  applyInlineFallbackFormatting(root);
  const first = root.children[0] as MarkdownNode | undefined;
  const startsTight = first !== undefined && isTightFollowupType(first.type);
  let lines = renderBlocks(root.children as MarkdownNode[], width, { baseColor });
  // Trailing blank lines are the message's own (flattenMessages
  // appends one blank line per message); drop them here.
  while (lines.length > 0) {
    const last = lines[lines.length - 1] as VisualLine;
    if (last.segments.map((s) => s.text).join("").trim() !== "") break;
    lines = lines.slice(0, -1);
  }
  return { lines, startsTight, startsBlank, endsBlank };
}
