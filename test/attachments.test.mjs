// Unit tests for the large-paste attachment system (src/ui/paste.ts
// + src/ui/attachments.ts). Run after build: npm run build && npm test
import test from "node:test";
import assert from "node:assert/strict";
import {
  LONG_TEXT_THRESHOLD,
  attachmentMetaLine,
  buildSendContent,
  countLines,
  createTextAttachment,
  deriveTitle,
  detectContentType,
  truncateEnd,
} from "../dist/ui/attachments.js";
import { createPasteAssembler, stripAnsi } from "../dist/ui/paste.js";

// --- Threshold (Freebuff utils/strings.ts:38) ---

test("LONG_TEXT_THRESHOLD is Freebuff's 2000", () => {
  assert.equal(LONG_TEXT_THRESHOLD, 2000);
});

// --- Attachment model ---

const MD_DOC = `# TASK: REPLICATE FREEBUFF
Tulis panduan lengkap.

- pertama
- kedua

Lihat [docs](https://example.com) untuk detail.`;

test("createTextAttachment keeps the full content and derives card fields", () => {
  const a = createTextAttachment(MD_DOC);
  assert.equal(a.kind, "text");
  assert.equal(a.content, MD_DOC);
  assert.equal(a.charCount, MD_DOC.length);
  assert.equal(a.title, "TASK: REPLICATE FREEBUFF");
  assert.equal(a.contentType, "Markdown");
  assert.equal(a.lineCount, 7);
  assert.equal(a.preview, MD_DOC.slice(0, 100).replace(/\n/g, " "));
  assert.match(a.id, /^[0-9a-f-]{36}$/);
});

test("deriveTitle strips heading/list markers, falls back when blank", () => {
  assert.equal(deriveTitle("# Judul\nisi"), "Judul");
  assert.equal(deriveTitle("\n\n- item satu\n- item dua"), "item satu");
  assert.equal(deriveTitle("1. langkah pertama\n2. kedua"), "langkah pertama");
  assert.equal(deriveTitle("   \n  \n"), "Pasted text");
  assert.equal(deriveTitle(""), "Pasted text");
});

test("detectContentType: Markdown only when markers are present", () => {
  assert.equal(detectContentType(MD_DOC), "Markdown");
  assert.equal(detectContentType("```js\nconst x = 1;\n```"), "Markdown");
  assert.equal(detectContentType("Halo dunia, ini teks biasa saja."), "Text");
  assert.equal(detectContentType("baris satu\nbaris dua\nbaris tiga"), "Text");
});

test("countLines handles LF, CRLF and lone CR", () => {
  assert.equal(countLines("a\nb\nc"), 3);
  assert.equal(countLines("a\r\nb\r\nc"), 3);
  assert.equal(countLines("a\rb\rc"), 3);
  assert.equal(countLines(""), 0);
  assert.equal(countLines("satu"), 1);
  assert.equal(countLines("a\nb\n"), 2);
});

test("attachmentMetaLine follows Reza's format", () => {
  assert.equal(
    attachmentMetaLine({ contentType: "Markdown", lineCount: 191 }),
    "📄 Markdown · 191 baris",
  );
  assert.equal(
    attachmentMetaLine({ contentType: "Text", lineCount: 1 }),
    "📄 Text · 1 baris",
  );
});

test("truncateEnd shortens visually with an ellipsis, keeps short strings", () => {
  assert.equal(truncateEnd("TASK: REPLICATE FREEBUFF", 10), "TASK: REP…");
  assert.equal(truncateEnd("pendek", 10), "pendek");
});

// --- Send composition (Freebuff send-message.ts:175-183) ---

test("buildSendContent: draft first, then [Pasted Text] blocks in order", () => {
  const a = createTextAttachment("ISI LAMPIRAN\nbaris dua");
  const b = createTextAttachment("lampiran kedua");
  assert.equal(
    buildSendContent("tolong review ini", [a, b]),
    "tolong review ini\n\n[Pasted Text]\nISI LAMPIRAN\nbaris dua\n\n[Pasted Text]\nlampiran kedua",
  );
});

test("buildSendContent: attachments alone when the draft is empty", () => {
  const a = createTextAttachment("ISI SAJA");
  assert.equal(buildSendContent("", [a]), "[Pasted Text]\nISI SAJA");
});

test("buildSendContent: no attachments returns the draft untouched", () => {
  assert.equal(buildSendContent("halo", []), "halo");
});

test("buildSendContent preserves line breaks and Unicode byte-identically", () => {
  const content = "baris 1\nbaris 2\r\nbaris 3\nemoji 👨‍👩‍👧 café — “kutip”";
  const a = createTextAttachment(content);
  const out = buildSendContent("", [a]);
  assert.ok(out.includes(content), "full content must survive verbatim");
});

// --- ANSI strip (Freebuff Bun.stripANSI on paste) ---

test("stripAnsi removes CSI/OSC but keeps visible Unicode", () => {
  assert.equal(stripAnsi("a\x1b[31mmerah\x1b[0mb"), "amerahb");
  assert.equal(stripAnsi("x\x1b]8;;https://example.com\x07link\x1b]8;;\x07y"), "xlinky");
  assert.equal(stripAnsi("emoji 👨‍👩‍👧 café"), "emoji 👨‍👩‍👧 café");
  assert.equal(stripAnsi("a\nb"), "a\nb");
});

// --- Bracketed paste assembler ---

test("assembler: one delivery, markers + payload", () => {
  const asm = createPasteAssembler();
  const r = asm.feed("[200~halo dunia[201~");
  assert.deepEqual(r.pastes, ["halo dunia"]);
  assert.equal(r.plain, "");
  assert.equal(r.collecting, false);
});

test("assembler: payload split across deliveries stays one paste", () => {
  const asm = createPasteAssembler();
  let r = asm.feed("[200~baris satu\nbaris dua ");
  assert.deepEqual(r.pastes, []);
  assert.equal(r.collecting, true);
  assert.equal(r.plain, "");
  r = asm.feed("baris tiga[201~");
  assert.deepEqual(r.pastes, ["baris satu\nbaris dua baris tiga"]);
  assert.equal(r.collecting, false);
});

test("assembler: plain text before a start marker and after an end marker", () => {
  const asm = createPasteAssembler();
  const r = asm.feed("ab[200~PASTE[201~cd");
  assert.deepEqual(r.pastes, ["PASTE"]);
  assert.equal(r.plain, "abcd");
});

test("assembler: two pastes in one delivery", () => {
  const asm = createPasteAssembler();
  const r = asm.feed("[200~satu[201~x[200~dua[201~");
  assert.deepEqual(r.pastes, ["satu", "dua"]);
  assert.equal(r.plain, "x");
});

test("assembler: a marker split across deliveries is held, not typed", () => {
  const asm = createPasteAssembler();
  let r = asm.feed("teks[20");
  assert.equal(r.plain, "teks");
  assert.equal(r.collecting, false);
  r = asm.feed("0~ISI[201~");
  assert.deepEqual(r.pastes, ["ISI"]);
  assert.equal(r.plain, "");
});

test("assembler: a lone end marker with no open paste is swallowed", () => {
  const asm = createPasteAssembler();
  const r = asm.feed("abc[201~def");
  assert.deepEqual(r.pastes, []);
  assert.equal(r.plain, "abcdef");
});

test("assembler: ESC-prefixed markers are accepted too", () => {
  const asm = createPasteAssembler();
  const r = asm.feed("\x1b[200~isi\x1b[201~");
  assert.deepEqual(r.pastes, ["isi"]);
});

test("assembler: ANSI inside the payload is stripped, line breaks kept", () => {
  const asm = createPasteAssembler();
  const r = asm.feed("[200~a\x1b[31mmerah\x1b[0m\nb[201~");
  assert.deepEqual(r.pastes, ["amerah\nb"]);
});

test("assembler: reset drops a half-open paste", () => {
  const asm = createPasteAssembler();
  asm.feed("[200~setengah");
  assert.equal(asm.collecting, true);
  asm.reset();
  assert.equal(asm.collecting, false);
  const r = asm.feed("lanjut[201~");
  assert.deepEqual(r.pastes, []);
  assert.equal(r.plain, "lanjut");
});
