// Diff viewer with MethaTech colors. Ready for the coding agent's
// edit/preview flow. Not wired to any agent yet — the agent runtime does
// not exist in this phase. Kept small and theme-driven.

import React from "react";
import { Box, Text } from "ink";
import { agentTheme, theme } from "../theme.js";

export type DiffLine = {
  type: "add" | "remove" | "context" | "hunk";
  text: string;
};

interface DiffViewProps {
  lines: DiffLine[];
  file?: string;
}

export default function DiffView({ lines, file }: DiffViewProps) {
  return (
    <Box flexDirection="column">
      {file ? (
        <Text color={theme.muted}>{file}</Text>
      ) : null}
      {lines.map((l, i) => {
        if (l.type === "add") {
          return (
            <Text key={i} color={agentTheme.diff.add}>
              + {l.text}
            </Text>
          );
        }
        if (l.type === "remove") {
          return (
            <Text key={i} color={agentTheme.diff.remove}>
              - {l.text}
            </Text>
          );
        }
        if (l.type === "hunk") {
          return (
            <Text key={i} color={agentTheme.diff.hunk}>
              {l.text}
            </Text>
          );
        }
        return (
          <Text key={i} color={agentTheme.diff.context}>
            {"  "}
            {l.text}
          </Text>
        );
      })}
    </Box>
  );
}
