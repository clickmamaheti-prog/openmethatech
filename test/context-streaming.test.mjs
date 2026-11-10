// Context & Streaming Integration tests (Universal Runtime, Fase 7).
// All mocks, no network. Covers: token estimation + budgeting,
// pair-preserving truncation, pinned summaries, auto-compaction
// (success + failure fallback), stream completeness, finish
// reasons, retry policy, Ctrl+C abort, provider errors mid-stream,
// XML fallback in long conversations, and no duplication of
// messages / tool calls / tool results.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ApiError } from "../dist/api.js";
import {
  addUsage,
  buildSummaryMessage,
  budgetContext,
  COMPACT_SUMMARY_MARKER,
  countContextTokens,
  estimateMessageTokens,
  estimateTokens,
  FALLBACK_CONTEXT_WINDOW_TOKENS,
  prepareContext,
  resolveContextWindow,
  RESPONSE_RESERVE_MARGIN_TOKENS,
  summarizeSegment,
} from "../dist/agent/context-manager.js";
import { LOOP_MAX_TOKENS, runAgentLoop } from "../dist/agent/loop.js";
import { AdapterError, collectChatText, normalizeProviderError } from "../dist/agent/model-adapter.js";
import { setCapability } from "../dist/agent/model-capabilities.js";
import { formatToolCall } from "../dist/agent/xml-parser.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "methatech-fase7-"));
}

const abortErr = () => {
  const e = new Error("dibatalkan");
  e.name = "AbortError";
  return e;
};

/**
 * Mock ModelAdapter: scripted steps. Each step is either
 * `{ chunks: [...] }` (yielded in order) or `{ error }` (thrown
 * when the step starts). A chunk may be `{ error }` (thrown
 * mid-stream, after earlier chunks were delivered) or carry
 * `abortAfter: true` (aborts `abortCtl`, then throws AbortError).
 * After the scripted chunks, a finish chunk is auto-appended —
 * real servers always send one — unless the step opts out with
 * `truncate: true` or sets `finishReason` ("length",
 * "content_filter", ...). Requests are recorded.
 */
class MockAdapter {
  id = "mock";
  calls = [];
  #script;
  #step = 0;
  /** Optional AbortController the adapter aborts mid-stream. */
  abortCtl = null;

  constructor(script) {
    this.#script = script;
  }

  async *chat(request) {
    this.calls.push({ ...request, messages: request.messages.map((m) => ({ ...m })) });
    const step = this.#script[Math.min(this.#step++, this.#script.length - 1)];
    if (step.error) throw step.error;
    for (const chunk of step.chunks) {
      if (chunk.error) throw chunk.error;
      if (request.signal?.aborted) throw abortErr();
      if (chunk.delayMs) await sleep(chunk.delayMs);
      if (this.abortCtl && chunk.abortAfter) {
        this.abortCtl.abort();
        throw abortErr();
      }
      yield chunk;
    }
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
const serverError = (status = 500) => new AdapterError("server", `panel down ${status}`, { status, retryable: true });

function baseOpts(dir, overrides = {}) {
  return {
    apiKey: "test-key",
    model: "glm-5.3-flash",
    cwd: dir,
    mode: "default",
    userPrompt: "halo",
    ...overrides,
  };
}

async function runLoop(dir, script, overrides = {}) {
  const adapter = new MockAdapter(script);
  const result = await runAgentLoop({ ...baseOpts(dir, overrides), adapter });
  return { result, adapter };
}

/** N user/assistant exchanges, each ~20 tokens. */
function longHistory(n = 60) {
  const history = [];
  for (let i = 0; i < n; i++) {
    history.push({ role: "user", content: `pesan ${i} dari pengguna, tolong dicatat baik-baik` });
    history.push({ role: "assistant", content: `jawaban ${i}, sudah dicatat.` });
  }
  return history;
}

/** Set a test model's context window; returns a restore function. */
function setWindow(modelId, windowTokens) {
  setCapability(modelId, { contextWindow: windowTokens }, "probe-live");
  return () => setCapability(modelId, { contextWindow: null }, "provider-config");
}

// ---------------------------------------------------------------------------
// Token estimation + budgeting
// ---------------------------------------------------------------------------

test("estimateTokens: Latin ~4 chars/token, CJK ~1 char/token, empty is 0", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("hello world"), 3); // 11 chars / 4
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("你好世界"), 4); // 4 CJK chars
  assert.equal(estimateTokens("ab你好"), 3); // 2 latin / 4 + 2 CJK
});

test("estimateMessageTokens: per-message overhead, tool messages cost more", () => {
  const sys = { role: "system", content: "abcd" };
  const tool = { role: "tool", content: "abcd", tool_call_id: "call-1-0", name: "read_files" };
  assert.equal(estimateMessageTokens(sys), 1 + 8);
  assert.equal(estimateMessageTokens(tool), 1 + 8 + 12);
  assert.equal(
    countContextTokens([sys, { role: "user", content: "abcd" }]),
    2 * (1 + 8),
  );
});

test("resolveContextWindow: unknown model falls back to the planning default", () => {
  assert.equal(resolveContextWindow("model-yang-tidak-ada"), FALLBACK_CONTEXT_WINDOW_TOKENS);
  assert.equal(FALLBACK_CONTEXT_WINDOW_TOKENS, 128_000);
  const restore = setWindow("fase7-resolve-model", 8000);
  try {
    assert.equal(resolveContextWindow("fase7-resolve-model"), 8000);
  } finally {
    restore();
    assert.equal(resolveContextWindow("fase7-resolve-model"), FALLBACK_CONTEXT_WINDOW_TOKENS);
  }
});

test("budgetContext: breakdown math and over-budget flag", () => {
  const messages = [
    { role: "system", content: "abcd" },
    { role: "user", content: "abcdefgh" },
    { role: "assistant", content: "abcd" },
    { role: "tool", content: "abcdefgh", tool_call_id: "call-1-0", name: "read_files" },
  ];
  const b = budgetContext(messages, { windowTokens: 100, reserveTokens: 10, toolDefinitionText: "abcd" });
  assert.equal(b.windowTokens, 100);
  assert.equal(b.reserveTokens, 10);
  assert.equal(b.systemTokens, 9);
  assert.equal(b.toolDefinitionTokens, 1);
  // history = user (2+8) + assistant (1+8) + tool (2+8+12) = 41
  assert.equal(b.historyTokens, 41);
  assert.equal(b.toolResultTokens, 22);
  assert.equal(b.totalEstimatedTokens, 50);
  assert.equal(b.historyBudgetTokens, 100 - 10 - 9);
  assert.equal(b.overBudget, false);
  const over = budgetContext(messages, { windowTokens: 40, reserveTokens: 10 });
  assert.equal(over.overBudget, true);
});

test("prepareContext: short conversation passes through unchanged", () => {
  const messages = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "halo" },
    { role: "assistant", content: "Halo!" },
    { role: "user", content: "lanjut" },
  ];
  const before = JSON.stringify(messages);
  const p = prepareContext(messages, { windowTokens: 128_000, reserveTokens: 4352 });
  assert.deepEqual(p.messages, messages);
  assert.equal(p.droppedMessages.length, 0);
  assert.equal(p.truncatedToolResults, 0);
  assert.equal(p.overBudget, false);
  assert.equal(p.summaryInsertAt, 1);
  // The input is never mutated by truncation (view only).
  assert.equal(JSON.stringify(messages), before);
});

test("prepareContext: long conversation drops front exchanges, keeps the last + system", () => {
  const messages = [{ role: "system", content: "system prompt" }, ...longHistory(10)];
  const p = prepareContext(messages, { windowTokens: 4352 + 100, reserveTokens: 4352 });
  assert.ok(p.droppedMessages.length > 0, "some exchanges must be dropped");
  assert.ok(p.droppedMessages.length < 20, "not everything is dropped");
  // The view starts with the system prompt, then kept exchanges in order.
  assert.equal(p.messages[0].role, "system");
  assert.equal(p.messages[0].content, "system prompt");
  // The last exchange (current user prompt) is never dropped.
  const lastUser = p.messages.filter((m) => m.role === "user").at(-1);
  assert.equal(lastUser.content, "pesan 9 dari pengguna, tolong dicatat baik-baik");
  // Dropped messages are a prefix of the exchanges, in order.
  assert.equal(p.droppedMessages[0].content, "pesan 0 dari pengguna, tolong dicatat baik-baik");
  // The view fits the budget (or reports over-budget honestly).
  assert.ok(p.estimatedTokens <= 100 || p.overBudget);
});

test("prepareContext: a tool call and its result drop together, never split", () => {
  const toolExchange = [
    { role: "user", content: "baca berkas" },
    { role: "assistant", content: formatToolCall("read_files", { paths: ["a.txt"] }) },
    { role: "tool", content: "isi berkas", tool_call_id: "call-1-0", name: "read_files" },
  ];
  const messages = [
    { role: "system", content: "system prompt" },
    ...toolExchange,
    { role: "user", content: "pesan kedua" },
    { role: "assistant", content: "jawaban kedua" },
    { role: "user", content: "pesan terakhir" },
  ];
  // Window keeps only the last exchange.
  const p = prepareContext(messages, { windowTokens: 4352 + 60, reserveTokens: 4352 });
  const droppedContents = p.droppedMessages.map((m) => m.content);
  const viewContents = p.messages.map((m) => m.content);
  // Both the tool-call assistant message AND its tool result are dropped...
  assert.ok(droppedContents.includes(toolExchange[1].content));
  assert.ok(droppedContents.includes("isi berkas"));
  // ...and neither leaks into the view without the other.
  assert.ok(!viewContents.includes(toolExchange[1].content));
  assert.ok(!viewContents.includes("isi berkas"));
  // The last user message is still there.
  assert.ok(viewContents.includes("pesan terakhir"));
});

test("prepareContext: giant tool result is truncated in the VIEW only, stored history untouched", () => {
  const giant = "x".repeat(50_000);
  const messages = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "baca berkas besar" },
    { role: "assistant", content: formatToolCall("read_files", { paths: ["big.txt"] }) },
    { role: "tool", content: giant, tool_call_id: "call-1-0", name: "read_files" },
  ];
  const before = JSON.stringify(messages);
  const p = prepareContext(messages, { windowTokens: 4352 + 1000, reserveTokens: 4352 });
  assert.equal(p.droppedMessages.length, 0, "single exchange is never dropped");
  assert.equal(p.truncatedToolResults, 1);
  assert.equal(p.truncatedMessages.length, 1);
  assert.equal(p.truncatedMessages[0].content, giant, "truncatedMessages carries the ORIGINAL");
  const viewTool = p.messages.find((m) => m.role === "tool");
  assert.ok(viewTool.content.includes("output dipotong"), "view shows the truncation marker");
  assert.ok(viewTool.content.length < 5000, "view keeps head + tail only");
  assert.ok(viewTool.content.startsWith("x".repeat(100)), "head preserved");
  assert.ok(viewTool.content.endsWith("x".repeat(100)), "tail preserved");
  // Stored history is byte-identical (the view is a copy).
  assert.equal(JSON.stringify(messages), before);
  assert.equal(messages[3].content, giant);
});

test("prepareContext: pinned summary messages are never dropped", () => {
  const summary = buildSummaryMessage("pengguna bertanya banyak hal.");
  const messages = [
    { role: "system", content: "system prompt" },
    summary,
    ...longHistory(10),
  ];
  const p = prepareContext(messages, { windowTokens: 4352 + 100, reserveTokens: 4352 });
  assert.ok(p.droppedMessages.length > 0);
  assert.ok(p.messages.includes(summary), "the summary survives truncation");
  assert.ok(!p.droppedMessages.includes(summary));
  // A summary of the dropped segment belongs right after the pinned prefix.
  assert.equal(p.summaryInsertAt, 2);
});

test("prepareContext: token budgeting differs across providers (window 128k vs 5k)", () => {
  const messages = [{ role: "system", content: "system prompt" }, ...longHistory(40)];
  const wide = prepareContext(messages, { windowTokens: 128_000, reserveTokens: 4352 });
  assert.equal(wide.droppedMessages.length, 0, "128k window fits the whole conversation");
  const narrow = prepareContext(messages, { windowTokens: 5000, reserveTokens: 4352 });
  assert.ok(narrow.droppedMessages.length > 0, "5k window must drop exchanges");
  const lastUser = narrow.messages.filter((m) => m.role === "user").at(-1);
  assert.equal(lastUser.content, "pesan 39 dari pengguna, tolong dicatat baik-baik");
});

test("buildSummaryMessage: starts with the marker so prepareContext can pin it", () => {
  const msg = buildSummaryMessage("ringkasan isi.");
  assert.equal(msg.role, "system");
  assert.ok(msg.content.startsWith(COMPACT_SUMMARY_MARKER));
  assert.ok(msg.content.includes("ringkasan isi."));
});

test("addUsage: null-safe, sums per-step usage into a turn total", () => {
  const step = { promptTokens: 100, completionTokens: 50, totalTokens: 150 };
  assert.deepEqual(addUsage(null, step), step);
  assert.equal(addUsage(null, null), null);
  assert.deepEqual(addUsage(step, null), step);
  assert.deepEqual(addUsage(step, { promptTokens: 200, completionTokens: 75, totalTokens: 275 }), {
    promptTokens: 300,
    completionTokens: 125,
    totalTokens: 425,
  });
});

// ---------------------------------------------------------------------------
// summarizeSegment
// ---------------------------------------------------------------------------

test("summarizeSegment: returns the model summary text", async () => {
  const adapter = new MockAdapter([{ chunks: [text("Ringkasan: pengguna bertanya banyak hal."), finish()] }]);
  const segment = [
    { role: "user", content: "pesan 0 dari pengguna" },
    { role: "assistant", content: "jawaban 0" },
  ];
  const summary = await summarizeSegment(segment, adapter, { apiKey: "test", model: "glm-5.3-flash" });
  assert.equal(summary, "Ringkasan: pengguna bertanya banyak hal.");
  // The summary request reuses the /compact prompt (role-prefixed lines).
  assert.ok(adapter.calls[0].messages[0].content.includes("USER: pesan 0 dari pengguna"));
});

test("summarizeSegment: provider error returns null (failure-safe, never throws)", async () => {
  const adapter = new MockAdapter([{ error: serverError(500) }]);
  const summary = await summarizeSegment(
    [{ role: "user", content: "pesan 0" }],
    adapter,
    { apiKey: "test", model: "glm-5.3-flash" },
  );
  assert.equal(summary, null);
});

test("summarizeSegment: pre-aborted signal returns null without calling the model", async () => {
  const adapter = new MockAdapter([{ chunks: [text("tidak akan dipakai")] }]);
  const ctl = new AbortController();
  ctl.abort();
  const summary = await summarizeSegment(
    [{ role: "user", content: "pesan 0" }],
    adapter,
    { apiKey: "test", model: "glm-5.3-flash", signal: ctl.signal },
  );
  assert.equal(summary, null);
  assert.equal(adapter.calls.length, 0);
});

test("summarizeSegment: empty summary returns null", async () => {
  const adapter = new MockAdapter([{ chunks: [text("   "), finish()] }]);
  const summary = await summarizeSegment(
    [{ role: "user", content: "pesan 0" }],
    adapter,
    { apiKey: "test", model: "glm-5.3-flash" },
  );
  assert.equal(summary, null);
});

test("summarizeSegment: empty segment returns null without calling the model", async () => {
  const adapter = new MockAdapter([{ chunks: [text("tidak akan dipakai")] }]);
  assert.equal(await summarizeSegment([], adapter, { apiKey: "test", model: "glm-5.3-flash" }), null);
  assert.equal(adapter.calls.length, 0);
});

// ---------------------------------------------------------------------------
// normalizeProviderError: the retry classifier (incl. the 408 timeout)
// ---------------------------------------------------------------------------

test("normalizeProviderError: 408/429/5xx are retryable, 400 is not, abort never retries", () => {
  const timeout = normalizeProviderError(new ApiError(408, "timeout"));
  assert.equal(timeout.kind, "server");
  assert.equal(timeout.retryable, true);
  assert.equal(normalizeProviderError(new ApiError(429, "rate limit")).retryable, true);
  assert.equal(normalizeProviderError(new ApiError(500, "boom")).retryable, true);
  assert.equal(normalizeProviderError(new ApiError(503, "boom")).retryable, true);
  const bad = normalizeProviderError(new ApiError(400, "bad request"));
  assert.equal(bad.retryable, false);
  const aborted = normalizeProviderError(abortErr());
  assert.equal(aborted.kind, "aborted");
  assert.equal(aborted.retryable, false);
  // collectChatText surfaces streamComplete for the loop's guard.
  assert.equal(typeof collectChatText, "function");
});

// ---------------------------------------------------------------------------
// Loop integration: usage, retry, stream completeness, finish reasons
// ---------------------------------------------------------------------------

test("loop: usage accumulates across steps into the turn total", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "hello.txt"), "hello fase7\n");
  const { result } = await runLoop(dir, [
    { chunks: [text(formatToolCall("read_files", { paths: ["hello.txt"] })), usage(100, 50)] },
    { chunks: [text("Selesai, file dibaca."), usage(200, 75)] },
  ]);
  assert.equal(result.completed, true);
  assert.deepEqual(result.usage, { promptTokens: 300, completionTokens: 125, totalTokens: 425 });
  assert.ok(result.context.estimatedTokens > 0);
  // One parsed call = exactly one execution (no duplication).
  assert.equal(result.executedToolCalls.length, 1);
  assert.deepEqual(
    result.executedToolCalls.map((e) => [e.step, e.index]),
    [[1, 0]],
  );
});

test("loop: two tool calls in one step execute once each, ledger keys unique", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.txt"), "aaa\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "bbb\n");
  const twoReads =
    formatToolCall("read_files", { paths: ["a.txt"] }) + "\n" + formatToolCall("read_files", { paths: ["b.txt"] });
  const { result } = await runLoop(dir, [
    { chunks: [text(twoReads)] },
    { chunks: [text("Selesai.")] },
  ]);
  assert.equal(result.completed, true);
  assert.equal(result.executedToolCalls.length, 2);
  assert.deepEqual(
    result.executedToolCalls.map((e) => `${e.step}:${e.index}`),
    ["1:0", "1:1"],
  );
  assert.equal(result.history.filter((m) => m.role === "tool").length, 2);
});

test("loop: retryable provider error retries up to 3 attempts, then succeeds", async () => {
  const dir = tmpDir();
  const { result, adapter } = await runLoop(dir, [
    { error: serverError(500) },
    { error: serverError(500) },
    { chunks: [text("Akhirnya berhasil.")] },
  ]);
  assert.equal(result.completed, true);
  assert.equal(result.steps, 1);
  assert.equal(adapter.calls.length, 3);
});

test("loop: non-retryable error is not retried", async () => {
  const dir = tmpDir();
  const bad = new AdapterError("client", "bad request", { status: 400, retryable: false });
  const { result, adapter } = await runLoop(dir, [{ error: bad }]);
  assert.equal(result.completed, false);
  assert.ok(result.stopReason.startsWith("model call failed"));
  assert.equal(adapter.calls.length, 1);
});

test("loop: timeout (408) is retryable and succeeds on the second attempt", async () => {
  const dir = tmpDir();
  const { result, adapter } = await runLoop(dir, [
    { error: serverError(408) },
    { chunks: [text("OK setelah timeout.")] },
  ]);
  assert.equal(result.completed, true);
  assert.equal(adapter.calls.length, 2);
});

test("loop: error AFTER partial streaming is not retried (no duplicated display)", async () => {
  const dir = tmpDir();
  const { result, adapter } = await runLoop(dir, [
    { chunks: [text("sebagian jawaban..."), { error: serverError(500) }] },
  ]);
  assert.equal(result.completed, false);
  assert.ok(result.stopReason.startsWith("model call failed"));
  assert.equal(adapter.calls.length, 1, "a retry would re-stream the partial text");
});

test("loop: stream that ends without finish/usage is incomplete — partial text never enters history", async () => {
  const dir = tmpDir();
  const { result } = await runLoop(dir, [
    { chunks: [text("sebagian jawaban yang terputus...")], truncate: true },
  ]);
  assert.equal(result.completed, false);
  assert.ok(result.stopReason.includes("stream ended"), result.stopReason);
  assert.equal(result.finalText, "");
  // History stays intact: system + user only, no partial assistant message.
  assert.equal(result.history.length, 2);
  assert.ok(!result.history.some((m) => m.content.includes("terputus")));
});

test("loop: finish reason length (no tool calls) stops explicitly, not as a normal answer", async () => {
  const dir = tmpDir();
  const { result } = await runLoop(dir, [
    { chunks: [text("jawaban yang terpotong di tengah...")], finishReason: "length" },
  ]);
  assert.equal(result.completed, false);
  assert.ok(result.stopReason.includes("cut off"), result.stopReason);
});

test("loop: finish reason content_filter stops explicitly", async () => {
  const dir = tmpDir();
  const { result } = await runLoop(dir, [
    { chunks: [text("")], finishReason: "content_filter" },
  ]);
  assert.equal(result.completed, false);
  assert.ok(result.stopReason.includes("content filter"), result.stopReason);
});

test("loop: finish reason length WITH a tool call still executes the call", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "hello.txt"), "hello fase7\n");
  const { result } = await runLoop(dir, [
    { chunks: [text(formatToolCall("read_files", { paths: ["hello.txt"] }))], finishReason: "length" },
    { chunks: [text("Selesai.")] },
  ]);
  assert.equal(result.completed, true);
  assert.equal(result.steps, 2);
  assert.equal(result.executedToolCalls.length, 1);
});

test("loop: pre-aborted signal (Ctrl+C before the call) interrupts, 0 model calls", async () => {
  const dir = tmpDir();
  const ctl = new AbortController();
  ctl.abort();
  const { result, adapter } = await runLoop(dir, [{ chunks: [text("tidak akan dipakai")] }], {
    signal: ctl.signal,
  });
  assert.equal(result.completed, false);
  assert.equal(result.stopReason, "interrupted by user");
  assert.equal(adapter.calls.length, 0);
});

test("loop: abort mid-stream (Ctrl+C) interrupts without retry", async () => {
  const dir = tmpDir();
  const ctl = new AbortController();
  const adapter = new MockAdapter([{ chunks: [text("mulai..."), { abortAfter: true }] }]);
  adapter.abortCtl = ctl;
  const result = await runAgentLoop({ ...baseOpts(dir, { signal: ctl.signal }), adapter });
  assert.equal(result.completed, false);
  assert.equal(result.stopReason, "interrupted by user");
  assert.equal(adapter.calls.length, 1, "an abort must never retry");
});

test("loop: streamed chunks assemble in order; reasoning never leaks into finalText", async () => {
  const dir = tmpDir();
  const { result } = await runLoop(dir, [
    { chunks: [text("Hel"), reasoning("mikir dulu"), text("lo"), text("!"), finish()] },
  ]);
  assert.equal(result.finalText, "Hello!");
  assert.equal(result.completed, true);
});

// ---------------------------------------------------------------------------
// Loop integration: long conversations, truncation, auto-compaction
// ---------------------------------------------------------------------------

test("loop: long conversation truncates the view, stored history keeps every tool message once", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "hello.txt"), "hello fallback\n");
  const restore = setWindow("fase7-small-window", LOOP_MAX_TOKENS + RESPONSE_RESERVE_MARGIN_TOKENS + 4000);
  try {
    const history = longHistory(120);
    // A tool exchange in the middle of the history.
    history.splice(
      120,
      0,
      { role: "user", content: "baca berkas hello.txt" },
      { role: "assistant", content: formatToolCall("read_files", { paths: ["hello.txt"] }) },
      { role: "tool", content: "hello fallback\n", tool_call_id: "call-1-0", name: "read_files" },
    );
    const { result, adapter } = await runLoop(
      dir,
      [
        { error: serverError(500) }, // summary attempt fails -> truncated view
        { chunks: [text("Baik, saya lanjut.")] },
      ],
      { model: "fase7-small-window", history, userPrompt: "lanjutkan dari yang terakhir" },
    );
    assert.equal(result.completed, true);
    assert.equal(result.context.compacted, false);
    assert.ok(result.context.droppedMessages > 0, "old exchanges must be dropped from the view");
    assert.equal(result.toolChannel, "xml-fallback", "XML fallback stays the channel in long conversations");
    // The turn's model call (calls[1]; calls[0] is the failed summary
    // attempt) got a SHORTER view than stored history, still ending
    // with the current prompt.
    const sent = adapter.calls[1].messages;
    assert.ok(sent.length < result.history.length, "the view is shorter than stored history");
    assert.equal(sent.at(-1).content, "lanjutkan dari yang terakhir");
    // Stored history keeps the tool exchange exactly once (no duplication).
    const storedTools = result.history.filter((m) => m.role === "tool");
    assert.equal(storedTools.length, 1);
    assert.equal(storedTools[0].content, "hello fallback\n");
    const storedCalls = result.history.filter(
      (m) => m.role === "assistant" && m.content.includes("read_files"),
    );
    assert.equal(storedCalls.length, 1);
  } finally {
    restore();
  }
});

test("loop: auto-compaction replaces the dropped segment with a summary (once per turn)", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "hello.txt"), "hello fallback\n");
  const restore = setWindow("fase7-compact-window", LOOP_MAX_TOKENS + RESPONSE_RESERVE_MARGIN_TOKENS + 4000);
  try {
    const history = longHistory(120);
    const { result, adapter } = await runLoop(
      dir,
      [
        { chunks: [text("Ringkasan: pengguna mencatat banyak pesan.")] },
        { chunks: [text("Baik, sudah diringkas.")] },
      ],
      { model: "fase7-compact-window", history, userPrompt: "lanjutkan dari yang terakhir" },
    );
    assert.equal(result.completed, true);
    assert.equal(result.context.compacted, true);
    assert.ok(result.context.droppedMessages > 0);
    // The summary call (calls[0]) received the dropped segment.
    assert.equal(adapter.calls[0].messages.length, 1);
    assert.equal(adapter.calls[0].messages[0].role, "user");
    assert.ok(adapter.calls[0].messages[0].content.includes("pesan 0 dari pengguna"));
    // Stored history: the summary sits right after the system prompt,
    // and the dropped messages are gone.
    assert.equal(result.history[0].role, "system");
    assert.ok(result.history[1].content.startsWith(COMPACT_SUMMARY_MARKER));
    assert.ok(result.history[1].content.includes("Ringkasan: pengguna mencatat banyak pesan."));
    assert.ok(!result.history.some((m) => m.content.includes("pesan 0 dari pengguna")));
    // The last exchanges survive, and the turn's view carries the summary.
    assert.ok(result.history.some((m) => m.content.includes("pesan 119 dari pengguna")));
    assert.ok(adapter.calls[1].messages[1].content.startsWith(COMPACT_SUMMARY_MARKER));
  } finally {
    restore();
  }
});

test("loop: giant tool result is truncated in the step-2 view, stored history keeps the full output", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "big.txt"), "x".repeat(40_000));
  const restore = setWindow("fase7-truncate-window", LOOP_MAX_TOKENS + RESPONSE_RESERVE_MARGIN_TOKENS + 3000);
  try {
    const { result, adapter } = await runLoop(
      dir,
      [
        { chunks: [text(formatToolCall("read_files", { paths: ["big.txt"] }))] },
        { chunks: [text("Selesai, file dibaca.")] },
      ],
      { model: "fase7-truncate-window", userPrompt: "baca big.txt lalu jawab selesai" },
    );
    assert.equal(result.completed, true);
    assert.equal(result.steps, 2);
    assert.equal(result.context.truncatedToolResults, 1);
    assert.equal(result.context.compacted, false);
    // The step-2 view truncates the giant tool result...
    const sentTool = adapter.calls[1].messages.find((m) => m.role === "tool");
    assert.ok(sentTool, "step 2 view still carries the tool result");
    assert.ok(sentTool.content.includes("output dipotong"));
    assert.ok(sentTool.content.length < 5000);
    // ...while stored history keeps the full 40k output.
    const storedTool = result.history.find((m) => m.role === "tool");
    assert.ok(storedTool.content.length > 39_000);
    assert.ok(storedTool.content.includes("x".repeat(1000)));
  } finally {
    restore();
  }
});
