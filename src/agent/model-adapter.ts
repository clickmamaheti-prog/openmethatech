// Universal Model Adapter — Universal Agent Runtime, Fase 2.
//
// This module is the SINGLE CONTRACT between the agent loop (and any
// other model caller) and the model transport. It standardizes, per
// provider, what used to be a bare `streamChat` call in src/api.ts:
//
//   - one request shape (AdapterChatRequest) for every provider
//   - one normalized chunk stream (ChatChunk) for every response:
//     text / reasoning / usage / finish / tool_call
//   - one normalized error type (AdapterError) for every failure,
//     keyed off the HTTP status the panel already normalizes
//     upstream errors into (the panel relay converts each provider's
//     native error into an OpenAI-compatible error body, so the CLI
//     cannot — and must not — map errors per provider name)
//
// What this phase does NOT do (by order):
// - It does NOT send native `tools` (a later phase — NOT Fase 5,
//   per the binding roadmap correction 2026-11-10: Fase 5 is the
//   Universal Agent Loop; native tool calling is deferred to a
//   later phase, placement decided by Reza). The request contract
//   carries an optional `tools` field so that later phase only
//   fills the sender, not the shape — but the Fase 2 adapter
//   REJECTS any call that provides tools, fail-loud, so nothing
//   silently pretends native calling works.
// - It does NOT parse `delta.tool_calls` from SSE (same later
//   phase). The `tool_call` chunk type exists in the contract so
//   that phase has a place to emit it; no such chunk is produced
//   in this phase.
// - It does NOT retry (Fase 7), does NOT change the transport
//   (still POST {apiBase}/v1/chat/completions, SSE), does NOT touch
//   the panel, and does NOT change the XML tool-call path — the loop
//   still collects plain text and parses <codebuff_tool_call> from
//   it exactly as before.
//
// Reference patterns (read from source, not assumed):
// - Freebuff `packages/llm-providers/src/openai-compatible/chat/`:
//   one generic OpenAI-compatible adapter for ALL providers
//   (`openai-compatible-chat-language-model.ts`), tool conversion in
//   `openai-compatible-prepare-tools.ts`, finish-reason mapping in
//   `map-openai-compatible-finish-reason.ts` (stop/length/
//   content-filter/tool-calls/unknown — adopted below without the
//   Vercel AI SDK dependency).
// - Freebuff AGENTS.md convention: prefer dependency injection over
//   module mocking — the adapter takes its transport as a
//   constructor argument, so tests inject a fake without mocking
//   the network module.
//
// Keputusan Reza 2026-11-10 (mengikat, lihat
// docs/UNIVERSAL-RUNTIME-AUDIT.md §11):
// - Runtime stays local in the CLI; the panel stays a relay.
// - Capability metadata lives in the CLI first
//   (src/agent/model-capabilities.ts, this phase's companion).
// - No capability is inferred from a model name — the adapter
//   reports what the transport returned, nothing more.

import { ApiError, streamChat, type ChatMessage, type ChatUsage, type ToolCallDelta } from "../api.js";
import type { OpenAiFunctionTool } from "./tool-registry.js";

// ---------------------------------------------------------------------------
// Normalized chunks (the internal response format)
// ---------------------------------------------------------------------------

/** Normalized finish reason. Mapped from the OpenAI `finish_reason`
 *  string the panel forwards (Freebuff
 *  map-openai-compatible-finish-reason.ts pattern: `function_call`
 *  and `tool_calls` both mean tool-calls; anything else unknown). */
export type AdapterFinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "unknown";

export function mapFinishReason(raw: string | null | undefined): AdapterFinishReason {
  switch (raw) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return "unknown";
  }
}

export type ChatChunk =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "usage"; usage: ChatUsage }
  | { type: "finish"; reason: AdapterFinishReason }
  /**
   * Native tool-call delta (a later phase, NOT Fase 5). NOT produced
   * yet: the transport never sends `tools`, so the server never
   * returns `delta.tool_calls`. The shape is fixed now so that phase
   * only adds the parser: `index` groups deltas of one call,
   * `arguments` accumulates the JSON string, `complete` marks the
   * last delta.
   */
  | { type: "tool_call"; id: string; index: number; name: string; arguments: string; complete: boolean };

// ---------------------------------------------------------------------------
// Normalized errors
// ---------------------------------------------------------------------------

export type AdapterErrorKind =
  | "auth" // 401 — key invalid, login again (not retryable)
  | "quota" // 402 — balance / free credits exhausted (not retryable)
  | "rate_limit" // 429 — too many requests / model busy (retryable)
  | "server" // 408 / 5xx — panel or upstream failed (retryable)
  | "network" // fetch failed before an HTTP status (retryable)
  | "aborted" // caller cancelled (Esc / Ctrl+C — not an error)
  | "unknown"; // anything else (not retryable)

/**
 * Normalized provider error. The message is the friendly message
 * from src/api.ts (kept verbatim, so the TUI text does not change);
 * `kind` and `retryable` are the machine-readable parts Fase 7's
 * retry policy will read. `status` is the HTTP status when one
 * exists; `cause` keeps the original error for debugging.
 */
export class AdapterError extends Error {
  kind: AdapterErrorKind;
  status?: number;
  retryable: boolean;
  cause?: unknown;
  constructor(kind: AdapterErrorKind, message: string, opts: { status?: number; retryable?: boolean; cause?: unknown } = {}) {
    super(message);
    this.name = "AdapterError";
    this.kind = kind;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.cause = opts.cause;
  }
}

/** Retryable HTTP statuses (Freebuff codebuff-web-api.ts pattern:
 *  408/429/500/502/503/504). The retry POLICY lives in Fase 7;
 *  this only marks the fact. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Normalize any thrown value from the transport into an
 * AdapterError. ApiError (from src/api.ts) is mapped by HTTP
 * status; an abort (AbortError, or a signal that is already
 * aborted) becomes kind "aborted"; a fetch TypeError becomes
 * "network". Anything else becomes "unknown" with the original
 * error kept as `cause` — never swallowed, never reworded into a
 * claim about a specific provider.
 */
export function normalizeProviderError(e: unknown): AdapterError {
  if (e instanceof AdapterError) return e;
  if (e instanceof ApiError) {
    const status = e.status;
    if (status === 401) return new AdapterError("auth", e.message, { status, retryable: false, cause: e });
    if (status === 402) return new AdapterError("quota", e.message, { status, retryable: false, cause: e });
    if (status === 429) return new AdapterError("rate_limit", e.message, { status, retryable: true, cause: e });
    if (RETRYABLE_STATUSES.has(status)) {
      return new AdapterError("server", e.message, { status, retryable: true, cause: e });
    }
    return new AdapterError("unknown", e.message, { status, retryable: false, cause: e });
  }
  if (e instanceof Error) {
    if (e.name === "AbortError") {
      return new AdapterError("aborted", "dibatalkan", { retryable: false, cause: e });
    }
    // Undici fetch failures surface as TypeError ("fetch failed").
    if (e instanceof TypeError) {
      return new AdapterError("network", `tidak bisa menghubungi panel: ${e.message}`, { retryable: true, cause: e });
    }
    return new AdapterError("unknown", e.message, { retryable: false, cause: e });
  }
  return new AdapterError("unknown", String(e), { retryable: false, cause: e });
}

// ---------------------------------------------------------------------------
// Request + adapter contract
// ---------------------------------------------------------------------------

export interface AdapterChatRequest {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** Abort the request (Esc / Ctrl+C interrupt). Passed through to
   *  the transport untouched. */
  signal?: AbortSignal;
  /**
   * Native function tools (a later phase, NOT Fase 5). Present in the contract so that phase
   * 5 only fills the sender, not the shape. The Fase 2 adapter
   *  REJECTS any request that sets this — fail-loud, so no caller
   *  can silently believe native calling works before that phase wires
   *  it in. The ONE exception is the Fase 9 probe harness, which sets
   *  `probeNativeTools: true` (see below) to test native calling
   *  through the relay WITHOUT making it the loop's default path.
   *  Shape: the OpenAI function-tool format from the Fase 3
   *  registry (`toOpenAiFunction`), which the panel relay already
   *  forwards to providers.
   */
  tools?: OpenAiFunctionTool[];
  /**
   * Fase 9 probe ONLY (default off). When true, the adapter sends
   * `tools` through to the transport instead of rejecting them, and
   * emits `tool_call` chunks from the streamed deltas. This is a
   * test-scoped switch: the loop NEVER sets it, so the XML path
   * stays the production default and no model is ever forced onto
   * native calling. The probe wiring is a candidate for a later
   * phase; its placement is Reza's decision, not this phase's.
   */
  probeNativeTools?: boolean;
  /**
   * JSON mode request ({ type: "json_object" }). Fase 9 probe
   * ONLY, to test structured-output support through the relay.
   * The loop never sets it.
   */
  responseFormat?: { type: "json_object" };
  /** Later phase: "auto" (default) or "none". Ignored in Fase 2. */
  toolChoice?: "auto" | "none";
}

/** Transport function: the existing streamChat, injectable for
 *  tests (Freebuff AGENTS.md: prefer dependency injection). */
export type ChatTransport = (
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  handlers: {
    onDelta: (text: string) => void;
    onUsage: (usage: ChatUsage) => void;
    onReasoning?: (text: string) => void;
    onFinishReason?: (reason: string | null) => void;
    onToolCallDelta?: (delta: ToolCallDelta) => void;
  },
  maxTokens?: number,
  opts?: { signal?: AbortSignal; tools?: OpenAiFunctionTool[]; responseFormat?: { type: "json_object" } },
) => Promise<{ usage: ChatUsage | null }>;

/**
 * The universal adapter contract. One adapter serves every model:
 * the panel relay is already provider-agnostic (one OpenAI-compatible
 * endpoint), so the CLI needs exactly one implementation today.
 * A future direct-provider adapter (bypassing the panel) would
 * implement this same interface — the loop would not change.
 */
export interface ModelAdapter {
  /** Stable id, e.g. "panel-openai-compatible". */
  id: string;
  /** Stream one chat completion as normalized chunks. */
  chat(request: AdapterChatRequest): AsyncIterable<ChatChunk>;
}

/**
 * The panel relay adapter: wraps the existing `streamChat` transport
 * and converts its callbacks into the normalized chunk stream.
 * Behavior is identical to calling streamChat directly — same
 * request, same timeout (120s inside streamChat), same SSE parsing.
 * The only additions are normalization (chunk types, finish reason,
 * error kind) and the fail-loud guard for `tools`.
 */
export class PanelChatAdapter implements ModelAdapter {
  readonly id = "panel-openai-compatible";
  private readonly transport: ChatTransport;

  constructor(transport: ChatTransport = streamChat) {
    this.transport = transport;
  }

  async *chat(request: AdapterChatRequest): AsyncIterable<ChatChunk> {
    // A later phase owns native tools. Reject now, loudly, rather than
    // silently dropping them and letting a caller believe the model
    // received them. The Fase 9 probe harness is the only caller
    // allowed through, via probeNativeTools: true (test-scoped).
    if (request.tools !== undefined && request.tools.length > 0 && !request.probeNativeTools) {
      throw new AdapterError(
        "unknown",
        "native tools are not wired yet (a later phase, not Fase 5); probe-only use passes probeNativeTools: true",
      );
    }

    const queue: ChatChunk[] = [];
    let waiting: (() => void) | null = null;
    let done = false;
    let failure: unknown = null;
    let finishReason: string | null | undefined;
    // Fase 9 probe: per-index accumulation of native tool-call
    // deltas. Arguments arrive fragmented across SSE chunks; the
    // adapter concatenates them and emits one complete chunk per
    // call when the stream ends (see below).
    const toolCallState = new Map<number, { id: string; name: string; arguments: string }>();
    const push = (chunk: ChatChunk): void => {
      queue.push(chunk);
      wake();
    };
    /** Wake the generator loop when a chunk arrives or the transport
     *  settles. (A tiny helper rather than an inline null-check:
     *  the check-then-call pattern confuses TS narrowing here
     *  because `waiting` is also assigned inside closures.) */
    const wake = (): void => {
      const w = waiting;
      waiting = null;
      w?.();
    };

    // The consumer may stop iterating early (break). Abort the
    // underlying request then, so no stream is left running.
    const abortCtl = new AbortController();
    const onCallerAbort = (): void => abortCtl.abort();
    if (request.signal) {
      if (request.signal.aborted) abortCtl.abort();
      else request.signal.addEventListener("abort", onCallerAbort, { once: true });
    }
    const signal = AbortSignal.any(
      request.signal ? [abortCtl.signal, request.signal] : [abortCtl.signal],
    );

    const run = (async (): Promise<void> => {
      try {
        await this.transport(
          request.apiKey,
          request.model,
          request.messages,
          {
            onDelta: (text) => push({ type: "text", text }),
            onReasoning: (text) => push({ type: "reasoning", text }),
            onUsage: (usage) => push({ type: "usage", usage }),
            onFinishReason: (reason) => {
              finishReason = reason;
            },
            onToolCallDelta: (delta) => {
              const state = toolCallState.get(delta.index) ?? { id: "", name: "", arguments: "" };
              toolCallState.set(delta.index, state);
              if (typeof delta.id === "string" && delta.id.length > 0) state.id = delta.id;
              if (typeof delta.name === "string" && delta.name.length > 0) state.name = delta.name;
              if (typeof delta.arguments === "string") state.arguments += delta.arguments;
              push({ type: "tool_call", id: state.id, index: delta.index, name: state.name, arguments: state.arguments, complete: false });
            },
          },
          request.maxTokens ?? 1024,
          {
            signal,
            // Fase 9 probe only: tools go out ONLY when the caller
            // explicitly opted into the probe. responseFormat is
            // likewise probe-only; the loop never sets either.
            ...(request.probeNativeTools && request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
            ...(request.responseFormat ? { responseFormat: request.responseFormat } : {}),
          },
        );
      } catch (e) {
        failure = e;
      } finally {
        done = true;
        wake();
      }
    })();

    try {
      while (true) {
        while (queue.length > 0) {
          const chunk = queue.shift();
          if (chunk) yield chunk;
        }
        if (done) break;
        await new Promise<void>((resolve) => {
          waiting = resolve;
        });
      }
      if (failure !== null) throw normalizeProviderError(failure);
      // Fase 9 probe: a tool call is complete only when the stream
      // ended cleanly. Emit one complete chunk per accumulated call
      // (index order), carrying the fully concatenated arguments —
      // a consumer takes the complete chunk as the call's final
      // form. On failure (above) no complete chunk is emitted, so
      // a partial call can never be mistaken for a real one.
      for (const [index, state] of [...toolCallState.entries()].sort((a, b) => a[0] - b[0])) {
        yield { type: "tool_call", id: state.id, index, name: state.name, arguments: state.arguments, complete: true };
      }
      // Finish reason is emitted only when the server actually sent
      // one. If it never arrives, no finish chunk is faked — a later
      // phase's routing must not decide on a reason that was never sent.
      if (finishReason !== undefined) {
        yield { type: "finish", reason: mapFinishReason(finishReason) };
      }
    } finally {
      abortCtl.abort();
      if (request.signal) request.signal.removeEventListener("abort", onCallerAbort);
      // The transport promise settles on its own after the abort;
      // swallow its rejection here so breaking out of the iteration
      // never surfaces as an unhandled rejection. The error itself
      // is delivered through the normal path when the consumer
      // iterates to the end.
      run.catch(() => undefined);
    }
  }
}

/** The adapter the CLI uses today: the panel relay. */
export function createDefaultAdapter(transport?: ChatTransport): ModelAdapter {
  return new PanelChatAdapter(transport);
}

// ---------------------------------------------------------------------------
// Collection helper (loop + /compact share it)
// ---------------------------------------------------------------------------

export interface CollectedChat {
  /** Full response text (concatenated text chunks). */
  text: string;
  /** Full reasoning text (concatenated reasoning chunks). */
  reasoning: string;
  /** Last usage chunk received, if the server sent one. */
  usage: ChatUsage | null;
  /** Finish reason, when the server sent one. */
  finishReason: AdapterFinishReason | null;
  /**
   * True when the server signaled the stream finished: a usage
   * chunk (sent in the final chunk when include_usage is set) or
   * a finish chunk arrived. False means the stream ended WITHOUT
   * either — the server closed the connection mid-response, so
   * the text collected so far is PARTIAL and must not be presented
   * as a final response (Fase 7). A transport error throws
   * instead, so this only covers the clean-close-without-end
   * case. Adapters that predate this field and emit neither chunk
   * report false; the loop's test doubles append a finish chunk.
   */
  streamComplete: boolean;
}

/**
 * Run one adapter chat and collect it. Deltas are forwarded to the
 * callbacks as they arrive (so the TUI keeps streaming); the return
 * value is the complete response. Tool-call chunks (a later phase) are
 * ignored here — the loop parses tool calls from the collected text
 * via the XML parser, exactly as before Fase 2.
 */
export async function collectChatText(
  adapter: ModelAdapter,
  request: AdapterChatRequest,
  cbs: { onDelta?: (text: string) => void; onReasoning?: (text: string) => void; onUsage?: (usage: ChatUsage) => void } = {},
): Promise<CollectedChat> {
  let text = "";
  let reasoning = "";
  let usage: ChatUsage | null = null;
  let finishReason: AdapterFinishReason | null = null;
  for await (const chunk of adapter.chat(request)) {
    switch (chunk.type) {
      case "text":
        text += chunk.text;
        cbs.onDelta?.(chunk.text);
        break;
      case "reasoning":
        reasoning += chunk.text;
        cbs.onReasoning?.(chunk.text);
        break;
      case "usage":
        usage = chunk.usage;
        cbs.onUsage?.(chunk.usage);
        break;
      case "finish":
        finishReason = chunk.reason;
        break;
      case "tool_call":
        // Fase 9 probe: the adapter emits these ONLY when the
        // caller opted into probeNativeTools. The loop never probes,
        // so it still parses tool calls from the collected text via
        // the XML parser, exactly as before Fase 2.
        break;
    }
  }
  // Fase 7: a stream is complete only when the server said so — a
  // usage chunk or a finish chunk arrived. Without either, the
  // server closed the stream mid-response (clean TCP close, no
  // error thrown) and the collected text is partial.
  const streamComplete = usage !== null || finishReason !== null;
  return { text, reasoning, usage, finishReason, streamComplete };
}
