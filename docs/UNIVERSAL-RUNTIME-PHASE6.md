# MethaTech Universal Agent Runtime — FASE 6: Fallback Tool Protocol

**Tanggal:** 2026-11-10
**Status:** SELESAI, teruji, TIDAK commit/publish/deploy. HEAD tetap `b384284` (0.1.8).
**Repo:** `~/workspace/metatech-cli/` (working tree 0.1.9 §4j–§4q + Fase 1 audit + Fase 3 registry + Fase 2 adapter + Fase 4 orchestrator + Fase 5 loop + Fase 6 ini).
**Referensi:** `docs/UNIVERSAL-RUNTIME-AUDIT.md` (Fase 1 + §9 definisi Fase 6 + §11 Keputusan Reza), `docs/TOOL-CALL-PROTOCOL.md` (dokumen protokol normatif), `docs/UNIVERSAL-RUNTIME-PHASE2.md` (adapter + capability registry), `docs/UNIVERSAL-RUNTIME-PHASE3.md` (tool registry), `docs/UNIVERSAL-RUNTIME-PHASE4.md` (orchestrator), `docs/UNIVERSAL-RUNTIME-PHASE5.md` (agent loop + ledger).
**Backup pre-Fase 6:** `.bak-20261110-fallback/` (`loop.ts`, `tool-orchestrator.ts`, `UNIVERSAL-RUNTIME-AUDIT.md`).

## 0. Keputusan yang mengikat fase ini

### 0.1 Roadmap asli (mengikat)

Fase 6 = Fallback Tool Protocol. Fase 7 = Context & Streaming.
Fase 8 = Security Hardening. Fase 9 = Cross-Model Testing.
Fase 10 = Final Audit & Dokumentasi. Jangan mengubah urutan, nama,
tujuan, atau cakupan fase.

### 0.2 Keputusan Reza 2026-11-10 (tetap berlaku)

1. Confirmation gate HANYA untuk tool kritis + flag `--yolo` (gate di Fase 8).
2. Capability registry di CLI dulu, status SUPPORTED / UNSUPPORTED / UNKNOWN.
3. Runtime TETAP lokal di CLI; panel tetap relay.
4. Live probe SUBSET (10 free + Sonnet + Opus + 1 per provider lain) — Fase 9.
5. Paralel hanya read-only tanpa dependency; mutasi sekuensial.

### 0.3 Klarifikasi Reza 2026-11-10 (permission vs risk, tetap berlaku)

Permission dan risk DIBEDAKAN. `run_terminal_command` (critical)
WAJIB gate; `write_file` (high) WAJIB konfirmasi saat gate
diimplementasikan; `str_replace` dievaluasi dari cakupan perubahan
+ risk metadata; `write_todos` dan `skill` mengikuti risk +
permission masing-masing. `--yolo` boleh melewati konfirmasi
interaktif, tapi TIDAK BOLEH melewati sandbox, security policy,
validasi input, atau perlindungan kredensial. Gate TIDAK
diimplementasikan di fase ini (Fase 8).

### 0.4 Ketentuan implementasi Fase 6 (dari perintah Reza)

- Pertahankan XML tool calling yang sudah berjalan; jangan ganti
  atau hapus mekanisme XML.
- Jangan asumsikan semua model mendukung native function calling.
- Gunakan Capability Registry untuk menentukan kemampuan model;
  status UNKNOWN tidak boleh dianggap sebagai SUPPORTED.
- Gunakan Tool Registry sebagai sumber definisi tool.
- Seluruh eksekusi tool harus melewati Tool Orchestrator.
- Tangani respons malformed, parameter tidak valid, tool tidak
  dikenal, dan output yang tidak lengkap.
- Jangan sampai satu tool call dieksekusi dua kali akibat retry
  atau fallback.
- Pertahankan format history, streaming, Thinking, Ctrl+C, dan
  perilaku CLI yang sudah ada.
- Jangan mengubah mode CLI, TUI, panel, atau workflow interaksi.
- Jangan menambahkan Ask, YOLO, `--yolo`, atau confirmation
  workflow baru.
- Jangan membangun ulang komponen yang sudah tersedia pada fase
  sebelumnya.

## 1. Audit sebelum coding (jalur XML yang ada)

Audit dilakukan dengan membaca source aktual + grep verifikasi.
Kesimpulan: jalur XML sudah lengkap sebagai mekanisme, tapi
protokolnya informal — tidak ada dokumen, tidak ada routing
berbasis capability, tidak ada batas kegagalan protokol yang
eksplisit, dan loop tidak bisa membedakan "call tidak pernah
jalan" dari "call jalan lalu gagal".

### 1.1 Yang SUDAH tersedia (tidak dibuat ulang)

| Komponen | Bukti | Status |
|---|---|---|
| Parser XML (tag, alias `codex_tool_call`, JSON body, parse error, unclosed tag) | `src/agent/xml-parser.ts` | Sudah ada, tidak diubah |
| Validasi schema JSON Schema per call + unknown tool + mode membership | `tool-orchestrator.ts: executeOne` (validator Fase 3) | Sudah ada, tidak diubah |
| Retry `[TOOL_CALL_ERROR]` untuk JSON malformed | `loop.ts` parse-error branch | Sudah ada, diperketat (§2.3) |
| Nudge max 2x untuk janji tanpa call | `loop.ts: MAX_TOOL_CALL_NUDGES` | Sudah ada, ujungnya diubah (§2.3) |
| Execution ledger (satu call = satu eksekusi) | `loop.ts: executedToolCalls` (Fase 5) | Sudah ada, diperketat (§2.2) |
| Capability registry + `isCapabilityProven` | `model-capabilities.ts` (Fase 2) | Sudah ada, dipakai routing (§2.1) |
| Prompt yang mengajarkan protokol XML | `prompt.ts` (bagian "How to call tools") | Sudah ada, tidak diubah |
| Guard loop (max steps 100/600, no-progress 40, failed-edit 6, todo-loop 3/6) | `loop.ts` | Sudah ada, tidak diubah |

### 1.2 Kebutuhan fallback yang BENAR-BENAR belum tersedia

1. **Dokumen protokol.** Tidak ada satu dokumen pun yang
   menyatakan format, aturan validasi, taksonomi error, dan batas
   protokol. Audit §9 menamai file ini: `docs/TOOL-CALL-PROTOCOL.md`.
2. **Routing berbasis capability.** Tidak ada kode yang memutuskan
   channel dari kemampuan model — loop selalu memakai XML tanpa
   membaca registry. UNKNOWN tidak pernah ditegaskan sebagai "bukan
   SUPPORTED" di kode.
3. **Batas kegagalan protokol yang eksplisit.** JSON malformed
   bisa retry sampai guard no-progress 40 (40 langkah terbakar);
   nudge yang habis mengakhiri turn diam-diam sebagai completed
   "no more tool calls"; kegagalan validasi hanya jadi error tool
   generik tanpa pernah menghentikan turn secara eksplisit.
4. **Pembedaan "tidak pernah jalan" vs "jalan lalu gagal".**
   `OrchestratedToolResult` tidak membawa klasifikasi kegagalan,
   dan ledger Fase 5 mencatat SEMUA hasil batch — termasuk call
   yang gagal validasi dan tidak pernah dieksekusi — sebagai
   "eksekusi". Klaim "satu call = satu eksekusi" tidak presisi.

Bukan kebutuhan (dicatat, tidak dikerjakan — di luar cakupan Fase 6):
- **Native `tools`** — fase berikutnya, penempatan diputuskan Reza.
  Adapter tetap menolak fail-loud bila ada request membawa tools.
- **Retry policy model call, token budgeting, auto-compaction**
  (Fase 7). **Gate, validasi shell, secret redaction, audit log**
  (Fase 8). **Probe live** (Fase 9).

## 2. Yang dibangun

### 2.1 Modul baru `src/agent/fallback-protocol.ts`

Kontrak protokol + routing, tanpa wire format baru dan tanpa jalur
eksekusi baru:

- `ToolCallChannel = "native" | "xml-fallback"`.
- `resolveToolChannel(record)` — native HANYA bila
  `isCapabilityProven(record, "nativeToolCalling")` (SUPPORTED dari
  probe-live; provider-config saja bukan bukti); selain itu
  `"xml-fallback"`. `channelForModel(modelId)` membungkusnya
  (model tak dikenal = semua-UNKNOWN → fallback).
- `PROTOCOL_FAILURE_LIMIT = 2`.
- `protocolFailureMessage(model, detail)` — pesan eksplisit ke
  user: model + alasan konkret + "after 2 attempts" + arahan coba
  model lain. `protocolFailureStopReason(detail)` — stopReason
  pendek untuk baris "Agen berhenti: …".
- `isProtocolViolationResult(result)` — `failureKind ===
  "validation"`: call tidak pernah jalan (unknown tool, di luar
  mode, schema-invalid). `"execution"` / `"timeout"` / `null`
  berarti handler jalan — bukan pelanggaran.
- `createProtocolTracker()` — counter streak murni dan
  unit-testable: `recordViolation()`, `recordExecution()` (reset),
  `shouldStop()` (streak ≥ 2).

Header modul menjelaskan pembedaan ketiganya secara eksplisit:
**native** adalah channel (structured `tool_calls`, belum
terpasang); **XML** adalah channel yang benar-benar jalan hari
ini; **fallback** adalah kebijakan routing yang memilih XML
kapan pun native tidak terbukti — bukan format wire ketiga.

### 2.2 `failureKind` di orchestrator (`src/agent/tool-orchestrator.ts`)

Satu field aditif di `OrchestratedToolResult`:

- `"validation"` — call tidak pernah jalan: mode-rejected,
  unknown tool, schema-invalid (ketiga situs `errorResult`,
  default parameter).
- `"execution"` — handler jalan dan mengembalikan `ok: false`
  atau throw.
- `"timeout"` — handler jalan dan hang guard menyala.
- `null` — call berhasil.

Loop membaca field ini, tidak pernah menebak dari teks output.
Tidak ada perubahan perilaku orchestrator: pesan error, urutan
hasil, batch stop, dan timeout sama persis.

### 2.3 Aturan 2x di loop (`src/agent/loop.ts`)

Tiga jalur pelanggaran, satu pesan eksplisit yang sama:

1. **JSON malformed / tag tidak tertutup** (parse-error branch):
   streak +1; pada pelanggaran ke-2 turn berhenti dengan pesan
   eksplisit (detail `malformed tool-call JSON` atau
   `unclosed tool-call tag`). Pelanggaran pertama tetap mendapat
   `[TOOL_CALL_ERROR]` + retry seperti sebelumnya.
2. **Validasi batch** (sesudah `executeToolCalls`): langkah yang
   mengeksekusi minimal satu call me-reset streak; langkah dengan
   pelanggaran dan tanpa eksekusi menaikkan streak; pada
   pelanggaran ke-2 turn berhenti (detail `unknown tool` bila
   semua pelanggaran adalah unknown tool, sonst
   `invalid tool-call parameters`).
3. **Janji tanpa call** (nudge habis): setelah 2 nudge model
   masih berjanji tanpa call → turn berhenti eksplisit (detail
   `promised tool work but emitted no tool call after 2
   reminders`), BUKAN completed "no more tool calls" seperti
   sebelumnya. Jawaban teks biasa tanpa janji tetap completed
   normal.

Pesan eksplisit sampai ke user dua jalur: `finalText` + event
`text` (TUI menampilkannya sebagai pesan terakhir asisten) dan
`stopReason` (TUI menampilkan `Agen berhenti: protocol
violation: …`). `completed` adalah `false` — ini kegagalan
mengikuti protokol, bukan turn yang selesai.

### 2.4 Ledger diperketat (loop)

Hanya call yang benar-benar dieksekusi yang masuk
`executedToolCalls`: hasil dengan `failureKind === "validation"`
tetap masuk history sebagai tool message (model harus melihat
errornya), tapi TIDAK masuk ledger. Komentar ledger Fase 5
diperbaiki: "satu entri per call yang benar-benar dieksekusi".
Tidak ada perubahan format history: pesan tool tetap
`{tool, ok, output}` + id sintetis `call-{step}-{index}`.

### 2.5 Channel tercatat di hasil loop

`AgentLoopResult` mendapat field baru `toolChannel` (diisi di
semua jalur keluar, termasuk early return). Hari ini nilainya
selalu `"xml-fallback"` — hasil yang jujur, karena belum ada
model yang terbukti native. Fase native nanti membaca decision
point yang sama.

### 2.6 Yang TIDAK diubah

- Tag `<codebuff_tool_call>` + alias, parser, nudge, retry —
  tidak berubah.
- Mode CLI, tampilan TUI, perilaku konfirmasi — tidak berubah;
  tidak ada Ask / YOLO / `--yolo` / confirmation workflow baru.
- Tidak ada handler tool baru atau yang ditulis ulang; `tools.ts`,
  `prompt.ts`, `modes.ts`, `xml-parser.ts`, `api.ts`,
  `ChatApp.tsx` TIDAK disentuh.
- Native `tools` tetap TIDAK dikirim; adapter tetap menolak
  fail-loud.
- Tidak ada perubahan panel / production / database.
- Tidak ada retry policy, token budgeting, auto-compaction
  (Fase 7); tidak ada gate / validasi shell / redaction /
  audit log (Fase 8).

## 3. Kontrak protokol (ringkas; normatif di `docs/TOOL-CALL-PROTOCOL.md`)

- **Input (model → loop):** teks balasan; call = JSON dalam tag
  `<codebuff_tool_call>` (alias `<codex_tool_call>`), satu call
  per tag, `cb_tool_name` wajib string, kunci lain = input tool.
- **Routing (sebelum turn):** `resolveToolChannel` dari capability
  record; UNKNOWN → fallback.
- **Validasi (orchestrator, per call):** mode membership →
  registry lookup → JSON Schema input. Gagal = error result di
  channel yang sama; call tidak dieksekusi.
- **Eksekusi (orchestrator):** satu-satunya jalur; hasil selalu
  dalam urutan call; read-only boleh paralel (wave), mutasi
  sekuensial; batch berhenti setelah `ask_user` / `endsAgentStep`.
- **Output (loop → model):** hasil sebagai pesan `role: "tool"`
  `{tool, ok, output}` + id `call-{step}-{index}`; pesan asisten
  menyimpan teks mentah ber-tag XML.
- **Output (loop → user) saat gagal protokol 2x:** pesan
  eksplisit (§2.3) sebagai finalText + stopReason.
- **Anti-duplikasi:** satu parsed call = tepat satu eksekusi;
  ledger mencatat hanya eksekusi nyata; retry/fallback tidak
  pernah mengeksekusi ulang call yang sama.

## 4. Tes

### 4.1 Hasil aktual

| Suite | Hasil |
|---|---|
| `npx tsc --noEmit` | Bersih |
| `npm test` (unit) | **308/308** (288 sebelumnya + 20 baru di `test/fallback-protocol.test.mjs`) |
| `test/agent-pty.sh` | **32/32** |
| `test/tui-pty.sh` | **270/270** (captures di `/tmp/methatech-tui-pty`) |

### 4.2 Test baru (`test/fallback-protocol.test.mjs`, 20 test)

MockAdapter scripted tanpa jaringan (pola yang sama dengan
`test/agent-loop.test.mjs`).

| Test | Yang dibuktikan |
|---|---|
| routing: UNKNOWN → fallback | `glm-5.3-flash` (seed UNKNOWN) → `xml-fallback` |
| routing: UNSUPPORTED → fallback | Set probe-live UNSUPPORTED → `xml-fallback` |
| routing: SUPPORTED provider-config-only → fallback | Config claim bukan bukti → `xml-fallback` |
| routing: SUPPORTED probe-live → native | Hanya probe-live yang merutekan native |
| routing: unlisted model → fallback | Semua-UNKNOWN → `xml-fallback` |
| tracker: 1 violation tidak stop, 2 stop, eksekusi reset | Streak murni, limit 2 |
| protocolFailureMessage | Nama model + detail + "2 attempts" + arahan |
| isProtocolViolationResult | Hanya `"validation"` yang pelanggaran |
| loop: model tanpa native jalan lewat fallback XML | `toolChannel` xml-fallback, 2 call tereksekusi, `tools` tidak dikirim |
| loop: JSON malformed 2x → explicit stop | 2 model call saja (bukan 40), completed false, ledger kosong |
| loop: unclosed tag 2x → explicit stop | Detail `unclosed tool-call tag`, ledger kosong |
| loop: unknown tool 2x → explicit stop | Detail `unknown tool`, ledger kosong |
| loop: schema-invalid 2x → explicit stop | Detail `invalid tool-call parameters`, ledger kosong |
| loop: 1 violation lalu call diperbaiki → lanjut + selesai | Streak reset oleh eksekusi; ledger 1 read_files |
| loop: tool execution error BUKAN pelanggaran | read_files file hilang 1x → turn lanjut, completed normal, ledger 1 entri `ok: false` |
| loop: retry sesudah validation failure tepat 1 eksekusi | Call gagal validasi lalu diperbaiki → ledger tepat 1 read_files |
| loop: mixed step (valid + invalid) | Valid tereksekusi, streak reset, turn selesai normal, ledger 1 |
| loop: janji tanpa call 2x → explicit stop | 3 model call, completed false, detail `promised tool work` |
| loop: jawaban biasa tetap completed normal | `no more tool calls`, tanpa protocol stop |
| loop: percakapan lanjut sesudah hasil tool | History roles `[system,user,assistant,tool,system,assistant,tool]` (termasuk reminder `[step 2]`) |

### 4.3 Catatan jujur: dua kegagalan awal adalah kesalahan saya di test, bukan regresi

1. **Test `agent.test.mjs` lama** ("promise twice with no call
   ends the turn after 2 nudges", dari §4j) menegaskan perilaku
   PRA-Fase 6: nudge habis → completed `no more tool calls`.
   Fase 6 sengaja mengubah perilaku ini (audit §9: hentikan
   dengan pesan eksplisit, bukan diam-diam selesai). Test
   diperbarui ke ekspektasi baru (completed false, stopReason
   protocol violation); 2 nudge tetap dikirim, jumlah step sama.
2. **Test saya sendiri** (roles history): ekspektasi lupa bahwa
   loop menyisipkan pesan sistem `[step 2]` di step kedua —
   urutan benar 7 elemen, bukan 6 (pelajaran yang sama dengan
   Fase 5). Diperbaiki di test saja.

Tidak ada kode produksi yang diubah untuk meloloskan test.

## 5. Kompatibilitas dengan fase sebelumnya

| Fitur | Status |
|---|---|
| XML tool calling (tag, alias, parser, nudge, retry) | Dipertahankan; perilaku hanya berubah di ujung kegagalan 2x (eksplisit, bukan diam-diam) |
| Mode CLI (DEFAULT/LITE/MAX/PLAN) | Tidak berubah |
| Streaming, Thinking, Ctrl+C | Tidak berubah; agent-pty 32/32 + tui-pty 270/270 hijau |
| Context antar turn, `/compact` | Tidak berubah |
| 11 tool + handler | Tidak berubah; `tools.ts` tidak disentuh |
| Adapter Fase 2, Registry Fase 3, Orchestrator Fase 4, Loop Fase 5 | Dipakai apa adanya; orchestrator hanya mendapat field aditif `failureKind` |
| Panel / production | Tidak berubah |

## 6. Temuan dan pekerjaan yang masih tertunda

### 6.1 Temuan keamanan shell — status TERBUKA (Fase 8)

Tidak berubah di fase ini dan TIDAK dianggap selesai karena Fase 6
lulus pengujian. Fakta (audit Fase 2 §4, dicatat lengkap di
PHASE4 §5): shell `spawn("bash", ["-c", ...])` hanya me-sandbox
`cwd` awal; isi perintah tidak divalidasi; model bisa membaca file
kredensial (`~/.config/metatech/credentials.json`, `~/.ssh`,
`.env`), `env`, eksfiltrasi via `curl`, `rm -rf ~`, `>> ~/.bashrc`;
aturan prompt adalah instruksi ke model, BUKAN enforcement.
**Dampak Fase 6 terhadap risiko ini: NOL** — tidak ada jalur shell
baru, tidak ada handler yang diubah. Mitigasi (validasi shell,
secret redaction, audit log, gate) tetap jatah Fase 8.

### 6.2 Tertunda (bukan Fase 6)

- **Native tool calling** — fase berikutnya, penempatan diputuskan
  Reza. Kontrak sudah siap (`tools`, `toolChoice`, chunk
  `tool_call`, `toOpenAiFunction`, dan kini `resolveToolChannel`
  + `toolChannel`); yang belum ada: pengirim `tools`, parser
  `delta.tool_calls`, normalisasi history native vs XML; validasi
  live per channel tetap dibutuhkan (Fase 9).
- **Retry policy, token budgeting, auto-compaction** — Fase 7.
- **Gate, validasi shell, secret redaction, audit log** — Fase 8.
- **Per-step usage/cost surfacing ke footer TUI** — follow-up lama.
- **`executeToolCall` (`tools.ts`) tanpa pemanggil produksi** —
  dibiarkan sebagai seam pengujian handler.
- **History tool-call lama saat pindah jalur** — id sintetis
  `call-{step}-{index}` perlu normalisasi/pembuangan saat jalur
  native aktif nanti.

## 7. Status kesiapan Fase 7 (Context & Streaming Integration)

**SIAP, dengan satu catatan.** Prasyarat Fase 7 sudah terpenuhi:

- Loop berjalan melalui adapter + orchestrator dengan ledger dan
  kini dengan protokol fallback yang terdokumentasi — Fase 7
  membangun budgeting/compaction/retry di atas siklus yang sama
  tanpa mengubah protokol.
- Adapter sudah mengumpulkan `usage` per chunk
  (`collectChatText` mengembalikan usage); loop masih
  mengabaikannya — Fase 7 tinggal memakainya untuk budgeting dan
  surfacing per-step ke footer (follow-up lama yang sudah dicatat).
- Retry policy model call (3x untuk 408/429/500/502/503/504
  dengan backoff) adalah pekerjaan baru, tidak ada prasyarat yang
  hilang: `AdapterError` Fase 2 sudah membawa klasifikasi
  `retryable`.
- Catatan: batas no-progress 40 dan protocol-failure 2x saling
  melengkapi (pelanggaran protokol berhenti di 2, bukan 40) —
  Fase 7 tidak perlu mengubah keduanya, hanya menambahkan retry
  di level pemanggilan model.

## 8. File

- BARU: `src/agent/fallback-protocol.ts` (routing + aturan 2x +
  pesan eksplisit + tracker), `test/fallback-protocol.test.mjs`
  (20 test), `docs/TOOL-CALL-PROTOCOL.md` (dokumen protokol
  normatif), `docs/UNIVERSAL-RUNTIME-PHASE6.md` (dokumen ini).
- DIUBAH: `src/agent/loop.ts` (resolusi channel, streak
  pelanggaran, explicit stop, ledger hanya eksekusi nyata, field
  `toolChannel`), `src/agent/tool-orchestrator.ts` (field aditif
  `failureKind` + komentar header), `src/agent/index.ts`
  (export modul baru), `test/agent.test.mjs` (1 test §4j
  diperbarui ke perilaku Fase 6 yang disengaja),
  `docs/UNIVERSAL-RUNTIME-AUDIT.md` (§9 Fase 6 ditandai SELESAI).
- Backup pre-Fase 6: `.bak-20261110-fallback/` (`loop.ts`,
  `tool-orchestrator.ts`, `UNIVERSAL-RUNTIME-AUDIT.md`).
- TIDAK diubah: `src/agent/tools.ts`, `src/agent/prompt.ts`,
  `src/agent/modes.ts`, `src/agent/xml-parser.ts`, `src/api.ts`,
  `src/ui/ChatApp.tsx`, `src/agent/model-adapter.ts`,
  `src/agent/model-capabilities.ts`, `src/agent/tool-registry.ts`,
  panel, production, database, TUI.

## 9. Status akhir

Fase 6 SELESAI dan teruji. Protokol fallback kini formal: dokumen
protokol, routing berbasis capability (UNKNOWN tidak pernah
dianggap SUPPORTED), aturan 2x dengan pesan eksplisit ke user,
dan ledger yang hanya mencatat eksekusi nyata — tanpa mengubah
tag XML, mode CLI, TUI, atau panel. Belum commit/publish — tunggu
gaz Reza. JANGAN lanjut ke Fase 7 (Context & Streaming
Integration) sebelum Reza memberi perintah.
