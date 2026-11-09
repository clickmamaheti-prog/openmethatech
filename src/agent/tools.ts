// Minimal coding-agent toolset for the MethaTech CLI.
//
// Tool names and semantics follow Freebuff (Apache-2.0), from
//   common/src/tools/constants.ts (toolNames)
//   common/src/tools/params/tool/*.ts (one Zod schema per tool)
//   packages/agent-runtime/src/tools/handlers/tool/*.ts
// The subset here is the Fase 0 set from AGENT-ADOPTION.md §9.2:
// read_files, list_directory, glob, code_search, str_replace,
// write_file, run_terminal_command, write_todos, task_completed,
// ask_user, skill.
//
// MethaTech differences:
// - No Zod dependency: each tool validates its input by hand with the
//   same required/optional rules (a "Zod or equivalent" schema).
// - All tools run LOCALLY in the CLI (Freebuff splits server/client
//   execution; MethaTech has no agent runtime on the panel, so there
//   is no server side at all — AGENT-ADOPTION.md §2.3).
// - Every tool is sandboxed to the project folder (base3 rule "Stay
//   inside the project folder"): absolute paths outside cwd are
//   rejected, `..` escapes are rejected.
// - Tools run directly, like Freebuff: no confirmation gate (the
//   SDK executes shell/file tools without asking the user first).
// - Shell output cap 50,000 chars head+tail (Freebuff
//   COMMAND_OUTPUT_LIMIT), timeout clamp max 600s, SIGTERM→SIGKILL
//   escalation after 1500ms (Freebuff sdk run-terminal-command).

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { discoverSkills, formatAvailableSkillsXml, loadSkill } from "./skills.js";

export const TOOL_OUTPUT_LIMIT = 50_000;
export const MAX_TERMINAL_TIMEOUT_SECONDS = 600;

// ---------------------------------------------------------------------------
// Validation helpers (hand-rolled equivalent of the per-tool Zod schemas)
// ---------------------------------------------------------------------------

type Valid<T> = { ok: true; value: T } | { ok: false; error: string };

function reqString(input: Record<string, unknown>, key: string): Valid<string> {
  const v = input[key];
  if (typeof v !== "string" || v.length === 0) return { ok: false, error: `missing or empty string param: ${key}` };
  return { ok: true, value: v };
}

function optString(input: Record<string, unknown>, key: string, fallback: string | undefined = undefined): string | undefined {
  const v = input[key];
  return typeof v === "string" ? v : fallback;
}

function optNumber(input: Record<string, unknown>, key: string, fallback: number): number {
  const v = input[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function reqStringArray(input: Record<string, unknown>, key: string): Valid<string[]> {
  const v = input[key];
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "string")) {
    return { ok: false, error: `missing or invalid string array param: ${key}` };
  }
  return { ok: true, value: v as string[] };
}

// ---------------------------------------------------------------------------
// Path sandbox
// ---------------------------------------------------------------------------

/** Resolve `p` inside `cwd`; null when it escapes the project folder. */
export function resolveInside(cwd: string, p: string): string | null {
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.normalize(path.join(cwd, p));
  const root = path.normalize(cwd);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function capOutput(text: string): string {
  if (text.length <= TOOL_OUTPUT_LIMIT) return text;
  const half = Math.floor(TOOL_OUTPUT_LIMIT / 2);
  return `${text.slice(0, half)}\n… [output truncated, ${text.length} chars total] …\n${text.slice(-half)}`;
}

// ---------------------------------------------------------------------------
// Tool context + results
// ---------------------------------------------------------------------------

/**
 * To-do item — Freebuff shape (cli/src/utils/todos.ts, 37 lines):
 * `{task: string, completed: boolean}`. No id, no status enum, no
 * in_progress/cancelled. Each write_todos call REPLACES the whole
 * list; an empty list clears it.
 */
export interface TodoItem {
  task: string;
  completed: boolean;
}

export interface ToolContext {
  cwd: string;
  /** Current to-do list, mutated by write_todos. */
  todos: TodoItem[];
  /** Called whenever write_todos changes the list (TUI live progress). */
  onTodos?: (todos: TodoItem[]) => void;
  /** True when the caller is the model (skill disable-model-invocation). */
  invokedByModel: boolean;
  /** Tool names available in the current mode (for the write_todos
      no-file-edit-tools note in Plan mode). */
  toolNames?: string[];
}

export interface ToolResult {
  ok: boolean;
  /** Text returned to the model as the tool message. */
  output: string;
  /** ask_user: the turn must pause for the user's answers. */
  askUserQuestions?: { question: string; options?: string[] }[];
}

function okResult(output: string): ToolResult {
  return { ok: true, output: capOutput(output) };
}

function errResult(output: string): ToolResult {
  return { ok: false, output: capOutput(output) };
}

// ---------------------------------------------------------------------------
// Tool definitions (name, description shown to the model, validator)
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  /**
   * Freebuff endsAgentStep (common/src/tools/constants.ts: the
   * `cb_easp` marker): when true, this tool ends the current agent
   * step after its result — the loop must not execute further tool
   * calls from the same model response. Freebuff sets it for `skill`.
   */
  endsAgentStep?: boolean;
  execute: (ctx: ToolContext, input: Record<string, unknown>) => Promise<ToolResult>;
}

function readFilesTool(): ToolDefinition {
  return {
    name: "read_files",
    description:
      "Read one or more files. Params: {paths: string[] (paths relative to the project folder), start_line?: number (1-based), end_line?: number}. Returns the file contents with line numbers. Large files are windowed — read a slice, not the whole file.",
    execute: async (ctx, input) => {
      const paths = reqStringArray(input, "paths");
      if (!paths.ok) return errResult(paths.error);
      const startLine = Math.max(1, Math.floor(optNumber(input, "start_line", 1)));
      const endLine = optNumber(input, "end_line", 0);
      const out: string[] = [];
      for (const p of paths.value) {
        const abs = resolveInside(ctx.cwd, p);
        if (!abs) return errResult(`read_files: path outside the project folder: ${p}`);
        let raw: string;
        try {
          raw = fs.readFileSync(abs, "utf-8");
        } catch (e) {
          return errResult(`read_files: cannot read ${p}: ${(e as Error).message}`);
        }
        const lines = raw.split("\n");
        const end = endLine > 0 ? Math.min(endLine, lines.length) : Math.min(lines.length, startLine + 1999);
        const slice = lines.slice(startLine - 1, end);
        out.push(
          `--- ${p} (lines ${startLine}-${startLine + slice.length - 1} of ${lines.length}) ---\n` +
            slice.map((l, i) => `${startLine + i}: ${l}`).join("\n"),
        );
      }
      return okResult(out.join("\n\n"));
    },
  };
}

function listDirectoryTool(): ToolDefinition {
  return {
    name: "list_directory",
    description:
      "List a directory. Params: {path?: string (default: project root)}. Returns entries with a trailing / for directories.",
    execute: async (ctx, input) => {
      const rel = optString(input, "path", ".") ?? ".";
      const abs = resolveInside(ctx.cwd, rel);
      if (!abs) return errResult(`list_directory: path outside the project folder: ${rel}`);
      try {
        const entries = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        return okResult(entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n") || "(empty directory)");
      } catch (e) {
        return errResult(`list_directory: cannot list ${rel}: ${(e as Error).message}`);
      }
    },
  };
}

/** Convert a small glob (**, *, ?) to a RegExp over slash paths. */
export function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** matches any number of path segments (incl. none).
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else if ("+|()^${}.[]\\".includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(re + "$");
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "target", "vendor", "__pycache__"]);

function walkFiles(dir: string, out: string[], base: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".agents") {
      if (SKIP_DIRS.has(e.name)) continue;
    }
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, out, base);
    else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join("/"));
  }
}

function globTool(): ToolDefinition {
  return {
    name: "glob",
    description:
      "Find files by glob pattern. Params: {pattern: string, e.g. \"src/**/*.ts\"}. Returns matching paths, at most 200.",
    execute: async (ctx, input) => {
      const pattern = reqString(input, "pattern");
      if (!pattern.ok) return errResult(pattern.error);
      const re = globToRegExp(pattern.value);
      const all: string[] = [];
      walkFiles(ctx.cwd, all, ctx.cwd);
      const matches = all.filter((f) => re.test(f)).slice(0, 200);
      return okResult(matches.length > 0 ? matches.join("\n") : "(no files matched)");
    },
  };
}

function codeSearchTool(): ToolDefinition {
  return {
    name: "code_search",
    description:
      "Search file contents for text. Params: {pattern: string (plain text or /regex/flags), path?: string (default: project root)}. Returns file:line matches, at most 50. Skips node_modules, .git, dist.",
    execute: async (ctx, input) => {
      const pattern = reqString(input, "pattern");
      if (!pattern.ok) return errResult(pattern.error);
      const rel = optString(input, "path", ".") ?? ".";
      const start = resolveInside(ctx.cwd, rel);
      if (!start) return errResult(`code_search: path outside the project folder: ${rel}`);
      let re: RegExp;
      const m = pattern.value.match(/^\/(.+)\/([gimsuy]*)$/);
      try {
        re = m ? new RegExp(m[1] as string, (m[2] ?? "") || undefined) : new RegExp(escapeRegExp(pattern.value));
      } catch {
        return errResult(`code_search: invalid regex: ${pattern.value}`);
      }
      const relFiles: string[] = [];
      if (fs.existsSync(start) && fs.statSync(start).isFile()) {
        relFiles.push(path.relative(ctx.cwd, start).split(path.sep).join("/"));
      } else if (fs.existsSync(start) && fs.statSync(start).isDirectory()) {
        walkFiles(start, relFiles, ctx.cwd);
      } else {
        return errResult(`code_search: path not found: ${rel}`);
      }
      const hits: string[] = [];
      for (const relFile of relFiles) {
        const abs = path.join(ctx.cwd, relFile);
        let raw: string;
        try {
          raw = fs.readFileSync(abs, "utf-8");
        } catch {
          continue;
        }
        if (raw.includes("\0")) continue; // binary
        const lines = raw.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i] as string)) {
            hits.push(`${relFile}:${i + 1}: ${(lines[i] as string).trim()}`);
            if (hits.length >= 50) return okResult(hits.join("\n"));
          }
        }
      }
      return okResult(hits.length > 0 ? hits.join("\n") : "(no matches)");
    },
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeFileTool(): ToolDefinition {
  return {
    name: "write_file",
    description:
      "Create or overwrite a file. Params: {path: string, content: string}.",
    execute: async (ctx, input) => {
      const p = reqString(input, "path");
      const content = reqString(input, "content");
      if (!p.ok) return errResult(p.error);
      if (!content.ok) return errResult(content.error);
      const abs = resolveInside(ctx.cwd, p.value);
      if (!abs) return errResult(`write_file: path outside the project folder: ${p.value}`);
      const oldContent = fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : null;
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content.value, "utf-8");
      } catch (e) {
        return errResult(`write_file: cannot write ${p.value}: ${(e as Error).message}`);
      }
      return okResult(oldContent === null ? `created ${p.value}` : `wrote ${p.value}`);
    },
  };
}

function strReplaceTool(): ToolDefinition {
  return {
    name: "str_replace",
    description:
      "Replace one or more exact text spans in a file. Params: {path: string, replacements: [{oldString: string, newString: string, allowMultiple?: boolean (default false)}]}. A single replacement may also be given top-level as {path, oldString, newString}. If you are making multiple edits in a row to a file, use only one str_replace call with multiple replacements instead of multiple str_replace tool calls. Each oldString must match exactly once unless allowMultiple is true.",
    execute: async (ctx, input) => {
      const p = reqString(input, "path");
      if (!p.ok) return errResult(p.error);
      // Freebuff normalizeReplacementAliases (common/src/tools/params/
      // utils.ts): oldString ← old, old_str, old_string; newString ←
      // new, new_str, new_string, replacement. liftSingleReplacement:
      // top-level {path, oldString, newString} lifts into replacements.
      const pick = (rec: Record<string, unknown>, keys: string[]): unknown => {
        for (const k of keys) if (rec[k] !== undefined) return rec[k];
        return undefined;
      };
      const normalizeOne = (rec: Record<string, unknown>): { oldString: string; newString: string; allowMultiple: boolean } | string => {
        const oldString = pick(rec, ["oldString", "old", "old_str", "old_string"]);
        const newString = pick(rec, ["newString", "new", "new_str", "new_string", "replacement"]);
        if (typeof oldString !== "string" || oldString.length === 0) return "str_replace: each replacement needs a non-empty oldString";
        if (typeof newString !== "string") return "str_replace: each replacement needs a newString";
        const allowMultiple = rec.allowMultiple === true;
        return { oldString, newString, allowMultiple };
      };
      const replacements: { oldString: string; newString: string; allowMultiple: boolean }[] = [];
      if (Array.isArray(input.replacements)) {
        for (const [i, r] of (input.replacements as unknown[]).entries()) {
          if (typeof r !== "object" || r === null) return errResult(`str_replace: replacement ${i} is not an object`);
          const n = normalizeOne(r as Record<string, unknown>);
          if (typeof n === "string") return errResult(`str_replace: replacement ${i}: ${n}`);
          replacements.push(n);
        }
      } else if (input.replacements !== undefined) {
        return errResult("str_replace: replacements must be an array");
      } else {
        // Single-replacement lift.
        const n = normalizeOne(input);
        if (typeof n === "string") return errResult(n);
        replacements.push(n);
      }
      if (replacements.length === 0) return errResult("str_replace: no replacements given");
      const abs = resolveInside(ctx.cwd, p.value);
      if (!abs) return errResult(`str_replace: path outside the project folder: ${p.value}`);
      let raw: string;
      try {
        raw = fs.readFileSync(abs, "utf-8");
      } catch (e) {
        return errResult(`str_replace: cannot read ${p.value}: ${(e as Error).message}`);
      }
      // Validate ALL replacements first so a failing call writes
      // nothing (Freebuff returns {file, errorMessage} on failure).
      let next = raw;
      for (const [i, r] of replacements.entries()) {
        const occurrences = next.split(r.oldString).length - 1;
        if (occurrences === 0) return errResult(`str_replace: replacement ${i} oldString not found in ${p.value}`);
        if (occurrences > 1 && !r.allowMultiple) {
          return errResult(
            `str_replace: replacement ${i} oldString matches ${occurrences} times in ${p.value} — make it unique or set allowMultiple: true`,
          );
        }
        next = r.allowMultiple ? next.split(r.oldString).join(r.newString) : next.replace(r.oldString, r.newString);
      }
      try {
        fs.writeFileSync(abs, next, "utf-8");
      } catch (e) {
        return errResult(`str_replace: cannot write ${p.value}: ${(e as Error).message}`);
      }
      return okResult(`edited ${p.value} (${replacements.length} replacement${replacements.length > 1 ? "s" : ""})`);
    },
  };
}

function clampTimeoutSeconds(raw: number): number | null {
  if (raw === -1) return null; // Freebuff sentinel: no timeout
  return Math.min(MAX_TERMINAL_TIMEOUT_SECONDS, Math.max(1, Math.floor(raw)));
}

function runTerminalCommandTool(): ToolDefinition {
  return {
    name: "run_terminal_command",
    description:
      "Run a shell command in the project folder (bash). Params: {command: string, timeout_seconds?: number (default 120, max 600, -1 = no timeout), cwd?: string (must stay inside the project folder)}. Returns {command, stdout, stderr, exitCode}.",
    execute: async (ctx, input) => {
      const command = reqString(input, "command");
      if (!command.ok) return errResult(command.error);
      const relCwd = optString(input, "cwd", ".") ?? ".";
      const cwd = resolveInside(ctx.cwd, relCwd);
      if (!cwd) return errResult(`run_terminal_command: cwd outside the project folder: ${relCwd}`);
      const timeoutMs = (() => {
        const t = clampTimeoutSeconds(optNumber(input, "timeout_seconds", 120));
        return t === null ? null : t * 1000;
      })();
      return new Promise<ToolResult>((resolve) => {
        const child = spawn("bash", ["-c", command.value], { cwd, shell: false });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (result: ToolResult) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        const timer =
          timeoutMs === null
            ? null
            : setTimeout(() => {
                child.kill("SIGTERM");
                setTimeout(() => child.kill("SIGKILL"), 1500);
              }, timeoutMs);
        child.stdout.on("data", (d: Buffer) => {
          stdout += d.toString("utf-8");
        });
        child.stderr.on("data", (d: Buffer) => {
          stderr += d.toString("utf-8");
        });
        child.on("error", (e) => {
          if (timer) clearTimeout(timer);
          finish(errResult(JSON.stringify({ command: command.value, errorMessage: e.message })));
        });
        child.on("close", (code) => {
          if (timer) clearTimeout(timer);
          finish(
            okResult(
              JSON.stringify({
                command: command.value,
                startingCwd: cwd,
                stdout: capOutput(stdout),
                stderr: capOutput(stderr),
                exitCode: code ?? -1,
              }),
            ),
          );
        });
      });
    },
  };
}

function writeTodosTool(): ToolDefinition {
  return {
    name: "write_todos",
    description:
      "Create and manage a structured task list. Params: {todos: [{task: string, completed?: boolean (default false)}]}. Use this tool to create a task list when the user asks for help with a larger task, and keep it updated as you complete tasks. The todos list must contain ALL the tasks that the user needs to complete, including any tasks that were previously added to the list. This tool REPLACES the entire list — always include the full list, marking completed tasks with completed: true. An empty list clears the to-dos.",
    execute: async (ctx, input) => {
      const v = input.todos;
      if (!Array.isArray(v)) return errResult("write_todos: missing todos array");
      const items: TodoItem[] = [];
      for (const [i, t] of v.entries()) {
        if (typeof t !== "object" || t === null) return errResult(`write_todos: item ${i} is not an object`);
        const rec = t as Record<string, unknown>;
        if (typeof rec.task !== "string" || rec.task.length === 0) {
          return errResult(`write_todos: item ${i} needs a non-empty task`);
        }
        if (rec.completed !== undefined && typeof rec.completed !== "boolean") {
          return errResult(`write_todos: item ${i} completed must be a boolean`);
        }
        items.push({ task: rec.task, completed: rec.completed === true });
      }
      // A malformed item above already returned an error, so the old
      // list survives (Freebuff getLatestTodos: malformed input does
      // NOT replace the list).
      // Freebuff todo-loop.ts WRITE_TODOS_UNCHANGED_MESSAGE: re-sending
      // the already-recorded list is a no-op, and saying so right away
      // is the point — a generic "Todos written" reads as success and
      // rewards a model stuck re-sending the same list.
      const sameList =
        items.length === ctx.todos.length &&
        items.every((it, i) => it.task === ctx.todos[i]?.task && it.completed === ctx.todos[i]?.completed);
      if (sameList) {
        return okResult(writeTodosUnchangedMessage(ctx.toolNames ?? []));
      }
      ctx.todos.splice(0, ctx.todos.length, ...items);
      ctx.onTodos?.(ctx.todos);
      return okResult(`todos updated (${items.length} items)`);
    },
  };
}

/** Freebuff todo-loop.ts FILE_EDIT_TOOLS_UNAVAILABLE_NOTE, adapted:
 * MethaTech has no apply_patch, so only write_file and str_replace
 * are named. Appended to the todo-loop recovery / unchanged messages
 * when the mode has no file-edit tools (e.g. Plan). */
export const FILE_EDIT_TOOLS_UNAVAILABLE_NOTE =
  " File-editing tools (write_file, str_replace) are not available to you right now, so do not call write_todos in their place. If the next task needs a file edit, tell the user and end your turn.";

/** Freebuff todo-loop.ts WRITE_TODOS_UNCHANGED_MESSAGE (+ the
 * FILE_EDIT_TOOLS_UNAVAILABLE_NOTE when the mode has no file-edit
 * tools, e.g. Plan). */
export function writeTodosUnchangedMessage(toolNames: readonly string[]): string {
  const base =
    "To-do list unchanged: it is already recorded, so this call did nothing. Do not call write_todos again until a task changes status. Continue with the next incomplete task using an available tool, or tell the user what is blocking you and end your turn.";
  const hasFileEditTool = toolNames.includes("write_file") || toolNames.includes("str_replace");
  if (hasFileEditTool) return base;
  return base + FILE_EDIT_TOOLS_UNAVAILABLE_NOTE;
}

function taskCompletedTool(): ToolDefinition {
  return {
    name: "task_completed",
    description:
      "End the turn when the work is done. Params: {} (optionally {summary?: string}). Call this after the final message is ready — a turn with this tool in its toolset does not end without it.",
    execute: async (_ctx, input) => {
      const summary = optString(input, "summary", undefined);
      return okResult(summary ? `task completed: ${summary}` : "task completed");
    },
  };
}

function askUserTool(): ToolDefinition {
  return {
    name: "ask_user",
    description:
      "Ask the user a clarifying question when the request is ambiguous. Params: {questions: [{question: string, options?: string[]}]}. The turn pauses; the user's answers come back as the next message.",
    execute: async (_ctx, input) => {
      const v = input.questions;
      if (!Array.isArray(v) || v.length === 0) return errResult("ask_user: missing questions array");
      const questions: { question: string; options?: string[] }[] = [];
      for (const [i, q] of v.entries()) {
        if (typeof q !== "object" || q === null) return errResult(`ask_user: question ${i} is not an object`);
        const rec = q as Record<string, unknown>;
        if (typeof rec.question !== "string" || rec.question.length === 0) {
          return errResult(`ask_user: question ${i} needs a non-empty question`);
        }
        const opts = Array.isArray(rec.options) ? (rec.options as unknown[]).filter((o) => typeof o === "string") as string[] : undefined;
        questions.push({ question: rec.question, ...(opts && opts.length > 0 ? { options: opts } : {}) });
      }
      return { ok: true, output: "Questions shown to the user; waiting for answers.", askUserQuestions: questions };
    },
  };
}

function skillTool(): ToolDefinition {
  return {
    name: "skill",
    description:
      "Load a skill (SKILL.md) by name and follow its instructions. Params: {name: string}. The skill is always read fresh from disk. Skills are discovered in <project>/.agents/skills/ and ~/.config/metatech/skills/.",
    // Freebuff: skill has endsAgentStep: true — the step ends after
    // the skill content is loaded; the model continues in a new step.
    endsAgentStep: true,
    execute: async (ctx, input) => {
      const name = reqString(input, "name");
      if (!name.ok) return errResult(name.error);
      const loaded = loadSkill(name.value, ctx.cwd);
      if (!loaded.ok) return errResult(`skill: ${loaded.error}`);
      if (loaded.skill.frontmatter.disableModelInvocation && ctx.invokedByModel) {
        return errResult(`skill ${name.value} can only be invoked by the user, not by the model`);
      }
      return okResult(`--- skill: ${name.value} ---\n${loaded.skill.content}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export function allToolDefinitions(): ToolDefinition[] {
  return [
    readFilesTool(),
    listDirectoryTool(),
    globTool(),
    codeSearchTool(),
    strReplaceTool(),
    writeFileTool(),
    runTerminalCommandTool(),
    writeTodosTool(),
    taskCompletedTool(),
    askUserTool(),
    skillTool(),
  ];
}

export function toolDefinitionsFor(names: readonly string[]): ToolDefinition[] {
  const all = new Map(allToolDefinitions().map((t) => [t.name, t]));
  return names.map((n) => all.get(n)).filter((t): t is ToolDefinition => t !== undefined);
}

export function toolDescriptionsFor(names: readonly string[], cwd: string): string {
  const defs = toolDefinitionsFor(names);
  const lines = defs.map((d) => {
    if (d.name === "skill") {
      const xml = formatAvailableSkillsXml(discoverSkills(cwd));
      return `- skill: ${d.description}${xml ? `\n${xml}` : ""}`;
    }
    return `- ${d.name}: ${d.description}`;
  });
  return lines.join("\n");
}

/** One-line TUI preview per tool call (Freebuff collapsedPreview pattern). */
export function toolPreview(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "run_terminal_command":
      return `$ ${String(input.command ?? "")}`;
    case "read_files":
      return `Read ${Array.isArray(input.paths) ? (input.paths as unknown[]).join(", ") : String(input.paths ?? "")}`;
    case "write_file":
      return `Write ${String(input.path ?? "")}`;
    case "str_replace":
      return `Edit ${String(input.path ?? "")}`;
    case "list_directory":
      return `List ${String(input.path ?? ".")}`;
    case "glob":
      return `Glob ${String(input.pattern ?? "")}`;
    case "code_search":
      return `Search ${String(input.pattern ?? "")}`;
    case "write_todos":
      return "Update to-dos";
    case "task_completed":
      return "Task completed";
    case "ask_user":
      return "Ask user";
    case "skill":
      return `Skill ${String(input.name ?? "")}`;
    default:
      return toolName;
  }
}

/** Execute one parsed tool call; unknown tools and validation errors are results, not throws. */
export async function executeToolCall(
  ctx: ToolContext,
  toolName: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const def = toolDefinitionsFor([toolName])[0];
  if (!def) return errResult(`unknown tool: ${toolName}`);
  try {
    return await def.execute(ctx, input);
  } catch (e) {
    return errResult(`${toolName} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
