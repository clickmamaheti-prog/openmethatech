/**
 * Fase 8 — Audit log (append-only, secrets never recorded).
 *
 * One JSON object per line in `<configDir>/audit.log` (mode 0600).
 * Every tool call the orchestrator processes gets an entry: tool
 * identity, time, success, duration, failure kind, sandbox mode, and
 * a sanitized argument summary. The summary NEVER contains file
 * contents, command output, or secret values — it names what was
 * touched (paths, command text truncated, sizes), and the caller
 * redacts it before it reaches this module.
 *
 * The log cannot be manipulated through model input: entries are
 * single-line JSON (a newline inside an argument summary is escaped
 * by JSON.stringify, so a crafted argument can never forge a second
 * entry), and this module never throws — a logging failure is silent
 * rather than breaking the agent turn.
 *
 * Rotation: at 5 MB the log is renamed to audit.log.1 (one
 * generation kept) and a fresh log starts.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { configDir } from "../config.js";

export const AUDIT_LOG_MAX_BYTES = 5 * 1024 * 1024;

export interface AuditEntry {
  ts: string;
  session: string;
  tool: string;
  ok: boolean;
  durationMs: number;
  /** "validation" | "execution" | "timeout" | null, same meaning as
   *  the orchestrator's failureKind. */
  failureKind?: "validation" | "execution" | "timeout" | null;
  sandbox?: "namespace" | "validation-only";
  /** Sanitized, redacted argument summary — never file contents. */
  args: string;
}

/** One random id per process, so entries from one CLI session can be
 *  correlated without recording anything about the user. */
export const AUDIT_SESSION_ID = randomUUID();

export function auditLogPath(): string {
  return path.join(configDir(), "audit.log");
}

/** Append one entry. Never throws. */
export function appendAuditLog(entry: AuditEntry, filePath: string = auditLogPath()): void {
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    try {
      if (fs.statSync(filePath).size >= AUDIT_LOG_MAX_BYTES) {
        fs.renameSync(filePath, filePath + ".1");
      }
    } catch {
      // No log file yet, or rotation failed — continue with append.
    }
    fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch {
    // Audit logging must never break the agent turn.
  }
}

/**
 * Build the sanitized argument summary for a tool call. File contents
 * are never included (write_file / str_replace log path + byte count
 * only). The caller redacts the result; this function also truncates.
 */
export function summarizeToolArgs(
  tool: string,
  input: Record<string, unknown>,
  redact: (text: string) => string = (t) => t,
): string {
  const truncate = (s: string, n = 400) => (s.length > n ? s.slice(0, n) + "…[truncated]" : s);
  let summary: string;
  switch (tool) {
    case "run_terminal_command": {
      const cmd = typeof input.command === "string" ? input.command : "";
      summary = `command=${truncate(cmd)}`;
      break;
    }
    case "read_files": {
      const paths = Array.isArray(input.paths) ? input.paths.join(",") : "";
      summary = `paths=${truncate(paths)}`;
      break;
    }
    case "list_directory":
    case "code_search":
    case "glob": {
      summary = truncate(JSON.stringify(input));
      break;
    }
    case "write_file": {
      const p = typeof input.path === "string" ? input.path : "";
      const content = typeof input.content === "string" ? input.content.length : 0;
      summary = `path=${p} bytes=${content}`;
      break;
    }
    case "str_replace": {
      const p = typeof input.path === "string" ? input.path : "";
      const n = Array.isArray(input.replacements) ? input.replacements.length : 0;
      summary = `path=${p} replacements=${n}`;
      break;
    }
    default:
      summary = truncate(JSON.stringify(input), 300);
  }
  return redact(summary);
}
