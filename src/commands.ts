import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { render } from "ink";
import React from "react";
import { Command } from "commander";
import {
  readCredentials,
  writeCredentials,
  deleteCredentials,
  resolveApiKey,
  resolveDefaultModel,
  LOGIN_URL,
  TOKEN_PAGE_URL,
  TOPUP_URL,
} from "./config.js";
import { fetchCatalog, DEFAULT_MODEL, FALLBACK_MODEL, isFreeModel } from "./models.js";
import { getSubscription, getTotalUsageCents, listModels, ApiError, requestDeviceCode, pollDeviceToken, DeviceFlowError } from "./api.js";
import ChatApp from "./ui/ChatApp.js";
import ModelsScreen from "./ui/ModelsScreen.js";
import AccountScreen from "./ui/AccountScreen.js";
import { MOUSE_DISABLE, MOUSE_ENABLE } from "./ui/mouse.js";

function tryOpenUrl(url: string): void {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.env.TERMUX_VERSION || process.env.PREFIX?.includes("com.termux")
        ? "termux-open-url"
        : "xdg-open";
  try {
    const child = spawn(opener, [url], { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // Opening the browser is best-effort; the URL is always printed.
  }
}

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const tty = stdin.isTTY && typeof stdin.setRawMode === "function";
    // Raw mode disables tty echo, so the pasted key never appears on screen.
    // Non-tty stdin (piped input) has no raw mode; read the line plainly.
    if (tty) stdin.setRawMode(true);
    stdin.resume();
    let value = "";
    const finish = () => {
      if (tty) stdin.setRawMode(false);
      stdin.removeListener("data", onData);
      stdin.pause();
      process.stdout.write("\n");
      resolve(value.trim());
    };
    const onData = (chunk: Buffer) => {
      const s = chunk.toString("utf-8");
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") {
          finish();
          return;
        }
        if (ch === "\u0003") {
          if (tty) stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (tty && ch === "\u007f") {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        } else if (ch >= " ") {
          value += ch;
          if (tty) process.stdout.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Validate a key once, then save it (preserving the saved default model). */
async function saveValidatedKey(key: string): Promise<boolean> {
  try {
    await listModels(key);
  } catch (e) {
    const message = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
    console.log(`Key tidak bisa dipakai: ${message}`);
    return false;
  }
  const existing = readCredentials();
  writeCredentials({ apiKey: key, defaultModel: existing?.defaultModel ?? DEFAULT_MODEL, savedAt: new Date().toISOString() });
  console.log("Login berhasil. Key tersimpan di ~/.config/metatech/credentials.json (0600).");
  return true;
}

/** Manual paste flow: the original login, kept as fallback and --paste. Returns true when a key was validated and saved. */
async function cmdLoginPaste(): Promise<boolean> {
  console.log("MethaTech login (tempel API key manual)");
  console.log("");
  console.log("1. Buka URL ini di browser dan pilih akun Google / GitHub:");
  console.log(`   ${LOGIN_URL}`);
  tryOpenUrl(LOGIN_URL);
  console.log("");
  console.log("2. Setelah login, buka halaman token dan salin API key kamu:");
  console.log(`   ${TOKEN_PAGE_URL}`);
  console.log("");
  const existing = readCredentials();
  if (existing) console.log("Sudah ada key tersimpan — menempel key baru akan menggantinya.");
  const key = await askHidden("Tempel API key: ");
  if (!key) {
    console.log("Key kosong, dibatalkan.");
    return false;
  }
  return saveValidatedKey(key);
}

/**
 * Device-code flow (Freebuff-style): minta kode ke panel, buka URL di
 * browser, lalu poll sampai user menyetujui di browser. Key tidak pernah
 * diketik atau ditampilkan. Returns true when a key was validated and saved.
 */
async function cmdLoginDevice(): Promise<boolean> {
  console.log("MethaTech login");
  console.log("");
  let code;
  try {
    code = await requestDeviceCode();
  } catch {
    console.log("Login device-code belum tersedia di panel, lanjut tempel API key manual.");
    console.log("");
    return cmdLoginPaste();
  }
  console.log("1. Buka URL ini di browser dan setujui login (sudah login Google / GitHub di browser):");
  console.log(`   ${code.verificationUriComplete}`);
  console.log("");
  console.log("   Kode kamu:");
  console.log(`   ${code.userCode}`);
  console.log("");
  tryOpenUrl(code.verificationUriComplete);
  const existing = readCredentials();
  if (existing) console.log("Sudah ada key tersimpan — login baru akan menggantinya.");
  console.log("");

  const deadline = Date.now() + code.expiresIn * 1000;
  let waitSec = code.interval;
  let pollErrors = 0;
  while (true) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    if (remaining <= 0) {
      process.stdout.write("\n");
      console.log("Kode sudah kedaluwarsa. Jalankan lagi: methatech login");
      return false;
    }
    process.stdout.write(`\rMenunggu persetujuan di browser... (${remaining}s tersisa)`);
    await sleep(waitSec * 1000);
    if (Date.now() >= deadline) {
      process.stdout.write("\n");
      console.log("Kode sudah kedaluwarsa. Jalankan lagi: methatech login");
      return false;
    }
    let result;
    try {
      result = await pollDeviceToken(code.deviceCode);
      pollErrors = 0;
    } catch (e) {
      if (e instanceof DeviceFlowError && e.terminal) {
        process.stdout.write("\n");
        console.log("Kode sudah tidak berlaku (kedaluwarsa atau sudah dipakai). Jalankan lagi: methatech login");
        return false;
      }
      pollErrors += 1;
      if (pollErrors >= 3) {
        process.stdout.write("\n");
        console.log("Tidak bisa memeriksa status login. Coba lagi: methatech login");
        return false;
      }
      continue;
    }
    if (result.status === "approved") {
      process.stdout.write("\n");
      console.log("Persetujuan diterima, memeriksa key...");
      return saveValidatedKey(result.apiKey);
    }
    if (result.status === "denied") {
      process.stdout.write("\n");
      console.log("Login ditolak di browser. Tidak ada key yang disimpan.");
      return false;
    }
    if (result.status === "slow_down") {
      waitSec = Math.min(waitSec * 2, 30);
      continue;
    }
    waitSec = code.interval;
  }
}

/** Login only (device-code, or paste with --paste). True when a key was saved. */
async function runLogin(opts: { paste?: boolean }): Promise<boolean> {
  if (opts.paste) return cmdLoginPaste();
  return cmdLoginDevice();
}

/**
 * After a successful login, hand the terminal over to the chat TUI.
 * Login itself leaves stdout writes (and, for --paste, a raw-mode stdin
 * session) behind; cmdChat clears the screen first so Ink starts clean.
 * Non-TTY: the key is already saved, so just point at `methatech chat`.
 */
async function enterChatAfterLogin(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("Login berhasil. TUI butuh terminal interaktif — jalankan: methatech chat");
    return;
  }
  console.log("Membuka TUI utama...");
  await sleep(500);
  await cmdChat(undefined, { clearScreen: true });
}

async function cmdLogin(opts: { paste?: boolean }): Promise<void> {
  const ok = await runLogin(opts);
  if (!ok) return;
  await enterChatAfterLogin();
}

/**
 * Bare `methatech`: with a key, straight into the TUI (as before); without
 * one, run login first and enter the TUI when it succeeds. Non-TTY without
 * a key exits instead of hanging on a login prompt.
 */
async function cmdNoArgs(): Promise<void> {
  if (resolveApiKey()) {
    await cmdChat();
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("Belum login. Jalankan: methatech login");
    console.log("atau set env METATECH_API_KEY.");
    process.exit(1);
  }
  console.log("Belum login — membuka login dulu, lalu langsung masuk TUI.");
  console.log("");
  const ok = await runLogin({});
  if (!ok) return;
  await enterChatAfterLogin();
}

function requireKey(): string {
  const key = resolveApiKey();
  if (!key) {
    console.log("Belum login. Jalankan: methatech login");
    console.log("atau set env METATECH_API_KEY.");
    process.exit(1);
  }
  return key;
}

async function balanceOf(apiKey: string): Promise<number | null> {
  try {
    const [sub, cents] = await Promise.all([getSubscription(apiKey), getTotalUsageCents(apiKey)]);
    return Math.max(0, sub.hardLimitUsd - cents / 100);
  } catch {
    return null;
  }
}

async function cmdChat(modelOpt?: string, opts?: { clearScreen?: boolean }): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("methatech chat butuh terminal interaktif.");
    process.exit(1);
  }
  const apiKey = requireKey();
  const savedModel = resolveDefaultModel();
  const requested = modelOpt ?? savedModel ?? DEFAULT_MODEL;
  const catalog = await fetchCatalog();
  const known = catalog.entries.some((e) => e.id === requested);
  // Retired/unknown ids are coerced to the fallback instead of erroring
  // (Freebuff lesson, incident #1801).
  const model = known ? requested : FALLBACK_MODEL;
  if (!known) console.log(`Model ${requested} tidak dikenal, memakai ${FALLBACK_MODEL}.`);
  const balance = await balanceOf(apiKey);
  // Always start on a fresh screen, so no shell prompt, login output or
  // previous command is left stacked above the TUI. Ink then owns the
  // screen from the top row. (Was conditional on coming from login only,
  // which left `$ methatech` visible above the header on a plain start.)
  process.stdout.write("\x1b[2J\x1b[H");
  // Mouse reporting (SGR, see ./ui/mouse.ts): the terminal reports
  // wheel notches while the TUI runs, so a Termux finger swipe
  // arrives as wheel events and ChatApp can scroll the history
  // (Freebuff's renderer enables the same DECSET set). Scoped to
  // the chat TUI only — the one-shot screens never enable it.
  // Disabled again on exit, including process.exit() paths, so a
  // crash/exit never leaves the shell in mouse mode (where clicks
  // would stop selecting text). A hard kill (SIGKILL) cannot run
  // the guard; reset then with: printf '\e[?1006l\e[?1002l\e[?1000l'.
  process.stdout.write(MOUSE_ENABLE);
  let mouseDisabled = false;
  const disableMouse = () => {
    if (mouseDisabled) return;
    mouseDisabled = true;
    process.stdout.write(MOUSE_DISABLE);
  };
  process.on("exit", disableMouse);
  const app = render(
    React.createElement(ChatApp, { apiKey, initialModel: model, catalog, balanceUsd: balance }),
    // exitOnCtrlC: false — Ctrl+C MUST reach ChatApp's own priority
    // resolver (Freebuff double-tap: clear draft / interrupt / warn /
    // exit). With Ink's default (true), Ink exits on the first \x03
    // and never delivers it to useInput, so every Ctrl+C branch in
    // the resolver was dead code in the real TUI until 2026-11-09.
    // The one-shot screens (models/account) keep the default: Ctrl+C
    // quits them.
    { exitOnCtrlC: false },
  );
  await app.waitUntilExit();
  disableMouse();
}

async function cmdModels(): Promise<void> {
  const apiKey = resolveApiKey();
  const catalog = await fetchCatalog();
  let selected: string | null = null;
  if (apiKey) {
    try {
      const models = await listModels(apiKey);
      if (models.length > 0) selected = resolveDefaultModel() ?? DEFAULT_MODEL;
    } catch {
      // Key invalid: the list still renders from the public catalog.
    }
  } else {
    selected = resolveDefaultModel() ?? DEFAULT_MODEL;
  }
  void selected;
  const app = render(React.createElement(ModelsScreen, { catalog, selectedModel: selected }));
  await app.waitUntilExit();
}

async function cmdAccount(): Promise<void> {
  const apiKey = requireKey();
  const keySource = process.env.METATECH_API_KEY ? "env" : "file";
  let subscription = null;
  let usedUsd: number | null = null;
  try {
    subscription = await getSubscription(apiKey);
    const cents = await getTotalUsageCents(apiKey);
    usedUsd = cents / 100;
  } catch (e) {
    const message = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
    console.log(`Tidak bisa membaca akun: ${message}`);
    process.exit(1);
  }
  const app = render(React.createElement(AccountScreen, { subscription, usedUsd, keySource }));
  await app.waitUntilExit();
}

function cmdKeys(): void {
  const has = readCredentials() !== null || !!process.env.METATECH_API_KEY;
  console.log("MethaTech API keys");
  console.log("");
  console.log(`Key tersimpan di CLI ini: ${has ? "ada" : "tidak ada"}`);
  console.log("Kelola dan buat key baru di panel:");
  console.log(`  ${TOKEN_PAGE_URL}`);
  console.log("Lalu jalankan: methatech login");
}

function cmdTopup(): void {
  console.log("Top up MethaTech lewat:");
  console.log(`  ${TOPUP_URL}`);
  tryOpenUrl(TOPUP_URL);
}

function cmdLogout(): void {
  if (deleteCredentials()) console.log("Logout berhasil. Key tersimpan dihapus.");
  else console.log("Tidak ada key tersimpan.");
}

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function main(): void {
  const program = new Command();
  program
    .name("methatech")
    .description("MethaTech CLI — chat with MethaTech models from your terminal")
    .version(getVersion());

  program
    .command("login")
    .description("Login lewat browser (device-code), tanpa tempel API key")
    .option("--paste", "tempel API key manual, lewati device-code")
    .action((opts: { paste?: boolean }) => void cmdLogin(opts));

  program
    .command("chat")
    .description("Chat TUI dengan model MethaTech")
    .option("--model <id>", "model yang dipakai")
    .action((opts: { model?: string }) => void cmdChat(opts.model));

  program
    .command("models")
    .description("Daftar model + harga")
    .action(() => void cmdModels());

  program
    .command("account")
    .description("Lihat akun dan saldo")
    .action(() => void cmdAccount());

  program
    .command("keys")
    .description("Lihat cara mengelola API key")
    .action(() => cmdKeys());

  program
    .command("topup")
    .description("Buka halaman top up")
    .action(() => cmdTopup());

  program
    .command("logout")
    .description("Hapus key tersimpan")
    .action(() => cmdLogout());

  // No command = chat with the default model (Freebuff behaviour).
  // With a key saved this opens the TUI directly; without one it logs
  // in first, then opens the TUI on success.
  if (process.argv.length <= 2) {
    void cmdNoArgs();
    return;
  }
  program.parse(process.argv);
}
