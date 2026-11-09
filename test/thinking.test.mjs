// Unit tests for the thinking-indicator logic (src/ui/thinking.ts).
// Run after build: npm run build && npm test
import test from "node:test";
import assert from "node:assert/strict";
import {
  THINKING_LABEL,
  SHIMMER_INTERVAL_MS,
  formatElapsedTime,
  generateShimmerPalette,
  shimmerSegments,
  shouldShowThinking,
} from "../dist/ui/thinking.js";

test("shimmer interval is Freebuff's 180ms", () => {
  assert.equal(SHIMMER_INTERVAL_MS, 180);
});

test("generateShimmerPalette: lightness sweep around the primary, flat fallback on bad hex", () => {
  const palette = generateShimmerPalette("#a3aed0", 10, "#acb3bf");
  assert.equal(palette.length, 10);
  // First entry is the lightest (ratio 0 -> +0.22 lightness), last the darkest.
  assert.notEqual(palette[0], palette[palette.length - 1]);
  assert.ok(palette.every((c) => /^#[0-9a-f]{6}$/.test(c)));
  assert.deepEqual(generateShimmerPalette("not-a-color", 8, "#acb3bf"), Array(8).fill("#acb3bf"));
});

test("shimmerSegments: every segment joined reproduces the label, colors travel with the pulse", () => {
  for (let pulse = 0; pulse < THINKING_LABEL.length; pulse++) {
    const segs = shimmerSegments(THINKING_LABEL, pulse, "#a3aed0", "#acb3bf");
    assert.equal(segs.map((s) => s.text).join(""), THINKING_LABEL);
    assert.ok(segs.every((s) => /^#[0-9a-f]{6}$/.test(s.color)));
  }
  const first = shimmerSegments(THINKING_LABEL, 0, "#a3aed0", "#acb3bf");
  const shifted = shimmerSegments(THINKING_LABEL, 1, "#a3aed0", "#acb3bf");
  assert.notDeepEqual(
    first.map((s) => s.color),
    shifted.map((s) => s.color),
  );
});

test("shimmerSegments: first chars BOLD, a DIM band exists and travels with the pulse", () => {
  const segs = shimmerSegments(THINKING_LABEL, 0, "#a3aed0", "#acb3bf");
  assert.equal(segs[0].bold, true);
  assert.equal(segs.some((s) => s.dim), true);
  // The DIM band sits at different characters for a different pulse.
  const dimAt = (pulse) =>
    shimmerSegments(THINKING_LABEL, pulse, "#a3aed0", "#acb3bf")
      .filter((s) => s.dim)
      .map((s) => s.text)
      .join("");
  assert.notEqual(dimAt(0), dimAt(5));
});

test("formatElapsedTime: Freebuff's exact rules", () => {
  assert.equal(formatElapsedTime(0), "0s");
  assert.equal(formatElapsedTime(30), "30s");
  assert.equal(formatElapsedTime(60), "1m");
  assert.equal(formatElapsedTime(90), "1m 30s");
  assert.equal(formatElapsedTime(3600), "1h");
  assert.equal(formatElapsedTime(3700), "1h 1m");
});

test("shouldShowThinking: only while sending and before the first delta", () => {
  assert.equal(
    shouldShowThinking({ sending: true, gotFirstDelta: false, hasError: false }),
    true,
  );
  assert.equal(
    shouldShowThinking({ sending: true, gotFirstDelta: true, hasError: false }),
    false,
  );
  assert.equal(
    shouldShowThinking({ sending: true, gotFirstDelta: false, hasError: true }),
    false,
  );
  assert.equal(
    shouldShowThinking({ sending: false, gotFirstDelta: false, hasError: false }),
    false,
  );
});

test("getLastNVisualLines: last N lines, hasMore when cut", async () => {
  const { getLastNVisualLines, thinkingPreview, toggleThinkingState, phaseLabel } = await import(
    "../dist/ui/thinking.js"
  );
  const text = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join(" ");
  const { lines, hasMore } = getLastNVisualLines(text, 6, 5);
  assert.equal(lines.length, 5);
  assert.equal(hasMore, true);
  assert.ok(lines[4].includes("line 8"));
  const short = getLastNVisualLines("a b c", 10, 5);
  assert.deepEqual(short, { lines: ["a b c"], hasMore: false });
});

test("thinkingPreview: 5-line preview with ... cut, lone **bold** hidden", async () => {
  const { thinkingPreview, toggleThinkingState, phaseLabel } = await import(
    "../dist/ui/thinking.js"
  );
  const long = Array.from({ length: 8 }, (_, i) => `reasoning line ${i + 1}`).join("\n");
  // Width 20 wraps each "reasoning line N" onto its own visual line.
  const p = thinkingPreview(long, 20, "preview", true);
  assert.equal(p.visible, true);
  assert.equal(p.lines.length, 5);
  assert.equal(p.hasMore, true);
  assert.equal(p.toggle, "• ");
  assert.equal(thinkingPreview("**Just a title**", 20, "preview", true).visible, false);
  assert.equal(thinkingPreview(long, 20, "expanded", true).toggle, "▾ ");
  assert.equal(thinkingPreview(long, 20, "collapsed", true).toggle, "▸ ");
  assert.equal(toggleThinkingState("preview"), "expanded");
  assert.equal(toggleThinkingState("expanded"), "preview");
  assert.equal(phaseLabel("waiting"), "thinking...");
  assert.equal(phaseLabel("streaming"), "working...");
});
