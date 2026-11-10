// Priority keyboard resolver — pure, no Ink/React. Unit-testable.
//
// Port of the PATTERN in Freebuff `cli/src/utils/keyboard-actions.ts`
// (resolveChatKeyboardAction, commit 5d8bd24, Apache-2.0): ONE pure
// function that maps a key event + a fresh state snapshot to a single
// action, with numbered priorities. The ChatApp dispatcher calls it once
// per atomic keypress and executes the returned action; it never decides
// from a stale render closure (state is read from synchronous refs).
//
// Freebuff priorities, adapted to MethaTech (no agents, no queue, no
// ads, no feedback mode, no mention/file menus — those are documented
// as `none` / remapped below instead of silently dropped):
//   0  out-of-credits mode: Enter opens top-up, Esc/Ctrl+C leaves it
//   1  (feedback mode — not present in MethaTech, skipped)
//   2  Escape exits a non-default mode (picker / palette) first
//   2.5 Ctrl+Q — Freebuff opens the queue panel; MethaTech has no
//      queue, so it is inert (`none`)
//   3  Ctrl+C with text clears the input
//   4  Esc / Ctrl+C while streaming interrupts the stream
//   5  Backspace at an empty draft exits a non-default mode
//   6  slash menu navigation (Up/Down/Tab-complete/Enter-select)
//   7  (mention menu — not present in MethaTech, skipped)
//   7.5 bare arrows in a non-empty draft do NOTHING (they would move
//      a cursor in Freebuff; Ink has no cursor, so MethaTech cycles
//      the model instead — see priority 10.5 note below)
//   8  Tab (no menu open) opens the model picker — Freebuff opens the
//      file menu here; MethaTech has no file menu, the picker is the
//      equivalent "open a chooser" action
//   10/10.5 history: Up/Down page sent-message history ONLY from an
//      empty draft, or from a draft recalled by history navigation
//      (lastEditDueToNav). In a non-empty draft Up/Down cycle the
//      model (MethaTech adaptation of Freebuff 7.5: arrows edit text
//      there; here they switch models instead of doing nothing)
//   11 Ctrl+T toggles all Thinking blocks collapsed/expanded
//      (Freebuff: toggle-all collapsed/expanded)
//   12 (agent-mode toggle — no agent in MethaTech, Tab is priority 8)
//   13 (unfocus agent — no agent, skipped)
//   14 PgUp/PgDn scroll history (page = 0.8 viewport, layout.ts)
//   15 Ctrl+V paste — Ink delivers pasted text as input events, so
//      the dispatcher treats a multi-char chunk as paste; the resolver
//      only marks it `paste` for completeness
//   16 Ctrl+C double-tap exits (Freebuff use-exit-handler.ts +
//      keyboard-actions.ts priority 16): with an empty draft and no
//      stream the FIRST Ctrl+C only WARNS (sets nextCtrlCWillExit +
//      shows "Press Ctrl-C again to exit" in the status bar, flag
//      resets after 2000ms); the SECOND Ctrl+C within 2s exits.
//      With text, the first press clears the input (priority 3) and
//      the next press warns; while a stream is live priority 4
//      interrupts it first. The model picker does NOT claim Ctrl+C
//      (Freebuff's selector only claims Esc/Tab/arrows/Enter), so a
//      Ctrl+C with the picker open also reaches priority 16.

/** Ctrl+C exit-warning window (Freebuff use-exit-handler.ts: the
    nextCtrlCWillExit flag resets after 2000ms). */
export const EXIT_WARNING_TIMEOUT_MS = 2000;

/** Minimal key shape the resolver needs (subset of Ink's Key). */
export interface ResolverKey {
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  return?: boolean;
  escape?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
}

/** Fresh state snapshot the resolver decides on. */
export interface KeyboardState {
  /** Current draft text. */
  input: string;
  /** A request is waiting for the first delta / streaming. */
  sending: boolean;
  /** Model picker is open. */
  pickerOpen: boolean;
  /** Command palette is open (input starts with "/" and no picker). */
  paletteOpen: boolean;
  /** Number of filtered palette commands (0 when the palette is closed). */
  paletteCount: number;
  /** Palette selection index. */
  paletteSelected: number;
  /** Picker selection index. */
  pickerSelected: number;
  /** Number of models in the picker. */
  pickerCount: number;
  /** Paid model selected while balance is $0 (locked two-step Enter). */
  pickerLocked: boolean;
  /** The locked explanation was already shown for the selected row. */
  pickerLockedWarned: boolean;
  /** Balance is $0 and the active model is paid (out-of-credits mode). */
  outOfCredits: boolean;
  /** There is sent-message history to page through. */
  historyCount: number;
  historyNavUpEnabled: boolean;
  historyNavDownEnabled: boolean;
  /** The draft is a recalled history entry (Up/Down keep paging it). */
  lastEditDueToNav: boolean;
  /** First Ctrl+C already pressed: the next Ctrl+C within 2s exits
      (Freebuff ChatKeyboardState.nextCtrlCWillExit). */
  nextCtrlCWillExit: boolean;
  /** Number of pending large-paste text attachments on the composer
      (Ctrl+X / Ctrl+E act on them; 0 disables both). */
  attachmentsCount: number;
}

export type KeyboardAction =
  | { type: "none" }
  | { type: "exit-app" }
  | { type: "exit-app-warning" }
  | { type: "clear-input" }
  | { type: "interrupt-stream" }
  | { type: "open-topup" }
  | { type: "exit-mode" }
  | { type: "picker-up" }
  | { type: "picker-down" }
  | { type: "picker-select" }
  | { type: "picker-locked-explain" }
  | { type: "picker-locked-open-topup" }
  | { type: "palette-up" }
  | { type: "palette-down" }
  | { type: "palette-select" }
  | { type: "palette-complete" }
  | { type: "history-up" }
  | { type: "history-down" }
  | { type: "cycle-model"; dir: 1 | -1 }
  | { type: "open-picker" }
  | { type: "toggle-thinking" }
  | { type: "scroll-up" }
  | { type: "scroll-down" }
  | { type: "show-help" }
  | { type: "submit" }
  | { type: "newline" }
  | { type: "type"; text: string }
  | { type: "backspace" }
  | { type: "paste" }
  /** Remove the most recent pending attachment card (Ctrl+X). */
  | { type: "attachment-remove-last" }
  /** Expand the most recent attachment back into the draft for
      editing and drop its card (Ctrl+E). */
  | { type: "attachment-edit-last" };

const hasModifier = (key: ResolverKey): boolean =>
  Boolean(key.ctrl || key.meta);

/** Default state: empty draft, nothing open, nothing sending. */
export function createDefaultKeyboardState(): KeyboardState {
  return {
    input: "",
    sending: false,
    pickerOpen: false,
    paletteOpen: false,
    paletteCount: 0,
    paletteSelected: 0,
    pickerSelected: 0,
    pickerCount: 0,
    pickerLocked: false,
    pickerLockedWarned: false,
    outOfCredits: false,
    historyCount: 0,
    historyNavUpEnabled: false,
    historyNavDownEnabled: false,
    lastEditDueToNav: false,
    nextCtrlCWillExit: false,
    attachmentsCount: 0,
  };
}

export function resolveKeyboardAction(
  inputKey: string,
  key: ResolverKey,
  state: KeyboardState,
): KeyboardAction {
  const isEscape = key.escape === true;
  const isCtrlC = key.ctrl === true && inputKey === "c";
  const isCtrlV = key.ctrl === true && inputKey === "v";
  const isCtrlQ = key.ctrl === true && inputKey === "q" && !key.meta;
  const isCtrlT = key.ctrl === true && inputKey === "t" && !key.meta;
  const isCtrlJ = key.ctrl === true && inputKey === "j";
  const isCtrlX = key.ctrl === true && inputKey === "x" && !key.meta;
  const isCtrlE = key.ctrl === true && inputKey === "e" && !key.meta;
  const isBackspace = key.backspace === true || key.delete === true;
  const isUp = key.upArrow === true && !hasModifier(key);
  const isDown = key.downArrow === true && !hasModifier(key);
  const isTab = key.tab === true && !hasModifier(key) && !key.shift;
  const isShiftTab = key.tab === true && key.shift === true && !key.ctrl && !key.meta;
  const isEnter = key.return === true;
  const isPageUp = key.pageUp === true && !hasModifier(key);
  const isPageDown = key.pageDown === true && !hasModifier(key);
  const inHistoryDraft = state.input.length === 0 || state.lastEditDueToNav;

  // Priority 0: out-of-credits mode — Enter opens top-up, Esc/Ctrl+C
  // leaves the mode, everything else is blocked.
  if (state.outOfCredits) {
    if (isEnter) return { type: "open-topup" };
    if (isEscape || isCtrlC) return { type: "exit-mode" };
    return { type: "none" };
  }

  // Priority 2: Escape exits the current mode BEFORE interrupting a
  // stream (picker / palette own Escape while open).
  if (isEscape && (state.pickerOpen || state.paletteOpen)) {
    return { type: "exit-mode" };
  }

  // "?" on an empty draft shows help (Freebuff priority 2).
  if (
    !hasModifier(key) &&
    inputKey === "?" &&
    state.input.length === 0 &&
    !state.pickerOpen &&
    !state.paletteOpen
  ) {
    return { type: "show-help" };
  }

  // Priority 2.5: Ctrl+Q — no queue in MethaTech, inert.
  if (isCtrlQ) return { type: "none" };

  // Priority 3: Ctrl+C with text clears the input (does not exit).
  // Freebuff has NO sending guard here — priority 3 fires BEFORE
  // priority 4, so with a draft + a live stream the FIRST Ctrl+C
  // clears the draft and the stream keeps running; the next Ctrl+C
  // (draft now empty) interrupts it.
  if (isCtrlC && state.input.trim().length > 0) {
    return { type: "clear-input" };
  }

  // Priority 4: interrupt a live stream (Esc or Ctrl+C).
  if ((isEscape || isCtrlC) && state.sending) {
    return { type: "interrupt-stream" };
  }

  // Escape with a non-empty draft clears it (MethaTech behavior kept
  // from 0.1.5; Freebuff's Esc meanings live in the modes above).
  if (isEscape && state.input.length > 0 && !state.pickerOpen && !state.paletteOpen) {
    return { type: "clear-input" };
  }

  // Priority 5: Backspace on an empty draft exits a non-default mode.
  if (isBackspace && state.input.length === 0 && (state.pickerOpen || state.paletteOpen)) {
    return { type: "exit-mode" };
  }

  // Priority 6: slash menu (command palette) navigation. Up/Down stop
  // at the ends instead of wrapping (Freebuff: `none` at the edge).
  if (state.paletteOpen && state.paletteCount > 0) {
    if (isDown) {
      return state.paletteSelected < state.paletteCount - 1
        ? { type: "palette-down" }
        : { type: "none" };
    }
    if (isUp) {
      return state.paletteSelected > 0 ? { type: "palette-up" } : { type: "none" };
    }
    if (isTab || isShiftTab) {
      // Tab completes the highlighted command into the input without
      // running it, so arguments can still be typed (Freebuff 6).
      return { type: "palette-complete" };
    }
    if (isEnter) return { type: "palette-select" };
  }

  // Picker navigation (Freebuff model selector: arrows move the
  // focused row only, Enter/Space commits). A LOCKED paid row needs
  // two Enters: first explains, second opens the pay site.
  // PgUp/PgDn are NOT consumed here — Freebuff priority 14 scrolls
  // the chat history even with the picker open. Ctrl+C is NOT
  // consumed here either — Freebuff's selector claims only
  // Esc/Tab/arrows/Enter, so Ctrl+C falls through to priority 16
  // (exit warning / exit) below.
  if (state.pickerOpen) {
    if (isDown) return { type: "picker-down" };
    if (isUp) return { type: "picker-up" };
    if (isPageUp) return { type: "scroll-up" };
    if (isPageDown) return { type: "scroll-down" };
    if (isEnter) {
      if (state.pickerLocked) {
        return state.pickerLockedWarned
          ? { type: "picker-locked-open-topup" }
          : { type: "picker-locked-explain" };
      }
      return { type: "picker-select" };
    }
    if (!isCtrlC) return { type: "none" };
    // Ctrl+C falls through to priority 16.
  }

  // Priority 7.5: bare Left/Right in a non-empty draft do NOTHING
  // (Freebuff: arrows move the cursor there). Up/Down are NOT blocked
  // here — they fall through to history (10.5, empty/recalled draft)
  // or model cycling (10.5, non-empty draft).
  if (
    state.input.length > 0 &&
    (key.leftArrow === true || key.rightArrow === true) &&
    !hasModifier(key)
  ) {
    return { type: "none" };
  }

  // Priority 8: Tab with no menu open opens the model picker
  // (Freebuff opens the file menu here; MethaTech has no file menu).
  if (isTab && !state.pickerOpen && !state.paletteOpen) {
    return { type: "open-picker" };
  }

  // Priority 10.5: history navigation — only from an empty draft or a
  // history-recalled draft. In a non-empty draft Up/Down cycle the
  // model instead (MethaTech adaptation of Freebuff 7.5). With no
  // history at all, Up/Down on an empty draft also cycle the model;
  // while paging history at the oldest entry they stop (none).
  if (isUp && inHistoryDraft && state.historyNavUpEnabled) {
    return { type: "history-up" };
  }
  if (isDown && inHistoryDraft && state.historyNavDownEnabled) {
    return { type: "history-down" };
  }
  if (isUp && !inHistoryDraft) return { type: "cycle-model", dir: -1 };
  if (isDown && !inHistoryDraft) return { type: "cycle-model", dir: 1 };
  if (isUp && inHistoryDraft && state.historyCount === 0) {
    return { type: "cycle-model", dir: -1 };
  }
  if (isDown && inHistoryDraft && state.historyCount === 0) {
    return { type: "cycle-model", dir: 1 };
  }

  // Priority 11: Ctrl+T toggles all Thinking blocks collapsed/expanded.
  if (isCtrlT) return { type: "toggle-thinking" };

  // Priority 11.5: attachment cards (Ctrl+X remove / Ctrl+E edit
  // the most recent card). Freebuff has no keyboard path here — its
  // cards are mouse-clickable (attachment-card.tsx X button) — and
  // MethaTech has no click hit-test, so these chords are the
  // keyboard equivalent. Gated on attachmentsCount, so with no
  // cards both chords fall through to `none` below. The picker
  // block above already returned `none` for non-Ctrl+C keys, so
  // with the picker open both are inert until it closes.
  if (isCtrlX && state.attachmentsCount > 0) return { type: "attachment-remove-last" };
  if (isCtrlE && state.attachmentsCount > 0) return { type: "attachment-edit-last" };

  // Priority 14: PgUp/PgDn scroll the message history.
  if (isPageUp) return { type: "scroll-up" };
  if (isPageDown) return { type: "scroll-down" };

  // Priority 15: paste (Ctrl+V). Ink delivers pasted runs as input
  // events, so the dispatcher also treats multi-char chunks as paste.
  if (isCtrlV) return { type: "paste" };

  // Priority 16: Ctrl+C double-tap exit (Freebuff
  // keyboard-actions.ts priority 16 + use-exit-handler.ts). Reaching
  // here means the draft is empty and no stream is live (priorities
  // 3/4 already claimed those cases). The first press only warns
  // (nextCtrlCWillExit set by the dispatcher, reset after 2000ms);
  // the second press within the window exits.
  if (isCtrlC) {
    return state.nextCtrlCWillExit ? { type: "exit-app" } : { type: "exit-app-warning" };
  }

  // Shift+Enter (or Ctrl+J below) inserts a newline instead of
  // submitting. Menus above already claimed plain Enter.
  if (isEnter && key.shift === true) return { type: "newline" };

  // Plain keys: Enter submits, Ctrl+J / Shift+Enter is a newline,
  // Backspace deletes, anything else types.
  if (isEnter) return { type: "submit" };
  if (isCtrlJ) return { type: "newline" };
  if (isBackspace) return { type: "backspace" };
  if (inputKey && !key.ctrl && !key.meta) return { type: "type", text: inputKey };

  return { type: "none" };
}
