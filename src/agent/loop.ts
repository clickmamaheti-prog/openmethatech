// Local agent loop (MethaTech CLI).
//
// Adapted from Freebuff, Apache-2.0:
//   packages/agent-runtime/src/run-agent-step.ts
//     (loopAgentSteps :1115, runAgentStep, shouldEndTurn :901-1030)
//   packages/agent-runtime/src/util/turn-progress.ts
//     (NO_PROGRESS_STOP_THRESHOLD = 40)
//   packages/agent-runtime/src/util/file-edit-loop.ts (3/6/12)
//   common/src/constants/agents.ts
//     (MAX_AGENT_STEPS_DEFAULT = 600, MAX_SUBAGENT_STEPS_DEFAULT = 200)
//
// The loop runs LOCALLY in the CLI (AGENT-ADOPTION.md §0): the panel
// is a plain OpenAI-compatible chat API with no agent runtime, so the
// CLI itself does request → parse tool calls → execute → feed results
// back, until task_completed or no tool calls remain.
//
// MethaTech differences (deliberate, documented):
// - Transport is src/api.ts (SSE), not the Vercel AI SDK.
// - Tool calls execute AFTER the full step response arrives, not
//   mid-stream with the stream paused (Freebuff processStream). The
//   stream cannot be paused through streamChat's callback API, so
//   batching per step is the honest equivalent.
// - MAX_STEPS default is 100, not 600: on free panel models a 600-step
//   backstop can burn a lot of turns before the no-progress guard
//   (40) stops it; 100 is the working cap, configurable per call.
// - Turn-end rule is relaxed: Freebuff requires task_completed when
//   the toolset has it, or the turn never ends. Free panel models
//   often answer in plain text without ever calling task_completed,
//   which would loop to maxSteps on every chatty answer. MethaTech
//   ends the turn when a step returns no tool calls (and reports it),
//   and treats task_completed as the explicit finish signal.
// - ask_user pauses the turn: the questions are returned to the TUI
//   and the user's next message resumes the loop.

import { streamChat, type ChatMessage } from "../api.js";
import { createStreamParserState, parseFullText, parseStreamChunk } from "./xml-parser.js";
import { buildAgentSystemPrompt, buildProjectContext, stepPrompt } from "./prompt.js";
import { executeToolCall, FILE_EDIT_TOOLS_UNAVAILABLE_NOTE, toolDefinitionsFor, toolPreview, type TodoItem, type ToolContext, type ToolResult } from "./tools.js";
import { toolNamesForMode, type AgentMode } from "./modes.js";

/** Backstop for a turn that never stops (Freebuff: 600). MethaTech working cap: 100. */
export const MAX_AGENT_STEPS_DEFAULT = 100;
/** Freebuff MAX_AGENT_STEPS_DEFAULT, kept as the absolute ceiling. */
export const MAX_AGENT_STEPS_ABSOLUTE = 600;
/** Steps without any successful tool call before stopping (Freebuff: 40). */
export const NO_PROGRESS_STOP_THRESHOLD = 40;
/** Steps that only re-send the same unchanged to-do list before a
 * recovery nudge (Freebuff todo-loop.ts: 3). */
export const TODO_LOOP_RECOVERY_THRESHOLD = 3;
/** Steps that only re-send the same unchanged to-do list before the
 * turn is stopped (Freebuff todo-loop.ts: 6). */
export const TODO_LOOP_STOP_THRESHOLD = 6;
/** Freebuff todo-loop.ts TODO_LOOP_RECOVERY_MESSAGE (verbatim). */
export const TODO_LOOP_RECOVERY_MESSAGE =
  "You have repeatedly called write_todos with the same unchanged list and no other tool use in between. The list is already recorded. Stop repeating it. Use an available tool to make progress on the task, or explain the blocker to the user and end your turn. Respect the current mode and tool permissions.";
/** Freebuff todo-loop.ts TODO_LOOP_STOP_MESSAGE (verbatim). */
export const TODO_LOOP_STOP_MESSAGE =
  "The model got stuck repeating the same to-do list without making progress. This turn was stopped to avoid wasting more of your session. Try a different model or reasoning level, then continue.";
/** Failed edits to the same file before stopping (Freebuff: 6 identical). */
export const FILE_EDIT_LOOP_STOP_THRESHOLD = 6;

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; toolName: string; input: Record<string, unknown>; preview: string }
  | { type: "tool_result"; toolName: string; ok: boolean; output: string }
  | { type: "step"; step: number }
  | { type: "todos"; todos: TodoItem[] }
  | { type: "done"; completed: boolean; stopReason: string };

export interface AgentLoopOptions {
  apiKey: string;
  model: string;
  cwd: string;
  mode: AgentMode;
  userPrompt: string;
  /** Prior conversation (user/assistant/tool messages, no system prompt). */
  history?: ChatMessage[];
  maxSteps?: number;
  signal?: AbortSignal;
  /** Injectable model call (tests use a mock; default is streamChat). */
  callModel?: (messages: ChatMessage[], opts: { onDelta: (t: string) => void; signal?: AbortSignal }) => Promise<string>;
  onEvent?: (e: AgentEvent) => void;
  /** Shared to-do list (also updated live via onTodos). */
  todos?: TodoItem[];
}

export interface AgentLoopResult {
  /** Full history including the system prompt (feed it back next turn). */
  history: ChatMessage[];
  steps: number;
  completed: boolean;
  stopReason: string;
  /** Visible final text (filtered, no tool-call XML). */
  finalText: string;
  /** ask_user paused the turn with these questions. */
  askUserQuestions?: { question: string; options?: string[] }[];
  todos: TodoItem[];
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxSteps = Math.min(opts.maxSteps ?? MAX_AGENT_STEPS_DEFAULT, MAX_AGENT_STEPS_ABSOLUTE);
  const toolNames = toolNamesForMode(opts.mode);
  const toolSet = new Set(toolNames);
  const project = buildProjectContext(opts.cwd);
  const systemPrompt = buildAgentSystemPrompt({ mode: opts.mode, cwd: opts.cwd, model: opts.model, project });
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...(opts.history ?? []),
    { role: "user", content: opts.userPrompt },
  ];
  const todos: TodoItem[] = opts.todos ?? [];
  const toolCtx: ToolContext = {
    cwd: opts.cwd,
    todos,
    invokedByModel: true,
    toolNames,
    onTodos: (t) => opts.onEvent?.({ type: "todos", todos: [...t] }),
  };

  const callModel =
    opts.callModel ??
    (async (msgs: ChatMessage[], cbs: { onDelta: (t: string) => void; signal?: AbortSignal }) => {
      let text = "";
      await streamChat(opts.apiKey, opts.model, msgs, {
        onDelta: (d) => {
          text += d;
          cbs.onDelta(d);
        },
        onUsage: () => undefined,
      }, 4096, { signal: cbs.signal });
      return text;
    });

  let steps = 0;
  let noProgressSteps = 0;
  /** Consecutive steps that only re-sent the same unchanged to-do list
      (Freebuff todo-loop guard: recovery at 3, stop at 6). */
  let todoLoopStreak = 0;
  const failedEdits = new Map<string, number>();
  let finalText = "";
  let askUserQuestions: { question: string; options?: string[] }[] | undefined;
  let stopReason = "";
  let completed = false;

  while (steps < maxSteps) {
    if (opts.signal?.aborted) {
      stopReason = "interrupted by user";
      break;
    }
    steps += 1;
    opts.onEvent?.({ type: "step", step: steps });
    if (steps > 1) {
      messages.push({ role: "system", content: stepPrompt(steps) });
    }

    let rawText: string;
    // Stream deltas through the XML parser as they arrive, so tool-call
    // tags never leak into the visible text. Mock model calls (tests)
    // return the whole response without deltas — then the filtered text
    // is emitted once below instead.
    const parserState = createStreamParserState();
    let streamedAny = false;
    try {
      rawText = await callModel(messages, {
        onDelta: (d) => {
          streamedAny = true;
          const r = parseStreamChunk(d, parserState);
          if (r.filteredText.length > 0) opts.onEvent?.({ type: "text", text: r.filteredText });
        },
        signal: opts.signal,
      });
    } catch (e) {
      stopReason = `model call failed: ${e instanceof Error ? e.message : String(e)}`;
      break;
    }

    const parsed = parseFullText(rawText);
    // The assistant message kept in history is the raw text (so the
    // model sees its own tool calls on the next step); the TUI shows
    // only the filtered text.
    messages.push({ role: "assistant", content: rawText });
    finalText = parsed.filteredText;
    if (!streamedAny && parsed.filteredText.trim().length > 0) {
      opts.onEvent?.({ type: "text", text: parsed.filteredText });
    }

    // Malformed tool JSON forces a retry step (Freebuff TOOL_CALL_ERROR).
    if (parsed.parseErrors.length > 0) {
      messages.push({
        role: "user",
        content: `[TOOL_CALL_ERROR] Your tool call JSON did not parse: ${parsed.parseErrors.join(" | ")}. Fix the JSON and emit the call again inside <codebuff_tool_call> tags.`,
      });
      noProgressSteps += 1;
      if (noProgressSteps >= NO_PROGRESS_STOP_THRESHOLD) {
        stopReason = `stopped: no progress for ${NO_PROGRESS_STOP_THRESHOLD} steps`;
        break;
      }
      continue;
    }

    if (parsed.toolCalls.length === 0) {
      // No tool calls: the turn ends (relaxed vs Freebuff §1.1 — see
      // header). A text-only answer is a finished turn.
      completed = true;
      stopReason = "no more tool calls";
      break;
    }

    let hadToolError = false;
    let stepSucceeded = false;
    let taskDone = false;
    /** True when this step's only tool call re-sent the unchanged list. */
    let writeTodosUnchanged = false;

    for (const [callIndex, call] of parsed.toolCalls.entries()) {
      if (!toolSet.has(call.toolName)) {
        const output = `unknown or unavailable tool in this mode: ${call.toolName}`;
        messages.push({
          role: "tool",
          content: JSON.stringify({ tool: call.toolName, ok: false, output }),
          name: call.toolName,
          tool_call_id: `call-${steps}-${callIndex}`,
        });
        opts.onEvent?.({ type: "tool_result", toolName: call.toolName, ok: false, output });
        hadToolError = true;
        continue;
      }
      opts.onEvent?.({ type: "tool_call", toolName: call.toolName, input: call.input, preview: toolPreview(call.toolName, call.input) });
      const result: ToolResult = await executeToolCall(toolCtx, call.toolName, call.input);
      opts.onEvent?.({ type: "tool_result", toolName: call.toolName, ok: result.ok, output: result.output });
      messages.push({
        role: "tool",
        content: JSON.stringify({ tool: call.toolName, ok: result.ok, output: result.output }),
        name: call.toolName,
        tool_call_id: `call-${steps}-${callIndex}`,
      });
      if (!result.ok) {
        hadToolError = true;
        if (call.toolName === "str_replace" || call.toolName === "write_file") {
          const key = `${call.toolName}:${String(call.input.path ?? "")}`;
          const n = (failedEdits.get(key) ?? 0) + 1;
          failedEdits.set(key, n);
          if (n >= FILE_EDIT_LOOP_STOP_THRESHOLD) {
            stopReason = `stopped: ${n} failed edits to ${String(call.input.path ?? "the same file")} — try a different approach`;
            opts.onEvent?.({ type: "done", completed: false, stopReason });
            return { history: messages, steps, completed: false, stopReason, finalText, todos };
          }
        }
      } else {
        // An unchanged write_todos is a no-op, not progress (Freebuff:
        // write_todos is excluded from turn-progress fingerprints).
        const isUnchangedTodos =
          call.toolName === "write_todos" && result.output.startsWith("To-do list unchanged");
        if (isUnchangedTodos) writeTodosUnchanged = true;
        else stepSucceeded = true;
        if (call.toolName === "task_completed") taskDone = true;
      }
      if (result.askUserQuestions) {
        askUserQuestions = result.askUserQuestions;
        stopReason = "waiting for user answers (ask_user)";
        opts.onEvent?.({ type: "done", completed: false, stopReason });
        return { history: messages, steps, completed: false, stopReason, finalText, askUserQuestions, todos };
      }
      // Freebuff endsAgentStep (skill): the step ends after this
      // tool's result — remaining calls in this response are NOT
      // executed; the model re-issues them in the next step if needed.
      if (toolSet.has(call.toolName)) {
        const def = toolDefinitionsFor([call.toolName])[0];
        if (def?.endsAgentStep === true) break;
      }
    }

    // Freebuff todo-loop guard (util/todo-loop.ts): a step whose only
    // tool call re-sends the same unchanged to-do list is not progress.
    // A different list, another tool, or a user message breaks the
    // streak (here: any step that is not exactly one unchanged
    // write_todos resets it).
    if (parsed.toolCalls.length === 1 && parsed.toolCalls[0]?.toolName === "write_todos" && writeTodosUnchanged) {
      todoLoopStreak += 1;
    } else {
      todoLoopStreak = 0;
    }
    if (todoLoopStreak === TODO_LOOP_RECOVERY_THRESHOLD) {
      // Freebuff todoLoopRecoveryMessage(toolNames): append the
      // no-file-edit-tools note when the mode lacks them (Plan).
      const hasFileEditTool = toolSet.has("write_file") || toolSet.has("str_replace");
      messages.push({
        role: "user",
        content: hasFileEditTool ? TODO_LOOP_RECOVERY_MESSAGE : TODO_LOOP_RECOVERY_MESSAGE + FILE_EDIT_TOOLS_UNAVAILABLE_NOTE,
      });
    }
    if (todoLoopStreak >= TODO_LOOP_STOP_THRESHOLD) {
      stopReason = TODO_LOOP_STOP_MESSAGE;
      opts.onEvent?.({ type: "done", completed: false, stopReason });
      return { history: messages, steps, completed: false, stopReason, finalText, todos };
    }

    if (taskDone) {
      completed = true;
      stopReason = "task_completed";
      break;
    }
    if (stepSucceeded) noProgressSteps = 0;
    else noProgressSteps += 1;
    if (hadToolError) {
      // Error forces one more step so the model can retry (Freebuff).
      messages.push({
        role: "user",
        content: "[TOOL_CALL_ERROR] One or more tool calls above failed. Read the error, fix the call, and retry. Do not repeat the exact failing call.",
      });
    }
    if (noProgressSteps >= NO_PROGRESS_STOP_THRESHOLD) {
      stopReason = `stopped: no progress for ${NO_PROGRESS_STOP_THRESHOLD} steps`;
      break;
    }
  }

  if (!stopReason) {
    stopReason = steps >= maxSteps ? `stopped: max steps reached (${maxSteps})` : "turn ended";
  }
  opts.onEvent?.({ type: "done", completed, stopReason });
  return { history: messages, steps, completed, stopReason, finalText, askUserQuestions, todos };
}
