import React, { useState, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { theme } from "../theme.js";
import { streamChat, ApiError, type ChatMessage, type ChatUsage } from "../api.js";
import { priceFor, isFreeModel, DEFAULT_MODEL, FALLBACK_MODEL, type Catalog } from "../models.js";
import { formatUsageLine, formatUsd } from "../cost.js";
import { saveDefaultModel } from "../config.js";

type DisplayMessage = ChatMessage & { kind: "chat" | "system" };

interface ChatAppProps {
  apiKey: string;
  initialModel: string;
  catalog: Catalog;
  balanceUsd: number | null;
}

const HELP_LINES = [
  "/models — lihat daftar model",
  "/model <id> — ganti model",
  "/clear — bersihkan layar chat",
  "/help — bantuan ini",
  "/exit — keluar",
  "↑↓ ganti model · Enter kirim · Ctrl+C keluar",
];

export default function ChatApp({ apiKey, initialModel, catalog, balanceUsd }: ChatAppProps) {
  const { exit } = useApp();
  const [model, setModel] = useState(initialModel);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [lastUsage, setLastUsage] = useState<{ usage: ChatUsage; model: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const modelRef = useRef(model);
  modelRef.current = model;

  const modelIds = catalog.entries.map((e) => e.id);
  const price = priceFor(catalog, model);
  const free = isFreeModel(model);

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
      setMessages((m) => [
        ...m,
        { role: "assistant", content: `Model ${id} tidak dikenal, dialihkan ke ${FALLBACK_MODEL}.`, kind: "system" },
      ]);
      modelRef.current = FALLBACK_MODEL;
      setModel(FALLBACK_MODEL);
      return false;
    }
    modelRef.current = id;
    setModel(id);
    saveDefaultModel(id);
    return true;
  };

  const send = async (text: string) => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    const history: ChatMessage[] = [...messages.filter((m) => m.kind === "chat"), { role: "user", content: text }];
    setMessages((m) => [...m, { role: "user", content: text, kind: "chat" }]);
    // Placeholder assistant message, filled by the stream.
    setMessages((m) => [...m, { role: "assistant", content: "", kind: "chat" }]);
    const currentModel = modelRef.current;
    try {
      const { usage } = await streamChat(
        apiKey,
        currentModel,
        history,
        {
          onDelta: (delta) => {
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
        }
      );
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
        setMessages((m) => [...m, { role: "assistant", content: HELP_LINES.join("\n"), kind: "system" }]);
        break;
      case "models": {
        const freeList = catalog.entries.filter((e) => e.free).map((e) => e.id);
        const paidList = catalog.entries
          .filter((e) => !e.free && e.price)
          .map((e) => `${e.id}  $${e.price!.input.toFixed(2)}/$${e.price!.output.toFixed(2)}`);
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            content:
              "FREE $0.00\n" +
              freeList.join("\n") +
              "\n\nPAID ($ per 1M in/out)\n" +
              paidList.join("\n"),
            kind: "system",
          },
        ]);
        break;
      }
      case "model":
        if (arg) setModelById(arg);
        else setMessages((m) => [...m, { role: "assistant", content: `Model aktif: ${modelRef.current}`, kind: "system" }]);
        break;
      default:
        setMessages((m) => [
          ...m,
          { role: "assistant", content: `Perintah tidak dikenal: /${cmd}. Ketik /help.`, kind: "system" },
        ]);
    }
  };

  useInput((inputKey, key) => {
    if (key.ctrl && inputKey === "c") {
      exit();
      return;
    }
    if (sendingRef.current) return;
    if (key.return) {
      const text = input.trim();
      if (!text) return;
      setInput("");
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
      setInput((v) => v.slice(0, -1));
      return;
    }
    if (key.escape) {
      setInput("");
      return;
    }
    if (inputKey && !key.ctrl && !key.meta) {
      setInput((v) => v + inputKey);
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color={theme.accent} bold>
          MethaTech
        </Text>
        <Text color={theme.muted}> · </Text>
        <Text color={theme.text} bold>
          {model}
        </Text>
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
        <Text color={balanceUsd === null ? theme.dim : theme.text}>
          Balance {balanceUsd === null ? "—" : formatUsd(balanceUsd)}
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {messages.length === 0 && (
          <Text color={theme.dim}>Ketik pesan lalu Enter. /help untuk perintah. ↑↓ ganti model.</Text>
        )}
        {messages.map((m, i) => (
          <Box key={i} marginBottom={1} flexDirection="column">
            {m.kind === "system" ? (
              <Text color={theme.dim}>{m.content}</Text>
            ) : m.role === "user" ? (
              <Text>
                <Text color="#7DD3FC" bold>
                  You:{" "}
                </Text>
                <Text color={theme.text}>{m.content}</Text>
              </Text>
            ) : (
              <Box flexDirection="column">
                <Text color={theme.accent} bold>
                  Muse:
                </Text>
                <Text color={theme.text}>{m.content || (sending && i === messages.length - 1 ? "…" : "")}</Text>
              </Box>
            )}
          </Box>
        ))}
      </Box>
      {lastUsage && (
        <Box marginTop={1}>
          <Text color={theme.dim}>{formatUsageLine(lastUsage.usage, priceFor(catalog, lastUsage.model))}</Text>
        </Box>
      )}
      {error && (
        <Box marginTop={1}>
          <Text color="#FF6B6B">{error}</Text>
        </Box>
      )}
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
        {sending && <Text color={theme.dim}> mengirim…</Text>}
      </Box>
      <Box>
        <Text color={theme.dim}>↑↓ ganti model · /models daftar · /help bantuan · Ctrl+C keluar</Text>
      </Box>
    </Box>
  );
}
