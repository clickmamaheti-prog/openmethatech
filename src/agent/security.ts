/**
 * Fase 8 — Security Hardening (core primitives).
 *
 * This module is the single place where security policy lives:
 *
 * - `resolveInsideSecure`: filesystem containment enforced with realpath
 *   resolution, so a symlink inside the workspace that points outside the
 *   workspace is refused (Fase 2's lexical `resolveInside` in tools.ts
 *   was only a name check — `readlink` escapes were never resolved).
 * - `validateShellCommand`: content validation for `run_terminal_command`,
 *   applied to the command string before it runs. It is a layered check
 *   (sensitive paths, exfiltration primitives, destructive primitives),
 *   never a bare command-name blacklist.
 * - `scrubShellEnv`: the shell child no longer inherits the parent's
 *   full environment (the parent may hold METATECH_API_KEY and other
 *   secrets). Only a small allowlist survives.
 * - `createRedactor` / `collectSessionSecrets`: secret redaction for tool
 *   output, streaming text, errors and the audit log. Redaction is
 *   value-based (exact session secrets) plus pattern-based (well-known
 *   credential formats), applied to whole reassembled strings.
 *
 * None of this is prompt text. These are checks that run in code on
 * every call, regardless of what the model was told.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { configDir } from "../config.js";
import { resolveInside } from "./tools.js";

// ---------------------------------------------------------------------------
// Sensitive locations
// ---------------------------------------------------------------------------

/** Credential / identity locations under the user's home directory. */
export const SENSITIVE_HOME_PREFIXES = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  ".docker",
  ".config",
  ".npmrc",
  ".netrc",
  ".git-credentials",
  ".cache/gh",
] as const;

/** File basenames that are credentials wherever they live outside the
 *  project workspace (a project-owned `.env` inside the workspace is
 *  allowed — see `isSensitivePath`). */
export const SENSITIVE_BASENAMES = [
  "credentials.json",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "id_ed448",
  ".env",
] as const;

/** System paths that are never legitimate targets for the agent shell. */
export const SENSITIVE_ABSOLUTE_PREFIXES = [
  "/etc/shadow",
  "/etc/gshadow",
  "/etc/sudoers",
  "/etc/sudoers.d",
  "/proc/",
  "/sys/",
  "/dev/sda",
  "/dev/mem",
  "/dev/kmem",
] as const;

export function isSensitiveBasename(basename: string): boolean {
  if (SENSITIVE_BASENAMES.includes(basename as (typeof SENSITIVE_BASENAMES)[number])) return true;
  const lower = basename.toLowerCase();
  return lower.endsWith(".pem") || lower.endsWith(".key") || lower.endsWith(".p12") || lower.endsWith(".pfx");
}

/**
 * True when an absolute path points at a credential location: under a
 * sensitive home prefix, under the CLI config dir, or at a system secret.
 * A path inside the project workspace is NOT sensitive by this rule
 * (project-owned files such as a local `.env` are the user's own work);
 * containment is enforced separately by `resolveInsideSecure`.
 */
export function isSensitivePath(abs: string, home: string = os.homedir()): boolean {
  const normalized = path.normalize(abs);
  for (const prefix of SENSITIVE_HOME_PREFIXES) {
    const dir = path.join(home, prefix);
    if (normalized === dir || normalized.startsWith(dir + path.sep)) return true;
  }
  const cfg = configDir();
  if (normalized === cfg || normalized.startsWith(cfg + path.sep)) return true;
  for (const prefix of SENSITIVE_ABSOLUTE_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(prefix)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Filesystem containment (realpath-enforced)
// ---------------------------------------------------------------------------

/**
 * Resolve `p` against `cwd` like `resolveInside`, then resolve symlinks
 * (the nearest existing ancestor when the target does not exist yet) and
 * require the real path to stay inside the real workspace root.
 * Returns the real absolute path, or null when the path escapes.
 */
export function resolveInsideSecure(cwd: string, p: string): string | null {
  const lexical = resolveInside(cwd, p);
  if (!lexical) return null;
  const realRoot = realpathAllowMissing(cwd);
  const real = realpathAllowMissing(lexical);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
  return real;
}

/** realpath that also works for not-yet-existing paths: resolve the
 *  nearest existing ancestor, then re-append the missing tail. */
export function realpathAllowMissing(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return cur;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

// ---------------------------------------------------------------------------
// Shell command validation
// ---------------------------------------------------------------------------

/** Expand `~` and `$HOME`/`${HOME}` in a copy of the command, for
 *  analysis only — the original command string is never modified. */
function expandHomeForCheck(command: string, home: string): string {
  return command
    .replace(/(^|[\s"'=:(])~(?=\/|\s|$|["'])/g, `$1${home}`)
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$HOME(?=\/|\s|$|["'])/g, home);
}

/** Split a command line into whitespace-separated tokens, respecting
 *  single/double quotes and backslash escapes. Good enough for
 *  validation — this is not a shell parser, and the whole-string regex
 *  checks below do not depend on tokenization being exact. */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const ch of command) {
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length > 0) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) tokens.push(cur);
  return tokens;
}

/** Split a command into `;`/`&&`/`||`/`|`/`&`/newline/paren
 *  segments, respecting single/double quotes and backslash escapes,
 *  so a `;` inside a quoted `-c "..."` string does not split the
 *  command (a naive split would let `python3 -c "import socket;
 *  socket.create_connection(...)"` evade the per-segment checks). */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const flush = () => {
    const s = cur.trim();
    if (s.length > 0) segments.push(s);
    cur = "";
  };
  for (const ch of command) {
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      cur += ch;
      continue;
    }
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "(" || ch === ")" || ch === "&" || ch === "|") {
      flush();
      continue;
    }
    cur += ch;
  }
  flush();
  return segments;
}

/** Primitives that exfiltrate data or fetch remote code. Checked per
 *  segment (the first token of each `;`/`&&`/`||`/`|`/`&`-separated
 *  segment), not as a bare substring, so `grep curl` stays legal. */
const EXFIL_FIRST_TOKENS = new Set(["nc", "ncat", "socat", "ssh", "scp", "sftp", "rsync", "ftp", "telnet", "sudo", "su", "doas", "eval"]);

/** Destructive primitives, checked the same way. */
const DESTRUCTIVE_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\brm\s+(?:-[a-z]*f[a-z]*\s+)+(--no-preserve-root\s+)?(\/|\$HOME|~|\$)/, reason: "recursive delete of a root or home path" },
  { re: /\brm\s+--no-preserve-root\b/, reason: "rm --no-preserve-root" },
  { re: /\bmkfs\b/, reason: "mkfs (filesystem format)" },
  { re: /\bdd\b[^|;]*\bof=\/dev\//, reason: "dd writing to a device" },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, reason: "fork bomb" },
  { re: /\b(chmod|chown)\s+-R\s+.*\s+\/$/, reason: "recursive permission change on /" },
  { re: /\b(shutdown|reboot|poweroff|halt|init\s+0)\b/, reason: "system shutdown/reboot" },
  { re: />\s*\/dev\/sd[a-z]/, reason: "redirect into a block device" },
];

/** Network upload flags for curl/wget: sending data out is the
 *  exfiltration primitive, a plain GET is not. */
const UPLOAD_FLAGS = ["--data", "--data-binary", "--data-raw", "--data-urlencode", "--upload-file", "--form", "--post-data", "--post-file", "-T", "-F"];

/**
 * Validate a shell command before execution. Returns null when the
 * command is allowed, otherwise a short human-readable reason.
 *
 * Layers (in order): sensitive-path references, exfiltration
 * primitives, destructive primitives, pipe-to-shell. A plain command
 * name is never the sole basis for refusal — the check is about what
 * the command does with what data.
 *
 * Known limitation (documented, not hidden): this is a syntactic
 * check on the command string. A model that obfuscates a path
 * (`$'~/.ssh'`, `$(echo ...)` nesting, base64 decoding into a file
 * and executing it) can evade it. That is why the namespace sandbox
 * in shell-sandbox.ts is the second layer: even a command that passes
 * validation runs with the credential directories masked.
 */
export function validateShellCommand(command: string, cwd: string, home: string = os.homedir()): string | null {
  const expanded = expandHomeForCheck(command, home);
  const resolvedCwd = path.resolve(cwd);

  // 1. Sensitive absolute prefixes, anywhere in the string (catches
  //    command substitution, pipes, `python -c`, `node -e`, ...).
  for (const prefix of SENSITIVE_ABSOLUTE_PREFIXES) {
    if (expanded.includes(prefix)) {
      return `references a system secret path (${prefix})`;
    }
  }
  for (const prefix of SENSITIVE_HOME_PREFIXES) {
    const dir = path.join(home, prefix);
    if (expanded.includes(dir + path.sep) || expanded.includes(dir + '"') || expanded.includes(dir + "'") || expanded.endsWith(dir)) {
      return `references a credential location under ${dir}`;
    }
  }
  const cfg = configDir();
  if (expanded.includes(cfg)) {
    return `references the CLI credentials directory (${cfg})`;
  }

  // 2. Path tokens that resolve outside the workspace AND point at a
  //    credential file (basename check). A project-owned `.env` or
  //    `credentials.json` inside the workspace stays allowed.
  for (const token of tokenize(expanded)) {
    if (!token.includes("/")) continue;
    const cleaned = token.replace(/^[^a-zA-Z0-9._/~$-]+/, "").replace(/[^a-zA-Z0-9._/~$-]+$/, "");
    if (!cleaned.includes("/")) continue;
    const abs = path.isAbsolute(cleaned) ? path.normalize(cleaned) : path.resolve(resolvedCwd, cleaned);
    const inside = abs === resolvedCwd || abs.startsWith(resolvedCwd + path.sep);
    if (inside) continue;
    if (isSensitiveBasename(path.basename(abs)) || isSensitivePath(abs, home)) {
      return `reads a credential file outside the workspace (${token})`;
    }
  }

  // 3. Exfiltration primitives (segment first tokens).
  const segments = splitSegments(expanded);
  for (const segment of segments) {
    const first = tokenize(segment)[0];
    if (!first) continue;
    const base = path.basename(first);
    if (EXFIL_FIRST_TOKENS.has(base)) {
      return `uses a network/privilege primitive (${base}) that can exfiltrate data`;
    }
    if (base === "curl" || base === "wget") {
      const toks = tokenize(segment);
      for (let i = 1; i < toks.length; i++) {
        const t = toks[i];
        if (UPLOAD_FLAGS.includes(t) || /^--data($|=)/.test(t) || t === "-d" || t === "--post" || t === "--request=POST" || t === "--request") {
          return `uses ${base} to send data out (upload flag ${t})`;
        }
      }
    }
    if (base === "python3" || base === "python" || base === "node" || base === "perl" || base === "ruby") {
      // Inline code is allowed in general, but a data-sending call
      // inside it is the same exfiltration primitive.
      if (
        /\b(urllib|requests|http\.client|socket|subprocess|os\.system|child_process|fetch|XMLHttpRequest)\b/.test(segment) &&
        /\b(curl|POST|upload|send)\b|create_connection|\.connect\(|urlopen\(|requests\.(get|post|put|request)\(/i.test(segment)
      ) {
        return `inline ${base} code attempts a network send`;
      }
    }
    // Pipe-to-shell: `curl ... | sh` / `... | sudo` / `... | bash`.
    if (/^\s*(sh|bash|zsh|sudo|su)\b/.test(segment) && segments.length > 1) {
      return "pipes output into a shell";
    }
  }

  // 4. Destructive primitives.
  for (const { re, reason } of DESTRUCTIVE_PATTERNS) {
    if (re.test(expanded)) return reason;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Environment scrubbing
// ---------------------------------------------------------------------------

/** Environment variables the shell child is allowed to see. Everything
 *  else — including METATECH_API_KEY and any *_KEY/*_TOKEN/*_SECRET —
 *  is stripped so a model-invoked `env` or `printenv` cannot dump
 *  credentials. */
const SHELL_ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "SHELL",
  "PWD",
  "OLDPWD",
  "TMPDIR",
  "TZ",
  "NODE_OPTIONS",
  "NPM_CONFIG_CACHE",
  "FORCE_COLOR",
  "NO_COLOR",
  "CI",
]);

const SECRET_ENV_NAME = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD|_AUTH|_CREDENTIAL|_PRIVATE|BEARER|SESSION|COOKIE|API_KEY)$/i;

export function scrubShellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (SHELL_ENV_ALLOWLIST.has(k)) out[k] = v;
    else if (SECRET_ENV_NAME.test(k)) continue;
    else if (k.startsWith("METATECH_")) continue;
    else if (k.startsWith("NPM_") || k.startsWith("NODE_") || k.startsWith("GIT_")) {
      // Tool config that is not a secret: keep only if it does not look
      // like a credential value (a 40+ char opaque token is dropped).
      if (v.length >= 40 && /^[A-Za-z0-9_\-+/=]+$/.test(v)) continue;
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

/** Generic credential formats, redacted even when the exact value was
 *  never seen (e.g. a secret echoed by the model from a file it read
 *  before Fase 8, or a third-party key in tool output). */
const SECRET_PATTERNS: { re: RegExp; replacement: string }[] = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: "[REDACTED PRIVATE KEY]" },
  { re: /\b(sk-ant-[A-Za-z0-9_\-]{16,})\b/g, replacement: "[REDACTED]" },
  { re: /\b(sk-[A-Za-z0-9_\-]{16,})\b/g, replacement: "[REDACTED]" },
  { re: /\b(npm_[A-Za-z0-9]{20,})\b/g, replacement: "[REDACTED]" },
  { re: /\b(ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghu_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|ghr_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, replacement: "[REDACTED]" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED]" },
  { re: /\bxox[baprs]-[A-Za-z0-9\-]{10,}\b/g, replacement: "[REDACTED]" },
  { re: /\bBearer\s+[A-Za-z0-9._\-~+/=]{20,}/g, replacement: "Bearer [REDACTED]" },
  {
    re: /\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd)\s*[:=]\s*['"]?[^\s'";,]{8,}/gi,
    replacement: "$1=[REDACTED]",
  },
];

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface Redactor {
  (text: string): string;
}

/** Build a redactor from known session secrets (exact values) plus the
 *  generic patterns above. Exact values are replaced longest-first so a
 *  short secret that is a substring of a longer one does not leave a
 *  partial leak. Redaction is idempotent. */
export function createRedactor(secrets: string[]): Redactor {
  const values = [...new Set(secrets.filter((s) => typeof s === "string" && s.length >= 8))].sort((a, b) => b.length - a.length);
  const exactRes = values.map((v) => new RegExp(escapeRegExp(v), "g"));
  return (text: string): string => {
    if (!text) return text;
    let out = text;
    for (const re of exactRes) out = out.replace(re, "[REDACTED]");
    for (const { re, replacement } of SECRET_PATTERNS) out = out.replace(re, replacement);
    return out;
  };
}

/** Secrets known to this process: the session API key (when present)
 *  plus any secret-looking environment variable. Never reads the
 *  credentials file — the point is to redact values the runtime
 *  already holds in memory, not to go looking for more. */
export function collectSessionSecrets(apiKey?: string): string[] {
  const secrets: string[] = [];
  if (apiKey && apiKey.length >= 8) secrets.push(apiKey);
  for (const [k, v] of Object.entries(process.env)) {
    if (v && v.length >= 8 && SECRET_ENV_NAME.test(k)) secrets.push(v);
  }
  return secrets;
}
