// Local agent loop (MethaTech CLI) — the Universal Agent Loop
// (Universal Agent Runtime, Fase 5).
//
// The loop is the single turn driver for every model. It depends
// ONLY on the two Fase 2–4 contracts, never on a concrete transport
// or handler:
//
//   - ModelAdapter (src/agent/model-adapter.ts, Fase 2): every model
//     request goes through `adapter.chat` via `collectChatText`.
//     The loop never calls streamChat or any transport directly.
//     The adapter is INJECTED (AgentLoopOptions.adapter, default:
//     the panel relay adapter); a mock adapter drives the loop in
//     tests without touching the network.
//   - Tool Orchestrator (src/agent/tool-orchestrator.ts, Fase 4):
//     every tool execution goes through `executeToolCalls` as one
//     batch per step. The loop never calls a handler directly.
//   - Tool Registry (src/agent/tool-registry.ts, Fase 3): guards
//     (failed-edit, todo-loop recovery note) read classification
//     from the registry, never hardcoded tool names.
//
// One turn cycle (unchanged since 0.1.7, now contract-bound):
//
//   build system prompt (fresh per turn) → prepareContext: the
//   sendable view is budgeted against the model's window (Fase 7;
//   stored history is never mutated by truncation, auto-compaction
//   at most once per turn) → adapter.chat with retry (Fase 7: max
//   3 attempts on retryable provider errors, only when the failed
//   attempt streamed nothing) → parse <codebuff_tool_call> from the
//   collected text (XML path, formalized in Fase 6:
//   fallback-protocol.ts) → orchestrator batch → tool messages
//   appended to history → repeat until task_completed / no tool
//   calls / maxSteps / no-progress 40 / todo-loop 6 / failed-edit 6
//   / abort / incomplete stream / content_filter / length stop.
//
// Invariants the loop guarantees (tested in test/agent-loop.test.mjs
// and test/fallback-protocol.test.mjs):
//   - one parsed tool call = exactly one execution (execution
//     ledger, AgentLoopResult.executedToolCalls; keys step:index
//     are unique within a turn); a call that fails validation
//     never runs, so it never appears in the ledger (Fase 6);
//   - the tool-call channel is resolved from the capability
//     registry (Fase 6, fallback-protocol.ts): native only when
//     proven SUPPORTED, otherwise the XML fallback; UNKNOWN is
//     never treated as SUPPORTED;
//   - two consecutive protocol violations (malformed JSON, unknown
//     tool, schema-invalid input, or promised-but-missing calls)
//     stop the turn with an explicit message to the user; a handler
//     error is NOT a violation — the call ran, the tool failed.
//   - history format is unchanged: assistant message keeps the raw
//     text (Fase 8: redacted as a whole before it is stored — the
//     model still sees its own calls, minus any secret values);
//     tool messages are produced ONLY by resultToToolMessage
//     ({tool, ok, output} + synthetic call-{step}-{index} id);
//   - a provider error ends the step, never the session: the loop
//     returns the history intact so the next turn resumes from it;
//   - a tool error is a result on the same channel, the model gets
//     one retry step, the turn does not crash;
//   - abort (Esc / Ctrl+C) stops the turn with "interrupted by user".
//
// Fase 7 (Context & Streaming) invariants:
//   - the model receives a budgeted VIEW of history
//     (context-manager.ts prepareContext): system prompt + pinned
//     summaries are never dropped; whole exchanges are dropped
//     from the front, the last exchange never; tool results are
//     truncated only in the view, never in stored history;
//   - auto-compaction (once per turn) replaces a dropped segment
//     with a summary message in stored history; a failed summary
//     falls back to the truncated view — the turn never crashes
//     on a summarization error;
//   - a stream that ends without a finish reason or usage chunk
//     is INCOMPLETE: the partial text never enters history and
//     never becomes the final answer;
//   - finish reasons content_filter and length end the turn
//     explicitly (completed=false) when no tool calls were
//     emitted; usage is summed per step into result.usage.
//
// Fase 8 (Security Hardening) invariants:
//   - every tool output is redacted before it reaches the model
//     (orchestrator, whole reassembled text) and every streamed
//     text/reasoning event is redacted before display; the stored
//     assistant message is redacted as a whole, so a secret split
//     across stream deltas cannot survive in history;
//   - run_terminal_command is validated before it runs and runs in
//     a user+mount namespace when the platform supports it
//     (credential dirs masked); the shell child never inherits
//     the parent's secrets (scrubbed environment);
//   - file tools resolve symlinks and refuse paths whose real
//     location escapes the workspace;
//   - every processed tool call is audit-logged (when the caller
//     enables it) with a sanitized, redacted argument summary.
//
// What this loop does NOT do (explicit non-goals, per Reza):
// - No native `tools` (a later phase, NOT Fase 5): the adapter
//   still rejects requests carrying tools, fail-loud.
// - No confirmation gate / Ask / YOLO / --yolo: Fase 8 (Security
//   Hardening) was ordered WITHOUT them — Reza's Fase 8 order
//   excludes any new confirmation workflow, so the gate stays an
//   open item of his 2026-11-10 decision 1, not something Fase 8
//   silently completed or cancelled. No new tools, no mode/TUI
//   changes, no panel changes. (Retry policy, token budgeting and
//   auto-compaction are Fase 7 — DONE, see the invariants above.)
//
// Adapted from Freebuff, Apache-2.0:
//   packages/agent-runtime/src/run-agent-step.ts
//     (loopAgentSteps :1115, runAgentStep, shouldEndTurn :901-1030)
//   packages/agent-runtime/src/util/turn-progress.ts
//     (NO_PROGRESS_STOP_THRESHOLD = 40)
//   packages/agent-runtime/src/util/file-edit-loop.ts (3/6/12)
//   common/src/constants/agents.ts
//     (MAX_AGENT_STEPS_DEFAULT = 600, MAX_SUBAGENT_STEPS_DEFAULT = 200)
//
// The loop runs LOCALLY in the CLI (AGENT-ADOPTION.md §0): the panel
// is a plain OpenAI-compatible chat API with no agent runtime, so the
// CLI itself does request → parse tool calls → execute → feed results
// back, until task_completed or no tool calls remain.
//
// MethaTech differences (deliberate, documented):
// - Transport is the ModelAdapter (Fase 2), not the Vercel AI SDK.
// - Tool calls execute AFTER the full step response arrives, not
//   mid-stream with the stream paused (Freebuff processStream). The
//   stream cannot be paused through the adapter's callback API, so
//   batching per step is the honest equivalent.
// - MAX_STEPS default is 100, not 600: on free panel models a 600-step
//   backstop can burn a lot of turns before the no-progress guard
//   (40) stops it; 100 is the working cap, configurable per call.
// - Turn-end rule is relaxed: Freebuff requires task_completed when
//   the toolset has it, or the turn never ends. Free panel models
//   often answer in plain text without ever calling task_completed,
//   which would loop to maxSteps on every chatty answer. MethaTech
//   ends the turn when a step returns no tool calls (and reports it),
//   and treats task_completed as the explicit finish signal.
// - ask_user pauses the turn: the questions are returned to the TUI
//   and the user's next message resumes the loop.

import { type ChatMessage, type ChatUsage } from "../api.js";
import { collectChatText, createDefaultAdapter, normalizeProviderError, type AdapterFinishReason, type ModelAdapter } from "./model-adapter.js";
import {
  addUsage,
  buildSummaryMessage,
  prepareContext,
  resolveContextWindow,
  RESPONSE_RESERVE_MARGIN_TOKENS,
  summarizeSegment,
  type PreparedContext,
} from "./context-manager.js";
import { createStreamParserState, parseFullText, parseStreamChunk } from "./xml-parser.js";
import { buildAgentSystemPrompt, buildProjectContext, stepPrompt } from "./prompt.js";
import { executeToolCalls, resultToToolMessage } from "./tool-orchestrator.js";
import {
  createProtocolTracker,
  isProtocolViolationResult,
  protocolFailureMessage,
  protocolFailureStopReason,
  type ToolCallChannel,
} from "./fallback-protocol.js";
import { FILE_EDIT_TOOLS_UNAVAILABLE_NOTE, toolDescriptionsFor, toolPreview, type TodoItem, type ToolContext } from "./tools.js";
import { isFileEditTool } from "./tool-registry.js";
import { toolNamesForMode, type AgentMode } from "./modes.js";
import { collectSessionSecrets, createRedactor } from "./security.js";

/** Backstop for a turn that never stops (Freebuff: 600). MethaTech working cap: 100. */
export const MAX_AGENT_STEPS_DEFAULT = 100;
/** Freebuff MAX_AGENT_STEPS_DEFAULT, kept as the absolute ceiling. */
export const MAX_AGENT_STEPS_ABSOLUTE = 600;
/** Steps without any successful tool call before stopping (Freebuff: 40). */
export const NO_PROGRESS_STOP_THRESHOLD = 40;
/** Steps that only re-send the same unchanged to-do list before a
 * recovery nudge (Freebuff todo-loop.ts: 3). */
export const TODO_LOOP_RECOVERY_THRESHOLD = 3;
/** Steps that only re-send the same unchanged to-do list before the
 * turn is stopped (Freebuff todo-loop.ts: 6). */
export const TODO_LOOP_STOP_THRESHOLD = 6;
/** Freebuff todo-loop.ts TODO_LOOP_RECOVERY_MESSAGE (verbatim). */
export const TODO_LOOP_RECOVERY_MESSAGE =
  "You have repeatedly called write_todos with the same unchanged list and no other tool use in between. The list is already recorded. Stop repeating it. Use an available tool to make progress on the task, or explain the blocker to the user and end your turn. Respect the current mode and tool permissions.";
/** Freebuff todo-loop.ts TODO_LOOP_STOP_MESSAGE (verbatim). */
export const TODO_LOOP_STOP_MESSAGE =
  "The model got stuck repeating the same to-do list without making progress. This turn was stopped to avoid wasting more of your session. Try a different model or reasoning level, then continue.";
/** Failed edits to the same file before stopping (Freebuff: 6 identical). */
export const FILE_EDIT_LOOP_STOP_THRESHOLD = 6;
/** Max consecutive nudges when the model promises tool work but emits
 * no tool call (live bug 2026-11-09: glm-5.3-flash said "saya cek
 * proyeknya sekarang" and went silent — the turn ended with "no more
 * tool calls" and nothing ever ran). After this many nudges the turn
 * ends instead of looping forever. */
export const MAX_TOOL_CALL_NUDGES = 2;
/** Nudge sent when the model promised tool use but emitted no call. */
export const TOOL_CALL_MISSING_MESSAGE =
  '[TOOL_CALL_MISSING] You said you would check something with a tool, but no tool call was emitted. Emit the tool call NOW inside <codebuff_tool_call> tags with JSON {"cb_tool_name": "<tool name>", ...}. Do not just announce the action — do it in this response.';
/** Max model-call attempts per step (Fase 7 retry policy, Freebuff
 *  codebuff-web-api.ts: 3 attempts for 408/429/500/502/503/504). */
export const MAX_MODEL_CALL_ATTEMPTS = 3;
/** Backoff between retry attempts (ms): 500, then 1000. */
export const MODEL_CALL_RETRY_DELAYS_MS = [500, 1000];
/** Max tokens per model response — also the reply reserve base
 *  for context budgeting (Fase 7). */
export const LOOP_MAX_TOKENS = 4096;

/**
 * Does this step's text promise tool work ("I will check…") without
 * emitting a call? Indonesian + English, because free panel models
 * answer in either. Kept deliberately narrow: a plain answer ("4.",
 * a greeting, an explanation) must NOT match, or every chatty turn
 * would burn a nudge.
 */
const TOOL_PROMISE_PATTERNS: RegExp[] = [
  /saya (akan )?(cek|lihat|periksa|cari|baca|buka|list|tampilkan)/i,
  /aku (akan )?(cek|lihat|periksa|cari|baca|buka)/i,
  /\bcek (dulu|proyek|project|isi|file|folder|direktori|directory)\b/i,
  /let me (check|look|see|read|list|verify)/i,
  /i['’]ll (check|look|list|read|verify)/i,
  /i will (check|look|list|read|verify)/i,
  /i['’]m (going to )?(check|look|list|read)/i,
  /\bchecking (the|this|your|my|our)\b/i,
];

export function looksLikeToolPromise(text: string): boolean {
  return TOOL_PROMISE_PATTERNS.some((p) => p.test(text));
}

/** An abort error shaped like the DOM AbortError the transport
 *  throws (Fase 7): normalizeProviderError maps name === "AbortError"
 *  to kind "aborted" (never retryable). */
function abortError(): Error {
  const e = new Error("dibatalkan");
  e.name = "AbortError";
  return e;
}

/** Sleep that rejects with an AbortError when the signal fires
 *  (Fase 7 retry backoff): a Ctrl+C during backoff must interrupt
 *  the turn instead of sleeping out the delay and retrying. */
async function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  if (!signal) {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; toolName: string; input: Record<string, unknown>; preview: string }
  | { type: "tool_result"; toolName: string; ok: boolean; output: string }
  | { type: "step"; step: number }
  | { type: "todos"; todos: TodoItem[] }
  | { type: "done"; completed: boolean; stopReason: string };

export interface AgentLoopOptions {
  apiKey: string;
  model: string;
  cwd: string;
  mode: AgentMode;
  userPrompt: string;
  /** Prior conversation (user/assistant/tool messages, no system prompt). */
  history?: ChatMessage[];
  maxSteps?: number;
  signal?: AbortSignal;
  /**
   * The model adapter this turn talks through (Fase 5). Injected so
   * the loop depends on the ModelAdapter contract, not on a concrete
   * transport: tests pass a mock adapter, the TUI passes nothing and
   * gets the panel relay adapter. When `callModel` is also given it
   * takes precedence (older test seam, kept for compatibility).
   */
  adapter?: ModelAdapter;
  /** Injectable model call (tests use a mock; default is the
   *  injected adapter via collectChatText — Fase 2/5). */
  callModel?: (messages: ChatMessage[], opts: { onDelta: (t: string) => void; onReasoning?: (t: string) => void; signal?: AbortSignal }) => Promise<string>;
  onEvent?: (e: AgentEvent) => void;
  /** Shared to-do list (also updated live via onTodos). */
  todos?: TodoItem[];
  /** Fase 8: write every processed tool call to the audit log
   *  (audit-log.ts). Default false — the TUI enables it for real
   *  agent turns; tests leave it off so they never write to the
   *  user's real audit log. */
  audit?: boolean;
  /** Override the audit log file (tests use a temp path). */
  auditLogPath?: string;
}

/**
 * One executed tool call, as recorded in the turn's execution
 * ledger (Fase 5). The key (step, index) is unique within a turn:
 * the ledger proves one parsed call = exactly one execution — the
 * loop never re-runs a call on retry, nudge, or guard paths. A
 * legitimate repeat (same tool + same args in a LATER step) is a
 * different key and executes normally; the ledger does not dedupe.
 */
export interface ExecutedToolCall {
  step: number;
  index: number;
  tool: string;
  ok: boolean;
  durationMs: number;
}

export interface AgentLoopResult {
  /** Full history including the system prompt (feed it back next turn). */
  history: ChatMessage[];
  steps: number;
  completed: boolean;
  stopReason: string;
  /** Visible final text (filtered, no tool-call XML). */
  finalText: string;
  /** ask_user paused the turn with these questions. */
  askUserQuestions?: { question: string; options?: string[] }[];
  todos: TodoItem[];
  /** Execution ledger: every tool call this turn actually ran, in
   *  execution order (Fase 5). One entry per call that EXECUTED —
   *  a validation failure (unknown tool, bad schema) never ran, so
   *  it is not listed (Fase 6 precision): if a call were ever
   *  executed twice, this list would show the duplicate key. */
  executedToolCalls: ExecutedToolCall[];
  /** Tool-call channel this turn resolved to (Fase 6): "native"
   *  only when native calling is proven for the model, else
   *  "xml-fallback". Recorded for observability; the XML path
   *  executes regardless until the native phase lands. */
  toolChannel: ToolCallChannel;
  /** Turn usage total (Fase 7): summed across steps from the
   *  adapter's usage chunks. Null when no step reported usage
   *  (e.g. the injected callModel seam, or a provider that sends
   *  no usage). The TUI footer renders this (per-turn surfacing;
   *  per-step breakdown stays a follow-up). */
  usage: ChatUsage | null;
  /** Context stats for this turn (Fase 7). `compacted` is true
   *  when auto-compaction summarized a dropped segment; the
   *  counts are UNIQUE messages/results across the turn (a
   *  message dropped in two steps counts once); estimatedTokens
   *  is the last step's sent-view estimate. */
  context: {
    compacted: boolean;
    droppedMessages: number;
    truncatedToolResults: number;
    estimatedTokens: number;
  };
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxSteps = Math.min(opts.maxSteps ?? MAX_AGENT_STEPS_DEFAULT, MAX_AGENT_STEPS_ABSOLUTE);
  const toolNames = toolNamesForMode(opts.mode);
  const project = buildProjectContext(opts.cwd);
  const systemPrompt = buildAgentSystemPrompt({ mode: opts.mode, cwd: opts.cwd, model: opts.model, project });
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...(opts.history ?? []),
    { role: "user", content: opts.userPrompt },
  ];
  const todos: TodoItem[] = opts.todos ?? [];
  // Fase 8: one redactor per turn, built from the session secrets
  // (the API key + secret-looking env vars). It redacts streamed
  // text, stored history, tool outputs (via the orchestrator and
  // the tool context) and the audit log.
  const redact = createRedactor(collectSessionSecrets(opts.apiKey));
  const toolCtx: ToolContext = {
    cwd: opts.cwd,
    todos,
    invokedByModel: true,
    toolNames,
    redact,
    onTodos: (t) => opts.onEvent?.({ type: "todos", todos: [...t] }),
  };

  // Fase 5 (Universal Runtime): the loop talks to the model ONLY
  // through the injected ModelAdapter (default: the panel relay
  // adapter). It never constructs a transport of its own and never
  // calls streamChat directly — the adapter is the single model
  // boundary, so a future adapter plugs in here without touching
  // the loop. Behavior is identical: the adapter wraps the same
  // transport and returns the same text/reasoning. The XML path
  // below is untouched: tool calls are still parsed from the
  // collected text.
  const adapter = opts.adapter ?? createDefaultAdapter();
  const callModel =
    opts.callModel ??
    (async (msgs: ChatMessage[], cbs: { onDelta: (t: string) => void; onReasoning?: (t: string) => void; signal?: AbortSignal }) => {
      // Fase 7: collect the full CollectedChat, not just the text —
      // usage feeds the turn total (footer), and finishReason /
      // streamComplete feed the incomplete-stream and finish-reason
      // guards in the step loop below.
      const collected = await collectChatText(
        adapter,
        { apiKey: opts.apiKey, model: opts.model, messages: msgs, maxTokens: LOOP_MAX_TOKENS, signal: cbs.signal },
        { onDelta: cbs.onDelta, onReasoning: cbs.onReasoning },
      );
      turnUsage = addUsage(turnUsage, collected.usage);
      lastStreamComplete = collected.streamComplete;
      lastFinishReason = collected.finishReason;
      return collected.text;
    });

  let steps = 0;
  let noProgressSteps = 0;
  /** Consecutive steps that only re-sent the same unchanged to-do list
      (Freebuff todo-loop guard: recovery at 3, stop at 6). */
  let todoLoopStreak = 0;
  /** Consecutive nudges for a promised-but-missing tool call (cap:
      MAX_TOOL_CALL_NUDGES). Reset by any step that emits tool calls. */
  let toolNudgeStreak = 0;
  const failedEdits = new Map<string, number>();
  let finalText = "";
  let askUserQuestions: { question: string; options?: string[] }[] | undefined;
  let stopReason = "";
  let completed = false;
  /** Execution ledger (Fase 5): one entry per tool call actually
   *  run this turn, in execution order. Returned with the result
   *  so callers and tests can prove one parsed call = one
   *  execution. Fase 6 precision: validation failures never ran,
   *  so they are not listed — only calls the handler executed. */
  const executedToolCalls: ExecutedToolCall[] = [];
  /** Turn usage total (Fase 7): summed across steps from the
   *  adapter's usage chunks. Null when no step reported usage. */
  let turnUsage: ChatUsage | null = null;
  /** Last model call's stream state (Fase 7): set by the
   *  callModel wrapper from collectChatText; the defaults mean
   *  "the injected callModel seam, which reports neither". Reset
   *  each step before the call, so a stale value can never leak
   *  from a previous step. */
  let lastStreamComplete = true;
  let lastFinishReason: AdapterFinishReason | null = null;
  /** Auto-compaction ran this turn (at most once per turn). */
  let compactedThisTurn = false;
  /** Unique messages ever dropped from a sent view, and unique
   *  tool results ever truncated in a sent view (Fase 7 stats —
   *  identity sets, so a message dropped in two steps counts
   *  once). */
  const droppedSeen = new Set<ChatMessage>();
  const truncatedSeen = new Set<ChatMessage>();
  /** Last step's sent-view token estimate (Fase 7 stat). */
  let lastEstimatedTokens = 0;
  /** Tool-call channel for this turn (Fase 6, corrected Fase 9):
   *  the channel actually EXECUTED. The loop runs the XML path +
   *  orchestrator only — `channelForModel()` resolves the routing
   *  DECISION from the registry (native when a live probe proved
   *  it), but native is not wired into the loop yet, so reporting
   *  the resolution would claim a channel this turn never used.
   *  Fase 9 caught this: seeding native SUPPORTED for any model
   *  would have flipped the recorded channel to "native" while
   *  execution stayed XML. A later phase that wires native tools
   *  into the loop must set this from the resolution instead. */
  const toolChannel: ToolCallChannel = "xml-fallback";
  /** Consecutive protocol-violation steps (Fase 6): two in a row
   *  stop the turn with an explicit message; any step where a call
   *  actually executes resets it. */
  const protocol = createProtocolTracker();
  /**
   * Build the turn result (Fase 7): every exit site goes through
   * here so `usage` and `context` are never forgotten on an early
   * return (failed edit, ask_user, todo-loop, protocol stop).
   */
  const buildResult = (over: {
    completed: boolean;
    stopReason: string;
    finalText?: string;
    askUserQuestions?: { question: string; options?: string[] }[];
  }): AgentLoopResult => ({
    history: messages,
    steps,
    completed: over.completed,
    stopReason: over.stopReason,
    finalText: over.finalText ?? finalText,
    askUserQuestions: over.askUserQuestions ?? askUserQuestions,
    todos,
    executedToolCalls,
    toolChannel,
    usage: turnUsage,
    context: {
      compacted: compactedThisTurn,
      droppedMessages: droppedSeen.size,
      truncatedToolResults: truncatedSeen.size,
      estimatedTokens: lastEstimatedTokens,
    },
  });
  /**
   * Stop the turn for protocol violations (Fase 6): the model
   * failed twice in a row to follow the tool-call format. The
   * explicit message reaches the user as the assistant's final
   * text (text event + finalText) and as the stopReason (the TUI
   * shows "Agen berhenti: ..."). completed is false — this is a
   * failure to follow the protocol, not a finished turn.
   */
  const protocolStop = (detail: string): AgentLoopResult => {
    const message = protocolFailureMessage(opts.model, detail);
    finalText = message;
    stopReason = protocolFailureStopReason(detail);
    opts.onEvent?.({ type: "text", text: message });
    opts.onEvent?.({ type: "done", completed: false, stopReason });
    return buildResult({ completed: false, stopReason });
  };
  /**
   * Call the model with the Fase 7 retry policy (Freebuff
   * codebuff-web-api.ts: 3 attempts for 408/429/500/502/503/504).
   * Only errors the adapter marks retryable are retried, and only
   * when the failed attempt delivered NO deltas yet — a retry
   * after partial streaming would duplicate the displayed text /
   * reasoning. Aborts never retry. Each attempt gets fresh parser
   * state, so a retried attempt re-parses from scratch.
   * `streamedAny` (outer, reset per step) is set when any attempt
   * streams, so the caller still emits the filtered text once for
   * non-streaming calls.
   */
  let streamedAny = false;
  const callModelWithRetry = async (msgs: ChatMessage[]): Promise<string> => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_MODEL_CALL_ATTEMPTS; attempt++) {
      if (opts.signal?.aborted) throw abortError();
      if (attempt > 0) {
        await sleepAbortable(MODEL_CALL_RETRY_DELAYS_MS[attempt - 1] ?? 1000, opts.signal);
      }
      const parserState = createStreamParserState();
      let attemptStreamed = false;
      try {
        const text = await callModel(msgs, {
          onDelta: (d) => {
            attemptStreamed = true;
            streamedAny = true;
            const r = parseStreamChunk(d, parserState);
            // Fase 8: redact per delta (best effort — a secret split
            // across two deltas is caught by the whole-message
            // redaction when the assistant message is stored).
            if (r.filteredText.length > 0) opts.onEvent?.({ type: "text", text: redact(r.filteredText) });
          },
          onReasoning: (r) => {
            attemptStreamed = true;
            streamedAny = true;
            opts.onEvent?.({ type: "reasoning", text: redact(r) });
          },
          signal: opts.signal,
        });
        return text;
      } catch (e) {
        const err = normalizeProviderError(e);
        if (err.kind === "aborted" || !err.retryable || attemptStreamed) throw e;
        lastError = e;
      }
    }
    throw lastError;
  };

  while (steps < maxSteps) {
    if (opts.signal?.aborted) {
      stopReason = "interrupted by user";
      break;
    }
    steps += 1;
    opts.onEvent?.({ type: "step", step: steps });
    if (steps > 1) {
      messages.push({ role: "system", content: stepPrompt(steps) });
    }

    // Fase 7 (Context & Streaming): prepare the sendable view for
    // this step — the stored history is never mutated by
    // truncation; only the view sent to the model is reduced.
    // Auto-compaction (at most once per turn) summarizes the
    // dropped segment instead of losing it, then re-prepares.
    const windowTokens = resolveContextWindow(opts.model);
    const reserveTokens = LOOP_MAX_TOKENS + RESPONSE_RESERVE_MARGIN_TOKENS;
    const toolDefinitionText = toolDescriptionsFor(toolNames, opts.cwd);
    let prepared: PreparedContext = prepareContext(messages, {
      windowTokens,
      reserveTokens,
      toolDefinitionText,
    });
    for (const m of prepared.droppedMessages) droppedSeen.add(m);
    for (const m of prepared.truncatedMessages) truncatedSeen.add(m);
    lastEstimatedTokens = prepared.estimatedTokens;
    if (prepared.droppedMessages.length > 0 && !compactedThisTurn && !opts.signal?.aborted) {
      const summary = await summarizeSegment(prepared.droppedMessages, adapter, {
        apiKey: opts.apiKey,
        model: opts.model,
        signal: opts.signal,
      });
      if (summary !== null) {
        compactedThisTurn = true;
        // Replace the dropped segment in STORED history with the
        // summary (the summary goes right after the pinned prefix,
        // the dropped messages leave history) and re-prepare.
        const stored = [
          ...prepared.messages.slice(0, prepared.summaryInsertAt),
          buildSummaryMessage(summary),
          ...prepared.messages.slice(prepared.summaryInsertAt),
        ];
        messages.splice(0, messages.length, ...stored);
        prepared = prepareContext(messages, {
          windowTokens,
          reserveTokens,
          toolDefinitionText,
        });
        for (const m of prepared.truncatedMessages) truncatedSeen.add(m);
        lastEstimatedTokens = prepared.estimatedTokens;
      }
    }

    let rawText: string;
    // Stream deltas through the XML parser as they arrive, so tool-call
    // tags never leak into the visible text. Mock model calls (tests)
    // return the whole response without deltas — then the filtered text
    // is emitted once below instead. The retry wrapper (Fase 7) owns
    // the parser state per attempt.
    streamedAny = false;
    lastStreamComplete = true;
    lastFinishReason = null;
    try {
      rawText = await callModelWithRetry(prepared.messages);
    } catch (e) {
      // An abort mid-call is the user interrupting, not a model
      // failure — the old plain-chat path reported "Request dibatalkan."
      // and the agent loop used to swallow it as "model call failed".
      stopReason = opts.signal?.aborted
        ? "interrupted by user"
        : redact(`model call failed: ${e instanceof Error ? e.message : String(e)}`);
      break;
    }
    // Fase 7: the stream must have finished cleanly. A stream that
    // ends without a usage or finish chunk closed mid-response —
    // the collected text is partial and must not become the final
    // answer or enter history. History stays intact (the assistant
    // message is NOT pushed below); the user can re-send. Partial
    // text already streamed to the display is live display, not a
    // committed final response.
    if (!lastStreamComplete) {
      stopReason = "model call failed: stream ended before the server finished the response (no finish reason or usage received)";
      break;
    }

    const parsed = parseFullText(rawText);
    // The assistant message kept in history is the raw text (so the
    // model sees its own tool calls on the next step); the TUI shows
    // only the filtered text. Fase 8: redacted as a whole before it
    // is stored — a secret split across stream deltas cannot survive
    // in history, and the tool-call JSON was already parsed above.
    messages.push({ role: "assistant", content: redact(rawText) });
    finalText = redact(parsed.filteredText);
    if (!streamedAny && parsed.filteredText.trim().length > 0) {
      opts.onEvent?.({ type: "text", text: redact(parsed.filteredText) });
    }

    // Malformed tool JSON forces a retry step (Freebuff TOOL_CALL_ERROR).
    // Fase 6: a malformed step is a protocol violation — two in a row
    // stop the turn with an explicit message instead of burning steps
    // to the no-progress guard.
    if (parsed.parseErrors.length > 0) {
      protocol.recordViolation();
      if (protocol.shouldStop()) {
        const unclosed = parsed.parseErrors.some((e) => e.startsWith("unclosed"));
        return protocolStop(unclosed ? "unclosed tool-call tag" : "malformed tool-call JSON");
      }
      messages.push({
        role: "user",
        content: `[TOOL_CALL_ERROR] Your tool call JSON did not parse: ${parsed.parseErrors.join(" | ")}. Fix the JSON and emit the call again inside <codebuff_tool_call> tags.`,
      });
      noProgressSteps += 1;
      if (noProgressSteps >= NO_PROGRESS_STOP_THRESHOLD) {
        stopReason = `stopped: no progress for ${NO_PROGRESS_STOP_THRESHOLD} steps`;
        break;
      }
      continue;
    }

    if (parsed.toolCalls.length === 0) {
      // Fase 7: finish reasons the loop must not silently accept
      // as a normal final answer. A content-filter stop means the
      // provider refused the reply; a length stop means the reply
      // was cut at max_tokens and is incomplete. Both end the turn
      // explicitly (completed=false) instead of presenting a
      // partial answer as finished. When tool calls were emitted
      // alongside a length stop, the step below still runs them —
      // the work continues on the next step.
      if (lastFinishReason === "content_filter") {
        completed = false;
        stopReason = "stopped: response blocked by content filter";
        break;
      }
      if (lastFinishReason === "length") {
        completed = false;
        stopReason = "stopped: response cut off at max_tokens (length) — the answer is incomplete";
        break;
      }
      // The model promised tool work but emitted no call (live bug
      // 2026-11-09: "saya cek proyeknya sekarang" then silence). Nudge
      // it once per streak (max MAX_TOOL_CALL_NUDGES) instead of ending
      // the turn with nothing done. A plain answer with no promise
      // still ends the turn below, unchanged.
      if (
        parsed.parseErrors.length === 0 &&
        toolNudgeStreak < MAX_TOOL_CALL_NUDGES &&
        looksLikeToolPromise(parsed.filteredText)
      ) {
        toolNudgeStreak += 1;
        messages.push({ role: "user", content: TOOL_CALL_MISSING_MESSAGE });
        noProgressSteps += 1;
        if (noProgressSteps >= NO_PROGRESS_STOP_THRESHOLD) {
          stopReason = `stopped: no progress for ${NO_PROGRESS_STOP_THRESHOLD} steps`;
          break;
        }
        continue;
      }
      // No tool calls: a plain answer ends the turn (relaxed vs
      // Freebuff §1.1 — see header). But if the model PROMISED tool
      // work and still emitted nothing after both nudges, that is a
      // protocol failure (Fase 6): stop explicitly instead of
      // completing silently as "no more tool calls".
      if (looksLikeToolPromise(parsed.filteredText)) {
        return protocolStop(`promised tool work but emitted no tool call after ${MAX_TOOL_CALL_NUDGES} reminders`);
      }
      completed = true;
      stopReason = "no more tool calls";
      break;
    }

    // A step that emitted tool calls breaks the missing-call streak.
    toolNudgeStreak = 0;

    let hadToolError = false;
    let stepSucceeded = false;
    let taskDone = false;
    /** True when this step's only tool call re-sent the unchanged list. */
    let writeTodosUnchanged = false;

    // Fase 4 (Universal Runtime): tool execution lives in the
    // orchestrator (tool-orchestrator.ts) — the loop hands over the
    // step's parsed calls as one batch and processes the ordered
    // results below. The orchestrator owns mode membership, schema
    // validation, timeout, parallel waves (read-only only), and
    // batch stops (ask_user / endsAgentStep). The loop keeps owning
    // the turn guards (failed-edit, todo-loop, no-progress) and the
    // history messages — the tool message shape is byte-identical
    // to the old inline path (resultToToolMessage). The XML path
    // above is untouched.
    const batch = await executeToolCalls(
      parsed.toolCalls.map((c) => ({ name: c.toolName, input: c.input })),
      {
        ctx: toolCtx,
        toolNames,
        signal: opts.signal,
        // Fase 8: the orchestrator redacts every tool output and
        // writes the audit log for real agent turns.
        redact,
        audit: opts.audit ?? false,
        auditLogPath: opts.auditLogPath,
        onCallStart: (call) =>
          opts.onEvent?.({ type: "tool_call", toolName: call.name, input: call.input, preview: toolPreview(call.name, call.input) }),
        onCallResult: (r) => opts.onEvent?.({ type: "tool_result", toolName: r.tool, ok: r.ok, output: r.output }),
      },
    );
    // Fase 6: track whether this step executed anything and whether
    // it violated the protocol. The ledger records ONLY calls that
    // actually ran — a validation failure (unknown tool, bad schema)
    // never executed, so it must not appear as an execution.
    let stepExecuted = false;
    let stepViolated = false;
    for (const result of batch.results) {
      messages.push(resultToToolMessage(result, `call-${steps}-${result.index}`));
      if (isProtocolViolationResult(result)) {
        stepViolated = true;
      } else {
        stepExecuted = true;
        executedToolCalls.push({
          step: steps,
          index: result.index,
          tool: result.tool,
          ok: result.ok,
          durationMs: result.durationMs,
        });
      }
      if (!result.ok) {
        hadToolError = true;
        if (isFileEditTool(result.tool)) {
          const key = `${result.tool}:${String(result.input.path ?? "")}`;
          const n = (failedEdits.get(key) ?? 0) + 1;
          failedEdits.set(key, n);
          if (n >= FILE_EDIT_LOOP_STOP_THRESHOLD) {
            stopReason = `stopped: ${n} failed edits to ${String(result.input.path ?? "the same file")} — try a different approach`;
            opts.onEvent?.({ type: "done", completed: false, stopReason });
            return buildResult({ completed: false, stopReason });
          }
        }
      } else {
        // An unchanged write_todos is a no-op, not progress (Freebuff:
        // write_todos is excluded from turn-progress fingerprints).
        const isUnchangedTodos =
          result.tool === "write_todos" && result.output.startsWith("To-do list unchanged");
        if (isUnchangedTodos) writeTodosUnchanged = true;
        else stepSucceeded = true;
        if (result.tool === "task_completed") taskDone = true;
      }
      if (result.askUserQuestions) {
        askUserQuestions = result.askUserQuestions;
        stopReason = "waiting for user answers (ask_user)";
        opts.onEvent?.({ type: "done", completed: false, stopReason });
        return buildResult({ completed: false, stopReason });
      }
      // Freebuff endsAgentStep (skill): the orchestrator already
      // stopped the batch after this result, so there are no further
      // results to skip here.
    }

    // Fase 6: update the protocol-violation streak. A step that
    // executed at least one call resets it; a step with violations
    // and no execution increments it; two in a row stop the turn
    // with an explicit message. A handler error is NOT a violation
    // — the call ran, the tool failed, and the ordinary retry
    // below handles it.
    if (stepExecuted) protocol.recordExecution();
    else if (stepViolated) {
      protocol.recordViolation();
      if (protocol.shouldStop()) {
        const allUnknown = batch.results
          .filter((r) => isProtocolViolationResult(r))
          .every((r) => r.output.startsWith("unknown"));
        return protocolStop(allUnknown ? "unknown tool" : "invalid tool-call parameters");
      }
    }

    // Freebuff todo-loop guard (util/todo-loop.ts): a step whose only
    // tool call re-sends the same unchanged to-do list is not progress.
    // A different list, another tool, or a user message breaks the
    // streak (here: any step that is not exactly one unchanged
    // write_todos resets it).
    if (parsed.toolCalls.length === 1 && parsed.toolCalls[0]?.toolName === "write_todos" && writeTodosUnchanged) {
      todoLoopStreak += 1;
    } else {
      todoLoopStreak = 0;
    }
    if (todoLoopStreak === TODO_LOOP_RECOVERY_THRESHOLD) {
      // Freebuff todoLoopRecoveryMessage(toolNames): append the
      // no-file-edit-tools note when the mode lacks them (Plan).
      // File-edit membership is read from the registry, not hardcoded.
      const hasFileEditTool = toolNames.some((n) => isFileEditTool(n));
      messages.push({
        role: "user",
        content: hasFileEditTool ? TODO_LOOP_RECOVERY_MESSAGE : TODO_LOOP_RECOVERY_MESSAGE + FILE_EDIT_TOOLS_UNAVAILABLE_NOTE,
      });
    }
    if (todoLoopStreak >= TODO_LOOP_STOP_THRESHOLD) {
      stopReason = TODO_LOOP_STOP_MESSAGE;
      opts.onEvent?.({ type: "done", completed: false, stopReason });
      return buildResult({ completed: false, stopReason });
    }

    if (taskDone) {
      completed = true;
      stopReason = "task_completed";
      break;
    }
    if (stepSucceeded) noProgressSteps = 0;
    else noProgressSteps += 1;
    if (hadToolError) {
      // Error forces one more step so the model can retry (Freebuff).
      messages.push({
        role: "user",
        content: "[TOOL_CALL_ERROR] One or more tool calls above failed. Read the error, fix the call, and retry. Do not repeat the exact failing call.",
      });
    }
    if (noProgressSteps >= NO_PROGRESS_STOP_THRESHOLD) {
      stopReason = `stopped: no progress for ${NO_PROGRESS_STOP_THRESHOLD} steps`;
      break;
    }
  }

  if (!stopReason) {
    stopReason = steps >= maxSteps ? `stopped: max steps reached (${maxSteps})` : "turn ended";
  }
  opts.onEvent?.({ type: "done", completed, stopReason });
  return buildResult({ completed, stopReason });
}
