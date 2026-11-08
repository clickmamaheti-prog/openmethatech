import React from "react";
import { Box, Text, useApp, useInput } from "ink";
import { theme } from "../theme.js";
import type { Catalog } from "../models.js";

interface ModelsScreenProps {
  catalog: Catalog;
  selectedModel: string | null;
}

/** Static model list. Any key (or q) exits. */
export default function ModelsScreen({ catalog, selectedModel }: ModelsScreenProps) {
  const { exit } = useApp();
  useInput((input, key) => {
    if (input === "q" || key.escape || (key.ctrl && input === "c")) exit();
  });

  const free = catalog.entries.filter((e) => e.free);
  const paid = catalog.entries.filter((e) => !e.free);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color={theme.accent} bold>
          MethaTech
        </Text>
        <Text color={theme.muted}> · models</Text>
        <Text color={theme.dim}> {catalog.live ? "(live)" : "(offline, harga tersimpan)"}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text} bold>
          FREE models{" "}
          <Text color={theme.accent} bold>
            $0.00
          </Text>
        </Text>
        {free.map((e) => (
          <Text key={e.id} color={e.id === selectedModel ? theme.accent : theme.text}>
            {e.id === selectedModel ? "▸ " : "  "}
            {e.id}
          </Text>
        ))}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text} bold>
          PAID models ($ per 1M in / out)
        </Text>
        {paid.map((e) => (
          <Text key={e.id} color={e.id === selectedModel ? theme.accent : theme.text}>
            {e.id === selectedModel ? "▸ " : "  "}
            {e.id}
            {e.price ? `  ·  $${e.price.input.toFixed(2)} / $${e.price.output.toFixed(2)}` : "  ·  harga —"}
            {e.ownedBy ? `  ·  ${e.ownedBy}` : ""}
          </Text>
        ))}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.dim}>
          {catalog.entries.length} models · ▸ = model aktif · q keluar · metatech chat --model &lt;id&gt; untuk chat
        </Text>
      </Box>
    </Box>
  );
}
