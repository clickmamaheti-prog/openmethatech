// Unit tests for the formal Tool Registry (Universal Agent Runtime,
// Fase 3). The registry is the single source of truth for the 11
// existing tools: name, description, JSON Schema input/output,
// permission level, risk classification, read-only vs mutating,
// timeout and execution limits.
// Run after build: npm run build && npm test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  REGISTRY_VERSION,
  listRegisteredTools,
  getRegisteredTool,
  registeredToolNames,
  isReadOnlyTool,
  isMutatingTool,
  isFileEditTool,
  toolRequiresConfirmation,
  toolsRequiringConfirmation,
  confirmationPolicyFor,
  validateToolInput,
  toOpenAiFunction,
} from "../dist/agent/tool-registry.js";
import { allToolDefinitions } from "../dist/agent/tools.js";
import { runAgentLoop } from "../dist/agent/loop.js";
import { formatToolCall } from "../dist/agent/xml-parser.js";

const EXPECTED_NAMES = [
  "read_files",
  "list_directory",
  "glob",
  "code_search",
  "str_replace",
  "write_file",
  "run_terminal_command",
  "write_todos",
  "task_completed",
  "ask_user",
  "skill",
];

const READ_ONLY = ["read_files", "list_directory", "glob", "code_search", "task_completed", "ask_user", "skill"];
const MUTATING = ["str_replace", "write_file", "run_terminal_command", "write_todos"];

test("registry: exactly the 11 existing tools, unique ids and names", () => {
  const tools = listRegisteredTools();
  assert.equal(tools.length, 11);
  assert.deepEqual(registeredToolNames().sort(), [...EXPECTED_NAMES].sort());
  const ids = tools.map((t) => t.id);
  assert.equal(new Set(ids).size, 11, "ids must be unique");
  const names = tools.map((t) => t.name);
  assert.equal(new Set(names).size, 11, "names must be unique");
  for (const t of tools) assert.equal(t.id, t.name, "local tool id is its name");
  assert.equal(REGISTRY_VERSION, 1);
});

test("registry: every tool matches a factory definition (no drift, no duplicates)", async () => {
  const defs = allToolDefinitions();
  assert.equal(defs.length, 11);
  for (const def of defs) {
    const entry = getRegisteredTool(def.name);
    assert.ok(entry, `missing registry entry for ${def.name}`);
    assert.equal(entry.description, def.description, "description is the factory's, referenced not duplicated");
    // Factories build fresh closures on every allToolDefinitions()
    // call, so handler identity cannot be compared by reference —
    // verify behavior instead: the registered handler IS a working
    // executor (read_files below), and endsAgentStep matches.
    assert.equal(typeof entry.handler, "function", `${def.name}: handler is a function`);
    assert.equal(entry.endsAgentStep ?? false, def.endsAgentStep ?? false);
  }
  assert.equal(getRegisteredTool("teleport"), undefined);
  // Behavioral proof: the registered read_files handler reads a real file.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "methatech-registry-handler-"));
  fs.writeFileSync(path.join(dir, "a.txt"), "handler works\n");
  const ctx = { cwd: dir, todos: [], invokedByModel: true };
  const out = await getRegisteredTool("read_files").handler(ctx, { paths: ["a.txt"] });
  assert.equal(out.ok, true);
  assert.match(out.output, /handler works/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("registry: every tool has a complete metadata record", () => {
  const permissions = new Set(["read", "write", "execute", "ask"]);
  const risks = new Set(["low", "medium", "high", "critical"]);
  const effects = new Set(["read-only", "mutating"]);
  const categories = new Set(["filesystem", "shell", "search", "state", "control", "interaction", "knowledge"]);
  for (const t of listRegisteredTools()) {
    assert.ok(t.description.length > 0, `${t.name}: description`);
    assert.equal(t.inputSchema.type, "object", `${t.name}: inputSchema root`);
    assert.ok(t.inputSchema.properties, `${t.name}: inputSchema properties`);
    assert.equal(t.outputSchema.type, "object", `${t.name}: outputSchema root`);
    assert.ok(t.outputSchema.required.includes("ok"), `${t.name}: output requires ok`);
    assert.ok(t.outputSchema.required.includes("output"), `${t.name}: output requires output`);
    assert.ok(permissions.has(t.permission), `${t.name}: permission ${t.permission}`);
    assert.ok(risks.has(t.risk), `${t.name}: risk ${t.risk}`);
    assert.ok(effects.has(t.effect), `${t.name}: effect ${t.effect}`);
    assert.ok(categories.has(t.category), `${t.name}: category ${t.category}`);
    assert.equal(typeof t.handler, "function", `${t.name}: handler`);
    assert.equal(t.outputLimitChars, 50_000, `${t.name}: output cap`);
    if (t.timeoutMs !== undefined) assert.ok(t.timeoutMs > 0, `${t.name}: timeoutMs positive`);
  }
});

test("registry: read-only vs mutating classification (Keputusan Reza 1 + 5)", () => {
  assert.deepEqual(
    listRegisteredTools().filter((t) => t.effect === "read-only").map((t) => t.name).sort(),
    [...READ_ONLY].sort(),
  );
  assert.deepEqual(
    listRegisteredTools().filter((t) => t.effect === "mutating").map((t) => t.name).sort(),
    [...MUTATING].sort(),
  );
  for (const name of READ_ONLY) assert.equal(isReadOnlyTool(name), true, name);
  for (const name of MUTATING) assert.equal(isMutatingTool(name), true, name);
});

test("registry: confirmation policy follows risk (Klarifikasi Reza 2026-11-10)", () => {
  // Permission and risk are DIFFERENT axes; confirmation follows
  // RISK, not effect alone. The Fase 3 rule ("gate only for
  // critical") was refined by Reza's 2026-11-10 clarification:
  // run_terminal_command (critical) "required", write_file (high,
  // whole-file) "required", str_replace (high, spans) "scoped"
  // (the gate evaluates the call scope), everything else "none".
  // The gate itself is still NOT implemented (Fase 8) — this is
  // metadata only.
  assert.deepEqual(
    toolsRequiringConfirmation().map((t) => t.name),
    ["str_replace", "write_file", "run_terminal_command"],
  );
  assert.equal(confirmationPolicyFor("run_terminal_command"), "required");
  assert.equal(confirmationPolicyFor("write_file"), "required");
  assert.equal(confirmationPolicyFor("str_replace"), "scoped");
  assert.equal(toolRequiresConfirmation("run_terminal_command"), true);
  assert.equal(toolRequiresConfirmation("write_file"), true);
  assert.equal(toolRequiresConfirmation("str_replace"), true);
  for (const name of EXPECTED_NAMES) {
    if (["run_terminal_command", "write_file", "str_replace"].includes(name)) continue;
    assert.equal(confirmationPolicyFor(name), "none", name);
    assert.equal(toolRequiresConfirmation(name), false, name);
  }
  // Consistency: a policy that prompts implies high/critical risk;
  // a policy of "none" implies low/medium risk. A future edit that
  // raises a tool's risk without fixing its policy (or vice versa)
  // fails here.
  for (const t of listRegisteredTools()) {
    if (t.confirmationPolicy === "required") {
      assert.ok(t.risk === "high" || t.risk === "critical", `${t.name}: required implies high/critical risk`);
    }
    if (t.confirmationPolicy === "scoped") {
      assert.equal(t.risk, "high", `${t.name}: scoped implies high risk`);
    }
    if (t.confirmationPolicy === "none") {
      assert.ok(t.risk === "low" || t.risk === "medium", `${t.name}: none implies low/medium risk`);
    }
  }
  // str_replace carries the scope factors the Fase 8 gate reads.
  const note = getRegisteredTool("str_replace").confirmationNote;
  assert.ok(typeof note === "string" && note.length > 0);
  // File writes are high risk (permission write); skill is medium.
  assert.equal(getRegisteredTool("write_file").risk, "high");
  assert.equal(getRegisteredTool("str_replace").risk, "high");
  assert.equal(getRegisteredTool("skill").risk, "medium");
  assert.equal(getRegisteredTool("skill").endsAgentStep, true);
});

test("registry: file-edit classification covers exactly str_replace + write_file", () => {
  assert.equal(isFileEditTool("str_replace"), true);
  assert.equal(isFileEditTool("write_file"), true);
  for (const name of EXPECTED_NAMES) {
    if (name !== "str_replace" && name !== "write_file") assert.equal(isFileEditTool(name), false, name);
  }
});

test("registry: timeouts and result limits match the handlers", () => {
  const shell = getRegisteredTool("run_terminal_command");
  assert.equal(shell.timeoutMs, 120_000);
  assert.equal(shell.maxTimeoutMs, 600_000);
  assert.equal(getRegisteredTool("read_files").maxLinesPerFile, 2000);
  assert.equal(getRegisteredTool("glob").maxResults, 200);
  assert.equal(getRegisteredTool("code_search").maxResults, 50);
});

const VALID_INPUTS = {
  read_files: { paths: ["a.txt"] },
  list_directory: { path: "." },
  glob: { pattern: "src/**/*.ts" },
  code_search: { pattern: "hello" },
  str_replace: { path: "a.txt", replacements: [{ oldString: "x", newString: "y" }] },
  write_file: { path: "a.txt", content: "hi\n" },
  run_terminal_command: { command: "echo hi" },
  write_todos: { todos: [{ task: "Do it" }] },
  task_completed: { summary: "done" },
  ask_user: { questions: [{ question: "Which one?", options: ["a", "b"] }] },
  skill: { name: "review" },
};

test("registry: valid inputs pass schema validation for all 11 tools", () => {
  for (const [name, input] of Object.entries(VALID_INPUTS)) {
    const entry = getRegisteredTool(name);
    assert.equal(validateToolInput(entry, input), null, `${name} should validate`);
  }
});

test("registry: missing required params and wrong types fail validation", () => {
  const cases = [
    ["read_files", {}, /paths: missing required param/],
    ["read_files", { paths: "a.txt" }, /paths: expected array/],
    ["read_files", { paths: [] }, /paths: array shorter than minItems 1/],
    ["read_files", { paths: [1] }, /paths\[0\]: expected string/],
    ["glob", {}, /pattern: missing required param/],
    ["glob", { pattern: "" }, /pattern: string shorter than minLength 1/],
    ["write_file", { path: "a.txt" }, /content: missing required param/],
    ["write_file", { path: "a.txt", content: 5 }, /content: expected string/],
    ["run_terminal_command", {}, /command: missing required param/],
    ["run_terminal_command", { command: "x", timeout_seconds: 601 }, /above maximum 600/],
    ["run_terminal_command", { command: "x", timeout_seconds: "120" }, /timeout_seconds: expected number/],
    ["write_todos", { todos: [{ completed: true }] }, /task: missing required param/],
    ["write_todos", { todos: [{ task: "x", completed: "yes" }] }, /completed: expected boolean/],
    ["ask_user", { questions: [] }, /questions: array shorter than minItems 1/],
    ["ask_user", { questions: [{ options: ["a"] }] }, /question: missing required param/],
    ["skill", { name: "" }, /name: string shorter than minLength 1/],
  ];
  for (const [name, input, re] of cases) {
    const entry = getRegisteredTool(name);
    const err = validateToolInput(entry, input);
    assert.ok(err, `${name} ${JSON.stringify(input)} should fail`);
    assert.match(err, re, `${name}: ${err}`);
  }
});

test("registry: str_replace aliases and single-replacement lift pass schema validation", () => {
  // The schema documents the canonical shape; the alias-aware
  // handler remains the enforcer — aliases must NOT be rejected
  // here (handlers accept old/new/old_str/new_str/replacement).
  const entry = getRegisteredTool("str_replace");
  assert.equal(validateToolInput(entry, { path: "a.txt", oldString: "x", newString: "y" }), null);
  assert.equal(validateToolInput(entry, { path: "a.txt", old_str: "x", new_str: "y" }), null);
  assert.equal(
    validateToolInput(entry, { path: "a.txt", replacements: [{ old: "x", new: "y" }] }),
    null,
  );
  // Unknown extra keys are ignored, like the handlers ignore them.
  assert.equal(validateToolInput(entry, { path: "a.txt", content: "ignored" }), null);
  assert.equal(validateToolInput(getRegisteredTool("read_files"), { paths: ["a.txt"], extra: 1 }), null);
});

test("registry: toOpenAiFunction produces the relay's function-tool shape", () => {
  const fn = toOpenAiFunction(getRegisteredTool("read_files"));
  assert.equal(fn.type, "function");
  assert.equal(fn.function.name, "read_files");
  assert.ok(fn.function.description.length > 0);
  assert.equal(fn.function.parameters.type, "object");
  assert.deepEqual(fn.function.parameters.required, ["paths"]);
  assert.ok(fn.function.parameters.properties.paths);
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "methatech-registry-"));
}

function mockModel(responses) {
  let i = 0;
  return async () => responses[Math.min(i++, responses.length - 1)];
}

test("loop: schema-invalid tool call becomes a tool error result, not a crash", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  const events = [];
  const result = await runAgentLoop({
    apiKey: "test",
    model: "glm-5.3-flash",
    cwd: dir,
    mode: "DEFAULT",
    userPrompt: "read it",
    callModel: mockModel([
      // paths as a bare string: the handler would have rejected this
      // too, but the registry must catch it first, same channel.
      formatToolCall("read_files", { paths: "a.txt" }),
      `${formatToolCall("task_completed", { summary: "done" })}All done.`,
    ]),
    onEvent: (e) => events.push(e),
  });
  assert.equal(result.completed, true);
  assert.equal(result.stopReason, "task_completed");
  const toolMsg = result.history.find((m) => m.role === "tool");
  assert.ok(toolMsg);
  assert.match(toolMsg.content, /read_files: paths: expected array/);
  assert.ok(events.some((e) => e.type === "tool_result" && !e.ok));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loop: schema-valid tool call still executes through the XML path unchanged", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.txt"), "registry still reads\n");
  const result = await runAgentLoop({
    apiKey: "test",
    model: "glm-5.3-flash",
    cwd: dir,
    mode: "DEFAULT",
    userPrompt: "read a.txt",
    callModel: mockModel([
      formatToolCall("read_files", { paths: ["a.txt"] }),
      `${formatToolCall("task_completed", { summary: "done" })}All done.`,
    ]),
  });
  assert.equal(result.completed, true);
  const toolMsg = result.history.find((m) => m.role === "tool");
  assert.match(toolMsg.content, /registry still reads/);
  fs.rmSync(dir, { recursive: true, force: true });
});
