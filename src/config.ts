import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Config dir: ~/.config/metatech (override with METATECH_CONFIG_DIR).
// Follows the Freebuff pattern: credentials.json, dir 0700, file 0600.
export function configDir(): string {
  const override = process.env.METATECH_CONFIG_DIR;
  if (override) return override;
  return path.join(os.homedir(), ".config", "metatech");
}

export function credentialsPath(): string {
  return path.join(configDir(), "credentials.json");
}

export interface Credentials {
  apiKey: string;
  /** Model picked last time, so `metatech chat` resumes with it. */
  defaultModel?: string;
  savedAt?: string;
}

export function readCredentials(): Credentials | null {
  try {
    const raw = fs.readFileSync(credentialsPath(), "utf-8");
    const parsed = JSON.parse(raw) as Credentials;
    if (typeof parsed.apiKey === "string" && parsed.apiKey.length > 0) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeCredentials(creds: Credentials): void {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // best effort; some filesystems ignore chmod
  }
  const file = credentialsPath();
  fs.writeFileSync(file, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort
  }
}

export function deleteCredentials(): boolean {
  try {
    fs.unlinkSync(credentialsPath());
    return true;
  } catch {
    return false;
  }
}

/** Resolution order: env var first, then the saved credentials file. */
export function resolveApiKey(): string | null {
  const env = process.env.METATECH_API_KEY;
  if (env && env.trim().length > 0) return env.trim();
  return readCredentials()?.apiKey ?? null;
}

export function resolveDefaultModel(): string | null {
  return readCredentials()?.defaultModel ?? null;
}

export function saveDefaultModel(model: string): void {
  const creds = readCredentials();
  if (!creds) return;
  writeCredentials({ ...creds, defaultModel: model });
}

export function apiBase(): string {
  return (process.env.METATECH_API_BASE ?? "https://api.methatech.eu.org").replace(/\/$/, "");
}

export function consoleBase(): string {
  return (process.env.METATECH_CONSOLE_BASE ?? "https://console.methatech.eu.org").replace(/\/$/, "");
}

export const LOGIN_URL = "https://console.methatech.eu.org/login";
export const TOKEN_PAGE_URL = "https://console.methatech.eu.org/panel/token";
export const TOPUP_URL = "https://pay.methatech.eu.org";
