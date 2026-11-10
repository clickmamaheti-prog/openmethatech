// Fallback Tool Protocol — Universal Agent Runtime, Fase 6.
//
// This module formalizes the tool-call protocol the loop already
// runs, and the routing decision that picks it. It adds NO new wire
// format and NO new execution path: the XML protocol
// (`<codebuff_tool_call>` + JSON body, xml-parser.ts) is the one
// that already works live on free panel models, and the orchestrator
// (tool-orchestrator.ts) is still the only execution path. What
// Fase 6 adds is the CONTRACT around them: which channel a model
// uses, what counts as following the protocol, and what happens
// when a model fails to follow it twice in a row.
//
// ---------------------------------------------------------------------------
// The three things, and how they differ
// ---------------------------------------------------------------------------
//
// - NATIVE tool calling: the model returns structured `tool_calls`
//   when the adapter sends `tools` (OpenAI function format,
//   registry toOpenAiFunction). The adapter contract already carries
//   the shape (model-adapter.ts: `tools`, `toolChoice`, `tool_call`
//   chunks) but the CLI does NOT send tools yet — a later phase
//   wires it in. Native is a CHANNEL, not a policy.
// - XML tool calling: the model emits tool calls as JSON inside
//   `<codebuff_tool_call>` tags in its plain-text reply; the loop
//   parses them (xml-parser.ts) and hands them to the orchestrator.
//   This is the channel that actually runs today, for every model.
// - FALLBACK (this module's policy): the ROUTING rule that selects
//   the XML channel whenever native tool calling is NOT proven for
//   a model. "Fallback" is not a third wire format — it is the
//   decision to use XML because native is unavailable or unproven.
//   A model with `nativeToolCalling: UNKNOWN` is routed to the
//   fallback, never assumed to support native: UNKNOWN means "not
//   proven", and only a live probe (Fase 9) or provider config
//   marked proven can move a model to the native channel.
//
// Routing table (what the loop reads at turn start):
//
//   nativeToolCalling proven SUPPORTED (probe-live) → "native"
//   nativeToolCalling SUPPORTED from provider-config only → "xml-fallback"
//       (a config claim is not proof for routing —
//       isCapabilityProven() says so, Fase 2)
//   nativeToolCalling UNSUPPORTED / UNKNOWN → "xml-fallback"
//   model not in the registry at all → "xml-fallback"
//
// Today the routing resolves to "xml-fallback" for every model,
// because nothing has been proven native yet. That is the honest
// result, and the loop records the resolved channel in
// AgentLoopResult.toolChannel so a later phase can see the decision
// point and act on it. The XML execution path does not change with
// the channel: until the native phase lands, XML is the only path
// that executes anything.
//
// ---------------------------------------------------------------------------
// What counts as following the protocol (a "protocol violation")
// ---------------------------------------------------------------------------
//
// A step violates the protocol when the model produces NO tool call
// that actually executes, because the call never became executable:
//
//   - malformed JSON inside a closed tag, or an unclosed tag
//     (xml-parser.ts parseErrors);
//   - a call naming a tool that does not exist or is unavailable in
//     the current mode (orchestrator: unknown tool);
//   - a call whose input fails the registry JSON Schema validation
//     (orchestrator: schema-invalid).
//
// A call that PASSES validation and runs — even if the handler
// returns ok:false, times out, or throws — is NOT a violation: the
// model followed the protocol, the tool itself failed. Execution
// errors get the ordinary [TOOL_CALL_ERROR] retry step, never a
// protocol stop. The orchestrator marks this distinction with
// OrchestratedToolResult.failureKind ("validation" vs "execution" /
// "timeout" / null); the loop reads it, never re-parses output text.
//
// Promising tool work but emitting no call at all is the fourth
// violation shape: the loop already nudges at most twice
// (MAX_TOOL_CALL_NUDGES, loop.ts). Exhausting both nudges is a
// protocol failure too — the turn ends with the explicit message
// below instead of completing silently as "no more tool calls".
//
// ---------------------------------------------------------------------------
// The 2x rule (audit Fase 1 §9, binding)
// ---------------------------------------------------------------------------
//
// Two CONSECUTIVE violation steps stop the turn with an explicit
// message to the user — never a silent end, never a 40-step burn
// to the no-progress guard. One violation gets the ordinary retry
// ([TOOL_CALL_ERROR] / nudge); the second consecutive one stops.
// Any step in which at least one call actually executes resets the
// streak to zero: the model proved it can follow the protocol, and
// a later violation starts a fresh count. A plain-text answer ends
// the turn normally and is not a violation.
//
// The explicit message is delivered to the user two ways: as the
// loop's finalText (and a `text` event, so the TUI shows it as the
// assistant's last message) and as the stopReason (shown by the TUI
// as "Agen berhenti: ...").

import { capabilitiesFor, isCapabilityProven, type CapabilityRecord } from "./model-capabilities.js";
import type { OrchestratedToolResult } from "./tool-orchestrator.js";

/** How a model is invoked this turn. */
export type ToolCallChannel = "native" | "xml-fallback";

/**
 * Which channel a model uses, from its capability record. Native
 * ONLY when nativeToolCalling is proven SUPPORTED (live probe, or
 * the transport fact — which never applies to native calling, so in
 * practice probe-live only). Everything else — UNSUPPORTED, UNKNOWN,
 * SUPPORTED-from-provider-config-only — routes to the XML fallback.
 * UNKNOWN is never treated as SUPPORTED.
 */
export function resolveToolChannel(record: CapabilityRecord): ToolCallChannel {
  return isCapabilityProven(record, "nativeToolCalling") ? "native" : "xml-fallback";
}

/** resolveToolChannel for a model id (unlisted models are all-UNKNOWN → fallback). */
export function channelForModel(modelId: string): ToolCallChannel {
  return resolveToolChannel(capabilitiesFor(modelId));
}

/** Consecutive protocol violations that stop a turn (audit §9). */
export const PROTOCOL_FAILURE_LIMIT = 2;

/**
 * The explicit message shown to the user when a turn stops for
 * protocol violations. Names the model and the concrete reason, so
 * the user knows it is the model not following the format — not a
 * crash, not a quota error, and not a tool that failed. The model
 * itself already got the detailed [TOOL_CALL_ERROR] feedback in
 * history; this message is for the user, not the model.
 */
export function protocolFailureMessage(model: string, detail: string): string {
  return (
    `This model (${model}) did not follow the tool-call format (${detail}) ` +
    `after ${PROTOCOL_FAILURE_LIMIT} attempts, so the turn was stopped without running any tool. ` +
    `Try a different model, or rephrase the request.`
  );
}

/** Short stopReason for the same failure (shown as "Agen berhenti: ..."). */
export function protocolFailureStopReason(detail: string): string {
  return `protocol violation: model did not follow the tool-call format (${detail})`;
}

/**
 * True when this orchestrator result is a protocol violation: the
 * call never ran because it failed validation (unknown tool,
 * unavailable in mode, schema-invalid input). A result with
 * failureKind "execution" / "timeout" / null ran the handler — the
 * model followed the protocol and the tool itself failed.
 */
export function isProtocolViolationResult(result: OrchestratedToolResult): boolean {
  return result.failureKind === "validation";
}

/**
 * Consecutive-violation counter for one turn. Pure and tiny, so the
 * rule is unit-testable without running a loop: record a violation
 * step, record a step where at least one call executed, ask whether
 * the turn must stop.
 */
export interface ProtocolTracker {
  /** Consecutive violation steps so far. */
  violations: number;
  /** Record a step that produced a protocol violation and no execution. */
  recordViolation(): void;
  /** Record a step in which at least one call actually executed. */
  recordExecution(): void;
  /** True once the streak reaches PROTOCOL_FAILURE_LIMIT. */
  shouldStop(): boolean;
}

export function createProtocolTracker(): ProtocolTracker {
  let violations = 0;
  return {
    get violations() {
      return violations;
    },
    recordViolation() {
      violations += 1;
    },
    recordExecution() {
      violations = 0;
    },
    shouldStop() {
      return violations >= PROTOCOL_FAILURE_LIMIT;
    },
  };
}
