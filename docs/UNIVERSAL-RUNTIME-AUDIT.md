# MethaTech Universal Agent Runtime — FASE 1: Architecture Audit

**Tanggal:** 2026-11-10
**Status:** AUDIT SAJA — tidak ada kode implementasi yang ditulis, tidak ada file source yang diubah, tidak ada commit/publish/deploy.
**Repo yang diaudit:** `~/workspace/metatech-cli/` (HEAD `b384284` = 0.1.8 live; working tree berisi 0.1.9 §4j–§4q yang belum commit — audit bersifat read-only terhadap tree itu).
**Repo pendukung:** `~/workspace/panel-alternatif/done-hub/` (panel Go, Done Hub fork; dibaca seperlunya untuk sisi relay).
**Referensi:**
- Freebuff asli: `~/workspace/freebuff-source/` (CodebuffAI/freebuff, commit `5d8bd24`, Apache-2.0). BUKAN VectorHead.
- OpenTUI: `~/workspace/opentui-source/` (anomalyco/opentui, HEAD `c9d7a56`, `packages/core` v0.8.3, MIT) — clone depth-1 dibuat untuk audit ini.
- MCP TypeScript SDK: `~/workspace/mcp-typescript-sdk/` (modelcontextprotocol/typescript-sdk, commit `1e608ca`, root `2.0.0-alpha.0`, paket client/server `2.4.0`) — clone depth-1 dibuat untuk audit ini.
- Studi pendahuluan: `~/workspace/freebuff-study/LAPORAN.md`, `docs/AGENT-ADOPTION.md`, `docs/AGENT-IMPLEMENTATION.md` (§4j–§4q).

**Metode:** membaca source aktual + grep verifikasi. Setiap klaim "ada/tidak ada" dicek di file yang dikutip. Klaim yang TIDAK bisa diverifikasi dari source yang dibaca ditandai eksplisit sebagai BELUM TERVERIFIKASI, bukan diasumsikan. Kemampuan model TIDAK disimpulkan dari nama model.

---

## 0. Ringkasan eksekutif

### Temuan terbesar: separuh runtime universal SUDAH ada, tapi terbelah dua tempat

1. **Transport sudah provider-agnostic.** CLI hanya bicara ke satu endpoint OpenAI-compatible (`POST {apiBase}/v1/chat/completions`, SSE). Model hanyalah sebuah string (`src/api.ts:streamChat`). Ganti model tidak mengubah satu baris pun kode request. Adapter per-provider yang sesungguhnya hidup di **panel relay** (Go, 40+ provider di `providers/`, kontrak `ChatInterface` di `providers/base/interface.go:58`), bukan di CLI.
2. **Native tool calling sudah MUNGKIN end-to-end hari ini tanpa mengubah panel.** Relay meneruskan `tools` apa adanya ke upstream (`relay/chat.go`: `Tools != nil` → `skip_only_chat`; `relay/transformer/interface.go`: `UnifiedChatRequest.Tools []UnifiedTool`). Yang menghalangi hanyalah CLI **tidak pernah mengirim `tools`** (grep `tools:` di `src/` menghasilkan NOL). Semua tool calling CLI hari ini lewat protokol XML teks (`<codebuff_tool_call>`).
3. **Freebuff sudah menyelesaikan masalah yang sama dengan pola DUAL** — native AI SDK `tool-call` chunks + XML fallback dari text stream, dalam satu stream processor (`packages/agent-runtime/src/tool-stream-parser.ts:111` XML, `:146` native). Ini referensi langsung untuk spek §5, bukan teori.
4. **Yang belum ada sama sekali:** capability detection per model (di CLI, di panel, maupun di Freebuff — ketiganya tidak punya); permission layer per tool (hanya toolset per mode + sandbox path); context truncation/token budgeting otomatis (hanya `/compact` manual); retry policy untuk model call; secret redaction; audit logging eksekusi tool; validasi perintah shell (sandbox hanya membatasi `cwd` awal, bukan isi perintah).
5. **Keputusan arsitektur yang harus dibuat Reza sebelum Fase 2:** (a) confirmation gate untuk tool berisiko — spek §8 memintanya, tapi Reza pernah MENOLAK confirmation gate di 0.1.6 ("pake ada konfirmasi segala"); (b) di mana metadata capability tinggal — katalog panel vs registry statis di CLI; (c) runtime tetap lokal di CLI (arsitektur saat ini) atau pindah ke server seperti Freebuff (TIDAK direkomendasikan — lihat §5.5).

### Peta jalan yang direkomendasikan (berdasarkan audit, bukan urutan spek mentah)

| Urutan | Fase | Alasan urutan |
|---|---|---|
| 1 | Fase 3 — Shared Tool Registry (formal) | Paling murah, tanpa risiko: formalkan 11 tool yang sudah ada menjadi registry ber-schema + klasifikasi risiko. Fondasi semua fase lain. **SELESAI 2026-11-10 (docs/UNIVERSAL-RUNTIME-PHASE3.md).** |
| 2 | Fase 2 — Provider Adapter Standardization | Bungkus `streamChat` menjadi `ModelAdapter` internal; tambah `ModelCapabilities` yang diisi dari probe live (bukan dari nama model). **SELESAI 2026-11-10 (docs/UNIVERSAL-RUNTIME-PHASE2.md).** |
| 3 | Fase 5 — Universal Agent Loop | Loop bekerja melalui kontrak adapter (Fase 2) + orchestrator (Fase 4) dengan ledger eksekusi; tanpa native tools. **SELESAI 2026-11-10 (docs/UNIVERSAL-RUNTIME-PHASE5.md).** |
| 4 | Fase 6 — Fallback Tool Protocol | Formalkan protokol XML yang sudah ada (validasi ketat + pesan gagal eksplisit). |
| 5 | Fase 4 — Universal Tool Orchestrator | Ekstrak eksekusi dari loop; eksekusi paralel untuk call independen (butuh analisis keamanan dulu). |
| 6 | Fase 7 — Context & Streaming Integration | Token budgeting + auto-compaction (referensi Freebuff `compact-history.ts`) + retry policy. **SELESAI 2026-11-10 (docs/UNIVERSAL-RUNTIME-PHASE7.md).** |
| 7 | Fase 8 — Security Hardening | Validasi shell, secret redaction, audit log, namespace sandbox, permission enforcement. Confirmation gate + `--yolo` DIKECUALIKAN dari Fase 8 atas perintah Reza (tetap item terbuka keputusan 2026-11-10). **SELESAI 2026-11-10 (docs/UNIVERSAL-RUNTIME-PHASE8.md).** |
| 8 | Fase 9 — Cross-Model Testing | Mock provider per kontrak adapter, lalu integration test live per channel (butuh izin spend live). |
| 9 | Fase 10 — Final Audit & Documentation | **SELESAI 2026-11-10 (docs/UNIVERSAL-RUNTIME-PHASE10.md, FINAL-AUDIT.md, ARCHITECTURE.md).** |

**KOREKSI URUTAN 2026-11-10 (Reza, mengikat):** tabel di atas sempat
mengusulkan urutan berbeda dari spek — Fase 5 sebelum Fase 4.
Usulan itu TIDAK dipakai. Yang berlaku adalah roadmap asli spek §14:
**Fase 4 = Universal Tool Orchestrator, Fase 5 = Universal Agent
Loop.** Native Tool Calling bukan alasan mengubah definisi atau
urutan Fase 5. **Fase 4 SELESAI 2026-11-10
(docs/UNIVERSAL-RUNTIME-PHASE4.md)** — orchestrator terpisah
(`src/agent/tool-orchestrator.ts`), loop di-wire minimal, tes
279/279 + agent-pty 32/32 + tui-pty 270/270.

---

## 1. Architecture map — keadaan saat ini

### 1.1 Arsitektur CLI (lokal, TypeScript + Ink + React, Node.js + npm ONLY)

```
Termux / terminal pengguna
│
├─ src/cli.ts ── commander entry (methatech login/chat/models/account/keys/topup/logout)
│
├─ src/ui/ChatApp.tsx (1858 baris) ── TUI
│   ├─ DisplayMessage[] (state tampilan, BUKAN history model)
│   ├─ agentHistoryRef: ChatMessage[] (history model antar turn, in-memory sesi)
│   ├─ historyRef: string[] (riwayat pesan terkirim, Up/Down)
│   ├─ ModelPicker / CommandPalette / Thinking / status bar / footer
│   ├─ send(text) ── satu-satunya jalur kirim; selalu lewat runAgentLoop
│   └─ /compact, /init, /export (src/agent/slash.ts)
│
├─ src/agent/loop.ts ── runAgentLoop() — agent loop LOKAL
│   ├─ buildAgentSystemPrompt() (src/agent/prompt.ts) — system prompt dibangun
│   │   ULANG tiap turn (file tree 300 entri + knowledge + git status fresh)
│   ├─ callModel → streamChat() (default) atau mock (tests)
│   ├─ parseStreamChunk / parseFullText (src/agent/xml-parser.ts)
│   │   tag <codebuff_tool_call> (+ alias <codex_tool_call>) → JSON {cb_tool_name, ...}
│   ├─ executeToolCall() (src/agent/tools.ts) — eksekusi SEQUENSIAL, satu per satu
│   ├─ guard: MAX_STEPS 100 (cap absolut 600), NO_PROGRESS 40,
│   │   todo-loop 3/6, failed-edit 6, nudge max 2x
│   └─ hasil tool → pesan role "tool" {tool, ok, output} + name + tool_call_id sintetis
│
├─ src/agent/tools.ts ── 11 tool, definisi + handler + validasi tangan (tanpa Zod)
├─ src/agent/modes.ts ── DEFAULT/LITE/MAX/PLAN → toolset per mode
├─ src/agent/skills.ts ── SKILL.md lokal (project .agents/skills, ~/.config/metatech/skills)
├─ src/agent/prompt.ts ── system prompt + project context
├─ src/agent/slash.ts ── /init, /compact, /export
│
├─ src/api.ts ── SATU-SATUNYA jalur ke model
│   ├─ streamChat(apiKey, model, messages, {onDelta, onUsage, onReasoning?}, maxTokens=1024)
│   │   POST /v1/chat/completions {model, messages, max_tokens, stream:true,
│   │   stream_options:{include_usage:true}} — TIDAK PERNAH mengirim `tools`
│   ├─ listModels(), getSubscription(), getTotalUsageCents()
│   └─ requestDeviceCode() / pollDeviceToken() (login device-code)
│
├─ src/models.ts ── katalog: fetch /api/available_model (id, owned_by, price)
│   + COMPILED_PRICES fallback + FREE_MODEL_IDS (10 model, hardcoded)
├─ src/config.ts ── ~/.config/metatech/credentials.json (0600), METATECH_API_KEY,
│   apiBase() / consoleBase() (env override)
└─ src/cost.ts ── costOf() dari usage SSE chunk terakhir

Dependensi (package.json): commander, ink 6.8.0, react 19, remark/unified.
TIDAK ADA: zod, ai (Vercel AI SDK), @modelcontextprotocol/*, @opentui/*.
Node >= 20. TIDAK ada Bun.
```

### 1.2 Arsitektur panel relay (Go — adapter provider yang sesungguhnya)

```
POST api.methatech.eu.org/v1/chat/completions
│
├─ relay/chat.go — relayChat.setRequest()
│   ├─ Unmarshal ke types.ChatCompletionRequest
│   ├─ common.NormalizeNullContentWithToolCalls(messages) (common/message_filter.go:75)
│   ├─ Tools != nil → c.Set("skip_only_chat", true)   ← native tools DITERUSKAN
│   └─ Stream ? StreamOptions : nil
│
├─ relay/relay.go — routing channel + model mapping + quota + harga
│
├─ providers/base/interface.go:58 — ChatInterface (KONTRAK ADAPTER):
│   │   CreateChatCompletion(req *types.ChatCompletionRequest)
│   │   CreateChatCompletionStream(req *types.ChatCompletionRequest)
│   └─ 40+ provider di providers/ (openai, claude, gemini, cohere, deepseek,
│       zhipu, moonshot, ollama, openrouter, groq, mistral, xAI, vertexai, ...)
│
├─ relay/transformer/ — UnifiedChatRequest {Model, Messages, MaxTokens,
│   Temperature, Stream, Tools []UnifiedTool, ToolChoice, System}
│   + transformer per provider (claude.go, vertex_gemini.go) — konversi
│   format OpenAI ↔ format native provider
│
└─ Channel live (verifikasi live 2026-11-08, TIDAK di-query ulang dalam audit ini):
    id7  apinex     type 1  (OpenAI-compatible)  14 model
    id8  alibaba    type 1  (OpenAI-compatible)   5 model aktif
    id9  cohere     type 36 (Cohere native)      4 model aktif
    id10 vectorhead type 1  (OpenAI-compatible)  3 model (ag/* prefix mapping)
    id12 methatech  type 50 (VectorHead gateway) 1 model (methatech/uncensored)
    Total etalase: 29 model di DB, 27 aktif.
```

### 1.3 Aliran data satu turn agent (saat ini)

```
User mengetik → ChatApp.send()
  → runAgentLoop({apiKey, model, cwd, mode, userPrompt, history})
    → buildAgentSystemPrompt() + history + userPrompt
    → streamChat() → SSE text mentah (delta.content, delta.reasoning_content, usage)
      → parseStreamChunk() memisahkan teks tampil vs <codebuff_tool_call>
    → parseFullText() → toolCalls[] atau parseErrors[]
      → parseErrors → pesan [TOOL_CALL_ERROR], model retry (1 step)
      → tidak ada tool call → turn selesai (atau nudge max 2x bila janji tanpa call)
      → ada tool call → executeToolCall() SEQUENSIAL
        → hasil → pesan role "tool" JSON {tool, ok, output}
    → ulang sampai task_completed / no more tool calls / maxSteps / no-progress 40
  → agentHistoryRef = result.history (system prompt lama di-filter, diganti fresh tiap turn)
```

---

## 2. Audit CLI per area (spek §2)

| Area | Lokasi | Status | Provider-bound? |
|---|---|---|---|
| Model provider adapters | `src/api.ts` (streamChat) + panel relay | **Ada, tapi terbelah.** CLI: satu fungsi generik OpenAI-compatible. Panel: 40+ adapter + transformer. CLI tidak punya adapter per provider sama sekali. | CLI: tidak terikat (satu endpoint). Panel: terikat per channel (by design, dan itu benar). |
| Model selector | `src/ui/ModelPicker.tsx`, `src/models.ts` (fetchCatalog, FREE_MODEL_IDS) | **Berfungsi.** Picker + harga live + FREE first + cheapest first. Katalog dari `/api/available_model` (id, owned_by, price) + fallback compile-time. | **Sebagian terikat:** `owned_by` hanya label string; tidak ada metadata capability (context window, tool calling, multimodal) dari server. |
| Request/response pipeline | `src/api.ts:streamChat` | **Berfungsi, minimal.** POST JSON, SSE parse (`data:` lines, `[DONE]`), usage dari chunk terakhir. Timeout 120s + AbortSignal. | Tidak terikat provider. **TAPI:** tidak ada retry (bandingkan Freebuff `codebuff-web-api.ts`: 3 retry untuk 408/429/500/502/503/504). |
| Native function calling | — (tidak ada) | **BELUM ADA.** Grep `tools:` di `src/` = NOL. CLI tidak pernah mengirim `tools`/`tool_choice`, tidak pernah parse `delta.tool_calls`. | — |
| Agent execution loop | `src/agent/loop.ts` (390 baris) | **Berfungsi, teruji.** MAX_STEPS 100/600, no-progress 40, todo-loop 3/6, failed-edit 6, nudge 2x, ask_user pause, endsAgentStep, tool-call error retry. Test: agent-pty 32/32. | Tidak terikat provider (loop buta terhadap model; hanya string model id di prompt). |
| Tool registry | `src/agent/tools.ts` (`allToolDefinitions()`, `toolDefinitionsFor()`) | **Ada, informal.** 11 tool sebagai array `ToolDefinition {name, description, endsAgentStep?, execute}`. Bukan registry: tidak ada ID unik, input/output schema formal (validasi tangan per tool), permission level, timeout per tool, risk classification. | Tidak terikat provider. |
| Tool execution | `src/agent/tools.ts:executeToolCall()` | **Berfungsi.** Unknown tool → error result (bukan throw). Validasi → error result. Eksekusi SEQUENSIAL. Tidak ada eksekusi paralel. | Tidak terikat provider. |
| Shell executor | `run_terminal_command` di `tools.ts` | **Berfungsi, dengan CELAH.** bash `-c`, timeout default 120s / max 600s / -1 tanpa timeout, SIGTERM→SIGKILL 1500ms, output cap 50.000 head+tail. **Celah:** sandbox hanya membatasi `cwd` awal (resolveInside); ISI perintah tidak divalidasi — `cat ~/.config/metatech/credentials.json` akan jalan. | Tidak terikat provider. |
| File operations | `read_files, list_directory, glob, code_search, str_replace, write_file` | **Berfungsi.** Semua lewat `resolveInside()` (path absolut di luar cwd ditolak, `..` escape ditolak). read windowed (2000 baris), glob max 200, code_search max 50 hit, skip node_modules/.git/dist. | Tidak terikat provider. |
| Context management | `src/agent/prompt.ts`, `ChatApp.tsx` (agentHistoryRef), `src/agent/slash.ts` | **Sebagian.** History antar turn dipertahankan in-memory sesi; system prompt dibangun ulang tiap turn (fresh file tree + git status); `/compact` manual (ringkas via model, ganti history dengan ringkasan). **BELUM ADA:** truncation otomatis, token budgeting, auto-compaction, summarization berkala. History tumbuh tanpa batas sampai user `/compact`. | Tidak terikat provider. |
| Conversation history | `ChatApp.tsx:agentHistoryRef` + `DisplayMessage[]` | **Berfungsi, in-memory saja.** Tidak ada persistensi sesi ke disk (restart CLI = history hilang). Dua history terpisah: tampilan vs model — by design, tapi rawan drift (attachment full content hanya di history model). | Tidak terikat provider. |
| Streaming engine | `src/api.ts` (SSE reader) + `ChatApp.tsx` (onDelta → appendAssistantText, onReasoning → Thinking card) | **Berfungsi.** Reasoning (`delta.reasoning_content`) diteruskan ke Thinking card; usage dari chunk terakhir; auto-scroll 50ms; Thinking/Working indicator + `Agent step N · Ns · ■ Esc`. | Tidak terikat provider. |
| Error handling | `src/api.ts:friendlyError` (401/402/429), `loop.ts` (model call failed → stopReason), `ChatApp.tsx` (catch → setError, sanitize ANSI) | **Berfungsi, tanpa retry.** 401 → "key tidak valid, login lagi"; 402 → "saldo habis, topup"; 429 → "terlalu banyak request / model sibuk". Error provider diteruskan sebagai teks (disanitasi ANSI). | **Sebagian terikat:** pesan error memakai teks mentah provider; tidak ada normalisasi error per provider (bandingkan Freebuff `openai-compatible-error.ts`). |
| Authentication & permission | `src/config.ts` (credentials.json 0600), `src/commands.ts` (login device-code + paste fallback), `src/agent/modes.ts` | **Auth berfungsi. Permission MINIMAL.** Login: device-code (POST /api/device/code, /api/device/token) + paste fallback. Permission = SATU mekanisme: toolset per mode (PLAN cabut str_replace/write_file/run_terminal_command) + flag skill `disable-model-invocation`. **Tidak ada:** permission per tool, per kategori, per user/session; tidak ada confirmation gate (sengaja dihapus 0.1.6 atas perintah Reza); tidak ada audit log; tidak ada isolasi antar-session (semua tool jalan sebagai OS user yang sama). | Tidak terikat provider. |
| MCP integration | — (tidak ada) | **BELUM ADA.** Tidak ada dependensi MCP, tidak ada client MCP, tidak ada `server__tool`. Freebuff punya (`mcp.ts`, lihat §5.4). | — |
| Skills | `src/agent/skills.ts` | **Berfungsi, lokal saja.** Discovery `.agents/skills` + `.claude/skills` (project) + `~/.config/metatech/skills` + `~/.agents/skills` + `~/.claude/skills` (home). Frontmatter tervalidasi tangan (name, description, disable-model-invocation). Tool `skill` dengan `endsAgentStep: true`. Tidak ada remote registry. | Tidak terikat provider. |
| Modes | `src/agent/modes.ts` | **Berfungsi, satu stub.** DEFAULT/LITE/MAX/PLAN. LITE hanya ubah prompt (hemat). PLAN menegakkan via toolset (benar). **MAX = stub:** berperilaku seperti DEFAULT; best-of-n editor/reviewer (Fase 4) belum dibangun. | Tidak terikat provider. |
| Cost / usage | `src/cost.ts`, `src/api.ts` (onUsage) | **Berfungsi, sebagian.** Usage dari SSE chunk terakhir → `$X in / Y out · $Z`. **BELUM ADA:** usage per step agent (follow-up yang sudah dicatat), token budgeting. | Tidak terikat provider. |

---

## 3. Tool registry yang sudah ada (11 tool)

Sumber: `src/agent/tools.ts` (`allToolDefinitions()`), `src/agent/modes.ts` (`BASE_TOOL_NAMES`, `PLAN_REMOVED_TOOLS`).

| Tool | Deskripsi (kontrak saat ini: string di prompt) | Validasi input | Batasan eksekusi | Risiko |
|---|---|---|---|---|
| `read_files` | Baca 1+ file, windowed (start_line/end_line, max 2000 baris) | `paths: string[]` wajib | `resolveInside()`; file tidak ada → error result | Rendah (read-only) |
| `list_directory` | List direktori (default root) | `path?` opsional | `resolveInside()` | Rendah |
| `glob` | Cari file by glob (`**`, `*`, `?`), max 200 hasil | `pattern: string` wajib | skip node_modules/.git/dist | Rendah |
| `code_search` | Cari teks/regex di file, max 50 hit | `pattern: string` wajib; `path?` | `resolveInside()`; skip biner (byte NUL) | Rendah |
| `str_replace` | Ganti 1+ span teks eksak (array replacements + alias old/new) | `path` + `replacements[]` wajib; oldString harus cocok tepat 1x kecuali `allowMultiple` | Validasi SEMUA replacement dulu baru tulis (atomic); `resolveInside()` | **Tinggi (mutasi file)** |
| `write_file` | Buat/timpa file | `path` + `content` wajib | `mkdir -p` parent; `resolveInside()` | **Tinggi (mutasi file)** |
| `run_terminal_command` | Jalankan bash `-c` | `command: string` wajib; `timeout_seconds?` (default 120, max 600, -1 = tanpa timeout); `cwd?` | Timeout + SIGTERM→SIGKILL 1500ms; output cap 50.000 head+tail; **isi perintah TIDAK divalidasi** | **Kritis (arbitrary shell)** |
| `write_todos` | Ganti seluruh to-do list | `todos: [{task, completed?}]` | List sama → no-op + pesan (anti-loop) | Rendah |
| `task_completed` | Akhiri turn | `{}` (opsional `summary`) | — | Rendah |
| `ask_user` | Tanya user, turn pause | `questions: [{question, options?}]` | Jawaban user jadi pesan berikutnya | Rendah |
| `skill` | Muat SKILL.md | `name: string` wajib | `disable-model-invocation` dihormati; `endsAgentStep: true` | Sedang (isi skill masuk prompt) |

**Yang TIDAK dimiliki registry saat ini (gap vs spek §7):** unique ID (nama = ID), input schema formal (JSON Schema / Zod — validasi tangan per tool, tidak seragam), output schema (output = string bebas), permission level, timeout per tool (hanya shell yang punya), risk classification (hanya implisit di atas), audit logging, versioning.

**Perbandingan Freebuff:** 38 tool (`common/src/tools/constants.ts:25-100` — apply_patch, add_subgoal, ask_user, browser_logs, code_search, create_plan, end_turn, find_files, glob, gravity_index, list_directory, lookup_agent_info, propose_str_replace, propose_write_file, read_docs, read_files, read_subtree, read_url, render_ui, run_terminal_command, set_messages, set_output, skill, spawn_agents, spawn_agent_inline, str_replace, suggest_followups, task_completed, think_deeply, web_search, write_file, write_todos, ...). MethaTech memakai subset 11 (Fase 0, `docs/AGENT-ADOPTION.md` §9.2). Tool yang Freebuff punya dan MethaTech TIDAK punya (kandidat, BUKAN perintah membuat): `web_search`, `read_url`, `apply_patch`, `spawn_agents` (sub-agent), `think_deeply`, `find_files`, `read_subtree`, `propose_*` (mode propose). **Jangan menduplikasi:** `propose_*` dan `apply_patch` adalah varian dari `str_replace`/`write_file` yang sudah ada.

---

## 4. Audit panel relay — adapter yang sudah ada di server

Panel BUKAN sekadar proxy: ia adalah lapisan adapter provider yang lengkap. Ini penting karena menentukan di mana pekerjaan Fase 2 seharusnya tinggal.

| Komponen panel | File | Fungsi |
|---|---|---|
| Kontrak adapter | `providers/base/interface.go:58` | `ChatInterface { CreateChatCompletion, CreateChatCompletionStream }` (+ Completion, Embeddings, Moderation, Speech, Image, Responses interface terpisah) |
| Provider adapters | `providers/` (40+ direktori) | openai, claude, gemini, cohere, deepseek, zhipu, moonshot, ollama, openrouter, groq, mistral, xAI, vertexai, bedrock, azure, ... — masing-masing mengimplementasikan interface di atas |
| Transformer | `relay/transformer/interface.go` | `UnifiedChatRequest {Model, Messages, MaxTokens, Temperature, Stream, Tools []UnifiedTool, ToolChoice, System}` + `UnifiedMessage {Role, Content, ToolCalls, ToolCallId, CacheControl}` + `UnifiedTool {Type, Function{Name, Description, Parameters}}` — format internal seragam dengan dukungan tool |
| Transformer per provider | `relay/transformer/claude.go`, `vertex_gemini.go` | Konversi OpenAI ↔ format native Claude / Gemini |
| Chat relay | `relay/chat.go` | `Tools != nil` → `skip_only_chat`; raw passthrough untuk protokol chat; routing Responses API (`ShouldUseResponsesForModel`); image-model shunt |
| Normalisasi tool-call | `common/message_filter.go:75` | `NormalizeNullContentWithToolCalls` — pesan assistant dengan `tool_calls` tapi `content: null` → `content: ""` |
| Quota / harga | `relay/relay_util/quota.go` | `isPlaygroundFreeModel`, penghitungan quota; harga dari tabel DB `prices` (bukan `price.go`) |

**Implikasi untuk Fase 2:** adapter provider TIDAK perlu dibangun di CLI — sudah ada di panel. Yang perlu dibangun di CLI adalah **kontrak internal** antara loop dan `streamChat` (interface `ModelAdapter`), plus kemampuan mengirim `tools` dan mem-parse `tool_calls` dari SSE. Panel sudah siap menerima keduanya; validasi per channel (apakah upstream VectorHead/Alibaba/Cohere benar-benar menghormati `tools`) adalah pekerjaan Fase 9, bukan asumsi.

**Yang panel TIDAK sediakan (gap):** metadata capability per model di `/api/available_model` (hanya `id`, `owned_by`, `price` — lihat `src/models.ts:fetchCatalog`). Tidak ada `context_window`, `supports_tools`, `supports_vision`, `supports_reasoning` dari server. Kalau capability detection mau berbasis server, endpoint ini yang harus diperluas (keputusan: panel vs CLI — lihat §10).

---

## 5. Referensi Freebuff — apa yang sudah diselesaikan di sana

Semua kutipan dari `~/workspace/freebuff-source/` commit `5d8bd24`.

### 5.1 Adapter provider: Vercel AI SDK `LanguageModelV2` + per-model template

- **Adapter generik:** `packages/llm-providers/src/openai-compatible/` — `OpenAICompatibleChatLanguageModel` (chat), `...CompletionLanguageModel`, `...EmbeddingModel`, `...ImageModel`, factory `createOpenAICompatible` (`openai-compatible-provider.ts`), plus `convert-to-openai-compatible-chat-messages.ts`, `map-openai-compatible-finish-reason.ts`, `openai-compatible-error.ts`, `prepare-tools.ts` (konversi tool ke format OpenAI). Satu adapter melayani SEMUA provider OpenAI-compatible.
- **Provider routing:** `packages/agent-runtime/src/prompt-agent-stream.ts` — `getAgentStreamFromTemplate()` membangun `aiSdkStreamParams` (`messages, model, tools, toolChoice, maxRetries: 3, providerOptions` untuk `openrouter`/`codebuff`, `agentProviderOptions = template.providerOptions`) lalu memanggil `promptAiSdkStream` yang di-inject (Vercel AI SDK `streamText`).
- **Fallback provider:** `packages/agent-runtime/src/llm-api/gemini-with-fallbacks.ts` — Gemini gagal → Vertex AI → GPT-4o atau Claude Haiku 4.5. `llm-api/claude.ts` — pemanggilan Claude langsung (tanpa Anthropic SDK, tipe blok teks sendiri).
- **Per-model template (BUKAN per-model adapter):** `agents/` berisi satu file template per model: `base3-free-glm-5-3-flash.ts`, `base3-free-deepseek-flash.ts`, `base3-free-gemini-3-8-flash.ts`, `base3-free-gpt-6-1-sol.ts`, `base3-free-luna-6.ts`, `base3-free-muse-spark-1-3.ts`, ... — masing-masing mengatur prompt + `providerOptions` + `reasoningOptions` untuk model itu. **Pola kuncinya: kemampuan model diakomodasi lewat template prompt, bukan lewat kode adapter yang berbeda.**
- **Katalog model server-driven:** `cli/src/utils/freebuff-model-catalog.ts` — `GET /api/v1/freebuff/models`, refresh di `refreshAt`, mode fallback katalog compile-time bila server tidak mendukung. Row katalog (`common/src/types/freebuff-model-catalog.ts:157-213`): `key, handle, displayName, tagline, badges, multimodal: boolean, premium: boolean, dataUse, access: open|locked, efforts[], defaultEffort, reasoningEffort, contextWindow?, compaction {cacheExpiryMs, cacheExpiryMinTokens, maxContextLength?, lean?}, sortOrder, placement, peakPills, opensAt, legacyDigests`. **TIDAK ADA flag `supports_tools` / `supports_parallel_tools` / `supports_streaming` / `supports_vision` di katalog.** Freebuff tidak melakukan capability detection untuk tool calling — ia mengasumsikan protokol XML bekerja untuk semua model.

### 5.2 Agent loop: server-side, loopAgentSteps

- `packages/agent-runtime/src/run-agent-step.ts` — `loopAgentSteps` (:1115), `runAgentStep`, `shouldEndTurn` (:901-1030). Turn berakhir HANYA bila `task_completed` dipanggil (bila toolset memilikinya) — aturan ketat yang MethaTech SENGAJA longgarkan (turn berakhir bila tidak ada tool call) karena model gratis panel sering menjawab teks polos tanpa pernah memanggil `task_completed`.
- Guard yang sama dengan MethaTech: no-progress 40 (`util/turn-progress.ts`), todo-loop 3/6/12 (`util/todo-loop.ts`), file-edit-loop 3/6 (`util/file-edit-loop.ts`), `MAX_AGENT_STEPS_DEFAULT = 600` (`common/src/constants/agents.ts`) vs MethaTech 100.
- **Perbedaan arsitektur terbesar:** runtime Freebuff berjalan di SERVER (Codebuff web API, `llm-api/codebuff-web-api.ts` — retry 3x untuk 408/429/500/502/503/504, `FETCH_TIMEOUT_MS = 30_000`); CLI hanya mengirim pesan dan menerima stream event. MethaTech membalik ini: loop berjalan LOKAL di CLI, panel hanya relay chat polos. Pembalikan ini disengaja (`docs/AGENT-ADOPTION.md` §2.3) dan harus DIPERTAHANKAN — memindah runtime ke server berarti membangun backend agent baru + mengubah model ancaman (server mengeksekusi shell/file atas nama user).

### 5.3 Native + fallback tool calling: DUAL dalam satu stream processor (referensi spek §5)

`packages/agent-runtime/src/tool-stream-parser.ts` — `processStreamWithTools`:

- **Jalur XML (fallback):** `:111` — `parseStreamChunk(chunk.text, xmlParserState)` mem-parse `<codebuff_tool_call>` dari text stream; tool call yang ditemukan dieksekusi SEGERA via `executeXmlToolCall` dengan stream di-pause; id sintetis `xml-<uuid8>` (`:131`).
- **Jalur native:** `:146` — `chunk.type === 'tool-call'` (chunk AI SDK) diproses via `processToolCallObject` (`:63-81`), termasuk repair pass: AI SDK kadang meng-emit `input` sebagai string JSON mentah bila repair pass-nya gagal → coba `JSON.parse`, bila gagal biarkan string dan executor yang memberi error jelas.
- **ToolSet native tetap dikirim:** `prompt-agent-stream.ts` mengirim `tools` (AI SDK `ToolSet`) + `toolChoice` ke `streamText` — jadi model yang mendukung native calling memakainya, model yang tidak mendukung tetap bisa lewat XML teks.
- **Parser XML yang sama** dipakai MethaTech: `packages/agent-runtime/src/util/stream-xml-parser.ts` → `src/agent/xml-parser.ts` (dengan alias `<codex_tool_call>` tambahan + parse error dilaporkan, bukan didiamkan).
- **Permission di tool-executor** (`tools/tool-executor.ts:364-374, 553`): tool yang tidak ada di `agentTemplate.toolNames` ditolak dengan error event "not currently available... permission to use" — ini permission KEANGGOTAAN TOOLSET, bukan permission keamanan. Sama persis dengan mekanisme mode MethaTech. Freebuff TIDAK punya confirmation gate, risk classification, atau audit log eksekusi tool.

### 5.4 MCP di Freebuff: client-side, tools sebagai data

- `packages/agent-runtime/src/mcp.ts` — `getMCPToolData()`: meminta definisi tool dari MCP server via `requestMcpToolData({mcpConfig, toolNames})`; nama yang dilihat model = `server__tool` (`mcpExposedToolName`, dengan sanitasi + hash bila nama mengandung karakter ilegal atau >64 char); schema JSON mentah disimpan (BUKAN Zod — Zod cyclic, tidak bisa JSON-serialize ke run state); MCP tools diberi `endsAgentStep: true`; server MCP yang gagal hanya menonaktifkan tool-nya sendiri, bukan menggagalkan turn.
- **Yang Freebuff TIDAK lakukan dengan MCP:** tidak ada permission/approval untuk MCP tools; tidak ada validasi input di client (validasi di server MCP).
- **Relevansi:** pola `server__tool` + "tool sebagai data dari server" adalah cara yang benar menambah tool dinamis tanpa mengubah kode. MethaTech belum butuh ini sampai ada server MCP eksternal yang dikonsumsi.

### 5.5 Context management Freebuff (referensi Fase 7)

- `packages/agent-runtime/src/compact-history.ts` — compaction dengan budget token eksplisit: `MECHANICAL_HISTORY_TOKENS = 12_000`, `USER_MEMORY_TOKENS = 24_000`, `MAX_PROTECTED_TOOL_CALLS = 100`, `compactMessages()`, `compactHistoryNow()`; `compaction.ts` — `automaticCompactionPostCeiling`, `compactedContextCeiling`, `compactionOverBudgetMessage`. Compaction OTOMATIS berbasis budget, bukan manual.
- `agents/context-pruner.ts`, `agents/lean-context.ts` — pruning konteks per model (budget `contextPrunerBudgetForModel`).
- MethaTech tidak punya satu pun dari ini: hanya `/compact` manual (`src/agent/slash.ts:compactPrompt` — ringkas via model, potong tiap pesan ke 4000 char) dan system prompt yang dibangun ulang tiap turn.

### 5.6 Yang Freebuff TIDAK punya (jangan dicari di sana)

- Capability matrix / capability detection per model (tidak ada flag tool-calling di katalog maupun konstanta).
- Permission system keamanan (hanya keanggotaan toolset).
- Secret redaction / audit logging eksekusi tool.
- Sub-agent Fase 3 MethaTech (`spawn_agents` ada di Freebuff; MethaTech sengaja belum membangunnya).

---

## 6. Referensi OpenTUI — ringkasan studi

Sumber: studi read-only atas `~/workspace/opentui-source/` (HEAD `c9d7a56`, `packages/core` v0.8.3, MIT). Detail lengkap ada di laporan agen studi; di sini hanya yang relevan untuk runtime.

- **Apa itu:** library TUI — TypeScript (API) + Zig (engine) + C++ (jembatan Yoga). Monorepo Bun workspaces (`packageManager: bun@1.4.1`). **BUKAN agent runtime, BUKAN provider model, BUKAN tool calling** — grep seluruh `packages/` untuk `openai|anthropic|tool_call|function_call|chat.completions` menghasilkan NOL di source (satu-satunya hit `openai` adalah string contoh di fixture test). Tidak ada direktori agent/tool/provider/model.
- **Layout tetap Yoga** (`packages/native/src/yoga.zig`, `yoga-bridge.cpp`) — bedanya Yoga jalan lewat jembatan native Zig/C++, bukan binding JS seperti Ink.
- **ScrollBox + scrollbar bawaan ADA** (`packages/core/src/renderables/ScrollBox.ts`, `ScrollBar.ts`, `ScrollBoxParts.ts`). Visibilitas dikendalikan API resmi: `verticalScrollBar.visible = false` → policy `never` (bar hilang permanen), `= null` → auto (`ScrollBoxParts.ts:448-458`); auto-hide bawaan bila konten muat (`ScrollBar.ts:314-318`). Scroll tetap jalan tanpa bar: `scrollTop/scrollBy/scrollTo`, wheel chaining (`lib/scroll-chain.ts`), drag thumb. **Ini persis pola yang baru dikerjakan manual di CLI MethaTech (§4q) — di OpenTUI itu satu baris API, di Ink harus hand-roll.**
- **Event mouse mentah ADA:** SGR 1006 + 1000/1002/1003 (`packages/native/src/ansi.zig:329-336`, `terminal.zig:966-997`), parser `parse.mouse.ts` (down/up/move/drag/scroll + arah + delta), handler per komponen `onMouseScroll` dll (`Renderable.ts:185-195`). Ink tidak mengekspos mouse mentah secara resmi.
- **Streaming:** mutasi properti + `requestRender()` (coalescing frame, target 30 fps / max 60, `renderer.ts:1928-1955, 2045-2060`); di React sama dengan Ink (`setState` → render). `NativeSpanFeed` zero-copy untuk stream byte besar.
- **Biaya migrasi (alasan TIDAK pindah):** dev/build WAJIB Bun 1.4.1 + Zig 0.17.0; runtime Node ≥ 26.4.0 atau Bun (FFI `node:ffi`/`bun:ffi`); binary native prebuilt per platform (`@opentui/core-<platform>-<arch>`); **dukungan Termux/Android TIDAK TERVERIFIKASI** (target `linux-arm64` ada, tapi tidak ada bukti/test Termux). Ini melanggar aturan proyek saat ini (Node.js + npm ONLY, tanpa Bun) dan berisiko besar karena Reza bekerja dari HP.
- **Verdict:** JANGAN pindah framework. Yang layak diadopsi hanya POLANYA: API `visible = false → policy never` + wheel-chaining di implementasi scroll Ink yang sudah ada. OpenTUI tidak memberi apa pun untuk spek §3–§9 (adapter, orchestrator, loop, fallback, permission, context) — semua itu tetap harus dibangun sendiri, sama seperti di Ink.

---

## 7. Referensi MCP — ringkasan studi

Sumber: studi read-only atas `~/workspace/mcp-typescript-sdk/` (commit `1e608ca`, root `2.0.0-alpha.0`, paket client/server `2.4.0`). Detail lengkap ada di laporan agen studi; di sini hanya yang relevan untuk runtime.

### 7.1 Yang MCP sediakan (dan MethaTech belum punya)

- **Definisi Tool sebagai JSON Schema** (`spec.types.2025-11-25.ts:1290-1360`): `name` (regex `^[A-Za-z0-9._-]{1,128}$`), `description`, `inputSchema {type:'object', properties, required}`, `outputSchema?` (root wajib `type:'object'`), `annotations?`, `execution?`, `_meta?`. Registrasi: `McpServer.registerTool(name, config, cb)` (`mcp.ts:1058-1090`).
- **Pola `tools/list` → `tools/call`** (JSON-RPC 2.0): list dengan paginasi `cursor`/`nextCursor`; call `{method:'tools/call', params:{name, arguments}}`; notifikasi `notifications/tools/list_changed` bila tool set berubah.
- **Hasil tool terstruktur:** `CallToolResult {content: ContentBlock[], structuredContent?, isError?}` — content blocks: `text`, `image` (base64), `audio`, `resource_link`, `resource` (embedded). **Aturan error dua lapis:** error dari tool WAJIB dilaporkan di dalam result dengan `isError: true` (supaya LLM bisa self-correct), BUKAN sebagai JSON-RPC error. Hanya "tool tidak ditemukan" / "server tidak mendukung" yang jadi MCP error.
- **Validasi di SERVER, bukan client:** `McpServer.validateToolInput/validateToolOutput` (`mcp.ts:348-430`); client TIDAK memvalidasi argumen input terhadap `inputSchema` sebelum mengirim (validator client hanya untuk output).
- **ToolAnnotations sebagai HINT kebijakan:** `readOnlyHint?` (default false), `destructiveHint?` (default true), `idempotentHint?` (default false), `openWorldHint?` (default true). Dokumen tegas: ini hint, TIDAK boleh dipercaya dari server tak tepercaya; client tidak boleh mengambil keputusan tool dari annotation.
- **Roots sebagai boundary filesystem:** server meminta `roots/list`; client menjawab direktori `file://` yang diizinkan. Ini pola "working directory yang diizinkan" — padanan `resolveInside()` MethaTech, tapi dinegosiasikan lewat protokol.
- **Resources & prompts:** resources = data read-only ber-URI (`resources/list/read/subscribe`); prompts = template prompt server-side (`prompts/list/get`). Relevansi sedang: resources untuk konteks ber-URI + subscribe; prompts sebagai padanan `skill` bila skill pindah ke server.
- **Transport:** Streamable HTTP (utama), stdio (spawn proses anak), SSE **deprecated**. Dua era protokol: legacy 2025 (`initialize` handshake) dan modern 2026-07-28 (`server/discover`, tanpa `initialize`).
- **Client API:** `Client` (`client.ts:548`), `connect(transport)`, `listTools()`, `callTool({name, arguments})`, `listResources/readResource/listPrompts/getPrompt`, `close()`.

### 7.2 Yang MCP TIDAK sediakan (terverifikasi absen — jangan diasumsikan ada)

- **Capability detection per model: TIDAK ADA.** Satu-satunya yang menyangkut model adalah `ModelPreferences` di `sampling/createMessage` (`hints`, `costPriority`, `speedPriority`, `intelligencePriority` 0–1) — dan spesifikasi tegas: *"always advisory. The client MAY ignore them"*; client bebas memilih model. Tidak ada `models/list`, tidak ada registry capability model.
- **Permission/approval gate untuk tool call: TIDAK ADA.** Tidak ada gate approval, allowlist, atau permission per-tool di `Client`/`Server`/`McpServer`. Human-in-the-loop hanya SHOULD di sampling, bukan mekanisme enforceable. `scopeChallenge` per-tool adalah otorisasi OAuth, bukan approval user.
- **Secret vault / manajemen kredensial: TIDAK ADA.** Elicitation dilarang mengumpulkan password/API key ("Never collect sensitive information... Use URL mode or an out-of-band flow").
- **Validasi input sisi client: TIDAK ADA** (lihat 7.1 — jangan meniru kekosongan ini).

### 7.3 Verdict adopsi MCP

| Adopsi | Keterangan |
|---|---|
| Bentuk `Tool` JSON Schema | **YA — paling bernilai.** Pakai sebagai definisi 11 tool lokal secara internal (ganti/dampingi definisi string saat ini). Langsung memberi validasi + dokumentasi tool yang bisa dibaca model. |
| Pola `tools/list` → `tools/call` | **YA, sebagai pola internal.** Daftar tool sebagai data (bukan hardcode di prompt); berguna saat tool bertambah/dinamis. |
| `CallToolResult` + content blocks + `isError` | **YA.** Hasil tool sebagai `content[]` + `structuredContent` + `isError` untuk error tool-level (bukan throw). Bisa ditiru di runtime lokal tanpa protokol apa pun. |
| `ToolAnnotations` sebagai hint | **YA, sebagai metadata approval gate milik runtime sendiri** (mis. `destructiveHint` → wajib konfirmasi). Enforcement tetap di host. |
| Roots sebagai pola boundary | **YA, sebagai pola.** Runtime yang menentukan direktori kerja yang diizinkan. |
| Transport stdio / Streamable HTTP server / OAuth+DPoP | **TIDAK.** 11 tool bersifat lokal in-process; membungkusnya jadi server MCP eksternal hanya menambah proses, IPC, dan failure mode. |
| Seluruh SDK `@modelcontextprotocol/client`/`server` | **TIDAK sekarang.** Dual-era codec, response cache, tasks, elicitation/sampling — berat; root masih `2.0.0-alpha.0`. Bila suatu hari perlu mengonsumsi server MCP pihak ketiga, adopsi HANYA `Client` + satu transport di belakang lapisan tool-call yang sudah ada. |
| Sampling | **TIDAK.** MethaTech sudah punya LLM sendiri. |
| Resources/prompts | **NANTI, sebagai pola.** Bila konteks/skill pindah ke server. Bukan kebutuhan fase awal. |

---

## 8. Gap analysis per spek §3–§11

### §3 Universal Model Adapter — GAP BESAR di CLI, SUDAH ADA di panel

| Kebutuhan | Status |
|---|---|
| Kontrak internal seragam per provider | **Belum ada di CLI.** Satu fungsi `streamChat` generik; tidak ada interface `ModelAdapter`. Panel punya `ChatInterface` + `UnifiedChatRequest` (sudah seragam). |
| Mengubah format request/response | Panel: transformer per provider (Claude, Gemini). CLI: tidak ada (tidak perlu — panel yang melakukannya). |
| Menerjemahkan native tool calls | **Belum ada di CLI** (tidak pernah kirim/parse `tools`). Panel: meneruskan apa adanya + normalisasi. |
| Streaming | CLI: SSE generik. Panel: per-provider stream reader. Cukup. |
| Token usage | CLI: dari SSE chunk terakhir. **Belum ada:** usage per step, token budgeting. |
| Capability detection | **TIDAK ADA di mana pun** (CLI, panel, Freebuff, MCP — keempatnya terverifikasi tidak punya). Ini pekerjaan baru yang sesungguhnya. |
| Provider-specific errors | CLI: `friendlyError` generik (401/402/429 + teks mentah). **Belum ada:** normalisasi error per provider. |

### §4 Universal Tool Orchestrator — SEBAGIAN (loop + eksekusi ada, orchestrator belum)

Loop + eksekusi tool sudah ada dan teruji (`loop.ts` + `tools.ts`), tapi: (a) eksekusi menempel di loop (tidak ada modul orchestrator terpisah); (b) eksekusi sequensial saja (tidak ada paralel); (c) tidak ada registry formal (lihat §3); (d) tidak ada tool result normalizer (hasil = string JSON bebas, bukan `CallToolResult` + content blocks). Arsitektur di spek (Conversation Manager → Model Adapter → Agent Loop → Tool Orchestrator → Shell/File/Web/Browser/MCP/Custom → Normalizer) BELUM ada sebagai modul terpisah — yang ada adalah loop monolitik yang memanggil `executeToolCall` langsung.

### §5 Native Tool Calling dan Fallback — NATIVE BELUM ADA, FALLBACK SUDAH ADA (informal)

- **Native (A): BELUM ADA.** Bukti: grep NOL untuk `tools:` di `src/`; `streamChat` tidak mengirim `tools`; tidak ada parsing `delta.tool_calls`. Panel sudah siap menerima (lihat §4). Referensi implementasi: Freebuff dual path (§5.3).
- **Fallback (B): SUDAH ADA, tapi informal.** Protokol XML `<codebuff_tool_call>` + JSON `{cb_tool_name, ...}` + validasi nama tool (unknown → error result) + validasi schema per tool (tangan) + `TOOL_CALL_ERROR` retry + nudge max 2x + pesan gagal eksplisit bila model tidak mengikuti protokol (stopReason `no more tool calls` / `stopped: no progress`). **Yang kurang dari spek:** validasi TIDAK memakai schema formal (JSON Schema); tidak ada batas eksekusi per protokol yang terpisah dari batas loop; tidak ada penjelasan terstruktur yang dikembalikan ke user bila model tidak mampu mengikuti protokol (hanya stopReason internal + pesan sistem `Agen berhenti: ...`).

### §6 Universal Agent Loop — SUDAH ADA (95%), perlu dua tambahan

Loop sudah memenuhi hampir semua siklus spek: terima pesan → susun context → kirim via adapter → terima respons → periksa tool call → validasi → periksa permission (toolset mode) → eksekusi → normalisasi (sebagai JSON string) → masukkan ke context → lanjutkan → berhenti di final response / batas. **Yang belum:** (a) eksekusi paralel untuk tool call independen (saat ini sequensial; Freebuff juga mengeksekusi saat stream tiba, bukan paralel batch — jadi paralel adalah fitur baru, bukan adopsi); (b) retry policy untuk model call gagal (saat ini langsung stop); (c) tool result tracking formal (saat ini hanya pesan `role: tool` tanpa indeks/tracking); (d) deteksi pengulangan tool yang sama tanpa alasan valid — SEBAGIAN ada (todo-loop, failed-edit loop) tapi tidak ada guard umum "tool yang sama dengan argumen yang sama berulang".

### §7 Shared Tool Registry — BELUM FORMAL (lihat §3)

11 tool ada sebagai array definisi; bukan registry. Yang harus ditambah (tanpa membuat tool duplikat): ID, input/output JSON Schema, permission level, timeout per tool, risk classification, handler terdaftar (bukan switch), audit trail. Daftar contoh di spek (`shell.execute`, `filesystem.read`, `web.search`, `browser.navigate`, `mcp.invoke`, ...) adalah CONTOH ARSITEKTUR — yang sudah ada (`read_files`, `run_terminal_command`, ...) TIDAK boleh diduplikasi dengan nama baru.

### §8 Security dan Permission System — GAP TERBESAR

| Kebutuhan spek | Status |
|---|---|
| Tool permission per kategori | **BELUM ADA.** Hanya toolset per mode. |
| Validasi input schema | Sebagian (validasi tangan per tool, tidak seragam, tidak memakai JSON Schema). |
| Path restriction filesystem | **ADA** (`resolveInside`, semua file tool). |
| Shell command validation | **BELUM ADA.** Hanya batas `cwd` awal. Celah nyata (lihat §2). |
| Execution timeout | **ADA** (shell 120/600/-1; model call 120s; device-code 20s). |
| Output size limit | **ADA** (tool 50.000 head+tail; knowledge file 20.000; git status/diff 4000). |
| Secret redaction | **BELUM ADA.** Tidak ada redaksi secret di output tool / error / log. (Sanitasi ANSI ada, itu bukan redaksi secret.) |
| Audit logging | **BELUM ADA.** Tidak ada log eksekusi tool (nama, argumen, hasil, waktu, user). |
| Cancellation support | **ADA** (AbortSignal Esc/Ctrl+C → `interrupted by user`). |
| Confirmation operasi berisiko | **BELUM ADA — dan DITOLAK sebelumnya oleh Reza** (0.1.6: "pake ada konfirmasi segala"). Konflik langsung dengan spek §8 — BUTUH keputusan eksplisit Reza sebelum Fase 8. |
| Isolasi antar-session dan user | **BELUM ADA.** Satu CLI = satu user OS; tidak ada isolasi session (tidak ada session id di tool context). |

### §9 Context Management — SEBAGIAN

Ada: conversation history, tool call history (pesan `role: tool`), tool execution results (di history), attachment context (paste → `[Pasted Text]` block), system instructions + agent instructions (prompt.ts), `/compact` manual. **Belum ada:** context truncation otomatis, token budgeting, context summarization berkala/otomatis, proteksi relasi tool-call ↔ tool-result saat model diganti di tengah sesi (ganti model = history tetap dipakai apa adanya; pesan `role: tool` dengan `tool_call_id` sintetis `call-{step}-{index}` TIDAK akan cocok dengan format native provider bila jalur native diaktifkan — ini risiko migrasi Fase 5 yang harus ditangani: history lama harus dinormalisasi atau dibuang saat pindah jalur).

### §10 Streaming dan TUI Integration — SUDAH ADA

Streaming respons, Thinking card, Working indicator, agent step akurat, tool activity tampil (preview + summary), tool error terlihat (pesan sistem + error block), Ctrl+C cancellation, final response tidak tercampur tool output (parser memisahkan) — SEMUA sudah berfungsi dan teruji (tui-pty 270/270 di 0.1.9). **Jangan ubah desain TUI yang tidak berkaitan.** Satu-satunya yang terkait runtime: per-step usage/cost (follow-up yang sudah dicatat) dan indikator tool berjalan yang lebih kaya (saat ini hanya preview satu baris).

### §11 Model Capability Matrix — BELUM ADA (dan tidak boleh diisi dari asumsi)

**Status saat ini (JUJUR): SEMUA capability untuk SEMUA model adalah UNKNOWN.**

| Capability | GPT-6 Luna | GPT-6 Astra | GPT-6.1 Sol | Gemini 3.8 Flash | Gemini 3.1 Pro | DeepSeek V4 Flash | GLM 5.3 Flash | Kimi K2.7 Code | Qwen 3.8 Flash | Claude Sonnet 4.6 | Claude Opus 4.6 | Cohere Cmd R+ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Native tool calling | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? |
| Multiple tool calls | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? |
| Parallel tool calls | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? |
| Streaming | ✓ (terbukti: SSE jalan untuk semua model di atas) | | | | | | | | | | | |
| Structured output | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? |
| Reasoning/thinking | ? (delta.reasoning_content DITERIMA dari beberapa model — tapi tidak dicatat per model mana) | | | | | | | | | | | |
| Vision | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? |

Alasan: (a) panel `/api/available_model` tidak mengembalikan capability apa pun; (b) CLI tidak pernah mengirim `tools`, jadi tidak ada model yang pernah diuji native calling lewat jalur ini; (c) XML tool-call TERBUKTI jalan di `glm-5.3-flash` (live Termux 2026-11-09, 0.1.7) — itu SATU-SATUNYA bukti capability tool-calling yang ada, dan itu membuktikan protokol XML, bukan native calling. (d) Freebuff dan MCP juga tidak punya capability detection — tidak ada referensi yang bisa disalin. **Fase 2 harus membangun capability registry yang diisi dari probe live per model, dengan status `verified` / `unverified` / `failed`, bukan dari nama model.**

---

## 9. Rencana Fase 2–10 (berdasarkan audit)

### Fase 2 — Provider Adapter Standardization (setelah Fase 3, lihat urutan §0)

- Buat `src/agent/adapter.ts`: interface `ModelAdapter { id, chat(messages, opts): AsyncIterable<ChatChunk> }` dengan SATU implementasi `PanelChatAdapter` membungkus `streamChat` (tanpa mengubah perilaku). `ChatChunk = {type: 'text'|'reasoning'|'tool_call'|'usage'|'error'}` — normalisasi delta SSE ke format internal.
- Buat `src/agent/capabilities.ts`: `ModelCapabilities {nativeTools, multipleTools, parallelTools, streaming, structuredOutput, reasoning, vision, contextWindow?}` + registry `Map<modelId, {capabilities, status: 'verified'|'unverified'|'failed', verifiedAt?}>`. Isi awal: SEMUA `unverified` kecuali `streaming: verified` (terbukti jalan). Jangan isi dari nama model.
- Probe live (Fase 9 awal, bukan Fase 2): kirim `tools` minimal ke tiap model lewat panel, catat apakah `tool_calls` kembali / 400 / diabaikan. Per channel: VectorHead, Alibaba, Cohere, Apinex.
- JANGAN sentuh adapter panel (sudah benar). JANGAN tambah dependensi AI SDK (Vercel `ai` tidak diperlukan — SSE + JSON cukup; Freebuff memakainya karena runtime-nya server-side).
- **Realita implementasi:** modul `src/agent/model-adapter.ts` (bukan `adapter.ts` seperti rencana awal — nama lebih eksplisit; kontrak `ModelAdapter`, `ChatChunk`, `AdapterError` + normalisasi per status HTTP, `PanelChatAdapter` membungkus `streamChat`, `collectChatText`) + `src/agent/model-capabilities.ts` (bukan `capabilities.ts`; registry SUPPORTED/UNSUPPORTED/UNKNOWN, seed jujur, `isCapabilityProven`, `toAvailableModelEntry`); wiring minimal di `loop.ts` + `/compact` di `ChatApp.tsx`; `onFinishReason` aditif di `api.ts`; metadata konfirmasi diperbaiki di `tool-registry.ts` (`confirmationPolicy` required/scoped/none, Klarifikasi 2026-11-10). Tes: tsc bersih, unit 259/259, agent-pty 32/32, tui-pty 270/270.

### Fase 3 — Shared Tool Registry (**SELESAI 2026-11-10**, docs/UNIVERSAL-RUNTIME-PHASE3.md)

- Refactor `src/agent/tools.ts` → `src/agent/registry.ts`: `ToolDefinition` diperluas menjadi `{id, name, description, inputSchema (JSON Schema), outputSchema?, permission: 'read'|'write'|'execute'|'ask', timeoutMs?, risk: 'low'|'medium'|'high'|'critical', handler}`. Tulis JSON Schema untuk 11 tool yang ada (adopsi bentuk MCP §7.1). Validasi input memakai schema (ganti validasi tangan secara bertahap, satu tool per satu, dengan test).
- Registry sebagai data: `listTools()` untuk prompt + `getTool(name)` untuk eksekusi. Mode (PLAN dst.) menjadi filter di atas registry, bukan daftar terpisah.
- TIDAK ada tool baru di fase ini. TIDAK ada perubahan perilaku eksekusi.
- **Realita implementasi:** modul baru `src/agent/tool-registry.ts` (registry + validator + helper klasifikasi + `toOpenAiFunction`); `tools.ts` TIDAK diubah (handler/deskripsi direferensikan, bukan diduplikasi); wiring minimal di `loop.ts` (validasi pre-eksekusi + 3 klasifikasi dari registry). Tes: tsc bersih, unit 237/237, agent-pty 32/32, tui-pty 270/270.

### Fase 4 — Universal Tool Orchestrator

- Ekstrak eksekusi dari `loop.ts` ke `src/agent/orchestrator.ts`: `executeCalls(calls[], ctx) → results[]` dengan: validasi schema → cek permission → eksekusi → normalisasi hasil ke `CallToolResult {content[], structuredContent?, isError}` (adopsi MCP §7.1) → audit log entry.
- Paralel: eksekusi paralel HANYA untuk call independen yang read-only (`read_files`, `list_directory`, `glob`, `code_search`) — mutasi + shell tetap sequensial sampai analisis keamanan selesai. Perlu keputusan: batas konkurensi (usulan: 4).
- JANGAN ubah loop dulu di fase ini; orchestrator dipanggil loop sebagai pengganti `executeToolCall` langsung.
- **Realita implementasi (SELESAI 2026-11-10, docs/UNIVERSAL-RUNTIME-PHASE4.md):** modul baru `src/agent/tool-orchestrator.ts` (`executeToolCalls`, hasil ternormalisasi ala MCP `CallToolResult`, wave paralel read-only + sekuensial mutasi dengan urutan hasil dipertahankan, timeout hang-guard dari metadata registry, batch stop ask_user/endsAgentStep, cancellation via signal); loop di-wire minimal (batch per step + proses hasil berurutan, guard/history/event tidak berubah); `tools.ts` TIDAK disentuh. Tes: tsc bersih, unit 279/279 (20 baru), agent-pty 32/32, tui-pty 270/270. Temuan keamanan shell dicatat lengkap untuk Fase 8 di PHASE4 §5 (dampak Fase 4 terhadap risiko itu: NOL).

### Fase 5 — Universal Agent Loop

**KOREKSI DEFINISI 2026-11-10 (Reza, mengikat):** bagian ini
semula mendeskripsikan Fase 5 sebagai "native path" (tambah jalur
native `tools` di samping XML). Itu usulan urutan audit yang SUDAH
DIBATALKAN. Yang berlaku adalah roadmap asli spek §14: **Fase 5 =
Universal Agent Loop.** Native tool calling BUKAN Fase 5 — ia
adalah pekerjaan fase berikutnya, penempatannya diputuskan Reza.

Isi Fase 5 yang benar (**SELESAI 2026-11-10,
docs/UNIVERSAL-RUNTIME-PHASE5.md**):

- Loop bekerja MELALUI kontrak adapter (Fase 2) dan orchestrator
  (Fase 4): adapter diinjeksikan ke loop (`AgentLoopOptions.adapter`,
  default adapter relay panel); semua eksekusi tool lewat
  `executeToolCalls`; tidak ada jalur pintas transport atau handler.
- Execution ledger (`AgentLoopResult.executedToolCalls`): satu entri
  per call yang benar-benar dieksekusi, kunci `(step, index)` unik —
  membuktikan satu parsed call = tepat satu eksekusi.
- Kontrak loop tertulis (header `loop.ts`): siklus, guard, format
  history, penanganan error — dengan test MockAdapter (9 test baru).
- XML tool calling dipertahankan; native `tools` tetap TIDAK
  dikirim (adapter tetap menolak fail-loud); tidak ada perubahan
  mode CLI / TUI / panel.

Pekerjaan native yang semula ditulis di sini (kirim `tools`,
parse `delta.tool_calls`, routing per capability, normalisasi
history native vs XML, validasi live per channel sebelum klaim)
PINDAH ke fase berikutnya — bukan Fase 5, bukan Fase 6. Saat
ganti model/jalur di tengah sesi nanti, history tool-call lama
(id sintetis `call-{step}-{index}`) harus dinormalisasi atau
dibuang — keputusan desain fase native itu.

### Fase 6 — Fallback Tool Protocol — SELESAI 2026-11-10 (tes unit + agent-pty + tui-pty hijau, lihat docs/UNIVERSAL-RUNTIME-PHASE6.md)

- Protokol XML yang sudah ada diformalkan: dokumen `docs/TOOL-CALL-PROTOCOL.md` (format tag, JSON body, alias yang diterima, aturan validasi, pesan error, batas nudge, routing native vs XML vs fallback, batas eksekusi). Tag `<codebuff_tool_call>` TIDAK diubah (sudah terbukti jalan di model gratis).
- Routing berbasis capability (`src/agent/fallback-protocol.ts`): native HANYA bila `nativeToolCalling` terbukti SUPPORTED (probe-live); UNKNOWN / UNSUPPORTED / provider-config-only → fallback XML. UNKNOWN tidak pernah dianggap SUPPORTED.
- Validasi schema JSON Schema (dari registry Fase 3) untuk SETIAP call XML — sudah dijalankan orchestrator Fase 4; Fase 6 menambahkan klasifikasi `failureKind` ("validation" = call tidak pernah jalan = pelanggaran protokol; "execution"/"timeout" = handler jalan dan gagal) agar loop bisa membedakannya tanpa menebak dari teks output.
- Bila model 2x gagal mengikuti protokol (JSON malformed, tag tidak tertutup, tool tidak dikenal, parameter tidak valid, janji tanpa call) → turn dihentikan dengan pesan eksplisit ke user ("Model ini tidak mengikuti format tool-call; ..."), bukan diam-diam selesai. Satu pelanggaran hanya mendapat retry biasa; langkah yang mengeksekusi minimal satu call me-reset streak.
- Ledger eksekusi diperketat: hanya call yang benar-benar dieksekusi yang tercatat (kegagalan validasi tidak pernah jalan, jadi tidak masuk ledger) — bukti anti-duplikasi tetap utuh.
- Native `tools` tetap TIDAK dikirim; gate + `--yolo` tetap Fase 8; tidak ada perubahan mode CLI / TUI / panel / production.

### Fase 7 — Context & Streaming Integration — SELESAI 2026-11-10 (tes 342/342, agent-pty 32/32, tui-pty 270/270, lihat docs/UNIVERSAL-RUNTIME-PHASE7.md)

- Context management baru (`src/agent/context-manager.ts`): estimasi token heuristik (Latin ~4 karakter/token, CJK ~1/char, didokumentasikan sebagai perkiraan, bukan angka pasti); budgeting system/history/tool-result/reserve; `resolveContextWindow` membaca `contextWindow` dari capability record, fallback konservatif 128.000 token bila UNKNOWN (bukan fakta terukur).
- Truncation sebagai VIEW, bukan mutasi: `prepareContext` mengirim view yang muat ke model — system prompt + ringkasan yang di-pin tidak pernah di-drop, exchange utuh di-drop dari depan (tool-call + tool result tidak pernah terpisah), exchange terakhir tidak pernah di-drop, tool result dipotong hanya di view (head 1500 + marker + tail 500). Stored history (format Fase 5) tidak pernah dimutasi truncation.
- Auto-compaction max 1x per turn: bila truncation men-drop pesan, segmen yang ter-drop diringkas via model memakai ulang prompt `/compact` (`compactPrompt`), lalu menggantikan segmen di stored history sebagai pesan system `[Ringkasan percakapan]`. Gagal → null → lanjut dengan truncated view (turn tidak pernah crash karena summarization).
- Streaming: `CollectedChat.streamComplete` (true hanya bila usage atau finish chunk tiba); stream tanpa keduanya = incomplete → turn berhenti eksplisit SEBELUM teks parsial masuk history. Timeout 120 detik di `api.ts` kini `ApiError(408)` (retryable) dan dibedakan dari abort user (`AbortError`, tidak retryable).
- Retry policy loop (adopsi Freebuff `codebuff-web-api.ts`): max 3 attempt untuk 408/429/500/502/503/504, backoff 500ms lalu 1000ms (abortable), hanya bila attempt yang gagal belum mengirim delta apa pun (tanpa duplikasi display). Abort tidak pernah di-retry.
- Finish reason: `content_filter` dan `length` (tanpa tool call) menghentikan turn eksplisit (completed=false); `length` DENGAN tool call tetap mengeksekusi call.
- Usage per turn (follow-up lama): diakumulasi per langkah ke `AgentLoopResult.usage` dan ditampilkan di footer TUI (slot yang sudah ada); per-step breakdown tetap follow-up. `AgentLoopResult` juga membawa `context` (compacted, droppedMessages unik, truncatedToolResults unik, estimatedTokens); semua exit site lewat `buildResult`.
- Kompatibilitas: Fase 2–6 tidak berubah (adapter, registry, orchestrator, loop format history, ledger, routing fallback XML). MockAdapter di kedua file tes loop kini auto-yield finish chunk (perilaku server nyata). Keterbatasan: estimasi token heuristik ±20%, window 128k adalah default perencanaan, ringkasan ditulis model yang sama, tidak ada verifikasi live (Fase 9).
- Fase 8 TIDAK dimulai sebelum perintah Reza.

### Fase 8 — Security Hardening — SELESAI 2026-11-10 (tes 401/401, agent-pty 32/32, tui-pty 270/270, lihat docs/UNIVERSAL-RUNTIME-PHASE8.md)

- Temuan shell Fase 2 §4 DITUTUP dengan enforcement di kode, bukan
  instruksi prompt: validasi perintah shell sebelum jalan
  (`validateShellCommand` — path sensitif, primitif eksfiltrasi,
  primitif destruktif, pemisah segmen sadar quote), namespace
  sandbox Linux (`unshare --user --map-root-user --mount`,
  direktori kredensial di-mask + diverifikasi, fail closed exit
  126, fallback `"validation-only"` yang dilaporkan jujur di
  platform tanpa user namespace), env scrub allowlist (shell child
  tidak mewarisi `METATECH_API_KEY` dkk.), containment realpath
  (`resolveInsideSecure` — symlink keluar ditolak di semua file
  tool + cwd shell; glob/code_search tidak mengikuti symlink).
- Secret redaction: nilai eksak (API key sesi + env rahasia) +
  pola generik (`sk-...`, `Bearer ...`, `api_key=...`, private key)
  di orchestrator (semua output tool), loop (streaming, history,
  finalText, error), handler shell, dan tampilan ChatApp
  (whole-message pass — secret terbelah dua delta tetap
  teredaksi).
- Audit log append-only `<configDir>/audit.log` (JSONL, mode 0600,
  rotasi 5 MB): tool, waktu, ok/gagal, durasi, failureKind, mode
  sandbox, argumen tersanitasi + teredaksi — tanpa isi file, tanpa
  nilai secret, anti-forgery baris (JSON.stringify satu baris).
  Diaktifkan loop untuk turn agen nyata; terbukti end-to-end
  (agent-pty menulis 15 entri).
- Permission enforcement: mode toolset sebagai boundary (Plan mode
  menolak semua mutating tool, penolakan teraudit); metadata
  confirmation TIDAK diubah perilakunya.
- **Gate + `--yolo` TIDAK diimplementasikan** — perintah Fase 8
  Reza mengecualikannya ("Jangan menambahkan Ask, YOLO, --yolo,
  atau confirmation workflow baru"). Gate tetap item TERBUKA dari
  keputusan Reza 2026-11-10 decision 1; metadata
  `confirmationPolicy` tetap menjadi hook-nya. Komentar "gate
  Fase 8" di registry/orchestrator/loop diperbarui agar tidak
  mengklaim sebaliknya. Lihat juga koreksi di §11 decision 1.
- Keterbatasan jujur: validator sintaktis bisa diakali obfuscation;
  namespace hanya Linux (Termux/macOS/Windows =
  validation-only); egress GET polos diizinkan (trade-off sadar);
  tidak ada confirmation gate; unit test bukan audit keamanan
  formal. Detail lengkap di PHASE8 §9.
- Kompatibilitas: Fase 2–7 tidak berubah (adapter, registry,
  orchestrator, loop format history, ledger, routing fallback,
  context/streaming). Tidak ada perubahan mode CLI / TUI / panel /
  production. 59 tes keamanan baru (DUMMY credentials saja).
- Fase 9 TIDAK dimulai sebelum perintah Reza.

### Fase 9 — Cross-Model Testing

**SELESAI 2026-11-10 (menunggu penerimaan Reza). Detail lengkap:
docs/UNIVERSAL-RUNTIME-PHASE9.md.**

- Harness probe live `test/probe-live.mjs` (adapter + transport asli
  terhadap panel relay, akun test id10): 2 pass, 15 model subset
  (9 gratis yang masih ada di katalog + Sonnet + Opus + 1 per provider
  lain), 3 probe per model (native / XML / structured), 87 hasil.
  Key dibaca runner dari DB bore, lewat env saja, tidak pernah
  dicetak/disimpan.
- Hasil: XML valid pada 12/12 model yang menjawab (10 di kedua pass;
  2 Gemini hanya pass 2 — kepatuhan percobaan pertama tidak
  konsisten). JSON mode valid pada 12/12 yang menjawab. Native
  TERBUKTI hanya pada Cohere command-r-plus-08-2024 (2 panggilan
  dalam satu respons, finish `tool_calls`) — 14 model lain TIDAK
  DAPAT diuji native karena panel mengembalikan 503 untuk setiap
  request ber-`tools` sementara request biasa berhasil. Sonnet, Opus,
  methatech/uncensored tidak dapat diuji sama sekali (503 di semua
  probe, kedua pass — upstream VectorHead jenuh). kimi-k2.7-code
  sudah tidak ada di katalog live (retired).
- Registry diperbarui dengan bukti: field baru `xmlToolCalling`,
  versi 1 → 2, tabel `PROBE_RESULTS_2026_11_10` (sumber `probe-live`,
  `verifiedAt` 2026-11-10T08:25:00Z). Model yang tidak dapat diuji
  tetap UNKNOWN — error panel bukan putusan kapabilitas.
- Wiring probe: opsi probe-only `probeNativeTools` di adapter
  (default OFF) + parsing `delta.tool_calls` di `streamChat` +
  `responseFormat` passthrough. Loop TIDAK PERNAH mengirim tools;
  XML tetap default. Wiring ini kandidat fase berikutnya;
  penempatannya diputuskan Reza.
- Bug ditemukan & diperbaiki: (1) loop melaporkan `toolChannel`
  dari resolusi registry, sehingga seeding native SUPPORTED akan
  membuatnya mengklaim `"native"` sementara eksekusi tetap XML —
  kini selalu `"xml-fallback"` (channel yang dieksekusi), dengan tes
  regresi; (2) `toAvailableModelEntry` menghilangkan
  `xml_tool_calling` dari `capability_source`.
- Keamanan lintas model dibuktikan 8 tes baru
  (`test/cross-model.test.mjs`): enforcement Fase 8 sama untuk
  setiap model; channel resolution jujur; XML malformed 2x berhenti;
  stream terpotong; history panjang konsisten.
- Tes akhir: `npx tsc` bersih, unit 415/415, agent-pty 32/32,
  tui-pty 270/270.
- Terbuka setelah fase ini: probe ulang native (14 model) +
  Sonnet/Opus/methatech saat upstream pulih; gate konfirmasi tetap
  belum diimplementasikan (keputusan 1); penempatan wiring native
  diputuskan Reza. Fase 10 TIDAK dimulai sebelum perintah Reza.

### Fase 10 — Final Audit & Documentation

**SELESAI 2026-11-10. Detail lengkap:
`docs/UNIVERSAL-RUNTIME-FINAL-AUDIT.md`,
`docs/UNIVERSAL-RUNTIME-ARCHITECTURE.md`,
`docs/UNIVERSAL-RUNTIME-PHASE10.md`.**

- Audit independen terhadap source code aktual (bukan ringkasan
  laporan fase): semua klaim material Fase 1–9 diverifikasi
  dengan grep + pembacaan file; hasil mentah probe Fase 9
  diperiksa ulang baris per baris (87 hasil: native hanya
  Cohere, XML 12 model, 40 record menyebut 503, 3 model tak
  teruji).
- Integritas arsitektur: 13 pemeriksaan — satu adapter
  (`PanelChatAdapter` satu-satunya pemanggil `streamChat`),
  satu registry (11 tool), satu orchestrator (satu-satunya
  pemanggil produksi `loop.ts:742`), satu loop, satu protokol
  fallback; `executeToolCall` tanpa pemanggil produksi (test
  seam); tidak ada Ask/YOLO/`--yolo`.
- Keamanan: 6 lapisan Fase 8 diperiksa ulang di source; 59 tes
  keamanan hijau. Sistem TIDAK diklaim menjalani pentest
  profesional.
- Confirmation gate didokumentasikan sebagai open item
  (metadata siap, implementasi menunggu perintah Reza) — gate
  TIDAK diimplementasikan di Fase 10.
- Temuan: (A) `REGISTRY_VERSION` masih `1` padahal Fase 2
  menambah field — dampak NOL, didokumentasikan saja;
  (B) §9 `docs/TOOL-CALL-PROTOCOL.md` usang — DIPERBAIKI
  (§1 + §9 ditulis ulang). Tidak ada bug kritis baru.
- Validasi akhir: `npx tsc` bersih, unit **415/415** (sama
  persis baseline Fase 9), agent-pty **32/32**, tui-pty
  **270/270**. NOL perubahan source di Fase 10 (hanya
  dokumentasi).
- **Kesimpulan: Universal Agent Runtime layak dinyatakan
  selesai.** Open items yang tersisa (gate, jalur native di
  loop, re-probe, follow-up lama) membutuhkan perintah Reza di
  luar roadmap ini.

---

## 10. Keputusan yang dibutuhkan dari Reza (sebelum Fase 2)

1. **Confirmation gate (Fase 8):** spek minta konfirmasi untuk operasi berisiko; Reza pernah menolak confirmation gate di 0.1.6. Pilih: (a) gate hanya untuk tool `critical`, (b) gate + flag `--yolo` untuk menonaktifkan, (c) tetap tanpa gate (tanggung jawab penuh di user + audit log saja).
2. **Tempat capability metadata:** (a) perluas `/api/available_model` di panel (butuh perubahan panel + deploy), atau (b) registry statis di CLI yang diisi probe live (tanpa ubah panel). Rekomendasi audit: (b) dulu — tanpa perubahan panel.
3. **Runtime tetap lokal di CLI?** Rekomendasi audit: YA, pertahankan (Freebuff server-side bukan contoh yang harus diikuti; memindah runtime ke server = proyek backend baru + risiko keamanan baru).
4. **Scope model untuk probe live Fase 9:** 27 model aktif semuanya, atau subset (10 free + Sonnet/Opus + 1 per provider)? Probe live memakai quota/saldo.
5. **Paralel tool execution (Fase 4):** boleh untuk read-only saja, atau tetap sequensial penuh?

**TIDAK ada yang dilanjutkan ke Fase 2 sebelum Reza memberi perintah.**

---

## 11. Keputusan Reza 2026-11-10 (sudah diputuskan — MENGIKAT seluruh proyek)

1. **Confirmation gate HANYA untuk tool kritis, dengan opsi `--yolo`.**
   Read-only tanpa konfirmasi. Operasi ubah/hapus file butuh permission
   sesuai tingkat risiko. Destructive shell WAJIB confirmation gate.
   `--yolo` boleh melewati konfirmasi interaktif untuk workflow otomatis,
   tetapi TIDAK BOLEH melewati security policy, sandbox restriction,
   validasi input, atau perlindungan credential. Jangan semua tool minta
   konfirmasi. (Gate + `--yolo` diimplementasikan di Fase 8; Fase 3
   hanya membawa metadata `requiresConfirmation`.)
   **KOREKSI 2026-11-10 (perintah Fase 8 Reza):** perintah Fase 8
   justru MENGECUALIKAN gate/Ask/YOLO/`--yolo` — "Jangan menambahkan
   Ask, YOLO, --yolo, atau confirmation workflow baru." Jadi gate
   TIDAK diimplementasikan di Fase 8; ia tetap item TERBUKA dari
   keputusan ini (metadata `confirmationPolicy` di registry tetap
   menjadi hook-nya bila Reza memerintahkannya di fase lain).
   Enforcement keamanan Fase 8 adalah validasi shell, namespace
   sandbox, env scrub, secret redaction, dan audit log — bukan gate.
2. **Metadata capability: registry di CLI dulu.** Terstruktur per provider
   dan model, sumber dari hasil probe + konfigurasi provider. Status
   SUPPORTED / UNSUPPORTED / UNKNOWN. Jangan simpulkan capability dari
   nama model. Jangan ubah panel API kalau belum benar-benar perlu.
   Desain agar metadata bisa diintegrasikan ke `/api/available_model`
   di tahap berikutnya.
3. **Runtime TETAP lokal di CLI.** Jangan pindahkan agent loop, tool
   orchestration, atau eksekusi tools ke panel. Panel tetap relay /
   provider gateway. Pertahankan agent loop lokal, tool execution lokal,
   permission enforcement lokal, context management lokal, streaming +
   Ctrl+C yang sudah berjalan.
4. **Live capability probe: SUBSET dulu** — 10 model free + Claude Sonnet
   + Claude Opus + minimal 1 model representatif per provider lain.
   Jangan langsung 27 model. Probe mencatat: native tool calling,
   multiple tool calls, parallel tool calls, streaming, structured
   output jika tersedia, error dan kompatibilitas format. Jangan klaim
   capability yang belum terbukti live.
5. **Paralel: read-only boleh paralel jika tanpa dependency; mutasi
   tetap sekuensial.** File write, delete, shell mutation, dan operasi
   yang mengubah state harus sekuensial. Jangan jalankan dua operasi
   yang berpotensi konflik bersamaan. Pakai classification + permission
   metadata dari registry. Pertahankan urutan hasil agar context model
   tidak rusak.

**Klarifikasi Reza 2026-11-10 (mengikat, diterima bersama perintah Fase 2):**

- **Permission dan risk DIBEDAKAN.** Read-only = tool tidak mengubah
  state atau file; mutating = tool melakukan perubahan; risk = tingkat
  dampak + kebutuhan konfirmasi. Tidak semua mutating otomatis
  berbahaya, tidak semua mutating aman. Konfirmasi berdasarkan risiko:
  `run_terminal_command` (critical) WAJIB gate; `write_file` (high)
  WAJIB konfirmasi saat gate diimplementasikan; `str_replace` (high)
  dievaluasi berdasarkan cakupan perubahan + risk metadata; `write_todos`
  dan `skill` mengikuti risk + permission masing-masing. `--yolo` boleh
  melewati konfirmasi interaktif, tapi TIDAK BOLEH melewati sandbox,
  security policy, validasi input, atau perlindungan kredensial. Gate
  TIDAK diimplementasikan sekarang (Fase 8); registry harus menyediakan
  metadata yang cukup — diwujudkan sebagai `confirmationPolicy`
  ("required" / "scoped" / "none") di Fase 2.
- **Fase 2 menjaga kompatibilitas:** jangan rusak jalur XML; jangan
  asumsikan semua provider mendukung native function calling; jangan
  mengarang kemampuan model yang belum diuji; pertahankan streaming,
  Thinking, Ctrl+C, dan agent loop; adapter konsisten tanpa memaksakan
  semua provider punya fitur identik.
- **Keamanan:** audit ulang risiko akses file kredensial via
  `run_terminal_command` (temuan Fase 2, docs/UNIVERSAL-RUNTIME-PHASE2.md
  §4: sandbox hanya membatasi `cwd` awal, isi perintah tidak divalidasi;
  aturan prompt "stay inside the project folder" ADA tapi itu instruksi
  ke model, bukan enforcement; mitigasi — gate, validasi shell, redaction,
  audit log — adalah pekerjaan Fase 8). Standardisasi adapter TIDAK
  BOLEH memperlebar akses shell atau melemahkan sandbox.

**Urutan kerja yang diperintahkan:** Fase 3 DIDAHULUKAN (selesai
2026-11-10), lalu standardisasi provider adapter (Fase 2), kemudian
native tool calling sebagai jalur tambahan di samping XML yang sudah
berjalan (Fase 5). Aturan penting: jangan rusak XML tool calling yang
sudah terbukti berjalan; jangan hapus fallback lama sebelum jalur native
terbukti stabil; jangan ubah panel atau production tanpa kebutuhan
teknis yang terbukti; jangan deploy tanpa persetujuan; backup sebelum
perubahan; setiap fase wajib punya test dan laporan hasil.

---

## Appendix A — Indeks file yang dibaca (audit trail)

**CLI** (`~/workspace/metatech-cli/src/`): `agent/loop.ts`, `agent/tools.ts`, `agent/xml-parser.ts`, `agent/prompt.ts`, `agent/modes.ts`, `agent/skills.ts`, `agent/slash.ts`, `agent/index.ts`, `api.ts`, `models.ts`, `config.ts`, `cost.ts`, `ui/ChatApp.tsx` (bagian send/compact/catch), `package.json`, `docs/ADOPTION.md`, `docs/AGENT-ADOPTION.md`.

**Panel** (`~/workspace/panel-alternatif/done-hub/`): `relay/chat.go`, `relay/relay.go` (sebagian), `relay/transformer/interface.go`, `relay/transformer/claude.go` (daftar), `relay/transformer/vertex_gemini.go` (daftar), `relay/relay_util/quota.go` (daftar), `providers/base/interface.go`, `common/message_filter.go`, `providers/` (daftar direktori).

**Freebuff** (`~/workspace/freebuff-source/`): `packages/agent-runtime/src/run-agent-step.ts`, `prompt-agent-stream.ts`, `tool-stream-parser.ts`, `tools/tool-executor.ts`, `tools/stream-parser.ts`, `util/stream-xml-parser.ts`, `mcp.ts`, `mcp-constants.ts`, `compact-history.ts`, `compaction.ts`, `llm-api/codebuff-web-api.ts`, `llm-api/claude.ts`, `llm-api/gemini-with-fallbacks.ts`, `packages/llm-providers/src/openai-compatible/index.ts` (+ chat/), `common/src/tools/constants.ts`, `common/src/types/freebuff-model-catalog.ts`, `cli/src/utils/freebuff-model-catalog.ts`, `agents/` (daftar template per model).

**OpenTUI** (`~/workspace/opentui-source/`): `packages/core/src/renderer.ts`, `renderables/ScrollBox.ts`, `ScrollBar.ts`, `ScrollBoxParts.ts`, `lib/parse.mouse.ts`, `lib/scroll-chain.ts`, `Renderable.ts`, `platform/ffi.ts`, `packages/native/src/ansi.zig`, `terminal.zig`, `packages/react/src/reconciler/renderer.ts`, `packages/react/src/components/index.ts`, `packages/examples/src/{scroll-example,mouse-interaction-demo,split-footer-streaming-demo}.ts`, `package.json` root.

**MCP SDK** (`~/workspace/mcp-typescript-sdk/`): `packages/core/src/constants.ts`, `packages/core-internal/src/types/spec.types.2025-11-25.ts`, `shared/protocolEras.ts`, `shared/toolNameValidation.ts`, `types/errors.ts`, `errors/sdkErrors.ts`, `packages/client/src/client/client.ts`, `client/stdio.ts`, `client/streamableHttp.ts`, `client/sse.ts`, `client/versionNegotiation.ts`, `packages/server/src/server/mcp.ts`, `server/createMcpHandler.ts`, `docs/protocol-versions.md`, `docs/clients/`, `docs/servers/`, `packages/core-internal/test/corpus/fixtures/2025-11-25/`, `examples/tools/{client,server}.ts`.

## Appendix B — Fakta yang TIDAK diverifikasi ulang dalam audit ini

- Status live channel panel (id7/id8/id9/id10/id12, 27 model aktif): dari verifikasi live 2026-11-08 (riwayat kerja). Tidak di-query ulang ke panel/bore dalam audit ini.
- Bukti XML tool-call jalan di `glm-5.3-flash` di Termux Reza: dari pengujian live 2026-11-09 (0.1.7). Tidak diulang dalam audit ini.
- Harga model di `COMPILED_PRICES`: dari `/api/available_model` 2026-11-08. Bisa berubah (mis. Gemini naik 1 Des 2026 / 1 Jan 2027 — sudah dicatat di tempat lain).
