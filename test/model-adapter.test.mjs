// Unit tests for the Universal Model Adapter (Universal Agent
// Runtime, Fase 2). The adapter is the single contract between the
// agent loop and the model transport: normalized chunk stream,
// normalized errors, fail-loud rejection of native tools (Fase 5).
// The transport is injected (Freebuff AGENTS.md: prefer dependency
// injection over module mocking), so tests use fakes, no network.
// Run after build: npm run build && npm test
import test from "node:test";
import assert from "node:assert/strict";

import { ApiError } from "../dist/api.js";
import {
  AdapterError,
  PanelChatAdapter,
  collectChatText,
  createDefaultAdapter,
  mapFinishReason,
  normalizeProviderError,
} from "../dist/agent/model-adapter.js";

function fakeTransport(chunks) {
  return async (_apiKey, _model, _messages, handlers, _maxTokens, _opts) => {
    for (const c of chunks) {
      if (c.type === "text") handlers.onDelta(c.text);
      else if (c.type === "reasoning") handlers.onReasoning?.(c.text);
      else if (c.type === "usage") handlers.onUsage(c.usage);
      else if (c.type === "finish") handlers.onFinishReason?.(c.reason);
    }
    return { usage: null };
  };
}

test("adapter: mapFinishReason follows the OpenAI finish_reason values", () => {
  assert.equal(mapFinishReason("stop"), "stop");
  assert.equal(mapFinishReason("length"), "length");
  assert.equal(mapFinishReason("tool_calls"), "tool_calls");
  assert.equal(mapFinishReason("function_call"), "tool_calls");
  assert.equal(mapFinishReason("content_filter"), "content_filter");
  assert.equal(mapFinishReason(null), "unknown");
  assert.equal(mapFinishReason(undefined), "unknown");
  assert.equal(mapFinishReason(""), "unknown");
  assert.equal(mapFinishReason("something_new"), "unknown");
});

test("adapter: normalizeProviderError maps ApiError by HTTP status", () => {
  const auth = normalizeProviderError(new ApiError(401, "API key tidak valid. Jalankan: methatech login"));
  assert.equal(auth.kind, "auth");
  assert.equal(auth.retryable, false);
  assert.equal(auth.status, 401);
  assert.match(auth.message, /login/);

  const quota = normalizeProviderError(new ApiError(402, "Saldo dan free credits habis."));
  assert.equal(quota.kind, "quota");
  assert.equal(quota.retryable, false);

  const rate = normalizeProviderError(new ApiError(429, "Terlalu banyak request"));
  assert.equal(rate.kind, "rate_limit");
  assert.equal(rate.retryable, true);

  for (const status of [408, 500, 502, 503, 504]) {
    const server = normalizeProviderError(new ApiError(status, `API error ${status}`));
    assert.equal(server.kind, "server", `status ${status}`);
    assert.equal(server.retryable, true, `status ${status}`);
  }

  const other = normalizeProviderError(new ApiError(400, "bad request"));
  assert.equal(other.kind, "unknown");
  assert.equal(other.retryable, false);
});

test("adapter: normalizeProviderError maps aborts, network failures, and unknowns", () => {
  const abort = new Error("The operation was aborted");
  abort.name = "AbortError";
  assert.equal(normalizeProviderError(abort).kind, "aborted");
  assert.equal(normalizeProviderError(abort).retryable, false);

  const network = new TypeError("fetch failed");
  const n = normalizeProviderError(network);
  assert.equal(n.kind, "network");
  assert.equal(n.retryable, true);

  const plain = normalizeProviderError(new Error("boom"));
  assert.equal(plain.kind, "unknown");
  assert.equal(plain.retryable, false);

  const already = new AdapterError("quota", "custom");
  assert.equal(normalizeProviderError(already), already);
  assert.equal(normalizeProviderError("weird string").kind, "unknown");
});

test("adapter: PanelChatAdapter yields normalized chunks in order", async () => {
  const transport = fakeTransport([
    { type: "text", text: "Hello " },
    { type: "text", text: "world" },
    { type: "reasoning", text: "thinking..." },
    { type: "usage", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    { type: "finish", reason: "stop" },
  ]);
  const adapter = new PanelChatAdapter(transport);
  assert.equal(adapter.id, "panel-openai-compatible");
  const chunks = [];
  for await (const c of adapter.chat({ apiKey: "k", model: "m", messages: [{ role: "user", content: "hi" }] })) {
    chunks.push(c);
  }
  assert.deepEqual(chunks, [
    { type: "text", text: "Hello " },
    { type: "text", text: "world" },
    { type: "reasoning", text: "thinking..." },
    { type: "usage", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    { type: "finish", reason: "stop" },
  ]);
});

test("adapter: finish chunk is only emitted when the server sent a finish reason", async () => {
  const noFinish = new PanelChatAdapter(fakeTransport([{ type: "text", text: "x" }]));
  const chunks = [];
  for await (const c of noFinish.chat({ apiKey: "k", model: "m", messages: [] })) chunks.push(c);
  assert.deepEqual(chunks, [{ type: "text", text: "x" }]);
  assert.equal(chunks.some((c) => c.type === "finish"), false);
});

test("adapter: collectChatText concatenates and forwards deltas", async () => {
  const adapter = new PanelChatAdapter(
    fakeTransport([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
      { type: "reasoning", text: "r1" },
      { type: "reasoning", text: "r2" },
      { type: "usage", usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } },
      { type: "finish", reason: "length" },
    ]),
  );
  const seenText = [];
  const seenReasoning = [];
  const result = await collectChatText(
    adapter,
    { apiKey: "k", model: "m", messages: [{ role: "user", content: "hi" }] },
    { onDelta: (d) => seenText.push(d), onReasoning: (r) => seenReasoning.push(r) },
  );
  assert.equal(result.text, "ab");
  assert.equal(result.reasoning, "r1r2");
  assert.deepEqual(result.usage, { promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  assert.equal(result.finishReason, "length");
  assert.deepEqual(seenText, ["a", "b"]);
  assert.deepEqual(seenReasoning, ["r1", "r2"]);
});

test("adapter: native tools are rejected fail-loud in Fase 2", async () => {
  const adapter = createDefaultAdapter(fakeTransport([]));
  await assert.rejects(
    () =>
      collectChatText(adapter, {
        apiKey: "k",
        model: "m",
        messages: [],
        tools: [{ type: "function", function: { name: "read_files", description: "d", parameters: { type: "object", properties: {} } } }],
      }),
    (e) => {
      assert.ok(e instanceof AdapterError);
      assert.match(e.message, /not wired yet/);
      return true;
    },
  );
});

test("adapter: transport errors surface as normalized AdapterError", async () => {
  const failing = async () => {
    throw new ApiError(429, "Terlalu banyak request / model sibuk (x)");
  };
  const adapter = new PanelChatAdapter(failing);
  await assert.rejects(
    () => collectChatText(adapter, { apiKey: "k", model: "m", messages: [] }),
    (e) => {
      assert.ok(e instanceof AdapterError);
      assert.equal(e.kind, "rate_limit");
      assert.equal(e.retryable, true);
      return true;
    },
  );
});

test("adapter: an already-aborted signal normalizes to kind aborted", async () => {
  const ctl = new AbortController();
  ctl.abort();
  const adapter = new PanelChatAdapter(async (_a, _m, _msgs, _h, _t, opts) => {
    // streamChat rejects with AbortError when the signal is aborted.
    if (opts?.signal?.aborted) {
      const e = new Error("The operation was aborted");
      e.name = "AbortError";
      throw e;
    }
    return { usage: null };
  });
  await assert.rejects(
    () => collectChatText(adapter, { apiKey: "k", model: "m", messages: [], signal: ctl.signal }),
    (e) => {
      assert.ok(e instanceof AdapterError);
      assert.equal(e.kind, "aborted");
      return true;
    },
  );
});

test("adapter: breaking out of the iteration aborts the transport", async () => {
  let sawAbort = false;
  const hanging = async (_a, _m, _msgs, _h, _t, opts) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5000);
      opts?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          sawAbort = true;
          const e = new Error("The operation was aborted");
          e.name = "AbortError";
          reject(e);
        },
        { once: true },
      );
    });
    return { usage: null };
  };
  const adapter = new PanelChatAdapter(hanging);
  const iter = adapter
    .chat({ apiKey: "k", model: "m", messages: [{ role: "user", content: "hi" }] })
    [Symbol.asyncIterator]();
  const collecting = (async () => {
    for await (const _c of { [Symbol.asyncIterator]: () => iter }) {
      // The transport never yields; this loop only ends via break.
    }
  })();
  await new Promise((r) => setTimeout(r, 50));
  await iter.return();
  await Promise.race([
    collecting,
    new Promise((_, rej) => setTimeout(() => rej(new Error("iteration did not finish after break")), 1000)),
  ]);
  assert.equal(sawAbort, true);
});

// ---------------------------------------------------------------------------
// Fase 9 — probe-only native tool calling (probeNativeTools)
// ---------------------------------------------------------------------------

const PROBE_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Return the current time as an ISO string.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_note",
      description: "Read a note by name.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
  },
];

/** Fake transport for probe tests: records the probe options and
 *  replays scripted handler events (tool-call deltas included). */
function probeTransport(capture, events) {
  return async (_apiKey, _model, _messages, handlers, _maxTokens, opts) => {
    capture.tools = opts?.tools;
    capture.responseFormat = opts?.responseFormat;
    for (const ev of events) {
      if (ev.type === "tool_call_delta") handlers.onToolCallDelta?.(ev.delta);
      else if (ev.type === "text") handlers.onDelta(ev.text);
      else if (ev.type === "finish") handlers.onFinishReason?.(ev.reason);
      else if (ev.type === "usage") handlers.onUsage(ev.usage);
      else if (ev.type === "error") throw ev.error;
    }
    return { usage: null };
  };
}

test("adapter (Fase 9 probe): rejection message names the probe opt-in", async () => {
  const adapter = createDefaultAdapter(fakeTransport([]));
  await assert.rejects(
    () =>
      collectChatText(adapter, {
        apiKey: "k",
        model: "m",
        messages: [],
        tools: PROBE_TOOLS,
      }),
    (e) => {
      assert.ok(e instanceof AdapterError);
      assert.match(e.message, /not wired yet/);
      assert.match(e.message, /probeNativeTools/);
      return true;
    },
  );
});

test("adapter (Fase 9 probe): probeNativeTools sends tools and emits complete tool_call chunks", async () => {
  const capture = {};
  const adapter = new PanelChatAdapter(
    probeTransport(capture, [
      { type: "tool_call_delta", delta: { index: 0, id: "call_1", name: "get_current_time", arguments: '{"' } },
      { type: "tool_call_delta", delta: { index: 0, arguments: '}"' } },
      { type: "tool_call_delta", delta: { index: 1, id: "call_2", name: "read_note", arguments: '{"name": "welcome"}' } },
      { type: "finish", reason: "tool_calls" },
    ]),
  );
  const chunks = [];
  for await (const c of adapter.chat({
    apiKey: "k",
    model: "m",
    messages: [{ role: "user", content: "call both tools" }],
    tools: PROBE_TOOLS,
    probeNativeTools: true,
  })) {
    chunks.push(c);
  }
  assert.deepEqual(capture.tools, PROBE_TOOLS);
  const complete = chunks.filter((c) => c.type === "tool_call" && c.complete === true);
  assert.equal(complete.length, 2);
  assert.deepEqual(complete, [
    { type: "tool_call", id: "call_1", index: 0, name: "get_current_time", arguments: '{"}"', complete: true },
    { type: "tool_call", id: "call_2", index: 1, name: "read_note", arguments: '{"name": "welcome"}', complete: true },
  ]);
  // Fragmented arguments accumulate across deltas.
  const deltas = chunks.filter((c) => c.type === "tool_call" && c.complete === false);
  assert.equal(deltas.length, 3);
  assert.equal(deltas[1].arguments, '{"}"');
  assert.equal(chunks.at(-1).type, "finish");
  assert.equal(chunks.at(-1).reason, "tool_calls");
});

test("adapter (Fase 9 probe): tool-call arguments accumulate per index, interleaved", async () => {
  const adapter = new PanelChatAdapter(
    probeTransport({}, [
      { type: "tool_call_delta", delta: { index: 1, id: "c2", name: "read_note", arguments: '{"na' } },
      { type: "tool_call_delta", delta: { index: 0, id: "c1", name: "get_current_time", arguments: "{}" } },
      { type: "tool_call_delta", delta: { index: 1, arguments: 'me": "x"}' } },
      { type: "finish", reason: "tool_calls" },
    ]),
  );
  const chunks = [];
  for await (const c of adapter.chat({
    apiKey: "k",
    model: "m",
    messages: [],
    tools: PROBE_TOOLS,
    probeNativeTools: true,
  })) {
    chunks.push(c);
  }
  const complete = chunks.filter((c) => c.type === "tool_call" && c.complete === true);
  assert.equal(complete.length, 2);
  assert.equal(complete[0].index, 0);
  assert.equal(complete[0].arguments, "{}");
  assert.equal(complete[1].index, 1);
  assert.equal(complete[1].arguments, '{"name": "x"}');
});

test("adapter (Fase 9 probe): a failed transport emits no complete tool_call chunk", async () => {
  const adapter = new PanelChatAdapter(
    probeTransport({}, [
      { type: "tool_call_delta", delta: { index: 0, id: "c1", name: "get_current_time", arguments: '{"' } },
      { type: "error", error: new ApiError(503, "upstream down") },
    ]),
  );
  const chunks = [];
  await assert.rejects(
    (async () => {
      for await (const c of adapter.chat({
        apiKey: "k",
        model: "m",
        messages: [],
        tools: PROBE_TOOLS,
        probeNativeTools: true,
      })) {
        chunks.push(c);
      }
    })(),
    (e) => {
      assert.ok(e instanceof AdapterError);
      assert.equal(e.kind, "server");
      return true;
    },
  );
  assert.equal(chunks.filter((c) => c.type === "tool_call" && c.complete === true).length, 0);
  assert.equal(chunks.filter((c) => c.type === "tool_call" && c.complete === false).length, 1);
});

test("adapter (Fase 9 probe): responseFormat passes through to the transport", async () => {
  const capture = {};
  const adapter = new PanelChatAdapter(
    probeTransport(capture, [
      { type: "text", text: '{"ok": true}' },
      { type: "finish", reason: "stop" },
    ]),
  );
  const result = await collectChatText(adapter, {
    apiKey: "k",
    model: "m",
    messages: [{ role: "user", content: "reply json" }],
    responseFormat: { type: "json_object" },
  });
  assert.deepEqual(capture.responseFormat, { type: "json_object" });
  assert.equal(capture.tools, undefined);
  assert.equal(result.text, '{"ok": true}');
  assert.equal(result.finishReason, "stop");
});

test("adapter (Fase 9 probe): collectChatText ignores tool_call chunks (loop behavior unchanged)", async () => {
  const adapter = new PanelChatAdapter(
    probeTransport({}, [
      { type: "tool_call_delta", delta: { index: 0, id: "c1", name: "get_current_time", arguments: "{}" } },
      { type: "text", text: "done" },
      { type: "finish", reason: "tool_calls" },
    ]),
  );
  const result = await collectChatText(adapter, {
    apiKey: "k",
    model: "m",
    messages: [],
    tools: PROBE_TOOLS,
    probeNativeTools: true,
  });
  assert.equal(result.text, "done");
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.streamComplete, true);
});
