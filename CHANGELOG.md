# Changelog — MethaTech CLI

All notable changes to `@methatech-cli/cli`. Versions are published to npm
as `@methatech-cli/cli`.

## [0.1.11] — 2026-11-10

TUI layout restore on top of the 0.1.10 ContentBlock fix. The conversation
header is now persistent, adopted from the original Freebuff source
(CodebuffAI/freebuff, commit `5d8bd24`, `cli/src/chat.tsx` — the header is
a permanent first child of the scrollbox). No runtime, provider, or model
changes.

### TUI layout restore

- **Persistent conversation header:** the welcome info card now stays
  above the conversation once the first message is sent (its session line
  switches from "Pesan pertama memulai sesi." to "Sesi aktif.", following
  Freebuff's `freebuff-chat-header.tsx` conditional). Before the fix the
  whole welcome block vanished on the first message and the conversation
  jumped to the top of a mostly empty viewport.
- **ASCII banner deleted entirely** on Reza's order ("gausah pake code
  ASCII lah, hapus aja"): the block-letter "METHA TECH" wordmark
  (`BANNER_FONT`, `BANNER_ROWS`, `bannerLines()`, `centerText()`) is
  removed from the source; the welcome screen is now the info card alone
  plus the "Try:" starters and the hint, top-anchored and proportional on
  small terminals.
- **Header is render-only:** `/export` and `/compact` read the message
  list, never the header rows; the ContentBlock turn order and the
  `/export` after `/compact` behaviour from 0.1.10 are unchanged.
- **Regression tests:** PTY scenarios s13, s14, s33, and s35 now assert
  the persistent header (card rows 2–6, first timestamp row 7, "You:"
  row 8); s27's numbered-list check moved to the mid capture; the
  `start_tui` sleep went from 2s to 3s to fix a startup race flake.

Validation: `npx tsc` clean; `npm test` **428/428**; `test/agent-pty.sh`
**32/32**; `test/tui-pty.sh` **297/297**.

## [0.1.10] — 2026-11-10

TUI interaction and conversation rendering fixes on top of the 0.1.9
Universal Agent Runtime. No runtime, provider, or model changes.

### TUI interaction fix (ContentBlock)

- **Chronological turn order:** one assistant message per turn now holds
  ordered append-only blocks (text, tool, text, tool) adopted from the
  Freebuff ContentBlock model, so assistant text, tool calls, tool
  results, and TODOs render in true arrival order instead of all text
  above all tool calls.
- **Tool results attach to their own tool**, including parallel batches;
  TODOs stay in chronological position as a single list; a tool rejected
  by the mode is now shown as a system line instead of vanishing.
- **`/export` after `/compact`:** the compact summary is now included in
  the export file; ordinary system notices stay out.
- **Repeated `/compact`:** the previous summary is now fed back into the
  next summarization, so the context chain survives compact 1 → 2 → 3
  without duplication and without ordinary system notices leaking in.
- **Slash-command confirmations while scrolled up:** `/export`, `/mode`,
  `/agent`, and `/init` confirmations now snap the viewport to the bottom
  so they are visible after PgUp; other system notices keep the previous
  "don't yank while reading" behaviour.
- **Regression tests:** 9 tests in `test/slash.test.mjs` cover export
  selection and the compact chain; new PTY scenario s35 covers the
  chronological turn order.

Validation: `npx tsc` clean; `npm test` **428/428**; `test/agent-pty.sh`
**32/32**; `test/tui-pty.sh` **293/293**.

## [0.1.9] — 2026-11-10

The Universal Agent Runtime release. The CLI now runs a full local agent
runtime — one provider adapter, one tool registry, one orchestrator, one
agent loop — instead of plain chat. Agent mode is the default in every
chat session.

### Agent experience (§4j–§4q)

- **Tool-call fix (§4j):** models that emit the wrong tag
  (`<codex_tool_call>`) are now understood via an alias; when a model
  promises a tool call but emits none, the loop nudges it (max 2x per
  turn) and then stops explicitly instead of ending silently as if the
  work were done.
- **Status bar + colors (§4k):** the working indicator lives in its own
  padded box with a right-side cluster (step, timer, `■ Esc`) that
  collapses gracefully at narrow widths; assistant text renders in the
  theme text color instead of terminal-default gray.
- **Timestamp (§4p):** the `[HH:MM]` timestamp sits directly above the
  user message with a continuous green bar beside it (Freebuff layout);
  the earlier blank-line gap (§4l) was removed as too far.
- **Tool-wall (§4m):** anti-echo rule in the system prompt plus a
  tool-summary renderer — file reads show a one-line summary instead of
  dumping full contents into the chat. The model itself can still echo
  file contents in its own reply; the rule reduces this but does not
  guarantee it on every model.
- **Large paste (§4n):** pasting more than 2000 characters shows a
  compact attachment card (`📄 <title> · <type> · <N> baris`); the full
  content still reaches the agent. `Ctrl+E` edits the card back into a
  plain draft, `Ctrl+X` removes it. Bracketed paste is assembled
  correctly and ANSI is stripped so a paste cannot type commands.
- **Viewport + composer (§4o):** the message area is top-anchored (no
  empty void at the top on tall terminals) and the composer is a
  5-row bordered box at rest, with multiline input capped at half the
  terminal height.
- **Scrollbar removed (§4q):** the right-edge scrollbar is gone in all
  conditions. Scrolling itself is fully intact (swipe, wheel, PgUp/PgDn,
  auto-scroll, `↑ N baris di atas` / `↓ PgDn ke bawah` footer hints).

### Universal Agent Runtime (Fase 1–10)

- **Fase 1 — Architecture Audit:** documented the existing transport
  (provider-agnostic, OpenAI-compatible), the missing capability
  detection, and the open shell sandbox gap. No behavior change.
- **Fase 2 — Provider Adapter Standardization:** `src/agent/model-adapter.ts`
  — one internal contract (`ModelAdapter`, `ChatChunk`, `AdapterError`
  with normalized 401/402/429/5xx errors) wrapping the existing
  `streamChat` transport; `src/agent/model-capabilities.ts` — CLI
  capability registry with `SUPPORTED` / `UNSUPPORTED` / `UNKNOWN`
  statuses and per-field provenance. Native tools are NOT sent by the
  loop; the adapter rejects requests carrying them (fail-loud).
- **Fase 3 — Shared Tool Registry:** `src/agent/tool-registry.ts` —
  the single source of truth for the 11 tools: JSON Schema input
  (MCP shape), permission, risk, read-only/mutating classification,
  timeout, and output limits. Fail-fast on registry/factory drift.
  Includes a `toOpenAiFunction` converter for later native work.
- **Fase 4 — Universal Tool Orchestrator:** `src/agent/tool-orchestrator.ts`
  — the only tool execution path. Per call: mode membership, registry
  lookup + schema validation, execution via the existing handlers,
  registry timeout as a hang guard, MCP-style result normalization
  while history messages stay byte-identical. Read-only tools may run
  in parallel waves (max 4); mutations always run sequentially; results
  always return in call order.
- **Fase 5 — Universal Agent Loop:** adapter injection, an execution
  ledger (one entry per call that actually executed, on every exit
  path), and a written contract in the loop header. No runtime behavior
  change.
- **Fase 6 — Fallback Tool Protocol:** `docs/TOOL-CALL-PROTOCOL.md` —
  the normative XML protocol (`<codebuff_tool_call>`, alias
  `<codex_tool_call>`), capability-based routing (native only when
  proven `SUPPORTED` via live probe, otherwise XML fallback), and an
  explicit 2x protocol-failure limit with an explicit stop message.
  The ledger records only calls that really executed.
- **Fase 7 — Context & Streaming Integration:** `src/agent/context-manager.ts`
  — heuristic token estimation, context budgeting, truncation as a
  view (never a mutation: system prompt and pinned summary are never
  dropped, tool call and result are never separated), auto-compaction
  (max 1x/turn, reuses the `/compact` prompt), retry max 3x for
  retryable errors only when no delta was sent, incomplete-stream
  guard, and per-turn usage in the footer.
- **Fase 8 — Security Hardening:** enforcement in code, not prompt
  instructions. Six layers: shell command validation; Linux user +
  mount namespace sandbox (sensitive home paths masked, fail-closed);
  environment scrubbing for shell children; realpath containment
  (symlinks out of the workspace rejected); secret redaction on tool
  output, streaming, history, errors, and the audit log; append-only
  JSONL audit log (`<configDir>/audit.log`, mode 0600, 5 MB rotation).
  59 security tests, all with dummy credentials.
- **Fase 9 — Cross-Model Testing:** live probes against the panel
  relay (87 results, 2 passes). XML fallback proven on 12 models
  (all 10 free models, both Gemini, Grok 4.7, Kimi K3.1 Pro, Cohere
  Command R+). Native tool calling proven on exactly **one** model:
  Cohere Command R+ (2 native calls in one response). 14 models could
  not be tested for native because the panel returned HTTP 503 for
  every request carrying `tools`; Claude Sonnet, Claude Opus, and
  `methatech/uncensored` could not be tested at all (upstream
  saturated) — all remain `UNKNOWN`, not `UNSUPPORTED`. The Capability
  Registry now carries the probe evidence (`xmlToolCalling`, registry
  v2, `PROBE_RESULTS_2026_11_10`).
- **Fase 10 — Final Audit & Documentation:** independent re-audit of
  Fase 1–9 against the actual source code and raw probe evidence; all
  phases verified, no critical finding. Final architecture and audit
  documents in `docs/`.

### Limitations (honest, still open)

- **No confirmation gate.** The registry carries `confirmationPolicy`
  metadata (`required` for `run_terminal_command` and `write_file`,
  `scoped` for `str_replace`, `none` for the rest), but no gate is
  implemented and there is no Ask mode, YOLO mode, or `--yolo` flag.
  A destructive command that passes validation (e.g. `rm -rf ./build`
  inside the workspace) runs without confirmation.
- **Native tool calling is not the production path.** The loop never
  sends `tools`; XML fallback is what runs. Native is proven only for
  Cohere Command R+; a probe-only opt-in exists for live capability
  probes. Wiring native into the loop is a later decision.
- **No MCP integration.** The runtime adopts MCP formats and patterns
  (Tool JSON Schema, `CallToolResult`, tool annotations) but does not
  integrate the MCP SDK or any MCP server.
- **Sandbox is Linux-only.** The namespace sandbox needs Linux user
  namespaces; on Termux, macOS, and Windows the shell falls back to
  validation-only and reports that in the tool result and audit log.
- **Plain GET egress is allowed** (blocking it would break
  `npm install`); the validator can be bypassed by obfuscation, and
  the namespace covers most of it on Linux.
- **Live Termux verification still pending:** physical Android swipe,
  5-row composer, real Android clipboard paste, and anti-echo
  compliance on free models.
- **Known minor issues:** attachment cards are not counted in the
  layout budget (the frame can overflow and cut the footer when a
  paste card shows); per-step usage is not surfaced (per-turn only);
  `REGISTRY_VERSION` is still 1 although Fase 2 added a field;
  `kimi-k2.7-code` is retired upstream but still listed in
  `FREE_MODEL_IDS`; panel-reported usage numbers are inconsistent for
  `gpt-6-astra`, `gpt-6-luna`, and `grok-4.7`.

### Tests

`npx tsc` clean; `npm test` **415/415**; `test/agent-pty.sh` **32/32**;
`test/tui-pty.sh` **270/270**.

## [0.1.8] — 2026-11-09

- Text rendering: parse-before-wrap Markdown renderer
  (`src/ui/markdown.ts`, unified/remark), semantic colors, ANSI
  sanitization ported from Freebuff.
- Horizontal gutter: 1-column side gutter on message text.
- Vertical scrolling / mouse: SGR wheel events reach `useInput`;
  mouse tracking on TUI start, off on exit; 1 line per wheel event.
- Markdown rendering: full Markdown (headings, tables, code blocks,
  task lists, blockquotes) without leaking raw markers.

## [0.1.7] — 2026-11-09

- Agent is the default: plain-chat send removed entirely; every
  message goes through the agent loop. Footer always shows
  "Agent: Default". `/agent` removed as a toggle (it only reports
  the always-on status now).
- First live proof on Reza's Termux (glm-5.3-flash, free): the agent
  called List + Read and summarized his Termux home correctly.

## [0.1.6] — 2026-11-09

- Freebuff adoption: bordered input box, user message blocks, agent
  behavior (XML tool calls, 11 tools, skills, modes
  DEFAULT/LITE/MAX/PLAN, `/mode` `/init` `/compact` `/export`),
  scroll + Thinking + Ctrl+C fixes.

## [0.1.5] — 2026-11-08

- TUI upgrade: theme, command palette, model picker, Thinking
  shimmer, central `useInput` fixing the Ink 6 coalescing bug.
- Device-code login against the live panel.

## [0.1.1] — 2026-11-08

- First npm publish (`@methatech-cli/cli`).
- Base CLI: `login`, `chat`, `models`, `account`, `keys`, `topup`,
  `logout`; device-code login flow; 10 free models.
