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
  /** Primary accent: neon green (MethaTech identity, Freebuff primary is #9EFC62). */
  accent: "#39FF14",
  /** Secondary accent: light green. */
  accentSecondary: "#A3FF5F",
  /** Primary text: soft white (Freebuff foreground #f1f5f9, kept softer). */
  text: "#F5F5F5",
  /** Secondary text: Freebuff secondary #a3aed0. */
  secondary: "#a3aed0",
  /** Muted text: Freebuff muted #acb3bf. */
  muted: "#acb3bf",
  /** Error: Freebuff error #ef4444. */
  error: "#ef4444",
  /** Warning: Freebuff warning #FFA500. */
  warning: "#FFA500",
  /** Success: Freebuff success #22c55e. */
  success: "#22c55e",
  /** Link blue: Freebuff link #3B82F6. */
  link: "#3B82F6",
  /** Border gray: Freebuff border #536175. */
  border: "#536175",
  /** Panel surface: Freebuff surface #202327. */
  panel: "#202327",
  /** The "You:" label color (kept from the old theme for continuity). */
  userLabel: "#7DD3FC",
  /** Left-border column of user messages (Freebuff theme.userLine). */
  userLine: "#A3FF5F",
} as const;

/**
 * Markdown palette — Freebuff dark theme, verbatim from
 * cli/src/utils/theme-system.ts DEFAULT_CHAT_THEMES.dark.markdown
 * (via createMarkdownPalette). Every text element gets its own color:
 * headings yellow, links blue, inline code orange on dark gray.
 * The primary accent stays MethaTech neon green; these are the
 * element colors Freebuff assigns, not a re-tint.
 */
export const markdown = {
  /** Inline-code + code-block background: #374151. */
  codeBackground: "#374151",
  /** Code-block language header (`// lang`): #5b647a. */
  codeHeaderFg: "#5b647a",
  /** Inline-code text: #FF8534 (orange). */
  inlineCodeFg: "#FF8534",
  /** Code-block body text: #f1f5f9. */
  codeTextFg: "#f1f5f9",
  /** Headings H1-H6: #facc15 (yellow), always bold. */
  headingFg: "#facc15",
  /** List bullets: #a3aed0. */
  listBulletFg: "#a3aed0",
  /** Blockquote border: #334155. */
  blockquoteBorderFg: "#334155",
  /** Blockquote text: #e2e8f0. */
  blockquoteTextFg: "#e2e8f0",
  /** Horizontal divider: #283042. */
  dividerFg: "#283042",
  /** Link text: #3B82F6. */
  linkFg: "#3B82F6",
} as const;

/**
 * Syntax highlighting — kept for the exported CodeBlock component.
 * NOTE: chat code blocks do NOT use these colors. Freebuff renders
 * code blocks monochrome (markdown.codeTextFg on markdown.codeBackground);
 * see layout.ts flattenMessages. These tokens stay for CodeBlock/DiffView
 * surfaces that show code outside chat.
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
    muted: "#acb3bf",
  },
  diff: {
    add: "#22c55e",
    addBg: "#0A1F00",
    remove: "#ef4444",
    removeBg: "#1F0A0A",
    hunk: "#A3FF5F",
    context: "#a3aed0",
  },
  task: {
    pending: "#acb3bf",
    running: "#39FF14",
    done: "#A3FF5F",
    failed: "#ef4444",
  },
  tool: {
    name: "#A3FF5F",
    args: "#a3aed0",
    output: "#F5F5F5",
  },
  log: {
    info: "#a3aed0",
    success: "#22c55e",
    warn: "#FFA500",
    error: "#ef4444",
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
