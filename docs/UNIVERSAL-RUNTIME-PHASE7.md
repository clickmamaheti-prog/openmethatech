# Universal Agent Runtime — Fase 7: Context & Streaming Integration

Status: **SELESAI** (2026-11-10). Tes: `npx tsc` bersih, `npm test` 342/342
(308 lama + 34 baru), `test/agent-pty.sh` 32/32, `test/tui-pty.sh`
270/270. Belum commit/publish — menunggu perintah Reza. Fase 8 TIDAK
dimulai sebelum perintahnya.

Fase 7 menutup dua celah yang sengaja ditinggal Fase 2–6: loop tidak
pernah mengelola context window (riwayat dikirim utuh sampai provider
menolak) dan tidak pernah membedakan stream yang selesai bersih dari
stream yang terputus (teks parsial bisa menjadi jawaban final). Semua
yang dibangun di sini duduk DI ATAS kontrak Fase 2–6 — tidak ada
komponen lama yang dibangun ulang, tidak ada perubahan format history,
mode CLI, tampilan TUI, atau workflow interaksi.

## 0. Ringkasan perubahan

| Area | Yang dibangun |
|---|---|
| Context management | Modul baru `src/agent/context-manager.ts`: estimasi token (heuristik), budgeting, `prepareContext` (truncation view), `summarizeSegment` (auto-compaction), `buildSummaryMessage`, `addUsage` |
| Streaming | `CollectedChat.streamComplete` (`model-adapter.ts`); timeout 408 vs abort user (`api.ts`); retry max 3x di loop; guard stream tidak lengkap; guard finish reason `length` / `content_filter` |
| Loop | `loop.ts`: prepareContext per langkah + auto-compaction max 1x/turn, retry wrapper, akumulasi usage, `AgentLoopResult.usage` + `AgentLoopResult.context`, `buildResult` untuk semua exit |
| TUI | `ChatApp.tsx`: usage per turn ke footer (slot yang sudah ada), notifikasi auto-compaction sekali per turn |
| Tes | `test/context-streaming.test.mjs` (34 tes baru); MockAdapter di `test/agent-loop.test.mjs` + `test/fallback-protocol.test.mjs` auto-yield finish chunk |

## 1. Context Management (`src/agent/context-manager.ts`)

### 1.1 Estimasi token — heuristik, bukan angka pasti

CLI tidak membawa tokenizer (tanpa dependensi tiktoken). `estimateTokens`
adalah heuristik yang didokumentasikan sebagai perkiraan: ~4 karakter
Latin per token, ~1 token per karakter CJK, plus overhead 8 token per
pesan (+12 untuk pesan tool: nama + tool_call_id). Galat tipikal ±20%
pada kode/prosa. Angka ini dipakai untuk budgeting, TIDAK PERNAH untuk
klaim billing atau ukuran window yang tepat.

### 1.2 Context window — fallback konservatif, bukan fakta

`resolveContextWindow(modelId)` membaca `contextWindow` dari capability
record; bila null (UNKNOWN) dipakai `FALLBACK_CONTEXT_WINDOW_TOKENS =
128_000`. Angka 128k adalah default perencanaan yang konservatif, BUKAN
fakta terukur tentang model mana pun — audit Fase 1 tidak menemukan
model dengan window yang terbukti, dan nilai ini langsung digantikan
saat probe atau konfigurasi provider mengisi `contextWindow`. UNKNOWN
tidak pernah dianggap sebagai window yang diketahui.

### 1.3 Budgeting (`budgetContext`)

Satu request dipecah menjadi: system (termasuk definisi tool — system
prompt memang sudah memuat `toolDescriptionsFor`, jadi
`toolDefinitionTokens` hanya sub-baris informatif, bukan hitungan
ganda), history, tool results (sub-baris history), reserve (maxTokens +
margin 256), dan sisa budget history. `overBudget` benar bila total +
reserve melebihi window.

### 1.4 Truncation view (`prepareContext`) — BUKAN mutasi history

Ini keputusan desain yang paling penting di Fase 7: **stored history
tidak pernah dimutasi oleh truncation**. Loop menyimpan history penuh
(format Fase 5, tidak berubah) dan hanya mengirim VIEW yang muat.

Aturan view, berurutan:
1. Pesan pertama (system prompt) dan pesan ringkasan yang di-pin tidak
   pernah di-drop.
2. Exchange utuh di-drop dari depan sampai view muat — exchange adalah
   unit drop, jadi pesan tool-call assistant TIDAK PERNAH terpisah dari
   tool result-nya.
3. Exchange TERAKHIR (memuat prompt pengguna saat ini) tidak pernah
   di-drop.
4. Jalan terakhir: isi tool result di dalam view dipotong (head 1500 +
   marker + tail 500) — hanya di view, stored history tetap utuh.
5. Bila view minimal pun masih melebihi window, `overBudget = true`
   dan view minimal tetap dikirim — provider menolak dengan jujur,
   loop tidak pernah diam-diam menghapus request pengguna.

### 1.5 Auto-compaction — max 1x per turn, failure-safe

Bila truncation akan men-drop pesan DAN belum ada compaction di turn
ini, loop memanggil `summarizeSegment` pada segmen yang ter-drop.
Summarizer memakai ulang prompt `/compact` yang sudah ada
(`compactPrompt` dari `slash.ts` — kontrak yang sama dengan /compact
manual), dengan input dibatasi ~100.000 karakter (pesan tertua di-drop
dulu). Hasilnya menggantikan segmen yang ter-drop di STORED history
sebagai pesan system berawalan `[Ringkasan percakapan]` — pola yang
sama dengan pesan system pengingat langkah yang sudah ada, dan bentuk
yang sama dengan hasil /compact manual.

Bila summarization gagal (error provider, abort, ringkasan kosong),
hasilnya null dan loop lanjut dengan truncated view — turn TIDAK PERNAH
crash karena summarization. Bila berhasil, loop prepare ulang: segmen
yang ter-drop kini menjadi ringkasan, jadi view biasanya muat tanpa
drop. Compaction tidak menyentuh pesan display (display vs history
model tetap terpisah, sesuai desain).

## 2. Streaming Integration

### 2.1 `streamComplete` (`model-adapter.ts`)

`collectChatText` kini mengembalikan `streamComplete: boolean` — true
hanya bila server mengirim usage chunk ATAU finish chunk. Server panel
mengirim keduanya di chunk terakhir (`finish_reason` + usage via
`stream_options.include_usage`), jadi stream live yang sehat selalu
complete. Stream yang tertutup bersih TANPA keduanya berarti server
menutup koneksi di tengah respons: teks yang terkumpul adalah PARSIAL.

### 2.2 Guard stream tidak lengkap (`loop.ts`)

Bila `!lastStreamComplete` setelah call berhasil, loop berhenti dengan
`stopReason` eksplisit ("stream ended before the server finished..."),
SEBELUM pesan assistant di-push ke history. History tetap utuh,
pengguna bisa kirim ulang. Teks parsial yang sudah tampil di display
adalah display live, bukan jawaban final yang dikomit.

### 2.3 Timeout vs abort (`api.ts`)

Sinyal timeout kini bernama (`timeoutSignal`): abort karena timeout
120 detik dilempar sebagai `ApiError(408)` → adapter memetakannya ke
kind `"server"`, retryable. Abort pengguna (Esc / Ctrl+C) tetap
`AbortError` → kind `"aborted"`, tidak retryable. Sebelum Fase 7,
keduanya tidak bisa dibedakan dan timeout tidak pernah bisa di-retry.

### 2.4 Retry policy (loop, pola Freebuff `codebuff-web-api.ts`)

Max 3 attempt per langkah, hanya untuk error yang adapter tandai
retryable (408/429/500/502/503/504), backoff 500ms lalu 1000ms
(abortable sleep — Ctrl+C saat backoff langsung interrupt, bukan
tidur sampai habis lalu retry). Syarat kedua: attempt yang gagal TIDAK
BOLEH sudah mengirim delta apa pun — retry setelah streaming parsial
akan menduplikasi teks/reasoning yang sudah tampil. Abort tidak pernah
di-retry. Setiap attempt mendapat parser state baru.

### 2.5 Finish reason

- `content_filter` (tanpa tool call): turn berhenti eksplisit,
  completed=false — provider menolak reply, bukan jawaban normal.
- `length` (tanpa tool call): turn berhenti eksplisit — jawaban
  terpotong di max_tokens dan tidak lengkap.
- `length` DENGAN tool call: tool tetap dieksekusi, pekerjaan lanjut
  di langkah berikut (potongan terjadi di teks, bukan di call).

### 2.6 Usage per turn (follow-up lama, kini selesai)

`collectChatText` menangkap usage per langkah; loop menjumlahkannya ke
`AgentLoopResult.usage` (turn total). `ChatApp.tsx` mengumpankannya ke
slot footer yang sudah ada (`formatUsageLine`) — agent turn kini
menampilkan usage di footer. Per-step breakdown tetap follow-up.

## 3. Tool dan Context

- Hasil orchestrator masuk ke history dengan urutan yang sama seperti
  sebelumnya (`resultToToolMessage`, id `call-{step}-{index}`) — Fase 7
  tidak mengubah jalur ini.
- Hubungan tool call ↔ tool result dipertahankan oleh truncation
  berbasis exchange (keduanya di-drop atau dipertahankan bersama) dan
  oleh fakta bahwa truncation tool result hanya terjadi di view.
- Tidak ada duplikasi: ledger Fase 5 tidak berubah (hanya call yang
  benar-benar dieksekusi tercatat); retry model call tidak pernah
  mengeksekusi ulang tool (retry hanya di level model call, sebelum
  parse); compaction menggantikan segmen, bukan menduplikasinya
  (pesan yang ter-drop keluar dari stored history).
- Fallback XML tetap kompatibel: `toolChannel` tetap `"xml-fallback"`
  untuk model tanpa native yang terbukti, termasuk di percakapan
  panjang; routing tidak berubah.

## 4. Kompatibilitas provider

- Tidak ada asumsi fitur: reasoning, streaming tool call, dan window
  dibaca dari capability registry; UNKNOWN tidak pernah dianggap
  SUPPORTED (window UNKNOWN → fallback 128k, bukan "unlimited").
- Provider tanpa usage chunk: `streamComplete` tetap true bila finish
  chunk ada; provider tanpa keduanya akan selalu terlihat "incomplete"
  — itu perilaku yang benar (tidak ada bukti stream selesai), dan
  akan diperbaiki oleh probe yang mengisi capability record, bukan
  oleh asumsi.
- Provider tanpa finish reason `length`/`content_filter`: guard tidak
  aktif (lastFinishReason null) — perilaku lama dipertahankan.

## 5. File yang berubah

| File | Perubahan |
|---|---|
| `src/agent/context-manager.ts` | BARU (~400 baris): estimasi, budgeting, prepareContext, summarizeSegment, buildSummaryMessage, addUsage |
| `src/agent/loop.ts` | prepareContext + auto-compaction per langkah, retry wrapper, usage, finish-reason + stream guard, `usage`/`context` di result, `buildResult`, konstanta `MAX_MODEL_CALL_ATTEMPTS`/`MODEL_CALL_RETRY_DELAYS_MS`/`LOOP_MAX_TOKENS`, header kontrak Fase 7 |
| `src/agent/model-adapter.ts` | `CollectedChat.streamComplete` |
| `src/api.ts` | timeout bernama → `ApiError(408)`; abort user tetap `AbortError` |
| `src/ui/ChatApp.tsx` | usage turn ke footer + notifikasi auto-compaction |
| `test/context-streaming.test.mjs` | BARU: 34 tes |
| `test/agent-loop.test.mjs` | MockAdapter auto-yield finish chunk (+ opt-out `truncate`, `finishReason`) |
| `test/fallback-protocol.test.mjs` | MockAdapter auto-yield finish chunk (sama) |

Tidak berubah: `tool-registry.ts`, `tool-orchestrator.ts`,
`fallback-protocol.ts`, `model-capabilities.ts`, `tools.ts`,
`prompt.ts`, `slash.ts`, mode CLI, panel, production.

## 6. Hasil pengujian (aktual)

Semua dengan mock, tanpa jaringan, di VM ini:

- `npx tsc --noEmit`: bersih (0 error).
- `npm test`: **342/342 hijau** (308 lama + 34 baru). Yang baru:
  estimasi token (Latin/CJK), overhead pesan, budgeting lintas
  provider (128k vs 5k), truncation view (drop depan, keep terakhir,
  pasangan tool-call/result tidak terpisah, truncasi view-only,
  pin ringkasan), `summarizeSegment` (sukses/gagal/abort/kosong),
  `normalizeProviderError` (408/429/5xx retryable, 400 tidak, abort
  tidak), usage akumulasi, retry 500 2x lalu sukses (3 call), tanpa
  retry untuk 400, retry 408, tanpa retry setelah streaming parsial,
  stream tidak lengkap (history utuh, tanpa pesan parsial), finish
  `length`/`content_filter`, `length` + tool call tetap eksekusi,
  abort sebelum + di tengah stream (tanpa retry), assembly streaming
  berurutan, dua tool call satu langkah (ledger unik), percakapan
  panjang 120 exchange (truncation view + tool message tersimpan
  tepat sekali), auto-compaction (ringkasan menggantikan segmen),
  truncasi tool result 40k di view langkah-2 (stored tetap penuh).
- `test/agent-pty.sh`: **32/32**.
- `test/tui-pty.sh`: **270/270** — setelah satu perbaikan yang
  ditemukan oleh suite ini sendiri: run pertama 269/270, gagal
  `s33/80: footer stays on the last row with a long draft` — part
  usage baru (turn total) membuat baris footer 80 kolom meluap
  (94 > 78 karakter) sehingga cascade men-drop hint, termasuk
  `Ctrl+C 2x keluar`. Perbaikan: bila usage ada dan hint penuh
  tidak muat berdampingan, hint memakai varian ringkas (tetap
  memuat history, help, dan exit) — di `ChatApp.tsx`, tanpa
  mengubah urutan part atau perilaku cascade. Re-run penuh hijau.
- Catatan: `dist/` harus di-build (`npx tsc`) sebelum `npm test`
  karena tes mengimpor dari `dist/`; `tsc --noEmit` saja tidak
  cukup. Tiga tes baru sempat gagal saat penulisan karena sizing
  window/history di tes saya sendiri (bukan bug implementasi):
  history 60 exchange muat di budget — diperbaiki ke 120 exchange
  dan window sempit 5k, lalu hijau.

## 7. Kompatibilitas dengan Fase 1–6

- Fase 1 (audit): tidak ada temuan audit yang dilanggar; window
  fallback 128k dicatat sebagai default perencanaan, bukan fakta.
- Fase 2 (adapter): kontrak adapter tidak berubah — hanya field
  tambahan `streamComplete` di `CollectedChat`; fail-loud untuk
  request ber-tools tidak berubah; `normalizeProviderError` dipakai
  ulang oleh retry loop.
- Fase 3 (registry): tidak disentuh; `toolDescriptionsFor` dipakai
  ulang untuk sub-baris budgeting.
- Fase 4 (orchestrator): tidak disentuh; satu-satunya jalur eksekusi
  tool tetap orchestrator; hasil tool tetap `resultToToolMessage`.
- Fase 5 (agent loop): format history tidak berubah; ledger tidak
  berubah (hanya call yang dieksekusi tercatat); semua 5 exit site
  kini membawa `usage` + `context` lewat `buildResult`; perilaku
  runtime untuk percakapan pendek tidak berubah (prepareContext
  pass-through, tanpa retry bila tidak ada error).
- Fase 6 (fallback): routing + protokol tidak berubah; guard
  `length`/`content_filter` hanya aktif bila tidak ada tool call;
  MockAdapter kedua file tes di-update agar auto-yield finish chunk
  (perilaku server nyata).

## 8. Keterbatasan yang masih ada

1. **Estimasi token adalah heuristik (±20%)**, bukan tokenizer.
   Budget bisa meleset di kedua arah: view yang dikirim bisa sedikit
   melebihi window nyata (provider menolak — ditangani retry/error
   path), atau truncation memotong lebih awal dari yang perlu.
   Tokenizer asli (tiktoken) adalah follow-up, bukan Fase 7.
2. **Window 128k adalah default perencanaan**, bukan fakta per
   model. Model dengan window nyata lebih kecil akan memicu error
   provider sebelum truncation bekerja optimal — probe-live Fase 9
   yang mengisi `contextWindow` per model.
3. **Ringkasan auto-compaction ditulis oleh model yang sama** —
   kualitasnya tergantung model; ringkasan yang salah bisa
   menghilangkan detail penting dari segmen yang ter-drop. Tidak ada
   validasi isi ringkasan; pengguna diberitahu lewat notifikasi TUI.
4. **Retry tidak menutupi provider yang lambat secara konsisten**:
   3 attempt dengan backoff 500ms+1000ms; bila provider down lebih
   lama, turn tetap gagal dengan pesan eksplisit.
5. **Stream "complete" didefinisikan oleh sinyal server** (usage
   atau finish chunk). Provider yang tidak mengirim keduanya akan
   selalu terlihat incomplete — benar secara konservatif, tapi
   bergantung pada probe capability untuk membedakannya.
6. **Per-step usage breakdown** masih follow-up (yang selesai di
   Fase 7 adalah total per turn di footer).
7. **Compaction di-retry tiap langkah bila gagal** (selama belum
   berhasil di turn itu): bila summarizer gagal terus, tiap langkah
   membayar satu model call yang gagal sebelum lanjut dengan
   truncated view. Jarang terjadi (gagal berarti provider bermasalah),
   tapi perlu dicatat.
8. **Tidak ada verifikasi live** (sesuai perintah: mock saja).
   Perilaku terhadap panel relay nyata — terutama urutan chunk
   finish + usage dan finish reason `length` — perlu probe live di
   Fase 9.

## 9. Kesiapan Fase 8 (Security Hardening)

Fase 7 siap diserahkan ke Fase 8:

- **Yang sudah disediakan untuk Fase 8:** retry yang tidak
  menduplikasi eksekusi (fondasi aman untuk gate), usage + context
  di result (observabilitas untuk audit log), pemisahan view vs
  stored history (audit bisa membedakan yang dikirim vs yang
  disimpan).
- **Yang TETAP TERBUKA untuk Fase 8 (tidak berubah oleh Fase 7):**
  akses kredensial via shell TIDAK divalidasi (temuan Fase 2,
  dampak Fase 7 NOL); tidak ada confirmation gate / Ask / YOLO /
  --yolo (sengaja tidak ditambahkan); tidak ada validasi isi
  perintah shell, secret redaction, atau audit log.
- **Yang harus dikerjakan SEBELUM atau BERSAMA Fase 8 bila
  relevan:** tidak ada — Fase 7 tidak menambah permukaan serangan
  baru (satu-satunya model call tambahan adalah summarization,
  yang memakai adapter + API key yang sama, tanpa tool).

Fase 8 TIDAK dimulai sebelum Reza memberi perintah.
