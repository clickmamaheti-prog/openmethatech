// Thinking-indicator logic — pure, no Ink/React. Unit-testable.
// The component (Thinking.tsx) only renders what these functions
// return: a per-character shimmer sweep across the status label
// (Freebuff ShimmerText), repeating while the AI is processing and
// before the first delta arrives.

export const THINKING_LABEL = "thinking...";
/** Waiting label. Freebuff status-bar.tsx uses lowercase "thinking..."
    (ShimmerText, primaryColor theme.secondary). */
export const WAITING_LABEL = "thinking...";
/** Streaming label (Freebuff status-bar: streaming -> "working..."). */
export const WORKING_LABEL = "working...";
/** Retrying label (Freebuff status-bar: retrying -> "retrying..."). */
export const RETRYING_LABEL = "retrying...";

/**
 * When the indicator may be shown: a request is active, no delta has
 * arrived yet, and there is no error. It disappears the moment streaming
 * starts (first delta), the request finishes, or an error occurs — and it
 * never renders when no request is active.
 */
export function shouldShowThinking(opts: {
  sending: boolean;
  gotFirstDelta: boolean;
  hasError: boolean;
}): boolean {
  return opts.sending && !opts.gotFirstDelta && !opts.hasError;
}

/** Status-bar phase: waiting for the first delta, or streaming deltas. */
export type ThinkingPhase = "waiting" | "streaming";

/** Label for a status-bar phase (Freebuff status-bar.tsx). */
export function phaseLabel(phase: ThinkingPhase): string {
  return phase === "waiting" ? WAITING_LABEL : WORKING_LABEL;
}

// ---------------------------------------------------------------------------
// Elapsed time — Freebuff `cli/src/utils/format-elapsed-time.ts`
// (exact rules): under 60s "Xs"; 60–3599s "Xm" or "Xm Ys"; 3600s+
// "Xh" or "Xh Ym". The status bar hides the timer while it is 0
// (status-bar.tsx renderElapsedTime).
// ---------------------------------------------------------------------------

export function formatElapsedTime(elapsedSeconds: number): string {
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  if (hours > 0) {
    return `${hours}h` + (minutes > 0 ? ` ${minutes}m` : "");
  }
  return `${minutes}m` + (seconds > 0 ? ` ${seconds}s` : "");
}

// ---------------------------------------------------------------------------
// Shimmer — Freebuff `cli/src/components/shimmer-text.tsx`
// (ShimmerText). Per-character color sweep: a palette is generated
// from the primary color by varying lightness ±0.22 (HSL), sized
// clamp(8..20, ceil(chars * 1.5)); every 180ms the pulse advances one
// character and the band travels across the text. Attribute by
// position ratio: first 23% BOLD, middle plain, last 31% DIM. The
// palette color and the attribute both follow the travelling phase.
// ---------------------------------------------------------------------------

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const t = hex.trim();
  const h = t.startsWith("#") ? t.slice(1) : t;
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (full.length !== 6) return null;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return { r, g, b };
}

export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h, s, l };
}

function hueToRgb(p: number, q: number, t: number): number {
  let temp = t;
  if (temp < 0) temp += 1;
  if (temp > 1) temp -= 1;
  if (temp < 1 / 6) return p + (q - p) * 6 * temp;
  if (temp < 1 / 2) return q;
  if (temp < 2 / 3) return p + (q - p) * (2 / 3 - temp) * 6;
  return p;
}

export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  if (s === 0) return { r: l, g: l, b: l };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hueToRgb(p, q, h + 1 / 3),
    g: hueToRgb(p, q, h),
    b: hueToRgb(p, q, h - 1 / 3),
  };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Palette for the shimmer sweep, generated from the primary color
 * (Freebuff generatePaletteFromPrimary): lightness varies ±0.22 around
 * the base, saturation kept. Falls back to a flat fallback color when
 * the primary cannot be parsed.
 */
export function generateShimmerPalette(
  primaryColor: string,
  size: number,
  fallbackColor: string,
): string[] {
  const base = hexToRgb(primaryColor);
  const paletteSize = Math.max(6, Math.min(24, size));
  if (!base) return Array.from({ length: paletteSize }, () => fallbackColor);
  const { h, s, l } = rgbToHsl(base.r, base.g, base.b);
  const palette: string[] = [];
  for (let i = 0; i < paletteSize; i++) {
    const ratio = paletteSize === 1 ? 0.5 : i / (paletteSize - 1);
    const adjustedLightness = Math.min(0.92, Math.max(0.08, l + (0.5 - ratio) * 2 * 0.22));
    const { r, g, b } = hslToRgb(h, s, adjustedLightness);
    palette.push(rgbToHex(r, g, b));
  }
  return palette;
}

export interface ShimmerSegment {
  text: string;
  color: string;
  bold: boolean;
  dim: boolean;
}

export const SHIMMER_INTERVAL_MS = 180;

/**
 * Per-character shimmer segments for one pulse position (Freebuff
 * ShimmerText render): each character shows the palette color and
 * attribute at its travelling phase, so a bright band moves across
 * the text as `pulse` advances. Characters are merged into runs of
 * identical color + attribute.
 */
export function shimmerSegments(
  text: string,
  pulse: number,
  primaryColor: string,
  fallbackColor: string,
): ShimmerSegment[] {
  const chars = text.split("");
  const numChars = chars.length;
  if (numChars === 0) return [];
  const paletteSize = Math.max(8, Math.min(20, Math.ceil(numChars * 1.5)));
  const palette = generateShimmerPalette(primaryColor, paletteSize, fallbackColor);
  const charColors: string[] = [];
  for (let i = 0; i < numChars; i++) {
    const ratio = numChars === 1 ? 0 : i / (numChars - 1);
    charColors.push(palette[Math.min(palette.length - 1, Math.floor(ratio * (palette.length - 1)))] as string);
  }
  const charAttrs: { bold: boolean; dim: boolean }[] = [];
  for (let i = 0; i < numChars; i++) {
    const ratio = numChars <= 1 ? 0 : i / (numChars - 1);
    charAttrs.push({ bold: ratio < 0.23, dim: ratio >= 0.69 });
  }
  const segments: ShimmerSegment[] = [];
  chars.forEach((ch, index) => {
    const phase = (pulse - index + numChars) % numChars;
    const color = charColors[phase] as string;
    const attr = charAttrs[phase] as { bold: boolean; dim: boolean };
    const last = segments[segments.length - 1];
    if (last && last.color === color && last.bold === attr.bold && last.dim === attr.dim) {
      last.text += ch;
    } else {
      segments.push({ text: ch, color, bold: attr.bold, dim: attr.dim });
    }
  });
  return segments;
}

// ---------------------------------------------------------------------------
// Collapsible reasoning block — Freebuff `cli/src/components/thinking.tsx`
// (PREVIEW_LINE_COUNT = 5) + `cli/src/utils/text-layout.ts`
// (getLastNVisualLines). The model sends its reasoning BEFORE the answer;
// MethaTech shows it as a collapsible "Thinking" block above the answer.
// A single **bold** string under 100 chars is hidden entirely (Freebuff
// treats it as a title, not reasoning).
// ---------------------------------------------------------------------------

/** Collapse states of one Thinking block (Freebuff ThinkingCollapseState). */
export type ThinkingCollapseState = "preview" | "expanded" | "collapsed";

/** Lines shown in the collapsed preview (Freebuff PREVIEW_LINE_COUNT). */
export const PREVIEW_LINE_COUNT = 5;

/**
 * Word-wrap `text` to `cols` columns and return the last `n` visual
 * lines plus whether earlier lines were cut off. Port of
 * getLastNVisualLines (text-layout.ts): greedy word wrap, over-long
 * words hard-split.
 */
export function getLastNVisualLines(
  text: string,
  cols: number,
  n: number,
): { lines: string[]; hasMore: boolean } {
  if (n <= 0 || cols <= 0) return { lines: [], hasMore: false };
  if (!text) return { lines: [], hasMore: false };
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  const pushLine = () => {
    lines.push(current);
    current = "";
    currentWidth = 0;
  };
  const appendSegment = (segment: string) => {
    if (!segment) return;
    // A whitespace run never starts a line: if it fits, it separates
    // words on this line; if it does not fit, the line breaks here
    // and the space is dropped (not carried to the next line).
    if (/^\s+$/.test(segment)) {
      if (currentWidth + segment.length > cols) {
        pushLine();
        return;
      }
      current += segment;
      currentWidth += segment.length;
      return;
    }
    if (segment.length > cols) {
      for (const ch of segment) {
        if (currentWidth + 1 > cols) pushLine();
        current += ch;
        currentWidth += 1;
      }
      return;
    }
    if (currentWidth + segment.length > cols) pushLine();
    current += segment;
    currentWidth += segment.length;
  };
  for (const token of text.split(/(\s+)/)) {
    appendSegment(token);
  }
  if (current !== "" || lines.length === 0) pushLine();
  const hasMore = lines.length > n;
  return { lines: lines.slice(-n), hasMore };
}

export interface ThinkingPreview {
  /** False when the content is a lone **bold** title (< 100 chars). */
  visible: boolean;
  /** Preview lines (last 5 visual lines, "..." prefixed when cut). */
  lines: string[];
  hasMore: boolean;
  /** Toggle glyph: • while reasoning, ▾ expanded, ▸ collapsed. */
  toggle: string;
}

/**
 * Build the preview for a reasoning block. `complete` is true once the
 * stream finished; while reasoning is still arriving the toggle is "•".
 * The preview normalizes newlines to spaces (Freebuff) and prefixes
 * "..." when earlier lines were cut off.
 */
export function thinkingPreview(
  content: string,
  width: number,
  state: ThinkingCollapseState,
  complete: boolean,
): ThinkingPreview {
  const singleBold =
    content.length < 100 ? content.trim().match(/^\*\*([^*]+)\*\*$/) : null;
  if (singleBold) return { visible: false, lines: [], hasMore: false, toggle: "• " };
  const normalized = content.replace(/\n+/g, " ").trim();
  const { lines, hasMore } = getLastNVisualLines(
    normalized,
    Math.max(10, width - 3),
    PREVIEW_LINE_COUNT,
  );
  const toggle = !complete ? "• " : state === "expanded" ? "▾ " : state === "collapsed" ? "▸ " : "• ";
  return { visible: true, lines, hasMore, toggle };
}

/** Next collapse state when the user toggles a Thinking block. */
export function toggleThinkingState(state: ThinkingCollapseState): ThinkingCollapseState {
  return state === "expanded" ? "preview" : "expanded";
}
