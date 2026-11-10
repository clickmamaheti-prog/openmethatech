/**
 * Fase 8 — Shell sandbox (user + mount namespace).
 *
 * Layer 2 of shell security, after the validator in security.ts.
 * Even a command that passes validation runs inside a fresh Linux
 * user + mount namespace (`unshare --user --map-root-user --mount`)
 * where the credential directories are bind-mounted over with an
 * empty directory and credential files with /dev/null. A command
 * that evades the syntactic validator (obfuscated path, indirect
 * access) still finds nothing to read.
 *
 * Platform notes (honest, not aspirational):
 * - This works on Linux with unprivileged user namespaces enabled
 *   (verified on the Muse VM: `unshare --user --map-root-user
 *   --mount` mounts tmpfs fine; /proc/sys/kernel/
 *   unprivileged_userns_clone = 1). It is NOT portable: Termux,
 *   macOS and Windows do not provide this mechanism, so on those
 *   platforms the runner degrades to validation + env scrubbing
 *   only and reports sandbox "validation-only" — never claiming a
 *   namespace that does not exist.
 * - The namespace is per-command (created and destroyed with the
 *   child process). There is no persistent sandbox daemon and no
 *   network namespace: network egress is NOT blocked by this layer
 *   (see the validator, which blocks upload primitives, and the
 *   limitations section of docs/UNIVERSAL-RUNTIME-PHASE8.md).
 * - Masking is verified inside the namespace: a credential
 *   directory that still has contents after masking aborts the
 *   command with exit code 126 instead of running unprotected.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { configDir } from "../config.js";

export type SandboxMode = "namespace" | "validation-only";

export interface ShellRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  sandbox: SandboxMode;
}

export interface ShellRunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Seconds; null means no timeout (the Freebuff -1 sentinel). */
  timeoutSeconds: number | null;
}

let cachedAvailable: boolean | null = null;

/** Probe once per process: does this platform support the user+mount
 *  namespace sandbox? Never throws. */
export function isSandboxAvailable(): boolean {
  if (cachedAvailable !== null) return cachedAvailable;
  try {
    const r = spawnSync("unshare", ["--user", "--map-root-user", "--mount", "/bin/true"], { timeout: 5000 });
    cachedAvailable = r.status === 0;
  } catch {
    cachedAvailable = false;
  }
  return cachedAvailable;
}

const MASK_SCRIPT = `#!/bin/sh
# MethaTech CLI shell sandbox mask script (Fase 8). Runs inside a fresh
# user+mount namespace. Credential directories are bind-mounted over with
# an empty directory, credential files with /dev/null.
EMPTY_DIR="\${TMPDIR:-/tmp}/.methatech-empty-dir"
mkdir -p "$EMPTY_DIR" 2>/dev/null || exit 126
mask_dir() {
  [ -d "$1" ] || return 0
  mount --bind "$EMPTY_DIR" "$1" 2>/dev/null || return 1
  return 0
}
mask_file() {
  [ -f "$1" ] || return 0
  mount --bind /dev/null "$1" 2>/dev/null || return 1
  return 0
}
for d in "$SANDBOX_HOME/.ssh" "$SANDBOX_HOME/.gnupg" "$SANDBOX_HOME/.aws" "$SANDBOX_HOME/.kube" "$SANDBOX_HOME/.docker" "$SANDBOX_HOME/.config" "$SANDBOX_CONFIG"; do
  mask_dir "$d" || exit 126
done
for f in "$SANDBOX_HOME/.npmrc" "$SANDBOX_HOME/.netrc" "$SANDBOX_HOME/.git-credentials" "$SANDBOX_HOME/.env"; do
  mask_file "$f" || exit 126
done
# Fail closed: a credential directory that existed and is still
# non-empty after masking was NOT masked — do not run the command.
for d in "$SANDBOX_HOME/.ssh" "$SANDBOX_CONFIG"; do
  if [ -d "$d" ] && [ -n "$(ls -A "$d" 2>/dev/null)" ]; then
    echo "methatech sandbox: failed to mask $d" >&2
    exit 126
  fi
done
cd "$SANDBOX_CWD" || exit 126
exec bash -c "$SANDBOX_CMD"
`;

let maskScriptPath: string | null = null;

/** Write the mask script once per process (mode 0600, tmpdir). */
function getMaskScriptPath(): string {
  if (maskScriptPath) return maskScriptPath;
  const p = path.join(os.tmpdir(), `methatech-sandbox-mask-${process.pid}.sh`);
  fs.writeFileSync(p, MASK_SCRIPT, { mode: 0o600 });
  maskScriptPath = p;
  return p;
}

/** Wait for a child, with the same timeout semantics the shell tool
 *  has always had: SIGTERM, then SIGKILL after 1500 ms. When
 *  `killGroup` is set, the signal goes to the whole process group
 *  (needed for the unshare chain: unshare -> sh -> bash). */
function waitForChild(child: ChildProcess, timeoutMs: number | null, killGroup: boolean): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d: Buffer) => {
    stdout += d.toString("utf8");
  });
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString("utf8");
  });
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    const signal = (sig: NodeJS.Signals) => {
      try {
        if (killGroup && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // Already gone.
      }
    };
    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        signal("SIGTERM");
        killTimer = setTimeout(() => signal("SIGKILL"), 1500);
      }, timeoutMs);
      timer.unref?.();
    }
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ stdout, stderr, exitCode: code });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ stdout, stderr: stderr + String(err), exitCode: null });
    });
  });
}

/**
 * Run a shell command, sandboxed when the platform supports it.
 * The caller is responsible for `validateShellCommand` (layer 1) and
 * `scrubShellEnv` (env) before calling this — this function is layer 2
 * only. Returns the sandbox mode actually used so callers and the
 * audit log can report it honestly.
 */
export async function runShellCommand(command: string, opts: ShellRunOptions): Promise<ShellRunResult> {
  const timeoutMs = opts.timeoutSeconds === null ? null : opts.timeoutSeconds * 1000;
  if (isSandboxAvailable()) {
    try {
      const script = getMaskScriptPath();
      const env: NodeJS.ProcessEnv = {
        ...opts.env,
        SANDBOX_CMD: command,
        SANDBOX_CWD: opts.cwd,
        SANDBOX_HOME: opts.env.HOME ?? os.homedir(),
        SANDBOX_CONFIG: configDir(),
      };
      const child = spawn("unshare", ["--user", "--map-root-user", "--mount", "/bin/sh", script], {
        cwd: opts.cwd,
        env,
        detached: true,
      });
      const r = await waitForChild(child, timeoutMs, true);
      return { ...r, sandbox: "namespace" };
    } catch {
      // Fall through to the direct run below (validation-only).
    }
  }
  const child = spawn("bash", ["-c", command], { cwd: opts.cwd, env: opts.env });
  const r = await waitForChild(child, timeoutMs, false);
  return { ...r, sandbox: "validation-only" };
}
