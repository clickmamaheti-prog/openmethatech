// Model picker — presentational only. It takes NO keyboard input of its
// own: the single useInput handler in ChatApp owns Up/Down/Enter/Esc and
// passes the selection down here. Groups come from the live catalog via
// groupCatalog(); FREE first, PAID sorted cheapest-first. Paid models are
// shown with their price, never hidden. Long lists scroll: only the
// visibleWindow() slice around the selection is rendered.

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { flattenGroups, groupCatalog, visibleWindow, type PickerGroup } from "./picker.js";
import type { Catalog } from "../models.js";

interface ModelPickerProps {
  catalog: Catalog;
  /** Flat index (across FREE + PAID) of the highlighted row. */
  selectedIndex: number;
  activeModel: string;
  /** Max model rows shown at once (from useStdout rows). */
  maxRows: number;
  /** Max row width in columns (from useStdout, already minus padding). */
  maxWidth: number;
}

function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s;
}

function priceLabel(group: PickerGroup, id: string, price: { input: number; output: number } | null): string {
  if (group.title === "FREE") return "FREE $0.00";
  if (!price) return "harga —";
  return `$${price.input.toFixed(2)} / $${price.output.toFixed(2)} per 1M`;
}

export default function ModelPicker({ catalog, selectedIndex, activeModel, maxRows, maxWidth }: ModelPickerProps) {
  const groups = groupCatalog(catalog);
  const flat = flattenGroups(groups);
  const total = flat.length;
  if (total === 0) {
    return (
      <Box flexDirection="column">
        <Text color={theme.muted}>Tidak ada model di katalog.</Text>
      </Box>
    );
  }
  const { start, end } = visibleWindow(total, selectedIndex, maxRows);
  const visible = flat.slice(start, end);

  // Map a flat index back to its group for the price label.
  const groupOf = (flatIdx: number): PickerGroup => {
    let offset = 0;
    for (const g of groups) {
      if (flatIdx < offset + g.entries.length) return g;
      offset += g.entries.length;
    }
    return groups[groups.length - 1] as PickerGroup;
  };

  // Render group headers only for groups present in the visible slice.
  const rows: React.ReactNode[] = [];
  let lastTitle: string | null = null;
  visible.forEach((entry, i) => {
    const flatIdx = start + i;
    const group = groupOf(flatIdx);
    if (group.title !== lastTitle) {
      lastTitle = group.title;
      rows.push(
        <Text key={`h-${group.title}-${flatIdx}`} color={theme.text} bold>
          {group.title}
          {start > 0 && flatIdx === start ? "  ·  ↑" : ""}
        </Text>,
      );
    }
    const selected = flatIdx === selectedIndex;
    const active = entry.id === activeModel;
    const marker = active ? "▸ " : "  ";
    const line = `${marker}${entry.id}  ·  ${priceLabel(group, entry.id, entry.price)}`;
    if (selected) {
      rows.push(
        <Box key={entry.id} backgroundColor={theme.accent}>
          <Text color="#000000" bold>
            {truncate(line, maxWidth)}
          </Text>
        </Box>,
      );
    } else {
      rows.push(
        <Text key={entry.id} color={active ? theme.accent : theme.text} bold={active}>
          {truncate(line, maxWidth)}
        </Text>,
      );
    }
  });

  return (
    <Box flexDirection="column">
      <Text color={theme.accent} bold>
        Pilih model
      </Text>
      {rows}
      {end < total ? <Text color={theme.muted}>↓ {total - end} lagi</Text> : null}
      <Text color={theme.muted}>↑↓ pilih · Enter pakai · Esc batal · ▸ = model aktif</Text>
    </Box>
  );
}
