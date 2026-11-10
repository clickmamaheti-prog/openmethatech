// Universal Tool Orchestrator — Universal Agent Runtime, Fase 4.
//
// This module is the SINGLE execution path for tool calls. The agent
// loop (loop.ts) calls `executeToolCalls`; it never calls a tool
// handler directly. The orchestrator owns, in this order per call:
//
//   1. mode membership (the caller's toolset — same message as the
//      loop used to produce inline),
//   2. registry lookup + input validation against the registered
//      JSON Schema (tool-registry.ts — the ONLY validator; no second
//      validator is written here),
//   3. execution through the EXISTING handler (tools.ts — handlers
//      are not rewritten, not duplicated),
//   4. timeout enforcement from registry metadata (a hang guard,
//      see effectiveTimeoutMs),
//   5. result normalization to the MCP CallToolResult shape
//      (content blocks + isError) while keeping the exact tool
//      message the loop already puts in model history
//      ({tool, ok, output}). Each result also carries `failureKind`
//      (Fase 6): "validation" when the call never ran (unknown tool,
//      unavailable in mode, schema-invalid), "execution"/"timeout"
//      when the handler ran and failed, null on success — so the
//      loop can tell a protocol violation from a tool failure
//      without re-parsing output text.
//
// Parallelism (Keputusan Reza 5): read-only calls may run in
// parallel when dependency-free; mutations stay sequential. The
// rule is derived from registry metadata — never hardcoded tool
// names: a call is parallel-eligible when its entry is
// effect "read-only" AND its category is neither "interaction"
// (ask_user pauses the turn) nor "control" (task_completed ends
// the turn) AND it does not set endsAgentStep (skill ends the
// step). With the 11 current tools that is exactly read_files,
// list_directory, glob, code_search. Consecutive eligible calls
// form a wave (Promise.all, chunks of maxParallel); any other call
// flushes the wave and runs alone, in order. Results are ALWAYS
// returned in call order, whatever the execution order was — the
// model's context must never see results shuffled.
//
// Batch stops: the batch stops after a result that pauses or ends
// the step (ask_user's askUserQuestions, or endsAgentStep) — the
// loop used to stop mid-batch at exactly those points, so calls
// after them in the same step never run. task_completed does NOT
// stop the batch (the loop kept executing the rest of the step
// after it, then ended the turn).
//
// Cancellation: the orchestrator checks the caller's AbortSignal
// before starting each wave/chunk/sequential call. A call already
// running cannot be interrupted (handlers take no signal — same
// as before Fase 4); remaining calls are skipped and the batch
// reports stoppedEarly with stopReason "cancelled". The loop still
// breaks with "interrupted by user" on its next iteration.
//
// What this module does NOT do (explicit non-goals, per Reza):
// - No confirmation gate, no Ask, no YOLO, no --yolo — Fase 8 was
//   ordered WITHOUT them (the gate stays an open item of Reza's
//   2026-11-10 decision 1). The registry's confirmationPolicy is
//   metadata only.
// - No new tools, no handler changes, no panel changes.
// - No behavior change to the XML tool-call path: tag, alias,
//   parser, nudge, and retry are untouched (loop.ts).
// - Fase 8 (Security Hardening) IS implemented here and in the
//   handlers: secret redaction on every tool output, audit logging
//   of every processed call, realpath-enforced containment, shell
//   command validation + namespace sandbox + scrubbed environment
//   (docs/UNIVERSAL-RUNTIME-PHASE8.md). The shell-credential risk
//   from audit Fase 2 §4 is closed by those layers.
//
// Freebuff reference (honest): Freebuff executes tool calls
// sequentially as they arrive in the stream
// (packages/agent-runtime/src/tool-stream-parser.ts — no
// Promise.all in the execution path; tool-executor.ts has a single
// Promise.allSettled for validation, not execution). Parallel
// batching is a MethaTech-new feature, NOT an adoption — the wave
// machinery here exists so future async tools (web_search,
// read_url, ...) can actually benefit; with the current 11 tools
// every read-only handler is synchronous (fs.readFileSync), so a
// wave launches concurrently but the work itself still runs on one
// thread in order. The ordering and stop guarantees above are the
// real, testable behavior of this phase.

import { type ChatMessage } from "../api.js";
import { getRegisteredTool, validateToolInput, type RegisteredTool } from "./tool-registry.js";
import { type ToolContext, type ToolResult } from "./tools.js";
import { type Redactor } from "./security.js";
import { appendAuditLog, AUDIT_SESSION_ID, summarizeToolArgs } from "./audit-log.js";

/** How long past a tool's own timeout the orchestrator waits before
 *  declaring the call hung. The handler's own timeout normally fires
 *  first and its detailed result wins; the orchestrator deadline is
 *  only a hang guard for a handler that never settles. */
export const ORCHESTRATOR_TIMEOUT_GRACE_MS = 5_000;

/** Default max parallel calls in one wave (audit Fase 1 §9
 *  suggestion). */
export const DEFAULT_MAX_PARALLEL = 4;

/** One parsed tool call, as the loop hands it over (XML parser
 *  shape {toolName, input} mapped to {name, input} so the
 *  orchestrator does not depend on the XML parser). */
export interface ToolCallRequest {
  name: string;
  input: Record<string, unknown>;
}

/** MCP CallToolResult-flavored normalized result
 *  (modelcontextprotocol/typescript-sdk, spec.types.2025-11-25.ts):
 *  tool-level errors are carried INSIDE the result (isError), never
 *  thrown — the model can self-correct from them, same channel as
 *  before. `output` is the exact text the loop puts in the model
 *  history message ({tool, ok, output}), unchanged from Fase 3. */
export interface OrchestratedToolResult {
  /** Tool name. */
  tool: string;
  /** Position of the call in the input batch (results are returned
   *  in this order). */
  index: number;
  /** The call's input (kept so the loop's guards can read e.g.
   *  input.path for the failed-edit guard without re-parsing). */
  input: Record<string, unknown>;
  /** Whether the call succeeded (handler ok, validation ok). */
  ok: boolean;
  /** Text returned to the model as the tool message. */
  output: string;
  /** MCP-shaped content blocks: one text block with `output`.
   *  A later phase's native path reads this; the XML path keeps using
   *  `output` directly. */
  content: { type: "text"; text: string }[];
  /** MCP convention: true when this is a tool-level error carried
   *  in the result (ok === false). */
  isError: boolean;
  /**
   * Why this result failed, for the Fase 6 fallback protocol
   * (fallback-protocol.ts): "validation" means the call never ran —
   * unknown tool, unavailable in mode, or schema-invalid input
   * (a protocol violation); "execution" means the handler ran and
   * returned ok:false or threw; "timeout" means the handler ran
   * and the hang guard fired; null means the call succeeded. The
   * loop reads this, never re-parses output text, to decide
   * whether a step violated the protocol or a tool merely failed.
   */
  failureKind: "validation" | "execution" | "timeout" | null;
  /** Wall-clock time of this call (validation + handler), ms. */
  durationMs: number;
  /** True when the orchestrator's hang-guard deadline fired (the
   *  handler never settled). Normally false: the handler's own
   *  timeout fires first and its detailed result wins. */
  timedOut: boolean;
  /** ask_user: the turn must pause for the user's answers. */
  askUserQuestions?: { question: string; options?: string[] }[];
  /** Fase 8: how run_terminal_command actually ran (copied from the
   *  handler result) — "namespace" or "validation-only". */
  sandbox?: "namespace" | "validation-only";
  /** Registry endsAgentStep (skill): the step ends after this
   *  result — the orchestrator stops the batch here. */
  endsAgentStep: boolean;
}

/** Why a batch stopped before all its calls ran. */
export type BatchStopReason = "ask_user" | "ends_agent_step" | "cancelled";

/** What executeToolCalls returns: results for the calls that were
 *  processed, always in call order, plus whether the batch stopped
 *  early (and why). Calls after the stopping point are NOT in
 *  `results` — they never ran. */
export interface OrchestratorBatchResult {
  results: OrchestratedToolResult[];
  stoppedEarly: boolean;
  stopReason?: BatchStopReason;
}

/** Context the orchestrator needs. `ctx` is the existing
 *  ToolContext (cwd, todos, onTodos); `toolNames` is the mode
 *  toolset the loop already computed. */
export interface OrchestratorContext {
  ctx: ToolContext;
  /** Tool names available in the current mode. Calls outside this
   *  set are rejected with the same message the loop used to
   *  produce inline. */
  toolNames: readonly string[];
  /** Cancellation: checked before starting each wave/chunk/call. */
  signal?: AbortSignal;
  /** Max parallel calls in one wave. Default DEFAULT_MAX_PARALLEL. */
  maxParallel?: number;
  /** Fired when a call is about to be validated/executed — after
   *  the mode + registry checks, before validation. The loop wires
   *  this to its `tool_call` event (with toolPreview), preserving
   *  the exact event order it had before Fase 4. Mode-rejected
   *  calls never fire this (the loop never announced them either). */
  onCallStart?: (call: { name: string; input: Record<string, unknown>; index: number }) => void;
  /** Fired for EVERY processed call once its result exists —
   *  including mode-rejected and validation-failed calls. The loop
   *  wires this to its `tool_result` event. In a parallel wave the
   *  callbacks fire in completion order; the returned `results`
   *  array is always in call order. */
  onCallResult?: (result: OrchestratedToolResult) => void;
  /** Fase 8: redact secrets from every tool output before it
   *  reaches the model (and from the audit log). Set by the loop
   *  from the session API key; when absent, no redaction happens
   *  at this level. */
  redact?: Redactor;
  /** Fase 8: when true, every processed call is written to the
   *  audit log (audit-log.ts). Default false — the loop enables it
   *  for real agent turns; unit tests leave it off so they never
   *  write to the user's real audit log. */
  audit?: boolean;
  /** Override the audit log file (tests use a temp path). */
  auditLogPath?: string;
}

// ---------------------------------------------------------------------------
// Timeout (registry metadata, hang guard)
// ---------------------------------------------------------------------------

/**
 * Effective timeout for one call, in ms, or null for no deadline.
 * Derived from registry metadata, never hardcoded per tool name:
 * a tool whose input schema declares `timeout_seconds` (today only
 * the shell tool) reads it from the call input — -1 (Freebuff
 * sentinel) means no timeout, otherwise clamped to the registry
 * ceiling (maxTimeoutMs) and a 1s floor; absent input falls back
 * to the registry default timeoutMs. Tools without a timeoutMs
 * have no deadline: their handlers are synchronous and bounded by
 * result limits instead.
 *
 * This mirrors the shell handler's own clamp exactly, so the
 * handler's own timeout normally fires first and its detailed
 * result (stdout/stderr/exitCode) wins over the orchestrator's
 * generic timeout result. The orchestrator only adds the grace
 * period (ORCHESTRATOR_TIMEOUT_GRACE_MS) as a hang guard.
 */
export function effectiveTimeoutMs(entry: RegisteredTool, input: Record<string, unknown>): number | null {
  const hasTimeoutParam = entry.inputSchema.properties["timeout_seconds"] !== undefined;
  if (hasTimeoutParam) {
    const raw = input["timeout_seconds"];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      if (raw === -1) return null;
      const maxSeconds = entry.maxTimeoutMs !== undefined ? entry.maxTimeoutMs / 1000 : 600;
      return Math.min(maxSeconds, Math.max(1, Math.floor(raw))) * 1000;
    }
  }
  return entry.timeoutMs ?? null;
}

/** Race a promise against a deadline; on timeout resolve with the
 *  value produced by onTimeout (never reject — a timeout is a tool
 *  error result, not a crash). The timer is always cleared. */
export function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

// ---------------------------------------------------------------------------
// Parallel eligibility (registry metadata, no hardcoded names)
// ---------------------------------------------------------------------------

/**
 * Whether this call may run in a parallel wave. Derived from the
 * registry entry: effect must be "read-only" AND the category must
 * be neither "interaction" (ask_user pauses the turn) nor "control"
 * (task_completed ends the turn) AND it must not set endsAgentStep
 * (skill ends the step). With the 11 current tools this is exactly
 * read_files, list_directory, glob, code_search — but the rule is
 * the metadata, so a future read-only tool is eligible
 * automatically and a future control-flow tool is not.
 */
export function isParallelEligible(entry: RegisteredTool | undefined): boolean {
  if (entry === undefined) return false;
  return (
    entry.effect === "read-only" &&
    entry.category !== "interaction" &&
    entry.category !== "control" &&
    entry.endsAgentStep !== true
  );
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Same head+tail cap as tools.ts capOutput (kept local so the
 *  orchestrator does not depend on an unexported helper). Handlers
 *  already cap their output; this is a safety net, idempotent on
 *  already-capped text. */
function capOutputTo(limit: number, text: string): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n… [output truncated, ${text.length} chars total] …\n${text.slice(-half)}`;
}

function errorResult(
  tool: string,
  index: number,
  input: Record<string, unknown>,
  output: string,
  startedAt: number,
  failureKind: "validation" | "execution" = "validation",
  redact: Redactor = (t) => t,
): OrchestratedToolResult {
  const redacted = redact(output);
  return {
    tool,
    index,
    input,
    ok: false,
    output: redacted,
    content: [{ type: "text", text: redacted }],
    isError: true,
    failureKind,
    durationMs: Date.now() - startedAt,
    timedOut: false,
    endsAgentStep: false,
  };
}

function normalizeResult(
  entry: RegisteredTool,
  index: number,
  input: Record<string, unknown>,
  raw: ToolResult,
  startedAt: number,
  timedOut: boolean,
  redact: Redactor = (t) => t,
): OrchestratedToolResult {
  // Fase 8: redact BEFORE the cap so a secret cannot survive in the
  // capped tail, and before the text reaches the model history.
  const output = capOutputTo(entry.outputLimitChars, redact(raw.output));
  return {
    tool: entry.name,
    index,
    input,
    ok: raw.ok,
    output,
    content: [{ type: "text", text: output }],
    isError: !raw.ok,
    // Fase 6: the handler ran, so a failure here is an execution
    // failure (or a timeout), never a protocol violation.
    failureKind: timedOut ? "timeout" : raw.ok ? null : "execution",
    durationMs: Date.now() - startedAt,
    timedOut,
    askUserQuestions: raw.askUserQuestions,
    sandbox: raw.sandbox,
    endsAgentStep: entry.endsAgentStep === true,
  };
}

/** Fase 8: write one audit entry for a processed call. The entry
 *  carries a sanitized, redacted argument summary — never file
 *  contents or secret values (audit-log.ts). */
function auditCall(orch: OrchestratorContext, result: OrchestratedToolResult): void {
  if (!orch.audit) return;
  appendAuditLog(
    {
      ts: new Date().toISOString(),
      session: AUDIT_SESSION_ID,
      tool: result.tool,
      ok: result.ok,
      durationMs: result.durationMs,
      failureKind: result.failureKind,
      sandbox: result.sandbox,
      args: summarizeToolArgs(result.tool, result.input, orch.redact ?? ((t) => t)),
    },
    orch.auditLogPath,
  );
}

/**
 * The exact tool message the loop puts in model history — the same
 * shape as before Fase 4 ({tool, ok, output}), so history built by
 * the orchestrator path is byte-identical to history built by the
 * old inline path. `toolCallId` keeps the loop's synthetic
 * `call-{step}-{index}` scheme for the XML path.
 */
export function resultToToolMessage(result: OrchestratedToolResult, toolCallId: string): ChatMessage {
  return {
    role: "tool",
    content: JSON.stringify({ tool: result.tool, ok: result.ok, output: result.output }),
    name: result.tool,
    tool_call_id: toolCallId,
  };
}

// ---------------------------------------------------------------------------
// Single-call execution
// ---------------------------------------------------------------------------

async function executeOne(
  call: ToolCallRequest,
  index: number,
  orch: OrchestratorContext,
): Promise<OrchestratedToolResult> {
  const startedAt = Date.now();
  const redact = orch.redact ?? ((t: string) => t);

  // 1. Mode membership — same message the loop used to produce inline.
  // Fase 8: this IS the registry permission enforcement. The mode
  // toolset is the permission boundary (Plan mode excludes every
  // mutating tool; the shell tool's own validator + sandbox + env
  // scrub are the second layer, applied inside the handler).
  if (!orch.toolNames.includes(call.name)) {
    const result = errorResult(call.name, index, call.input, `unknown or unavailable tool in this mode: ${call.name}`, startedAt, "validation", redact);
    auditCall(orch, result);
    return result;
  }

  // Registry lookup (fail-fast registry guarantees a mode-allowed
  // tool has an entry; the check below is defense in depth).
  const entry = getRegisteredTool(call.name);
  if (!entry) {
    const result = errorResult(call.name, index, call.input, `unknown tool: ${call.name}`, startedAt, "validation", redact);
    auditCall(orch, result);
    return result;
  }

  // Announced before validation, like the loop's tool_call event.
  orch.onCallStart?.({ name: call.name, input: call.input, index });

  // 2. Schema validation — the registry validator, the only one.
  // A validation failure is a tool error result on the same channel
  // as handler errors: the model can fix and retry.
  const validationError = validateToolInput(entry, call.input);
  if (validationError) {
    const result = errorResult(call.name, index, call.input, validationError, startedAt, "validation", redact);
    auditCall(orch, result);
    return result;
  }

  // 3. Execute through the EXISTING handler, with the registry
  // timeout as a hang guard (handler's own timeout normally fires
  // first — see effectiveTimeoutMs).
  const effective = effectiveTimeoutMs(entry, call.input);
  let timedOut = false;
  let raw: ToolResult;
  try {
    const run = entry.handler(orch.ctx, call.input);
    raw =
      effective === null
        ? await run
        : await withTimeout(run, effective + ORCHESTRATOR_TIMEOUT_GRACE_MS, () => {
            timedOut = true;
            return { ok: false, output: `${entry.name} timed out after ${effective} ms` };
          });
  } catch (e) {
    // Same message shape as tools.ts executeToolCall's catch.
    raw = { ok: false, output: `${entry.name} failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  // 4. Normalize (redact + cap safety net + MCP-shaped content blocks).
  const result = normalizeResult(entry, index, call.input, raw, startedAt, timedOut, redact);
  auditCall(orch, result);
  return result;
}

// ---------------------------------------------------------------------------
// Batch execution
// ---------------------------------------------------------------------------

/** Whether this result stops the batch (ask_user pauses the turn;
 *  endsAgentStep ends the step). task_completed does NOT stop the
 *  batch — the loop kept executing the rest of the step after it. */
function isBatchStopping(result: OrchestratedToolResult): BatchStopReason | null {
  if (result.askUserQuestions) return "ask_user";
  if (result.endsAgentStep) return "ends_agent_step";
  return null;
}

/**
 * Execute a batch of tool calls — the single execution path for
 * the agent loop. Results are always returned in call order.
 * Parallel-eligible consecutive calls run as a wave (chunks of
 * maxParallel); every other call runs alone, sequentially, in
 * order. The batch stops after a batch-stopping result, or when
 * the signal aborts before the next wave/call starts.
 */
export async function executeToolCalls(
  calls: ToolCallRequest[],
  orch: OrchestratorContext,
): Promise<OrchestratorBatchResult> {
  const results: OrchestratedToolResult[] = [];
  const maxParallel = Math.max(1, Math.floor(orch.maxParallel ?? DEFAULT_MAX_PARALLEL));
  let stoppedEarly = false;
  let stopReason: BatchStopReason | undefined;

  let i = 0;
  while (i < calls.length) {
    if (orch.signal?.aborted) {
      stoppedEarly = true;
      stopReason = "cancelled";
      break;
    }
    const call = calls[i] as ToolCallRequest;
    const entry = getRegisteredTool(call.name);

    if (isParallelEligible(entry) && orch.toolNames.includes(call.name)) {
      // Collect the consecutive eligible wave (mode-rejected or
      // ineligible calls break it — they run sequentially below).
      const wave: { call: ToolCallRequest; index: number }[] = [];
      while (i < calls.length) {
        const c = calls[i] as ToolCallRequest;
        const e = getRegisteredTool(c.name);
        if (!isParallelEligible(e) || !orch.toolNames.includes(c.name)) break;
        wave.push({ call: c, index: i });
        i += 1;
      }
      // Run the wave in chunks of maxParallel. Promise.all
      // preserves chunk order in its result array, and chunks run
      // in order, so results stay in call order.
      for (let s = 0; s < wave.length; s += maxParallel) {
        if (orch.signal?.aborted) {
          stoppedEarly = true;
          stopReason = "cancelled";
          break;
        }
        const chunk = wave.slice(s, s + maxParallel);
        const chunkResults = await Promise.all(
          chunk.map(({ call: c, index }) => executeOne(c, index, orch)),
        );
        results.push(...chunkResults);
        for (const r of chunkResults) orch.onCallResult?.(r);
      }
      if (stoppedEarly) break;
      continue;
    }

    // Sequential call (mutating, control-flow, or ineligible).
    const result = await executeOne(call, i, orch);
    results.push(result);
    orch.onCallResult?.(result);
    i += 1;
    const stop = isBatchStopping(result);
    if (stop !== null) {
      stoppedEarly = true;
      stopReason = stop;
      break;
    }
  }

  return { results, stoppedEarly, stopReason };
}
