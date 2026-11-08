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
export { groupCatalog, flattenGroups, pickerNext, pickerPrev, visibleWindow } from "./picker.js";
export type { PickerGroup, VisibleWindow } from "./picker.js";
export { THINKING_LABEL, SWEEP_WIDTH, nextSweepIndex, sweepSegments, shouldShowThinking } from "./thinking.js";
export type { SweepSegment } from "./thinking.js";
