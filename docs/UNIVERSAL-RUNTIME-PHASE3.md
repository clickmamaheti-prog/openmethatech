# MethaTech Universal Agent Runtime — FASE 3: Formal Tool Registry

**Tanggal:** 2026-11-10
**Status:** SELESAI, teruji, TIDAK commit/publish/deploy. HEAD tetap `b384284` (0.1.8).
**Repo:** `~/workspace/metatech-cli/` (working tree 0.1.9 §4j–§4q + Fase 3 ini).
**Referensi:** `docs/UNIVERSAL-RUNTIME-AUDIT.md` (Fase 1), spek Universal Runtime §7 + Keputusan Reza 2026-11-10.

**KOREKSI 2026-11-10 (Fase 5):** rujukan "Fase 5" di dokumen ini
yang menyangkut native tool calling (konverter `toOpenAiFunction`
"dipakai Fase 5") adalah usulan urutan audit yang SUDAH DIBATALKAN
oleh koreksi roadmap Reza — native tool calling BUKAN Fase 5
(Fase 5 = Universal Agent Loop, docs/UNIVERSAL-RUNTIME-PHASE5.md),
melainkan pekerjaan fase berikutnya; konverter tetap data turunan
tanpa perilaku. Riwayat fase ini tidak ditulis ulang; hanya
penamaan fase yang dikoreksi.

## 0. Keputusan Reza 2026-11-10 (mengikat seluruh proyek Universal Runtime)

1. **Confirmation gate HANYA untuk tool kritis, dengan opsi `--yolo`.**
   Read-only tanpa konfirmasi. Operasi ubah/hapus file butuh permission
   sesuai tingkat risiko. Destructive shell WAJIB confirmation gate.
   `--yolo` boleh melewati konfirmasi interaktif untuk workflow otomatis,
   tetapi TIDAK BOLEH melewati security policy, sandbox restriction,
   validasi input, atau perlindungan credential. Jangan semua tool minta
   konfirmasi.
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

## 1. Yang dibangun

### 1.1 Modul baru: `src/agent/tool-registry.ts`

Registry formal untuk ke-11 tool yang sudah ada. Registry adalah
SUMBER KEBENARAN untuk metadata; handler eksekusi TIDAK ditulis ulang
— setiap entri mereferensikan handler yang sudah ada di `tools.ts`
(`allToolDefinitions()`). Deskripsi juga direferensikan dari factory,
bukan diduplikasi, supaya tidak ada drift dua sumber.

Setiap entri `RegisteredTool`:

| Field | Isi |
|---|---|
| `id` / `name` | Unique ID = nama tool (nama unik dijamin factory + test) |
| `description` | Deskripsi model (dari factory) |
| `inputSchema` | JSON Schema (bentuk MCP: `{type:'object', properties, required}`) |
| `outputSchema` | JSON Schema hasil `{ok, output, askUserQuestions?}` |
| `permission` | `read` \| `write` \| `execute` \| `ask` |
| `risk` | `low` \| `medium` \| `high` \| `critical` |
| `effect` | `read-only` \| `mutating` |
| `category` | `filesystem` \| `shell` \| `search` \| `state` \| `control` \| `interaction` \| `knowledge` |
| `requiresConfirmation` | Diturunkan: `true` tepat saat `risk === "critical"` |
| `timeoutMs` / `maxTimeoutMs` | Timeout eksekusi (shell: default 120.000, max 600.000) |
| `outputLimitChars` | 50.000 untuk semua (TOOL_OUTPUT_LIMIT) |
| `maxResults` / `maxLinesPerFile` | Batas hasil (glob 200, code_search 50, read_files 2000 baris/file) |
| `endsAgentStep` | Dari factory (hanya `skill`) |
| `handler` | Handler yang sudah ada di `tools.ts` |

`REGISTRY_VERSION = 1` (bump saat field ditambah/diubah — Fase 2/5
mendeteksi registry usang).

Fail-fast: registry dibangun lazy + cached; bila ada factory tool
tanpa metadata, atau metadata tanpa factory, `listRegisteredTools()`
throw dengan pesan jelas. Inkonsistensi registry tidak pernah diam-diam.

### 1.2 Klasifikasi 11 tool (Keputusan 1 + 5)

| Tool | Permission | Risk | Effect | Category | Gate? |
|---|---|---|---|---|---|
| `read_files` | read | low | read-only | filesystem | tidak |
| `list_directory` | read | low | read-only | filesystem | tidak |
| `glob` | read | low | read-only | search | tidak |
| `code_search` | read | low | read-only | search | tidak |
| `str_replace` | write | high | mutating | filesystem | tidak |
| `write_file` | write | high | mutating | filesystem | tidak |
| `run_terminal_command` | execute | critical | mutating | shell | **YA** |
| `write_todos` | write | low | mutating | state | tidak |
| `task_completed` | read | low | read-only | control | tidak |
| `ask_user` | ask | low | read-only | interaction | tidak |
| `skill` | read | medium | read-only | knowledge | tidak |

Catatan klasifikasi:

- **Hanya `run_terminal_command` yang kritis** — satu-satunya tool
  yang menjalankan perintah arbitrer pilihan model. Gate konfirmasi
  untuknya adalah hook Fase 8; fase ini hanya membawa metadata.
- **`write_file` / `str_replace` = high, bukan critical.** Operasi
  tulis file butuh permission `write` + enforcement toolset mode
  (PLAN mencabut ketiganya), tapi TIDAK masuk gate di fase ini —
  sesuai keputusan: gate hanya untuk kritis. Bila Reza nanti
  menaikkan file-write ke critical, cukup ubah satu field `risk`.
- **`skill` = medium**, bukan low: isi SKILL.md masuk ke prompt model
  (permukaan prompt-injection dari file lokal) + flag
  `disable-model-invocation` dihormati handler.
- **`write_todos` = mutating** walau hanya state in-memory: urutan
  panggilan berpengaruh pada isi list, jadi orchestrator Fase 4
  harus menjalankannya sekuensial.
- **`task_completed` = permission `read`** (level terendah, tanpa efek
  samping) dengan category `control` yang membedakannya.

### 1.3 Validasi input terhadap JSON Schema

`validateToolInput(entry, input): string | null` — validator subset
JSON Schema tanpa dependensi Zod: `type`, `required`, `properties`,
`items`, `minLength`, `minItems`, `minimum`, `maximum`, `enum`,
`additionalProperties`.

Aturan yang disengaja (supaya perilaku tidak berubah):

- Menolak HANYA yang sudah ditolak handler: param wajib hilang,
  tipe salah. Kunci ekstra yang tidak dikenal DIABAIKAN (handler
  juga mengabaikannya).
- Alias `str_replace` (`old`/`old_str`/`old_string`,
  `new`/`new_str`/`new_string`/`replacement`, lift top-level)
  LULUS validasi schema — schema mendokumentasikan bentuk kanonik,
  handler alias-aware tetap menjadi penegak alias.
- Error dikembalikan sebagai **tool error result** di jalur yang sama
  dengan error validasi handler — model bisa memperbaiki dan retry,
  bukan crash.

### 1.4 Wiring minimal ke loop (`src/agent/loop.ts`)

Satu-satunya file yang diubah selain registry baru. Empat perubahan,
semuanya klasifikasi/validasi, TIDAK ada perubahan perilaku jalur XML:

1. Validasi schema SEBELUM `executeToolCall` — gagal validasi jadi
   `{ok:false, output}` lewat jalur hasil yang sama (termasuk
   penghitung failed-edit untuk file-edit tools).
2. Guard failed-edit memakai `isFileEditTool(name)` dari registry,
   bukan cek nama `str_replace`/`write_file` hardcoded.
3. `endsAgentStep` dibaca dari registry (`getRegisteredTool(name)`),
   bukan `toolDefinitionsFor`.
4. Catatan todo-loop recovery memakai `toolNames.some(isFileEditTool)`,
   bukan `toolSet.has("write_file") || toolSet.has("str_replace")`.

`tools.ts` TIDAK diubah (handler + deskripsi + `toolPreview` tetap).
`prompt.ts` TIDAK diubah (deskripsi tool di prompt tetap dari factory,
yang sama dengan yang direferensikan registry). `modes.ts` TIDAK
diubah (PLAN enforcement tetap di toolset mode). Tidak ada perubahan
panel, database, atau TUI.

### 1.5 Konverter format native (Fase 5)

`toOpenAiFunction(entry)` mengubah entri registry ke format function
tool OpenAI `{type:"function", function:{name, description,
parameters}}` — bentuk yang sudah diterima relay panel (audit §4).
Ini data turunan, tanpa perilaku: CLI belum mengirim `tools` — Fase 5
yang memasang jalur native di samping XML.

## 2. Yang TIDAK diubah / TIDAK dilakukan di fase ini

- **Jalur XML tool calling TIDAK berubah**: tag
  `<codebuff_tool_call>` + alias `<codex_tool_call>`, parser,
  nudge, error retry — semuanya sama persis. Bukti: `test/agent-pty.sh`
  32/32 dan `test/tui-pty.sh` 270/270 tetap hijau.
- **Fallback lama TIDAK dihapus.** Tidak ada jalur yang dimatikan.
- **Confirmation gate TIDAK diimplementasikan** — hanya metadata
  `requiresConfirmation`. Gate + flag `--yolo` adalah pekerjaan Fase 8.
  `--yolo` dicatat sebagai item Fase 8, bukan di fase ini.
- **Tidak ada tool baru.** Tidak ada duplikasi tool (`propose_*`,
  `apply_patch`, `web_search`, dsb. tetap TIDAK dibuat).
- **Tidak ada perubahan panel / production / database.**
- **Tidak ada perubahan perilaku eksekusi**: timeout shell, cap
  output, sandbox `resolveInside`, dan semua batas handler tetap
  seperti sebelumnya.

## 3. Tes

| Tes | Hasil |
|---|---|
| `npx tsc` | bersih |
| `npm test` (unit) | **237/237** (225 sebelumnya + 12 test registry baru) |
| `bash test/agent-pty.sh` | **32/32** |
| `bash test/tui-pty.sh` | **270/270** |

Test baru `test/tool-registry.test.mjs` (12 test):

- Registry berisi tepat 11 tool, id/nama unik.
- Setiap tool cocok dengan factory (deskripsi sama, handler terbukti
  bekerja lewat eksekusi `read_files` nyata di temp dir).
- Setiap tool punya metadata lengkap (schema, permission, risk,
  effect, category, handler, output cap 50.000).
- Klasifikasi sesuai Keputusan 1: read-only 7, mutating 4, gate
  hanya `run_terminal_command`; file-write high bukan critical.
- `isFileEditTool` tepat `str_replace` + `write_file`.
- Timeout/limit cocok dengan handler (shell 120.000/600.000,
  read_files 2000 baris, glob 200, code_search 50).
- Input valid lolos untuk ke-11 tool; 16 kasus input tidak valid
  gagal dengan pesan yang tepat (wajib hilang, tipe salah, minLength,
  minimum/maximum).
- Alias `str_replace` + lift top-level lolos validasi; kunci ekstra
  diabaikan.
- `toOpenAiFunction` menghasilkan bentuk function-tool relay.
- Loop: panggilan schema-invalid jadi tool error result (bukan crash),
  panggilan schema-valid tetap mengeksekusi lewat jalur XML.

Catatan pengujian jujur:

- Dua kegagalan awal adalah kesalahan SAYA di test/validator, bukan
  regresi: (1) `apiKey: <redacted>` tertulis mentah tanpa string di
  file test (placeholder dari pola test lama) — diperbaiki jadi
  `"test"` + koma; (2) validator tidak meneruskan path ke error
  nested — dirapikan jadi `typeDetail` + `validateValue` /
  `validateObject` dengan path penuh (`todos[0].task`); (3) assertion
  identitas handler gagal karena factory membuat closure baru tiap
  `allToolDefinitions()` dipanggil — diganti cek perilaku. Semua
  diperbaiki sebelum run hijau final; tidak ada kode produksi yang
  diubah untuk meloloskan test.

## 4. File yang dibuat / diubah

| File | Perubahan |
|---|---|
| `src/agent/tool-registry.ts` | BARU (~600 baris): registry, schema, validator, helper klasifikasi, `toOpenAiFunction` |
| `src/agent/loop.ts` | Wiring minimal (import registry, validasi pre-eksekusi, 3 klasifikasi dari registry) |
| `test/tool-registry.test.mjs` | BARU (12 test) |
| `docs/UNIVERSAL-RUNTIME-PHASE3.md` | BARU (dokumen ini) |
| `docs/UNIVERSAL-RUNTIME-AUDIT.md` | Tambah Keputusan Reza 2026-11-10 + tandai Fase 3 SELESAI |

Backup pre-Fase 3: `.bak-20261110-registry/` (`loop.ts`,
`UNIVERSAL-RUNTIME-AUDIT.md`). `tools.ts` tidak disentuh sehingga
tidak perlu backup.

## 5. Hook untuk fase berikutnya

- **Fase 2 (adapter + capability registry):** pola registry ini
  dipakai ulang untuk `ModelCapabilities` (status SUPPORTED /
  UNSUPPORTED / UNKNOWN per model, diisi probe live — Keputusan 2).
  `toOpenAiFunction` dipakai Fase 5 untuk mengirim `tools`.
- **Fase 4 (orchestrator):** baca `effect` (paralel hanya read-only
  tanpa dependency; mutasi sekuensial — Keputusan 5) dan
  `permission` + `requiresConfirmation` sebelum eksekusi.
- **Fase 8 (security):** implementasikan confirmation gate untuk
  `requiresConfirmation === true` + flag `--yolo` (lewati prompt
  interaktif SAJA, tidak pernah lewati policy/sandbox/validasi/
  credential). Shell validation + secret redaction + audit log juga
  Fase 8.
- **Fase 9 (probe live):** subset Keputusan 4 (10 free + Sonnet +
  Opus + 1 per provider lain); hasil probe mengisi capability
  registry, bukan asumsi dari nama model.

## 6. Status akhir

Fase 3 SELESAI. Registry formal 11 tool sudah jadi sumber kebenaran
metadata (schema, permission, risk, read-only/mutating, timeout,
limit), ter-wire minimal ke loop, teruji penuh, dan TIDAK mengubah
perilaku XML yang sudah terbukti jalan. Belum commit/publish — tunggu
gaz Reza. JANGAN lanjut ke Fase 2/5 sebelum Reza memberi perintah.

## 7. Klarifikasi 2026-11-10 (dicatat saat Fase 2 — riwayat Fase 3 di atas tidak ditulis ulang)

Reza mengklarifikasi bahwa **permission dan risk adalah sumbu yang
berbeda**, dan konfirmasi mengikuti RISK. Akibatnya metadata konfirmasi
Fase 3 diperbaiki di Fase 2 (bukan di fase ini):

- Fase 3: `requiresConfirmation` = true tepat saat risk "critical"
  (hanya `run_terminal_command`).
- Klarifikasi: `run_terminal_command` (critical) dan `write_file`
  (high, whole-file) = policy **"required"**; `str_replace` (high,
  spans) = policy **"scoped"** (gate Fase 8 mengevaluasi cakupan
  perubahan); sisanya **"none"**. `requiresConfirmation` kini berarti
  policy "required" atau "scoped".
- Alasannya: tidak semua mutating otomatis berbahaya (write_todos low),
  tidak semua mutating aman (write_file high), dan tidak semua read-only
  bebas risiko (skill medium) — tapi konfirmasi dikunci ke risk, bukan
  ke effect.
- Gate + `--yolo` tetap pekerjaan Fase 8 (belum diimplementasikan);
  `--yolo` tidak pernah melewati sandbox, security policy, validasi,
  atau perlindungan kredensial.
