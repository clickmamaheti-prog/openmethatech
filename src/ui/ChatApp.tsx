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

import React, { useEffect, useMemo, useRef, useState } from "react";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { Box, Text, useApp, useInput, useStdout, type Key } from "ink";
import { theme } from "../theme.js";
import { ApiError, type ChatMessage, type ChatUsage } from "../api.js";
import {
  runAgentLoop,
  cycleMode,
  modeDisplayName,
  modeDescription,
  parseMode,
  generateInitSummary,
  compactPrompt,
  exportConversation,
  selectExportMessages,
  selectConversationMessages,
  collectChatText,
  createDefaultAdapter,
  collectSessionSecrets,
  createRedactor,
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
import { phaseLabel, statusRightItems } from "./thinking.js";
import { summarizeToolResult } from "./tool-summary.js";
import { sanitizeTerminalOutput, sanitizeTerminalText } from "./terminal-safe.js";
import {
  AUTO_SCROLL_DELAY_MS,
  SCROLL_ANIMATION_DURATION_MS,
  SCROLL_ANIMATION_FRAME_MS,
  easeOutCubic,
  INPUT_PLACEHOLDER,
  SIDE_GUTTER,
  breakpoints,
  flattenMessages,
  composerIsCentered,
  COMPOSER_CENTERED_CONTENT_ROWS,
  headerLayout,
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
  type AssistantBlock,
} from "./layout.js";
import { filterCommands, paletteClampIndex, paletteNextIndex, palettePrevIndex } from "./palette.js";
import { flattenGroups, groupCatalog, isLocked, lockedExplanation, pickerNext, pickerPrev } from "./picker.js";
import { parseMouseInput, WHEEL_LINES } from "./mouse.js";
import {
  createTextAttachment,
  buildSendContent,
  truncateEnd,
  attachmentMetaLine,
  toSentMeta,
  LONG_TEXT_THRESHOLD,
  type PendingTextAttachment,
  type SentAttachmentMeta,
} from "./attachments.js";
import { createPasteAssembler, stripAnsi } from "./paste.js";
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
  kind: "chat" | "system";
  ts: number;
  /**
   * True only for the /compact summary message. It stays
   * `kind: "system"` for rendering, but /export includes it (via
   * selectExportMessages) so the pre-compact context is not lost;
   * ordinary system notices have no flag and stay out of exports.
   */
  isSummary?: boolean;
  thinking?: string;
  thinkingComplete?: boolean;
  /**
   * Ordered blocks of one assistant turn (Freebuff ChatMessage.blocks
   * / ContentBlock). Tool calls and to-dos are BLOCKS inside the
   * turn's assistant message — never separate top-level messages —
   * so a turn renders in true arrival order: text, tool, text, tool.
   * `content` keeps the CONCATENATED assistant text of the turn
   * (for /export and /compact, which read message content); the
   * layout renders `blocks` when present and falls back to `content`
   * for messages without blocks.
   */
  blocks?: AssistantBlock[];
  /**
   * Attachments sent with this user message (compact metadata only —
   * the full content lives in the agent history). The layout renders
   * one `📎 title · Type · N baris` line per attachment under the
   * user block (Freebuff message-block.tsx renders its
   * textAttachments as cards under the message).
   */
  attachments?: SentAttachmentMeta[];
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
  // contentWidth is the right-side gutter). 0.1.9 §4q: the scrollbar
  // is gone (Reza's order — no track/thumb column at the right edge),
  // so lines always wrap at the full messageWidth; no column is
  // reserved for a track anymore. Narrow terminals stay safe:
  // contentWidth floors at 20, so messageWidth never drops below 19
  // — no static padding number can break a small terminal.
  const messageWidth = contentWidth - SIDE_GUTTER;
  // Freebuff-style breakpoints (layout.ts): width xs < 50, sm 50-100,
  // md 100-150, lg > 150; height xs < 20, sm 20-40, md > 40. The header
  // stacks in two rows on narrow terminals (xs width), as before.
  const bp = breakpoints(columns, rows);
  const narrow = bp.width === "xs";

  const [model, setModel] = useState(initialModel);
  // Fase 8: redact session secrets from anything model-generated
  // that reaches the screen (assistant text, thinking, errors,
  // /compact summary). The loop already redacts its own events;
  // this is the display-side whole-message pass — it catches a
  // secret that arrived split across two stream deltas.
  const redact = useMemo(() => createRedactor(collectSessionSecrets(apiKey)), [apiKey]);
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
  // Pending large-paste text attachments (Freebuff
  // PendingTextAttachment, see ./attachments.ts): cards shown above
  // the input box, content sent with the next message. Same ref +
  // state mirroring as the draft, for the same reason.
  const [attachments, setAttachments] = useState<PendingTextAttachment[]>([]);
  const attachmentsRef = useRef<PendingTextAttachment[]>([]);
  const setAttachmentsBoth = (
    updater: PendingTextAttachment[] | ((prev: PendingTextAttachment[]) => PendingTextAttachment[]),
  ) => {
    const next = typeof updater === "function" ? updater(attachmentsRef.current) : updater;
    attachmentsRef.current = next;
    setAttachments(next);
  };
  // Bracketed-paste assembler (see ./paste.ts): one instance per
  // chat session, kept in a ref because useInput must see the
  // accumulated state across deliveries.
  const pasteAssemblerRef = useRef(createPasteAssembler());
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
  // the stop hint is exactly "■ Esc". The row shows for the whole
  // request, not just while waiting.
  //
  // Layout is Freebuff's status bar (status-bar.tsx): the bar's own
  // root box carries paddingLeft/Right 1 — the scrollbox content
  // carries the same paddingLeft 1, so the indicator lands on the
  // SAME column as the message text (col 3 here: root paddingX 1 +
  // bar padding 1, matching root paddingX 1 + SIDE_GUTTER 1). The
  // bar is two flex zones: the indicator left, the right cluster
  // (Agent step + timer + ■ Esc) right-aligned with gap 1 between
  // items, the Esc button in its own padded cell (StatusActionButton:
  // paddingLeft/Right 1). Timer and Esc render in theme.secondary,
  // like Freebuff — never one " · "-joined muted string.
  const statusActive = sending && error === null;
  const statusLabel = statusActive ? phaseLabel(gotFirstDelta ? "streaming" : "waiting") : null;
  const statusRight = statusRightItems({
    showStep: agentRunning,
    agentSteps,
    elapsedSec,
    narrow,
    // Row content width: root paddingX 1 + status-bar padding 1,
    // each side (the cascade in statusRightItems fits the cluster
    // to this width, dropping the timer, then the step).
    availableWidth: columns - 4,
  });

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
  // 0.1.9 §4o: at rest the composer content area is 3 rows with the
  // input vertically centered (chat.tsx:2122-2123
  // shouldCenterInputVertically), so the box is 5 rows tall, not 3.
  // The EFFECTIVE content rows feed the budget, so the picker/palette
  // budgets shrink by exactly the 2 extra rows.
  const headerRows = narrow ? 2 : 1;
  const inputInnerWidth = Math.max(10, contentWidth - 4);
  const displayInput = input === "" ? INPUT_PLACEHOLDER : input;
  const inputContentRows = Math.max(
    1,
    Math.min(Math.floor(rows / 2), wrapLineCount(displayInput, inputInnerWidth)),
  );
  const centerInput = composerIsCentered(inputContentRows, paletteOpen);
  const effectiveInputContentRows = centerInput
    ? COMPOSER_CENTERED_CONTENT_ROWS
    : inputContentRows;
  const footerRows = 2;
  // The exit warning reuses the status row's budget slot (Freebuff
  // status bar is one fixed row; the ctrlC warning has the highest
  // status-indicator priority, above waiting/streaming).
  const thinkingRows = statusActive || exitWarning ? 1 : 0;
  const errorRows = error ? wrapLineCount(error, contentWidth) : 0;
  const inputBoxBaseRows = 2 + effectiveInputContentRows;
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
  const inputBoxRows = inputBoxRowsFor(effectiveInputContentRows, paletteRowsInside);
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
  // instead of an empty black hole — info card, suggestions,
  // vertically centered in the area. It is exactly
  // `messageAvailable` rows, so the budget math below stays exact.
  // The first sent message makes the STARTERS disappear for good
  // (until /clear); the info card itself PERSISTS as the
  // conversation header (Freebuff chat.tsx:2243-2275 — the header is
  // a permanent first child of the scrollbox), prepended to the
  // message lines below.
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
  // No scrollbar (0.1.9 §4q, Reza's order): Freebuff's scrollbox
  // hides its own scrollbar too (chat.tsx:2246 scrollbarOptions
  // visible: false), and MethaTech used to draw a 1-wide track
  // (│/█) as a trailing column on every message-area row while
  // re-wrapping lines one column narrower. That column is gone:
  // lines always wrap at the full messageWidth, so the reclaimed
  // column goes back to the text (dividers run one column wider
  // while history overflows). The scroll FUNCTION is untouched —
  // scrollOffset, wheel, PgUp/PgDn, auto-scroll, easeOutCubic,
  // and the footer scroll affordances all work exactly as before;
  // only the visible track/thumb is removed.
  // Persistent conversation header (Freebuff chat.tsx:2243-2275 —
  // the header is a PERMANENT first child of the scrollbox, not an
  // empty-state-only branch): the welcome card stays above the
  // messages once the conversation starts, and only scrolls away
  // naturally once the history overflows the viewport. In the empty
  // state the welcome block already contains the same card, so the
  // header is prepended only when messages exist — never twice.
  // The header is render-only lines: /export and /compact read the
  // message list, never these rows.
  const header = headerLayout({
    contentWidth,
    model,
    free,
    priceText,
    balanceUsd,
    hasMessages: messages.length > 0,
  });
  const flatLines = showWelcome
    ? []
    : [...header, ...flattenMessages(messages, messageWidth, { thinkingExpanded })];
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
  // The scroll FUNCTION is unchanged (scrollOffset, wheel, PgUp/PgDn,
  // auto-scroll, animation) — only the visible scrollbar is gone
  // (§4q), so there is no thumb range to compute anymore.
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
  // Fase 7: the usage part (turn total, fed by the agent loop)
  // shares this line with the hint. The full hint + usage no
  // longer fit at 80 cols, and the drop cascade would shed the
  // hint — including the "Ctrl+C 2x keluar" exit hint. So when
  // usage is present, the hint shortens to the compact variant if
  // the full one does not fit alongside it; the compact hint keeps
  // every key (history, help, exit).
  const fullHintText = "↑↓ history · ? help · / perintah · /model pilih model · Ctrl+C 2x keluar";
  const shortHintText = "↑↓ history · ? help · Ctrl+C 2x keluar";
  const usageText = lastUsage ? formatUsageLine(lastUsage.usage, priceFor(catalog, lastUsage.model)) : null;
  const hintText =
    contentWidth >= 72 && (!usageText || usageText.length + 3 + fullHintText.length <= columns - 2)
      ? fullHintText
      : shortHintText;
  const statusParts: { text: string; color?: string }[] = [];
  if (usageText) {
    statusParts.push({ text: usageText });
  }
  if (windowed.hiddenBelow > 0) {
    statusParts.push({
      text: narrow
        ? `↓ PgDn (${windowed.hiddenBelow})`
        : `↓ PgDn ke bawah (${windowed.hiddenBelow} baris)`,
      color: theme.secondary,
    });
  }
  // Attachment hint (only while cards are pending): Ctrl+E edits /
  // Ctrl+X removes the most recent card. Inserted before the hint
  // part so the drop-from-the-end cascade sheds the hint first.
  if (attachments.length > 0) {
    statusParts.push({ text: "lampiran: Ctrl+E edit · Ctrl+X hapus", color: theme.secondary });
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
  /**
   * Append a tool call as a BLOCK inside the current turn's assistant
   * message (Freebuff ContentBlock tool, blocks-renderer.tsx) — never
   * a separate top-level message. Before this change, tool calls were
   * their own messages appended AFTER the assistant message, so all
   * assistant text of the turn rendered ABOVE all tool calls no
   * matter when it actually arrived.
   */
  const pushTool = (preview: string, toolName: string) => {
    const clean = sanitizeTerminalText(preview);
    setMessages((m) => {
      const copy = [...m];
      for (let i = copy.length - 1; i >= 0; i--) {
        const msg = copy[i];
        if (msg && msg.role === "assistant" && msg.kind === "chat") {
          const block: AssistantBlock = {
            type: "tool",
            name: toolName,
            preview: clean,
            shell: clean.startsWith("$ "),
            results: [],
            done: false,
          };
          copy[i] = { ...msg, blocks: [...(msg.blocks ?? []), block] };
          return copy;
        }
      }
      return copy;
    });
  };
  /**
   * Attach a result to its tool block. Results arrive in call order
   * (the orchestrator guarantees it), so the target is the earliest
   * block of this tool whose result has not arrived yet (`done` is
   * false) — even when a parallel wave pushed several tool blocks
   * before any result landed (all onCallStart fire before all
   * onCallResult, so "the last tool message" used to get every
   * result of the wave). A null summary still marks the block done:
   * a successful read_files shows no result line (§4m), but the
   * block must not stay "unresolved" or a later result for the same
   * tool would attach to it. Falls back to the earliest unresolved
   * block of any tool when the name does not match (defensive only).
   *
   * When NO block matches, the call never got a tool_call event —
   * the orchestrator rejected it before announcing it (mode-rejected
   * or unknown tool: onCallStart only fires after the mode check).
   * Dropping that result silently would hide the rejection, so it is
   * surfaced as a system line instead (Freebuff uses system messages
   * for out-of-band notices). Before the block model, the same
   * rejection was glued onto whatever tool message happened to be
   * last — visible, but attached to the wrong tool.
   */
  const appendToolResult = (toolName: string, summary: string | null, ok: boolean) => {
    // The summary is tool output / file content (external text):
    // strip escapes and collapse progress-bar redraws before it
    // reaches the layout. The layout adds its own ✓/✗ marker, so
    // the stored text is the plain summary, not the decorated line.
    const clean = summary === null ? null : sanitizeTerminalOutput(summary);
    setMessages((m) => {
      const copy = [...m];
      for (let i = copy.length - 1; i >= 0; i--) {
        const msg = copy[i];
        if (msg && msg.role === "assistant" && msg.kind === "chat" && msg.blocks) {
          const blocks = [...msg.blocks];
          let bi = blocks.findIndex((b) => b.type === "tool" && b.name === toolName && !b.done);
          if (bi < 0) bi = blocks.findIndex((b) => b.type === "tool" && !b.done);
          if (bi < 0) continue;
          const tool = blocks[bi];
          if (tool.type !== "tool") continue;
          blocks[bi] = {
            ...tool,
            done: true,
            results: clean === null ? tool.results : [...tool.results, { ok, text: clean }],
          };
          copy[i] = { ...msg, blocks };
          return copy;
        }
      }
      // No block for this result: surface the rejection instead of
      // dropping it (see above). A null summary has nothing to show.
      if (clean === null) return copy;
      return [...copy, { role: "assistant", content: clean, kind: "system", ts: Date.now() }];
    });
  };
  /**
   * Replace the to-do list BLOCK inside the current turn's assistant
   * message, or append it when the turn has none yet. Freebuff
   * write-todos.tsx: an empty list renders nothing, so an empty
   * update removes the block. The block stays at the position where
   * it first appeared inside the turn (its content is replaced, its
   * place is not) — the old top-level message was replaced in place
   * too, but at a position that could end up ABOVE text and tools
   * that arrived after it.
   */
  const upsertTodosMessage = (todos: { task: string; completed: boolean }[]) => {
    setMessages((m) => {
      const copy = [...m];
      for (let i = copy.length - 1; i >= 0; i--) {
        const msg = copy[i];
        if (msg && msg.role === "assistant" && msg.kind === "chat") {
          const blocks = [...(msg.blocks ?? [])];
          const bi = blocks.findIndex((b) => b.type === "todos");
          if (todos.length === 0) {
            if (bi >= 0) blocks.splice(bi, 1);
          } else if (bi >= 0) {
            blocks[bi] = { type: "todos", todos };
          } else {
            blocks.push({ type: "todos", todos });
          }
          copy[i] = { ...msg, blocks };
          return copy;
        }
      }
      return copy;
    });
  };
  /**
   * Append streamed agent text to the last TEXT block of the current
   * turn's assistant message — or start a new text block when the
   * last block is a tool/todos block (Freebuff: text deltas extend
   * the root text stream; a tool call in between starts a new text
   * segment after it). `content` keeps the concatenated text of the
   * whole turn (for /export and /compact); the layout renders the
   * blocks, so the text lands BELOW any tool that ran before it.
   */
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
          const blocks = [...(msg.blocks ?? [])];
          const last = blocks[blocks.length - 1];
          if (last && last.type === "text") {
            blocks[blocks.length - 1] = { ...last, content: last.content + delta };
          } else {
            blocks.push({ type: "text", content: delta });
          }
          copy[i] = { ...msg, content: msg.content + delta, blocks };
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
    // Capture pending attachments (Freebuff
    // capturePendingAttachments): the draft + every attachment, in
    // paste order, become the single user prompt the agent sees
    // (buildSendContent — `[Pasted Text]` blocks with the FULL
    // content). The user message in the history keeps the draft
    // text + compact card metadata; the full attachment content
    // lives in the agent history (loop.ts stores userPrompt).
    const pendingAttachments = attachmentsRef.current;
    const finalContent = buildSendContent(text, pendingAttachments);
    if (finalContent.trim().length === 0) return;
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
    historyRef.current = text ? [...historyRef.current, text] : historyRef.current;
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
    setMessages((m) => [...m, { role: "user", content: text, kind: "chat", ts: now, attachments: pendingAttachments.map(toSentMeta) }]);
    // The cards are consumed by this send (Freebuff clears pending
    // attachments in prepareUserMessage) — a later message starts
    // with no cards, and a re-send never duplicates the content.
    setAttachmentsBoth([]);
    setMessages((m) => [...m, { role: "assistant", content: "", kind: "chat", ts: now, thinking: "", blocks: [] }]);
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
        userPrompt: finalContent,
        history: priorHistory,
        signal: abort.signal,
        // Fase 8: audit-log every tool call of this turn.
        audit: true,
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
                  copy[i] = { ...msg, thinking: (msg.thinking ?? "") + redact(e.text) };
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
            // Display summary only (tool-summary.ts, Freebuff
            // tool-branch.tsx + read-files.tsx): the full output
            // still goes to the model in the loop's role "tool"
            // history message. A null summary means no result line —
            // the preview already says everything (read_files shows
            // only its paths, never file contents) — but the call
            // still counts as resolved for its block (appendToolResult
            // marks done even for a null summary).
            const summary = summarizeToolResult(e.toolName, e.output, e.ok);
            appendToolResult(e.toolName, summary, e.ok);
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
      // Fase 7: per-turn usage surfacing (follow-up lama) — the
      // footer already has the usage slot (formatUsageLine); the
      // agent loop never fed it before, so agent turns showed no
      // usage. The turn total (summed across steps) goes there.
      if (result.usage) setLastUsage({ usage: result.usage, model: currentModel });
      // Fase 7: auto-compaction notice — the stored history was
      // shortened by a summary; tell the user once, plainly.
      if (result.context?.compacted) {
        pushSystem(
          `Konteks percakapan lama diringkas otomatis (${result.context.droppedMessages} pesan lama diganti ringkasan) supaya tetap muat di context window.`,
        );
      }
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
              // Empty means no text AND no blocks: a turn that only
              // ran tools still has its tool blocks to show, so it
              // is never spliced away (the old content-only check
              // would have deleted the tools with the message).
              if (msg.content === "" && (msg.blocks ?? []).length === 0) copy.splice(i, 1);
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
        setError(redact(sanitizeTerminalText(message)));
        setMessages((m) => {
          const copy = [...m];
          for (let i = copy.length - 1; i >= 0; i--) {
            const msg = copy[i];
            if (msg && msg.role === "assistant" && msg.kind === "chat" && msg.content === "" && (msg.blocks ?? []).length === 0) {
              copy.splice(i, 1);
              break;
            }
          }
          return copy;
        });
      }
    } finally {
      // Fase 8: whole-message redaction pass. Deltas are stored raw
      // on purpose (a split ANSI escape would corrupt per-delta
      // sanitizing); the loop redacts its own events, but a secret
      // split across two deltas only becomes visible once the
      // message is whole — redact the reassembled content + thinking
      // of every assistant message before the turn is over.
      setMessages((m) =>
        m.map((msg) =>
          msg.role === "assistant"
            ? {
                ...msg,
                content: redact(msg.content),
                thinking: msg.thinking ? redact(msg.thinking) : msg.thinking,
                // Text deltas are stored raw inside blocks too, so
                // the same whole-message pass redacts them (plus tool
                // previews/results and to-do tasks, which may echo
                // file contents or command output).
                blocks: msg.blocks?.map((b) =>
                  b.type === "text"
                    ? { ...b, content: redact(b.content) }
                    : b.type === "tool"
                      ? {
                          ...b,
                          preview: redact(b.preview),
                          results: b.results.map((r) => ({ ...r, text: redact(r.text) })),
                        }
                      : { ...b, todos: b.todos.map((t) => ({ ...t, task: redact(t.task) })) },
                ),
              }
            : msg,
        ),
      );
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
    // Conversation content = chat messages PLUS the previous /compact
    // summary (isSummary). The summary carries the pre-compact
    // context, so a second /compact must feed it back into the
    // summarization — filtering `kind === "chat"` only silently lost
    // it. Ordinary system notices stay out (see
    // selectConversationMessages).
    const chatHistory: ChatMessage[] = selectConversationMessages(messagesRef.current);
    if (chatHistory.length === 0) {
      pushSystem("Belum ada percakapan untuk diringkas.");
      return;
    }
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      // Fase 2: the one-shot summarization call goes through the
      // ModelAdapter like every other model call (same transport,
      // same text — only the contract differs).
      const { text: summary } = await collectChatText(
        createDefaultAdapter(),
        { apiKey, model: modelRef.current, messages: [{ role: "user", content: compactPrompt(chatHistory) }], maxTokens: 1024 },
      );
      agentHistoryRef.current = [];
      setMessages([
        {
          role: "assistant",
          content: `Ringkasan percakapan:\n${redact(sanitizeTerminalText(summary))}`,
          kind: "system",
          isSummary: true,
          ts: Date.now(),
        },
      ]);
      setLastUsage(null);
      setScrollOffsetBoth(0);
    } catch (e) {
      const message = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
      setError(redact(sanitizeTerminalText(message)));
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
        // Direct response to a command the user just typed: snap to
        // the bottom so the confirmation is visible even when the
        // user had scrolled up (same as /export). pushSystem itself
        // never resets scroll.
        setScrollOffsetBoth(0);
        break;
      }
      case "mode": {
        if (arg) {
          const parsed = parseMode(arg);
          if (!parsed) {
            pushSystem(`Mode tidak dikenal: ${arg}. Pilih: default, lite, max, plan.`);
            // Direct response to a command the user just typed (same
            // rule as /export): snap to the bottom so it is visible.
            setScrollOffsetBoth(0);
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
        // Direct response to a command the user just typed (same
        // rule as /export): snap to the bottom so it is visible.
        setScrollOffsetBoth(0);
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
        // Direct response to a command the user just typed (same
        // rule as /export): snap to the bottom so it is visible.
        setScrollOffsetBoth(0);
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
          messages: selectExportMessages(messagesRef.current),
        });
        pushSystem(`Percakapan diekspor ke:\n${file}`);
        // The confirmation is the direct result of a command the
        // user just typed: snap to the bottom so it is visible even
        // when the user had scrolled up (same as send() / /clear /
        // /compact). pushSystem itself never resets scroll, so other
        // system notices keep the sticky-bottom "don't yank while
        // reading" behaviour.
        setScrollOffsetBoth(0);
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

  /**
   * Handle one completed paste payload (Freebuff
   * utils/strings.ts createPasteHandler: the payload is ANSI-
   * stripped first, then — when longer than LONG_TEXT_THRESHOLD —
   * becomes a text attachment instead of inline text).
   * - Short paste: appended to the draft (MethaTech has no in-draft
   *   cursor, so Freebuff's insert-at-cursor becomes append-at-end).
   * - Long paste: a PendingTextAttachment card above the input box;
   *   the draft stays clean and the full content rides with the
   *   next send (see send()).
   * - Whitespace-only payloads are ignored.
   */
  const handlePaste = (payload: string) => {
    if (payload.trim().length === 0) return;
    clearDraftEdit();
    if (payload.length > LONG_TEXT_THRESHOLD) {
      setAttachmentsBoth((prev) => [...prev, createTextAttachment(payload)]);
    } else {
      setInputBoth((v) => v + payload);
    }
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
      attachmentsCount: attachmentsRef.current.length,
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
        // An attachments-only send (empty draft, cards present) is
        // a real send — Freebuff's prepareUserMessage sends the
        // attachments alone when there is no draft text.
        if (!text && attachmentsRef.current.length === 0) return;
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
      case "attachment-remove-last":
        // LIFO: the most recent card (Freebuff removes the clicked
        // card; MethaTech has no click hit-test, so the newest card
        // goes first). Removing the card removes the pending
        // attachment — nothing orphaned is ever sent.
        setAttachmentsBoth((prev) => prev.slice(0, -1));
        return;
      case "attachment-edit-last": {
        // Freebuff has NO edit for text attachments (remove only).
        // Reza asked for edit: expand the newest card back into the
        // draft so it can be edited as plain text, then drop the
        // card. Sending afterwards sends the edited text inline —
        // the paste threshold applies to paste events only, not to
        // edits, so it is not re-attached.
        const last = attachmentsRef.current[attachmentsRef.current.length - 1];
        if (!last) return;
        clearDraftEdit();
        setAttachmentsBoth((prev) => prev.slice(0, -1));
        setInputBoth((v) => v + last.content);
        return;
      }
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
    // Bracketed paste (see ./paste.ts) is intercepted FIRST, before
    // the mouse parser and the atomic splitter: a paste payload may
    // contain SGR-looking text (which the mouse parser would strip)
    // and newlines (which the splitter would turn into submits), so
    // neither may ever see the inside of a paste. Completed pastes
    // go to handlePaste (short -> draft, long -> attachment card);
    // while a paste is still open (chunked delivery, end marker not
    // yet seen) the whole delivery is swallowed — a half paste must
    // never reach the draft.
    const fed = pasteAssemblerRef.current.feed(inputKey);
    for (const payload of fed.pastes) handlePaste(payload);
    if (fed.collecting) return;
    // Mouse input (SGR wheel/click, see ./mouse.ts) is intercepted
    // BEFORE the atomic splitter below: fed through it, a wheel
    // sequence would be shredded into "[<64;10;5M" characters typed
    // into the draft. Wheel notches scroll immediately (no 200ms
    // page animation — a fling sends many events in a burst);
    // clicks/drags/motion are consumed silently; any non-mouse text
    // in the same delivery falls through to the keyboard path.
    const mouse = parseMouseInput(fed.plain, mouseFragmentPendingRef.current);
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
    // Fallback: a long PLAIN delivery with no bracketed markers is
    // a paste from a terminal that ignored 2004h (Ink's own
    // useInput docs: a paste arrives as one call). Checked BEFORE
    // the splitter below — it would shred the payload and turn its
    // embedded newlines into submits — and only when no wheel
    // events rode in the same delivery (a scroll burst is not a
    // paste). One trailing line break is stripped: it is either the
    // user's Enter glued onto the paste or the paste's own final
    // newline, and it does NOT submit — the user presses Enter
    // again to send. The bracketed path is exact (no stripping,
    // Enter arrives as its own call); this fallback is best-effort
    // and documented as such in docs §4l.
    if (
      mouse.wheels.length === 0 &&
      text.length > LONG_TEXT_THRESHOLD &&
      !key.ctrl &&
      !key.meta &&
      key.return !== true
    ) {
      handlePaste(stripAnsi(text.replace(/\r\n?$/, "").replace(/\n$/, "")));
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
  // 1 gutter + 1 scrollbar track in Freebuff's own geometry — MethaTech
  // renders no track anymore (§4q), so the root only needs
  // paddingX 1). On top of it: the
  // message box adds SIDE_GUTTER 1 (message text at col 3), the header
  // adds paddingLeft 1 (header text at col 3), the status row adds
  // its own paddingLeft 1 (status-bar.tsx root box: indicator at
  // col 3, aligned with the message text — NOT at col 2, one column
  // left of the conversation), and the input box keeps its border
  // at col 2 with 1 space inside. The footer lines stay at col 2
  // (root padding only) — they are not status-bar content.
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

      {/* Message area: flexGrow takes every row the fixed blocks leave.
          Freebuff chat.tsx contentOptions: justifyContent flex-start
          for the Freebuff brand — the conversation is TOP-anchored, the
          empty space sits below the last message inside the viewport,
          never above it. 0.1.9 §4o: flex-end pinned short histories
          right above the input and left a black void ABOVE the
          conversation (up to 20 rows at 120x40) — that was the "celah
          kosong". Filler rows still paint the empty viewport black, now
          after the windowed lines, so the frame stays exactly `rows`
          tall; the window shows only the last budgeted visual lines. */}
      <Box
        flexDirection="column"
        flexGrow={1}
        justifyContent="flex-start"
        backgroundColor={theme.background}
      >
        {showWelcome && welcome ? (
          // Welcome / empty state: exactly `messageAvailable` rows,
          // top-anchored content (layout.ts, Freebuff chat.tsx: the
          // header is the first child of the scrollbox). No filler needed.
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
            {showScrollIndicator && (
              <Text color={theme.muted}>
                {`↑ ${windowed.hiddenAbove} baris di atas · PgUp/PgDn riwayat`}
              </Text>
            )}
            {windowed.lines.map((line, i) => (
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
            ))}
            {/* Filler AFTER the lines (0.1.9 §4o, Freebuff flex-start):
                the empty viewport sits below the conversation, never
                above it. Count unchanged — the frame stays exactly
                `rows` tall. */}
            {Array.from({ length: fillerRows }, (_, i) => (
              <Text key={`f-${i}`} backgroundColor={theme.background}>
                {fillerLine}
              </Text>
            ))}
          </>
        )}
      </Box>

      {/* Status row: the Ctrl+C exit warning has the HIGHEST
          priority (Freebuff getStatusIndicatorState: ctrlC first,
          above waiting/streaming) — exact Freebuff text
          "Press Ctrl-C again to exit", theme.secondary. Otherwise
          the thinking/working shimmer + elapsed timer + ■ Esc. */}
      {exitWarning ? (
        <Box paddingLeft={1}>
          <Text color={theme.secondary}>Press Ctrl-C again to exit</Text>
        </Box>
      ) : (
        statusActive && statusLabel && (
          <Box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
            <Thinking label={statusLabel} />
            <Box flexDirection="row" justifyContent="flex-end" gap={1}>
              {statusRight.step !== null && <Text color={theme.secondary}>{statusRight.step}</Text>}
              {statusRight.timer !== null && <Text color={theme.secondary}>{statusRight.timer}</Text>}
              <Box paddingLeft={1} paddingRight={1}>
                <Text color={theme.secondary}>■ Esc</Text>
              </Box>
            </Box>
          </Box>
        )
      )}

      {error && (
        <Box>
          <Text color={theme.error}>{error}</Text>
        </Box>
      )}

      {/* Pending attachment cards (Freebuff
          pending-attachments-banner.tsx: a banner above the input
          bar; here one bordered card per paste, in paste order).
          Width adapts to the content (title / meta line), clamped
          to 24–40 cols so a narrow terminal never overflows; the
          title is truncated with an ellipsis at render time only
          (the stored title keeps the full first line). */}
      {attachments.length > 0 && (
        <Box flexDirection="row" gap={1} paddingLeft={1} flexWrap="wrap">
          {attachments.map((a) => {
            const meta = attachmentMetaLine(a);
            const inner = Math.min(36, Math.max(20, Math.max(a.title.length, meta.length)));
            return (
              <Box
                key={a.id}
                borderStyle="round"
                borderColor={theme.muted}
                paddingX={1}
                flexDirection="column"
                width={inner + 4}
              >
                <Text color={theme.text} bold>
                  {truncateEnd(a.title, inner)}
                </Text>
                <Text color={theme.muted}>{meta}</Text>
              </Box>
            );
          })}
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
        {/* Composer rest height, 0.1.9 §4o (Freebuff chat-input-bar.tsx +
            chat.tsx:2122-2123 shouldCenterInputVertically): single-line
            draft + palette closed -> the content area is 3 rows with the
            input vertically centered inside the bordered box (5 rows
            total). Multiline / palette open -> hugs the content. */}
        <Box
          flexDirection="column"
          height={centerInput ? COMPOSER_CENTERED_CONTENT_ROWS : undefined}
          justifyContent={centerInput ? "center" : "flex-start"}
        >
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
