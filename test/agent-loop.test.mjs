// Universal Agent Loop — Fase 5 tests.
//
// These tests prove the loop works THROUGH the Fase 2 adapter and
// Fase 4 orchestrator contracts, with no shortcut:
//
//   - every model request goes through the injected ModelAdapter
//     (a MockAdapter here — no network, no transport mocking);
//   - every tool execution goes through the orchestrator (the loop
//     never calls a handler directly);
//   - one parsed tool call = exactly one execution (ledger);
//   - history format is unchanged vs the pre-Fase-5 shape;
//   - provider / tool errors end the step, never the session;
//   - streaming + abort still work.
//
// The XML tool-call path itself is covered by test/agent.test.mjs;
// this file covers the loop CONTRACT, not the parser.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runAgentLoop } from "../dist/agent/loop.js";
import { AdapterError } from "../dist/agent/model-adapter.js";
import { formatToolCall } from "../dist/agent/xml-parser.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "methatech-loop-"));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Mock ModelAdapter: scripted steps. Each step is either
 * `{ chunks: [...] }` (yielded in order) or `{ error }` (thrown
 * when the step starts). Requests are recorded so tests can assert
 * the loop talked to the adapter — and nothing else — with the
 * right model + messages.
 */
class MockAdapter {
  id = "mock";
  calls = [];
  #script;
  #step = 0;
  /** Optional AbortController the adapter aborts mid-stream (for the
   *  abort test — deterministic, no timers). */
  abortCtl = null;

  constructor(script) {
    this.#script = script;
  }

  async *chat(request) {
    // Snapshot the request: the loop mutates its messages array
    // after the call returns (it appends the assistant message), so
    // recording the live reference would show a later state.
    this.calls.push({ ...request, messages: request.messages.map((m) => ({ ...m })) });
    const step = this.#script[Math.min(this.#step++, this.#script.length - 1)];
    if (step.error) throw step.error;
    for (const chunk of step.chunks) {
      if (request.signal?.aborted) {
        const e = new Error("dibatalkan");
        e.name = "AbortError";
        throw e;
      }
      if (chunk.delayMs) await sleep(chunk.delayMs);
      if (this.abortCtl && chunk.abortAfter) {
        this.abortCtl.abort();
        const e = new Error("dibatalkan");
        e.name = "AbortError";
        throw e;
      }
      yield chunk;
    }
    // Fase 7: a model call's stream is complete only when the
    // server sends a finish chunk (or usage). Real servers send
    // one (the mock server sends finish_reason + usage in the
    // final chunk), so the mock appends it automatically — a
    // scripted step that omits it would otherwise fail every
    // loop test as an incomplete stream. A step may opt out with
    // `truncate: true` (no finish chunk) to test the
    // incomplete-stream guard, or set `finishReason` (e.g.
    // "length", "content_filter") to test finish-reason handling.
    if (step.truncate !== true && !step.chunks.some((c) => c.type === "finish" || c.type === "usage")) {
      yield { type: "finish", reason: step.finishReason ?? "stop" };
    }
  }
}

const text = (t) => ({ type: "text", text: t });
const reasoning = (t) => ({ type: "reasoning", text: t });
const usage = (promptTokens, completionTokens) => ({
  type: "usage",
  usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
});
const finish = (reason = "stop") => ({ type: "finish", reason });

function baseOpts(dir, overrides = {}) {
  return {
    apiKey: "test",
    model: "glm-5.3-flash",
    cwd: dir,
    mode: "DEFAULT",
    userPrompt: "kerjakan tugas",
    ...overrides,
  };
}

test("loop: model requests go through the injected adapter, not a transport", async () => {
  const dir = tmpDir();
  const adapter = new MockAdapter([{ chunks: [text("Halo!"), usage(10, 5), finish()] }]);
  const result = await runAgentLoop(baseOpts(dir, { adapter, userPrompt: "hai" }));
  assert.equal(result.completed, true);
  assert.equal(result.stopReason, "no more tool calls");
  assert.equal(result.steps, 1);
  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.calls[0].model, "glm-5.3-flash");
  assert.equal(adapter.calls[0].messages[0].role, "system");
  assert.equal(adapter.calls[0].messages.at(-1).role, "user");
  assert.equal(adapter.calls[0].messages.at(-1).content, "hai");
  assert.equal(adapter.calls[0].tools, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loop: streaming text + reasoning deltas flow through the adapter", async () => {
  const dir = tmpDir();
  const adapter = new MockAdapter([
    { chunks: [text("Hel"), reasoning("mikir"), text("lo"), text("!"), finish()] },
  ]);
  const events = [];
  const result = await runAgentLoop(
    baseOpts(dir, { adapter, onEvent: (e) => events.push(e) }),
  );
  assert.equal(result.finalText, "Hello!");
  assert.deepEqual(
    events.filter((e) => e.type === "text").map((e) => e.text),
    ["Hel", "lo", "!"],
  );
  assert.deepEqual(
    events.filter((e) => e.type === "reasoning").map((e) => e.text),
    ["mikir"],
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loop: provider error mid-turn keeps history intact and the session resumable", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.txt"), "isi file A\n");
  const failing = new MockAdapter([
    { chunks: [text(formatToolCall("read_files", { paths: ["a.txt"] }))] },
    { error: new AdapterError("server", "panel down", { status: 500, retryable: true }) },
  ]);
  const first = await runAgentLoop(baseOpts(dir, { adapter: failing }));
  assert.equal(first.completed, false);
  assert.match(first.stopReason, /^model call failed: panel down/);
  assert.equal(first.steps, 2);
  // History intact: system + user + assistant + tool message.
  assert.equal(first.history.filter((m) => m.role === "tool").length, 1);
  assert.match(first.history.find((m) => m.role === "tool").content, /isi file A/);
  assert.equal(first.executedToolCalls.length, 1);
  assert.equal(first.executedToolCalls[0].tool, "read_files");

  // Resume from the returned history (ChatApp filters the old system
  // prompt first) with a healthy adapter: the session continues.
  const priorHistory = first.history.filter((m) => m.role !== "system");
  const healthy = new MockAdapter([{ chunks: [text("Lanjut, file sudah dibaca.")] }]);
  const second = await runAgentLoop(
    baseOpts(dir, { adapter: healthy, history: priorHistory, userPrompt: "lanjutkan" }),
  );
  assert.equal(second.completed, true);
  assert.equal(second.stopReason, "no more tool calls");
  assert.equal(second.steps, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loop: tool error is a result on the same channel, the turn does not crash", async () => {
  const dir = tmpDir();
  const adapter = new MockAdapter([
    { chunks: [text(formatToolCall("read_files", { paths: ["hilang.txt"] }))] },
    { chunks: [text("Maaf, file itu tidak ada.")] },
  ]);
  const events = [];
  const result = await runAgentLoop(baseOpts(dir, { adapter, onEvent: (e) => events.push(e) }));
  assert.equal(result.completed, true);
  assert.equal(result.steps, 2);
  const toolMsg = result.history.find((m) => m.role === "tool");
  assert.ok(toolMsg);
  const parsed = JSON.parse(toolMsg.content);
  assert.equal(parsed.ok, false);
  assert.match(parsed.output, /hilang\.txt/);
  // The loop appends one retry hint for the model after a tool error.
  assert.ok(
    result.history.some((m) => m.role === "user" && m.content.startsWith("[TOOL_CALL_ERROR]")),
  );
  assert.equal(result.executedToolCalls.length, 1);
  assert.equal(result.executedToolCalls[0].ok, false);
  assert.ok(events.some((e) => e.type === "tool_result" && !e.ok));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loop: pre-aborted signal stops the turn without calling the model", async () => {
  const dir = tmpDir();
  const adapter = new MockAdapter([{ chunks: [text("tidak akan sampai")] }]);
  const ctl = new AbortController();
  ctl.abort();
  const result = await runAgentLoop(baseOpts(dir, { adapter, signal: ctl.signal }));
  assert.equal(result.stopReason, "interrupted by user");
  assert.equal(result.steps, 0);
  assert.equal(adapter.calls.length, 0);
  assert.equal(result.history.length, 2); // system + user, no assistant
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loop: abort mid-stream interrupts the turn, history stays intact", async () => {
  const dir = tmpDir();
  const ctl = new AbortController();
  const adapter = new MockAdapter([
    { chunks: [text("sebagian..."), { ...text("lanjut"), abortAfter: true }] },
  ]);
  adapter.abortCtl = ctl;
  const result = await runAgentLoop(baseOpts(dir, { adapter, signal: ctl.signal }));
  assert.equal(result.stopReason, "interrupted by user");
  assert.equal(result.completed, false);
  assert.equal(result.history.length, 2); // system + user; no assistant pushed
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loop: no duplicate tool execution — same calls in two steps run once each", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.txt"), "ISI-A\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "ISI-B\n");
  const twoReads =
    formatToolCall("read_files", { paths: ["a.txt"] }) +
    "\n" +
    formatToolCall("read_files", { paths: ["b.txt"] });
  const adapter = new MockAdapter([
    { chunks: [text(twoReads)] },
    { chunks: [text(twoReads)] },
    { chunks: [text("Selesai.")] },
  ]);
  const events = [];
  const result = await runAgentLoop(baseOpts(dir, { adapter, onEvent: (e) => events.push(e) }));
  assert.equal(result.completed, true);
  assert.equal(result.steps, 3);
  // Ledger: exactly 4 executions, keys (step:index) all unique.
  assert.equal(result.executedToolCalls.length, 4);
  const keys = result.executedToolCalls.map((c) => `${c.step}:${c.index}`);
  assert.equal(new Set(keys).size, 4);
  assert.deepEqual(keys, ["1:0", "1:1", "2:0", "2:1"]);
  // History: exactly 4 tool messages, results in call order.
  const toolMsgs = result.history.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 4);
  assert.deepEqual(
    toolMsgs.map((m) => m.tool_call_id),
    ["call-1-0", "call-1-1", "call-2-0", "call-2-1"],
  );
  // Both executions really ran (contents present twice, once per step).
  const contents = toolMsgs.map((m) => JSON.parse(m.content).output).join("\n");
  assert.equal((contents.match(/ISI-A/g) || []).length, 2);
  assert.equal((contents.match(/ISI-B/g) || []).length, 2);
  // Events: exactly 4 tool_result events, one per execution.
  assert.equal(events.filter((e) => e.type === "tool_result").length, 4);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loop: history format is unchanged — raw assistant text + resultToToolMessage shape", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.txt"), "ISI-A\n");
  const step1 = `Saya baca dulu.\n${formatToolCall("read_files", { paths: ["a.txt"] })}`;
  const step2 = `${formatToolCall("task_completed", { summary: "done" })}Selesai.`;
  const adapter = new MockAdapter([{ chunks: [text(step1)] }, { chunks: [text(step2)] }]);
  const result = await runAgentLoop(baseOpts(dir, { adapter }));
  assert.equal(result.stopReason, "task_completed");
  // Exact roles: system, user, assistant, tool, system(step prompt),
  // assistant, tool (task_completed is itself a tool call).
  assert.deepEqual(
    result.history.map((m) => m.role),
    ["system", "user", "assistant", "tool", "system", "assistant", "tool"],
  );
  // The assistant message keeps the RAW text (model sees its own calls).
  assert.equal(result.history[2].content, step1);
  assert.match(result.history[2].content, /<codebuff_tool_call>/);
  // The step-2 system message is the step prompt, not a rebuilt prompt.
  assert.match(result.history[4].content, /^\[step 2\] Continue the task/);
  // The tool message is the exact resultToToolMessage shape.
  const toolMsg = result.history[3];
  assert.equal(toolMsg.name, "read_files");
  assert.equal(toolMsg.tool_call_id, "call-1-0");
  const parsed = JSON.parse(toolMsg.content);
  assert.deepEqual(Object.keys(parsed), ["tool", "ok", "output"]);
  assert.equal(parsed.tool, "read_files");
  assert.equal(parsed.ok, true);
  assert.match(parsed.output, /ISI-A/);
  // The task_completed call also leaves its tool message behind.
  const doneMsg = result.history[6];
  assert.equal(doneMsg.name, "task_completed");
  assert.equal(doneMsg.tool_call_id, "call-2-0");
  assert.equal(JSON.parse(doneMsg.content).ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loop: execution ledger is present on early returns (ask_user)", async () => {
  const dir = tmpDir();
  const adapter = new MockAdapter([
    {
      chunks: [
        text(
          formatToolCall("ask_user", {
            questions: [{ question: "Lanjut?", options: ["Ya", "Tidak"] }],
          }),
        ),
      ],
    },
  ]);
  const result = await runAgentLoop(baseOpts(dir, { adapter }));
  assert.equal(result.stopReason, "waiting for user answers (ask_user)");
  assert.deepEqual(
    result.askUserQuestions,
    [{ question: "Lanjut?", options: ["Ya", "Tidak"] }],
  );
  assert.equal(result.executedToolCalls.length, 1);
  assert.equal(result.executedToolCalls[0].tool, "ask_user");
  assert.equal(result.executedToolCalls[0].step, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
