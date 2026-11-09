// Command palette — presentational only. It takes NO keyboard input of its
// own: the single useInput handler in ChatApp owns Up/Down/Enter/Esc and
// passes the filtered list + selection down here. Shown while the input
// starts with "/"; typing after "/" filters the list (via filterCommands).

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { suggestionWindow } from "./suggestions.js";
import { paletteHint } from "./layout.js";
import type { PaletteCommand } from "./palette.js";

interface CommandPaletteProps {
  commands: PaletteCommand[];
  selectedIndex: number;
  /** Max row width in columns (from useStdout, already minus padding). */
  maxWidth: number;
  /** Max command rows shown at once (dynamic budget from ChatApp). */
  maxRows?: number;
}

function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s;
}

export default function CommandPalette({ commands, selectedIndex, maxWidth, maxRows }: CommandPaletteProps) {
  if (commands.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color={theme.muted}>Tidak ada perintah yang cocok.</Text>
      </Box>
    );
  }
  // Long filtered lists scroll with Freebuff's centered
  // suggestionWindow: the selected row stays in the middle of the
  // visible slice, so the palette can never push the input out of
  // the viewport on a short terminal.
  const { start, visibleCount } = suggestionWindow(commands.length, selectedIndex, maxRows ?? commands.length);
  const end = start + visibleCount;
  const visible = commands.slice(start, end);
  return (
    <Box flexDirection="column">
      {visible.map((cmd, i) => {
        const idx = start + i;
        const selected = idx === selectedIndex;
        const line = `/${cmd.name} — ${cmd.desc}`;
        if (selected) {
          return (
            <Box key={cmd.name} backgroundColor={theme.accent}>
              <Text color="#000000" bold>
                {truncate(`▸ ${line}`, maxWidth)}
              </Text>
            </Box>
          );
        }
        return (
          <Text key={cmd.name} color={theme.text}>
            {truncate(`  ${line}`, maxWidth)}
          </Text>
        );
      })}
      <Text color={theme.muted}>{paletteHint(maxWidth)}</Text>
    </Box>
  );
}
