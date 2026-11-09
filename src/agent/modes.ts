// Agent modes: DEFAULT / LITE / MAX / PLAN (Freebuff).
//
// Source (Apache-2.0): freebuff-source/cli/src/utils/constants.ts
// (AGENT_MODE_TO_ID, AGENT_MODES), cli/src/state/chat-store.ts
// (toggleAgentMode cycling), agents/base2/base2.ts (PLAN toolset).
//
// Freebuff facts (AGENT-ADOPTION.md §5):
// - There is NO "Build" mode and NO "YOLO" mode in Freebuff (grep: 0).
// - In Freebuff itself the mode toggle is hidden and the mode is locked
//   to LITE; DEFAULT/LITE/MAX/PLAN only live in Codebuff.
// - PLAN is enforced by the TOOLSET, not by the prompt alone:
//   "Prose alone lost: a user who picked PLAN got the whole feature
//   built and committed, because every capability a build turn has was
//   still here." So mutating tools are REMOVED from the toolset in
//   PLAN mode — the model cannot call what it does not have.
//
// MethaTech notes:
// - The TUI shows the Freebuff mode name itself (Default / Lite /
//   Max / Plan). There is NO "Build" or "YOLO" mode in Freebuff.
// - LITE is not a separate tier: free vs paid is already decided by
//   the model picker + panel access rules, so LITE here only changes
//   the prompt (prefer cheap, small steps); the toolset is DEFAULT's.
// - MAX is accepted but behaves like DEFAULT for now: best-of-n
//   editor/reviewer fan-out is Fase 4 (expensive, needs evaluation).
// - PLAN removes every mutating tool at the toolset level.

export type AgentMode = "DEFAULT" | "LITE" | "MAX" | "PLAN";

/** Cycle order (Freebuff AGENT_MODES): DEFAULT → LITE → MAX → PLAN. */
export const AGENT_MODES: readonly AgentMode[] = ["DEFAULT", "LITE", "MAX", "PLAN"];

/** TUI display name: the Freebuff mode name itself. */
export function modeDisplayName(mode: AgentMode): string {
  switch (mode) {
    case "DEFAULT":
      return "Default";
    case "LITE":
      return "Lite";
    case "MAX":
      return "Max";
    case "PLAN":
      return "Plan";
  }
}

export function parseMode(text: string): AgentMode | null {
  const t = text.trim().toLowerCase();
  if (t === "default") return "DEFAULT";
  if (t === "lite") return "LITE";
  if (t === "max") return "MAX";
  if (t === "plan") return "PLAN";
  return null;
}

export function cycleMode(mode: AgentMode): AgentMode {
  const idx = AGENT_MODES.indexOf(mode);
  return AGENT_MODES[(idx + 1) % AGENT_MODES.length] as AgentMode;
}

/** The base toolset (Freebuff base3 root: the eight core tools + CLI surface). */
export const BASE_TOOL_NAMES: readonly string[] = [
  "read_files",
  "str_replace",
  "write_file",
  "run_terminal_command",
  "code_search",
  "glob",
  "list_directory",
  "write_todos",
  "task_completed",
  "ask_user",
  "skill",
];

/**
 * Tools removed in PLAN mode (Freebuff base2-plan). `run_terminal_command`
 * is removed entirely — a `git commit` once reached the repository
 * through the shell even while the prompt said not to touch anything.
 * task_completed stays: the turn still has to end.
 */
export const PLAN_REMOVED_TOOLS: readonly string[] = [
  "str_replace",
  "write_file",
  "run_terminal_command",
];

/** Tool names available in a mode — the enforcement point for PLAN. */
export function toolNamesForMode(mode: AgentMode): string[] {
  if (mode === "PLAN") {
    const removed = new Set(PLAN_REMOVED_TOOLS);
    return BASE_TOOL_NAMES.filter((n) => !removed.has(n));
  }
  return [...BASE_TOOL_NAMES];
}

/** Short description of what a mode does, shown in the TUI. */
export function modeDescription(mode: AgentMode): string {
  switch (mode) {
    case "DEFAULT":
      return "Default — mode kerja normal: baca, edit, dan jalankan perintah.";
    case "LITE":
      return "Lite — seperti Default, tapi instruksi hemat: langkah kecil, model murah.";
    case "MAX":
      return "Max — seperti Default (best-of-n editor/reviewer belum dibangun, Fase 4).";
    case "PLAN":
      return "Plan — baca dan rencana saja. Tool tulis/edit/shell dicabut dari toolset.";
  }
}
