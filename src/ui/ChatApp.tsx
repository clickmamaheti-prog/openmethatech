// MethaTech chat TUI — full-screen interactive, pure black background,
// neon green accent. ONE central useInput handler driven by the pure
// priority resolver in ./keyboard.ts (Freebuff pattern:
// keyboard-actions.ts resolveChatKeyboardAction — numbered priorities,
// one global listener reading FRESH state from synchronous refs, never
// a stale render closure):
//   0  (out-of-credits input block — NOT used: MethaTech must stay
//       usable so the user can switch to a free model; the $0-balance
//       guard lives at send-time + in the picker LOCKED rows instead)
//   2  Esc exits picker/palette · "?" on an empty draft shows help
//   2.5 Ctrl+Q inert (no queue in MethaTech)
//   3  Ctrl+C with text clears the input
//   4  Esc / Ctrl+C while streaming interrupts the stream (abort)
//   5  Backspace on an empty draft exits picker/palette
//   6  palette: Up/Down (stop at ends), Tab completes, Enter selects
//   8  Tab with no menu open opens the model picker
//   10.5 Up/Down page sent-message history from an empty draft (or a
//       history-recalled draft); in a non-empty draft they cycle model
//   11 Ctrl+T toggles all Thinking blocks collapsed/expanded
//   14 PgUp/PgDn scroll history (page = 0.8 viewport)
//   16 Ctrl+C double-tap exits: 1st press clears input (3) or
//      interrupts the stream (4); the 2nd press exits. A lone Ctrl+C
//      on an empty draft exits immediately.
//
// Assistant messages render per MessagePart: plain text as-is (with
// **bold** / `code` inline Markdown), ``` fenced blocks through
// CodeBlock (theme syntax colors). Reasoning the server sends
// (delta.reasoning_content) renders as a collapsible "Thinking" block
// BEFORE the answer (Freebuff thinking.tsx: 5-line preview + toggle).
// The agent loop IS the chat (Freebuff: no plain-chat mode — every
// message runs through the agent step with tools).

import React, { useEffect, useRef, useState } from "react";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { Box, Text, useApp, useInput, useStdout, type Key } from "ink";
import { theme } from "../theme.js";
import { streamChat, ApiError, type ChatMessage, type ChatUsage } from "../api.js";
import {
  runAgentLoop,
  cycleMode,
  modeDisplayName,
  modeDescription,
  parseMode,
  generateInitSummary,
  compactPrompt,
  exportConversation,
  type AgentEvent,
  type AgentMode,
  type TodoItem,
} from "../agent/index.js";
import { priceFor, isFreeModel, DEFAULT_MODEL, FALLBACK_MODEL, type Catalog } from "../models.js";
import { formatUsageLine, formatUsd } from "../cost.js";
import {
  saveDefaultModel,
  hasSubmittedFirstPrompt,
  markFirstPromptSubmitted,
  TOPUP_URL,
  TOKEN_PAGE_URL,
  LOGIN_URL,
} from "../config.js";
import { phaseLabel, formatElapsedTime } from "./thinking.js";
import { sanitizeTerminalOutput, sanitizeTerminalText } from "./terminal-safe.js";
import {
  AUTO_SCROLL_DELAY_MS,
  SCROLL_ANIMATION_DURATION_MS,
  SCROLL_ANIMATION_FRAME_MS,
  easeOutCubic,
  scrollbarThumbRange,
  INPUT_PLACEHOLDER,
  SIDE_GUTTER,
  breakpoints,
  flattenMessages,
  inputBoxRowsFor,
  layoutBudget,
  pageScrollOffset,
  paletteMaxRowsFor,
  paletteRenderedRows,
  pickerMaxRowsFor,
  pickerRenderedRows,
  welcomeLayout,
  wheelScrollOffset,
  windowLines,
  wrapLineCount,
  STARTER_PROMPTS,
} from "./layout.js";
import { filterCommands, paletteClampIndex, paletteNextIndex, palettePrevIndex } from "./palette.js";
import { flattenGroups, groupCatalog, isLocked, lockedExplanation, pickerNext, pickerPrev } from "./picker.js";
import { parseMouseInput, WHEEL_LINES } from "./mouse.js";
import { parseSlashContext, suggestionMaxVisible } from "./suggestions.js";
import {
  EXIT_WARNING_TIMEOUT_MS,
  resolveKeyboardAction,
  type KeyboardAction,
  type KeyboardState,
} from "./keyboard.js";
import Thinking from "./Thinking.js";
import CommandPalette from "./CommandPalette.js";
import ModelPicker from "./ModelPicker.js";
import CodeBlock from "./CodeBlock.js";

type DisplayMessage = ChatMessage & {
  kind: "chat" | "system" | "tool" | "todos";
  ts: number;
  thinking?: string;
  thinkingComplete?: boolean;
  /** To-do list for kind "todos" (Freebuff shape: {task, completed}). */
  todos?: { task: string; completed: boolean }[];
  /**
   * Structured tool call for kind "tool" (Freebuff ToolCallItem +
   * TerminalCommandDisplay). The layout renders the preview BOLD
   * and each result ✓ in success green / ✗ in error red; `content`
   * keeps the plain-text rendering for any other consumer.
   */
  tool?: {
    name: string;
    preview: string;
    shell: boolean;
    results: { ok: boolean; text: string }[];
  };
};

interface ChatAppProps {
  apiKey: string;
  initialModel: string;
  catalog: Catalog;
  balanceUsd: number | null;
}

/** Middle-truncate a long line so it fits one row (no Yoga wrap). */
function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 3) return s.slice(0, max);
  const keep = Math.floor((max - 1) / 2);
  return `${s.slice(0, keep)}…${s.slice(-(max - 1 - keep))}`;
}

const HELP_LINES = [
  "/models — lihat daftar model",
  "/model — pilih model (atau /model <id> langsung)",
  "/mode [default|lite|max|plan] — ganti mode agen",
  "/init — baca codebase, buat AGENTS.md",
  "/compact — ringkas percakapan",
  "/export — ekspor percakapan ke file Markdown",
  "/clear — bersihkan layar chat",
  "/help — bantuan ini",
  "/account — ringkasan akun",
  "/keys — info API key",
  "/topup — buka halaman top up",
  "/exit — keluar",
  "↑↓ history (draft kosong) · ↑↓ ganti model (draft terisi) · Tab pilih model · Ctrl+T thinking · Enter kirim · Ctrl+C 2x keluar",
];

/** Best-effort browser open (Termux-aware). The URL is always printed too. */
function tryOpenUrl(url: string): void {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.env.TERMUX_VERSION || process.env.PREFIX?.includes("com.termux")
        ? "termux-open-url"
        : "xdg-open";
  try {
    const child = spawn(opener, [url], { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // Opening the browser is best-effort; the URL is always printed.
  }
}

export default function ChatApp({ apiKey, initialModel, catalog, balanceUsd }: ChatAppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = stdout.columns ?? 80;
  const rows = stdout.rows ?? 24;
  const contentWidth = Math.max(20, columns - 4);
  // Message text width: the message box's own SIDE_GUTTER
  // (Freebuff message-with-agents.tsx:105, SIDE_GUTTER = 1) comes out
  // of the wrap width — flattenMessages prepends the gutter to every
  // line, so text starts at column 2 (root padding 1 + gutter 1) and
  // its right edge stays exactly where it was (the spare column in
  // contentWidth is the right-side gutter). The scrollbar pass takes
  // one more column for the track, as before. Narrow terminals stay
  // safe: contentWidth floors at 20, so messageWidth never drops
  // below 19 — no static padding number can break a small terminal.
  const messageWidth = contentWidth - SIDE_GUTTER;
  // Freebuff-style breakpoints (layout.ts): width xs < 50, sm 50-100,
  // md 100-150, lg > 150; height xs < 20, sm 20-40, md > 40. The header
  // stacks in two rows on narrow terminals (xs width), as before.
  const bp = breakpoints(columns, rows);
  const narrow = bp.width === "xs";

  const [model, setModel] = useState(initialModel);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [gotFirstDelta, setGotFirstDelta] = useState(false);
  const [lastUsage, setLastUsage] = useState<{ usage: ChatUsage; model: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSelected, setPickerSelected] = useState(0);
  const [paletteSelected, setPaletteSelected] = useState(0);
  // Ctrl+C exit warning (Freebuff use-exit-handler.ts): the first
  // Ctrl+C on an empty idle draft only warns — "Press Ctrl-C again
  // to exit" in the status bar — and arms the exit; the second
  // Ctrl+C within EXIT_WARNING_TIMEOUT_MS exits. The flag resets
  // after the timeout, so a lone Ctrl+C never exits on its own.
  const [exitWarning, setExitWarning] = useState(false);
  const exitWarningRef = useRef(false);
  const exitWarningTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setExitWarningBoth = (value: boolean) => {
    exitWarningRef.current = value;
    setExitWarning(value);
  };
  const armExitWarning = () => {
    if (exitWarningTimeoutRef.current !== null) {
      clearTimeout(exitWarningTimeoutRef.current);
    }
    setExitWarningBoth(true);
    exitWarningTimeoutRef.current = setTimeout(() => {
      setExitWarningBoth(false);
      exitWarningTimeoutRef.current = null;
    }, EXIT_WARNING_TIMEOUT_MS);
  };
  useEffect(
    () => () => {
      if (exitWarningTimeoutRef.current !== null) {
        clearTimeout(exitWarningTimeoutRef.current);
      }
    },
    [],
  );
  // History scroll offset in visual lines from the bottom (0 = bottom).
  // PgUp/PgDn moves it one page (0.8 viewport); new own messages and
  // /clear reset it to the bottom.
  const [scrollOffset, setScrollOffset] = useState(0);
  // Seconds since the current request started (status-bar timer).
  const [elapsedSec, setElapsedSec] = useState(0);
  // Ctrl+T flips every Thinking block between preview and expanded.
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  // Starter prompts show until the first prompt is sent (persisted in
  // credentials.json — Freebuff hasSubmittedFirstPrompt).
  const [startersShown, setStartersShown] = useState(() => !hasSubmittedFirstPrompt());

  // ---- Coding agent (Freebuff adoption, Fase 1–2) ----
  // Freebuff HAS NO plain-chat mode: every message goes through
  // onSubmitPrompt(content, agentMode) (cli/src/chat.tsx,
  // use-chat-input.ts) into the agent step with tools. MethaTech
  // follows: the agent loop IS the chat — every non-slash message
  // runs through it, with the agent system prompt (tools + project
  // context: file tree, cwd, knowledge files, git changes). A plain
  // question just gets a text-only answer (the loop ends the turn
  // when a step returns no tool calls). Mode tampil di status bar
  // (footer line 1). Nama mode mengikuti Freebuff: Default / Lite /
  // Max / Plan (AGENT-ADOPTION.md §5 — tidak ada mode "Build" atau
  // "YOLO" di Freebuff). There is no /agent toggle anymore: /agent
  // only reports that the agent is always on.
  const [agentMode, setAgentMode] = useState<AgentMode>("DEFAULT");
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentSteps, setAgentSteps] = useState(0);
  const [agentTodos, setAgentTodos] = useState<TodoItem[]>([]);
  const agentModeRef = useRef<AgentMode>("DEFAULT");
  const agentTodosRef = useRef<TodoItem[]>([]);
  // Agent loop history (system prompt + turns), kept across turns so
  // the agent remembers tool results. The system prompt is rebuilt
  // every run; the stored copy's system prompt is stripped on reuse.
  const agentHistoryRef = useRef<ChatMessage[]>([]);
  const agentRunningRef = useRef(false);

  const sendingRef = useRef(false);
  const modelRef = useRef(model);
  modelRef.current = model;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  // Sent-message history (Up/Down from an empty draft). -1 = not paging.
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef(-1);
  const lastEditDueToNavRef = useRef(false);
  // Abort for the live stream (Esc / Ctrl+C interrupt, priority 4).
  const abortRef = useRef<AbortController | null>(null);
  const sendStartRef = useRef(0);
  // Model id whose LOCKED explanation was already shown (2nd Enter on
  // the same row opens the top-up page instead).
  const lockedWarnedRef = useRef<string | null>(null);
  const startersShownRef = useRef(startersShown);
  startersShownRef.current = startersShown;

  // Refs mirrored synchronously with state, so the central useInput handler
  // never decides on a stale closure when keys arrive faster than React
  // re-renders (rapid typing + Enter would otherwise swallow the Enter:
  // the handler would still see the old input and think the palette is
  // closed). Every mutation below updates the ref AND the state together.
  const inputRef = useRef("");
  const pickerOpenRef = useRef(false);
  const pickerSelectedRef = useRef(0);
  const paletteSelectedRef = useRef(0);
  const scrollOffsetRef = useRef(0);
  // A mouse sequence Ink delivered in two pieces (see ./mouse.ts):
  // the first half was swallowed and this flag remembers to swallow
  // the second half instead of typing it into the draft.
  const mouseFragmentPendingRef = useRef(false);
  const setScrollOffsetBoth = (offset: number) => {
    scrollOffsetRef.current = offset;
    setScrollOffset(offset);
  };
  // Smooth-scroll animation (Freebuff use-scroll-management.ts: 200ms
  // easeOutCubic, ~60fps frames). A new scroll action cancels the
  // running animation and starts from the current offset; the
  // auto-scroll snap below skips while an animation is running, so a
  // fresh stream never yanks the view mid-animation.
  const scrollAnimRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelScrollAnimation = () => {
    if (scrollAnimRef.current !== null) {
      clearInterval(scrollAnimRef.current);
      scrollAnimRef.current = null;
    }
  };
  const animateScrollTo = (target: number) => {
    cancelScrollAnimation();
    const start = scrollOffsetRef.current;
    if (start === target) {
      setScrollOffsetBoth(target);
      return;
    }
    const startTime = Date.now();
    scrollAnimRef.current = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / SCROLL_ANIMATION_DURATION_MS, 1);
      const eased = easeOutCubic(progress);
      setScrollOffsetBoth(Math.round(start + (target - start) * eased));
      if (progress >= 1) {
        cancelScrollAnimation();
        setScrollOffsetBoth(target);
      }
    }, SCROLL_ANIMATION_FRAME_MS);
  };
  useEffect(() => cancelScrollAnimation, []);
  const setInputBoth = (updater: string | ((prev: string) => string)) => {
    const next = typeof updater === "function" ? updater(inputRef.current) : updater;
    inputRef.current = next;
    setInput(next);
  };
  const setPickerOpenBoth = (open: boolean) => {
    pickerOpenRef.current = open;
    setPickerOpen(open);
  };
  const setPickerSelectedBoth = (idx: number) => {
    pickerSelectedRef.current = idx;
    setPickerSelected(idx);
  };
  const setPaletteSelectedBoth = (idx: number) => {
    paletteSelectedRef.current = idx;
    setPaletteSelected(idx);
  };

  const modelIds = catalog.entries.map((e) => e.id);
  const flatModels = flattenGroups(groupCatalog(catalog));
  const price = priceFor(catalog, model);
  const free = isFreeModel(model);
  const priceText = price ? `$${price.input.toFixed(2)} / ${price.output.toFixed(2)} per 1M` : null;

  // Command palette: open while the slash trigger matches on the first
  // line (Freebuff parseSlashContext: /^(\s*)\/([^\s]*)$/, startIndex 0)
  // and the picker is not open. Typing after "/" filters in real time.
  const slash = parseSlashContext(input);
  const paletteOpen = slash.active && !pickerOpen;
  const paletteQuery = paletteOpen ? slash.query : "";
  const filteredCommands = paletteOpen ? filterCommands(paletteQuery) : [];

  // Reset the palette selection whenever the query changes; clamp it when
  // the filtered list shrinks. Keep the ref in sync (handler reads it).
  useEffect(() => {
    paletteSelectedRef.current = 0;
    setPaletteSelected(0);
  }, [paletteQuery]);
  useEffect(() => {
    setPaletteSelected((s) => {
      const clamped = paletteClampIndex(s, filteredCommands.length);
      paletteSelectedRef.current = clamped;
      return clamped;
    });
  }, [filteredCommands.length]);

  // Status phase (Freebuff status-bar.tsx): "thinking..." while
  // waiting for the first delta, "working..." once streaming. The
  // elapsed timer (formatElapsedTime) is hidden while it is 0, and
  // the stop hint is exactly "■ Esc" — both sit on the RIGHT of the
  // status row (Freebuff status bar: indicator left, timer + ■ Esc
  // right, justifyContent flex-end). The row shows for the whole
  // request, not just while waiting.
  const statusActive = sending && error === null;
  const statusLabel = statusActive ? phaseLabel(gotFirstDelta ? "streaming" : "waiting") : null;
  const statusRightParts: string[] = [];
  if (agentRunning) {
    statusRightParts.push(narrow ? `Step ${agentSteps}` : `Agent step ${agentSteps}`);
  }
  if (elapsedSec > 0) statusRightParts.push(formatElapsedTime(elapsedSec));
  statusRightParts.push("■ Esc");
  const statusRightText = statusRightParts.join(" · ");

  // Resize re-render (Ink 6 quirk, root-caused live 2026-11-08):
  // Ink's own resize handler (ink/build/ink.js `resized()`) only
  // re-serializes the ALREADY-COMMITTED tree and only updates the
  // root Yoga WIDTH — it never re-runs components, so a height-only
  // shrink (same width, fewer rows) leaves our root `height={rows}`
  // prop stale at the old value and Ink keeps emitting the old
  // taller frame into the shorter terminal until a keystroke forces
  // a React render. A timer effect keyed on [columns, rows] cannot
  // fix this (chicken-and-egg: it only fires after a render, and no
  // render happens). So listen to stdout 'resize' directly and bump
  // a tick: the listener fires on SIGWINCH regardless of renders,
  // and the forced render then reads the fresh stdout.rows.
  // (Freebuff never hits this: OpenTUI repaints the whole screen on
  // resize.) A fresh start at any size is correct; only the shrink
  // path mis-diffed. The tick itself is unused — it only forces the
  // render.
  const [, setResizeTick] = useState(0);
  useEffect(() => {
    const onResize = () => setResizeTick((t) => t + 1);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  // Elapsed timer: ticks once a second while a request is live.
  useEffect(() => {
    if (!sending) return;
    const id = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - sendStartRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [sending]);

  // Auto-scroll (Freebuff use-scroll-management.ts: AUTO_SCROLL_DELAY_MS
  // 50): 50ms after the messages change, snap back to the bottom —
  // UNLESS the user scrolled up (scrollOffset > 1 line), in which case
  // new deltas must not yank the view away from what they are reading.
  useEffect(() => {
    const id = setTimeout(() => {
      // A running scroll animation owns the offset (Freebuff skips its
      // auto-scroll while animating); snap only once it has landed.
      if (scrollAnimRef.current !== null) return;
      if (scrollOffsetRef.current <= 1) setScrollOffsetBoth(0);
    }, AUTO_SCROLL_DELAY_MS);
    return () => clearTimeout(id);
  }, [messages]);

  // ---- Full-screen layout budget (layout.ts, pure) ----
  // The root Box is exactly `rows` tall; every fixed block is counted
  // here so the message area gets precisely what is left. The picker
  // and palette budgets are dynamic (rows minus fixed chrome), never a
  // constant, so opening one can never push the input out of view.
  // The footer is TWO rows (Freebuff chat footer: model line + hint
  // line). The input is a BORDERED BOX (Freebuff chat-input-bar.tsx:
  // single rounded border, placeholder inside, suggestion menu inside
  // the box above the input); its height is 2 borders + the wrapped
  // input/placeholder rows (maxHeight = floor(rows / 2),
  // chat-input-bar.tsx) + the palette rows when the menu is open.
  const headerRows = narrow ? 2 : 1;
  const inputInnerWidth = Math.max(10, contentWidth - 4);
  const displayInput = input === "" ? INPUT_PLACEHOLDER : input;
  const inputContentRows = Math.max(
    1,
    Math.min(Math.floor(rows / 2), wrapLineCount(displayInput, inputInnerWidth)),
  );
  const footerRows = 2;
  // The exit warning reuses the status row's budget slot (Freebuff
  // status bar is one fixed row; the ctrlC warning has the highest
  // status-indicator priority, above waiting/streaming).
  const thinkingRows = statusActive || exitWarning ? 1 : 0;
  const errorRows = error ? wrapLineCount(error, contentWidth) : 0;
  const inputBoxBaseRows = 2 + inputContentRows;
  const fixedExcludingOverlays = headerRows + inputBoxBaseRows + footerRows + thinkingRows + errorRows;
  const pickerMaxRows = pickerOpen ? pickerMaxRowsFor(rows, fixedExcludingOverlays) : 0;
  const pickerRows = pickerOpen
    ? pickerRenderedRows({ catalog, selectedIndex: pickerSelected, maxRows: pickerMaxRows, maxWidth: contentWidth })
    : 0;
  const paletteMaxRows = paletteOpen
    ? Math.min(paletteMaxRowsFor(rows, fixedExcludingOverlays), suggestionMaxVisible(rows))
    : 0;
  const paletteRowsInside =
    paletteOpen && !pickerOpen
      ? paletteRenderedRows({
          totalCommands: filteredCommands.length,
          selectedIndex: paletteSelected,
          maxRows: paletteMaxRows,
          maxWidth: inputInnerWidth,
        })
      : 0;
  const inputBoxRows = inputBoxRowsFor(inputContentRows, paletteRowsInside);
  const { available: messageAvailable } = layoutBudget({
    rows,
    headerRows,
    inputRows: inputBoxRows,
    footerRows,
    thinkingRows,
    errorRows,
    pickerRows,
    paletteRows: 0,
  });
  // Manual windowing: only the last budgeted visual lines render
  // (shifted up by the PgUp/PgDn offset). Lines are pre-wrapped by
  // flattenMessages, so one line is exactly one terminal row. The
  // scroll indicator takes a row of the same budget, so the total can
  // never exceed the viewport.
  //
  // Welcome / empty state: while there are no messages (and no
  // picker/palette open) the message area shows the welcome block
  // instead of an empty black hole — block wordmark, info box, and
  // suggestions, vertically centered in the area. It is exactly
  // `messageAvailable` rows, so the budget math below stays exact.
  // The first sent message makes it disappear for good (until /clear).
  const showWelcome = messages.length === 0 && !pickerOpen && !paletteOpen;
  const welcome = showWelcome
    ? welcomeLayout({
        available: messageAvailable,
        contentWidth,
        model,
        free,
        priceText,
        balanceUsd,
        showStarters: startersShown,
      })
    : null;
  // Vertical scrollbar (Freebuff scrollbox: 1-wide track, visible
  // only when not streaming/waiting and the content overflows). Ink
  // has no scrollbox, so the track is a trailing column on every
  // message-area row; lines are re-wrapped one column narrower while
  // it shows, so no text is ever pushed out of the viewport.
  const flatLinesFull = flattenMessages(messages, messageWidth, { thinkingExpanded });
  const showScrollbar =
    !showWelcome && !sending && flatLinesFull.length > messageAvailable;
  const flatLines = showScrollbar
    ? flattenMessages(messages, messageWidth - 1, { thinkingExpanded })
    : flatLinesFull;
  let linesBudget = messageAvailable;
  let windowed = windowLines(flatLines, linesBudget, scrollOffset);
  // The "↑ N baris di atas" row only shows while the user is actually
  // scrolled up (scrollOffset > 0). At the bottom the window already
  // shows the latest lines, so no row is spent on it — Freebuff shows
  // its scroll affordances (↓ button, scrollbar thumb position) only
  // when !isAtBottom. (Before this fix the row showed whenever the
  // history overflowed, even at the bottom, claiming "133 baris di
  // atas" while the latest reply was already visible.)
  const showScrollIndicator = scrollOffset > 0 && linesBudget > 0;
  if (showScrollIndicator) {
    linesBudget -= 1;
    windowed = windowLines(flatLines, linesBudget, scrollOffset);
  }
  // Thumb range over the message-area rows (proportional to the
  // visible window's share of the whole history).
  const scrollbarThumb = showScrollbar
    ? scrollbarThumbRange(flatLines.length, messageAvailable, windowed.startLine, windowed.endLine)
    : { start: 0, end: 0 };
  const scrollbarChar = (rowIndex: number) =>
    rowIndex >= scrollbarThumb.start && rowIndex < scrollbarThumb.end ? "█" : "│";
  // Explicit black filler rows: Ink only paints cells it renders, so
  // the empty part of the viewport is painted with spaces on black
  // instead of showing the terminal's own background (teal on Reza's
  // Termux). Filler + visible lines always equal the message budget.
  const fillerRows = Math.max(0, linesBudget - windowed.lines.length);
  const fillerLine = " ".repeat(Math.max(1, columns - 2));

  // Footer, line 1 (Freebuff chat footer): "{model} • {effort} ·
  // {cwd} · /model to change · Chat: {name}". MethaTech has no
  // reasoning effort; the price / FREE tag takes its place. Chat name
  // is the first user prompt, else "New chat".
  const cwd = process.cwd().replace(process.env.HOME ?? "", "~");
  const firstUserPrompt =
    messages.find((m) => m.kind === "chat" && m.role === "user")?.content.replace(/\s+/g, " ") ??
    null;
  const chatName =
    firstUserPrompt === null
      ? "New chat"
      : firstUserPrompt.length > 24
        ? `${firstUserPrompt.slice(0, 24)}…`
        : firstUserPrompt;
  // Agent segment is ALWAYS shown (Freebuff: the agent is the chat,
  // there is no plain-chat mode to fall back to).
  const agentSeg = ` · Agent: ${modeDisplayName(agentMode)}`;
  // Footer price is the short "FREE" (the header already shows
  // "FREE $0.00"); the "$0.00" here only pushed the line past 80 cols
  // and cut the Chat name to "New cha".
  const priceSeg = free ? "FREE" : (priceText ?? "harga —");
  const footerFull = `${model} • ${priceSeg} · ${cwd} · /model to change${agentSeg} · Chat: ${chatName}`;
  // Cascade when the line would overflow (render slices to columns-2):
  // cwd drops first, then the Chat name (expendable per the old
  // comment) — model, price, /model hint and Agent mode always survive.
  const footerNoCwd = `${model} • ${priceSeg} · /model to change${agentSeg} · Chat: ${chatName}`;
  const footerNoChat = `${model} • ${priceSeg} · /model to change${agentSeg}`;
  const footerLine =
    footerFull.length <= columns - 2
      ? footerFull
      : footerNoCwd.length <= columns - 2
        ? footerNoCwd
        : footerNoChat;
  // Narrow terminals (40 cols) cannot fit model + price + Chat name:
  // the agent mode is the must-show segment (agent is always on).
  const footerLineShown =
    narrow ? `${model} · Agent: ${modeDisplayName(agentMode)}` : footerLine;
  // Footer, line 2: usage of the last answer + scroll position +
  // history/help hints. Narrow terminals get the short hint. The
  // scroll part is the Freebuff scroll-to-bottom button's affordance
  // (status-bar.tsx: `↓`, theme.info, shown only when !isAtBottom);
  // Ink has no mouse click, so PgDn is the way down and the `↓` marks
  // it. Parts are dropped from the end (hint first, then usage) so
  // the scroll affordance always survives on narrow terminals.
  const hintText =
    contentWidth >= 72
      ? "↑↓ history · ? help · / perintah · /model pilih model · Ctrl+C 2x keluar"
      : "↑↓ history · ? help · Ctrl+C 2x keluar";
  const statusParts: { text: string; color?: string }[] = [];
  if (lastUsage) {
    statusParts.push({ text: formatUsageLine(lastUsage.usage, priceFor(catalog, lastUsage.model)) });
  }
  if (windowed.hiddenBelow > 0) {
    statusParts.push({
      text: narrow
        ? `↓ PgDn (${windowed.hiddenBelow})`
        : `↓ PgDn ke bawah (${windowed.hiddenBelow} baris)`,
      color: theme.secondary,
    });
  }
  statusParts.push({ text: hintText });
  const statusPartsShown = [...statusParts];
  let statusJoinedLength = statusPartsShown.reduce((n, p, i) => n + p.text.length + (i > 0 ? 3 : 0), 0);
  while (statusJoinedLength > columns - 2 && statusPartsShown.length > 1) {
    const dropped = statusPartsShown.pop() as { text: string };
    statusJoinedLength -= dropped.text.length + 3;
  }

  const pushSystem = (content: string) => {
    // System lines are rendered through the layout, so any escape
    // sequence in them (a provider error string, a stop reason)
    // would reach the terminal raw — strip it first.
    setMessages((m) => [...m, { role: "assistant", content: sanitizeTerminalText(content), kind: "system", ts: Date.now() }]);
  };

  // ---- Agent helpers ----
  const pushTool = (preview: string, toolName: string) => {
    const clean = sanitizeTerminalText(preview);
    setMessages((m) => [
      ...m,
      {
        role: "assistant",
        content: clean,
        kind: "tool",
        ts: Date.now(),
        tool: { name: toolName, preview: clean, shell: clean.startsWith("$ "), results: [] },
      },
    ]);
  };
  /**
   * Append a result line to the last tool message (the to-do list is
   * its own kind now, so it is never a target). The structured
   * result keeps the real status (✓ green / ✗ red in the layout);
   * `content` keeps the plain-text rendering for any other consumer.
   */
  const appendToLastTool = (summary: string, ok: boolean) => {
    // The summary is tool output / file content (external text):
    // strip escapes and collapse progress-bar redraws before it
    // reaches the layout. The layout adds its own ✓/✗ marker, so
    // the stored text is the plain summary, not the decorated line.
    const clean = sanitizeTerminalOutput(summary);
    setMessages((m) => {
      const copy = [...m];
      for (let i = copy.length - 1; i >= 0; i--) {
        const msg = copy[i];
        if (msg && msg.kind === "tool") {
          const tool = msg.tool
            ? { ...msg.tool, results: [...msg.tool.results, { ok, text: clean }] }
            : undefined;
          copy[i] = { ...msg, content: `${msg.content}\n  ${ok ? "✓" : "✗"} ${clean}`, tool };
          return copy;
        }
      }
      return copy;
    });
  };
  /** Replace the to-do list message, or push it when there is none yet.
      Freebuff write-todos.tsx: an empty list renders nothing, so an
      empty update removes the message. */
  const upsertTodosMessage = (todos: { task: string; completed: boolean }[]) => {
    setMessages((m) => {
      const copy = [...m];
      const idx = copy.findIndex((msg) => msg && msg.kind === "todos");
      if (todos.length === 0) {
        return idx >= 0 ? copy.filter((_, i) => i !== idx) : copy;
      }
      const next = { role: "assistant" as const, content: "", kind: "todos" as const, ts: Date.now(), todos };
      if (idx >= 0) {
        copy[idx] = next;
        return copy;
      }
      return [...m, next];
    });
  };
  /** Append streamed agent text to the last assistant chat message. */
  const appendAssistantText = (delta: string) => {
    // Stored raw on purpose: an escape sequence split across two
    // stream chunks would be corrupted by per-delta sanitizing
    // (the parameter bytes of the second half would leak as plain
    // text). flattenMessages sanitizes the full reassembled content
    // at the render boundary instead, where a split sequence is
    // whole again. The raw stream still feeds the agent history in
    // loop.ts — only the display copy is cleaned, at render time.
    setMessages((m) => {
      const copy = [...m];
      for (let i = copy.length - 1; i >= 0; i--) {
        const msg = copy[i];
        if (msg && msg.role === "assistant" && msg.kind === "chat") {
          copy[i] = { ...msg, content: msg.content + delta };
          return copy;
        }
      }
      return copy;
    });
  };
  const cycleModel = (dir: 1 | -1) => {
    const idx = modelIds.indexOf(modelRef.current);
    const next = modelIds[(idx + dir + modelIds.length) % modelIds.length] ?? DEFAULT_MODEL;
    modelRef.current = next;
    setModel(next);
    saveDefaultModel(next);
  };

  const setModelById = (id: string): boolean => {
    if (!modelIds.includes(id)) {
      // Retired/unknown ids are coerced to the fallback instead of erroring
      // (Freebuff lesson, incident #1801).
      pushSystem(`Model ${id} tidak dikenal, dialihkan ke ${FALLBACK_MODEL}.`);
      modelRef.current = FALLBACK_MODEL;
      setModel(FALLBACK_MODEL);
      return false;
    }
    modelRef.current = id;
    setModel(id);
    saveDefaultModel(id);
    return true;
  };

  const openPicker = () => {
    lockedWarnedRef.current = null;
    const idx = flatModels.findIndex((e) => e.id === modelRef.current);
    setPickerSelectedBoth(idx >= 0 ? idx : 0);
    setPickerOpenBoth(true);
  };

  const pickModel = (id: string) => {
    setPickerOpenBoth(false);
    if (setModelById(id)) pushSystem(`Model aktif: ${id}`);
  };

  const showModelsList = () => {
    const freeList = catalog.entries.filter((e) => e.free).map((e) => e.id);
    const paidList = catalog.entries
      .filter((e) => !e.free && e.price)
      .map((e) => `${e.id}  $${e.price!.input.toFixed(2)}/$${e.price!.output.toFixed(2)}`);
    pushSystem(
      "FREE $0.00\n" + freeList.join("\n") + "\n\nPAID ($ per 1M in/out)\n" + paidList.join("\n"),
    );
  };

  /** THE send path (Freebuff: every message goes through the agent
      loop — cli/src/commands/router.ts:480 "send to agent" →
      use-send-message.ts:985 client.run). The local agent loop
      (read/edit/shell tools, run directly like Freebuff) handles the
      task; a plain question just gets a text-only answer (the loop
      ends the turn when a step returns no tool calls). The loop's
      history persists across turns in this session. */
  const send = async (text: string) => {
    if (sendingRef.current) return;
    const currentModel = modelRef.current;
    if (!isFreeModel(currentModel) && balanceUsd !== null && balanceUsd <= 0) {
      const entry = catalog.entries.find((e) => e.id === currentModel);
      pushSystem(
        entry
          ? lockedExplanation(entry)
          : `${currentModel} is a paid model and your balance is $0.00. Top up first: ${TOPUP_URL}`,
      );
      tryOpenUrl(TOPUP_URL);
      return;
    }
    if (startersShownRef.current) {
      startersShownRef.current = false;
      setStartersShown(false);
      markFirstPromptSubmitted();
    }
    historyRef.current = [...historyRef.current, text];
    historyIdxRef.current = -1;
    lastEditDueToNavRef.current = false;
    sendingRef.current = true;
    agentRunningRef.current = true;
    sendStartRef.current = Date.now();
    setElapsedSec(0);
    setSending(true);
    setAgentRunning(true);
    setAgentSteps(0);
    setGotFirstDelta(false);
    setError(null);
    setScrollOffsetBoth(0);
    const now = Date.now();
    setMessages((m) => [...m, { role: "user", content: text, kind: "chat", ts: now }]);
    setMessages((m) => [...m, { role: "assistant", content: "", kind: "chat", ts: now, thinking: "" }]);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const priorHistory = agentHistoryRef.current.filter(
        (m) => !(m.role === "system" && m.content.startsWith("You are the MethaTech coding agent")),
      );
      const result = await runAgentLoop({
        apiKey,
        model: currentModel,
        cwd: process.cwd(),
        mode: agentModeRef.current,
        userPrompt: text,
        history: priorHistory,
        signal: abort.signal,
        onEvent: (e: AgentEvent) => {
          if (e.type === "text") {
            setGotFirstDelta(true);
            appendAssistantText(e.text);
          } else if (e.type === "reasoning") {
            // Thinking card in agent mode (Freebuff thinking.tsx):
            // reasoning accumulates on the assistant message's thinking
            // field, same as plain chat did before the agent merge.
            setGotFirstDelta(true);
            setMessages((m) => {
              const copy = [...m];
              for (let i = copy.length - 1; i >= 0; i--) {
                const msg = copy[i];
                if (msg && msg.role === "assistant" && msg.kind === "chat") {
                  copy[i] = { ...msg, thinking: (msg.thinking ?? "") + e.text };
                  break;
                }
              }
              return copy;
            });
          } else if (e.type === "step") {
            setAgentSteps(e.step);
          } else if (e.type === "tool_call") {
            pushTool(e.preview, e.toolName);
          } else if (e.type === "tool_result") {
            // Freebuff tool-branch.tsx: run_terminal_command shows the
            // LAST 3 output lines ("...\n" + preview when more). The
            // tool's output is JSON {command, stdout, stderr,
            // exitCode}, so the stdout is extracted first.
            let summary: string;
            if (e.toolName === "run_terminal_command") {
              let stdout = e.output;
              try {
                const parsed = JSON.parse(e.output) as { stdout?: unknown; stderr?: unknown };
                if (typeof parsed.stdout === "string") stdout = parsed.stdout;
                if (typeof parsed.stderr === "string" && parsed.stderr.trim() !== "") {
                  stdout = `${stdout}\n${parsed.stderr}`;
                }
              } catch {
                // Not JSON — fall back to the raw output.
              }
              const outLines = stdout.split("\n").filter((l) => l.trim() !== "");
              const tail = outLines.slice(-3);
              summary = (outLines.length > 3 ? "... " : "") + tail.join(" / ");
            } else {
              summary = e.output.replace(/\s+/g, " ").trim().slice(0, 120);
            }
            appendToLastTool(summary, e.ok);
          } else if (e.type === "todos") {
            agentTodosRef.current = e.todos;
            setAgentTodos(e.todos);
            upsertTodosMessage(e.todos);
          } else if (e.type === "done") {
            // "interrupted by user" is reported once after the loop
            // returns ("Request dibatalkan."), not here.
            if (!e.completed && !e.stopReason.includes("ask_user") && e.stopReason !== "interrupted by user") {
              pushSystem(`Agen berhenti: ${e.stopReason}`);
            }
          }
        },
      });
      agentHistoryRef.current = result.history;
      // Abort (Esc / Ctrl+C while streaming) used to vanish inside the
      // agent loop; plain chat reported it as "Request dibatalkan.".
      if (abort.signal.aborted) {
        pushSystem("Request dibatalkan.");
      }
      setMessages((m) => {
        const copy = [...m];
        for (let i = copy.length - 1; i >= 0; i--) {
          const msg = copy[i];
          if (msg && msg.role === "assistant" && msg.kind === "chat") {
            copy[i] = { ...msg, thinkingComplete: true };
            break;
          }
        }
        return copy;
      });
      if (result.askUserQuestions) {
        pushSystem(
          "Agen bertanya (jawab di chat, agen lanjut dari jawabanmu):\n" +
            result.askUserQuestions
              .map((q, i) => `${i + 1}. ${q.question}${q.options ? ` (${q.options.join(" / ")})` : ""}`)
              .join("\n"),
        );
      }
    } catch (e) {
      if (abort.signal.aborted) {
        setMessages((m) => {
          const copy = [...m];
          for (let i = copy.length - 1; i >= 0; i--) {
            const msg = copy[i];
            if (msg && msg.role === "assistant" && msg.kind === "chat") {
              if (msg.content === "") copy.splice(i, 1);
              else copy[i] = { ...msg, thinkingComplete: true };
              break;
            }
          }
          return copy;
        });
        pushSystem("Request dibatalkan.");
      } else {
        const message = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
        // Provider-supplied text reaches the terminal through the
        // error block — strip escapes before storing it.
        setError(sanitizeTerminalText(message));
        setMessages((m) => {
          const copy = [...m];
          for (let i = copy.length - 1; i >= 0; i--) {
            const msg = copy[i];
            if (msg && msg.role === "assistant" && msg.kind === "chat" && msg.content === "") {
              copy.splice(i, 1);
              break;
            }
          }
          return copy;
        });
      }
    } finally {
      abortRef.current = null;
      sendingRef.current = false;
      agentRunningRef.current = false;
      setSending(false);
      setAgentRunning(false);
    }
  };

  /** /compact: summarise the conversation through the model, then
      replace the history with the summary (Freebuff /compact). */
  const compactHistory = async () => {
    const chatHistory: ChatMessage[] = messagesRef.current
      .filter((m) => m.kind === "chat")
      .map((m) => ({ role: m.role, content: m.content }));
    if (chatHistory.length === 0) {
      pushSystem("Belum ada percakapan untuk diringkas.");
      return;
    }
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      let summary = "";
      await streamChat(apiKey, modelRef.current, [{ role: "user", content: compactPrompt(chatHistory) }], {
        onDelta: (d) => {
          summary += d;
        },
        onUsage: () => undefined,
      }, 1024);
      agentHistoryRef.current = [];
      setMessages([
        {
          role: "assistant",
          content: `Ringkasan percakapan:\n${sanitizeTerminalText(summary)}`,
          kind: "system",
          ts: Date.now(),
        },
      ]);
      setLastUsage(null);
      setScrollOffsetBoth(0);
    } catch (e) {
      const message = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
      setError(sanitizeTerminalText(message));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const handleSlash = (raw: string) => {
    const [cmd, ...rest] = raw.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "exit":
      case "quit":
        exit();
        break;
      case "agent": {
        // Freebuff has no agent toggle: the agent IS the chat
        // (router.ts:480 "send to agent"). /agent only reports the
        // always-on status, for anyone who typed it out of habit.
        pushSystem(
          `Agen koding selalu AKTIF (mode ${modeDisplayName(agentModeRef.current)}). Kirim tugas seperti biasa — agen membaca/mengedit file dan menjalankan perintah di folder ini (${process.cwd()}). /mode untuk ganti mode.`,
        );
        break;
      }
      case "mode": {
        if (arg) {
          const parsed = parseMode(arg);
          if (!parsed) {
            pushSystem(`Mode tidak dikenal: ${arg}. Pilih: default, lite, max, plan.`);
            break;
          }
          agentModeRef.current = parsed;
          setAgentMode(parsed);
        } else {
          const next = cycleMode(agentModeRef.current);
          agentModeRef.current = next;
          setAgentMode(next);
        }
        pushSystem(`Mode agen: ${modeDisplayName(agentModeRef.current)}. ${modeDescription(agentModeRef.current)}`);
        break;
      }
      case "init": {
        const summary = generateInitSummary(process.cwd());
        if (summary.existed) {
          pushSystem(`AGENTS.md sudah ada — tidak ditimpa. Ringkasan codebase:\n${summary.content}`);
        } else {
          fs.writeFileSync("AGENTS.md", summary.content, "utf-8");
          pushSystem(`AGENTS.md dibuat di ${process.cwd()}. Isi ringkasannya:\n${summary.content}`);
        }
        break;
      }
      case "compact":
        void compactHistory();
        break;
      case "export": {
        const file = exportConversation({
          cwd: process.cwd(),
          model: modelRef.current,
          mode: modeDisplayName(agentModeRef.current),
          messages: messagesRef.current
            .filter((m) => m.kind === "chat")
            .map((m) => ({ role: m.role, content: m.content })),
        });
        pushSystem(`Percakapan diekspor ke:\n${file}`);
        break;
      }
      case "clear":
        setMessages([]);
        agentHistoryRef.current = [];
        agentTodosRef.current = [];
        setAgentTodos([]);
        setLastUsage(null);
        setScrollOffsetBoth(0);
        break;
      case "help":
        pushSystem(HELP_LINES.join("\n"));
        break;
      case "models":
        showModelsList();
        break;
      case "model":
        if (arg) setModelById(arg);
        else openPicker();
        break;
      case "account":
        pushSystem(
          "Akun MethaTech\n" +
            `Login: ya (key tersimpan di CLI)\n` +
            `Balance: ${balanceUsd === null ? "—" : formatUsd(balanceUsd)}\n` +
            `Model aktif: ${modelRef.current}\n` +
            `Top up: ${TOPUP_URL}\n` +
            `Detail lengkap: ${LOGIN_URL}`,
        );
        break;
      case "keys":
        pushSystem(
          "API key\n" +
            "Key tersimpan di CLI ini (file ~/.config/metatech/credentials.json).\n" +
            `Kelola dan buat key baru di panel: ${TOKEN_PAGE_URL}\n` +
            "Lalu jalankan: methatech login",
        );
        break;
      case "topup":
        pushSystem(`Top up MethaTech lewat:\n${TOPUP_URL}`);
        tryOpenUrl(TOPUP_URL);
        break;
      default:
        pushSystem(`Perintah tidak dikenal: /${cmd}. Ketik /help.`);
    }
  };

  /** Run the palette's selected command, keeping any typed argument.
      Computes the filtered list fresh from the ref (not closure state)
      so a fast "/exit" + Enter can never pick a stale first row. */
  const runPaletteCommand = () => {
    const q = parseSlashContext(inputRef.current).query;
    const list = filterCommands(q);
    const selected = list[paletteSelectedRef.current];
    if (!selected) return false;
    const arg = inputRef.current.slice(1).split(/\s+/).slice(1).join(" ").trim();
    setInputBoth("");
    handleSlash(`/${selected.name}${arg ? ` ${arg}` : ""}`);
    return true;
  };

  /** Complete the highlighted palette command into the input (Tab):
      "/mod" + Tab becomes "/model " so arguments can still be typed. */
  const completePaletteCommand = () => {
    const q = parseSlashContext(inputRef.current).query;
    const list = filterCommands(q);
    const selected = list[paletteSelectedRef.current];
    if (!selected) return;
    setInputBoth(`/${selected.name} `);
  };

  /** Page sent-message history (Up/Down from an empty draft). */
  const historyStep = (dir: 1 | -1) => {
    const history = historyRef.current;
    if (history.length === 0) return;
    let idx = historyIdxRef.current;
    if (dir === 1) {
      // Up: newest first, then older.
      idx = idx === -1 ? history.length - 1 : Math.max(0, idx - 1);
    } else {
      // Down: toward newer; past the newest clears the draft.
      if (idx === -1) return;
      idx = idx + 1;
      if (idx >= history.length) {
        historyIdxRef.current = -1;
        lastEditDueToNavRef.current = false;
        setInputBoth("");
        return;
      }
    }
    historyIdxRef.current = idx;
    lastEditDueToNavRef.current = true;
    setInputBoth(history[idx] as string);
  };

  const clearDraftEdit = () => {
    lastEditDueToNavRef.current = false;
  };

  // Build a fresh resolver snapshot from the synchronous refs (never
  // from closure state) and dispatch the single action it returns.
  const handleAtomicKey = (inputKey: string, key: Key) => {
    // Starter shortcuts: on the empty state, 1/2/3 sends a starter
    // prompt directly (Freebuff: clicking a suggestion submits it).
    if (
      startersShownRef.current &&
      messagesRef.current.length === 0 &&
      inputRef.current === "" &&
      !pickerOpenRef.current &&
      (inputKey === "1" || inputKey === "2" || inputKey === "3")
    ) {
      const starter = STARTER_PROMPTS[Number(inputKey) - 1];
      if (starter) {
        void send(starter.prompt);
        return;
      }
    }

    const curInput = inputRef.current;
    const curPickerOpen = pickerOpenRef.current;
    const slashCtx = parseSlashContext(curInput);
    const curPaletteOpen = slashCtx.active && !curPickerOpen;
    const curFiltered = curPaletteOpen ? filterCommands(slashCtx.query) : [];
    const pickerEntry = curPickerOpen ? flatModels[pickerSelectedRef.current] : undefined;
    const pickerLocked = pickerEntry !== undefined && isLocked(pickerEntry, balanceUsd);
    const state: KeyboardState = {
      input: curInput,
      sending: sendingRef.current,
      pickerOpen: curPickerOpen,
      paletteOpen: curPaletteOpen,
      paletteCount: curFiltered.length,
      paletteSelected: paletteSelectedRef.current,
      pickerSelected: pickerSelectedRef.current,
      pickerCount: flatModels.length,
      pickerLocked,
      pickerLockedWarned:
        pickerEntry !== undefined && lockedWarnedRef.current === pickerEntry.id,
      outOfCredits: false, // guarded at send-time + picker, see above
      historyCount: historyRef.current.length,
      historyNavUpEnabled:
        historyRef.current.length > 0 && historyIdxRef.current !== 0,
      historyNavDownEnabled: historyIdxRef.current !== -1,
      lastEditDueToNav: lastEditDueToNavRef.current,
      nextCtrlCWillExit: exitWarningRef.current,
    };
    const action: KeyboardAction = resolveKeyboardAction(inputKey, key, state);

    switch (action.type) {
      case "none":
        return;
      case "exit-app":
        if (exitWarningTimeoutRef.current !== null) {
          clearTimeout(exitWarningTimeoutRef.current);
          exitWarningTimeoutRef.current = null;
        }
        exit();
        return;
      case "exit-app-warning":
        // Freebuff use-exit-handler.ts: first Ctrl+C arms the exit
        // and shows the warning; only the second within 2s exits.
        armExitWarning();
        return;
      case "clear-input":
        clearDraftEdit();
        setInputBoth("");
        return;
      case "interrupt-stream":
        abortRef.current?.abort();
        return;
      case "open-topup":
        pushSystem(`Top up MethaTech lewat:\n${TOPUP_URL}`);
        tryOpenUrl(TOPUP_URL);
        return;
      case "exit-mode":
        if (curPickerOpen) {
          lockedWarnedRef.current = null;
          setPickerOpenBoth(false);
        } else if (curPaletteOpen) {
          setInputBoth("");
        }
        return;
      case "picker-up":
        lockedWarnedRef.current = null;
        setPickerSelectedBoth(pickerPrev(pickerSelectedRef.current, flatModels.length));
        return;
      case "picker-down":
        lockedWarnedRef.current = null;
        setPickerSelectedBoth(pickerNext(pickerSelectedRef.current, flatModels.length));
        return;
      case "picker-select": {
        const entry = flatModels[pickerSelectedRef.current];
        if (entry) pickModel(entry.id);
        return;
      }
      case "picker-locked-explain": {
        const entry = flatModels[pickerSelectedRef.current];
        if (!entry) return;
        lockedWarnedRef.current = entry.id;
        pushSystem(lockedExplanation(entry));
        return;
      }
      case "picker-locked-open-topup": {
        const entry = flatModels[pickerSelectedRef.current];
        lockedWarnedRef.current = null;
        setPickerOpenBoth(false);
        if (entry) pushSystem(lockedExplanation(entry));
        pushSystem(`Top up MethaTech lewat:\n${TOPUP_URL}`);
        tryOpenUrl(TOPUP_URL);
        return;
      }
      case "palette-up":
        setPaletteSelectedBoth(palettePrevIndex(paletteSelectedRef.current, curFiltered.length));
        return;
      case "palette-down":
        setPaletteSelectedBoth(paletteNextIndex(paletteSelectedRef.current, curFiltered.length));
        return;
      case "palette-complete":
        completePaletteCommand();
        return;
      case "palette-select":
        if (!runPaletteCommand()) {
          const text = curInput.trim();
          setInputBoth("");
          if (text.startsWith("/")) handleSlash(text);
        }
        return;
      case "history-up":
        historyStep(1);
        return;
      case "history-down":
        historyStep(-1);
        return;
      case "cycle-model":
        clearDraftEdit();
        cycleModel(action.dir);
        return;
      case "open-picker":
        openPicker();
        return;
      case "toggle-thinking":
        setThinkingExpanded((v) => !v);
        return;
      case "scroll-up":
        animateScrollTo(pageScrollOffset(scrollOffsetRef.current, "up", messageAvailable, flatLines.length));
        return;
      case "scroll-down":
        animateScrollTo(pageScrollOffset(scrollOffsetRef.current, "down", messageAvailable, flatLines.length));
        return;
      case "show-help":
        pushSystem(HELP_LINES.join("\n"));
        return;
      case "submit": {
        const text = curInput.trim();
        if (!text) return;
        clearDraftEdit();
        setInputBoth("");
        if (text.startsWith("/")) handleSlash(text);
        else void send(text);
        return;
      }
      case "newline":
        clearDraftEdit();
        setInputBoth((v) => `${v}\n`);
        return;
      case "type":
        clearDraftEdit();
        setInputBoth((v) => v + action.text);
        return;
      case "backspace":
        clearDraftEdit();
        setInputBoth((v) => v.slice(0, -1));
        return;
      case "paste":
        clearDraftEdit();
        // Ink delivers pasted text as input events; the multi-char
        // splitter below feeds it through "type" one char at a time,
        // so reaching here with Ctrl+V alone just types nothing.
        return;
    }
  };

  // Ink delivers a fast-typed/pasted run of plain characters as ONE input
  // event (its own useInput docs say so): e.g. "halo\r" arrives as a single
  // string whose key carries no `return` flag, so a trailing Enter in the
  // same chunk would otherwise land inside the input text instead of
  // submitting (observed live: "/exit" + Enter sent in one tmux send-keys
  // needed a second Enter; same for a pasted message + Enter). Split such
  // runs back into atomic keypresses and run each through the same handler,
  // in order. CRLF counts as one Return.
  useInput((inputKey, key) => {
    // Mouse input (SGR wheel/click, see ./mouse.ts) is intercepted
    // BEFORE the atomic splitter below: fed through it, a wheel
    // sequence would be shredded into "[<64;10;5M" characters typed
    // into the draft. Wheel notches scroll immediately (no 200ms
    // page animation — a fling sends many events in a burst);
    // clicks/drags/motion are consumed silently; any non-mouse text
    // in the same delivery falls through to the keyboard path.
    const mouse = parseMouseInput(inputKey, mouseFragmentPendingRef.current);
    mouseFragmentPendingRef.current = mouse.fragmentPending;
    if (mouse.wheels.length > 0) {
      // A wheel event is a user scroll (Freebuff handleScrollChange):
      // cancel any running page animation so the view follows the
      // finger instead of fighting the animation.
      cancelScrollAnimation();
      const curPickerOpen = pickerOpenRef.current;
      const curPaletteOpen = parseSlashContext(inputRef.current).active && !curPickerOpen;
      for (const dir of mouse.wheels) {
        if (curPickerOpen) {
          lockedWarnedRef.current = null;
          setPickerSelectedBoth(
            dir === "up"
              ? pickerPrev(pickerSelectedRef.current, flatModels.length)
              : pickerNext(pickerSelectedRef.current, flatModels.length),
          );
        } else if (curPaletteOpen) {
          const count = filterCommands(parseSlashContext(inputRef.current).query).length;
          setPaletteSelectedBoth(
            dir === "up"
              ? palettePrevIndex(paletteSelectedRef.current, count)
              : paletteNextIndex(paletteSelectedRef.current, count),
          );
        } else {
          setScrollOffsetBoth(
            wheelScrollOffset(scrollOffsetRef.current, dir, WHEEL_LINES, messageAvailable, flatLines.length),
          );
        }
      }
    }
    const text = mouse.rest;
    if (text.length === 0) {
      // Pure mouse delivery (wheel-only, click): nothing for the
      // keyboard path. But a KEY-ONLY event — arrows, PgUp/PgDn,
      // Tab, Esc arrive with input "" and the meaning in `key`
      // (verified by probe 2026-11-09) — must still reach the
      // resolver: the pre-mouse code called handleAtomicKey for
      // every input of length <= 1, including "". Swallowing it
      // here broke Down/PgUp/Tab/Esc/Up outright (s2/s10/s15/
      // s16/s17/s23 regressions, 2026-11-09).
      if (inputKey.length === 0) handleAtomicKey("", key);
      return;
    }
    if (text.length <= 1) {
      handleAtomicKey(text, key);
      return;
    }
    let lastWasReturn = false;
    for (const ch of text) {
      if (ch === "\r") {
        if (lastWasReturn) continue; // CRLF = one Return.
        lastWasReturn = true;
        handleAtomicKey("", { ...key, return: true });
      } else if (ch === "\n") {
        // LF alone: Ctrl+J is a newline (Shift+Enter arrives as
        // return+shift and is handled by the resolver); a bare LF
        // from a paste is a Return.
        if (key.ctrl) {
          lastWasReturn = false;
          handleAtomicKey("j", key);
        } else {
          if (lastWasReturn) continue;
          lastWasReturn = true;
          handleAtomicKey("", { ...key, return: true });
        }
      } else if (ch === "\x03") {
        exit();
        return;
      } else if (ch === "\x7f" || ch === "\x08") {
        lastWasReturn = false;
        handleAtomicKey("", { ...key, backspace: true });
      } else {
        lastWasReturn = false;
        handleAtomicKey(ch, key);
      }
    }
  });

  // Horizontal gutters, layered exactly like Freebuff (see SIDE_GUTTER
  // in layout.ts): this root Box is the scroll container (chat.tsx
  // scrollbox contentOptions paddingLeft 1 / paddingRight 2, right 2 =
  // 1 gutter + 1 scrollbar track — Ink renders the track as a trailing
  // column, so the root only needs paddingX 1). On top of it: the
  // message box adds SIDE_GUTTER 1 (message text at col 2), the header
  // adds paddingLeft 1 (header text at col 2), the footer/status row
  // stays at col 1 (status-bar.tsx root-level padding 1), and the
  // input box keeps its border at col 1 with 1 space inside.
  return (
    <Box
      flexDirection="column"
      backgroundColor={theme.background}
      paddingX={1}
      width={columns}
      height={rows}
    >
      {/* Header: row 0 (wide: 1 row, narrow: 2 rows). paddingLeft 1 on
          top of the root padding (Freebuff chat-header.tsx:46-47:
          paddingLeft 1 inside the scrollbox) puts the header text at
          column 2, aligned with the message text. */}
      <Box flexDirection="column" paddingLeft={1}>
        <Box>
          <Text color={theme.accent} bold>
            MethaTech
          </Text>
          <Text color={theme.muted}> · </Text>
          <Text color={theme.text} bold>
            {model}
          </Text>
          {!narrow && (
            <>
              <Text color={theme.muted}> · </Text>
              {free ? (
                <Text color={theme.accent} bold>
                  FREE $0.00
                </Text>
              ) : price ? (
                <Text color={theme.accent}>
                  ${price.input.toFixed(2)} / ${price.output.toFixed(2)} per 1M
                </Text>
              ) : (
                <Text color={theme.muted}>harga —</Text>
              )}
              <Text color={theme.muted}> · </Text>
              <Text color={balanceUsd === null ? theme.muted : theme.text}>
                Balance {balanceUsd === null ? "—" : formatUsd(balanceUsd)}
              </Text>
            </>
          )}
        </Box>
        {narrow && (
          <Box>
            {free ? (
              <Text color={theme.accent} bold>
                FREE $0.00
              </Text>
            ) : price ? (
              <Text color={theme.accent}>
                ${price.input.toFixed(2)} / ${price.output.toFixed(2)} per 1M
              </Text>
            ) : (
              <Text color={theme.muted}>harga —</Text>
            )}
            <Text color={theme.muted}> · </Text>
            <Text color={balanceUsd === null ? theme.muted : theme.text}>
              Balance {balanceUsd === null ? "—" : formatUsd(balanceUsd)}
            </Text>
          </Box>
        )}
      </Box>

      {/* Message area: flexGrow takes every row the fixed blocks leave;
          justifyContent flex-end pins short histories right above the
          input (Freebuff pattern). Filler rows paint the empty viewport
          black; the window shows only the last budgeted visual lines. */}
      <Box
        flexDirection="column"
        flexGrow={1}
        justifyContent="flex-end"
        backgroundColor={theme.background}
      >
        {showWelcome && welcome ? (
          // Welcome / empty state: exactly `messageAvailable` rows,
          // vertically centered content (layout.ts). No filler needed.
          welcome.rows.map((line, i) => (
            <Text key={`w-${i}`}>
              {line.segments.map((seg, j) => (
                <Text
                  key={j}
                  color={seg.color}
                  bold={seg.bold}
                  italic={seg.italic}
                  strikethrough={seg.strikethrough}
                  dimColor={seg.dim}
                  backgroundColor={seg.backgroundColor}
                >
                  {seg.text}
                </Text>
              ))}
            </Text>
          ))
        ) : (
          <>
            {Array.from({ length: fillerRows }, (_, i) => (
              <Text key={`f-${i}`} backgroundColor={theme.background}>
                {fillerLine}
              </Text>
            ))}
            {showScrollIndicator && (
              <Box flexDirection="row" justifyContent="space-between">
                <Text color={theme.muted}>
                  {showScrollbar
                    ? `↑ ${windowed.hiddenAbove} baris di atas · PgUp/PgDn riwayat`.slice(0, contentWidth - 1)
                    : `↑ ${windowed.hiddenAbove} baris di atas · PgUp/PgDn riwayat`}
                </Text>
                {showScrollbar && (
                  <Text color={scrollbarThumb.start <= 0 && scrollbarThumb.end > 0 ? theme.secondary : theme.muted}>
                    {scrollbarChar(0)}
                  </Text>
                )}
              </Box>
            )}
            {windowed.lines.map((line, i) => {
              const rowIndex = (showScrollIndicator ? 1 : 0) + i;
              const lineText = (
                <Text key={i}>
                  {line.segments.map((seg, j) => (
                    <Text
                      key={j}
                      color={seg.color}
                      bold={seg.bold}
                      italic={seg.italic}
                      strikethrough={seg.strikethrough}
                      dimColor={seg.dim}
                      backgroundColor={seg.backgroundColor}
                    >
                      {seg.text}
                    </Text>
                  ))}
                </Text>
              );
              if (!showScrollbar) return lineText;
              const isThumb =
                rowIndex >= scrollbarThumb.start && rowIndex < scrollbarThumb.end;
              return (
                <Box key={i} flexDirection="row" justifyContent="space-between">
                  {lineText}
                  <Text color={isThumb ? theme.secondary : theme.muted}>
                    {scrollbarChar(rowIndex)}
                  </Text>
                </Box>
              );
            })}
          </>
        )}
      </Box>

      {/* Status row: the Ctrl+C exit warning has the HIGHEST
          priority (Freebuff getStatusIndicatorState: ctrlC first,
          above waiting/streaming) — exact Freebuff text
          "Press Ctrl-C again to exit", theme.secondary. Otherwise
          the thinking/working shimmer + elapsed timer + ■ Esc. */}
      {exitWarning ? (
        <Box>
          <Text color={theme.secondary}>Press Ctrl-C again to exit</Text>
        </Box>
      ) : (
        statusActive && statusLabel && (
          <Box justifyContent="space-between">
            <Thinking label={statusLabel} />
            <Text color={theme.muted}>{statusRightText}</Text>
          </Box>
        )
      )}

      {error && (
        <Box>
          <Text color={theme.error}>{error}</Text>
        </Box>
      )}

      {pickerOpen ? (
        <Box flexDirection="column">
          <Text backgroundColor={theme.background}>{fillerLine}</Text>
          <ModelPicker
            catalog={catalog}
            selectedIndex={pickerSelected}
            activeModel={model}
            maxRows={pickerMaxRows}
            maxWidth={contentWidth}
            balanceUsd={balanceUsd}
          />
        </Box>
      ) : null}

      {/* Input: a BORDERED BOX pinned above the two-row footer by the
          fixed root height (Freebuff chat-input-bar.tsx ClickableTitleBox:
          single rounded border, placeholder inside). The suggestion menu
          (palette) renders INSIDE the box above the input, with one gap
          row between menu and input (chat-input-bar.tsx); the picker
          still renders above the box, directly over it. */}
      <Box borderStyle="round" borderColor={theme.accent} paddingX={1} flexDirection="column">
        {paletteOpen && !pickerOpen ? (
          <>
            <CommandPalette
              commands={filteredCommands}
              selectedIndex={paletteSelected}
              maxWidth={inputInnerWidth}
              maxRows={paletteMaxRows}
            />
            <Text>{" "}</Text>
          </>
        ) : null}
        <Box>
          {input === "" ? (
            <>
              {!sending && (
                <Text color={theme.accent} bold>
                  ▋
                </Text>
              )}
              <Text color={theme.muted}>{INPUT_PLACEHOLDER}</Text>
            </>
          ) : (
            <>
              <Text color={theme.text}>{input}</Text>
              {!sending && (
                <Text color={theme.accent} bold>
                  ▋
                </Text>
              )}
            </>
          )}
        </Box>
      </Box>
      {/* Footer, line 1: model · price · cwd · /model to change ·
          Chat: name. Line 2 (last row): usage + scroll + hints. */}
      <Box>
        <Text color={theme.muted}>{footerLineShown.slice(0, columns - 2)}</Text>
      </Box>
      <Box>
        <Text color={theme.muted}>
          {statusPartsShown.map((p, i) => (
            <React.Fragment key={i}>
              {i > 0 ? " · " : ""}
              <Text color={p.color ?? theme.muted}>{p.text}</Text>
            </React.Fragment>
          ))}
        </Text>
      </Box>
    </Box>
  );
}
