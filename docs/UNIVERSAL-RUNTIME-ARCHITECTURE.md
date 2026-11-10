# MethaTech Universal Agent Runtime — Architecture

**Status:** Final, Fase 10 (2026-11-10). HEAD `b384284` (0.1.8 live);
working tree holds 0.1.9 (§4j–§4q) + Universal Runtime Fase 1–9,
uncommitted. This document describes the runtime AS BUILT and
verified in Fase 10. Companion documents:
`docs/UNIVERSAL-RUNTIME-FINAL-AUDIT.md` (audit evidence),
`docs/UNIVERSAL-RUNTIME-PHASE10.md` (closing report),
`docs/UNIVERSAL-RUNTIME-PHASE2.md` … `PHASE9.md` (per-phase history),
`docs/UNIVERSAL-RUNTIME-AUDIT.md` (Fase 1 audit),
`docs/TOOL-CALL-PROTOCOL.md` (normative tool-call contract).

**Reading rule:** where this document and a per-phase document
disagree, the SOURCE CODE wins. Known stale lines in historical
phase documents are listed in FINAL-AUDIT §7, not silently rewritten.

---

## 0. One-paragraph summary

The MethaTech CLI agent runs ENTIRELY on the user's machine
(TypeScript + Ink + React, Node.js + npm only). It talks to exactly
one HTTP endpoint — the MethaTech panel relay, an OpenAI-compatible
`POST /v1/chat/completions` SSE stream — and the model is just a
string in that request. All agent intelligence lives locally: one
agent loop drives turns through a provider adapter contract; one
tool registry describes 11 tools; one orchestrator executes them;
one fallback protocol decides the tool-call channel; one context
manager budgets the context window; six security layers enforce
what the model may do. The panel is a relay and provider gateway,
never an agent host. Native tool calling exists ONLY as a probe-only
opt-in used by live capability probes; production turns always use
the XML fallback channel.

---

## 1. Component map

```
Termux / terminal pengguna
│
├─ src/cli.ts ── commander entry
│    (methatech login/chat/models/account/keys/topup/logout)
│
├─ src/ui/ChatApp.tsx ── TUI (Ink)
│    ├─ DisplayMessage[] (display state, NOT model history)
│    ├─ agentHistoryRef: ChatMessage[] (model history across turns)
│    ├─ send(text) ── the ONLY send path; always runAgentLoop
│    ├─ /compact, /init, /export (src/agent/slash.ts)
│    └─ footer: per-turn usage (Fase 7), mode, hints
│
├─ src/agent/loop.ts ── runAgentLoop() — Universal Agent Loop (Fase 5)
│    ├─ adapter injected (AgentLoopOptions.adapter, default panel)
│    ├─ prepareContext per step (Fase 7)
│    ├─ retry max 3x on retryable provider errors (Fase 7)
│    ├─ parse <codebuff_tool_call> (src/agent/xml-parser.ts)
│    ├─ executeToolCalls(batch) per step (Fase 4)
│    ├─ execution ledger executedToolCalls (Fase 5, tightened Fase 6)
│    ├─ protocol tracker + 2x explicit stop (Fase 6)
│    ├─ per-turn redactor + audit flag (Fase 8)
│    └─ result: { history, finalText, completed, stopReason,
│         executedToolCalls, toolChannel, usage, context }
│
├─ src/agent/model-adapter.ts ── ModelAdapter contract (Fase 2)
│    ├─ PanelChatAdapter wraps streamChat (the ONLY transport caller)
│    ├─ ChatChunk: text | reasoning | usage | finish | tool_call
│    ├─ AdapterError + normalizeProviderError (401/402/429/408/5xx)
│    ├─ collectChatText (loop + /compact)
│    └─ probe-only: probeNativeTools + responseFormat (Fase 9, default OFF)
│
├─ src/agent/model-capabilities.ts ── Capability Registry (Fase 2, v2)
│    ├─ status SUPPORTED / UNSUPPORTED / UNKNOWN per capability
│    ├─ provenance per field (probe-live / provider-config /
│    │   transport / default)
│    ├─ isCapabilityProven (only probe-live / transport count)
│    ├─ PROBE_RESULTS_2026_11_10 (Fase 9 live evidence)
│    └─ toAvailableModelEntry (serializer for future panel integration)
│
├─ src/agent/tool-registry.ts ── Shared Tool Registry (Fase 3)
│    ├─ 11 tools: schema, permission, risk, effect, category,
│    │   confirmationPolicy, timeout, limits
│    ├─ validateToolInput (JSON Schema subset, no Zod)
│    ├─ toOpenAiFunction (native function-tool format)
│    └─ fail-fast on registry/factory drift
│
├─ src/agent/tool-orchestrator.ts ── Tool Orchestrator (Fase 4)
│    ├─ THE ONLY tool execution path
│    ├─ mode membership → registry lookup → schema validation
│    ├─ parallel waves (read-only) / sequential mutations
│    ├─ result normalization (MCP CallToolResult shape)
│    ├─ failureKind: validation | execution | timeout | null (Fase 6)
│    ├─ redaction of every tool output (Fase 8)
│    └─ audit logging of every processed call (Fase 8)
│
├─ src/agent/tools.ts ── 11 tool handlers (pre-runtime, unchanged
│    │   in shape; Fase 8 rewired containment + shell handler)
│    └─ executeToolCall: NO production caller (test seam only)
│
├─ src/agent/fallback-protocol.ts ── Fallback Tool Protocol (Fase 6)
│    ├─ resolveToolChannel / channelForModel
│    ├─ PROTOCOL_FAILURE_LIMIT = 2 + tracker + explicit messages
│    └─ isProtocolViolationResult (failureKind === "validation")
│
├─ src/agent/context-manager.ts ── Context & Streaming (Fase 7)
│    ├─ estimateTokens (heuristic ±20%), budgetContext
│    ├─ resolveContextWindow (fallback 128k planning default)
│    ├─ prepareContext (truncation as VIEW, never history mutation)
│    ├─ summarizeSegment (auto-compaction max 1x/turn)
│    └─ buildSummaryMessage ("[Ringkasan percakapan]"), addUsage
│
├─ src/agent/security.ts ── Shell validation, containment,
│    │   env scrub, secret redaction (Fase 8)
├─ src/agent/shell-sandbox.ts ── Linux user+mount namespace
│    │   sandbox (Fase 8)
├─ src/agent/audit-log.ts ── JSONL append-only audit log (Fase 8)
│
├─ src/agent/modes.ts ── DEFAULT / LITE / MAX / PLAN toolsets
├─ src/agent/prompt.ts ── system prompt (rebuilt fresh per turn)
├─ src/agent/skills.ts ── local SKILL.md discovery + `skill` tool
├─ src/agent/xml-parser.ts ── <codebuff_tool_call> parser
│    │   (+ alias <codex_tool_call>)
└─ src/api.ts ── the ONLY transport: streamChat (SSE), listModels,
     billing, device-code login
```

Dependencies (package.json): commander, ink 6.8.0, react 19,
remark/unified. NO zod, NO Vercel AI SDK, NO MCP SDK, NO OpenTUI.
Node >= 20. NO Bun.

---

## 2. One agent turn, end to end

```
User types → ChatApp.send()
  → runAgentLoop({ apiKey, model, cwd, mode, userPrompt, history,
                   adapter?, signal?, audit: true })
    → buildAgentSystemPrompt() (fresh file tree + git status)
    → prepareContext(history)          [Fase 7: budgeted VIEW]
    → adapter.chat(request)            [Fase 2: PanelChatAdapter]
        → streamChat → SSE deltas
        → collectChatText: text + reasoning + usage + finishReason
        → retry ≤3x on retryable error, only if no delta sent
    → stream-incomplete guard (no usage/finish chunk → explicit stop)
    → finish-reason guards (content_filter / length w/o tool call)
    → parseFullText(text)              [XML protocol, Fase 6]
        → parse errors → [TOOL_CALL_ERROR], violation streak +1
        → 2nd consecutive violation → EXPLICIT STOP (completed=false)
        → promise without call → nudge (max 2x), then explicit stop
    → executeToolCalls(batch, { redact, audit })   [Fase 4]
        → per call: mode → registry → schema → handler
        → read-only wave (Promise.all, max 4) / mutations sequential
        → results in call order; failureKind attached
        → ledger: ONLY calls that actually executed
    → tool messages appended to history (resultToToolMessage,
      id call-{step}-{index})
    → repeat until task_completed / no tool calls / maxSteps 100
      (ceiling 600) / no-progress 40 / todo-loop 6 / failed-edit 6
      / abort / protocol stop / stream guard
    → auto-compaction (max 1x/turn) if truncation dropped messages
  → agentHistoryRef = result.history
  → footer shows per-turn usage
```

**Invariants (tested, see FINAL-AUDIT §3):**

- One parsed call = exactly one execution (ledger keys `step:index`
  unique; validation failures never enter the ledger).
- History format is fixed: assistant keeps raw XML-tagged text;
  tool results are `{tool, ok, output}` + `name` +
  `tool_call_id call-{step}-{index}`.
- Provider error ends the STEP, never the session; history stays
  intact and the next turn resumes from it.
- Tool error is a result on the same channel, never a throw.
- Abort = `interrupted by user`, at any point.
- `toolChannel` is always `"xml-fallback"` today — the channel
  actually executed, not the routing decision (Fase 9 bug fix).

---

## 3. Provider adapter (Fase 2)

**Contract** (`src/agent/model-adapter.ts`):

```ts
interface ModelAdapter {
  id: string; // "panel-openai-compatible"
  chat(request: AdapterChatRequest): AsyncIterable<ChatChunk>;
}
interface AdapterChatRequest {
  apiKey, model, messages, maxTokens?, signal?,
  tools?, toolChoice?,           // contract shape only
  probeNativeTools?: boolean,    // Fase 9: probe-only opt-in, default OFF
  responseFormat?: { type: "json_object" }, // Fase 9: probe-only
}
type ChatChunk =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "usage"; usage: ChatUsage }
  | { type: "finish"; reason: AdapterFinishReason }
  | { type: "tool_call"; id, index, name, arguments, complete };
```

**Rules:**

- `PanelChatAdapter` is the only implementation; it wraps the
  existing `streamChat` (same transport, timeout 120s, SSE parsing).
  Transport is constructor-injected (Freebuff convention), so tests
  drive the loop with a scripted `MockAdapter` and no network.
- **Fail-loud:** a request carrying `tools` without
  `probeNativeTools: true` is rejected with `AdapterError`
  ("native tools are not wired yet (a later phase, not Fase 5);
  probe-only use passes probeNativeTools: true"). The loop never
  opts in. `collectChatText` ignores `tool_call` chunks.
- **Error normalization** (`normalizeProviderError`): 401 → `auth`,
  402 → `quota`, 429 → `rate_limit` (retryable), 408/500/502/503/
  504 → `server` (retryable), fetch failure → `network`
  (retryable), abort → `aborted`. Friendly messages from `api.ts`
  are preserved verbatim. Retry policy (Fase 7) reads `retryable`.
- **Finish reasons** mapped from OpenAI strings
  (`stop | length | tool_calls | content_filter | unknown`);
  a finish chunk is emitted only when the server really sends one.
- Breaking iteration aborts the in-flight request (no orphaned
  stream).

**What the adapter does NOT do:** no per-provider code in the CLI.
The real per-provider adapters live in the panel relay (Go, 40+
providers under `providers/`, contract `ChatInterface` at
`providers/base/interface.go:58`, transformer `UnifiedChatRequest`
with `Tools`). The CLI deliberately does not duplicate them.

---

## 4. Tool registry (Fase 3)

**Source of truth** (`src/agent/tool-registry.ts`, `REGISTRY_VERSION
= 1` — see FINAL-AUDIT §7 for the un-bumped-version note). Each of
the 11 tools carries: unique id (= name), description (referenced
from the factory in `tools.ts`, never duplicated), JSON Schema
input/output (MCP shape), `permission` (read | write | execute |
ask), `risk` (low | medium | high | critical), `effect`
(read-only | mutating), `category`, `confirmationPolicy`
(required | scoped | none) + `confirmationNote`, timeout, output
cap 50,000, result limits, `endsAgentStep`, and the handler
reference.

| Tool | Permission | Risk | Effect | Category | Confirmation |
|---|---|---|---|---|---|
| `read_files` | read | low | read-only | filesystem | none |
| `list_directory` | read | low | read-only | filesystem | none |
| `glob` | read | low | read-only | search | none |
| `code_search` | read | low | read-only | search | none |
| `str_replace` | write | high | mutating | filesystem | scoped |
| `write_file` | write | high | mutating | filesystem | required |
| `run_terminal_command` | execute | critical | mutating | shell | required |
| `write_todos` | write | low | mutating | state | none |
| `task_completed` | read | low | read-only | control | none |
| `ask_user` | ask | low | read-only | interaction | none |
| `skill` | read | medium | read-only | knowledge | none |

**Rules:**

- Fail-fast: a factory tool without registry metadata, or metadata
  without a factory tool, throws at registry build — silent drift
  is impossible.
- `validateToolInput` is a dependency-free JSON Schema subset
  validator (`type`, `required`, `properties`, `items`,
  `minLength`, `minItems`, `minimum`, `maximum`, `enum`,
  `additionalProperties`). It rejects ONLY what handlers already
  reject; extra keys are ignored; `str_replace` aliases pass
  (the handler stays the alias enforcer).
- `toOpenAiFunction(entry)` converts an entry to the OpenAI
  function-tool format the panel relay already accepts. Derived
  data, no behavior — used by the Fase 9 probe harness and by
  whatever later phase wires native calling.
- Permission and risk are DIFFERENT axes (Reza's clarification):
  read-only vs mutating is about state change; risk is about
  impact + confirmation need. `write_todos` is mutating but low
  risk; `skill` is read-only but medium risk (skill content enters
  the prompt).

**Modes** (`src/agent/modes.ts`): DEFAULT / LITE / MAX / PLAN are
filters over the registry, not separate tool lists. PLAN removes
`str_replace`, `write_file`, `run_terminal_command` (all mutating
tools). MAX is currently a stub behaving like DEFAULT.

---

## 5. Tool orchestrator (Fase 4)

**The ONLY execution path** (`src/agent/tool-orchestrator.ts`).
The loop calls `executeToolCalls(calls, ctx)` once per batch and
never touches a handler. Per call, in order:

1. **Mode membership** — outside the mode's toolset →
   `unknown or unavailable tool in this mode: <name>`.
2. **Registry lookup + JSON Schema validation** (the Fase 3
   validator — the ONLY validator). Failure = tool error result
   on the same channel; the call never runs.
3. **Execution** via the existing handler from `tools.ts`.
   No handler was rewritten or duplicated.
4. **Timeout** from registry metadata as a hang guard
   (shell: input `timeout_seconds` clamped to the 600s ceiling,
   `-1` = no deadline, default 120s; +5s grace so the handler's
   own timeout wins and its detailed result is used).
5. **Normalization** to MCP-shaped `CallToolResult` (content
   blocks + `isError`), while the history message stays
   byte-identical (`{tool, ok, output}`) via `resultToToolMessage`.

**Parallel vs sequential** (Reza's Decision 5, derived from
registry metadata, NO hardcoded tool names): eligible = effect
`read-only` AND category not `interaction`/`control` AND NOT
`endsAgentStep`. With the current 11 tools that is exactly
`read_files`, `list_directory`, `glob`, `code_search`. Consecutive
eligible calls form a wave (`Promise.all`, chunk max 4); any other
call breaks the wave and runs alone, sequentially. Results are
ALWAYS returned in call order. Honest note: read-only handlers are
currently synchronous, so parallel waves give no wall-clock
speedup today — what is proven is co-launch + result order; the
wave engine is ready for future async tools.

**Batch stops + cancellation:** the batch stops after `ask_user` /
`endsAgentStep` (`skill`); `task_completed` does NOT stop the
batch. The abort signal is checked before every wave/call; a
running call cannot be interrupted (same as before Fase 4).

**`failureKind`** (Fase 6, additive on `OrchestratedToolResult`):
`"validation"` = call never ran; `"execution"` / `"timeout"` =
handler ran and failed; `null` = success. The loop reads this
field instead of guessing from output text.

**Known deviations (nil impact, recorded in PHASE4 §6):**
failed-edit guard is evaluated AFTER the batch instead of per
call (one or two extra failed calls may execute before the turn
stops; failed edits never write); orchestrator timeout almost
never fires (handler timeouts win — it is a hang guard).

---

## 6. Agent loop (Fase 5)

`runAgentLoop` (`src/agent/loop.ts`) is the single turn driver.
Its contract is written in the file header: two contract
dependencies (ModelAdapter + Tool Orchestrator, Registry as
classification reader), the one-turn cycle, and the guaranteed
invariants (§2 above) + explicit non-goals.

**Adapter injection:** `AgentLoopOptions.adapter?: ModelAdapter`,
used as `opts.adapter ?? createDefaultAdapter()`. The legacy
`callModel` option still takes precedence when given (old-test
compatibility). The TUI passes no adapter and gets the panel relay
adapter.

**Execution ledger:** `AgentLoopResult.executedToolCalls` —
`{step, index, tool, ok, durationMs}[]`, one entry per call that
ACTUALLY executed, unique `(step, index)` key, filled on ALL exit
paths including early returns. Validation failures enter history
as tool messages but NOT the ledger (Fase 6 tightening).

**Guards (unchanged since 0.1.7):** MAX_STEPS 100 (absolute
ceiling 600), no-progress 40, todo-loop 3/6, failed-edit 6,
nudge max 2x, ask_user pause, endsAgentStep.

**Legacy seam:** `executeToolCall` in `tools.ts` has NO
production caller (only `test/agent.test.mjs` + `test/security.
test.mjs` drive handlers through it). It is kept as a test seam;
deleting it would force rewriting handler tests with no loop
benefit. It is NOT a second execution path for production code —
grep-verified in Fase 10 (only the definition + test callers).

---

## 7. Fallback tool protocol (Fase 6)

Normative document: `docs/TOOL-CALL-PROTOCOL.md`.
Implementation: `src/agent/fallback-protocol.ts`.

**Channels:** `native` (structured `tool_calls`, NOT wired into
the loop) vs `xml-fallback` (JSON inside
`<codebuff_tool_call>` tags, alias `<codex_tool_call>`, ACTIVE
for every model). **Fallback is a routing policy, not a third
wire format:** use XML whenever native is not proven.

**Routing** (`resolveToolChannel`): native ONLY when
`nativeToolCalling` is proven SUPPORTED via probe-live
(`isCapabilityProven`). UNKNOWN / UNSUPPORTED /
provider-config-only → XML fallback. UNKNOWN is NEVER treated as
SUPPORTED. `channelForModel(modelId)` wraps it (unknown model →
all-UNKNOWN → fallback).

**The 2x rule** (`PROTOCOL_FAILURE_LIMIT = 2`): three violation
paths, ONE identical explicit message (finalText + text event +
stopReason, `completed = false`):
1. malformed JSON / unclosed tag → 2nd violation stops;
2. an all-validation-failure batch → 2nd violation stops;
3. a promise without a call after 2 nudges → explicit stop
   (NOT completed "no more tool calls" as before Fase 6).
Plain-text answers without a promise still complete normally.
A step that executes at least one call resets the streak.
Tool execution errors are NOT violations — the turn continues.

**Anti-duplication:** one parsed call = exactly one execution;
the ledger records only real executions; retry/fallback never
re-executes the same call.

---

## 8. Context manager & streaming (Fase 7)

`src/agent/context-manager.ts`:

- **Token estimation** is a HEURISTIC (Latin ~4 chars/token, CJK
  ~1/char, ±20%), documented as an estimate, NEVER a billing
  number.
- **`resolveContextWindow`** reads `contextWindow` from the
  capability record; fallback is a conservative 128,000 when
  UNKNOWN — a planning default, NOT a measured per-model fact.
- **`budgetContext`** splits one request into system / history /
  tool-result / reserve (maxTokens + 256 margin).
- **`prepareContext` — truncation as a VIEW, not a mutation:**
  system prompt + pinned summary are never dropped; whole
  exchanges are dropped from the front (a tool call and its
  result are never separated); the last exchange is never
  dropped; tool results are trimmed in the view only (head 1500
  + marker + tail 500); a minimal view is still sent with
  `overBudget = true` when nothing fits.
- **`summarizeSegment` — auto-compaction max 1x/turn:** reuses
  the `/compact` prompt, input cap ~100,000 chars, failure →
  null → continue with the truncated view; the turn never
  crashes. The summary replaces the dropped segment in STORED
  history as a system message `[Ringkasan percakapan]`.
- **`addUsage`** accumulates per-step usage into the per-turn
  total surfaced in the TUI footer (existing `formatUsageLine`
  slot). Per-STEP breakdown remains an open follow-up.

**Streaming** (`src/agent/model-adapter.ts`,
`CollectedChat.streamComplete` — true only when a usage or finish
chunk arrives; `src/api.ts` named timeout signal → `ApiError(408)`
retryable, user abort stays `AbortError` not retryable):

- Incomplete-stream guard: partial text never enters history and
  never becomes the final answer.
- Retry max 3x ONLY for retryable errors (408/429/500/502/503/
  504, backoff 500ms then 1000ms, abortable) and ONLY when the
  failed attempt sent no delta at all (no duplicated display).
- Finish-reason guards: `content_filter` and `length` WITHOUT
  tool calls stop explicitly (`completed = false`); `length`
  WITH a tool call still executes it.
- Providers without usage/finish chunks always look incomplete
  (conservative, intended).

---

## 9. Security model (Fase 8)

Six enforcement layers, all in code — NOT prompt instructions.
Full before/after in `docs/UNIVERSAL-RUNTIME-PHASE8.md` §1.

1. **Command validation** (`security.ts: validateShellCommand`):
   sensitive paths, exfiltration primitives (curl/wget upload
   flags, pipe to shell, nc/ssh/scp/sudo/eval, inline code with
   network send), destructive primitives (`rm -rf /`, `mkfs`,
   `dd of=/dev/`, fork bomb). Quote-aware segment splitting
   (the `python3 -c "import socket; ..."` hole was found and
   fixed during development). Rejection = tool error with a
   reason. A command NAME alone is never the sole reason.
2. **Namespace sandbox** (`shell-sandbox.ts`): on Linux,
   `unshare --user --map-root-user --mount` + bind-mount empty
   directories over `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`,
   `~/.docker`, `~/.config`, the CLI config dir; `/dev/null`
   over `~/.npmrc`, `~/.netrc`, `~/.git-credentials`, `~/.env`.
   Masking is VERIFIED inside the namespace; failure = exit 126
   (fail closed). On platforms without user namespaces
   (Termux/macOS/Windows) it falls back to `"validation-only"`
   and REPORTS that honestly in the tool result + audit log.
3. **Env scrub** (`scrubShellEnv`): the shell child gets a small
   allowlist only; all `*_KEY`/`*_TOKEN`/`*_SECRET`/`*_PASSWORD`/
   `METATECH_*` are dropped.
4. **Realpath containment** (`resolveInsideSecure`): all file
   tools + shell cwd; symlinks pointing outside are rejected;
   `walkFiles` (glob/code_search) never follows symlinks.
5. **Secret redaction** (`createRedactor` /
   `collectSessionSecrets`): exact session values + generic
   patterns (`sk-…`, `Bearer …`, `api_key=…`, private keys) in
   the orchestrator (all tool output), loop (streaming, history,
   finalText, errors), shell handler, and ChatApp (whole-message
   pass — a secret split across two deltas is still redacted).
6. **Audit log** (`audit-log.ts`): JSONL append-only
   `<configDir>/audit.log`, mode 0600, 5 MB rotation — tool,
   time, ok/fail, duration, failureKind, sandbox mode, sanitized
   + redacted arguments. No file contents, no secret values,
   one JSON line per entry (anti-forgery). Enabled by the loop
   for real agent turns (`audit: true` from ChatApp; default
   false in tests so unit tests never write the user's real log).

**Permission enforcement** = mode toolset as the boundary (PLAN
rejects all mutating tools, rejections audited) + the shell
layers above for every mode that allows the shell. The
`confirmationPolicy` metadata is a hook only — **there is NO
confirmation gate** (open item, see §11).

**Honest limitations (PHASE8 §9):** the syntactic validator can
be beaten by obfuscation (the namespace covers most of it on
Linux); namespace is Linux-only; plain GET egress is allowed
(conscious trade-off — blocking it would kill `npm install`);
no confirmation gate; theoretical TOCTOU on symlinks; pattern
redaction is imperfect for unknown formats; unit tests are NOT
a formal security audit; the local audit log is not tamper-proof.
**This system has NOT undergone a professional penetration test.**
What exists is 59 security unit tests with dummy credentials
plus the Fase 9 cross-model enforcement tests.

---

## 10. Capability registry & matrix (Fase 2 + Fase 9)

**Registry** (`src/agent/model-capabilities.ts`,
`CAPABILITY_REGISTRY_VERSION = 2`): status SUPPORTED /
UNSUPPORTED / UNKNOWN per capability, honest seed (all UNKNOWN
except streaming SUPPORTED as a shared SSE transport fact, source
recorded as `transport`), per-field provenance, provider as a
display label only (from id prefix, overridable by live
`owned_by` via `mergeCatalogOwnedBy()`), `setCapability()` for
probe results (unknown keys throw; `verifiedAt` only for
probe-live), `isCapabilityProven()` true ONLY for sources
`probe-live`/`transport` — a SUPPORTED from provider-config does
NOT count as proven for routing. `toAvailableModelEntry()`
snake_case serializer for future `/api/available_model`
integration (design only, panel NOT changed). The registry is NOT
persisted to disk; probe results are seeded from
`PROBE_RESULTS_2026_11_10`.

**Actual matrix (live probe, 2 passes, 2026-11-10, 87 results,
test account id10, raw data `~/workspace/phase9-probe-results/`):**

S = SUPPORTED (probe-live), U = UNKNOWN. Streaming = SUPPORTED
via transport for all. Vision / contextWindow not probed.

| Model | native | xml | multi | parallel | structured | reasoning |
|---|---|---|---|---|---|---|
| deepseek-v4-flash | U¹ | S | U | U | S | U |
| glm-5.3-flash | U¹ | S | U | U | S | S |
| gpt-6-luna | U¹ | S | U | U | S | U |
| gemini-3.8-flash | U¹ | S² | U | U | S | S |
| gpt-6-astra | U¹ | S | U | U | S | U |
| gemini-3.1-pro | U¹ | S² | U | U | S | S |
| qwen3.8-flash | U¹ | S | U | U | S | S |
| qwen3.7-max | U¹ | S | U | U | S | S |
| deepseek-v4.1-flash | U¹ | S | U | U | S | U |
| claude-sonnet-4-6 | U³ | U³ | U | U | U³ | U |
| claude-opus-4-6-thinking | U³ | U³ | U | U | U³ | U |
| command-r-plus-08-2024 | **S** | S | **S** | **S** | S | U |
| grok-4.7 | U¹ | S | U | U | S | U |
| methatech/uncensored | U³ | U³ | U | U | U³ | U |
| kimi-k3.1-pro | U¹ | S | U | U | S | U |

¹ Native NOT testable: the panel returns 503 for every request
carrying `tools` (2 passes, 4 attempts/model), while plain
requests on the same model succeed seconds later. NOT a verdict
that the model lacks native support.
² XML proven in pass 2; pass 1 answered a plain greeting without
a tag (first-attempt compliance is inconsistent; the Fase 6 nudge
loop exists for exactly this case).
³ Not testable at all: all probes 503 in both passes (upstream
VectorHead saturated).

**Live-probe decision rules (used consistently in both passes):**
SUPPORTED = the model PROVED it in a probe. UNSUPPORTED = the
model was probed and did the opposite. UNKNOWN = not proven either
way. Transport/panel errors (503, timeout) are NOT capability
verdicts. Absence of a reasoning delta is UNKNOWN, not
UNSUPPORTED.

**Other Fase 9 observations:** panel usage numbers are
inconsistent for gpt-6-astra / gpt-6-luna / grok-4.7 (inflated vs
the actual text) — footer cost display for those models is
suspect until the panel explains its counting. kimi-k2.7-code no
longer exists in the live catalog (retired) and could not be
tested; it is replaced by kimi-k3.1-pro as the Moonshot
representative. The 503-for-`tools` finding is a panel/upstream
problem, not a CLI problem.

---

## 11. Open items (not done, not cancelled)

1. **Confirmation gate (Decision 1, 2026-11-10).** NOT
   implemented — excluded from Fase 8 by Reza's order, and NOT
   implemented in Fase 10 either. Metadata ready:
   `confirmationPolicy` required for `run_terminal_command` +
   `write_file`, scoped for `str_replace`, none for the rest;
   `requiresConfirmation` = policy ≠ "none";
   `toolsRequiringConfirmation()` returns
   `["str_replace", "write_file", "run_terminal_command"]`.
   Risk without the gate: a destructive command that PASSES the
   validator (e.g. `rm -rf ./build` inside the workspace) still
   runs without interactive confirmation; mitigation today is
   only the audit log (trace) + validator (absolute destructive
   patterns). Architecture touchpoints for a future gate: the
   orchestrator's `executeOne` (pre-execution check point),
   `confirmationPolicyFor()` / `requiresConfirmation` from the
   registry, `--yolo` flag parsing in `src/cli.ts` /
   `src/commands.ts` (does not exist yet), and a TUI prompt
   surface in `ChatApp.tsx` (does not exist yet). `--yolo` must
   NEVER bypass sandbox, security policy, input validation, or
   credential protection — that constraint is part of the
   decision, not an implementation detail.
2. **Native tool calling as a loop path.** Wiring exists ONLY as
   the probe-only opt-in (`probeNativeTools` + `delta.tool_calls`
   parsing, Fase 9). Placement is Reza's decision. Remaining
   work when it lands: a sender in the loop, per-capability
   routing via `resolveToolChannel`, native-vs-XML history
   normalization (synthetic ids `call-{step}-{index}` need
   normalization/stripping when the native path activates),
   live validation per channel (Fase 9 proved only Cohere).
   Until then the loop never sends `tools`.
3. **Re-probe when upstream recovers:** native for 14 models +
   all capabilities for Sonnet / Opus / methatech/uncensored.
4. **Per-step usage/cost surfacing to the TUI footer** (Fase 7
   delivered per-TURN usage; per-step breakdown is still open).
5. **Attachment card not counted in `layoutBudget`** (0.1.9 §4o
   follow-up): when a paste card shows, the frame overflows and
   the footer is cut. Needs Reza's word.
6. **Failed compaction is retried every step** until it succeeds
   (one failed call per step). Retry max 3x does not cover a long
   provider outage.
7. **Token estimation is heuristic (±20%)**; a real tokenizer
   (tiktoken) is a follow-up, not a Fase 7 item.
8. **`executeToolCall` in `tools.ts`** has no production caller —
   kept as a test seam for handlers.
9. **Panel-side items (not CLI work):** the 503-for-`tools`
   routing/saturation; inflated usage numbers for
   gpt-6-astra/gpt-6-luna/grok-4.7; kimi-k2.7-code retired but
   still listed in the CLI's `FREE_MODEL_IDS`.

---

## 12. Adding a provider or model (integration guide)

The runtime is designed so a new provider/model needs NO loop
change:

1. **Panel side:** add the channel in the panel (provider
   adapter + model mapping + prices). The CLI needs nothing
   here — it talks to one endpoint.
2. **Catalog:** the model appears via `/api/available_model`
   (or the compile-time `COMPILED_PRICES` / `FREE_MODEL_IDS`
   fallback). The capability registry seeds it automatically
   (all UNKNOWN except streaming).
3. **Probe (Fase 9 method):** run `test/probe-live.mjs`
   (native / XML / structured, 3 probes, short prompts, retry
   1x on retryable) against the panel relay with a TEST account
   key passed via env only — never printed, never stored.
   Two passes; a capability is SUPPORTED only when the model
   proves it.
4. **Seed:** write the result into
   `PROBE_RESULTS_<date>` in `src/agent/model-capabilities.ts`
   via `setCapability(..., "probe-live")` (bumps
   `CAPABILITY_REGISTRY_VERSION` when the shape changes).
5. **Routing follows automatically:** `resolveToolChannel`
   routes native only for probe-live-proven models; everything
   else falls back to XML. No loop change, no prompt change.
6. **If the model proves native:** it still runs through the
   SAME orchestrator, the SAME ledger, the SAME security layers
   — the channel changes, the enforcement does not.

---

## 13. Non-goals (deliberately NOT part of this runtime)

- No MCP client/server integration (format/patterns adopted only).
- No Exa / Firecrawl / web_search tool (not built; not in the 11).
- No sub-agents (`spawn_agents` — Fase 3 of the old plan, not built).
- No confirmation gate / Ask / YOLO / `--yolo` (open item §11.1).
- No server-side agent runtime (Freebuff runs server-side;
  MethaTech deliberately runs local — Decision 3).
- No session persistence to disk (history is in-memory per CLI
  session; restart = history lost).
- No per-step usage/cost surfacing (per-turn only).
- No real tokenizer (heuristic estimation only).
- No professional penetration test (unit tests only — §9).

---

## 14. File index (runtime modules)

| File | Lines | Fase | Role |
|---|---|---|---|
| `src/agent/model-adapter.ts` | 473 | 2, 7, 9 | ModelAdapter contract, PanelChatAdapter, errors, probe opt-in |
| `src/agent/model-capabilities.ts` | 477 | 2, 9 | Capability registry v2 + probe results |
| `src/agent/tool-registry.ts` | 736 | 3 (+2) | 11-tool registry, validator, toOpenAiFunction |
| `src/agent/tool-orchestrator.ts` | 544 | 4, 6, 8 | Only execution path, waves, failureKind, redact, audit |
| `src/agent/loop.ts` | 878 | 5, 6, 7, 8, 9 | Agent loop, ledger, protocol 2x, retry, compaction, redact |
| `src/agent/fallback-protocol.ts` | 190 | 6 | Routing, 2x rule, tracker, messages |
| `src/agent/context-manager.ts` | 407 | 7 | Estimation, budgeting, view, compaction, usage |
| `src/agent/security.ts` | 463 | 8 | Shell validation, containment, env scrub, redaction |
| `src/agent/shell-sandbox.ts` | 191 | 8 | Linux namespace sandbox |
| `src/agent/audit-log.ts` | 115 | 8 | JSONL audit log |
| `src/agent/tools.ts` | 689 | pre, 8 | 11 handlers (+ test seam executeToolCall) |
| `src/agent/xml-parser.ts` | 189 | pre, §4j | XML tag parser + alias |
| `src/agent/modes.ts` | 108 | pre | Mode toolsets |
| `src/agent/prompt.ts` | 174 | pre | System prompt builder |
| `src/agent/skills.ts` | 211 | pre | Local skill discovery |
| `src/agent/slash.ts` | 142 | pre | /init /compact /export |
| `src/agent/index.ts` | 20 | 2–8 | Module exports |
| `src/api.ts` | 397 | pre, 2, 7, 9 | The only transport (streamChat) |
| `src/ui/ChatApp.tsx` | — | 5, 7, 8 | TUI: send, /compact, usage footer, redaction, audit |

Test files: `test/tool-registry.test.mjs`, `test/model-adapter.
test.mjs`, `test/model-capabilities.test.mjs`, `test/tool-
orchestrator.test.mjs`, `test/agent-loop.test.mjs`, `test/fallback-
protocol.test.mjs`, `test/context-streaming.test.mjs`, `test/
security.test.mjs`, `test/cross-model.test.mjs`,
`test/probe-live.mjs` (live harness, not a unit test),
`test/agent-pty.sh` (32 scenarios), `test/tui-pty.sh` (270
scenarios). Full suite: **415 unit + 32 agent-pty + 270 tui-pty**
(Fase 10 re-verified, see FINAL-AUDIT §8).
