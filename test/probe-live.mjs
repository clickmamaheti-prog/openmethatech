// Universal Agent Runtime — Fase 9 live probe.
//
// Runs the REAL CLI adapter (PanelChatAdapter, real streamChat
// transport) against the panel relay for each model in the Fase 9
// subset, and records what the model ACTUALLY does — native tool
// calls, XML fallback, structured output — one JSON line per probe
// on stdout.
//
//   node test/probe-live.mjs [model ...]
//
// The API key comes from METATECH_API_KEY (set by the bore runner
// from Reza's TEST account, id10) and is NEVER printed, logged, or
// written to any file: results contain only model names,
// capabilities, finish reasons, usage counts and short excerpts of
// MODEL output (truncated, control characters stripped). The probe
// never executes a tool — it only observes what the model returns.
//
// The API base comes from METATECH_API_BASE (the runner points it
// at the local panel, http://127.0.0.1:3000). Probes are MINIMAL:
// one short prompt and at most one small tool call per probe, free
// models first, Sonnet/Opus only a minimal probe each.
//
// This file is a test harness, not a product feature: it is not
// imported by the CLI, and it never changes the loop's default
// (the loop never sets probeNativeTools).

import { AdapterError, PanelChatAdapter } from "../dist/agent/model-adapter.js";
import { getRegisteredTool, toOpenAiFunction, validateToolInput } from "../dist/agent/tool-registry.js";
import { parseFullText } from "../dist/agent/xml-parser.js";

/** Fase 9 probe subset: 10 free + Sonnet + Opus + 1 per other provider.
 *  kimi-k2.7-code is NOT in the live catalog anymore (retired), so the
 *  free list that is actually testable is 9; Moonshot is represented
 *  by kimi-k3.1-pro instead. */
const SUBSET = [
  // Free (10 in the CLI list; kimi-k2.7-code no longer in the catalog).
  { id: "deepseek-v4-flash", provider: "DeepSeek", free: true },
  { id: "glm-5.3-flash", provider: "Zhipu", free: true },
  { id: "gpt-6-luna", provider: "OpenAI", free: true },
  { id: "gemini-3.8-flash", provider: "Google Gemini", free: true },
  { id: "gpt-6-astra", provider: "OpenAI", free: true },
  { id: "gemini-3.1-pro", provider: "Google Gemini", free: true },
  { id: "qwen3.8-flash", provider: "Qwen", free: true },
  { id: "qwen3.7-max", provider: "Qwen", free: true },
  { id: "deepseek-v4.1-flash", provider: "DeepSeek", free: true },
  // Anthropic.
  { id: "claude-sonnet-4-6", provider: "Anthropic", free: false },
  { id: "claude-opus-4-6-thinking", provider: "Anthropic", free: false },
  // One representative per other provider.
  { id: "command-r-plus-08-2024", provider: "Cohere", free: false },
  { id: "grok-4.7", provider: "xAI", free: false },
  { id: "methatech/uncensored", provider: "MethaTech", free: false },
  { id: "kimi-k3.1-pro", provider: "Moonshot", free: false },
];

const NATIVE_TOOLS = ["read_files", "list_directory"].map((name) => {
  const entry = getRegisteredTool(name);
  if (!entry) throw new Error(`probe tool not registered: ${name}`);
  return toOpenAiFunction(entry);
});

const NATIVE_PROMPT =
  'Call both tools in a single response: read_files with paths ["README.md"] and list_directory with path ".". Do not write any other text.';

const XML_PROMPT =
  "You have one tool, read_files. To call it, reply with ONLY this exact format and nothing else:\n" +
  '<codebuff_tool_call>{"cb_tool_name": "read_files", "paths": ["README.md"]}</codebuff_tool_call>\n' +
  "Do not write any other text.";

const STRUCTURED_PROMPT = 'Reply with exactly this JSON object and nothing else: {"ok": true, "answer": 42}';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Short excerpt of model output: truncated, control chars stripped. */
function excerpt(s, n = 300) {
  return (s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, n);
}

async function runOnce(adapter, request) {
  let text = "";
  let reasoning = "";
  let usage = null;
  let finishReason = null;
  const toolCalls = [];
  for await (const chunk of adapter.chat(request)) {
    switch (chunk.type) {
      case "text":
        text += chunk.text;
        break;
      case "reasoning":
        reasoning += chunk.text;
        break;
      case "usage":
        usage = chunk.usage;
        break;
      case "finish":
        finishReason = chunk.reason;
        break;
      case "tool_call":
        if (chunk.complete) toolCalls.push({ name: chunk.name, arguments: chunk.arguments, index: chunk.index });
        break;
    }
  }
  return { text, reasoning, usage, finishReason, toolCalls, streamComplete: usage !== null || finishReason !== null };
}

async function probe(adapter, apiKey, model, kind, request) {
  const started = Date.now();
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const r = await runOnce(adapter, { apiKey, model, ...request });
      return { status: "ok", attempt, ms: Date.now() - started, ...r };
    } catch (e) {
      const retryable = e instanceof AdapterError && e.retryable;
      if (retryable && attempt === 1) {
        console.error(`[${model}/${kind}] retryable ${e.kind}, retrying once...`);
        await sleep(2000);
        continue;
      }
      return {
        status: "error",
        attempt,
        ms: Date.now() - started,
        error: {
          kind: e instanceof AdapterError ? e.kind : "exception",
          status: e instanceof AdapterError ? (e.status ?? null) : null,
          message: excerpt(e instanceof Error ? e.message : String(e), 200),
        },
      };
    }
  }
}

function analyzeXml(text) {
  const parsed = parseFullText(text);
  const valid = [];
  const invalid = [];
  for (const call of parsed.toolCalls) {
    const entry = getRegisteredTool(call.toolName);
    if (!entry) {
      invalid.push({ toolName: call.toolName, reason: "unregistered tool" });
      continue;
    }
    const err = validateToolInput(entry, call.input);
    if (err) invalid.push({ toolName: call.toolName, reason: `schema: ${err}` });
    else valid.push({ toolName: call.toolName, input: call.input });
  }
  for (const err of parsed.parseErrors) invalid.push({ reason: `parse error: ${err}` });
  const hasTag = text.includes("<codebuff_tool_call") || text.includes("<codex_tool_call");
  return { valid, invalid, hasTag, filteredText: excerpt(parsed.filteredText) };
}

function analyzeStructured(text) {
  try {
    const obj = JSON.parse(text.trim());
    return { parsed: true, isObject: obj !== null && typeof obj === "object" && !Array.isArray(obj), ok: obj?.ok, answer: obj?.answer };
  } catch {
    return { parsed: false, isObject: false, ok: undefined, answer: undefined };
  }
}

async function main() {
  const apiKey = process.env.METATECH_API_KEY;
  if (!apiKey) {
    console.error("METATECH_API_KEY is not set — refusing to run without a key.");
    process.exit(1);
  }
  const wanted = process.argv.slice(2);
  const models = wanted.length > 0 ? SUBSET.filter((m) => wanted.includes(m.id)) : SUBSET;
  if (models.length === 0) {
    console.error("No requested model is in the Fase 9 subset.");
    process.exit(1);
  }
  const adapter = new PanelChatAdapter();
  for (const { id: model, provider, free } of models) {
    const base = { model, provider, free };
    console.error(`[probe] ${model} (${provider}${free ? ", free" : ""}) ...`);

    // A. Native tool calling (probe-only adapter option).
    const native = await probe(adapter, apiKey, model, "native", {
      messages: [{ role: "user", content: NATIVE_PROMPT }],
      maxTokens: 256,
      tools: NATIVE_TOOLS,
      probeNativeTools: true,
    });
    console.log(
      JSON.stringify({
        ...base,
        probe: "native",
        status: native.status,
        attempt: native.attempt,
        ms: native.ms,
        finishReason: native.finishReason ?? null,
        streamComplete: native.streamComplete ?? null,
        reasoningPresent: (native.reasoning?.length ?? 0) > 0,
        usage: native.usage ?? null,
        toolCalls: native.toolCalls ?? [],
        text: excerpt(native.text ?? ""),
        error: native.error ?? null,
      }),
    );

    // B. XML fallback (plain request, no tools — the loop's real path).
    const xml = await probe(adapter, apiKey, model, "xml", {
      messages: [{ role: "user", content: XML_PROMPT }],
      maxTokens: 256,
    });
    const xmlAnalysis = xml.status === "ok" ? analyzeXml(xml.text) : null;
    console.log(
      JSON.stringify({
        ...base,
        probe: "xml",
        status: xml.status,
        attempt: xml.attempt,
        ms: xml.ms,
        finishReason: xml.finishReason ?? null,
        streamComplete: xml.streamComplete ?? null,
        reasoningPresent: (xml.reasoning?.length ?? 0) > 0,
        usage: xml.usage ?? null,
        text: excerpt(xml.text ?? ""),
        xml: xmlAnalysis,
        error: xml.error ?? null,
      }),
    );

    // C. Structured output (JSON mode, probe-only adapter option).
    const structured = await probe(adapter, apiKey, model, "structured", {
      messages: [{ role: "user", content: STRUCTURED_PROMPT }],
      maxTokens: 128,
      responseFormat: { type: "json_object" },
    });
    const structAnalysis = structured.status === "ok" ? analyzeStructured(structured.text) : null;
    console.log(
      JSON.stringify({
        ...base,
        probe: "structured",
        status: structured.status,
        attempt: structured.attempt,
        ms: structured.ms,
        finishReason: structured.finishReason ?? null,
        streamComplete: structured.streamComplete ?? null,
        reasoningPresent: (structured.reasoning?.length ?? 0) > 0,
        usage: structured.usage ?? null,
        text: excerpt(structured.text ?? ""),
        structured: structAnalysis,
        error: structured.error ?? null,
      }),
    );
    console.error(`[probe] ${model} done.`);
  }
  console.error("[probe] all models done.");
}

main().catch((e) => {
  console.error(`probe crashed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
