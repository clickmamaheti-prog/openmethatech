// Public UI surface of the MethaTech CLI TUI.
// ChatApp is the full-screen chat; CodeBlock renders ``` blocks in
// assistant messages; DiffView is exported and ready for the future
// coding agent (no agent runtime exists yet — it is not wired to one).
// Palette/picker/thinking logic modules are pure and unit-tested.

export { default as ChatApp } from "./ChatApp.js";
export { default as CodeBlock } from "./CodeBlock.js";
export { default as DiffView } from "./DiffView.js";
export type { DiffLine } from "./DiffView.js";
export { default as Thinking } from "./Thinking.js";
export { default as CommandPalette } from "./CommandPalette.js";
export { default as ModelPicker } from "./ModelPicker.js";
export { COMMANDS, filterCommands, paletteNextIndex, palettePrevIndex, paletteClampIndex } from "./palette.js";
export type { PaletteCommand } from "./palette.js";
export { groupCatalog, flattenGroups, pickerNext, pickerPrev, visibleWindow, isLocked, lockedExplanation } from "./picker.js";
export type { PickerGroup, VisibleWindow } from "./picker.js";
export {
  THINKING_LABEL,
  WAITING_LABEL,
  WORKING_LABEL,
  SHIMMER_INTERVAL_MS,
  PREVIEW_LINE_COUNT,
  formatElapsedTime,
  generateShimmerPalette,
  shimmerSegments,
  shouldShowThinking,
  phaseLabel,
  getLastNVisualLines,
  thinkingPreview,
  toggleThinkingState,
} from "./thinking.js";
export type { ShimmerSegment, ThinkingPhase, ThinkingCollapseState, ThinkingPreview } from "./thinking.js";
export { EXIT_WARNING_TIMEOUT_MS, resolveKeyboardAction, createDefaultKeyboardState } from "./keyboard.js";
export type { KeyboardAction, KeyboardState, ResolverKey } from "./keyboard.js";
export {
  parseSlashContext,
  filterSlashCommands,
  fuzzyMatch,
  suggestionWindow,
  suggestionMaxVisible,
  highlightIndices,
} from "./suggestions.js";
export type { SuggestionItem } from "./suggestions.js";
