// Status shimmer — Freebuff `cli/src/components/shimmer-text.tsx`
// (ShimmerText) + `cli/src/components/status-bar.tsx`: while waiting
// the label is lowercase "thinking...", while streaming "working...",
// rendered as a per-character color sweep generated from
// theme.secondary (180ms pulse, bright band travels left to right,
// first 23% BOLD, last 31% DIM). The parent renders this only while
// a request is active, so it never appears when idle, once the
// request finishes, or on error.

import React, { useEffect, useState } from "react";
import { Text } from "ink";
import { theme } from "../theme.js";
import {
  SHIMMER_INTERVAL_MS,
  THINKING_LABEL,
  shimmerSegments,
} from "./thinking.js";

export default function Thinking({ label = THINKING_LABEL }: { label?: string } = {}) {
  const [pulse, setPulse] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setPulse((p) => (p + 1) % Math.max(1, label.length));
    }, SHIMMER_INTERVAL_MS);
    return () => clearInterval(id);
  }, [label]);

  const segments = shimmerSegments(label, pulse, theme.secondary, theme.muted);

  return (
    <Text>
      {segments.map((seg, i) => (
        <Text key={i} color={seg.color} bold={seg.bold} dimColor={seg.dim}>
          {seg.text}
        </Text>
      ))}
    </Text>
  );
}
