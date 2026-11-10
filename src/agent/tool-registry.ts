// Formal Tool Registry — Universal Agent Runtime, Fase 3.
//
// This module is the SINGLE SOURCE OF TRUTH for the 11 tools the CLI
// already has. It does NOT re-implement any tool: every execution
// handler is the existing one from ./tools.js. What the registry adds
// (audit Fase 1, §7 gap) is the metadata the old informal array
// lacked: unique ID, formal JSON Schema input/output, permission
// level, risk classification, read-only vs mutating classification,
// timeout and execution limits.
//
// Shape of the schema fields follows the MCP Tool definition
// (modelcontextprotocol/typescript-sdk, spec.types.2025-11-25.ts):
//   name, description, inputSchema {type:'object', properties,
//   required}, outputSchema (root must be type 'object'),
//   annotations (readOnlyHint / destructiveHint) as POLICY HINTS
// enforced by the host, never trusted from an untrusted server.
// MethaTech tools are local and in-process, so the registry IS the
// host's own metadata — no MCP transport or SDK is involved.
//
// Keputusan Reza 2026-11-10 (mengikat, dicatat di
// docs/UNIVERSAL-RUNTIME-PHASE3.md):
//  1. Confirmation gate HANYA untuk tool kritis, dengan opsi --yolo.
//     Read-only tanpa konfirmasi. --yolo boleh melewati konfirmasi
//     interaktif, tapi TIDAK BOLEH melewati security policy, sandbox
//     restriction, validasi input, atau perlindungan credential.
//     => `confirmationPolicy` (Fase 2, Klarifikasi 2026-11-10):
//     permission dan risk DIBEDAKAN — confirmation mengikuti RISK:
//     run_terminal_command (critical) "required", write_file (high,
//     whole-file) "required", str_replace (high, spans) "scoped"
//     (gate evaluates the call scope), the rest "none".
//     `requiresConfirmation` is true exactly for policy "required"
//     or "scoped". The gate itself is NOT implemented — Fase 8
//     was ordered WITHOUT a confirmation workflow, so the gate
//     stays an open item of Reza's 2026-11-10 decision 1; the
//     registry only carries the metadata the gate will need when
//     he orders it.
//  2. Capability metadata lives in the CLI first (this registry is
//     the pattern: SUPPORTED / UNSUPPORTED / UNKNOWN come in Fase 2).
//  3. Runtime stays local in the CLI; the panel stays a relay.
//  4. Live probe is a SUBSET first (10 free + Sonnet + Opus + 1 per
//     other provider) — Fase 9, not this phase.
//  5. Parallel execution: read-only tools may run in parallel when
//     dependency-free; mutations stay sequential. The orchestrator
//     (Fase 4) reads `effect` from this registry to decide.
//     => `effect` must be exact: a tool that changes any state
//     (file, shell, in-memory to-do list) is "mutating".
//
// Rules for this module:
// - No new tools. No behavior change to the XML tool-call path.
// - Validation mirrors the hand validators in tools.ts: it rejects
//   only what the handlers already reject (missing required param,
//   wrong type). Unknown extra keys are IGNORED (handlers ignore
//   them too), and str_replace alias keys (old/new/old_str/...) are
//   accepted — the schema documents the canonical shape, the
//   alias-aware handler remains the enforcer for aliases.
// - A registry that disagrees with the tool factories is a hard
//   error at first use (fail fast, caught by tests), never a silent
//   drift: every factory tool must have metadata, and every metadata
//   entry must match a factory tool.

import { allToolDefinitions, TOOL_OUTPUT_LIMIT, MAX_TERMINAL_TIMEOUT_SECONDS, type ToolDefinition, type ToolResult } from "./tools.js";

/** Registry format version. Bump when a field is added/renamed so
 *  Fase 2 (capability registry) and a later phase (native tools) can detect
 *  a stale registry. */
export const REGISTRY_VERSION = 1;

/** Permission level — who/what the tool may touch.
 *  read: only reads state (files, directories, search, skills).
 *  write: changes state (files, in-memory to-do list).
 *  execute: runs arbitrary code (shell).
 *  ask: does not touch state; it pauses the turn for the user. */
export type ToolPermission = "read" | "write" | "execute" | "ask";

/** Risk classification (audit Fase 1 §3). The confirmation gate
 *  (a later confirmation gate, when ordered) keys off risk
 *  THROUGH `confirmationPolicy` — see that
 *  type. Risk and permission are DIFFERENT axes (Klarifikasi Reza
 *  2026-11-10): risk is impact + confirmation need, permission is
 *  what the tool may touch.
 *  low: read-only or in-memory state, no destructive potential.
 *  medium: reads content that enters the model prompt (skill files)
 *    — a prompt-injection surface from local files.
 *  high: mutates files on disk (recoverable via git/backup, but a
 *    wrong edit destroys work).
 *  critical: arbitrary shell — the model chooses the command. */
export type ToolRisk = "low" | "medium" | "high" | "critical";

/**
 * Confirmation policy — what the confirmation gate must do (when
 * it is ordered in a later phase)
 * for this tool, once the gate exists. Derived from risk +
 * permission + change granularity (Klarifikasi Reza 2026-11-10 —
 * permission and risk are DIFFERENT axes, and confirmation follows
 * RISK, not effect alone):
 *
 * - "required": the gate MUST prompt before executing.
 *   run_terminal_command (critical: arbitrary shell) and write_file
 *   (high: whole-file overwrite) are both "required" — a whole-file
 *   write destroys the previous content in one call, so its scope
 *   never needs per-call evaluation.
 * - "scoped": the gate evaluates the CALL before deciding.
 *   str_replace (high) edits spans, not the whole file: a
 *   one-line fix in a file the model just read is a different risk
 *   from a 50-replacement rewrite. A later phase defines the
 *   exact rule when the gate is ordered
 *   (replacement count/size, target sensitivity); the registry
 *   only records that the decision is per-call, plus the factors
 *   in `confirmationNote`.
 * - "none": the gate never prompts. Read-only tools (any risk —
 *   including skill at medium) and low-risk mutating state
 *   (write_todos) are "none": not every mutating tool is
 *   dangerous, and not every read-only tool is free of risk, but
 *   confirmation is keyed to risk, and low/medium do not prompt.
 *
 * The gate itself is NOT implemented here — Fase 8 was ordered
 * without a confirmation workflow. --yolo (a later phase, when
 * ordered)
 * may skip the interactive prompt for "required"/"scoped" tools,
 * but NEVER the sandbox, security policy, input validation, or
 * credential protection.
 */
export type ConfirmationPolicy = "required" | "scoped" | "none";

/** Effect classification — the Fase 4 orchestrator's parallelism
 *  rule reads this: "read-only" may run in parallel when
 *  dependency-free; "mutating" is always sequential. */
export type ToolEffect = "read-only" | "mutating";

/** What kind of thing the tool operates on. Used by the loop for
 *  classification that used to be hardcoded tool-name checks
 *  (file-edit loop guard, todo-loop recovery note). */
export type ToolCategory =
  | "filesystem"
  | "shell"
  | "search"
  | "state"
  | "control"
  | "interaction"
  | "knowledge";

// ---------------------------------------------------------------------------
// JSON Schema (MCP-shaped subset, no Zod dependency)
// ---------------------------------------------------------------------------

export type JsonSchemaType = "string" | "number" | "boolean" | "array" | "object";

export interface JsonSchemaProperty {
  type: JsonSchemaType;
  description?: string;
  enum?: string[];
  minLength?: number;
  minItems?: number;
  minimum?: number;
  maximum?: number;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface ToolInputSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  /** Handlers ignore unknown keys, so the default is true. No tool
   *  in this phase sets false. */
  additionalProperties?: boolean;
}

/** Output schema: every tool returns a ToolResult
 *  {ok: boolean, output: string, askUserQuestions?}. ask_user is
 *  the only tool whose result carries askUserQuestions. */
export interface ToolOutputSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
}

const TOOL_RESULT_OUTPUT_SCHEMA: ToolOutputSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean", description: "Whether the tool call succeeded." },
    output: { type: "string", description: "Text returned to the model as the tool message." },
  },
  required: ["ok", "output"],
};

const ASK_USER_OUTPUT_SCHEMA: ToolOutputSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean", description: "Whether the tool call succeeded." },
    output: { type: "string", description: "Text returned to the model as the tool message." },
    askUserQuestions: {
      type: "array",
      description: "Questions to show the user; the turn pauses until answered.",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
        },
        required: ["question"],
      },
    },
  },
  required: ["ok", "output"],
};

// ---------------------------------------------------------------------------
// Registered tool
// ---------------------------------------------------------------------------

export interface RegisteredTool {
  /** Unique ID. For the 11 local tools the ID is the tool name
   *  (names are unique by construction — enforced by a test). */
  id: string;
  name: string;
  /** Description shown to the model — the factory's description,
   *  referenced, not duplicated (one source of truth). */
  description: string;
  inputSchema: ToolInputSchema;
  outputSchema: ToolOutputSchema;
  permission: ToolPermission;
  risk: ToolRisk;
  effect: ToolEffect;
  category: ToolCategory;
  /** Derived from risk (Keputusan Reza 1 + Klarifikasi 2026-11-10):
   *  true when `confirmationPolicy` is "required" or "scoped" —
   *  i.e. the confirmation gate (when ordered) must prompt (or
   *  evaluate the call) before
   *  executing. In Fase 3 this was true exactly for risk
   *  "critical"; the 2026-11-10 clarification extends it to high
   *  file writes (write_file: "required") and scope-evaluated edits
   *  (str_replace: "scoped"). The gate itself lives in a later
   *  phase (when ordered); --yolo (then) may skip the interactive
   *  prompt but NEVER this
   *  metadata, the sandbox, validation, or credential protection. */
  requiresConfirmation: boolean;
  /** What the confirmation gate (when ordered) must do for this
   *  tool (see
   *  ConfirmationPolicy). The authoritative policy field;
   *  `requiresConfirmation` is its boolean shortcut. */
  confirmationPolicy: ConfirmationPolicy;
  /** How a "scoped" policy is evaluated (factors the
   *  confirmation gate reads). Set only for "scoped" tools. */
  confirmationNote?: string;
  /** Default execution timeout in ms. Undefined = synchronous tool
   *  with no timeout (bounded by result limits instead). */
  timeoutMs?: number;
  /** Hard ceiling for timeoutMs (shell only: -1 = no timeout, the
   *  Freebuff sentinel; the handler clamps to this ceiling). */
  maxTimeoutMs?: number;
  /** Output cap in chars (TOOL_OUTPUT_LIMIT, applied to every
   *  result by the handlers). */
  outputLimitChars: number;
  /** Max items returned in one call, when the tool caps results. */
  maxResults?: number;
  /** Max lines returned per file (read_files window). */
  maxLinesPerFile?: number;
  /** Freebuff endsAgentStep: when true, the step ends after this
   *  tool's result — the loop must not execute further tool calls
   *  from the same model response. Only `skill` sets it. */
  endsAgentStep?: boolean;
  /** Execution handler — the EXISTING handler from tools.ts. */
  handler: ToolDefinition["execute"];
}

// Metadata table: everything the factories do NOT already carry.
// name/description/handler come from the factory at build time.
type ToolMetadata = Omit<RegisteredTool, "id" | "name" | "description" | "requiresConfirmation" | "handler">;

const TOOL_METADATA: Record<string, ToolMetadata> = {
  read_files: {
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          description: "Paths relative to the project folder.",
          items: { type: "string" },
          minItems: 1,
        },
        start_line: { type: "number", description: "1-based first line.", minimum: 1 },
        end_line: { type: "number", description: "1-based last line, 0 = windowed default.", minimum: 0 },
      },
      required: ["paths"],
    },
    outputSchema: TOOL_RESULT_OUTPUT_SCHEMA,
    permission: "read",
    risk: "low",
    effect: "read-only",
    category: "filesystem",
    confirmationPolicy: "none",
    outputLimitChars: TOOL_OUTPUT_LIMIT,
    maxLinesPerFile: 2000,
  },
  list_directory: {
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory relative to the project folder (default: project root)." },
      },
    },
    outputSchema: TOOL_RESULT_OUTPUT_SCHEMA,
    permission: "read",
    risk: "low",
    effect: "read-only",
    category: "filesystem",
    confirmationPolicy: "none",
    outputLimitChars: TOOL_OUTPUT_LIMIT,
  },
  glob: {
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. \"src/**/*.ts\".", minLength: 1 },
      },
      required: ["pattern"],
    },
    outputSchema: TOOL_RESULT_OUTPUT_SCHEMA,
    permission: "read",
    risk: "low",
    effect: "read-only",
    category: "search",
    confirmationPolicy: "none",
    outputLimitChars: TOOL_OUTPUT_LIMIT,
    maxResults: 200,
  },
  code_search: {
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Plain text or /regex/flags.", minLength: 1 },
        path: { type: "string", description: "File or directory relative to the project folder (default: project root)." },
      },
      required: ["pattern"],
    },
    outputSchema: TOOL_RESULT_OUTPUT_SCHEMA,
    permission: "read",
    risk: "low",
    effect: "read-only",
    category: "search",
    confirmationPolicy: "none",
    outputLimitChars: TOOL_OUTPUT_LIMIT,
    maxResults: 50,
  },
  str_replace: {
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File relative to the project folder.", minLength: 1 },
        replacements: {
          type: "array",
          description:
            "Replacements to apply. Each item: {oldString, newString, allowMultiple?}. Alias keys are accepted by the handler (old/old_str/old_string, new/new_str/new_string/replacement); a single replacement may also be given top-level as {path, oldString, newString}.",
          items: {
            type: "object",
            properties: {
              oldString: { type: "string", minLength: 1 },
              newString: { type: "string" },
              allowMultiple: { type: "boolean" },
            },
          },
        },
        oldString: { type: "string", description: "Single-replacement lift: top-level oldString.", minLength: 1 },
        newString: { type: "string", description: "Single-replacement lift: top-level newString." },
      },
      required: ["path"],
    },
    outputSchema: TOOL_RESULT_OUTPUT_SCHEMA,
    permission: "write",
    risk: "high",
    effect: "mutating",
    category: "filesystem",
    confirmationPolicy: "scoped",
    confirmationNote: "Evaluate the call scope: number of replacements, total changed characters, and whether the target file is sensitive (e.g. credentials, keys, config outside the project). A later phase defines the exact rule when the gate is ordered.",
    outputLimitChars: TOOL_OUTPUT_LIMIT,
  },
  write_file: {
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File relative to the project folder.", minLength: 1 },
        content: { type: "string", description: "Full file content (the handler requires a non-empty string).", minLength: 1 },
      },
      required: ["path", "content"],
    },
    outputSchema: TOOL_RESULT_OUTPUT_SCHEMA,
    permission: "write",
    risk: "high",
    effect: "mutating",
    category: "filesystem",
    confirmationPolicy: "required",
    outputLimitChars: TOOL_OUTPUT_LIMIT,
  },
  run_terminal_command: {
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command (bash -c) run in the project folder.", minLength: 1 },
        timeout_seconds: {
          type: "number",
          description: "Default 120, max 600, -1 = no timeout (Freebuff sentinel).",
          minimum: -1,
          maximum: MAX_TERMINAL_TIMEOUT_SECONDS,
        },
        cwd: { type: "string", description: "Working directory, must stay inside the project folder." },
      },
      required: ["command"],
    },
    outputSchema: TOOL_RESULT_OUTPUT_SCHEMA,
    permission: "execute",
    risk: "critical",
    effect: "mutating",
    category: "shell",
    confirmationPolicy: "required",
    timeoutMs: 120_000,
    maxTimeoutMs: MAX_TERMINAL_TIMEOUT_SECONDS * 1000,
    outputLimitChars: TOOL_OUTPUT_LIMIT,
  },
  write_todos: {
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The FULL to-do list (this call replaces it; an empty list clears it).",
          items: {
            type: "object",
            properties: {
              task: { type: "string", minLength: 1 },
              completed: { type: "boolean" },
            },
            required: ["task"],
          },
        },
      },
      required: ["todos"],
    },
    outputSchema: TOOL_RESULT_OUTPUT_SCHEMA,
    permission: "write",
    risk: "low",
    effect: "mutating",
    category: "state",
    confirmationPolicy: "none",
    outputLimitChars: TOOL_OUTPUT_LIMIT,
  },
  task_completed: {
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Optional one-line summary of what was done." },
      },
    },
    outputSchema: TOOL_RESULT_OUTPUT_SCHEMA,
    permission: "read",
    risk: "low",
    effect: "read-only",
    category: "control",
    confirmationPolicy: "none",
    outputLimitChars: TOOL_OUTPUT_LIMIT,
  },
  ask_user: {
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "Questions to ask the user; the turn pauses until answered.",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              question: { type: "string", minLength: 1 },
              options: { type: "array", items: { type: "string" } },
            },
            required: ["question"],
          },
        },
      },
      required: ["questions"],
    },
    outputSchema: ASK_USER_OUTPUT_SCHEMA,
    permission: "ask",
    risk: "low",
    effect: "read-only",
    category: "interaction",
    confirmationPolicy: "none",
    outputLimitChars: TOOL_OUTPUT_LIMIT,
  },
  skill: {
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name (SKILL.md), discovered in .agents/skills/ and ~/.config/metatech/skills/.", minLength: 1 },
      },
      required: ["name"],
    },
    outputSchema: TOOL_RESULT_OUTPUT_SCHEMA,
    permission: "read",
    risk: "medium",
    effect: "read-only",
    category: "knowledge",
    confirmationPolicy: "none",
    outputLimitChars: TOOL_OUTPUT_LIMIT,
    endsAgentStep: true,
  },
};

// ---------------------------------------------------------------------------
// Registry build (lazy, cached, fail-fast on drift)
// ---------------------------------------------------------------------------

let cachedRegistry: RegisteredTool[] | null = null;

function buildRegistry(): RegisteredTool[] {
  const defs = allToolDefinitions();
  const seen = new Set<string>();
  const out: RegisteredTool[] = [];
  for (const def of defs) {
    if (seen.has(def.name)) throw new Error(`tool registry: duplicate tool name: ${def.name}`);
    seen.add(def.name);
    const meta = TOOL_METADATA[def.name];
    if (!meta) throw new Error(`tool registry: tool "${def.name}" has no metadata entry — add it to TOOL_METADATA`);
    out.push({
      id: def.name,
      name: def.name,
      description: def.description,
      ...meta,
      // endsAgentStep lives on the factory (skill); the table only
      // repeats it for readability — the factory wins.
      endsAgentStep: def.endsAgentStep ?? meta.endsAgentStep,
      requiresConfirmation: meta.confirmationPolicy !== "none",
      handler: def.execute,
    });
  }
  for (const name of Object.keys(TOOL_METADATA)) {
    if (!seen.has(name)) {
      throw new Error(`tool registry: metadata entry "${name}" has no matching tool factory — remove it or add the tool`);
    }
  }
  return out;
}

/** All registered tools, in factory order. */
export function listRegisteredTools(): RegisteredTool[] {
  if (!cachedRegistry) cachedRegistry = buildRegistry();
  return cachedRegistry;
}

/** Look up one tool by name; undefined when unknown. */
export function getRegisteredTool(name: string): RegisteredTool | undefined {
  return listRegisteredTools().find((t) => t.name === name);
}

/** Tool names in registry order. */
export function registeredToolNames(): string[] {
  return listRegisteredTools().map((t) => t.name);
}

// ---------------------------------------------------------------------------
// Classification helpers (the loop reads these, not hardcoded names)
// ---------------------------------------------------------------------------

export function isReadOnlyTool(name: string): boolean {
  return getRegisteredTool(name)?.effect === "read-only";
}

export function isMutatingTool(name: string): boolean {
  return getRegisteredTool(name)?.effect === "mutating";
}

/** File-edit tools (write_file, str_replace): filesystem category +
 *  write permission. Used by the loop's failed-edit guard and the
 *  todo-loop recovery note — previously hardcoded name checks. */
export function isFileEditTool(name: string): boolean {
  const t = getRegisteredTool(name);
  return t !== undefined && t.category === "filesystem" && t.permission === "write";
}

/** Whether a call to this tool requires the confirmation gate
 *  (when ordered). True when `confirmationPolicy` is "required" or "scoped"
 *  (Klarifikasi Reza 2026-11-10): run_terminal_command (critical)
 *  and write_file (high, whole-file) are "required"; str_replace
 *  (high, spans) is "scoped" — the gate evaluates the call scope.
 *  The gate itself is NOT implemented here — this is metadata only.
 *  --yolo (a later phase, when ordered) may skip the interactive
 *  prompt, never the
 *  security policy, sandbox, validation, or credential protection. */
export function toolRequiresConfirmation(name: string): boolean {
  return getRegisteredTool(name)?.requiresConfirmation === true;
}

/** The confirmation policy for one tool ("required" | "scoped" |
 *  "none"). The authoritative field for the confirmation gate
 *  (when ordered). */
export function confirmationPolicyFor(name: string): ConfirmationPolicy | undefined {
  return getRegisteredTool(name)?.confirmationPolicy;
}

/** Tools that require the confirmation gate (critical risk only). */
export function toolsRequiringConfirmation(): RegisteredTool[] {
  return listRegisteredTools().filter((t) => t.requiresConfirmation);
}

// ---------------------------------------------------------------------------
// Input validation against the JSON Schema (MCP-shaped subset)
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Detail-only type check for one node (no path in the message).
 *  Child errors are returned already path-qualified by validateValue
 *  / validateObject, so this function never adds a prefix itself. */
function typeDetail(schema: JsonSchemaProperty, value: unknown): string | null {
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") return `expected string, got ${typeof value}`;
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        return `string shorter than minLength ${schema.minLength}`;
      }
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return `expected number, got ${typeof value}`;
      if (schema.minimum !== undefined && value < schema.minimum) return `number ${value} below minimum ${schema.minimum}`;
      if (schema.maximum !== undefined && value > schema.maximum) return `number ${value} above maximum ${schema.maximum}`;
      break;
    case "boolean":
      if (typeof value !== "boolean") return `expected boolean, got ${typeof value}`;
      break;
    case "array":
      if (!Array.isArray(value)) return `expected array, got ${typeof value}`;
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        return `array shorter than minItems ${schema.minItems}`;
      }
      break;
    case "object":
      if (!isPlainObject(value)) return `expected object, got ${Array.isArray(value) ? "array" : typeof value}`;
      break;
  }
  if (schema.enum && !schema.enum.includes(value as string)) {
    return `value not in enum: ${JSON.stringify(schema.enum)}`;
  }
  return null;
}

/** Validate one value; the returned error is path-qualified. */
function validateValue(schema: JsonSchemaProperty, value: unknown, path: string): string | null {
  const detail = typeDetail(schema, value);
  if (detail) return `${path || "value"}: ${detail}`;
  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const err = validateValue(schema.items, value[i], `${path}[${i}]`);
      if (err) return err;
    }
  }
  if (schema.type === "object" && isPlainObject(value)) {
    return validateObject(schema, value, path);
  }
  return null;
}

function validateObject(schema: { properties?: Record<string, JsonSchemaProperty>; required?: string[]; additionalProperties?: boolean }, input: Record<string, unknown>, path: string): string | null {
  const at = (key: string): string => (path ? `${path}.${key}` : key);
  for (const key of schema.required ?? []) {
    if (input[key] === undefined) return `${at(key)}: missing required param`;
  }
  for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
    const value = input[key];
    if (value === undefined) continue;
    const err = validateValue(propSchema, value, at(key));
    if (err) return err;
  }
  if (schema.additionalProperties === false) {
    const known = new Set(Object.keys(schema.properties ?? {}));
    for (const key of Object.keys(input)) {
      if (!known.has(key)) return `${at(key)}: unexpected param`;
    }
  }
  return null;
}

/**
 * Validate a tool call's input against the registered input schema.
 * Returns null when valid, otherwise a human-readable error string
 * (returned to the model as a tool error result, same channel as
 * handler validation errors — the model can fix and retry).
 *
 * Mirrors the hand validators in tools.ts: it rejects only missing
 * required params and wrong types. Unknown extra keys are ignored
 * (handlers ignore them too) and str_replace alias keys pass —
 * the alias-aware handler remains the enforcer for aliases.
 */
export function validateToolInput(entry: RegisteredTool, input: Record<string, unknown>): string | null {
  if (!isPlainObject(input)) return `${entry.name}: input must be an object`;
  const err = validateObject(entry.inputSchema, input, "");
  return err ? `${entry.name}: ${err}` : null;
}

// ---------------------------------------------------------------------------
// Native tool format (later-phase consumer; derived data, no behavior)
// ---------------------------------------------------------------------------

/**
 * OpenAI function-tool format: the shape the panel relay forwards
 * to providers (`tools: [{type: "function", function: {name,
 * description, parameters}}]`). Named so the Fase 2 adapter
 * contract can reference it without duplicating the shape.
 */
export interface OpenAiFunctionTool {
  type: "function";
  function: { name: string; description: string; parameters: ToolInputSchema };
}

/**
 * Convert a registered tool to the OpenAI function-tool format the
 * panel relay forwards to providers (`tools: [{type: "function",
 * function: {name, description, parameters}}]`). The relay already
 * accepts this shape (audit Fase 1 §4); the CLI does not send it
 * yet — a later phase wires it in as an additional path beside XML.
 */
export function toOpenAiFunction(entry: RegisteredTool): OpenAiFunctionTool {
  return {
    type: "function",
    function: {
      name: entry.name,
      description: entry.description,
      parameters: entry.inputSchema,
    },
  };
}

/** Re-export for tests/consumers that want the handler result type. */
export type { ToolResult };
