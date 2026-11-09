// Code block renderer — Freebuff style (markdown-renderer.tsx):
// MONOCHROME body (codeTextFg #f1f5f9 on codeBackground #374151),
// header "// lang" in codeHeaderFg (#5b647a). No per-token colors.
// Kept for surfaces that show code outside chat; chat code blocks
// render through layout.ts flattenMessages with the same palette.

import React from "react";
import { Box, Text } from "ink";
import { markdown } from "../theme.js";

interface CodeBlockProps {
  code: string;
  lang?: string;
}

export default function CodeBlock({ code, lang }: CodeBlockProps) {
  const rawLines = code.split("\n");
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
  return (
    <Box flexDirection="column" marginY={0}>
      {lang ? <Text color={markdown.codeHeaderFg}>{`// ${lang}`}</Text> : null}
      {rawLines.map((line, i) => (
        <Text key={i} color={markdown.codeTextFg} backgroundColor={markdown.codeBackground}>
          {line === "" ? " " : line}
        </Text>
      ))}
    </Box>
  );
}
