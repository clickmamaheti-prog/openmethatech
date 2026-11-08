// Thinking indicator: "Thinking..." in green with a bright sweep of light
// travelling left to right, repeating while the AI processes a request.
// Lightweight: one setInterval (~100ms) that only advances the sweep
// position. The parent renders this only while shouldShowThinking() is
// true, so it never appears when no request is active, once streaming
// starts, on finish, or on error.

import React, { useEffect, useState } from "react";
import { Text } from "ink";
import { theme } from "../theme.js";
import { THINKING_LABEL, nextSweepIndex, sweepSegments } from "./thinking.js";

export default function Thinking() {
  const [sweep, setSweep] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setSweep((s) => nextSweepIndex(s, THINKING_LABEL.length));
    }, 100);
    return () => clearInterval(id);
  }, []);

  const segments = sweepSegments(THINKING_LABEL, sweep);

  return (
    <Text>
      {segments.map((seg, i) => (
        <Text key={i} color={seg.bright ? theme.accent : theme.muted} bold={seg.bright}>
          {seg.text}
        </Text>
      ))}
    </Text>
  );
}
