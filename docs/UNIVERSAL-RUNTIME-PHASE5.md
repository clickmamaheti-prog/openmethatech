# MethaTech Universal Agent Runtime — FASE 5: Universal Agent Loop

**Tanggal:** 2026-11-10
**Status:** SELESAI, teruji, TIDAK commit/publish/deploy. HEAD tetap `b384284` (0.1.8).
**Repo:** `~/workspace/metatech-cli/` (working tree 0.1.9 §4j–§4q + Fase 1 audit + Fase 3 registry + Fase 2 adapter + Fase 4 orchestrator + Fase 5 ini).
**Referensi:** `docs/UNIVERSAL-RUNTIME-AUDIT.md` (Fase 1 + koreksi roadmap), `docs/UNIVERSAL-RUNTIME-PHASE2.md` (adapter), `docs/UNIVERSAL-RUNTIME-PHASE3.md` (registry), `docs/UNIVERSAL-RUNTIME-PHASE4.md` (orchestrator), spek Universal Runtime §6 + Keputusan Reza 2026-11-10 + Klarifikasi Reza 2026-11-10.
**Backup pre-Fase 5:** `.bak-20261110-loop/` (`loop.ts`, `model-adapter.ts`, `UNIVERSAL-RUNTIME-AUDIT.md`).

## 0. Keputusan yang mengikat fase ini

### 0.1 Roadmap asli (mengikat — koreksi Reza 2026-11-10)

Ikuti roadmap Universal Agent Runtime yang sudah disusun sejak awal.
Jangan mengubah urutan, nama, tujuan, atau cakupan fase berdasarkan
asumsi sendiri. **Fase 4 = Universal Tool Orchestrator. Fase 5 =
Universal Agent Loop.** Native Tool Calling BUKAN alasan untuk
mengubah definisi atau urutan Fase 5.

Koreksi yang diterapkan di fase ini: dokumen audit Fase 1 (§0 tabel
dan §9) serta komentar source Fase 2–4 sempat menyebut native tool
calling sebagai "pekerjaan Fase 5" — itu usulan urutan audit yang
SUDAH DIBATALKAN oleh koreksi Reza. Di fase ini semua rujukan itu
diperbaiki: native `tools` adalah pekerjaan fase berikutnya
(penempatannya diputuskan Reza), BUKAN Fase 5. Guard fail-loud
adapter tetap berlaku; tidak ada perilaku yang berubah karenanya.

### 0.2 Keputusan Reza 2026-11-10 (tetap berlaku)

1. Confirmation gate HANYA untuk tool kritis + flag `--yolo` (gate di Fase 8).
2. Capability registry di CLI dulu, status SUPPORTED / UNSUPPORTED / UNKNOWN.
3. Runtime TETAP lokal di CLI; panel tetap relay.
4. Live probe SUBSET (10 free + Sonnet + Opus + 1 per provider lain) — Fase 9.
5. Paralel hanya read-only tanpa dependency; mutasi sekuensial.

### 0.3 Klarifikasi Reza 2026-11-10 (permission vs risk, tetap berlaku)

Permission dan risk DIBEDAKAN. `run_terminal_command` (critical)
WAJIB gate; `write_file` (high) WAJIB konfirmasi saat gate
diimplementasikan; `str_replace` (high) dievaluasi dari cakupan
perubahan + risk metadata; `write_todos` dan `skill` mengikuti risk
+ permission masing-masing. `--yolo` boleh melewati konfirmasi
interaktif, tapi TIDAK BOLEH melewati sandbox, security policy,
validasi input, atau perlindungan kredensial. Gate TIDAK
diimplementasikan di fase ini (Fase 8).

### 0.4 Ketentuan implementasi Fase 5 (dari perintah Reza)

- Kembangkan agent loop agar bekerja MELALUI kontrak adapter dan
  orchestrator yang sudah tersedia.
- Pertahankan kompatibilitas seluruh provider yang sudah berjalan.
- Pertahankan XML tool calling. Jangan asumsikan semua model
  mendukung native tool calling.
- Pertahankan streaming, Thinking, Ctrl+C, context percakapan, dan
  mekanisme interaksi CLI yang sudah ada.
- Jangan membuat handler tool baru. Jangan mengubah mode CLI,
  tampilan TUI, atau perilaku konfirmasi. Jangan menambahkan Ask,
  YOLO, `--yolo`, atau workflow baru yang tidak ada dalam spesifikasi.
- Jangan mengubah panel atau production.
- Jangan mengimplementasikan pekerjaan yang sebenarnya merupakan
  bagian dari fase berikutnya (bukan Fase 6, bukan Fase 7, bukan
  Fase 8).

## 1. Audit sebelum implementasi (apa yang SUDAH tersedia)

Audit dilakukan dengan membaca source aktual + grep verifikasi.
Kesimpulan audit: loop SUDAH bekerja melalui kedua kontrak sejak
Fase 2 dan Fase 4 — Fase 5 adalah konsolidasi + penutupan celah,
bukan pembangunan ulang.

### 1.1 Jalur model: sudah melalui adapter

| Pemanggil model | Jalur | Status |
|---|---|---|
| `runAgentLoop` (satu-satunya jalur kirim chat) | `collectChatText(adapter)` → `adapter.chat` | Sudah adapter (Fase 2) |
| `/compact` (`ChatApp.tsx:1029`) | `collectChatText(createDefaultAdapter())` | Sudah adapter (Fase 2) |
| `streamChat` (`src/api.ts:243`) | Hanya dipanggil `PanelChatAdapter` | Satu-satunya pemanggil transport |

Grep `streamChat` di `src/` (di luar definisi + komentar):
satu-satunya pemanggil adalah `PanelChatAdapter`
(`model-adapter.ts:237`). Tidak ada jalur pintas transport.

### 1.2 Jalur tool: sudah melalui orchestrator

| Pemanggil tool | Jalur | Status |
|---|---|---|
| `runAgentLoop` | `executeToolCalls` (satu batch per step) | Sudah orchestrator (Fase 4) |
| `executeToolCall` (`tools.ts:673`) | — | TIDAK ADA pemanggil produksi (hanya `test/agent.test.mjs` sebagai seam pengujian handler). Dibiarkan apa adanya: menghapusnya memaksa penulisan ulang test handler tanpa manfaat loop. |
| Pesan `role: "tool"` | Hanya `resultToToolMessage` (`tool-orchestrator.ts:314`) | Satu-satunya produsen |

Grep `role: "tool"` di `src/`: satu-satunya produsen adalah
`resultToToolMessage`. Format history tidak berubah di fase ini.

### 1.3 Celah yang ditemukan audit (inilah pekerjaan Fase 5)

1. **Loop membangun adapter sendiri** (`loop.ts`: `createDefaultAdapter()`
   di dalam `runAgentLoop`). Loop bergantung pada konstruktor konkret,
   bukan pada kontrak `ModelAdapter` — mock adapter tidak bisa
   diinjeksikan, dan loop tidak bisa diuji melalui kontrak adapter.
2. **Tidak ada bukti tidak-duplikasi.** Satu parsed call dieksekusi
   tepat sekali oleh konstruksi (satu `executeToolCalls` per step),
   tapi tidak ada pencatatan maupun test yang membuktikannya — retry /
   nudge / guard path tidak pernah diaudit terhadap eksekusi ganda.
3. **Komentar + dokumen usang** menyebut native tool calling sebagai
   "Fase 5" (audit §0/§9, `model-adapter.ts`, `tool-registry.ts`,
   `tool-orchestrator.ts`, `model-capabilities.ts`, PHASE2/PHASE3
   docs) — bertentangan dengan koreksi roadmap yang mengikat.
4. **Tidak ada kontrak loop yang tertulis.** Aturan turn (siklus,
   guard, format history, penanganan error) tersebar di komentar
   `loop.ts` tanpa satu pernyataan kontrak yang bisa diuji.

Bukan celah (dicatat, tidak dikerjakan — di luar cakupan Fase 5):
- **Usage per step tidak sampai ke footer TUI.** `collectChatText`
  mengembalikan `usage`, tapi loop mengabaikannya; `setLastUsage` di
  `ChatApp.tsx` tidak pernah diisi nilai non-null di mode agent.
  Ini follow-up yang sudah dicatat sebelumnya (per-step usage/cost
  surfacing), bukan regresi Fase 2/5 — perilaku sama sebelum dan
  sesudah fase ini. Bukan pekerjaan Fase 5.
- **Retry policy model call** (Fase 7), **token budgeting /
  auto-compaction** (Fase 7), **gate / validasi shell / secret
  redaction / audit log** (Fase 8), **formalisasi protokol XML**
  (Fase 6), **native `tools`** (fase berikutnya).

## 2. Yang dibangun

### 2.1 Injeksi adapter ke loop (`src/agent/loop.ts`)

`AgentLoopOptions` mendapat field baru:

```ts
adapter?: ModelAdapter;
```

`runAgentLoop` memakai `opts.adapter ?? createDefaultAdapter()`.
Opsi `callModel` yang lama tetap ada sebagai test seam dan tetap
didahulukan bila diberikan (kompatibilitas dengan test yang sudah
ada). TUI tidak mengubah apa pun — ia tidak mengoper adapter dan
mendapat adapter relay panel seperti sebelumnya.

Dampak: loop kini bergantung pada interface `ModelAdapter`, bukan
pada konstruktor konkret. Mock adapter bisa menggerakkan loop tanpa
jaringan dan tanpa memalsukan modul transport — pola yang sama
dengan injeksi transport di `PanelChatAdapter` (konvensi Freebuff
AGENTS.md: prefer dependency injection).

### 2.2 Execution ledger (`src/agent/loop.ts`)

`AgentLoopResult` mendapat field baru:

```ts
executedToolCalls: ExecutedToolCall[]; // { step, index, tool, ok, durationMs }
```

Satu entri per tool call yang benar-benar dieksekusi turn ini,
dalam urutan eksekusi. Kunci `(step, index)` unik dalam satu turn:
ledger membuktikan satu parsed call = tepat satu eksekusi — bila
sebuah call pernah dieksekusi dua kali, daftar ini menampilkan
kunci duplikat. Repeat yang sah (tool + argumen sama di step
berikutnya) adalah kunci berbeda dan tetap dieksekusi normal;
ledger tidak mendedupe.

Ledger diisi di semua jalur keluar loop, termasuk early return
(failed-edit guard, ask_user, todo-loop stop) — diuji eksplisit
(§4, test ask_user).

### 2.3 Kontrak loop tertulis (`src/agent/loop.ts` header)

Header `loop.ts` ditulis ulang sebagai pernyataan kontrak Universal
Agent Loop: dua dependensi kontrak (ModelAdapter + Tool
Orchestrator + Registry sebagai pembaca klasifikasi), siklus satu
turn, dan invarian yang dijamin loop (satu eksekusi per call,
format history, error provider mengakhiri step bukan sesi, error
tool adalah result di channel yang sama, abort = "interrupted by
user") — beserta daftar non-goal eksplisit (tanpa native tools,
tanpa retry, tanpa budgeting/compaction, tanpa gate/Ask/YOLO/
`--yolo`, tanpa tool baru, tanpa perubahan mode/TUI/panel).

### 2.4 Koreksi rujukan "Fase 5 = native" (komentar + dokumen)

Semua rujukan yang menyebut native tool calling sebagai pekerjaan
Fase 5 diperbaiki menjadi "a later phase (NOT Fase 5)":

- `src/agent/model-adapter.ts` — header, komentar `tool_call`,
  komentar field `tools`/`toolChoice`, komentar fail-loud, pesan
  error fail-loud (`"native tools are not wired yet (a later phase,
  not Fase 5)"`), komentar `collectChatText`. Guard fail-loud
  sendiri TIDAK berubah (test yang menegaskan `/not wired yet/`
  tetap hijau).
- `src/agent/tool-registry.ts` — komentar versi registry,
  komentar `OpenAiFunctionTool` + `toOpenAiFunction`.
- `src/agent/tool-orchestrator.ts` — komentar field `content`.
- `src/agent/model-capabilities.ts` — komentar
  `isCapabilityProven`.
- `docs/UNIVERSAL-RUNTIME-AUDIT.md` — §0 tabel urutan (baris 3)
  dan §9 bagian Fase 5 ditulis ulang ke definisi yang benar
  (Universal Agent Loop; native path = fase berikutnya,
  penempatan diputuskan Reza).
- `docs/UNIVERSAL-RUNTIME-PHASE2.md` dan
  `docs/UNIVERSAL-RUNTIME-PHASE3.md` — catatan koreksi di §0
  masing-masing (riwayat fase tidak ditulis ulang; rujukan
  "Fase 5 (native)" di badan dokumen dinyatakan superseded).
- `docs/UNIVERSAL-RUNTIME-PHASE4.md` — satu baris (§"Tidak
  diubah": fail-loud "Itu pekerjaan Fase 5") diperbaiki menjadi
  fase berikutnya.

### 2.5 Yang TIDAK diubah

- Jalur XML tidak berubah (tag, alias, parser, nudge, retry sama persis).
- Mode CLI tidak berubah; tampilan TUI tidak berubah; perilaku
  konfirmasi tidak berubah; tidak ada Ask / YOLO / `--yolo` /
  confirmation workflow baru.
- Tidak ada handler tool baru atau yang ditulis ulang; `tools.ts`
  TIDAK disentuh; `executeToolCall` yang sudah tidak dipakai
  produksi dibiarkan sebagai seam pengujian handler.
- Native `tools` tetap TIDAK dikirim; adapter tetap menolak
  fail-loud bila ada request membawa tools.
- Tidak ada perubahan panel / production / database.
- Tidak ada retry policy (Fase 7), token budgeting / auto-compaction
  (Fase 7), gate / validasi shell / secret redaction / audit log
  (Fase 8), formalisasi protokol fallback XML (Fase 6).

## 3. Arsitektur sebelum dan sesudah

### Sebelum (0.1.9 + Fase 2–4)

```
ChatApp.send()
  → runAgentLoop()
      ├─ adapter = createDefaultAdapter()      ← loop membangun sendiri
      ├─ callModel = collectChatText(adapter)  ← via adapter (Fase 2)
      ├─ parse XML → executeToolCalls(batch)   ← via orchestrator (Fase 4)
      └─ history: assistant raw + tool msgs   ← via resultToToolMessage
ChatApp /compact
  → collectChatText(createDefaultAdapter())    ← via adapter (Fase 2)
```

### Sesudah (Fase 5)

```
ChatApp.send()
  → runAgentLoop({ adapter? })                ← adapter DIINJEKSI (default: panel)
      ├─ adapter = opts.adapter ?? createDefaultAdapter()
      ├─ callModel = collectChatText(adapter)  ← via adapter (tidak berubah)
      ├─ parse XML → executeToolCalls(batch)   ← via orchestrator (tidak berubah)
      ├─ ledger: executedToolCalls[]          ← BARU (observability)
      └─ history: assistant raw + tool msgs   ← via resultToToolMessage (tidak berubah)
ChatApp /compact
  → collectChatText(createDefaultAdapter())    ← via adapter (tidak berubah)
```

Perubahan perilaku runtime: TIDAK ADA. Satu-satunya perubahan
fungsional adalah injeksi adapter (default identik dengan
sebelumnya) dan ledger eksekusi di hasil. Semua pesan, guard,
event, dan format history byte-identik.

## 4. Tes

### 4.1 Hasil aktual

| Suite | Hasil |
|---|---|
| `npx tsc --noEmit` | Bersih |
| `npm test` (unit) | **288/288** (279 sebelumnya + 9 baru di `test/agent-loop.test.mjs`) |
| `test/agent-pty.sh` | **32/32** |
| `test/tui-pty.sh` | **270/270** (captures di `/tmp/methatech-tui-pty`) |

### 4.2 Test baru (`test/agent-loop.test.mjs`, 9 test)

`MockAdapter` — implementasi `ModelAdapter` scripted (langkah
berupa `{ chunks }` atau `{ error }`, request dicatat dengan
snapshot messages) — membuktikan loop bekerja melalui kontrak
adapter tanpa jaringan dan tanpa memalsukan modul transport.

| Test | Yang dibuktikan |
|---|---|
| model requests go through the injected adapter | 1 panggilan adapter, model + messages benar, `tools` tidak dikirim |
| streaming text + reasoning deltas flow through the adapter | Event text/reasoning berurutan, `finalText` utuh |
| provider error mid-turn keeps history intact and the session resumable | Step 2 gagal → `model call failed: panel down`, history utuh (tool message berisi isi file), ledger 1 entri; turn baru dari history itu lanjut sampai selesai |
| tool error is a result on the same channel | `read_files` file hilang → tool message `ok:false` + pesan `[TOOL_CALL_ERROR]`, turn selesai di step berikut |
| pre-aborted signal stops the turn without calling the model | `interrupted by user`, 0 step, 0 panggilan adapter, history system+user saja |
| abort mid-stream interrupts the turn | Abort di tengah stream → `interrupted by user`, history utuh |
| no duplicate tool execution | 2 call yang sama di 2 step → ledger 4 entri kunci unik `1:0,1:1,2:0,2:1`, 4 tool message `call-1-0…call-2-1`, 4 event `tool_result`, isi file muncul 2x (kedua eksekusi benar-benar jalan) |
| history format is unchanged | Urutan roles persis `[system,user,assistant,tool,system,assistant,tool]`, assistant menyimpan teks mentah ber-tag XML, pesan step-2 `[step 2]`, tool message `{tool,ok,output}` + `name` + `tool_call_id` `call-1-0`, task_completed juga meninggalkan tool message `call-2-0` |
| execution ledger is present on early returns (ask_user) | Early return ask_user tetap membawa ledger (1 entri) + `askUserQuestions` |

### 4.3 Catatan jujur: dua kegagalan awal adalah kesalahan saya di test, bukan regresi

1. Test format history: ekspektasi urutan roles saya lupa bahwa
   `task_completed` sendiri adalah tool call yang meninggalkan
   tool message — urutan benar 7 elemen, bukan 6. Diperbaiki di
   test saja.
2. Test injeksi adapter: mock mencatat referensi `messages` hidup,
   yang loop mutasi sesudah call (append assistant message) —
   snapshot di mock harus menyalin array. Diperbaiki di test saja
   (snapshot di `MockAdapter.chat`).

Tidak ada kode produksi yang diubah untuk meloloskan test.

## 5. Kompatibilitas fitur lama

| Fitur | Status |
|---|---|
| XML tool calling (tag, alias, nudge, retry) | Tidak berubah; agent-pty 32/32 + tui-pty 270/270 hijau |
| Mode CLI (DEFAULT/LITE/MAX/PLAN) | Tidak berubah |
| Streaming, Thinking, Ctrl+C | Tidak berubah; dibuktikan test streaming + abort |
| Context percakapan antar turn | Tidak berubah; dibuktikan test resumable + format history |
| `/compact` | Tidak berubah; tetap via adapter |
| `callModel` seam lama | Tetap didahulukan bila diberikan; test lama yang memakainya hijau |
| 11 tool + handler | Tidak berubah; `tools.ts` tidak disentuh |
| Panel / production | Tidak berubah |

## 6. Temuan dan pekerjaan yang masih tertunda

### 6.1 Temuan keamanan shell — status TERBUKA (Fase 8)

Tidak berubah di fase ini dan TIDAK dianggap selesai karena Fase 5
lulus pengujian. Fakta (audit Fase 2 §4, dicatat lengkap di
PHASE4 §5): shell `spawn("bash", ["-c", ...])` hanya me-sandbox
`cwd` awal; isi perintah tidak divalidasi; model bisa membaca file
kredensial (`~/.config/metatech/credentials.json`, `~/.ssh`,
`.env`), `env`, eksfiltrasi via `curl`, `rm -rf ~`, `>> ~/.bashrc`;
aturan prompt adalah instruksi ke model, BUKAN enforcement.
**Dampak Fase 5 terhadap risiko ini: NOL** — loop tidak menyentuh
eksekusi tool; `tools.ts` tidak diubah; tidak ada jalur shell baru.
Mitigasi (validasi shell, secret redaction, audit log, gate) tetap
jatah Fase 8.

### 6.2 Tertunda (bukan Fase 5)

- **Native tool calling** — fase berikutnya, penempatan diputuskan
  Reza. Adapter sudah membawa kontrak (`tools`, `toolChoice`,
  chunk `tool_call`) dan registry sudah membawa konverter
  (`toOpenAiFunction`); yang belum ada: pengirim `tools`,
  parser `delta.tool_calls`, routing per capability, normalisasi
  history native vs XML. Validasi live per channel tetap
  dibutuhkan sebelum klaim apa pun (Fase 9).
- **Formalisasi protokol fallback XML** — Fase 6.
- **Retry policy, token budgeting, auto-compaction** — Fase 7.
- **Gate, validasi shell, secret redaction, audit log** — Fase 8.
- **Per-step usage/cost surfacing ke footer TUI** — follow-up
  lama (usage dikumpulkan adapter tapi loop mengabaikannya).
- **`executeToolCall` (`tools.ts`) tanpa pemanggil produksi** —
  dibiarkan sebagai seam pengujian handler; bila suatu hari
  dihapus, test handler di `agent.test.mjs` harus dipindah ke
  orchestrator.
- **History tool-call lama saat pindah jalur** — bila jalur native
  aktif nanti, pasangan tool-call/result XML lama (id sintetis
  `call-{step}-{index}`) tidak cocok dengan format native
  provider; perlu normalisasi atau pembuangan saat pindah jalur
  (keputusan desain fase native).

## 7. Status kesiapan Fase 6 (Fallback Tool Protocol)

**SIAP.** Prasyarat Fase 6 sudah terpenuhi:

- Loop bekerja melalui adapter + orchestrator dengan ledger
  eksekusi (fase ini) — protokol fallback diformalkan di atas
  jalur yang sama tanpa mengubah loop.
- Registry Fase 3 sudah membawa JSON Schema untuk validasi
  setiap call XML (validator sudah dipakai orchestrator).
- Parser XML + alias + nudge + retry sudah ada dan teruji
  (agent-pty 32/32); Fase 6 tinggal memformalkan: dokumen
  protokol, validasi schema untuk SETIAP call XML, dan pesan
  gagal eksplisit bila model 2x tidak mengikuti protokol.
- Yang BELUM diputuskan dan bukan prasyarat teknis: ambang
  "2x gagal → hentikan dengan pesan eksplisit" vs perilaku
  sekarang (nudge max 2x lalu turn berakhir) — tetap mengikuti
  spek §5/§6 Fase 6.

## 8. File

- DIUBAH: `src/agent/loop.ts` (injeksi adapter, execution ledger,
  header kontrak), `src/agent/model-adapter.ts` (koreksi komentar
  "Fase 5 = native"), `src/agent/tool-registry.ts` (koreksi
  komentar), `src/agent/tool-orchestrator.ts` (koreksi komentar),
  `src/agent/model-capabilities.ts` (koreksi komentar),
  `docs/UNIVERSAL-RUNTIME-AUDIT.md` (§0 + §9 definisi Fase 5
  yang benar), `docs/UNIVERSAL-RUNTIME-PHASE2.md` (catatan
  koreksi), `docs/UNIVERSAL-RUNTIME-PHASE3.md` (catatan koreksi),
  `docs/UNIVERSAL-RUNTIME-PHASE4.md` (satu baris).
- BARU: `test/agent-loop.test.mjs` (9 test, MockAdapter),
  `docs/UNIVERSAL-RUNTIME-PHASE5.md` (dokumen ini).
- Backup pre-Fase 5: `.bak-20261110-loop/` (`loop.ts`,
  `model-adapter.ts`, `UNIVERSAL-RUNTIME-AUDIT.md`).
- TIDAK diubah: `src/agent/tools.ts`, `src/agent/prompt.ts`,
  `src/agent/modes.ts`, `src/agent/xml-parser.ts`, `src/api.ts`,
  `src/ui/ChatApp.tsx`, panel, production, database, TUI.

## 9. Status akhir

Fase 5 SELESAI dan teruji. Loop kini bekerja melalui kontrak
adapter dan orchestrator dengan ledger eksekusi dan kontrak
tertulis, tanpa perubahan perilaku runtime. Belum commit/publish —
tunggu gaz Reza. JANGAN lanjut ke Fase 6 (Fallback Tool Protocol)
sebelum Reza memberi perintah.
