// Context Manager — Universal Agent Runtime, Fase 7 (Context &
// Streaming Integration).
//
// This module standardizes how the agent loop manages conversation
// context across providers. It owns three things, all pure and
// unit-testable except the summarizer (which calls the model through
// the injected adapter):
//
//   1. Token estimation + budgeting. There is no tokenizer in the
//      CLI (no tiktoken dependency), so `estimateTokens` is a
//      HEURISTIC — documented as such, never presented as an exact
//      count. Budgets are computed against the model's context
//      window: the capability record's `contextWindow` when a probe
//      or provider config set it, otherwise
//      FALLBACK_CONTEXT_WINDOW_TOKENS — a conservative planning
//      default, NOT a measured fact about any model (the audit
//      found no model with a proven window yet).
//   2. `prepareContext`: a per-call TRUNCATION VIEW. The loop keeps
//      the full stored history (format unchanged, Fase 5 contract)
//      and sends only the view that fits the budget. Truncation
//      drops whole exchanges from the front and never splits an
//      assistant tool-call message from its tool results; the most
//      recent exchange (which holds the current user prompt) is
//      never dropped. Tool-result contents are truncated only as a
//      last resort, in the VIEW only — stored history keeps the full
//      output. Summarization is the separate path below.
//   3. `summarizeSegment`: model-based SUMMARIZATION of a dropped
//      segment, reusing the existing /compact prompt
//      (`compactPrompt` from slash.ts — the same contract manual
//      /compact uses). The loop calls it at most once per turn,
//      only when truncation would drop messages; a failure returns
//      null and the loop proceeds with the truncated view.
//
// What this module does NOT do (explicit non-goals):
// - No auto-compaction loop, no periodic summarization: one
//   bounded summarization per turn, only when needed.
// - No change to the stored-history format: a summary replaces
//   the dropped segment as a system message — the same role the
//   loop already uses for step reminders, and the same shape
//   manual /compact produces.
// - No capability inference: an unknown window falls back to the
//   planning default; UNKNOWN is never treated as a known window.
//
// Reference patterns (read from source, not assumed):
// - Freebuff `packages/agent-runtime/src/compact-history.ts`:
//   MECHANICAL_HISTORY_TOKENS = 12_000 budget for the mechanical
//   pass, `compactMessages()` summary algorithm, automatic
//   compaction ceilings (`automaticCompactionPostCeiling`). MethaTech
//   adopts the budget + compact-when-over pattern, not the exact
//   numbers: our windows are unknown, so the budget is derived
//   from the resolved window instead of a fixed constant.

import type { ChatMessage, ChatUsage } from "../api.js";
import { capabilitiesFor } from "./model-capabilities.js";
import { collectChatText, type ModelAdapter } from "./model-adapter.js";
import { compactPrompt } from "./slash.js";

/**
 * Conservative planning default for the context window, in tokens.
 * Used ONLY when the capability record has no known window (null =
 * unknown). This is NOT a measured fact about any model — the
 * audit found no model with a proven window — and it is overridden
 * the moment a probe or provider config sets `contextWindow`.
 * 128k is conservative for the free catalog (GLM/DeepSeek/Qwen
 * class windows are 128k and up); a smaller real window would
 * surface as a provider error, not as silent truncation.
 */
export const FALLBACK_CONTEXT_WINDOW_TOKENS = 128_000;

/** Tokens reserved for the model's reply on top of maxTokens. */
export const RESPONSE_RESERVE_MARGIN_TOKENS = 256;

/**
 * Marker prefix for auto-compaction summary messages. A summary
 * starts with this so `prepareContext` can recognize and PIN it
 * (never drop the only record of the summarized past), the same
 * way the loop pins the system prompt.
 */
export const COMPACT_SUMMARY_MARKER = "[Ringkasan percakapan]";

/** Chars kept from the head of an over-long tool result in the view. */
export const TOOL_RESULT_TRUNCATE_HEAD_CHARS = 1500;
/** Chars kept from the tail of an over-long tool result in the view. */
export const TOOL_RESULT_TRUNCATE_TAIL_CHARS = 500;

/** Max input chars for one summarization call (segment text after
 *  compactPrompt's own 4000-char-per-message slicing). Bounds the
 *  summary request so it cannot itself blow the window. */
export const SUMMARIZE_MAX_INPUT_CHARS = 100_000;

// ---------------------------------------------------------------------------
// Token estimation (heuristic — never exact)
// ---------------------------------------------------------------------------

/** CJK ranges: roughly one token per character, unlike Latin text. */
const CJK_RE = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;

/**
 * Estimate the token count of a text. HEURISTIC: ~4 Latin chars per
 * token, ~1 token per CJK character, plus a small constant for
 * structure. Typical error is ±20% on code/prose; it is a planning
 * number for budgeting, never a billing or exact-window claim.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const cjk = text.match(CJK_RE)?.length ?? 0;
  const latin = text.length - cjk;
  return Math.ceil(latin / 4 + cjk);
}

/**
 * Estimate one message: content tokens + a small per-message
 * overhead for role/structure (8), plus name + tool_call_id for
 * tool messages (12 more). Same order of magnitude as the
 * per-message overhead OpenAI documents (~3-4 tokens/message plus
 * role), rounded up conservatively.
 */
export function estimateMessageTokens(msg: ChatMessage): number {
  let tokens = estimateTokens(msg.content) + 8;
  if (msg.role === "tool") tokens += 12;
  return tokens;
}

/** Estimate the whole context (all messages). */
export function countContextTokens(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + estimateMessageTokens(m), 0);
}

// ---------------------------------------------------------------------------
// Context window + budget
// ---------------------------------------------------------------------------

/**
 * Resolve the context window for a model: the capability record's
 * `contextWindow` when known, otherwise the planning fallback.
 * A null window means "unknown", never "unlimited".
 */
export function resolveContextWindow(modelId: string): number {
  const record = capabilitiesFor(modelId);
  const known = record.capabilities.contextWindow;
  if (typeof known === "number" && known > 0) return known;
  return FALLBACK_CONTEXT_WINDOW_TOKENS;
}

export interface ContextBudget {
  /** Window the budget is computed against. */
  windowTokens: number;
  /** Tokens reserved for the reply (maxTokens + margin). */
  reserveTokens: number;
  /** System prompt tokens (includes the tool definitions). */
  systemTokens: number;
  /** Tool-definition tokens (sub-line of systemTokens). */
  toolDefinitionTokens: number;
  /** Conversation-history tokens (all non-system messages). */
  historyTokens: number;
  /** Tool-result tokens (sub-line of historyTokens). */
  toolResultTokens: number;
  /** Tokens left for history after system + reserve. */
  historyBudgetTokens: number;
  /** Total estimated tokens of the full request. */
  totalEstimatedTokens: number;
  /** True when the full request exceeds the window. */
  overBudget: boolean;
}

/**
 * Compute the token budget breakdown for one request. `messages`
 * is the full request (system prompt first, then history).
 * `toolDefinitionText` is the tool section of the system prompt
 * (from the Fase 3 registry via toolDescriptionsFor) — reported
 * as a sub-line of systemTokens, not double-counted.
 */
export function budgetContext(
  messages: ChatMessage[],
  opts: { windowTokens: number; reserveTokens: number; toolDefinitionText?: string },
): ContextBudget {
  const systemMessages = messages.filter((m) => m.role === "system");
  const historyMessages = messages.filter((m) => m.role !== "system");
  const systemTokens = systemMessages.reduce((n, m) => n + estimateMessageTokens(m), 0);
  const historyTokens = historyMessages.reduce((n, m) => n + estimateMessageTokens(m), 0);
  const toolResultTokens = historyMessages
    .filter((m) => m.role === "tool")
    .reduce((n, m) => n + estimateMessageTokens(m), 0);
  const toolDefinitionTokens = opts.toolDefinitionText ? estimateTokens(opts.toolDefinitionText) : 0;
  const totalEstimatedTokens = systemTokens + historyTokens;
  const historyBudgetTokens = Math.max(0, opts.windowTokens - opts.reserveTokens - systemTokens);
  return {
    windowTokens: opts.windowTokens,
    reserveTokens: opts.reserveTokens,
    systemTokens,
    toolDefinitionTokens,
    historyTokens,
    toolResultTokens,
    historyBudgetTokens,
    totalEstimatedTokens,
    overBudget: totalEstimatedTokens + opts.reserveTokens > opts.windowTokens,
  };
}

// ---------------------------------------------------------------------------
// prepareContext: pair-preserving truncation view
// ---------------------------------------------------------------------------

export interface PreparedContext {
  /** The view to send: pinned messages + kept exchanges, in order. */
  messages: ChatMessage[];
  /** Messages dropped from the view (oldest first) — the segment a
   *  summarization may replace. Empty when nothing was dropped. */
  droppedMessages: ChatMessage[];
  /** Tokens the dropped messages carried (estimate). */
  droppedTokens: number;
  /** How many tool results were truncated in the view. */
  truncatedToolResults: number;
  /** The ORIGINAL tool messages truncated in the view (before
   *  copying) — so callers can dedupe truncation stats by message
   *  identity across steps. */
  truncatedMessages: ChatMessage[];
  /** Estimated tokens of the returned view. */
  estimatedTokens: number;
  /** True when even the minimal view exceeds the window. */
  overBudget: boolean;
  /** Index in `messages` where a summary of the dropped segment
   *  belongs: right after the pinned prefix (system prompt +
   *  earlier summaries). */
  summaryInsertAt: number;
  /** The budget breakdown for the ORIGINAL request. */
  breakdown: ContextBudget;
}

function isPinnedSummary(msg: ChatMessage): boolean {
  return msg.role === "system" && msg.content.startsWith(COMPACT_SUMMARY_MARKER);
}

/**
 * Group non-pinned messages into exchanges. An exchange starts at
 * a "user" message and holds the following assistant / tool /
 * system messages until the next "user" message. Messages before
 * the first user message form a leading exchange. Exchanges are
 * the drop unit: dropping never splits an assistant tool-call
 * message from its tool results.
 */
function groupExchanges(messages: ChatMessage[]): ChatMessage[][] {
  const exchanges: ChatMessage[][] = [];
  let current: ChatMessage[] | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      if (current) exchanges.push(current);
      current = [m];
    } else {
      if (!current) current = [];
      current.push(m);
    }
  }
  if (current && current.length > 0) exchanges.push(current);
  return exchanges;
}

function truncateToolResult(msg: ChatMessage): ChatMessage {
  const head = msg.content.slice(0, TOOL_RESULT_TRUNCATE_HEAD_CHARS);
  const tail = msg.content.slice(-TOOL_RESULT_TRUNCATE_TAIL_CHARS);
  const hidden = msg.content.length - TOOL_RESULT_TRUNCATE_HEAD_CHARS - TOOL_RESULT_TRUNCATE_TAIL_CHARS;
  return {
    ...msg,
    content:
      `${head}\n… [output dipotong: ${hidden} karakter disembunyikan] …\n${tail}`,
  };
}

/**
 * Build the sendable view of `messages` for one model call.
 *
 * Rules, in order:
 * 1. The first message (system prompt) and any pinned summary
 *    messages are never dropped.
 * 2. Whole exchanges are dropped from the front until the view
 *    fits — except the LAST exchange, which holds the current
 *    user prompt (or the latest step) and is never dropped.
 * 3. If the last exchange alone still exceeds the budget, tool
 *    results inside it are truncated (head + tail + marker) in
 *    the VIEW only; stored history keeps the full output.
 * 4. If even that does not fit, `overBudget` is true and the
 *    minimal view is returned anyway — the provider will error
 *    honestly rather than the loop silently deleting the user's
 *    request.
 *
 * The stored history is NEVER mutated here: this returns a view.
 */
export function prepareContext(
  messages: ChatMessage[],
  opts: { windowTokens: number; reserveTokens: number; toolDefinitionText?: string },
): PreparedContext {
  const breakdown = budgetContext(messages, opts);
  const pinned: ChatMessage[] = [];
  const rest: ChatMessage[] = [];
  messages.forEach((m, i) => {
    if (i === 0 || isPinnedSummary(m)) pinned.push(m);
    else rest.push(m);
  });
  const pinnedTokens = pinned.reduce((n, m) => n + estimateMessageTokens(m), 0);
  const historyBudget = Math.max(0, opts.windowTokens - opts.reserveTokens - pinnedTokens);

  const exchanges = groupExchanges(rest);
  const droppedMessages: ChatMessage[] = [];
  let keptExchanges = exchanges;
  // Drop whole exchanges from the front while over budget, keeping
  // at least the last exchange.
  while (keptExchanges.length > 1) {
    const kept = keptExchanges.flat();
    const keptTokens = kept.reduce((n, m) => n + estimateMessageTokens(m), 0);
    if (keptTokens <= historyBudget) break;
    const dropped = keptExchanges[0] as ChatMessage[];
    droppedMessages.push(...dropped);
    keptExchanges = keptExchanges.slice(1);
  }

  let keptMessages = keptExchanges.flat();
  let truncatedToolResults = 0;
  const truncatedMessages: ChatMessage[] = [];
  let keptTokens = keptMessages.reduce((n, m) => n + estimateMessageTokens(m), 0);
  // Last resort: truncate tool-result contents inside the kept view.
  if (keptTokens > historyBudget) {
    keptMessages = keptMessages.map((m) => {
      if (m.role !== "tool") return m;
      if (estimateMessageTokens(m) <= TOOL_RESULT_TRUNCATE_HEAD_CHARS + TOOL_RESULT_TRUNCATE_TAIL_CHARS + 100) return m;
      truncatedToolResults += 1;
      truncatedMessages.push(m);
      return truncateToolResult(m);
    });
    keptTokens = keptMessages.reduce((n, m) => n + estimateMessageTokens(m), 0);
  }

  const view = [...pinned, ...keptMessages];
  const estimatedTokens = pinnedTokens + keptTokens;
  // The summary of the dropped segment belongs right after the
  // pinned prefix (system prompt + earlier summaries).
  const summaryInsertAt = pinned.length;
  return {
    messages: view,
    droppedMessages,
    droppedTokens: droppedMessages.reduce((n, m) => n + estimateMessageTokens(m), 0),
    truncatedToolResults,
    truncatedMessages,
    estimatedTokens,
    overBudget: estimatedTokens + opts.reserveTokens > opts.windowTokens,
    summaryInsertAt,
    breakdown,
  };
}

// ---------------------------------------------------------------------------
// Summarization (model-based, bounded, failure-safe)
// ---------------------------------------------------------------------------

/**
 * Summarize a dropped segment through the model, reusing the
 * existing /compact prompt (`compactPrompt` — the same contract
 * manual /compact uses, each message sliced to 4000 chars).
 * The input is additionally capped at SUMMARIZE_MAX_INPUT_CHARS
 * by dropping the segment's oldest messages first, so the summary
 * request itself cannot blow the window. Returns null on ANY
 * failure (provider error, abort, empty summary) — the caller
 * proceeds with the truncated view instead of crashing the turn.
 */
export async function summarizeSegment(
  segment: ChatMessage[],
  adapter: ModelAdapter,
  opts: { apiKey: string; model: string; signal?: AbortSignal },
): Promise<string | null> {
  if (segment.length === 0) return null;
  if (opts.signal?.aborted) return null;
  // Cap the input: keep the most recent messages of the segment.
  let input = segment;
  let inputText = compactPrompt(input);
  while (input.length > 1 && inputText.length > SUMMARIZE_MAX_INPUT_CHARS) {
    input = input.slice(1);
    inputText = compactPrompt(input);
  }
  try {
    const { text } = await collectChatText(
      adapter,
      { apiKey: opts.apiKey, model: opts.model, messages: [{ role: "user", content: inputText }], maxTokens: 1024, signal: opts.signal },
    );
    const summary = text.trim();
    return summary.length > 0 ? summary : null;
  } catch {
    return null;
  }
}

/** Build the stored-history summary message for a segment summary. */
export function buildSummaryMessage(summary: string): ChatMessage {
  return {
    role: "system",
    content: `${COMPACT_SUMMARY_MARKER} Bagian awal percakapan diringkas otomatis agar tetap muat di context window. Isi ringkasan:\n${summary}`,
  };
}

/** Add one step's usage into a turn total (null-safe). */
export function addUsage(total: ChatUsage | null, step: ChatUsage | null): ChatUsage | null {
  if (!step) return total;
  if (!total) return { ...step };
  return {
    promptTokens: total.promptTokens + step.promptTokens,
    completionTokens: total.completionTokens + step.completionTokens,
    totalTokens: total.totalTokens + step.totalTokens,
  };
}
