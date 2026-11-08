// Unit tests for the thinking-indicator logic (src/ui/thinking.ts).
// Run after build: npm run build && npm test
import test from "node:test";
import assert from "node:assert/strict";
import {
  THINKING_LABEL,
  SWEEP_WIDTH,
  nextSweepIndex,
  sweepSegments,
  shouldShowThinking,
} from "../dist/ui/thinking.js";

test("nextSweepIndex advances by one and wraps after label + width steps", () => {
  const cycle = THINKING_LABEL.length + SWEEP_WIDTH;
  assert.equal(nextSweepIndex(0, THINKING_LABEL.length), 1);
  assert.equal(nextSweepIndex(cycle - 1, THINKING_LABEL.length), 0);
  assert.equal(nextSweepIndex(5, THINKING_LABEL.length), 6);
});

test("sweepSegments: bright run of SWEEP_WIDTH at the sweep position", () => {
  // sweepPos 2 -> chars 0..2 bright ("Thi"), the rest dim.
  const segs = sweepSegments(THINKING_LABEL, 2);
  assert.deepEqual(segs, [
    { text: "Thi", bright: true },
    { text: "nking...", bright: false },
  ]);
});

test("sweepSegments: sweep sliding off the right end leaves all dim", () => {
  const segs = sweepSegments(THINKING_LABEL, THINKING_LABEL.length + SWEEP_WIDTH - 1);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].bright, false);
  assert.equal(segs[0].text, THINKING_LABEL);
});

test("sweepSegments: every segment joined reproduces the label", () => {
  for (let pos = 0; pos < THINKING_LABEL.length + SWEEP_WIDTH; pos++) {
    const joined = sweepSegments(THINKING_LABEL, pos).map((s) => s.text).join("");
    assert.equal(joined, THINKING_LABEL);
  }
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
