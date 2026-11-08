// Code block renderer with MethaTech syntax highlighting.
// Used by the chat TUI for ``` fenced blocks in assistant messages, and
// reused by the future coding-agent code viewer. Background stays black;
// every token color comes from the centralized theme.

import React from "react";
import { Box, Text } from "ink";
import { syntax, theme } from "../theme.js";
import { tokenizeCode } from "./syntax.js";

interface CodeBlockProps {
  code: string;
  lang?: string;
}

export default function CodeBlock({ code, lang }: CodeBlockProps) {
  const lines = tokenizeCode(code);
  return (
    <Box flexDirection="column" marginY={0}>
      {lang ? (
        <Text color={theme.muted}>
          {lang}
        </Text>
      ) : null}
      {lines.map((tokens, i) => (
        <Text key={i}>
          {tokens.map((t, j) => (
            <Text key={j} color={syntax[t.kind]}>
              {t.text}
            </Text>
          ))}
          {tokens.length === 0 ? " " : null}
        </Text>
      ))}
    </Box>
  );
}
