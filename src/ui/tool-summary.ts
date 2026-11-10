// Display summary for one finished agent tool call (what the TUI shows
// under the tool preview line). Freebuff (Apache-2.0):
//   cli/src/components/blocks/tool-branch.tsx
//     (finishedPreview: run_terminal_command shows the LAST 3 output
//      lines, "..." prefix when more; other tools show the last line)
//   cli/src/components/tools/read-files.tsx
//     (ReadFilesComponent renders only `Read <paths>` — the file
//      CONTENTS are never shown; they only go to the model)
//   cli/src/components/tools/run-terminal-command.tsx
//     (TerminalCommandDisplay, maxVisibleLines 5, expandable)
//
// The summary is DISPLAY ONLY: the full tool output still travels to
// the model in the loop's role "tool" history message (loop.ts). A null
// return means "no result line" — the preview already says everything
// (read_files: the paths are the whole story).

/**
 * Summarize one tool result for display. Returns the one-line summary
 * to append under the tool preview, or null when no result line is
 * shown at all.
 */
export function summarizeToolResult(toolName: string, output: string, ok: boolean): string | null {
  if (toolName === "run_terminal_command") {
    // Freebuff tool-branch.tsx: last 3 non-empty output lines, "..."
    // prefix when more. The output is JSON {command, stdout, stderr,
    // exitCode}, so stdout is extracted first.
    let stdout = output;
    try {
      const parsed = JSON.parse(output) as { stdout?: unknown; stderr?: unknown };
      if (typeof parsed.stdout === "string") stdout = parsed.stdout;
      if (typeof parsed.stderr === "string" && parsed.stderr.trim() !== "") {
        stdout = `${stdout}\n${parsed.stderr}`;
      }
    } catch {
      // Not JSON — fall back to the raw output.
    }
    const outLines = stdout.split("\n").filter((l) => l.trim() !== "");
    const tail = outLines.slice(-3);
    return (outLines.length > 3 ? "... " : "") + tail.join(" / ");
  }
  if (toolName === "read_files" && ok) {
    // Freebuff read-files.tsx: the TUI shows only `Read <paths>` —
    // file contents never reach the screen. The preview line already
    // carries the paths, so a successful read shows no result line.
    // A failed read still shows its (short) error below.
    return null;
  }
  // Other tools: one whitespace-collapsed line, max 120 chars, with an
  // explicit line count when the output spans more lines — so a cut is
  // visible instead of silent.
  const outLines = output.split("\n").filter((l) => l.trim() !== "");
  const oneLine = output.replace(/\s+/g, " ").trim().slice(0, 120);
  return outLines.length > 1 ? `${oneLine} (+${outLines.length} baris)` : oneLine;
}
