// MethaTech identity — SINGLE source of truth for every TUI component.
// Pure black background, neon green accent. All components (chat, model
// picker, command palette, thinking indicator, and the future coding agent)
// must import their colors from this module only, never hardcode their own.
//
// FreeBuff pattern adapted: one centralized theme module (their
// `theme-config.ts` / `use-theme.ts`) instead of per-component colors.

export const theme = {
  /** Pure black. The whole TUI surface. */
  background: "#000000",
  /** Same as background — panels/menus/dialogs blend into the black. */
  surface: "#000000",
  /** Primary accent: neon green. */
  accent: "#39FF14",
  /** Secondary accent: light green. */
  accentSecondary: "#A3FF5F",
  /** Primary text: soft white. */
  text: "#F5F5F5",
  /** Secondary text: light gray. */
  secondary: "#A0A0A0",
  /** Muted text: dark gray, still readable on black. */
  muted: "#666666",
  /** Error: clear red. */
  error: "#FF5555",
  /** Warning: yellow. */
  warning: "#FFD75F",
  /** Success: green (same as accent). */
  success: "#39FF14",
  /** The "You:" label color (kept from the old theme for continuity). */
  userLabel: "#7DD3FC",
} as const;

/**
 * Syntax highlighting — every token type gets a distinct color that stays
 * readable on the pure-black background. No dark-on-black colors.
 * Used by CodeBlock and by every future coding-agent surface (code viewer,
 * diff viewer, agent logs).
 */
export const syntax = {
  keyword: "#39FF14",
  function: "#A3FF5F",
  string: "#FFD75F",
  variable: "#F5F5F5",
  comment: "#8A8A8A",
  number: "#FF9E64",
  plain: "#F5F5F5",
  punctuation: "#A0A0A0",
  type: "#7DD3FC",
} as const;

export type SyntaxTokenKind = keyof typeof syntax;

/**
 * Coding-agent component tokens. The agent itself is NOT built in this
 * phase, but every agent surface that will be built MUST use these tokens
 * so the agent looks identical to the chat TUI. No default library theme.
 */
export const agentTheme = {
  fileTree: {
    dir: "#A3FF5F",
    file: "#F5F5F5",
    selected: "#39FF14",
    muted: "#666666",
  },
  diff: {
    add: "#39FF14",
    addBg: "#0A1F00",
    remove: "#FF5555",
    removeBg: "#1F0A0A",
    hunk: "#A3FF5F",
    context: "#A0A0A0",
  },
  task: {
    pending: "#666666",
    running: "#39FF14",
    done: "#A3FF5F",
    failed: "#FF5555",
  },
  tool: {
    name: "#A3FF5F",
    args: "#A0A0A0",
    output: "#F5F5F5",
  },
  log: {
    info: "#A0A0A0",
    success: "#39FF14",
    warn: "#FFD75F",
    error: "#FF5555",
  },
  confirm: {
    border: "#39FF14",
    yes: "#39FF14",
    no: "#A0A0A0",
  },
} as const;

/** Relative luminance of a hex color (0 = black, 1 = white). */
export function luminance(hex: string): number {
  const c = hex.replace("#", "");
  const r = parseInt(c.slice(0, 2), 16) / 255;
  const g = parseInt(c.slice(2, 4), 16) / 255;
  const b = parseInt(c.slice(4, 6), 16) / 255;
  const f = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio between two hex colors. Readable text needs >= 4.5. */
export function contrastRatio(fg: string, bg: string): number {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}
