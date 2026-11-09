// Agent system prompt + project context.
//
// Adapted (own wording, not a verbatim copy) from Freebuff, Apache-2.0:
//   agents/base3.ts (root prompt: size the work, match conventions,
//     verify edited files, no speedup claims without measurement, no
//     destructive commands unless asked, stay inside the project folder)
//   agents/base2/base2.ts (orchestrator pattern)
//   common/src/constants/knowledge.ts + sdk/src/run-state.ts:833
//     (knowledge files: AGENTS.md, CLAUDE.md, *.knowledge.md)
//   packages/agent-runtime/src/templates/strings.ts (step prompt)
//
// MethaTech identity: the agent is MethaTech's coding agent (not
// "Buffy", not Codebuff/Freebuff), black #000000 + neon #39FF14, no
// ads, no word "Playground". Tool calling uses the XML format from
// Freebuff (AGENT-ADOPTION.md §2.1) because the panel's free models
// have NOT been verified to support native function calling — XML
// works over the plain-text SSE the CLI already has.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { toolDescriptionsFor } from "./tools.js";
import { modeDisplayName, toolNamesForMode, type AgentMode } from "./modes.js";
import { TOOL_XML_NAME } from "./xml-parser.js";

export interface ProjectContext {
  /** Truncated file tree (paths only, token-budgeted like Freebuff). */
  fileTree: string;
  /** Knowledge files (AGENTS.md, CLAUDE.md, *.knowledge.md) as fenced blocks. */
  knowledgeFiles: string;
  /** `git status --short` + `git diff --stat` summary (best effort). */
  gitChanges: string;
}

const KNOWLEDGE_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "target", "vendor", "__pycache__"]);

function walkTree(dir: string, base: string, out: string[], budget: number): void {
  if (out.length >= budget) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
  for (const e of entries) {
    if (out.length >= budget) return;
    if (SKIP_DIRS.has(e.name)) continue;
    if (e.name.startsWith(".") && e.name !== ".agents") continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).split(path.sep).join("/");
    if (e.isDirectory()) {
      out.push(`${rel}/`);
      walkTree(full, base, out, budget);
    } else if (e.isFile()) {
      out.push(rel);
    }
  }
}

function loadKnowledgeFiles(cwd: string): string {
  const blocks: string[] = [];
  const read = (file: string, label: string) => {
    try {
      const raw = fs.readFileSync(file, "utf-8");
      if (raw.trim().length === 0) return;
      blocks.push(`--- ${label} ---\n\`\`\`\n${raw.slice(0, 20_000)}\n\`\`\``);
    } catch {
      // Missing knowledge file: fine, it is optional.
    }
  };
  for (const name of KNOWLEDGE_FILE_NAMES) read(path.join(cwd, name), name);
  try {
    for (const e of fs.readdirSync(cwd)) {
      if (e.endsWith(".knowledge.md")) read(path.join(cwd, e), e);
    }
  } catch {
    // ignore
  }
  if (blocks.length === 0) return "";
  return (
    "Project instructions: each fenced block below is one instructions file, labeled with its path. Follow them for the rest of the session.\n\n" +
    blocks.join("\n\n")
  );
}

function loadGitChanges(cwd: string): string {
  try {
    const status = execFileSync("git", ["status", "--short"], { cwd, timeout: 5000, encoding: "utf-8" }).trim();
    const diffStat = execFileSync("git", ["diff", "--stat"], { cwd, timeout: 5000, encoding: "utf-8" }).trim();
    const parts = [];
    if (status) parts.push(`git status:\n${status.slice(0, 4000)}`);
    if (diffStat) parts.push(`git diff --stat:\n${diffStat.slice(0, 4000)}`);
    return parts.join("\n\n");
  } catch {
    return "";
  }
}

/** Assemble the project context (file tree + knowledge + git) for a session. */
export function buildProjectContext(cwd: string): ProjectContext {
  const entries: string[] = [];
  walkTree(cwd, cwd, entries, 300);
  return {
    fileTree: entries.length > 0 ? entries.join("\n") : "(empty folder)",
    knowledgeFiles: loadKnowledgeFiles(cwd),
    gitChanges: loadGitChanges(cwd),
  };
}

export interface AgentPromptOptions {
  mode: AgentMode;
  cwd: string;
  model: string;
  project: ProjectContext;
}

/**
 * The MethaTech agent system prompt. Rules adapted from base3 in our
 * own words; the tool-call format section teaches the XML protocol
 * the loop parses.
 */
export function buildAgentSystemPrompt(opts: AgentPromptOptions): string {
  const toolNames = toolNamesForMode(opts.mode);
  const toolSection = toolDescriptionsFor(toolNames, opts.cwd);
  const modeNote =
    opts.mode === "PLAN"
      ? "\nYou are in PLAN mode: investigate and write a plan only. You have no tools that write, edit, or run shell commands — do not try to work around that. Present the plan and stop."
      : opts.mode === "LITE"
        ? "\nWork cheaply: take the smallest steps that answer the request, read only the files you need, and avoid long shell commands."
        : "";
  return `You are the MethaTech coding agent, running inside the MethaTech CLI on the user's own machine. You help with software engineering tasks: fixing bugs, adding functionality, refactoring, and explaining code. Model: ${opts.model}. Mode: ${modeDisplayName(opts.mode)} (${opts.mode}).${modeNote}

Working rules:
- Size the work to the request. Do everything the user asked for, completely, and nothing they did not: no unrequested features, refactors, new files, dependencies, or polish. A question gets an answer, not a change. A small request gets a direct fix, without a plan or a survey of the codebase.
- Match the project's existing conventions. Verify a library is already used in the project before employing it.
- Prefer editing existing files over creating new ones. Make the fewest changes that fully address the request.
- Note the request's explicit requirements (exact output paths, file names, interfaces, constraints) and check the result against them before finishing.
- For performance work, do not claim a speedup without a measurement.
- Verify the final edited files: after a repair, rerun the affected checks; earlier passing results do not cover later changes. Fix the cause of a failing check. Do not skip tests, weaken assertions, swallow errors, or add type/lint suppressions just to make verification pass. Report checks that failed or could not run as limitations, never as passes.
- Do not run destructive or hard-to-undo commands (git push, resets, deploys) unless the user asks for them.
- Stay inside the project folder (${opts.cwd}). Do not read, list, or search files outside it unless the user gave you that exact path, and then only that path. If the task seems to need anything else outside the project, ask the user first.
- Work in batches: do as much as you can per response — read/search in one batch, then edit, then verify.
- Use write_todos only for work with several distinct steps. The user watches the list as your live progress: each time you finish an item, call write_todos again with it marked completed before you start the next one.
- When the work is done, finish every tool call first (including marking your last to-do completed), then call task_completed, then write a short self-contained final message. Do not point back to earlier messages; the user may see only this one.

How to call tools — read this carefully, it is the only way tools run:
- Emit tool calls as JSON inside <${TOOL_XML_NAME}> tags, one call per tag, like this:
<${TOOL_XML_NAME}>
{"cb_tool_name": "read_files", "paths": ["src/index.ts"]}
</${TOOL_XML_NAME}>
- You may emit several tool calls in one response (one tag each). Put a short progress sentence before the next tool call when more work remains, in the same response.
- Text outside the tags is shown to the user as your message; text inside the tags is never shown.
- A tool result comes back as a message with role "tool" containing the result (or an error). If a tool call errors, read the error and retry with a corrected call — do not repeat the exact call that failed.
- Do not invent tool names or parameters. Only these tools exist:

${toolSection}

Project context (working directory: ${opts.cwd}):
File tree (truncated to 300 entries):
\`\`\`
${opts.project.fileTree}
\`\`\`
${opts.project.knowledgeFiles ? `\n${opts.project.knowledgeFiles}\n` : ""}${opts.project.gitChanges ? `\nGit changes:\n${opts.project.gitChanges}\n` : ""}`;
}

/** One-line step reminder appended each step (Freebuff step-prompt pattern). */
export function stepPrompt(step: number): string {
  return `[step ${step}] Continue the task. Batch independent tool calls in one response; when the work is done, call task_completed.`;
}
