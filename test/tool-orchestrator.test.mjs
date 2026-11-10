// Unit + integration tests for the Universal Tool Orchestrator
// (Fase 4): dispatch through the registry, validation, timeout,
// result normalization, parallel waves vs sequential mutations,
// batch stops, cancellation, and loop → orchestrator → handler
// end-to-end over the XML path.
// Run after build: npm run build && npm test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatToolCall } from "../dist/agent/xml-parser.js";
import { toolNamesForMode } from "../dist/agent/modes.js";
import { getRegisteredTool } from "../dist/agent/tool-registry.js";
import {
  DEFAULT_MAX_PARALLEL,
  effectiveTimeoutMs,
  executeToolCalls,
  isParallelEligible,
  resultToToolMessage,
  withTimeout,
} from "../dist/agent/tool-orchestrator.js";
import { runAgentLoop } from "../dist/agent/loop.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "methatech-orch-"));
}

function orchCtx(cwd, overrides = {}) {
  return {
    ctx: { cwd, todos: [], invokedByModel: true, toolNames: toolNamesForMode("DEFAULT") },
    toolNames: toolNamesForMode("DEFAULT"),
    ...overrides,
  };
}

function mockModel(responses) {
  let i = 0;
  return async () => responses[Math.min(i++, responses.length - 1)];
}

// --- Dispatch through the registry ---

test("orchestrator: read-only calls dispatch through the registry", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello orchestrator\n");
  const { results, stoppedEarly } = await executeToolCalls(
    [{ name: "read_files", input: { paths: ["a.txt"] } }],
    orchCtx(dir),
  );
  assert.equal(stoppedEarly, false);
  assert.equal(results.length, 1);
  const r = results[0];
  assert.equal(r.tool, "read_files");
  assert.equal(r.index, 0);
  assert.equal(r.ok, true);
  assert.equal(r.isError, false);
  assert.match(r.output, /hello orchestrator/);
  // MCP CallToolResult shape: one text block with the same output.
  assert.deepEqual(r.content, [{ type: "text", text: r.output }]);
  assert.equal(typeof r.durationMs, "number");
  assert.ok(r.durationMs >= 0);
  assert.equal(r.timedOut, false);
  assert.equal(r.endsAgentStep, false);
  assert.equal(r.askUserQuestions, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("orchestrator: unknown tool is an error result, not a throw", async () => {
  const dir = tmpDir();
  const { results } = await executeToolCalls(
    [{ name: "teleport", input: {} }],
    orchCtx(dir),
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].isError, true);
  // The mode check fires first (same as the loop before Fase 4):
  // "teleport" is in no mode's toolset. The "unknown tool: X"
  // branch only exists for a tool that IS mode-allowed but missing
  // from the registry — the fail-fast registry makes that
  // unreachable in practice, so it is defense in depth only.
  assert.match(results[0].output, /unknown or unavailable tool in this mode: teleport/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("orchestrator: mode-unavailable tool is rejected with the loop's message", async () => {
  const dir = tmpDir();
  const planNames = toolNamesForMode("PLAN");
  assert.ok(!planNames.includes("write_file"));
  const { results } = await executeToolCalls(
    [{ name: "write_file", input: { path: "x.txt", content: "x" } }],
    orchCtx(dir, { toolNames: planNames, ctx: { cwd: dir, todos: [], invokedByModel: true, toolNames: planNames } }),
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.match(results[0].output, /unknown or unavailable tool in this mode: write_file/);
  assert.equal(fs.existsSync(path.join(dir, "x.txt")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("orchestrator: schema-invalid input fails validation without running the handler", async () => {
  const dir = tmpDir();
  const { results } = await executeToolCalls(
    [{ name: "write_file", input: { path: "x.txt" } }],
    orchCtx(dir),
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.match(results[0].output, /write_file: content: missing required param/);
  assert.equal(fs.existsSync(path.join(dir, "x.txt")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Parallel waves vs sequential mutations ---

test("orchestrator: parallel wave launches read-only calls concurrently, results stay in call order", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.txt"), "A\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "B\n");
  const events = [];
  const { results } = await executeToolCalls(
    [
      { name: "read_files", input: { paths: ["a.txt"] } },
      { name: "glob", input: { pattern: "*.txt" } },
      { name: "read_files", input: { paths: ["b.txt"] } },
    ],
    orchCtx(dir, {
      onCallStart: (c) => events.push(`start:${c.name}:${c.index}`),
      onCallResult: (r) => events.push(`result:${r.tool}:${r.index}`),
    }),
  );
  assert.equal(results.length, 3);
  // Results in call order, whatever the execution order was.
  assert.deepEqual(results.map((r) => r.index), [0, 1, 2]);
  assert.deepEqual(results.map((r) => r.tool), ["read_files", "glob", "read_files"]);
  assert.ok(results.every((r) => r.ok));
  assert.match(results[0].output, /A/);
  assert.match(results[2].output, /B/);
  // Concurrency proof (timing-independent): every call in the wave
  // was STARTED before any result came back — a sequential executor
  // would strictly interleave start/result/start/result.
  const lastStart = Math.max(...events.map((e, i) => (e.startsWith("start:") ? i : -1)));
  const firstResult = events.findIndex((e) => e.startsWith("result:"));
  assert.ok(lastStart < firstResult, `wave was not concurrent: ${events.join(" ")}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("orchestrator: mixed batch keeps ordering across the wave boundary", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  const { results } = await executeToolCalls(
    [
      { name: "read_files", input: { paths: ["a.txt"] } },
      { name: "write_file", input: { path: "a.txt", content: "two\n" } },
      { name: "read_files", input: { paths: ["a.txt"] } },
    ],
    orchCtx(dir),
  );
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.ok));
  // The first read saw "one", the write ran, the second read saw "two":
  // the mutating call broke the wave and the order was preserved.
  assert.match(results[0].output, /one/);
  assert.match(results[2].output, /two/);
  assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf-8"), "two\n");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("orchestrator: mutating calls run sequentially in order", async () => {
  const dir = tmpDir();
  const { results } = await executeToolCalls(
    [
      { name: "write_file", input: { path: "a.txt", content: "first\n" } },
      { name: "write_file", input: { path: "a.txt", content: "second\n" } },
    ],
    orchCtx(dir),
  );
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.ok));
  // Sequential order: the second write overwrote the first.
  assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf-8"), "second\n");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("orchestrator: a failing call does not stop the batch", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.txt"), "here\n");
  const { results, stoppedEarly } = await executeToolCalls(
    [
      { name: "read_files", input: { paths: ["missing.txt"] } },
      { name: "read_files", input: { paths: ["a.txt"] } },
    ],
    orchCtx(dir),
  );
  assert.equal(stoppedEarly, false);
  assert.equal(results.length, 2);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].isError, true);
  assert.match(results[0].output, /cannot read missing\.txt/);
  assert.equal(results[1].ok, true);
  assert.match(results[1].output, /here/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Batch stops ---

test("orchestrator: ask_user stops the batch, later calls never run", async () => {
  const dir = tmpDir();
  const { results, stoppedEarly, stopReason } = await executeToolCalls(
    [
      { name: "ask_user", input: { questions: [{ question: "Which one?" }] } },
      { name: "write_file", input: { path: "x.txt", content: "x" } },
    ],
    orchCtx(dir),
  );
  assert.equal(stoppedEarly, true);
  assert.equal(stopReason, "ask_user");
  assert.equal(results.length, 1);
  assert.equal(results[0].tool, "ask_user");
  assert.equal(results[0].askUserQuestions?.[0]?.question, "Which one?");
  assert.equal(fs.existsSync(path.join(dir, "x.txt")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("orchestrator: skill (endsAgentStep) stops the batch", async () => {
  const dir = tmpDir();
  const skillDir = path.join(dir, ".agents", "skills", "review");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: review\ndescription: Review code\n---\nReview every diff.\n`);
  const { results, stoppedEarly, stopReason } = await executeToolCalls(
    [
      { name: "skill", input: { name: "review" } },
      { name: "write_file", input: { path: "x.txt", content: "x" } },
    ],
    orchCtx(dir),
  );
  assert.equal(stoppedEarly, true);
  assert.equal(stopReason, "ends_agent_step");
  assert.equal(results.length, 1);
  assert.equal(results[0].tool, "skill");
  assert.equal(results[0].endsAgentStep, true);
  assert.match(results[0].output, /Review every diff/);
  assert.equal(fs.existsSync(path.join(dir, "x.txt")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Cancellation ---

test("orchestrator: aborted signal skips unstarted calls", async () => {
  const dir = tmpDir();
  const controller = new AbortController();
  controller.abort();
  const { results, stoppedEarly, stopReason } = await executeToolCalls(
    [{ name: "write_file", input: { path: "x.txt", content: "x" } }],
    orchCtx(dir, { signal: controller.signal }),
  );
  assert.equal(stoppedEarly, true);
  assert.equal(stopReason, "cancelled");
  assert.equal(results.length, 0);
  assert.equal(fs.existsSync(path.join(dir, "x.txt")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Timeout (registry metadata) ---

test("orchestrator: effectiveTimeoutMs mirrors the shell handler clamp", () => {
  const shell = getRegisteredTool("run_terminal_command");
  assert.equal(effectiveTimeoutMs(shell, {}), 120_000);
  assert.equal(effectiveTimeoutMs(shell, { timeout_seconds: 600 }), 600_000);
  assert.equal(effectiveTimeoutMs(shell, { timeout_seconds: 900 }), 600_000);
  assert.equal(effectiveTimeoutMs(shell, { timeout_seconds: 1 }), 1000);
  assert.equal(effectiveTimeoutMs(shell, { timeout_seconds: -1 }), null);
  assert.equal(effectiveTimeoutMs(shell, { timeout_seconds: 0 }), 1000);
  // Tools without a timeoutMs have no deadline.
  assert.equal(effectiveTimeoutMs(getRegisteredTool("read_files"), {}), null);
  assert.equal(effectiveTimeoutMs(getRegisteredTool("write_file"), {}), null);
});

test("orchestrator: withTimeout resolves the fallback on deadline", async () => {
  const never = new Promise(() => {});
  const timedOut = await withTimeout(never, 10, () => "fallback");
  assert.equal(timedOut, "fallback");
  const fast = await withTimeout(Promise.resolve("value"), 1000, () => "fallback");
  assert.equal(fast, "value");
});

test("orchestrator: shell timeout is owned by the handler (existing behavior preserved)", async () => {
  const dir = tmpDir();
  const started = Date.now();
  const { results } = await executeToolCalls(
    [{ name: "run_terminal_command", input: { command: "sleep 2", timeout_seconds: 1 } }],
    orchCtx(dir),
  );
  // The handler's own timeout fires first (1s) and its detailed
  // result wins over the orchestrator's hang guard (1s + 5s grace):
  // a timed-out shell command is reported by the handler as ok with
  // exitCode -1. That is pre-existing handler behavior, NOT something
  // the orchestrator invented — Fase 4 preserves it as-is.
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].timedOut, false);
  assert.match(results[0].output, /"exitCode":-1/);
  assert.ok(Date.now() - started >= 900, "handler waited out its own timeout");
  assert.ok(Date.now() - started < 6000, "orchestrator did not wait for the full grace deadline");
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Normalization ---

test("orchestrator: output is capped to the registry limit", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "big.txt"), "x".repeat(60_000));
  const { results } = await executeToolCalls(
    [{ name: "read_files", input: { paths: ["big.txt"] } }],
    orchCtx(dir),
  );
  assert.equal(results[0].ok, true);
  assert.ok(results[0].output.length < 51_000);
  assert.match(results[0].output, /output truncated/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("orchestrator: resultToToolMessage keeps the exact history shape", () => {
  const msg = resultToToolMessage(
    {
      tool: "read_files",
      index: 2,
      input: { paths: ["a.txt"] },
      ok: true,
      output: "file contents",
      content: [{ type: "text", text: "file contents" }],
      isError: false,
      durationMs: 3,
      timedOut: false,
      endsAgentStep: false,
    },
    "call-1-2",
  );
  assert.deepEqual(msg, {
    role: "tool",
    content: JSON.stringify({ tool: "read_files", ok: true, output: "file contents" }),
    name: "read_files",
    tool_call_id: "call-1-2",
  });
});

test("orchestrator: isParallelEligible derives from registry metadata", () => {
  for (const name of ["read_files", "list_directory", "glob", "code_search"]) {
    assert.equal(isParallelEligible(getRegisteredTool(name)), true, name);
  }
  for (const name of ["str_replace", "write_file", "run_terminal_command", "write_todos", "task_completed", "ask_user", "skill"]) {
    assert.equal(isParallelEligible(getRegisteredTool(name)), false, name);
  }
  assert.equal(isParallelEligible(undefined), false);
  assert.equal(DEFAULT_MAX_PARALLEL, 4);
});

// --- Integration: loop -> orchestrator -> handler over XML ---

test("loop via orchestrator: mock model reads two files and writes one in a single step", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.txt"), "A\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "B\n");
  const events = [];
  const result = await runAgentLoop({
    apiKey: "test",
    model: "glm-5.3-flash",
    cwd: dir,
    mode: "DEFAULT",
    userPrompt: "read and write",
    callModel: mockModel([
      [
        "Reading both files, then writing.",
        formatToolCall("read_files", { paths: ["a.txt"] }),
        formatToolCall("read_files", { paths: ["b.txt"] }),
        formatToolCall("write_file", { path: "c.txt", content: "C\n" }),
      ].join("\n"),
      "Done.",
    ]),
    onEvent: (e) => events.push(e),
  });
  assert.equal(result.completed, true);
  assert.equal(result.steps, 2);
  assert.equal(fs.readFileSync(path.join(dir, "c.txt"), "utf-8"), "C\n");
  const toolMsgs = result.history.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 3);
  assert.deepEqual(toolMsgs.map((m) => m.name), ["read_files", "read_files", "write_file"]);
  assert.deepEqual(toolMsgs.map((m) => m.tool_call_id), ["call-1-0", "call-1-1", "call-1-2"]);
  // Tool-call events still fire in call order, before results.
  assert.deepEqual(
    events.filter((e) => e.type === "tool_call").map((e) => e.toolName),
    ["read_files", "read_files", "write_file"],
  );
  assert.equal(events.filter((e) => e.type === "tool_result").length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loop via orchestrator: mixed read-write-read batch keeps ordering through the loop", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  const result = await runAgentLoop({
    apiKey: "test",
    model: "glm-5.3-flash",
    cwd: dir,
    mode: "DEFAULT",
    userPrompt: "read, write, read again",
    callModel: mockModel([
      [
        formatToolCall("read_files", { paths: ["a.txt"] }),
        formatToolCall("write_file", { path: "a.txt", content: "two\n" }),
        formatToolCall("read_files", { paths: ["a.txt"] }),
      ].join("\n"),
      "Done.",
    ]),
  });
  assert.equal(result.completed, true);
  const toolMsgs = result.history.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 3);
  assert.match(toolMsgs[0].content, /one/);
  assert.match(toolMsgs[2].content, /two/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loop via orchestrator: ask_user mid-batch pauses and later calls never run", async () => {
  const dir = tmpDir();
  const result = await runAgentLoop({
    apiKey: "test",
    model: "glm-5.3-flash",
    cwd: dir,
    mode: "DEFAULT",
    userPrompt: "ambiguous task",
    callModel: mockModel([
      [
        formatToolCall("ask_user", { questions: [{ question: "Which framework?" }] }),
        formatToolCall("write_file", { path: "x.txt", content: "x" }),
      ].join("\n"),
    ]),
  });
  assert.equal(result.completed, false);
  assert.equal(result.askUserQuestions?.[0]?.question, "Which framework?");
  assert.equal(fs.existsSync(path.join(dir, "x.txt")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
