// Terminal cell widths — pure, no Ink/React. Split out of layout.ts
// so the Markdown renderer (markdown.ts) can measure text without a
// circular import: layout.ts imports markdown.ts, markdown.ts imports
// this module, and layout.ts re-exports these two functions.
/**
 * Cell width of one Unicode character on a terminal (Freebuff
 * cli/src/utils/markdown-renderer.tsx wrapText uses string-width).
 * Wide East-Asian / emoji chars occupy 2 cells, combining marks and
 * zero-width chars occupy 0, everything else 1. Without this, lines
 * with CJK text or emoji wrap at the wrong column on Termux (JS
 * string length counts them as 1).
 */
export function cellWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp === 0) return 0;
  // Combining marks, zero-width, variation selectors: 0 cells.
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x0591 && cp <= 0x05bd) ||
    (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) ||
    (cp >= 0x0670 && cp <= 0x0670) ||
    (cp >= 0x06d6 && cp <= 0x06dc) ||
    (cp >= 0x0e31 && cp <= 0x0e3a) ||
    (cp >= 0x0e47 && cp <= 0x0e4e) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20f0) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff
  ) {
    return 0;
  }
  // Wide / fullwidth (East Asian Wide + Fullwidth + emoji blocks).
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x231a && cp <= 0x231b) ||
    (cp >= 0x2329 && cp <= 0x232a) ||
    (cp >= 0x23e9 && cp <= 0x23ec) ||
    (cp >= 0x23f0 && cp <= 0x23f0) ||
    (cp >= 0x23f3 && cp <= 0x23f3) ||
    (cp >= 0x25fd && cp <= 0x25fe) ||
    (cp >= 0x2614 && cp <= 0x2615) ||
    (cp >= 0x2648 && cp <= 0x2653) ||
    (cp >= 0x267f && cp <= 0x267f) ||
    (cp >= 0x2693 && cp <= 0x2693) ||
    (cp >= 0x26a1 && cp <= 0x26a1) ||
    (cp >= 0x26aa && cp <= 0x26ab) ||
    (cp >= 0x26bd && cp <= 0x26be) ||
    (cp >= 0x26c4 && cp <= 0x26c5) ||
    (cp >= 0x26ce && cp <= 0x26ce) ||
    (cp >= 0x26d4 && cp <= 0x26d4) ||
    (cp >= 0x26ea && cp <= 0x26ea) ||
    (cp >= 0x26f2 && cp <= 0x26f3) ||
    (cp >= 0x26f5 && cp <= 0x26f5) ||
    (cp >= 0x26fa && cp <= 0x26fa) ||
    (cp >= 0x26fd && cp <= 0x26fd) ||
    (cp >= 0x2705 && cp <= 0x2705) ||
    (cp >= 0x270a && cp <= 0x270b) ||
    (cp >= 0x2728 && cp <= 0x2728) ||
    (cp >= 0x274c && cp <= 0x274c) ||
    (cp >= 0x274e && cp <= 0x274e) ||
    (cp >= 0x2753 && cp <= 0x2755) ||
    (cp >= 0x2757 && cp <= 0x2757) ||
    (cp >= 0x2795 && cp <= 0x2797) ||
    (cp >= 0x27b0 && cp <= 0x27b0) ||
    (cp >= 0x27bf && cp <= 0x27bf) ||
    (cp >= 0x2b1b && cp <= 0x2b1c) ||
    (cp >= 0x2b50 && cp <= 0x2b50) ||
    (cp >= 0x2b55 && cp <= 0x2b55) ||
    (cp >= 0x2e80 && cp <= 0x2e99) ||
    (cp >= 0x2e9b && cp <= 0x2ef3) ||
    (cp >= 0x2f00 && cp <= 0x2fd5) ||
    (cp >= 0x2ff0 && cp <= 0x2ffb) ||
    (cp >= 0x3000 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x3096) ||
    (cp >= 0x3099 && cp <= 0x30ff) ||
    (cp >= 0x3105 && cp <= 0x312f) ||
    (cp >= 0x3131 && cp <= 0x318e) ||
    (cp >= 0x3190 && cp <= 0x31e3) ||
    (cp >= 0x31f0 && cp <= 0x321e) ||
    (cp >= 0x3220 && cp <= 0x3247) ||
    (cp >= 0x3250 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0xa48c) ||
    (cp >= 0xa490 && cp <= 0xa4c6) ||
    (cp >= 0xa960 && cp <= 0xa97c) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe52) ||
    (cp >= 0xfe54 && cp <= 0xfe66) ||
    (cp >= 0xfe68 && cp <= 0xfe6b) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x16fe0 && cp <= 0x16fe4) ||
    (cp >= 0x17000 && cp <= 0x187f7) ||
    (cp >= 0x18800 && cp <= 0x18cd5) ||
    (cp >= 0x18d00 && cp <= 0x18d08) ||
    (cp >= 0x1aff0 && cp <= 0x1afff) ||
    (cp >= 0x1b000 && cp <= 0x1b122) ||
    (cp >= 0x1b150 && cp <= 0x1b152) ||
    (cp >= 0x1b164 && cp <= 0x1b167) ||
    (cp >= 0x1b170 && cp <= 0x1b2fb) ||
    (cp >= 0x1f004 && cp <= 0x1f004) ||
    (cp >= 0x1f0cf && cp <= 0x1f0cf) ||
    (cp >= 0x1f18e && cp <= 0x1f18e) ||
    (cp >= 0x1f191 && cp <= 0x1f19a) ||
    (cp >= 0x1f200 && cp <= 0x1f202) ||
    (cp >= 0x1f210 && cp <= 0x1f23b) ||
    (cp >= 0x1f240 && cp <= 0x1f248) ||
    (cp >= 0x1f250 && cp <= 0x1f251) ||
    (cp >= 0x1f260 && cp <= 0x1f265) ||
    (cp >= 0x1f300 && cp <= 0x1f320) ||
    (cp >= 0x1f32d && cp <= 0x1f335) ||
    (cp >= 0x1f337 && cp <= 0x1f37c) ||
    (cp >= 0x1f37e && cp <= 0x1f393) ||
    (cp >= 0x1f3a0 && cp <= 0x1f3ca) ||
    (cp >= 0x1f3cf && cp <= 0x1f3d3) ||
    (cp >= 0x1f3e0 && cp <= 0x1f3f0) ||
    (cp >= 0x1f3f4 && cp <= 0x1f3f4) ||
    (cp >= 0x1f3f8 && cp <= 0x1f43e) ||
    (cp >= 0x1f440 && cp <= 0x1f440) ||
    (cp >= 0x1f442 && cp <= 0x1f4fc) ||
    (cp >= 0x1f4ff && cp <= 0x1f53d) ||
    (cp >= 0x1f54b && cp <= 0x1f54e) ||
    (cp >= 0x1f550 && cp <= 0x1f567) ||
    (cp >= 0x1f57a && cp <= 0x1f57a) ||
    (cp >= 0x1f595 && cp <= 0x1f596) ||
    (cp >= 0x1f5a4 && cp <= 0x1f5a4) ||
    (cp >= 0x1f5fb && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6c5) ||
    (cp >= 0x1f6cc && cp <= 0x1f6cc) ||
    (cp >= 0x1f6d0 && cp <= 0x1f6d2) ||
    (cp >= 0x1f6d5 && cp <= 0x1f6d7) ||
    (cp >= 0x1f6dc && cp <= 0x1f6df) ||
    (cp >= 0x1f6eb && cp <= 0x1f6ec) ||
    (cp >= 0x1f6f4 && cp <= 0x1f6fc) ||
    (cp >= 0x1f7e0 && cp <= 0x1f7eb) ||
    (cp >= 0x1f7f0 && cp <= 0x1f7f0) ||
    (cp >= 0x1f90c && cp <= 0x1f93a) ||
    (cp >= 0x1f93c && cp <= 0x1f945) ||
    (cp >= 0x1f947 && cp <= 0x1f978) ||
    (cp >= 0x1f97a && cp <= 0x1f97a) ||
    (cp >= 0x1f97c && cp <= 0x1f9cb) ||
    (cp >= 0x1f9cd && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1fa74) ||
    (cp >= 0x1fa78 && cp <= 0x1fa7c) ||
    (cp >= 0x1fa80 && cp <= 0x1fa86) ||
    (cp >= 0x1fa90 && cp <= 0x1faac) ||
    (cp >= 0x1fab0 && cp <= 0x1faba) ||
    (cp >= 0x1fac0 && cp <= 0x1fac5) ||
    (cp >= 0x1fad0 && cp <= 0x1fad9) ||
    (cp >= 0x1fae0 && cp <= 0x1fae7) ||
    (cp >= 0x1faf0 && cp <= 0x1faf6) ||
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Terminal cell width of a string (sum of cellWidth per code point). */
export function textWidth(text: string): number {
  let n = 0;
  for (const ch of text) n += cellWidth(ch);
  return n;
}
