// MethaTech chat TUI — full-screen interactive, pure black background,
// neon green accent. One central useInput handler with a fixed priority
// (FreeBuff pattern: one global keyboard handler, no competing inputs):
//   1. Ctrl+C — always exits, in every mode.
//   2. ModelPicker open — Up/Down/Enter/Esc belong to the picker.
//   3. CommandPalette open — Up/Down/Enter/Esc belong to the palette.
//   4. Normal chat — Enter sends, Up/Down cycles model, Esc clears input.
// While a request is sending, all input except Ctrl+C is ignored. The
// Thinking indicator shows only while waiting for the first delta, then
// disappears the moment streaming starts.
//
// Assistant messages render per MessagePart: plain text as-is, ``` fenced
// blocks through CodeBlock (theme syntax colors). DiffView is exported
// from ui/index.ts, ready for the future coding agent — no agent is built
// in this phase.

import React, { useEffect, useRef, useState } from "react";
import { spawn } from "node:child_process";
import { Box, Text, useApp, useInput, useStdout, type Key } from "ink";
import { theme } from "../theme.js";
import { streamChat, ApiError, type ChatMessage, type ChatUsage } from "../api.js";
import { priceFor, isFreeModel, DEFAULT_MODEL, FALLBACK_MODEL, type Catalog } from "../models.js";
import { formatUsageLine, formatUsd } from "../cost.js";
import { saveDefaultModel, TOPUP_URL, TOKEN_PAGE_URL, LOGIN_URL } from "../config.js";
import { splitMessageParts } from "./syntax.js";
import { shouldShowThinking } from "./thinking.js";
import { filterCommands, paletteClampIndex, paletteNextIndex, palettePrevIndex } from "./palette.js";
import { flattenGroups, groupCatalog, pickerNext, pickerPrev } from "./picker.js";
import Thinking from "./Thinking.js";
import CommandPalette from "./CommandPalette.js";
import ModelPicker from "./ModelPicker.js";
import CodeBlock from "./CodeBlock.js";

type DisplayMessage = ChatMessage & { kind: "chat" | "system" };

interface ChatAppProps {
  apiKey: string;
  initialModel: string;
  catalog: Catalog;
  balanceUsd: number | null;
}

const HELP_LINES = [
  "/models — lihat daftar model",
  "/model — pilih model (atau /model <id> langsung)",
  "/clear — bersihkan layar chat",
  "/help — bantuan ini",
  "/account — ringkasan akun",
  "/keys — info API key",
  "/topup — buka halaman top up",
  "/exit — keluar",
  "↑↓ ganti model · / buka perintah · Enter kirim · Ctrl+C keluar",
];

/** Best-effort browser open (Termux-aware). The URL is always printed too. */
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

export default function ChatApp({ apiKey, initialModel, catalog, balanceUsd }: ChatAppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = stdout.columns ?? 80;
  const rows = stdout.rows ?? 24;
  const contentWidth = Math.max(20, columns - 4);
  const pickerMaxRows = Math.max(5, Math.min(16, rows - 14));
  // Narrow terminals (Termux split-screen, 40 cols): one header row would
  // hard-wrap mid-word. Stack it in two short rows instead.
  const narrow = columns < 60;

  const [model, setModel] = useState(initialModel);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [gotFirstDelta, setGotFirstDelta] = useState(false);
  const [lastUsage, setLastUsage] = useState<{ usage: ChatUsage; model: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSelected, setPickerSelected] = useState(0);
  const [paletteSelected, setPaletteSelected] = useState(0);

  const sendingRef = useRef(false);
  const modelRef = useRef(model);
  modelRef.current = model;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Refs mirrored synchronously with state, so the central useInput handler
  // never decides on a stale closure when keys arrive faster than React
  // re-renders (rapid typing + Enter would otherwise swallow the Enter:
  // the handler would still see the old input and think the palette is
  // closed). Every mutation below updates the ref AND the state together.
  const inputRef = useRef("");
  const pickerOpenRef = useRef(false);
  const pickerSelectedRef = useRef(0);
  const paletteSelectedRef = useRef(0);
  const setInputBoth = (updater: string | ((prev: string) => string)) => {
    const next = typeof updater === "function" ? updater(inputRef.current) : updater;
    inputRef.current = next;
    setInput(next);
  };
  const setPickerOpenBoth = (open: boolean) => {
    pickerOpenRef.current = open;
    setPickerOpen(open);
  };
  const setPickerSelectedBoth = (idx: number) => {
    pickerSelectedRef.current = idx;
    setPickerSelected(idx);
  };
  const setPaletteSelectedBoth = (idx: number) => {
    paletteSelectedRef.current = idx;
    setPaletteSelected(idx);
  };

  const modelIds = catalog.entries.map((e) => e.id);
  const flatModels = flattenGroups(groupCatalog(catalog));
  const price = priceFor(catalog, model);
  const free = isFreeModel(model);

  // Command palette: open while the input starts with "/" (and the picker
  // is not open). Typing after "/" filters the list in real time.
  const paletteOpen = input.startsWith("/") && !pickerOpen;
  const paletteQuery = paletteOpen ? (input.slice(1).split(/\s+/)[0] ?? "") : "";
  const filteredCommands = paletteOpen ? filterCommands(paletteQuery) : [];

  // Reset the palette selection whenever the query changes; clamp it when
  // the filtered list shrinks. Keep the ref in sync (handler reads it).
  useEffect(() => {
    paletteSelectedRef.current = 0;
    setPaletteSelected(0);
  }, [paletteQuery]);
  useEffect(() => {
    setPaletteSelected((s) => {
      const clamped = paletteClampIndex(s, filteredCommands.length);
      paletteSelectedRef.current = clamped;
      return clamped;
    });
  }, [filteredCommands.length]);

  const thinking = shouldShowThinking({ sending, gotFirstDelta, hasError: error !== null });

  const pushSystem = (content: string) => {
    setMessages((m) => [...m, { role: "assistant", content, kind: "system" }]);
  };

  const cycleModel = (dir: 1 | -1) => {
    const idx = modelIds.indexOf(modelRef.current);
    const next = modelIds[(idx + dir + modelIds.length) % modelIds.length] ?? DEFAULT_MODEL;
    modelRef.current = next;
    setModel(next);
    saveDefaultModel(next);
  };

  const setModelById = (id: string): boolean => {
    if (!modelIds.includes(id)) {
      // Retired/unknown ids are coerced to the fallback instead of erroring
      // (Freebuff lesson, incident #1801).
      pushSystem(`Model ${id} tidak dikenal, dialihkan ke ${FALLBACK_MODEL}.`);
      modelRef.current = FALLBACK_MODEL;
      setModel(FALLBACK_MODEL);
      return false;
    }
    modelRef.current = id;
    setModel(id);
    saveDefaultModel(id);
    return true;
  };

  const openPicker = () => {
    const idx = flatModels.findIndex((e) => e.id === modelRef.current);
    setPickerSelectedBoth(idx >= 0 ? idx : 0);
    setPickerOpenBoth(true);
  };

  const pickModel = (id: string) => {
    setPickerOpenBoth(false);
    if (setModelById(id)) pushSystem(`Model aktif: ${id}`);
  };

  const send = async (text: string) => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setGotFirstDelta(false);
    setError(null);
    const history: ChatMessage[] = [...messagesRef.current.filter((m) => m.kind === "chat"), { role: "user", content: text }];
    setMessages((m) => [...m, { role: "user", content: text, kind: "chat" }]);
    // Placeholder assistant message, filled by the stream.
    setMessages((m) => [...m, { role: "assistant", content: "", kind: "chat" }]);
    const currentModel = modelRef.current;
    try {
      const { usage } = await streamChat(apiKey, currentModel, history, {
        onDelta: (delta) => {
          setGotFirstDelta(true);
          setMessages((m) => {
            const copy = [...m];
            const last = copy[copy.length - 1];
            if (last && last.role === "assistant") {
              copy[copy.length - 1] = { ...last, content: last.content + delta };
            }
            return copy;
          });
        },
        onUsage: (u) => setLastUsage({ usage: u, model: currentModel }),
      });
      if (!usage) {
        setLastUsage((prev) => prev);
      }
    } catch (e) {
      const message = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
      setError(message);
      setMessages((m) => {
        const copy = [...m];
        const last = copy[copy.length - 1];
        if (last && last.role === "assistant" && last.content === "") copy.pop();
        return copy;
      });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const showModelsList = () => {
    const freeList = catalog.entries.filter((e) => e.free).map((e) => e.id);
    const paidList = catalog.entries
      .filter((e) => !e.free && e.price)
      .map((e) => `${e.id}  $${e.price!.input.toFixed(2)}/$${e.price!.output.toFixed(2)}`);
    pushSystem(
      "FREE $0.00\n" + freeList.join("\n") + "\n\nPAID ($ per 1M in/out)\n" + paidList.join("\n"),
    );
  };

  const handleSlash = (raw: string) => {
    const [cmd, ...rest] = raw.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "exit":
      case "quit":
        exit();
        break;
      case "clear":
        setMessages([]);
        setLastUsage(null);
        break;
      case "help":
        pushSystem(HELP_LINES.join("\n"));
        break;
      case "models":
        showModelsList();
        break;
      case "model":
        if (arg) setModelById(arg);
        else openPicker();
        break;
      case "account":
        pushSystem(
          "Akun MethaTech\n" +
            `Login: ya (key tersimpan di CLI)\n` +
            `Balance: ${balanceUsd === null ? "—" : formatUsd(balanceUsd)}\n` +
            `Model aktif: ${modelRef.current}\n` +
            `Top up: ${TOPUP_URL}\n` +
            `Detail lengkap: ${LOGIN_URL}`,
        );
        break;
      case "keys":
        pushSystem(
          "API key\n" +
            "Key tersimpan di CLI ini (file ~/.config/metatech/credentials.json).\n" +
            `Kelola dan buat key baru di panel: ${TOKEN_PAGE_URL}\n` +
            "Lalu jalankan: methatech login",
        );
        break;
      case "topup":
        pushSystem(`Top up MethaTech lewat:\n${TOPUP_URL}`);
        tryOpenUrl(TOPUP_URL);
        break;
      default:
        pushSystem(`Perintah tidak dikenal: /${cmd}. Ketik /help.`);
    }
  };

  /** Run the palette's selected command, keeping any typed argument.
      Computes the filtered list fresh from the ref (not closure state)
      so a fast "/exit" + Enter can never pick a stale first row. */
  const runPaletteCommand = () => {
    const q = inputRef.current.slice(1).split(/\s+/)[0] ?? "";
    const list = filterCommands(q);
    const selected = list[paletteSelectedRef.current];
    if (!selected) return false;
    const arg = inputRef.current.slice(1).split(/\s+/).slice(1).join(" ").trim();
    setInputBoth("");
    handleSlash(`/${selected.name}${arg ? ` ${arg}` : ""}`);
    return true;
  };

  // Single central keyboard handler for ONE atomic keypress. Priority:
  // Ctrl+C > picker > palette > normal chat. Palette and picker never
  // install their own useInput. Mode decisions read the synchronous refs
  // (not closure state) so rapid keystrokes cannot be decided against a
  // stale render.
  const handleAtomicKey = (inputKey: string, key: Key) => {
    // 1. Ctrl+C always exits, in every mode — even while sending.
    if (key.ctrl && inputKey === "c") {
      exit();
      return;
    }
    // While a request is active, ignore everything except Ctrl+C.
    if (sendingRef.current) return;

    const curInput = inputRef.current;
    const curPickerOpen = pickerOpenRef.current;
    const curPaletteOpen = curInput.startsWith("/") && !curPickerOpen;
    const curQuery = curPaletteOpen ? (curInput.slice(1).split(/\s+/)[0] ?? "") : "";
    const curFiltered = curPaletteOpen ? filterCommands(curQuery) : [];

    // 2. Model picker owns the keys while it is open.
    if (curPickerOpen) {
      if (key.upArrow) {
        setPickerSelectedBoth(pickerPrev(pickerSelectedRef.current, flatModels.length));
        return;
      }
      if (key.downArrow) {
        setPickerSelectedBoth(pickerNext(pickerSelectedRef.current, flatModels.length));
        return;
      }
      if (key.return) {
        const entry = flatModels[pickerSelectedRef.current];
        if (entry) pickModel(entry.id);
        return;
      }
      if (key.escape) {
        setPickerOpenBoth(false); // Cancel: active model unchanged.
        return;
      }
      return; // Any other key is swallowed while the picker is open.
    }

    // 3. Command palette owns the keys while it is open.
    if (curPaletteOpen) {
      if (key.upArrow) {
        setPaletteSelectedBoth(palettePrevIndex(paletteSelectedRef.current, curFiltered.length));
        return;
      }
      if (key.downArrow) {
        setPaletteSelectedBoth(paletteNextIndex(paletteSelectedRef.current, curFiltered.length));
        return;
      }
      if (key.return) {
        // Enter runs the selected command; if nothing matches, fall
        // through to normal slash handling (unknown-command message).
        if (!runPaletteCommand()) {
          const text = curInput.trim();
          setInputBoth("");
          if (text.startsWith("/")) handleSlash(text);
        }
        return;
      }
      if (key.escape) {
        // Close the palette and clear the input (documented behaviour:
        // Esc always leaves a clean, empty input line).
        setInputBoth("");
        return;
      }
      if (key.backspace || key.delete) {
        setInputBoth((v) => v.slice(0, -1));
        return;
      }
      // Typing filters the palette (it does not append to a message).
      if (inputKey && !key.ctrl && !key.meta) {
        setInputBoth((v) => v + inputKey);
      }
      return;
    }

    // 4. Normal chat mode.
    if (key.return) {
      const text = curInput.trim();
      if (!text) return;
      setInputBoth("");
      if (text.startsWith("/")) handleSlash(text);
      else void send(text);
      return;
    }
    if (key.upArrow) {
      cycleModel(-1);
      return;
    }
    if (key.downArrow) {
      cycleModel(1);
      return;
    }
    if (key.backspace || key.delete) {
      setInputBoth((v) => v.slice(0, -1));
      return;
    }
    if (key.escape) {
      setInputBoth("");
      return;
    }
    if (inputKey && !key.ctrl && !key.meta) {
      setInputBoth((v) => v + inputKey);
    }
  };

  // Ink delivers a fast-typed/pasted run of plain characters as ONE input
  // event (its own useInput docs say so): e.g. "halo\r" arrives as a single
  // string whose key carries no `return` flag, so a trailing Enter in the
  // same chunk would otherwise land inside the input text instead of
  // submitting (observed live: "/exit" + Enter sent in one tmux send-keys
  // needed a second Enter; same for a pasted message + Enter). Split such
  // runs back into atomic keypresses and run each through the same handler,
  // in order. CRLF counts as one Return.
  useInput((inputKey, key) => {
    if (inputKey.length <= 1) {
      handleAtomicKey(inputKey, key);
      return;
    }
    let lastWasReturn = false;
    for (const ch of inputKey) {
      if (ch === "\r" || ch === "\n") {
        if (lastWasReturn) continue; // CRLF = one Return.
        lastWasReturn = true;
        handleAtomicKey("", { ...key, return: true });
      } else if (ch === "\x03") {
        exit();
        return;
      } else if (ch === "\x7f" || ch === "\x08") {
        lastWasReturn = false;
        handleAtomicKey("", { ...key, backspace: true });
      } else {
        lastWasReturn = false;
        handleAtomicKey(ch, key);
      }
    }
  });

  return (
    <Box flexDirection="column" backgroundColor={theme.background} paddingX={1} width={columns}>
      <Box flexDirection="column">
        <Box>
          <Text color={theme.accent} bold>
            MethaTech
          </Text>
          <Text color={theme.muted}> · </Text>
          <Text color={theme.text} bold>
            {model}
          </Text>
          {!narrow && (
            <>
              <Text color={theme.muted}> · </Text>
              {free ? (
                <Text color={theme.accent} bold>
                  FREE $0.00
                </Text>
              ) : price ? (
                <Text color={theme.accent}>
                  ${price.input.toFixed(2)} / ${price.output.toFixed(2)} per 1M
                </Text>
              ) : (
                <Text color={theme.muted}>harga —</Text>
              )}
              <Text color={theme.muted}> · </Text>
              <Text color={balanceUsd === null ? theme.muted : theme.text}>
                Balance {balanceUsd === null ? "—" : formatUsd(balanceUsd)}
              </Text>
            </>
          )}
        </Box>
        {narrow && (
          <Box>
            {free ? (
              <Text color={theme.accent} bold>
                FREE $0.00
              </Text>
            ) : price ? (
              <Text color={theme.accent}>
                ${price.input.toFixed(2)} / ${price.output.toFixed(2)} per 1M
              </Text>
            ) : (
              <Text color={theme.muted}>harga —</Text>
            )}
            <Text color={theme.muted}> · </Text>
            <Text color={balanceUsd === null ? theme.muted : theme.text}>
              Balance {balanceUsd === null ? "—" : formatUsd(balanceUsd)}
            </Text>
          </Box>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        {messages.length === 0 && (
          <Text color={theme.muted}>Ketik pesan lalu Enter. /help untuk perintah. ↑↓ ganti model.</Text>
        )}
        {messages.map((m, i) => (
          <Box key={i} marginBottom={1} flexDirection="column">
            {m.kind === "system" ? (
              <Text color={theme.muted}>{m.content}</Text>
            ) : m.role === "user" ? (
              <Text>
                <Text color={theme.userLabel} bold>
                  You:{" "}
                </Text>
                <Text color={theme.text}>{m.content}</Text>
              </Text>
            ) : (
              <Box flexDirection="column">
                <Text color={theme.accent} bold>
                  Muse:
                </Text>
                {splitMessageParts(m.content).map((part, j) =>
                  part.type === "code" ? (
                    <CodeBlock key={j} code={part.content} lang={part.lang} />
                  ) : (
                    <Text key={j} color={theme.text}>
                      {part.content}
                    </Text>
                  ),
                )}
              </Box>
            )}
          </Box>
        ))}
      </Box>

      {thinking && (
        <Box marginTop={1}>
          <Thinking />
        </Box>
      )}

      {lastUsage && (
        <Box marginTop={1}>
          <Text color={theme.muted}>{formatUsageLine(lastUsage.usage, priceFor(catalog, lastUsage.model))}</Text>
        </Box>
      )}
      {error && (
        <Box marginTop={1}>
          <Text color={theme.error}>{error}</Text>
        </Box>
      )}

      {pickerOpen ? (
        <Box marginTop={1}>
          <ModelPicker
            catalog={catalog}
            selectedIndex={pickerSelected}
            activeModel={model}
            maxRows={pickerMaxRows}
            maxWidth={contentWidth}
          />
        </Box>
      ) : null}

      {paletteOpen && !pickerOpen ? (
        <Box marginTop={1}>
          <CommandPalette
            commands={filteredCommands}
            selectedIndex={paletteSelected}
            maxWidth={contentWidth}
          />
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color={theme.accent} bold>
          ❯{" "}
        </Text>
        <Text color={theme.text}>{input}</Text>
        {!sending && (
          <Text color={theme.accent} bold>
            ▋
          </Text>
        )}
      </Box>
      <Box>
        <Text color={theme.muted}>↑↓ ganti model · / perintah · /model pilih model · Ctrl+C keluar</Text>
      </Box>
    </Box>
  );
}
