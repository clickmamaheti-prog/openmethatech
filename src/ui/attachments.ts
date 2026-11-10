// Large-paste text attachments for the MethaTech TUI.
//
// ADOPTED FROM FREEBUFF (clone commit 5d8bd24, Apache-2.0):
// - Threshold: `LONG_TEXT_THRESHOLD = 2000` — text LONGER than this
//   (strictly greater) becomes an attachment instead of inline
//   insertion (cli/src/utils/strings.ts:38, :166, :229).
// - Storage: `PendingTextAttachment { kind: 'text', id, content,
//   preview, charCount }` — the FULL pasted text is kept in
//   `content`; `preview` is the first ~100 chars with newlines
//   replaced by spaces (cli/src/chat.tsx:2495-2510).
// - Send: on submit the attachments are appended to the message as
//   `[Pasted Text]\n<content>`, joined with blank lines, after the
//   plain draft text (or alone when there is no draft)
//   (cli/src/hooks/helpers/send-message.ts:175-183). The agent
//   receives the whole content — never just a filename or a
//   placeholder.
// - Card: a bordered card with a preview and a footer
//   (cli/src/components/text-attachment-card.tsx — width 24,
//   preview max 2 lines, footer "📄 N chars"), shown in a banner
//   above the input (pending-attachments-banner.tsx), removable
//   with an X button (attachment-card.tsx).
// - Remove: dropping the card drops the pending attachment —
//   nothing orphaned is sent (chat-store.ts removePendingAttachment).
//
// METHATECH ADAPTATIONS (documented differences, not Freebuff):
// - Card content follows Reza's spec (his reference screenshot):
//   a TITLE (first non-empty line), a CONTENT TYPE (Markdown /
//   Text, detected), and a LINE COUNT — Freebuff's card shows only
//   a preview + char count. The full first line is kept in `title`;
//   truncation with an ellipsis happens only at render time, so
//   the real title is never lost from the metadata.
// - EDIT: Freebuff has NO edit for text attachments (remove only).
//   Reza asked for edit; MethaTech implements it by expanding the
//   newest card back into the draft for editing as plain text and
//   dropping the card. Sending afterwards sends the edited text
//   inline — the paste threshold applies to paste events only, not
//   to edits.
// - REMOVE/EDIT KEYS: Freebuff's cards are mouse-clickable.
//   MethaTech has mouse reporting but no click hit-test, so
//   Ctrl+X removes and Ctrl+E edits the most recent card (LIFO).
// - No in-draft cursor: MethaTech's draft is a plain string, so a
//   short paste is always appended at the end (Freebuff inserts at
//   cursorPosition).

/** Threshold for treating pasted text as an attachment instead of
    inline insertion. Text longer than this value (not equal)
    becomes an attachment — Freebuff utils/strings.ts:38. */
export const LONG_TEXT_THRESHOLD = 2000;

export type AttachmentContentType = "Markdown" | "Text";

/** A pending large-paste text attachment (Freebuff
    types/store.ts PendingTextAttachment + Reza's card fields). */
export interface PendingTextAttachment {
  kind: "text";
  id: string;
  /** The FULL pasted text — kept verbatim (ANSI-stripped only). */
  content: string;
  /** First ~100 chars, newlines replaced with spaces (Freebuff
      chat.tsx:2497). Used by the history card only. */
  preview: string;
  charCount: number;
  /** First non-empty line, heading/list markers stripped (full
      line kept here; render truncates with an ellipsis). */
  title: string;
  contentType: AttachmentContentType;
  lineCount: number;
}

/** Compact metadata stored on a sent user message so the history
    can render the card line without keeping the full text twice
    (the content already lives in the agent history). */
export interface SentAttachmentMeta {
  title: string;
  contentType: AttachmentContentType;
  lineCount: number;
  charCount: number;
}

export function toSentMeta(a: PendingTextAttachment): SentAttachmentMeta {
  return {
    title: a.title,
    contentType: a.contentType,
    lineCount: a.lineCount,
    charCount: a.charCount,
  };
}

/** Number of lines (`\n`-separated; CRLF and lone CR count as one
    break each). A trailing line break does not add an empty last
    line: "a\nb\n" is 2 lines, not 3. */
export function countLines(content: string): number {
  if (content.length === 0) return 0;
  const parts = content.split(/\r\n|\r|\n/);
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

/** First non-empty line, trimmed, with a leading Markdown heading
    (`# `) or list marker (`- `, `1. `) stripped so the card title
    reads like the document's own title. Falls back to "Pasted
    text" when there is no non-empty line. */
export function deriveTitle(content: string): string {
  for (const raw of content.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    return line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .trim();
  }
  return "Pasted text";
}

const MARKDOWN_PATTERNS = [
  /^#{1,6}\s+\S/, // ATX heading
  /^```/, // fenced code block
  /^~~~/, // fenced code block (tilde)
  /^\s*[-*+]\s+\S/, // unordered list
  /^\s*\d+[.)]\s+\S/, // ordered list
  /^>\s+\S/, // blockquote
  /\[[^\]]+\]\([^)]+\)/, // link [text](url)
  /\*\*[^*]+\*\*/, // bold
  /__[^_]+__/, // bold (underscore)
  /^\|.*\|$/, // table row
];

/** "Markdown" when any line looks like Markdown, else "Text".
    Deliberately conservative: a plain paragraph of prose with no
    markers is Text, even inside a .md paste. */
export function detectContentType(content: string): AttachmentContentType {
  const lines = content.split(/\r\n|\r|\n/).slice(0, 20);
  for (const line of lines) {
    if (MARKDOWN_PATTERNS.some((re) => re.test(line))) return "Markdown";
  }
  return "Text";
}

/** Build a pending attachment from pasted text (Freebuff
    chat.tsx:2495-2510 shape + card fields). */
export function createTextAttachment(content: string): PendingTextAttachment {
  return {
    kind: "text",
    id: crypto.randomUUID(),
    content,
    preview: content.slice(0, 100).replace(/\n/g, " "),
    charCount: content.length,
    title: deriveTitle(content),
    contentType: detectContentType(content),
    lineCount: countLines(content),
  };
}

/** Card meta line, Reza's format: `📄 Markdown · 191 baris`. */
export function attachmentMetaLine(a: {
  contentType: AttachmentContentType;
  lineCount: number;
}): string {
  return `📄 ${a.contentType} · ${a.lineCount} baris`;
}

/** Truncate a string for display with a trailing ellipsis (visual
    only — the stored value is never shortened). */
export function truncateEnd(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Compose the text that is actually sent to the agent (Freebuff
 * hooks/helpers/send-message.ts:175-183): the plain draft first,
 * then one `[Pasted Text]` block per attachment in paste order,
 * separated by blank lines. The full content of every attachment
 * is included — line breaks, Unicode and Markdown intact.
 */
export function buildSendContent(
  draft: string,
  attachments: PendingTextAttachment[],
): string {
  if (attachments.length === 0) return draft;
  const blocks = attachments
    .map((att) => `[Pasted Text]\n${att.content}`)
    .join("\n\n");
  return draft ? `${draft}\n\n${blocks}` : blocks;
}
