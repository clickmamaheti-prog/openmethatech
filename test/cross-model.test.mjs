// Universal Agent Runtime — Fase 9 Cross-Model Testing.
//
// These tests prove the runtime behaves the SAME across models,
// not just on one proven model:
//
//   - the loop never sends native tools (XML stays the default) no
//     matter which model id runs, and reports the channel it
//     actually executed (Fase 9 bug fix: the recorded toolChannel
//     used to follow the registry resolution, so seeding native
//     SUPPORTED would have made the loop claim "native" while
//     still executing XML);
//   - channel resolution stays honest (native only when a live
//     probe proved it);
//   - Fase 8 security enforcement (shell validation, secret
//     redaction) is identical for every model;
//   - XML fallback, protocol-violation stops, truncated-stream
//     handling and long-history consistency are identical for
//     every model.
//
// MockAdapter only — no network. Live per-model evidence comes
// from the Fase 9 probe run (docs/UNIVERSAL-RUNTIME-PHASE9.md).
// Run after build: npm run build && npm test

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runAgentLoop } from "../dist/agent/loop.js";
import { channelForModel, resolveToolChannel } from "../dist/agent/fallback-protocol.js";
import { getCapabilityRecord, setCapability } from "../dist/agent/model-capabilities.js";
import { formatToolCall } from "../dist/agent/xml-parser.js";

// --- Dummy credentials (never real) --------------------------------------

const tag = randomBytes(6).toString("hex");
const DUMMY_KEY = `sk-dummy-${tag}-0123456789abcdef`;
const DUMMY_PRIV = `-----BEGIN DUMMY PRIVATE KEY-----\n${tag}\n-----END DUMMY PRIVATE KEY-----`;

function tmpDir(prefix = "methatech-xmodel-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// --- MockAdapter (same contract as test/agent-loop.test.mjs) --------------

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
      yield chunk;
    }
    if (step.truncate !== true && !step.chunks.some((c) => c.type === "finish" || c.type === "usage")) {
      yield { type: "finish", reason: step.finishReason ?? "stop" };
    }
  }
}

const text = (t) => ({ type: "text", text: t });
const finish = (reason = "stop") => ({ type: "finish", reason });

function baseOpts(dir, model, overrides = {}) {
  return {
    apiKey: DUMMY_KEY,
    model,
    cwd: dir,
    mode: "DEFAULT",
    userPrompt: "kerjakan tugas",
    ...overrides,
  };
}

// --- Channel: loop never probes, reports what it executed -----------------

const CHANNEL_MODELS = ["glm-5.3-flash", "deepseek-v4-flash", "claude-sonnet-4-6"];

test("cross-model: the loop never sends native tools — XML stays the default for every model", async () => {
  for (const model of CHANNEL_MODELS) {
    const dir = tmpDir();
    try {
      const adapter = new MockAdapter([{ chunks: [text("Selesai."), finish()] }]);
      const result = await runAgentLoop(baseOpts(dir, model, { adapter }));
      assert.equal(result.completed, true, model);
      assert.equal(result.toolChannel, "xml-fallback", `${model}: channel actually executed`);
      assert.equal(adapter.calls.length, 1, model);
      assert.equal(adapter.calls[0].tools, undefined, `${model}: no tools sent`);
      assert.equal(adapter.calls[0].probeNativeTools, undefined, `${model}: no probe opt-in`);
      assert.equal(adapter.calls[0].responseFormat, undefined, `${model}: no response_format`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("cross-model: channel resolution is honest — native only when a live probe proved it", () => {
  // deepseek-v4-pro and gpt-6.1-terra are outside the Fase 9 probe
  // subset; this file runs in its own process, so the mutations
  // below stay local to this file.
  assert.equal(channelForModel("deepseek-v4-pro"), "xml-fallback");
  assert.equal(channelForModel("gpt-6.1-terra"), "xml-fallback");

  const proven = setCapability("deepseek-v4-pro", { nativeToolCalling: "SUPPORTED" }, "probe-live");
  assert.equal(resolveToolChannel(proven), "native");

  // A provider-config SUPPORTED is not proof: routing stays XML.
  const configured = setCapability("gpt-6.1-terra", { nativeToolCalling: "SUPPORTED" }, "provider-config");
  assert.equal(resolveToolChannel(configured), "xml-fallback");
  assert.equal(channelForModel("gpt-6.1-terra"), "xml-fallback");
});

test("cross-model: the loop reports xml-fallback even for a native-proven record (Fase 9 fix)", async () => {
  // Regression test for the Fase 9 bug: before the fix the loop
  // recorded channelForModel(model), so seeding native SUPPORTED
  // for a model made the result claim "native" while the turn
  // still executed XML. The loop must report what it executed.
  setCapability("deepseek-v4-pro", { nativeToolCalling: "SUPPORTED" }, "probe-live");
  assert.equal(channelForModel("deepseek-v4-pro"), "native");
  const dir = tmpDir();
  try {
    const adapter = new MockAdapter([{ chunks: [text("Selesai."), finish()] }]);
    const result = await runAgentLoop(baseOpts(dir, "deepseek-v4-pro", { adapter }));
    assert.equal(result.toolChannel, "xml-fallback");
    assert.equal(adapter.calls[0].tools, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Security: identical enforcement for every model ----------------------

test("cross-model: shell validation and secret redaction are identical for every model", async () => {
  for (const model of ["glm-5.3-flash", "claude-sonnet-4-6"]) {
    const dir = tmpDir();
    try {
      const shellCall = formatToolCall("run_terminal_command", { command: "cat ~/.ssh/id_ed25519" });
      const adapter = new MockAdapter([
        { chunks: [text(shellCall), finish()] },
        // The model "helpfully" echoes the session key in its reply.
        { chunks: [text(`Selesai. Kunci sesi ini ${DUMMY_KEY} jangan disebar.`), finish()] },
      ]);
      const result = await runAgentLoop(baseOpts(dir, model, { adapter }));
      assert.equal(result.completed, true, model);
      assert.equal(result.stopReason, "no more tool calls", model);
      // The blocked call executed (handler ran, validation refused)
      // and is recorded in the ledger as a failure — never silently
      // dropped, never actually run.
      assert.equal(result.executedToolCalls.length, 1, model);
      assert.equal(result.executedToolCalls[0].tool, "run_terminal_command", model);
      assert.equal(result.executedToolCalls[0].ok, false, model);
      const toolMsg = result.history.find((m) => m.role === "tool");
      assert.ok(toolMsg, `${model}: tool result in history`);
      assert.match(toolMsg.content, /blocked: references a credential location under/, model);
      assert.doesNotMatch(toolMsg.content, new RegExp(DUMMY_PRIV.slice(0, 12)), model);
      // The echoed session key is redacted from the visible text.
      assert.doesNotMatch(result.finalText, new RegExp(DUMMY_KEY.slice(0, 12)), model);
      assert.doesNotMatch(JSON.stringify(result.history), new RegExp(DUMMY_KEY.slice(0, 12)), model);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// --- XML fallback: identical behavior for every model ---------------------

test("cross-model: a valid XML call executes exactly once per model", async () => {
  for (const model of ["glm-5.3-flash", "deepseek-v4-flash"]) {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, "notes.txt"), "hello workspace\n");
      const call = formatToolCall("read_files", { paths: ["notes.txt"] });
      const adapter = new MockAdapter([
        { chunks: [text(call), finish()] },
        { chunks: [text("File berisi hello workspace."), finish()] },
      ]);
      const result = await runAgentLoop(baseOpts(dir, model, { adapter }));
      assert.equal(result.completed, true, model);
      assert.equal(result.executedToolCalls.length, 1, model);
      assert.equal(result.executedToolCalls[0].tool, "read_files", model);
      assert.equal(result.executedToolCalls[0].ok, true, model);
      const toolMsg = result.history.find((m) => m.role === "tool");
      assert.ok(toolMsg, `${model}: tool result in history`);
      assert.match(toolMsg.content, /hello workspace/, model);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("cross-model: malformed XML twice stops the turn identically", async () => {
  for (const model of ["glm-5.3-flash", "claude-sonnet-4-6"]) {
    const dir = tmpDir();
    try {
      const unclosed = `<codebuff_tool_call>{"cb_tool_name": "read_files", "paths": ["x"]`;
      const adapter = new MockAdapter([
        { chunks: [text(unclosed), finish()] },
        { chunks: [text(unclosed), finish()] },
      ]);
      const result = await runAgentLoop(baseOpts(dir, model, { adapter }));
      assert.equal(result.completed, false, model);
      assert.match(result.stopReason, /^protocol violation:/, model);
      assert.match(result.finalText, new RegExp(model), `${model}: stop message names the model`);
      assert.equal(result.executedToolCalls.length, 0, `${model}: nothing executed`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// --- Streaming / context: identical handling for every model --------------

test("cross-model: a truncated stream is handled identically (no partial final answer)", async () => {
  for (const model of ["glm-5.3-flash", "deepseek-v4-flash"]) {
    const dir = tmpDir();
    try {
      const adapter = new MockAdapter([{ chunks: [text("Jawaban setengah jalan...")], truncate: true }]);
      const result = await runAgentLoop(baseOpts(dir, model, { adapter }));
      assert.equal(result.completed, false, model);
      assert.match(result.stopReason, /stream ended before the server finished/, model);
      assert.doesNotMatch(result.finalText, /Jawaban setengah jalan/, `${model}: partial text is not a final answer`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("cross-model: a long conversation keeps history consistent (tool message stored once)", async () => {
  const longHistory = [];
  for (let i = 0; i < 40; i++) {
    longHistory.push({ role: "user", content: `pertanyaan ${i}` });
    longHistory.push({ role: "assistant", content: `jawaban ${i}` });
  }
  const toolCall = formatToolCall("read_files", { paths: ["notes.txt"] });
  longHistory.push({ role: "assistant", content: toolCall });
  longHistory.push({ role: "tool", name: "read_files", tool_call_id: "call-0-0", content: "isi catatan" });
  for (const model of ["glm-5.3-flash", "claude-sonnet-4-6"]) {
    const dir = tmpDir();
    try {
      const adapter = new MockAdapter([{ chunks: [text("Ringkasan selesai."), finish()] }]);
      const result = await runAgentLoop(baseOpts(dir, model, { adapter, history: longHistory }));
      assert.equal(result.completed, true, model);
      const toolMsgs = result.history.filter((m) => m.role === "tool");
      assert.equal(toolMsgs.length, 1, `${model}: tool message stored exactly once`);
      assert.equal(toolMsgs[0].content, "isi catatan", model);
      assert.equal(result.history.at(-1).content, "Ringkasan selesai.", model);
      assert.equal(result.toolChannel, "xml-fallback", model);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
