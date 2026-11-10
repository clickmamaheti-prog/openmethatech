// Unit tests for the coding agent (Fase 0-2): XML parser, minimal
// tools, modes, skills, agent loop, slash commands.
// Run after build: npm run build && npm test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createStreamParserState,
  parseStreamChunk,
  parseFullText,
  formatToolCall,
} from "../dist/agent/xml-parser.js";
import { toolNamesForMode, cycleMode, modeDisplayName, parseMode } from "../dist/agent/modes.js";
import { parseSkillFile, discoverSkills, loadSkill, formatAvailableSkillsXml } from "../dist/agent/skills.js";
import { executeToolCall, toolDefinitionsFor, toolPreview, globToRegExp } from "../dist/agent/tools.js";
import { runAgentLoop, MAX_AGENT_STEPS_DEFAULT, TODO_LOOP_STOP_MESSAGE } from "../dist/agent/loop.js";
import { buildAgentSystemPrompt, buildProjectContext } from "../dist/agent/prompt.js";
import { generateInitSummary, exportConversation, compactPrompt } from "../dist/agent/slash.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "methatech-agent-"));
}

function toolCtx(cwd, overrides = {}) {
  return {
    cwd,
    todos: [],
    invokedByModel: true,
    ...overrides,
  };
}

// --- XML parser (Freebuff stream-xml-parser port) ---

test("parser: plain text passes through, no tool calls", () => {
  const r = parseFullText("Hello world, no tools here.");
  assert.equal(r.filteredText, "Hello world, no tools here.");
  assert.deepEqual(r.toolCalls, []);
  assert.deepEqual(r.parseErrors, []);
});

test("parser: one tool call extracted, surrounding text kept", () => {
  const text = `I'll read it now.\n${formatToolCall("read_files", { paths: ["a.txt"] })}\nDone.`;
  const r = parseFullText(text);
  assert.equal(r.filteredText, "I'll read it now.\n\nDone.");
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].toolName, "read_files");
  assert.deepEqual(r.toolCalls[0].input, { paths: ["a.txt"] });
});

test("parser: chunk boundary — tag split across chunks", () => {
  const state = createStreamParserState();
  const full = `start ${formatToolCall("glob", { pattern: "src/**" })} end`;
  // Feed one char at a time: the partial-tag logic must hold.
  let filtered = "";
  const calls = [];
  for (const ch of full) {
    const r = parseStreamChunk(ch, state);
    filtered += r.filteredText;
    calls.push(...r.toolCalls);
  }
  assert.equal(filtered, "start  end");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolName, "glob");
});

test("parser: multiple tool calls in one response", () => {
  const text = `${formatToolCall("read_files", { paths: ["a.txt"] })}${formatToolCall("read_files", { paths: ["b.txt"] })}`;
  const r = parseFullText(text);
  assert.equal(r.toolCalls.length, 2);
  assert.equal(r.filteredText, "");
});

test("parser: malformed JSON inside a closed tag is a parse error, not a silent drop", () => {
  const r = parseFullText(`<codebuff_tool_call>\n{not json\n</codebuff_tool_call>`);
  assert.equal(r.toolCalls.length, 0);
  assert.equal(r.parseErrors.length, 1);
});

test("parser: unclosed tag is a parse error", () => {
  const r = parseFullText(`text <codebuff_tool_call>\n{"cb_tool_name": "glob"}`);
  assert.equal(r.toolCalls.length, 0);
  assert.equal(r.parseErrors.length, 1);
  assert.equal(r.filteredText, "text ");
});

// --- Alias tag <codex_tool_call> (live bug 2026-11-09: glm-5.3-flash
// emitted the codex tag with an identical {"cb_tool_name": ...} body;
// the old parser let it leak as visible text and the turn ended) ---

test("parser: codex alias tag extracts the same tool call", () => {
  const r = parseFullText(
    `Baik, saya cek isi proyek dulu.\n<codex_tool_call>\n{"cb_tool_name": "list_directory", "path": "."}\n</codex_tool_call>`,
  );
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].toolName, "list_directory");
  assert.deepEqual(r.toolCalls[0].input, { path: "." });
  assert.equal(r.filteredText, "Baik, saya cek isi proyek dulu.\n");
  assert.deepEqual(r.parseErrors, []);
});

test("parser: codex alias tag split across chunks", () => {
  const state = createStreamParserState();
  const full = `start <codex_tool_call>\n{"cb_tool_name": "glob", "pattern": "src/**"}\n</codex_tool_call> end`;
  let filtered = "";
  const calls = [];
  for (const ch of full) {
    const r = parseStreamChunk(ch, state);
    filtered += r.filteredText;
    calls.push(...r.toolCalls);
  }
  assert.equal(filtered, "start  end");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolName, "glob");
});

test("parser: canonical and alias tags mix in one response", () => {
  const text =
    `${formatToolCall("read_files", { paths: ["a.txt"] })}` +
    `<codex_tool_call>\n{"cb_tool_name": "list_directory", "path": "."}\n</codex_tool_call>`;
  const r = parseFullText(text);
  assert.equal(r.toolCalls.length, 2);
  assert.equal(r.toolCalls[0].toolName, "read_files");
  assert.equal(r.toolCalls[1].toolName, "list_directory");
});

test("parser: unclosed codex alias tag is a parse error", () => {
  const r = parseFullText(`text <codex_tool_call>\n{"cb_tool_name": "glob"}`);
  assert.equal(r.toolCalls.length, 0);
  assert.equal(r.parseErrors.length, 1);
  assert.equal(r.filteredText, "text ");
});

// --- Modes ---

test("modes: PLAN removes mutating tools at the toolset level", () => {
  const plan = toolNamesForMode("PLAN");
  assert.ok(!plan.includes("write_file"));
  assert.ok(!plan.includes("str_replace"));
  assert.ok(!plan.includes("run_terminal_command"));
  assert.ok(plan.includes("read_files"));
  assert.ok(plan.includes("task_completed"));
  const def = toolNamesForMode("DEFAULT");
  assert.ok(def.includes("write_file"));
  assert.ok(def.includes("run_terminal_command"));
});

test("modes: display names are the Freebuff mode names; cycle order", () => {
  assert.equal(modeDisplayName("DEFAULT"), "Default");
  assert.equal(modeDisplayName("PLAN"), "Plan");
  assert.equal(parseMode("default"), "DEFAULT");
  assert.equal(parseMode("build"), null);
  assert.equal(parseMode("plan"), "PLAN");
  assert.equal(parseMode("nope"), null);
  assert.equal(cycleMode("DEFAULT"), "LITE");
  assert.equal(cycleMode("PLAN"), "DEFAULT");
});

// --- Tools (temp dir) ---

test("tools: read/write/edit/grep/glob in a temp dir", async () => {
  const dir = tmpDir();
  const ctx = toolCtx(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\nworld\nhello again\n");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "b.ts"), "export const x = 1;\n");

  const read = await executeToolCall(ctx, "read_files", { paths: ["a.txt"] });
  assert.equal(read.ok, true);
  assert.match(read.output, /1: hello/);

  const grep = await executeToolCall(ctx, "code_search", { pattern: "hello" });
  assert.equal(grep.ok, true);
  assert.match(grep.output, /a\.txt:1:/);

  const glob = await executeToolCall(ctx, "glob", { pattern: "src/**/*.ts" });
  assert.equal(glob.ok, true);
  assert.match(glob.output, /src\/b\.ts/);

  const list = await executeToolCall(ctx, "list_directory", { path: "." });
  assert.match(list.output, /a\.txt/);

  const written = await executeToolCall(ctx, "write_file", { path: "c.txt", content: "new file\n" });
  assert.equal(written.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, "c.txt"), "utf-8"), "new file\n");

  const edited = await executeToolCall(ctx, "str_replace", {
    path: "a.txt",
    replacements: [{ oldString: "world", newString: "there" }],
  });
  assert.equal(edited.ok, true);
  assert.match(fs.readFileSync(path.join(dir, "a.txt"), "utf-8"), /there/);

  const bash = await executeToolCall(ctx, "run_terminal_command", { command: "echo hi-agent" });
  assert.equal(bash.ok, true);
  assert.match(bash.output, /hi-agent/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("tools: paths outside the project folder are rejected", async () => {
  const dir = tmpDir();
  const ctx = toolCtx(dir);
  const read = await executeToolCall(ctx, "read_files", { paths: ["../outside.txt"] });
  assert.equal(read.ok, false);
  assert.match(read.output, /outside the project folder/);
  const write = await executeToolCall(ctx, "write_file", { path: "/etc/evil.txt", content: "x" });
  assert.equal(write.ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("tools: writes run directly, no confirmation gate (like Freebuff)", async () => {
  const dir = tmpDir();
  const ctx = toolCtx(dir);
  const r = await executeToolCall(ctx, "write_file", { path: "no-gate.txt", content: "x" });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, "no-gate.txt"), "utf-8"), "x");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("tools: str_replace requires a unique match", async () => {
  const dir = tmpDir();
  const ctx = toolCtx(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "x\nx\n");
  const r = await executeToolCall(ctx, "str_replace", {
    path: "a.txt",
    replacements: [{ oldString: "x", newString: "y" }],
  });
  assert.equal(r.ok, false);
  assert.match(r.output, /2 times/);
  const missing = await executeToolCall(ctx, "str_replace", {
    path: "a.txt",
    replacements: [{ oldString: "zzz", newString: "y" }],
  });
  assert.equal(missing.ok, false);
  assert.match(missing.output, /not found/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("tools: str_replace single-replacement lift + aliases (Freebuff)", async () => {
  const dir = tmpDir();
  const ctx = toolCtx(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello world\n");
  // Top-level {path, oldString, newString} lifts into replacements.
  const lifted = await executeToolCall(ctx, "str_replace", { path: "a.txt", oldString: "world", newString: "there" });
  assert.equal(lifted.ok, true);
  assert.match(fs.readFileSync(path.join(dir, "a.txt"), "utf-8"), /hello there/);
  // Aliases: old_str / new_str.
  const aliased = await executeToolCall(ctx, "str_replace", { path: "a.txt", old_str: "hello", new_str: "hi" });
  assert.equal(aliased.ok, true);
  assert.match(fs.readFileSync(path.join(dir, "a.txt"), "utf-8"), /hi there/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("tools: str_replace multiple replacements in one call (Freebuff)", async () => {
  const dir = tmpDir();
  const ctx = toolCtx(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "foo\nbar\n");
  const r = await executeToolCall(ctx, "str_replace", {
    path: "a.txt",
    replacements: [
      { oldString: "foo", newString: "FOO" },
      { oldString: "bar", newString: "BAR" },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf-8"), "FOO\nBAR\n");
  // allowMultiple replaces every occurrence.
  const multi = await executeToolCall(ctx, "str_replace", {
    path: "a.txt",
    replacements: [{ oldString: "O", newString: "0", allowMultiple: true }],
  });
  assert.equal(multi.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf-8"), "F00\nBAR\n");
  // A failing replacement writes nothing (all-or-nothing).
  const bad = await executeToolCall(ctx, "str_replace", {
    path: "a.txt",
    replacements: [
      { oldString: "F00", newString: "F" },
      { oldString: "missing", newString: "x" },
    ],
  });
  assert.equal(bad.ok, false);
  assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf-8"), "F00\nBAR\n");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("tools: write_todos uses the Freebuff shape {task, completed}", async () => {
  const dir = tmpDir();
  const seen = [];
  const ctx = toolCtx(dir, { onTodos: (todos) => seen.push(JSON.parse(JSON.stringify(todos))) });
  const r = await executeToolCall(ctx, "write_todos", {
    todos: [
      { task: "Baca hello.txt", completed: false },
      { task: "Edit hello.txt", completed: true },
    ],
  });
  assert.equal(r.ok, true);
  // Freebuff: each write REPLACES the whole list; completed defaults false.
  assert.deepEqual(ctx.todos, [
    { task: "Baca hello.txt", completed: false },
    { task: "Edit hello.txt", completed: true },
  ]);
  assert.equal(seen.length, 1, "onTodos fired once");
  // Empty list clears.
  const cleared = await executeToolCall(ctx, "write_todos", { todos: [] });
  assert.equal(cleared.ok, true);
  assert.deepEqual(ctx.todos, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("tools: write_todos unchanged list is a no-op with the Freebuff message", async () => {
  const dir = tmpDir();
  let fired = 0;
  const ctx = toolCtx(dir, { onTodos: () => fired++ });
  await executeToolCall(ctx, "write_todos", { todos: [{ task: "Keep me", completed: false }] });
  assert.equal(fired, 1);
  const again = await executeToolCall(ctx, "write_todos", { todos: [{ task: "Keep me", completed: false }] });
  assert.equal(again.ok, true);
  assert.match(again.output, /^To-do list unchanged: it is already recorded/);
  assert.equal(fired, 1, "onTodos does not fire for a no-op");
  assert.deepEqual(ctx.todos, [{ task: "Keep me", completed: false }]);
  // Plan-like toolset (no file-edit tools) appends the note.
  const planCtx = toolCtx(dir, { toolNames: ["read_files", "write_todos"] });
  planCtx.todos = [{ task: "Keep me", completed: false }];
  const planAgain = await executeToolCall(planCtx, "write_todos", { todos: [{ task: "Keep me", completed: false }] });
  assert.match(planAgain.output, /File-editing tools \(write_file, str_replace\) are not available/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("tools: write_todos malformed input does not replace the list (Freebuff)", async () => {
  const dir = tmpDir();
  const ctx = toolCtx(dir);
  await executeToolCall(ctx, "write_todos", { todos: [{ task: "Keep me", completed: false }] });
  const bad = await executeToolCall(ctx, "write_todos", { todos: [{ task: "Bad", completed: "yes" }] });
  assert.equal(bad.ok, false);
  assert.deepEqual(ctx.todos, [{ task: "Keep me", completed: false }], "old list survives");
  const bad2 = await executeToolCall(ctx, "write_todos", { todos: [{ content: "old shape", status: "pending" }] });
  assert.equal(bad2.ok, false, "old {content, status} shape is rejected");
  assert.deepEqual(ctx.todos, [{ task: "Keep me", completed: false }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("tools: skill ends the agent step (Freebuff endsAgentStep)", () => {
  const defs = toolDefinitionsFor(["skill"]);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].endsAgentStep, true);
  const others = toolDefinitionsFor(["read_files", "str_replace", "write_todos"]);
  assert.ok(others.every((d) => d.endsAgentStep !== true), "only skill ends the step");
});

test("tools: unknown tool is an error result, not a throw", async () => {
  const ctx = toolCtx(tmpDir());
  const r = await executeToolCall(ctx, "teleport", {});
  assert.equal(r.ok, false);
  assert.match(r.output, /unknown tool/);
});

test("tools: previews are one line per call", () => {
  assert.equal(toolPreview("run_terminal_command", { command: "npm test" }), "$ npm test");
  assert.equal(toolPreview("read_files", { paths: ["a.txt"] }), "Read a.txt");
  assert.equal(toolPreview("str_replace", { path: "a.txt" }), "Edit a.txt");
});

test("tools: glob matcher handles ** and *", () => {
  assert.ok(globToRegExp("src/**/*.ts").test("src/a/b.ts"));
  assert.ok(globToRegExp("src/**/*.ts").test("src/a.ts"));
  assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"));
  assert.ok(globToRegExp("*.md").test("README.md"));
});

// --- Skills ---

test("skills: frontmatter validation (name must match dir, description required)", () => {
  const good = parseSkillFile(`---\nname: my-skill\ndescription: Does things\n---\n# Do things\n`, "my-skill");
  assert.equal(good.ok, true);
  const mismatch = parseSkillFile(`---\nname: other\ndescription: x\n---\nbody\n`, "my-skill");
  assert.equal(mismatch.ok, false);
  const noDesc = parseSkillFile(`---\nname: my-skill\n---\nbody\n`, "my-skill");
  assert.equal(noDesc.ok, false);
  const noFm = parseSkillFile(`# no frontmatter\n`, "my-skill");
  assert.equal(noFm.ok, false);
});

test("skills: discover + load from project and home roots", () => {
  const dir = tmpDir();
  const home = tmpDir();
  const projSkill = path.join(dir, ".agents", "skills", "review");
  fs.mkdirSync(projSkill, { recursive: true });
  fs.writeFileSync(path.join(projSkill, "SKILL.md"), `---\nname: review\ndescription: Review code\n---\nReview every diff.\n`);
  const homeSkill = path.join(home, ".config", "metatech", "skills", "deploy");
  fs.mkdirSync(homeSkill, { recursive: true });
  fs.writeFileSync(path.join(homeSkill, "SKILL.md"), `---\nname: deploy\ndescription: Deploy it\n---\nDeploy steps.\n`);
  const found = discoverSkills(dir, home);
  assert.deepEqual(found.map((s) => s.name).sort(), ["deploy", "review"]);
  const loaded = loadSkill("review", dir, home);
  assert.equal(loaded.ok, true);
  assert.match(loaded.skill.content, /Review every diff/);
  assert.equal(loadSkill("nope", dir, home).ok, false);
  const xml = formatAvailableSkillsXml(found);
  assert.match(xml, /<skill name="review">/);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

// --- Agent loop (mock model) ---

function mockModel(responses) {
  let i = 0;
  return async () => responses[Math.min(i++, responses.length - 1)];
}

test("loop: mock model reads a file then completes", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "hello.txt"), "mock content here\n");
  const events = [];
  const result = await runAgentLoop({
    apiKey: "test",
    model: "glm-5.3-flash",
    cwd: dir,
    mode: "DEFAULT",
    userPrompt: "read hello.txt",
    callModel: mockModel([
      formatToolCall("read_files", { paths: ["hello.txt"] }),
      `${formatToolCall("task_completed", { summary: "read it" })}All done.`,
    ]),
    onEvent: (e) => events.push(e),
  });
  assert.equal(result.completed, true);
  assert.equal(result.steps, 2);
  assert.equal(result.stopReason, "task_completed");
  const toolMsg = result.history.find((m) => m.role === "tool");
  assert.ok(toolMsg);
  assert.match(toolMsg.content, /mock content here/);
  assert.ok(events.some((e) => e.type === "tool_call" && e.toolName === "read_files"));
  assert.ok(events.some((e) => e.type === "tool_result" && e.ok));
  fs.rmSync(dir, { recursive: true, force: true });
});

// Live bug 2026-11-09 (Reza Termux, glm-5.3-flash): the model echoed
// two whole files back into its reply as a fenced code block — a gray
// wall of dozens of lines — even though the tool-result display was
// already truncated to a 120-char summary. The wall came from the
// model's own text, so the fix is prompt-side (Freebuff
// AGENT_PROGRESS_GUIDANCE: progress text is normal assistant text,
// never tool arguments or terminal output) + display-side (read_files
// shows paths only, like Freebuff read-files.tsx).

test("prompt: system prompt forbids pasting tool output back into replies", () => {
  const dir = tmpDir();
  const prompt = buildAgentSystemPrompt({
    mode: "DEFAULT",
    cwd: dir,
    model: "glm-5.3-flash",
    project: buildProjectContext(dir),
  });
  assert.ok(prompt.includes("Never paste file contents, terminal output, or other tool output back into your reply"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loop: read of a large file keeps the FULL content in model history", async () => {
  const dir = tmpDir();
  const lines = Array.from({ length: 60 }, (_, i) => `BARIS BESAR ${String(i + 1).padStart(2, "0")} isi baris besar`);
  fs.writeFileSync(path.join(dir, "big.txt"), lines.join("\n") + "\n");
  const result = await runAgentLoop({
    apiKey: "test",
    model: "glm-5.3-flash",
    cwd: dir,
    mode: "DEFAULT",
    userPrompt: "baca big.txt",
    callModel: mockModel([
      formatToolCall("read_files", { paths: ["big.txt"] }),
      `${formatToolCall("task_completed", { summary: "selesai" })}All done.`,
    ]),
  });
  assert.equal(result.completed, true);
  // The system prompt (history[0]) carries the no-echo rule to the model.
  assert.ok(result.history[0].content.includes("Never paste file contents"));
  // The tool message keeps the WHOLE file: first AND last line present,
  // so display truncation never starves the model of context.
  const toolMsg = result.history.find((m) => m.role === "tool");
  assert.ok(toolMsg);
  assert.match(toolMsg.content, /BARIS BESAR 01/);
  assert.match(toolMsg.content, /BARIS BESAR 60/);
  // ...while the display summary for that same read is null (paths only).
  const { summarizeToolResult } = await import("../dist/ui/tool-summary.js");
  assert.equal(summarizeToolResult("read_files", toolMsg.content, true), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loop: plain-text answer ends the turn without tool calls", async () => {
  const dir = tmpDir();
  const result = await runAgentLoop({
    apiKey: "test",
    model: "glm-5.3-flash",
    cwd: dir,
    mode: "DEFAULT",
    userPrompt: "what is 2+2?",
    callModel: mockModel(["4."]),
  });
  assert.equal(result.completed, true);
  assert.equal(result.steps, 1);
  assert.equal(result.finalText, "4.");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loop: malformed tool JSON forces a retry step", async () => {
  const dir = tmpDir();
  const result = await runAgentLoop({
    apiKey: "test",
    model: "glm-5.3-flash",
    cwd: dir,
    mode: "DEFAULT",
    userPrompt: "hi",
    callModel: mockModel([
      `<codebuff_tool_call>\n{broken\n</codebuff_tool_call>`,
      "Recovered, plain answer.",
    ]),
  });
  assert.equal(result.completed, true);
  assert.equal(result.steps, 2);
  assert.ok(result.history.some((m) => m.role === "user" && m.content.includes("TOOL_CALL_ERROR")));
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Live bug 2026-11-09 (Reza Termux, glm-5.3-flash): the model
// emitted <codex_tool_call> and the turn ended with the raw block on
// screen; then it promised "saya cek proyeknya sekarang" with no call
// and the agent went silent. ---

test("loop: codex alias tag executes the tool (live bug repro)", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "hello.txt"), "hi\n");
  const result = await runAgentLoop({
    apiKey: "test",
    model: "glm-5.3-flash",
    cwd: dir,
    mode: "DEFAULT",
    userPrompt: "cek projeck kita",
    callModel: mockModel([
      `Baik, saya cek isi proyek dulu.\n<codex_tool_call>\n{"cb_tool_name": "list_directory", "path": "."}\n</codex_tool_call>`,
      formatToolCall("task_completed", { summary: "selesai" }),
    ]),
  });
  assert.equal(result.completed, true);
  assert.equal(result.steps, 2);
  assert.equal(result.stopReason, "task_completed");
  const toolMsg = result.history.find((m) => m.role === "tool");
  assert.ok(toolMsg);
  assert.match(toolMsg.content, /hello\.txt/);
  assert.doesNotMatch(result.finalText, /codex_tool_call/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loop: promised tool use with no call gets nudged, then complies", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "hello.txt"), "hi\n");
  const result = await runAgentLoop({
    apiKey: "test",
    model: "glm-5.3-flash",
    cwd: dir,
    mode: "DEFAULT",
    userPrompt: "cek projeck kita",
    callModel: mockModel([
      "Haha, oke oke, saya cek proyeknya sekarang.",
      formatToolCall("list_directory", { path: "." }),
      "Selesai, ini isi proyeknya.",
    ]),
  });
  assert.equal(result.completed, true);
  assert.equal(result.steps, 3);
  assert.ok(result.history.some((m) => m.role === "user" && m.content.includes("TOOL_CALL_MISSING")));
  const toolMsg = result.history.find((m) => m.role === "tool");
  assert.ok(toolMsg);
  assert.match(toolMsg.content, /hello\.txt/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loop: promise twice with no call ends the turn after 2 nudges", async () => {
  const dir = tmpDir();
  const result = await runAgentLoop({
    apiKey: "test",
    model: "glm-5.3-flash",
    cwd: dir,
    mode: "DEFAULT",
    userPrompt: "cek projeck kita",
    callModel: mockModel(["Haha, oke oke, saya cek proyeknya sekarang."]),
  });
  assert.equal(result.completed, false);
  assert.equal(result.steps, 3);
  // Fase 6: exhausting both nudges is a protocol failure — the turn
  // stops explicitly instead of completing silently as "no more
  // tool calls". Two nudges are still sent; the step count is the same.
  assert.match(result.stopReason, /protocol violation/);
  assert.match(result.finalText, /promised tool work/);
  const nudges = result.history.filter((m) => m.role === "user" && m.content.includes("TOOL_CALL_MISSING"));
  assert.equal(nudges.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loop: plain greeting answer still ends in 1 step (no false nudge)", async () => {
  const dir = tmpDir();
  const result = await runAgentLoop({
    apiKey: "test",
    model: "glm-5.3-flash",
    cwd: dir,
    mode: "DEFAULT",
    userPrompt: "halo",
    callModel: mockModel(["Halo! Ada yang bisa saya bantu?"]),
  });
  assert.equal(result.completed, true);
  assert.equal(result.steps, 1);
  assert.ok(!result.history.some((m) => m.role === "user" && m.content.includes("TOOL_CALL_MISSING")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loop: PLAN mode rejects a write_file call at the toolset level", async () => {
  const dir = tmpDir();
  const result = await runAgentLoop({
    apiKey: "test",
    model: "glm-5.3-flash",
    cwd: dir,
    mode: "PLAN",
    userPrompt: "write a file",
    callModel: mockModel([
      formatToolCall("write_file", { path: "x.txt", content: "x" }),
      "Plan only, no file written.",
    ]),
  });
  assert.equal(result.completed, true);
  assert.equal(fs.existsSync(path.join(dir, "x.txt")), false);
  const toolMsg = result.history.find((m) => m.role === "tool");
  assert.ok(toolMsg);
  assert.match(toolMsg.content, /unavailable tool in this mode/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loop: tool error forces a retry step", async () => {
  const dir = tmpDir();
  const result = await runAgentLoop({
    apiKey: "test",
    model: "glm-5.3-flash",
    cwd: dir,
    mode: "DEFAULT",
    userPrompt: "read missing",
    callModel: mockModel([
      formatToolCall("read_files", { paths: ["missing.txt"] }),
      "The file does not exist, nothing to do.",
    ]),
  });
  assert.equal(result.completed, true);
  assert.equal(result.steps, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loop: repeating the same to-do list stops at 6 (Freebuff todo-loop guard)", async () => {
  const dir = tmpDir();
  const sameList = formatToolCall("write_todos", { todos: [{ task: "Do the thing", completed: false }] });
  const result = await runAgentLoop({
    apiKey: "test",
    model: "glm-5.3-flash",
    cwd: dir,
    mode: "DEFAULT",
    userPrompt: "do the thing",
    callModel: mockModel([sameList, sameList]),
  });
  // Step 1 sets the list; steps 2-7 re-send it unchanged: recovery
  // nudge at streak 3 (step 4), stop at streak 6 (step 7).
  assert.equal(result.completed, false);
  assert.equal(result.steps, 7);
  assert.equal(result.stopReason, TODO_LOOP_STOP_MESSAGE);
  assert.ok(
    result.history.some((m) => m.role === "user" && m.content.includes("repeatedly called write_todos")),
    "recovery message inserted at streak 3",
  );
  assert.deepEqual(result.todos, [{ task: "Do the thing", completed: false }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loop: maxSteps default is 100 (below the Freebuff 600 backstop)", () => {
  assert.equal(MAX_AGENT_STEPS_DEFAULT, 100);
});

test("loop: ask_user pauses the turn with its questions", async () => {
  const dir = tmpDir();
  const result = await runAgentLoop({
    apiKey: "test",
    model: "glm-5.3-flash",
    cwd: dir,
    mode: "DEFAULT",
    userPrompt: "ambiguous task",
    callModel: mockModel([
      formatToolCall("ask_user", { questions: [{ question: "Which framework?", options: ["A", "B"] }] }),
    ]),
  });
  assert.equal(result.completed, false);
  assert.equal(result.askUserQuestions?.[0]?.question, "Which framework?");
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Prompt + project context ---

test("prompt: system prompt names MethaTech, never Buffy/Playground, and lists the XML format", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "Always run tests.\n");
  const project = buildProjectContext(dir);
  assert.match(project.knowledgeFiles, /Always run tests/);
  const prompt = buildAgentSystemPrompt({ mode: "DEFAULT", cwd: dir, model: "glm-5.3-flash", project });
  assert.match(prompt, /MethaTech coding agent/);
  assert.doesNotMatch(prompt, /Buffy/);
  assert.doesNotMatch(prompt, /Playground/);
  assert.match(prompt, /codebuff_tool_call/);
  assert.match(prompt, /read_files/);
  const planPrompt = buildAgentSystemPrompt({ mode: "PLAN", cwd: dir, model: "glm-5.3-flash", project });
  assert.doesNotMatch(planPrompt, /write_file: /);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("prompt: forbids other tag names and announcing a tool without emitting it (live bug 2026-11-09)", () => {
  const dir = tmpDir();
  const project = buildProjectContext(dir);
  const prompt = buildAgentSystemPrompt({ mode: "DEFAULT", cwd: dir, model: "glm-5.3-flash", project });
  assert.match(prompt, /Never use any other tag name/);
  assert.match(prompt, /codex_tool_call/);
  assert.match(prompt, /Never announce that you will use a tool without emitting the call in the same response/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Slash commands ---

test("slash: /init drafts AGENTS.md from package.json + files", () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "demo", description: "Demo project", scripts: { test: "node --test" } }),
  );
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "index.ts"), "export {};\n");
  const { content, existed } = generateInitSummary(dir);
  assert.equal(existed, false);
  assert.match(content, /Demo project/);
  assert.match(content, /npm run test/);
  assert.match(content, /src\/index\.ts/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("slash: /export writes a Markdown file in the project folder", () => {
  const dir = tmpDir();
  const file = exportConversation({
    cwd: dir,
    model: "glm-5.3-flash",
    mode: "Default",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ],
  });
  assert.match(path.basename(file), /^metatech-export-.*\.md$/);
  const raw = fs.readFileSync(file, "utf-8");
  assert.match(raw, /## user/);
  assert.match(raw, /hello/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("slash: compact prompt keeps the goal and drops verbatim output", () => {
  const p = compactPrompt([
    { role: "user", content: "Fix the login bug" },
    { role: "assistant", content: "Fixed in auth.ts" },
  ]);
  assert.match(p, /Fix the login bug/);
  assert.match(p, /Summarise/);
});
