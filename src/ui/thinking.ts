// Thinking-indicator logic — pure, no Ink/React. Unit-testable.
// The component (Thinking.tsx) only renders what these functions return:
// a bright green sweep that travels left to right across "Thinking...",
// repeating while the AI is processing and before the first delta arrives.

export const THINKING_LABEL = "Thinking...";

/** Width of the bright sweep, in characters. */
export const SWEEP_WIDTH = 3;

/**
 * Advance the sweep's leading edge by one step. The position cycles over
 * label.length + SWEEP_WIDTH steps so the light slides in from the left,
 * crosses the whole label, then slides off to the right before restarting.
 */
export function nextSweepIndex(current: number, labelLength: number, width: number = SWEEP_WIDTH): number {
  const cycle = labelLength + width;
  if (cycle <= 0) return 0;
  return (current + 1) % cycle;
}

export interface SweepSegment {
  text: string;
  bright: boolean;
}

/**
 * Split the label into bright / dim runs for one sweep position.
 * `sweepPos` is the leading edge: characters in
 * [sweepPos - width + 1, sweepPos] are bright, the rest are dim.
 */
export function sweepSegments(
  label: string,
  sweepPos: number,
  width: number = SWEEP_WIDTH,
): SweepSegment[] {
  const segments: SweepSegment[] = [];
  for (let i = 0; i < label.length; i++) {
    const bright = i <= sweepPos && i > sweepPos - width;
    const last = segments[segments.length - 1];
    if (last && last.bright === bright) last.text += label[i];
    else segments.push({ text: label[i] as string, bright });
  }
  return segments;
}

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
