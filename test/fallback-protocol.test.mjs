// Fallback Tool Protocol — Fase 6 tests.
//
// These tests prove the formalized fallback protocol (docs/TOOL-CALL-PROTOCOL.md):
//
//   - routing: native ONLY when nativeToolCalling is proven SUPPORTED;
//     UNKNOWN / UNSUPPORTED / provider-config-only all route to the
//     XML fallback (UNKNOWN is never treated as SUPPORTED);
//   - the 2x rule: two consecutive protocol violations (malformed
//     JSON, unclosed tag, unknown tool, schema-invalid params,
//     promised-but-missing calls) stop the turn with an explicit
//     message to the user — not a silent end, not a 40-step burn;
//   - a handler error is NOT a violation: the call ran, the tool
//     failed, the turn continues with an ordinary retry;
//   - a validation failure never executes: it leaves no ledger
//     entry, so a later fixed retry executes exactly once;
//   - a mixed step (one valid + one invalid call) executes the
//     valid one and resets the violation streak;
//   - a plain answer still completes normally; conversation
//     continues after tool results.
//
// MockAdapter drives the loop without network (same pattern as
// test/agent-loop.test.mjs). The XML path itself is covered by
// test/agent.test.mjs; this file covers the PROTOCOL around it.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runAgentLoop } from "../dist/agent/loop.js";
import { formatToolCall } from "../dist/agent/xml-parser.js";
import {
  PROTOCOL_FAILURE_LIMIT,
  channelForModel,
  createProtocolTracker,
  isProtocolViolationResult,
  protocolFailureMessage,
  resolveToolChannel,
} from "../dist/agent/fallback-protocol.js";
import {
  getCapabilityRecord,
  setCapability,
} from "../dist/agent/model-capabilities.js";

function tmpDirWithFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "methatech-fallback-"));
  fs.writeFileSync(path.join(dir, "hello.txt"), "hello fallback\n");
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Mock ModelAdapter: scripted steps (same shape as agent-loop tests). */
class MockAdapter {
  id = "mock";
  calls = [];
  #script;
  #step = 0;

  constructor(script) {
    this.#script = script;
  }

  async *chat(request) {
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
const call = (tool, input) => text(formatToolCall(tool, input));
const validRead = (dir) => call("read_files", { paths: [path.join(dir, "hello.txt")] });

async function runLoop(dir, script, model = "glm-5.3-flash") {
  const adapter = new MockAdapter(script);
  const result = await runAgentLoop({
    apiKey: "test-key",
    model,
    cwd: dir,
    mode: "DEFAULT",
    userPrompt: "do the thing",
    adapter,
  });
  return { result, adapter };
}

// ---------------------------------------------------------------------------
// Routing: capability → channel
// ---------------------------------------------------------------------------

test("routing: UNKNOWN native capability routes to the XML fallback", () => {
  // glm-5.3-flash is seeded all-UNKNOWN (except streaming): never native.
  assert.equal(resolveToolChannel(getCapabilityRecord("glm-5.3-flash")), "xml-fallback");
  assert.equal(channelForModel("glm-5.3-flash"), "xml-fallback");
});

test("routing: UNSUPPORTED native capability routes to the XML fallback", () => {
  setCapability("routing-unsupported-model", { nativeToolCalling: "UNSUPPORTED" }, "probe-live");
  assert.equal(channelForModel("routing-unsupported-model"), "xml-fallback");
});

test("routing: SUPPORTED from provider-config only is NOT proof — still fallback", () => {
  // A config claim is not a live probe: isCapabilityProven() is false,
  // so routing must not send this model down the native path.
  setCapability("routing-config-model", { nativeToolCalling: "SUPPORTED" }, "provider-config");
  assert.equal(channelForModel("routing-config-model"), "xml-fallback");
});

test("routing: SUPPORTED from a live probe routes to native", () => {
  setCapability("routing-probe-model", { nativeToolCalling: "SUPPORTED" }, "probe-live");
  assert.equal(channelForModel("routing-probe-model"), "native");
});

test("routing: unlisted model is all-UNKNOWN, routes to the fallback", () => {
  assert.equal(channelForModel("definitely-not-a-real-model-xyz"), "xml-fallback");
});

// ---------------------------------------------------------------------------
// Protocol tracker + message
// ---------------------------------------------------------------------------

test("tracker: one violation does not stop, two do, an execution resets", () => {
  const t = createProtocolTracker();
  assert.equal(t.shouldStop(), false);
  t.recordViolation();
  assert.equal(t.violations, 1);
  assert.equal(t.shouldStop(), false);
  t.recordExecution();
  assert.equal(t.violations, 0);
  assert.equal(t.shouldStop(), false);
  t.recordViolation();
  t.recordViolation();
  assert.equal(t.shouldStop(), true);
  assert.equal(PROTOCOL_FAILURE_LIMIT, 2);
});

test("protocolFailureMessage names the model, the detail, and the guidance", () => {
  const m = protocolFailureMessage("glm-5.3-flash", "malformed tool-call JSON");
  assert.match(m, /glm-5\.3-flash/);
  assert.match(m, /malformed tool-call JSON/);
  assert.match(m, /2 attempts/);
  assert.match(m, /Try a different model/);
});

test("isProtocolViolationResult: only validation failures are violations", () => {
  const base = { tool: "read_files", index: 0, ok: false, output: "x" };
  assert.equal(isProtocolViolationResult({ ...base, failureKind: "validation" }), true);
  assert.equal(isProtocolViolationResult({ ...base, failureKind: "execution" }), false);
  assert.equal(isProtocolViolationResult({ ...base, failureKind: "timeout" }), false);
  assert.equal(isProtocolViolationResult({ ...base, ok: true, failureKind: null }), false);
});

// ---------------------------------------------------------------------------
// Loop: the fallback channel executes valid XML calls
// ---------------------------------------------------------------------------

test("loop: model without native calling runs through the XML fallback", async () => {
  const dir = tmpDirWithFile();
  const { result, adapter } = await runLoop(dir, [
    { chunks: [validRead(dir), text("\n"), call("task_completed", { summary: "done" })] },
  ]);
  assert.equal(result.toolChannel, "xml-fallback");
  assert.equal(result.completed, true);
  assert.equal(result.executedToolCalls.length, 2);
  assert.equal(adapter.calls.length, 1);
  // No native tools were ever sent: the adapter request has no tools.
  assert.equal(adapter.calls[0].tools, undefined);
});

// ---------------------------------------------------------------------------
// Loop: the 2x rule — malformed, unclosed, unknown, schema-invalid
// ---------------------------------------------------------------------------

test("loop: malformed tool-call JSON twice stops explicitly, no execution, no 40-step burn", async () => {
  const dir = tmpDirWithFile();
  const bad = text('<codebuff_tool_call>{"cb_tool_name": "read_files", broken json</codebuff_tool_call>');
  const { result, adapter } = await runLoop(dir, [{ chunks: [bad] }, { chunks: [bad] }]);
  assert.equal(adapter.calls.length, 2);
  assert.equal(result.completed, false);
  assert.match(result.stopReason, /protocol violation/);
  assert.match(result.finalText, /did not follow the tool-call format/);
  assert.match(result.finalText, /malformed tool-call JSON/);
  assert.equal(result.executedToolCalls.length, 0);
});

test("loop: unclosed tool-call tag twice stops explicitly", async () => {
  const dir = tmpDirWithFile();
  const bad = text('<codebuff_tool_call>{"cb_tool_name": "read_files", "paths": ["hello.txt"]}');
  const { result, adapter } = await runLoop(dir, [{ chunks: [bad] }, { chunks: [bad] }]);
  assert.equal(adapter.calls.length, 2);
  assert.equal(result.completed, false);
  assert.match(result.stopReason, /protocol violation/);
  assert.match(result.finalText, /unclosed tool-call tag/);
  assert.equal(result.executedToolCalls.length, 0);
});

test("loop: unknown tool twice stops explicitly, ledger stays empty", async () => {
  const dir = tmpDirWithFile();
  const bad = call("teleport", { where: "nowhere" });
  const { result, adapter } = await runLoop(dir, [{ chunks: [bad] }, { chunks: [bad] }]);
  assert.equal(adapter.calls.length, 2);
  assert.equal(result.completed, false);
  assert.match(result.stopReason, /protocol violation/);
  assert.match(result.finalText, /unknown tool/);
  assert.equal(result.executedToolCalls.length, 0);
});

test("loop: schema-invalid params twice stops explicitly", async () => {
  const dir = tmpDirWithFile();
  // paths must be an array; a string fails registry schema validation.
  const bad = call("read_files", { paths: "hello.txt" });
  const { result, adapter } = await runLoop(dir, [{ chunks: [bad] }, { chunks: [bad] }]);
  assert.equal(adapter.calls.length, 2);
  assert.equal(result.completed, false);
  assert.match(result.stopReason, /protocol violation/);
  assert.match(result.finalText, /invalid tool-call parameters/);
  assert.equal(result.executedToolCalls.length, 0);
});

test("loop: one violation then a fixed call continues and completes", async () => {
  const dir = tmpDirWithFile();
  const bad = call("read_files", { paths: "hello.txt" });
  const { result, adapter } = await runLoop(dir, [
    { chunks: [bad] },
    { chunks: [validRead(dir), text("\n"), call("task_completed", { summary: "done" })] },
  ]);
  assert.equal(result.completed, true);
  assert.equal(adapter.calls.length, 2);
  // The failed validation never executed: exactly one ledger entry
  // for the fixed call (plus task_completed).
  assert.equal(result.executedToolCalls.filter((e) => e.tool === "read_files").length, 1);
});

// ---------------------------------------------------------------------------
// Loop: handler errors are NOT protocol violations
// ---------------------------------------------------------------------------

test("loop: tool execution errors do not trigger a protocol stop", async () => {
  const dir = tmpDirWithFile();
  // read_files on a missing file: the call is valid, the handler fails.
  const missing = call("read_files", { paths: [path.join(dir, "nope.txt")] });
  const { result, adapter } = await runLoop(dir, [
    { chunks: [missing] },
    { chunks: [text("The file does not exist, nothing more to do.")] },
  ]);
  assert.equal(result.completed, true);
  assert.equal(result.stopReason, "no more tool calls");
  assert.equal(adapter.calls.length, 2);
  // The call RAN (and failed): it is in the ledger.
  assert.equal(result.executedToolCalls.length, 1);
  assert.equal(result.executedToolCalls[0].tool, "read_files");
  assert.equal(result.executedToolCalls[0].ok, false);
});

// ---------------------------------------------------------------------------
// Loop: retry without duplication; mixed steps reset the streak
// ---------------------------------------------------------------------------

test("loop: retry after a validation failure executes exactly once", async () => {
  const dir = tmpDirWithFile();
  const bad = call("read_files", { paths: "hello.txt" });
  const { result } = await runLoop(dir, [
    { chunks: [bad] },
    { chunks: [validRead(dir)] },
    { chunks: [text("done, file read.")] },
  ]);
  assert.equal(result.completed, true);
  const reads = result.executedToolCalls.filter((e) => e.tool === "read_files");
  assert.equal(reads.length, 1);
  assert.equal(reads[0].ok, true);
});

test("loop: mixed step (one valid + one invalid) executes the valid call and resets the streak", async () => {
  const dir = tmpDirWithFile();
  const mixed = text(formatToolCall("read_files", { paths: [path.join(dir, "hello.txt")] }) + "\n" + formatToolCall("teleport", {}));
  const { result } = await runLoop(dir, [
    { chunks: [mixed] },
    { chunks: [text("done.")] },
  ]);
  assert.equal(result.completed, true);
  assert.equal(result.stopReason, "no more tool calls");
  // Only the valid call is in the ledger; the unknown tool never ran.
  assert.equal(result.executedToolCalls.length, 1);
  assert.equal(result.executedToolCalls[0].tool, "read_files");
});

// ---------------------------------------------------------------------------
// Loop: promised-but-missing calls, plain answers, continuation
// ---------------------------------------------------------------------------

test("loop: promised tool work but no call, twice, stops explicitly", async () => {
  const dir = tmpDirWithFile();
  const promise = text("Saya akan cek proyeknya sekarang");
  const { result, adapter } = await runLoop(dir, [
    { chunks: [promise] },
    { chunks: [promise] },
    { chunks: [promise] },
  ]);
  // Two nudges consumed, third promise still no call → protocol stop.
  assert.equal(adapter.calls.length, 3);
  assert.equal(result.completed, false);
  assert.match(result.stopReason, /protocol violation/);
  assert.match(result.finalText, /promised tool work/);
  assert.equal(result.executedToolCalls.length, 0);
});

test("loop: plain answer with no promise still completes normally", async () => {
  const dir = tmpDirWithFile();
  const { result } = await runLoop(dir, [{ chunks: [text("Here is the answer: 4.")] }]);
  assert.equal(result.completed, true);
  assert.equal(result.stopReason, "no more tool calls");
  assert.equal(result.toolChannel, "xml-fallback");
});

test("loop: conversation continues after a tool result is returned", async () => {
  const dir = tmpDirWithFile();
  const { result } = await runLoop(dir, [
    { chunks: [validRead(dir)] },
    { chunks: [text("The file says hello. "), call("task_completed", { summary: "read it" })] },
  ]);
  assert.equal(result.completed, true);
  assert.equal(result.stopReason, "task_completed");
  assert.equal(result.executedToolCalls.length, 2);
  // History keeps the assistant's raw XML call and the tool result.
  // Step 2 also inserts the [step 2] system reminder (loop.ts).
  const roles = result.history.map((m) => m.role);
  assert.deepEqual(roles, ["system", "user", "assistant", "tool", "system", "assistant", "tool"]);
});
