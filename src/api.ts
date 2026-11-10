import { apiBase, consoleBase } from "./config.js";
import type { OpenAiFunctionTool } from "./agent/tool-registry.js";

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = "") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function friendlyError(status: number, bodyText: string): ApiError {
  let message = bodyText.slice(0, 300);
  let code = "";
  try {
    const j = JSON.parse(bodyText) as { error?: { message?: string; code?: string; type?: string }; message?: string };
    if (j.error?.message) message = j.error.message;
    else if (typeof j.message === "string") message = j.message;
    if (j.error?.code) code = j.error.code;
  } catch {
    // keep raw text
  }
  if (status === 401) return new ApiError(401, "API key tidak valid. Jalankan: methatech login", code);
  if (status === 402) {
    return new ApiError(
      402,
      "Saldo dan free credits habis. Top up dulu: methatech topup",
      code
    );
  }
  if (status === 429) return new ApiError(429, `Terlalu banyak request / model sibuk (${message})`, code);
  return new ApiError(status, `API error ${status}: ${message}`, code);
}

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

/**
 * Error from the device-code flow. `terminal` means the code itself is dead
 * (unknown / expired / already claimed): polling must stop. Any other
 * DeviceFlowError from requestDeviceCode (network error, 404/405 = panel
 * does not support the flow yet) means the caller should fall back to the
 * manual paste flow.
 */
export class DeviceFlowError extends Error {
  terminal: boolean;
  constructor(message: string, terminal = false) {
    super(message);
    this.terminal = terminal;
  }
}

/** POST {consoleBase}/api/device/code — ask the panel for a device code. */
export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  let res: Response;
  try {
    res = await fetch(`${consoleBase()}/api/device/code`, {
      method: "POST",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new DeviceFlowError("tidak bisa menghubungi panel");
  }
  if (!res.ok) {
    throw new DeviceFlowError(`panel mengembalikan HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    success?: boolean;
    message?: string;
    data?: {
      device_code?: string;
      user_code?: string;
      verification_uri?: string;
      verification_uri_complete?: string;
      expires_in?: number;
      interval?: number;
    };
  };
  const d = json.data;
  if (!json.success || !d || typeof d.device_code !== "string" || typeof d.user_code !== "string") {
    throw new DeviceFlowError("respons device-code dari panel tidak valid");
  }
  return {
    deviceCode: d.device_code,
    userCode: d.user_code,
    verificationUri: d.verification_uri ?? "",
    verificationUriComplete: d.verification_uri_complete ?? d.verification_uri ?? "",
    expiresIn: typeof d.expires_in === "number" && d.expires_in > 0 ? d.expires_in : 600,
    interval: typeof d.interval === "number" && d.interval > 0 ? d.interval : 5,
  };
}

export type DeviceTokenResult =
  | { status: "pending" }
  | { status: "approved"; apiKey: string }
  | { status: "denied" }
  | { status: "slow_down" };

/**
 * POST {consoleBase}/api/device/token — one poll for the device code status.
 * 429 slow_down is a normal back-off signal, not an error. 400/410 means
 * the code is unknown / expired / already claimed (terminal).
 */
export async function pollDeviceToken(deviceCode: string): Promise<DeviceTokenResult> {
  let res: Response;
  try {
    res = await fetch(`${consoleBase()}/api/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: deviceCode }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new DeviceFlowError("tidak bisa menghubungi panel");
  }
  if (res.status === 429) return { status: "slow_down" };
  if (res.status === 400 || res.status === 410) {
    throw new DeviceFlowError("kode sudah tidak berlaku", true);
  }
  if (!res.ok) {
    throw new DeviceFlowError(`panel mengembalikan HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    success?: boolean;
    message?: string;
    data?: { status?: string; api_key?: string };
  };
  if (!json.success) {
    if (json.message === "slow_down") return { status: "slow_down" };
    throw new DeviceFlowError(json.message || "respons device-token tidak valid");
  }
  const status = json.data?.status;
  if (status === "approved" && typeof json.data?.api_key === "string" && json.data.api_key.length > 0) {
    return { status: "approved", apiKey: json.data.api_key };
  }
  if (status === "denied") return { status: "denied" };
  return { status: "pending" };
}

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** Tool messages only: which tool produced this result. */
  name?: string;
  /** Tool messages only: id of the tool call (OpenAI-compatible). */
  tool_call_id?: string;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModelInfo {
  id: string;
  ownedBy: string;
}

export async function listModels(apiKey: string): Promise<ModelInfo[]> {
  const res = await fetch(`${apiBase()}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw friendlyError(res.status, await res.text());
  const json = (await res.json()) as { data?: { id?: string; owned_by?: string }[] };
  return (json.data ?? []).map((m) => ({ id: m.id ?? "", ownedBy: m.owned_by ?? "" }));
}

export interface Subscription {
  hasPaymentMethod: boolean;
  softLimitUsd: number;
  hardLimitUsd: number;
  systemHardLimitUsd: number;
  accessUntil: number;
}

export async function getSubscription(apiKey: string): Promise<Subscription> {
  const res = await fetch(`${apiBase()}/v1/dashboard/billing/subscription`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw friendlyError(res.status, await res.text());
  const j = (await res.json()) as {
    has_payment_method?: boolean;
    soft_limit_usd?: number;
    hard_limit_usd?: number;
    system_hard_limit_usd?: number;
    access_until?: number;
  };
  return {
    hasPaymentMethod: j.has_payment_method ?? false,
    softLimitUsd: j.soft_limit_usd ?? 0,
    hardLimitUsd: j.hard_limit_usd ?? 0,
    systemHardLimitUsd: j.system_hard_limit_usd ?? 0,
    accessUntil: j.access_until ?? 0,
  };
}

/**
 * Total usage as reported by the billing endpoint. The panel reports this
 * in cents (used_quota / 5000): divide by 100 to get dollars.
 * Verified against the live panel: used_quota 191,137 -> total_usage 38.2274.
 */
export async function getTotalUsageCents(apiKey: string): Promise<number> {
  const res = await fetch(`${apiBase()}/v1/dashboard/billing/usage`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw friendlyError(res.status, await res.text());
  const j = (await res.json()) as { total_usage?: number };
  return typeof j.total_usage === "number" ? j.total_usage : 0;
}

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onUsage: (usage: ChatUsage) => void;
  /** Reasoning deltas (delta.reasoning_content), when the server sends them. */
  onReasoning?: (text: string) => void;
  /** Finish reason from the final choice (stop/length/tool_calls/
   *  content_filter/...), when the server sends it. Added for the
   *  Fase 2 model adapter (it normalizes this into a `finish`
   *  chunk); no existing caller is affected. */
  onFinishReason?: (reason: string | null) => void;
  /** Native tool-call deltas (delta.tool_calls), when the server
   *  sends them. Fase 9 probe only: the panel normally forwards
   *  these only when the request carries `tools`. The CLI never
   *  sends tools outside the probe path (see model-adapter.ts). */
  onToolCallDelta?: (delta: ToolCallDelta) => void;
}

/** One streamed native tool-call delta (OpenAI SSE shape). */
export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  /** A fragment of the JSON arguments string; accumulate per index. */
  arguments?: string;
}

export interface StreamOptions {
  /** Abort the request (Esc / Ctrl+C interrupt). Combined with the 120s timeout. */
  signal?: AbortSignal;
  /**
   * Native function tools, sent verbatim to the panel relay.
   * Fase 9 probe only (the adapter gates it behind
   * probeNativeTools); the CLI never sends tools in normal use.
   */
  tools?: OpenAiFunctionTool[];
  /**
   * JSON mode request ({ type: "json_object" }). Fase 9 probe
   * only, to test structured-output support through the relay;
   * the CLI never sets it in normal use.
   */
  responseFormat?: { type: "json_object" };
}

/**
 * Stream one chat completion. The panel reports usage in the final SSE
 * chunk when stream_options.include_usage is set (verified live 2026-11-08).
 */
export async function streamChat(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  handlers: StreamHandlers,
  maxTokens = 1024,
  opts: StreamOptions = {},
): Promise<{ usage: ChatUsage | null }> {
  // Fase 7: the timeout signal is NAMED so a timeout abort can be
  // told apart from a user abort (Esc / Ctrl+C) below. Before this,
  // both surfaced as AbortError/TimeoutError and a slow model looked
  // exactly like a user interrupt — and a timeout was never
  // retryable. A timeout is a server-side failure: it is reported
  // as HTTP 408 so the adapter maps it to kind "server"
  // (retryable); a user abort stays an AbortError (not retryable).
  const timeoutSignal = AbortSignal.timeout(120000);
  const signals = [timeoutSignal];
  if (opts.signal) signals.push(opts.signal);
  /** Map an abort during the request (see above). */
  const mapAbort = (e: unknown): unknown => {
    if (opts.signal?.aborted) return e;
    if (timeoutSignal.aborted) {
      return new ApiError(408, "Permintaan ke model kehabisan waktu (120 detik). Model atau panel lambat — coba lagi.");
    }
    return e;
  };
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        // Fase 9 probe only: absent in normal use, so the request
        // is byte-identical to before when no probe option is set.
        ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
        ...(opts.responseFormat ? { response_format: opts.responseFormat } : {}),
      }),
      signal: AbortSignal.any(signals),
    });
  } catch (e) {
    throw mapAbort(e);
  }
  if (!res.ok) throw friendlyError(res.status, await res.text());
  if (!res.body) throw new ApiError(0, "Tidak ada body stream dari server");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: ChatUsage | null = null;

  const handleLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") return;
    try {
      const chunk = JSON.parse(payload) as {
        choices?: {
          delta?: {
            content?: string;
            reasoning_content?: string;
            tool_calls?: {
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }[];
          };
          finish_reason?: string | null;
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
      };
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) handlers.onDelta(delta);
      const reasoning = chunk.choices?.[0]?.delta?.reasoning_content;
      if (typeof reasoning === "string" && reasoning.length > 0) handlers.onReasoning?.(reasoning);
      const toolCalls = chunk.choices?.[0]?.delta?.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          const index = typeof tc.index === "number" ? tc.index : 0;
          const name = tc.function?.name;
          const args = tc.function?.arguments;
          if (typeof tc.id === "string" || typeof name === "string" || typeof args === "string") {
            handlers.onToolCallDelta?.({ index, id: tc.id, name, arguments: args });
          }
        }
      }
      const finishReason = chunk.choices?.[0]?.finish_reason;
      if (typeof finishReason === "string") handlers.onFinishReason?.(finishReason);
      if (chunk.usage && typeof chunk.usage.prompt_tokens === "number") {
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens ?? 0,
          totalTokens: chunk.usage.total_tokens ?? 0,
        };
        handlers.onUsage(usage);
      }
    } catch {
      // A split JSON line is reassembled by the buffer below; ignore the rest.
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of event.split("\n")) handleLine(line.trim());
        idx = buffer.indexOf("\n\n");
      }
    }
  } catch (e) {
    throw mapAbort(e);
  }
  // Flush any trailing partial event.
  for (const line of buffer.split("\n")) handleLine(line.trim());
  return { usage };
}
