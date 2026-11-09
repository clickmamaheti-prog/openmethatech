// Unit tests for the priority keyboard resolver (src/ui/keyboard.ts).
// Port of the Freebuff priority order in keyboard-actions.ts — each
// test names the priority it pins down. Run after build:
// npm run build && npm test
import test from "node:test";
import assert from "node:assert/strict";
import {
  EXIT_WARNING_TIMEOUT_MS,
  createDefaultKeyboardState,
  resolveKeyboardAction,
} from "../dist/ui/keyboard.js";

const base = () => createDefaultKeyboardState();
const key = (over = {}) => ({ ...over });

test("priority 16: lone Ctrl+C on an empty draft only WARNS first (Freebuff double-tap)", () => {
  assert.deepEqual(resolveKeyboardAction("c", key({ ctrl: true }), base()), { type: "exit-app-warning" });
  const s = base();
  s.nextCtrlCWillExit = true;
  assert.deepEqual(resolveKeyboardAction("c", key({ ctrl: true }), s), { type: "exit-app" });
});

test("priority 16: exit-warning window is Freebuff's 2000ms", () => {
  assert.equal(EXIT_WARNING_TIMEOUT_MS, 2000);
});

test("priority 3: Ctrl+C with text clears the input instead of exiting", () => {
  const s = base();
  s.input = "hello";
  assert.deepEqual(resolveKeyboardAction("c", key({ ctrl: true }), s), { type: "clear-input" });
});

test("priority 3 before 4: Ctrl+C with text WHILE streaming clears the draft, stream keeps running", () => {
  const s = base();
  s.sending = true;
  s.input = "hello";
  assert.deepEqual(resolveKeyboardAction("c", key({ ctrl: true }), s), { type: "clear-input" });
});

test("priority 4: Esc / Ctrl+C (empty draft) while streaming interrupts", () => {
  const s = base();
  s.sending = true;
  assert.deepEqual(resolveKeyboardAction("c", key({ ctrl: true }), s), { type: "interrupt-stream" });
  assert.deepEqual(resolveKeyboardAction("", key({ escape: true }), s), { type: "interrupt-stream" });
  s.input = "hello";
  assert.deepEqual(resolveKeyboardAction("", key({ escape: true }), s), { type: "interrupt-stream" });
});

test("priority 16: Ctrl+C with the picker open warns/exits (picker does not claim Ctrl+C)", () => {
  const s = base();
  s.pickerOpen = true;
  assert.deepEqual(resolveKeyboardAction("c", key({ ctrl: true }), s), { type: "exit-app-warning" });
  s.nextCtrlCWillExit = true;
  assert.deepEqual(resolveKeyboardAction("c", key({ ctrl: true }), s), { type: "exit-app" });
});

test("priority 16: Ctrl+C with the palette open warns (palette does not claim Ctrl+C)", () => {
  const s = base();
  s.paletteOpen = true;
  s.paletteCount = 3;
  assert.deepEqual(resolveKeyboardAction("c", key({ ctrl: true }), s), { type: "exit-app-warning" });
});

test("priority 2: Esc closes the picker before interrupting", () => {
  const s = base();
  s.pickerOpen = true;
  s.sending = true;
  assert.deepEqual(resolveKeyboardAction("", key({ escape: true }), s), { type: "exit-mode" });
});

test("priority 2: '?' on an empty draft shows help; typed '?' in a draft types", () => {
  assert.deepEqual(resolveKeyboardAction("?", key(), base()), { type: "show-help" });
  const s = base();
  s.input = "hal";
  assert.deepEqual(resolveKeyboardAction("?", key(), s), { type: "type", text: "?" });
});

test("priority 6: palette arrows stop at the ends instead of wrapping", () => {
  const s = base();
  s.paletteOpen = true;
  s.paletteCount = 3;
  s.paletteSelected = 2;
  assert.deepEqual(resolveKeyboardAction("", key({ downArrow: true }), s), { type: "none" });
  assert.deepEqual(resolveKeyboardAction("", key({ upArrow: true }), s), { type: "palette-up" });
  s.paletteSelected = 0;
  assert.deepEqual(resolveKeyboardAction("", key({ upArrow: true }), s), { type: "none" });
  assert.deepEqual(resolveKeyboardAction("", key({ tab: true }), s), { type: "palette-complete" });
  assert.deepEqual(resolveKeyboardAction("", key({ return: true }), s), { type: "palette-select" });
});

test("picker: arrows move, Enter selects; LOCKED needs two Enters", () => {
  const s = base();
  s.pickerOpen = true;
  s.pickerCount = 5;
  assert.deepEqual(resolveKeyboardAction("", key({ downArrow: true }), s), { type: "picker-down" });
  assert.deepEqual(resolveKeyboardAction("", key({ return: true }), s), { type: "picker-select" });
  s.pickerLocked = true;
  assert.deepEqual(resolveKeyboardAction("", key({ return: true }), s), { type: "picker-locked-explain" });
  s.pickerLockedWarned = true;
  assert.deepEqual(resolveKeyboardAction("", key({ return: true }), s), { type: "picker-locked-open-topup" });
});

test("priority 8: Tab with no menu opens the picker", () => {
  assert.deepEqual(resolveKeyboardAction("", key({ tab: true }), base()), { type: "open-picker" });
});

test("priority 10.5: Up/Down page history only from an empty draft", () => {
  const s = base();
  s.historyCount = 3;
  s.historyNavUpEnabled = true;
  assert.deepEqual(resolveKeyboardAction("", key({ upArrow: true }), s), { type: "history-up" });
  // Non-empty draft: arrows cycle the model instead.
  s.input = "hal";
  assert.deepEqual(resolveKeyboardAction("", key({ upArrow: true }), s), { type: "cycle-model", dir: -1 });
  assert.deepEqual(resolveKeyboardAction("", key({ downArrow: true }), s), { type: "cycle-model", dir: 1 });
  // Recalled history draft keeps paging history.
  s.lastEditDueToNav = true;
  assert.deepEqual(resolveKeyboardAction("", key({ upArrow: true }), s), { type: "history-up" });
});

test("priority 10.5: with no history, Up/Down on an empty draft cycle the model", () => {
  assert.deepEqual(resolveKeyboardAction("", key({ upArrow: true }), base()), {
    type: "cycle-model",
    dir: -1,
  });
  assert.deepEqual(resolveKeyboardAction("", key({ downArrow: true }), base()), {
    type: "cycle-model",
    dir: 1,
  });
});

test("priority 11: Ctrl+T toggles all Thinking blocks", () => {
  assert.deepEqual(resolveKeyboardAction("t", key({ ctrl: true }), base()), { type: "toggle-thinking" });
});

test("priority 14: PgUp/PgDn scroll; priority 2.5: Ctrl+Q is inert", () => {
  assert.deepEqual(resolveKeyboardAction("", key({ pageUp: true }), base()), { type: "scroll-up" });
  assert.deepEqual(resolveKeyboardAction("", key({ pageDown: true }), base()), { type: "scroll-down" });
  assert.deepEqual(resolveKeyboardAction("q", key({ ctrl: true }), base()), { type: "none" });
});

test("plain keys: Enter submits, Shift+Enter / Ctrl+J newline, typing types", () => {
  assert.deepEqual(resolveKeyboardAction("", key({ return: true }), base()), { type: "submit" });
  assert.deepEqual(resolveKeyboardAction("", key({ return: true, shift: true }), base()), { type: "newline" });
  assert.deepEqual(resolveKeyboardAction("j", key({ ctrl: true }), base()), { type: "newline" });
  assert.deepEqual(resolveKeyboardAction("a", key(), base()), { type: "type", text: "a" });
  assert.deepEqual(resolveKeyboardAction("", key({ backspace: true }), base()), { type: "backspace" });
});

test("Esc with a non-empty draft clears it", () => {
  const s = base();
  s.input = "hal";
  assert.deepEqual(resolveKeyboardAction("", key({ escape: true }), s), { type: "clear-input" });
  assert.deepEqual(resolveKeyboardAction("", key({ escape: true }), base()), { type: "none" });
});

test("priority 14: PgUp/PgDn scroll the chat even with the picker open (Freebuff)", () => {
  const s = base();
  s.pickerOpen = true;
  assert.deepEqual(resolveKeyboardAction("", key({ pageUp: true }), s), { type: "scroll-up" });
  assert.deepEqual(resolveKeyboardAction("", key({ pageDown: true }), s), { type: "scroll-down" });
});
