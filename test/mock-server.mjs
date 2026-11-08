// Tiny mock MethaTech API server (zero dependencies) for PTY/TUI tests.
// Serves the endpoints the CLI uses, with canned data. No network access.
// Usage: node test/mock-server.mjs [port]  (default 18099)
// Env: MOCK_PORT, MOCK_SSE_FIRST_DELAY_MS (delay before the first SSE
// chunk, default 60 — raise it to observe the Thinking indicator).
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? process.argv[2] ?? 18099);

const CATALOG = {
  "deepseek-v4-flash": { owned_by: "DeepSeek", price: { input: 0.25, output: 1.0 } },
  "glm-5.3-flash": { owned_by: "Zhipu", price: { input: 0.125, output: 0.425 } },
  "gpt-6-luna": { owned_by: "OpenAI", price: { input: 0.085, output: 0.425 } },
  "gemini-3.8-flash": { owned_by: "Gemini", price: { input: 1.25, output: 6.25 } },
  "claude-sonnet-4-6": { owned_by: "Anthropic", price: { input: 2.5, output: 12.5 } },
  "qwen3.8-flash": { owned_by: "Qwen", price: { input: 0.125, output: 0.4 } },
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (req.method === "GET" && url.pathname === "/api/available_model") {
    return send(200, { success: true, data: CATALOG });
  }
  if (req.method === "GET" && url.pathname === "/v1/models") {
    return send(200, {
      data: Object.keys(CATALOG).map((id) => ({ id, owned_by: CATALOG[id].owned_by })),
    });
  }
  if (req.method === "GET" && url.pathname === "/v1/dashboard/billing/subscription") {
    return send(200, {
      has_payment_method: false,
      soft_limit_usd: 1,
      hard_limit_usd: 1,
      system_hard_limit_usd: 1,
      access_until: 0,
    });
  }
  if (req.method === "GET" && url.pathname === "/v1/dashboard/billing/usage") {
    return send(200, { total_usage: 5000 });
  }
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    // Canned SSE stream: two deltas + usage in the final chunk.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const chunks = [
      { choices: [{ delta: { content: "Halo! " } }] },
      { choices: [{ delta: { content: "Ini balasan mock." } }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      },
    ];
    const firstDelay = Number(process.env.MOCK_SSE_FIRST_DELAY_MS ?? 60);
    let i = 0;
    const sendNext = () => {
      if (i < chunks.length) {
        res.write(`data: ${JSON.stringify(chunks[i])}\n\n`);
        i++;
        setTimeout(sendNext, 60);
      } else {
        res.write("data: [DONE]\n\n");
        res.end();
      }
    };
    setTimeout(sendNext, firstDelay);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/device/code") {
    return send(200, {
      success: true,
      data: {
        device_code: "mock-device-code",
        user_code: "MOCK-CODE",
        verification_uri: "http://127.0.0.1:18099/device/authorize",
        verification_uri_complete: "http://127.0.0.1:18099/device/authorize?user_code=MOCK-CODE",
        expires_in: 600,
        interval: 5,
      },
    });
  }
  return send(404, { success: false, message: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock-server listening on 127.0.0.1:${PORT}`);
});
