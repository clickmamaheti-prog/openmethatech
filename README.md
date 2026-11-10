# MethaTech CLI

Chat with MethaTech models from your terminal — with a built-in coding
agent. Black + lime, Node.js + npm only.

## Install

```sh
npm install -g @methatech-cli/cli
methatech login
methatech
```

Requires Node.js 20+. The published package is `@methatech-cli/cli`;
the binary is `methatech`.

To build from source instead:

```sh
npm install
npm run build
node dist/cli.js --help
# or: npm link   (then `methatech` works globally)
```

## Login

```sh
methatech login
```

Device-code login (default):

1. The CLI prints a verification URL and tries to open it in your
   browser. Sign in with your Google or GitHub account and approve.
2. The panel creates an API key named "MethaTech CLI" and the CLI
   polls until it is approved — the key is delivered exactly once and
   saved to `~/.config/metatech/credentials.json` (file 0600, dir
   0700).

Fallback (manual key paste):

```sh
methatech login --paste
```

1. Open `https://console.methatech.eu.org/login` in your browser and
   sign in.
2. Open the token page (`https://console.methatech.eu.org/panel/token`),
   copy an API key, and paste it into the CLI (input is masked).

You can also use the env var instead of a saved key:

```sh
export METATECH_API_KEY="sk-..."
```

## Commands

| Command | What it does |
|---|---|
| `methatech` (no args) | Chat TUI with the default model (logs in first if no key is saved) |
| `methatech chat [--model <id>]` | Chat TUI |
| `methatech models` | Model list: FREE $0.00 section first, then paid prices in $/1M |
| `methatech account` | Spending limit, used, balance (all in $) |
| `methatech keys` | Whether a key is saved here, and where to manage keys in the panel |
| `methatech topup` | Print and open the top-up page (`https://pay.methatech.eu.org`) |
| `methatech logout` | Delete the saved key |

## Chat and agent mode

The agent is the default: every message goes through the agent loop.
There is no plain-chat mode. The agent works in the folder where you
started the CLI — it reads files, edits them, and runs shell commands
there.

Slash commands inside the chat:

| Command | What it does |
|---|---|
| `/mode [default\|lite\|max\|plan]` | Switch agent mode (no argument cycles to the next mode) |
| `/agent` | Report that the agent is always on, and the current mode |
| `/init` | Write a codebase summary to `AGENTS.md` in the current folder (never overwrites an existing one) |
| `/compact` | Summarize the conversation so far to free context |
| `/export` | Export the conversation to `metatech-export-<timestamp>.md` in the current folder |
| `/models` | List models |
| `/model <id>` | Switch model |
| `/clear` | Clear the conversation (messages, agent history, todos) |
| `/account`, `/keys`, `/topup` | Same as the CLI commands above |
| `/help` | Help |
| `/exit` (or `/quit`) | Quit |

Keys: `Enter` send · `Ctrl+C` quit (press twice to exit) · `Ctrl+E` /
`Ctrl+X` edit or remove a paste attachment card · mouse wheel scrolls
· swipe on Termux scrolls (when mouse tracking is active).

### Agent modes

| Mode | Behavior |
|---|---|
| `DEFAULT` | Normal work: read, edit, run commands |
| `LITE` | Lighter toolset |
| `MAX` | Full toolset |
| `PLAN` | Planning only — `str_replace`, `write_file`, and `run_terminal_command` are removed, so the agent can read and plan but not change anything |

### The 11 tools

| Tool | What it does | Effect | Risk |
|---|---|---|---|
| `read_files` | Read files | read-only | low |
| `list_directory` | List a directory | read-only | low |
| `glob` | Find files by pattern | read-only | low |
| `code_search` | Search code | read-only | low |
| `str_replace` | Replace text in a file | mutating | high |
| `write_file` | Write a file | mutating | high |
| `run_terminal_command` | Run a shell command | mutating | critical |
| `write_todos` | Manage the todo list | mutating | low |
| `task_completed` | End the turn as done | read-only | low |
| `ask_user` | Ask the user a question (pauses the turn) | read-only | low |
| `skill` | Run a local skill | read-only | medium |

The agent calls tools by emitting a JSON block inside a
`<codebuff_tool_call>` tag. Every call goes through the Tool
Orchestrator: mode membership, registry lookup, JSON Schema input
validation, then the handler. Read-only tools may run in parallel;
mutations always run sequentially, and results always return in call
order.

## Universal Agent Runtime

One runtime, one tool registry, one permission system, many model
providers. The runtime lives entirely in the CLI; the panel stays a
relay / provider gateway.

- **Provider adapter** (`src/agent/model-adapter.ts`): one internal
  contract for all models over a single OpenAI-compatible endpoint,
  with normalized errors (401 auth, 402 quota, 429 rate limit,
  408/5xx server, all retryable where appropriate).
- **Tool registry** (`src/agent/tool-registry.ts`): the single source
  of truth for the 11 tools — schema, permission, risk,
  read-only/mutating classification, timeout, output limits.
- **Tool orchestrator** (`src/agent/tool-orchestrator.ts`): the only
  tool execution path in production.
- **Agent loop** (`src/agent/loop.ts`): adapter injection, an
  execution ledger (one entry per call that actually executed), and
  the tool-call protocol.
- **XML fallback** (`docs/TOOL-CALL-PROTOCOL.md`): the production tool
  channel. Native tool calling is used only when a model is proven
  `SUPPORTED` by a live probe; otherwise the XML path runs. The loop
  never sends `tools` by itself.
- **Context & streaming** (`src/agent/context-manager.ts`): token
  estimation, context budgeting, truncation as a view (system prompt
  and pinned summary are never dropped, a tool call and its result
  are never separated), auto-compaction (max once per turn, reuses
  the `/compact` prompt), retry max 3x for retryable errors only
  when no output was streamed yet, and per-turn usage in the footer.
- **Security model** (`src/agent/security.ts`, `src/agent/shell-sandbox.ts`,
  `src/agent/audit-log.ts`): enforcement in code, not prompt
  instructions. Shell commands are validated; on Linux they run in a
  user + mount namespace with sensitive home paths masked
  (fail-closed); shell children only get a small env allowlist;
  file tools reject symlinks that escape the workspace; secrets are
  redacted from tool output, streaming, history, errors, and the
  audit log; every tool execution is recorded in an append-only JSONL
  audit log at `<configDir>/audit.log` (mode 0600, 5 MB rotation).
- **Capability registry** (`src/agent/model-capabilities.ts`):
  `SUPPORTED` / `UNSUPPORTED` / `UNKNOWN` per capability, with
  per-field provenance. A capability only becomes `SUPPORTED` from a
  live probe — never from a model name or provider configuration.

### What live probes actually proved (2026-11-10)

- XML fallback works on 12 models, including all 10 free models.
- Native tool calling is proven on exactly **one** model: Cohere
  Command R+ (2 native calls in one response).
- 14 models could not be tested for native because the panel returned
  HTTP 503 for every request carrying `tools`. Claude Sonnet, Claude
  Opus, and `methatech/uncensored` could not be tested at all
  (upstream saturated). All of these stay `UNKNOWN`, not
  `UNSUPPORTED`.
- Panel-reported usage numbers are inconsistent for `gpt-6-astra`,
  `gpt-6-luna`, and `grok-4.7`.

See `docs/UNIVERSAL-RUNTIME-PHASE9.md` for the full probe results and
`docs/UNIVERSAL-RUNTIME-ARCHITECTURE.md` for the architecture.

## Prices

All prices are in dollars. The model list is fetched live from the
panel (`/api/available_model`, $ = ratio × 2). If the server cannot be
reached, a compiled-in price table (2026-11-08) is used. The 10 FREE
models are always listed first at $0.00 — they run on your free
credits:

`deepseek-v4-flash`, `glm-5.3-flash`, `gpt-6-luna`,
`gemini-3.8-flash`, `gpt-6-astra`, `gemini-3.1-pro`, `qwen3.8-flash`,
`qwen3.7-max`, `kimi-k2.7-code`, `deepseek-v4.1-flash`.

Default model: `glm-5.3-flash`. Fallback model: `deepseek-v4-flash`.

## Config

- `~/.config/metatech/credentials.json` — API key + last used model
  (override dir with `METATECH_CONFIG_DIR`)
- `METATECH_API_KEY` — env var takes precedence over the file
- `METATECH_API_BASE` (default `https://api.methatech.eu.org`) and
  `METATECH_CONSOLE_BASE` (default `https://console.methatech.eu.org`)
  — override for local testing

## Limitations

- **No confirmation gate.** The registry carries `confirmationPolicy`
  metadata, but no gate is implemented and there is no Ask mode, YOLO
  mode, or `--yolo` flag. A destructive command that passes validation
  runs without confirmation.
- **Native tool calling is not the production path.** The loop uses
  XML fallback; native is proven only for Cohere Command R+.
- **No MCP integration.** The runtime adopts MCP formats and patterns
  (Tool JSON Schema, `CallToolResult`) but does not integrate the MCP
  SDK or any MCP server.
- **Sandbox is Linux-only.** On Termux, macOS, and Windows the shell
  falls back to validation-only and says so in the tool result and
  audit log.
- **Plain GET egress is allowed** (blocking it would break
  `npm install`); the command validator can be bypassed by
  obfuscation.
- **No session persistence** and the capability registry is not
  persisted between runs.
- **Live Termux verification still pending:** physical Android swipe,
  5-row composer, real Android clipboard paste, anti-echo compliance
  on free models.
- **Known minor issues:** attachment cards are not counted in the
  layout budget (the frame can overflow and cut the footer when a
  paste card shows); per-step usage is not surfaced (per-turn only);
  `kimi-k2.7-code` is retired upstream but still listed among the
  free models.

See `CHANGELOG.md` for the full 0.1.11 change list.
