# MethaTech Tool-Call Protocol

**Status:** Formal specification, Fase 6 (Universal Agent Runtime).
**Applies to:** the MethaTech CLI agent loop (`src/agent/loop.ts`).
**Normative references:** `src/agent/fallback-protocol.ts` (routing + the
2x rule), `src/agent/xml-parser.ts` (wire format), `src/agent/tool-registry.ts`
(tool definitions + validation), `src/agent/tool-orchestrator.ts` (execution),
`src/agent/model-capabilities.ts` (capability routing).

This document formalizes the tool-call protocol the loop already runs.
It does not invent a new wire format: the XML protocol below is the
one proven live on free panel models (glm-5.3-flash, 2026-11-09).
What Fase 6 adds is the contract around it — which channel a model
uses, what counts as following the protocol, and what happens when a
model fails to follow it twice in a row.

## 1. Channels: native, XML, fallback

A model can invoke tools through exactly one channel per turn. The
loop resolves the channel from the capability registry at turn start
(`fallback-protocol.ts: resolveToolChannel`, recorded in
`AgentLoopResult.toolChannel`).

| Channel | Wire format | Status today |
|---|---|---|
| `native` | Structured `tool_calls` in the model response; the adapter sends `tools` (OpenAI function format, `tool-registry.ts: toOpenAiFunction`). | NOT wired into the loop. The adapter contract carries the shape, and a probe-only opt-in (`probeNativeTools`, Fase 9, default OFF) sends `tools` for live capability probes only. The loop never sends `tools`; a later phase wires it (placement decided by Reza). |
| `xml-fallback` | JSON inside `<codebuff_tool_call>` tags in plain-text replies (§2). | ACTIVE for every model. |

**Fallback is a routing policy, not a third wire format.** It is the
decision to use the XML channel whenever native tool calling is NOT
proven for a model. The routing table:

| `nativeToolCalling` capability | Channel |
|---|---|
| SUPPORTED, source `probe-live` | `native` |
| SUPPORTED, source `provider-config` only | `xml-fallback` (a config claim is not proof for routing) |
| UNSUPPORTED | `xml-fallback` |
| UNKNOWN | `xml-fallback` — UNKNOWN is never treated as SUPPORTED |
| Model not in the registry | `xml-fallback` |

Today the routing resolves to `xml-fallback` for every model, because
nothing has been proven native yet. That is the honest result. When
the native phase lands, it reads the same `toolChannel` decision
point; the XML path stays as the fallback for models that fail or
lack native support.

## 2. Wire format (XML channel)

### 2.1 Tag

One call per tag. The canonical tag name is `<codebuff_tool_call>`
with a matching close tag. The alias `<codex_tool_call>` is accepted
identically (a free model emits it live); the body format is the same.

```xml
<codebuff_tool_call>
{"cb_tool_name": "read_files", "paths": ["src/index.ts"]}
</codebuff_tool_call>
```

### 2.2 JSON body

- The body is a single JSON object.
- `cb_tool_name` (string, required) is the tool name. All other keys
  are the tool input. `cb_easp` is consumed by the parser and never
  reaches the tool.
- The body must parse as JSON. Malformed JSON inside a closed tag is
  a parse error, not a silent drop (Freebuff silently drops it;
  MethaTech reports it so the model can retry).
- An unclosed tag at the end of a response is a parse error; its
  content is reported, not silently dropped.
- The tag name must be exact. A call in any other tag
  (`<tool_call>`, `<function_call>`, …) is ignored and never runs.

### 2.3 Batching

A model may emit several calls in one response, one tag each.
Independent calls should be batched in one response. Text outside
the tags is the model's visible message; text inside the tags is
never shown.

## 3. Validation rules

Every parsed call is validated before it executes, in this order
(orchestrator, `tool-orchestrator.ts: executeOne`):

1. **Mode membership** — the tool must be in the current mode's
   toolset. Otherwise: `unknown or unavailable tool in this mode: <name>`.
2. **Registry lookup** — the tool must exist in the Tool Registry
   (Fase 3). Otherwise: `unknown tool: <name>`.
3. **Input schema** — the input must satisfy the tool's registered
   JSON Schema (`tool-registry.ts: validateToolInput`). Otherwise a
   human-readable error naming the tool and the bad parameter
   (e.g. `read_files: paths: expected array`).

A validation failure is a **tool error result on the same channel**
as a handler error: the model sees it as a `role: "tool"` message
with `{tool, ok: false, output}` and may fix and retry. The call
never executes — no handler runs, no side effect happens, and no
execution-ledger entry is recorded for it.

Tool definitions (names, descriptions, input/output schemas,
permission, risk, timeout, limits) come ONLY from the Tool Registry
(`src/agent/tool-registry.ts`). The protocol never invents a tool
name or parameter: only the 11 registered tools exist.

## 4. Execution guarantees

- **Single execution path.** All calls run through the Tool
  Orchestrator (`executeToolCalls`, one batch per step). The loop
  never calls a handler directly.
- **One parsed call = exactly one execution.** The turn's execution
  ledger (`AgentLoopResult.executedToolCalls`, keys `step:index`)
  records every call that actually ran. A validation failure is
  not an execution and is not listed. A legitimate repeat (same
  tool + same arguments in a LATER step) is a different key and
  executes normally; the ledger does not dedupe.
- **Order.** Results are always returned in call order, whatever
  the execution order was. Read-only calls may run in a parallel
  wave; mutations run sequentially (Keputusan Reza 5).
- **Batch stops.** The batch stops after `ask_user` (turn pauses
  for answers) or a call with `endsAgentStep` (skill). Calls after
  the stopping point never run. `task_completed` does NOT stop the
  batch.
- **Cancellation.** An abort (Esc / Ctrl+C) stops the turn with
  `interrupted by user`. A call already running cannot be
  interrupted; remaining calls are skipped.

## 5. Error taxonomy

| Kind | Example | What happens |
|---|---|---|
| Parse error | Malformed JSON in a closed tag; unclosed tag | `[TOOL_CALL_ERROR]` user message; the model retries with fixed JSON (§6). |
| Unknown tool | `teleport`, or a tool outside the mode | Error result; the model may retry with a real tool (§6). |
| Schema-invalid input | Missing required param; wrong type | Error result naming the bad parameter (§6). |
| Execution error | Handler returns `ok: false` (file missing, edit conflict) | Error result; the model gets one retry step (§7). NOT a protocol violation. |
| Timeout | Handler exceeds its registry timeout | Error result (`timed out after … ms`); NOT a protocol violation. |
| Provider error | 401 / 402 / 429 / 5xx, network failure | The step ends, never the session: history stays intact and the next turn resumes from it. |
| Abort | Esc / Ctrl+C | `interrupted by user`; the turn stops. |

The orchestrator marks the distinction with
`OrchestratedToolResult.failureKind`: `"validation"` (call never
ran — a protocol violation), `"execution"` / `"timeout"` (the
handler ran and failed), `null` (success). The loop reads this
field; it never re-parses output text to classify a failure.

## 6. Retry and the 2x rule

### 6.1 First violation: retry

The first consecutive protocol violation gets ordinary feedback and
a retry step:

- Parse error → `[TOOL_CALL_ERROR] Your tool call JSON did not
  parse: … Fix the JSON and emit the call again inside
  <codebuff_tool_call> tags.`
- Unknown tool / schema-invalid → the error result itself (naming
  the tool or the bad parameter), plus the generic
  `[TOOL_CALL_ERROR] One or more tool calls above failed. Read the
  error, fix the call, and retry. Do not repeat the exact failing
  call.`
- Promised but missing call → `[TOOL_CALL_MISSING] You said you
  would check something with a tool, but no tool call was emitted.
  Emit the tool call NOW …` (at most 2 nudges per streak).

### 6.2 Second consecutive violation: explicit stop

**Two consecutive violation steps stop the turn with an explicit
message to the user** — never a silent end, never a 40-step burn to
the no-progress guard. A violation step is a step that produced NO
tool call that actually executed, because the call never became
executable: malformed JSON, unclosed tag, unknown tool, or
schema-invalid input. Any step in which at least one call actually
executes resets the streak to zero.

The explicit message is delivered two ways:

- As the assistant's final text (`finalText` + a `text` event, so
  the TUI shows it as the last message).
- As the stop reason (the TUI shows `Agen berhenti: protocol
  violation: model did not follow the tool-call format (<detail>)`).

Message shape (`fallback-protocol.ts: protocolFailureMessage`):

> This model (<model>) did not follow the tool-call format
> (<detail>) after 2 attempts, so the turn was stopped without
> running any tool. Try a different model, or rephrase the request.

`<detail>` names the concrete failure: `malformed tool-call JSON`,
`unclosed tool-call tag`, `unknown tool`, `invalid tool-call
parameters`, or `promised tool work but emitted no tool call after
2 reminders`.

### 6.3 What is NOT a violation

- A call that ran and failed (execution error, timeout): the model
  followed the protocol; the tool failed. It gets the ordinary
  retry step and does not count toward the 2x rule.
- A plain-text answer with no tool promise: the turn completes
  normally (`no more tool calls`).
- A mixed step (one valid call + one invalid call): the valid call
  executes, the streak resets, the turn continues.

## 7. Continuation after tool results

After a batch executes, each result is appended to history as a
`role: "tool"` message (`{tool, ok, output}`, produced ONLY by
`resultToToolMessage`, with synthetic id `call-{step}-{index}`),
and the next step sends the updated history to the model. The
assistant message keeps the raw text (so the model sees its own
calls). A tool error forces one more step so the model can retry;
the turn ends when a step returns no tool calls, when
`task_completed` is called, or when a guard stops it (max steps
100/600, no-progress 40, todo-loop 6, failed-edit 6, abort).

## 8. Limits

| Limit | Value | Source |
|---|---|---|
| Max steps per turn | 100 (absolute ceiling 600) | `loop.ts: MAX_AGENT_STEPS_DEFAULT` |
| No-progress stop | 40 steps without a successful call | `loop.ts: NO_PROGRESS_STOP_THRESHOLD` |
| Tool-call nudges | 2 per streak | `loop.ts: MAX_TOOL_CALL_NUDGES` |
| Protocol violations | 2 consecutive → explicit stop | `fallback-protocol.ts: PROTOCOL_FAILURE_LIMIT` |
| Todo-loop | recovery at 3, stop at 6 | `loop.ts: TODO_LOOP_*` |
| Failed edits | 6 to the same file | `loop.ts: FILE_EDIT_LOOP_STOP_THRESHOLD` |
| Per-tool timeout / output cap | registry metadata per tool | `tool-registry.ts` |

## 9. What this protocol does NOT cover (later phases)

- **Native tool calling as a loop path** — sending `tools` and
  parsing `delta.tool_calls` inside the loop is a later phase
  (placement decided by Reza). The adapter rejects any request
  carrying `tools` fail-loud, EXCEPT when the caller explicitly
  opts into the probe-only `probeNativeTools` flag (Fase 9, live
  capability probes only, default OFF). The loop never opts in.
  One model (Cohere command-r-plus-08-2024) is proven native via
  probe-live (Fase 9); all other models stay UNKNOWN for native
  until re-probed.
- **Retry policy for model calls, token budgeting, auto-compaction**
  — done in Fase 7 (`docs/UNIVERSAL-RUNTIME-PHASE7.md`).
- **Shell validation, secret redaction, audit log** — done in
  Fase 8 (`docs/UNIVERSAL-RUNTIME-PHASE8.md`). The shell-credential
  risk recorded in `docs/UNIVERSAL-RUNTIME-PHASE4.md` §5 is closed
  by the Fase 8 enforcement layers (see PHASE8 §1–§9 for the
  remaining limitations).
- **Confirmation gate** — NOT implemented (open item, decision 1
  of 2026-11-10). Metadata `confirmationPolicy` in the registry is
  the hook for it; no gate, Ask, YOLO, or `--yolo` workflow exists.
- **Live capability probes** — done in Fase 9
  (`docs/UNIVERSAL-RUNTIME-PHASE9.md`): 12 models proven for XML,
  1 proven native, 14 models untestable for native (panel 503 on
  requests carrying `tools`), 3 models untestable at all (upstream
  VectorHead saturated). Until re-probed, untested models stay
  UNKNOWN and the fallback is used.
