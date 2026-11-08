// Lightweight, dependency-free syntax highlighter for code blocks.
// Produces token segments that CodeBlock renders with theme.syntax colors.
// No new dependency: a single-pass regex tokenizer is enough for the
// chat TUI and for the future coding-agent code viewer.
//
// FreeBuff pattern adapted: the agent renders code with a consistent theme
// instead of each component inventing its own colors.

import type { SyntaxTokenKind } from "../theme.js";

export interface SyntaxToken {
  text: string;
  kind: SyntaxTokenKind;
}

const KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "do", "switch", "case", "break", "continue", "class", "extends", "import",
  "export", "from", "default", "new", "typeof", "instanceof", "in", "of",
  "try", "catch", "finally", "throw", "async", "await", "yield", "this",
  "super", "static", "get", "set", "void", "delete", "null", "undefined",
  "true", "false", "def", "print", "elif", "except", "pass", "lambda",
  "with", "as", "raise", "global", "nonlocal", "assert", "del", "and",
  "or", "not", "is", "None", "True", "False", "public", "private",
  "protected", "interface", "type", "enum", "implements", "package",
  "fn", "struct", "impl", "match", "mut", "pub", "use", "mod", "where",
  "echo", "fi", "then", "done", "select", "local", "readonly",
]);

/**
 * Tokenize one line of code. Single pass, left to right, so matches never
 * overlap. Comment and string runs win over keywords inside them.
 */
export function tokenizeLine(line: string): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  // Groups: 1 comment, 2 string, 3 number, 4 identifier, 5 other.
  const re =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d+(?:\.\d+)?)\b|([A-Za-z_$][A-Za-z0-9_$]*)|(\s+|.)/g;
  let m: RegExpExecArray | null;
  let lastEnd = 0;
  while ((m = re.exec(line)) !== null) {
    // Any gap between matches is plain text (should not happen with the
    // catch-all group, but stay safe).
    if (m.index > lastEnd) {
      tokens.push({ text: line.slice(lastEnd, m.index), kind: "plain" });
    }
    const [full, comment, str, num, ident] = m;
    if (comment !== undefined) {
      tokens.push({ text: full, kind: "comment" });
    } else if (str !== undefined) {
      tokens.push({ text: full, kind: "string" });
    } else if (num !== undefined) {
      tokens.push({ text: full, kind: "number" });
    } else if (ident !== undefined) {
      if (KEYWORDS.has(ident)) {
        tokens.push({ text: full, kind: "keyword" });
      } else if (/^[A-Z][A-Za-z0-9_$]*$/.test(ident)) {
        tokens.push({ text: full, kind: "type" });
      } else {
        // Identifier followed by "(" is a function call.
        const rest = line.slice(m.index + full.length);
        if (/^\s*\(/.test(rest)) tokens.push({ text: full, kind: "function" });
        else tokens.push({ text: full, kind: "variable" });
      }
    } else {
      tokens.push({ text: full, kind: /^\s+$/.test(full) ? "plain" : "punctuation" });
    }
    lastEnd = m.index + full.length;
    if (full.length === 0) re.lastIndex++;
  }
  if (lastEnd < line.length) {
    tokens.push({ text: line.slice(lastEnd), kind: "plain" });
  }
  return tokens;
}

/** Tokenize a whole code block, line by line. */
export function tokenizeCode(code: string): SyntaxToken[][] {
  return code.split("\n").map((line) => tokenizeLine(line));
}

/** Split a message into text and fenced code blocks (```lang ... ```). */
export interface MessagePart {
  type: "text" | "code";
  lang: string;
  content: string;
}

export function splitMessageParts(content: string): MessagePart[] {
  const parts: MessagePart[] = [];
  const re = /```([A-Za-z0-9_+-]*)\n?([\s\S]*?)```/g;
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m.index > lastEnd) {
      parts.push({ type: "text", lang: "", content: content.slice(lastEnd, m.index) });
    }
    parts.push({ type: "code", lang: m[1] ?? "", content: (m[2] ?? "").replace(/\n$/, "") });
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd < content.length) {
    parts.push({ type: "text", lang: "", content: content.slice(lastEnd) });
  }
  if (parts.length === 0) parts.push({ type: "text", lang: "", content });
  return parts;
}
