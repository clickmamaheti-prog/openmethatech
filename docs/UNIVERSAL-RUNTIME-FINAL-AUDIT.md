# MethaTech Universal Agent Runtime — Final Audit (Fase 10)

**Tanggal:** 2026-11-10
**Status:** AUDIT PENUTUP — verifikasi independen terhadap source
code aktual, bukan sekadar ringkasan laporan fase sebelumnya.
**Repo:** `~/workspace/metatech-cli/`, HEAD `b384284` (0.1.8 live).
Working tree berisi 0.1.9 (§4j–§4q) + Universal Runtime Fase 1–9,
belum commit/publish/deploy. TIDAK ada commit/push/deploy dalam
Fase 10.
**Backup pre-Fase 10:** `.bak-20261110-phase10/` (54 file).
**Metode:** membaca dokumentasi Fase 1–9 + `docs/TOOL-CALL-
PROTOCOL.md`, lalu memverifikasi setiap klaim material terhadap
source code dengan grep dan pembacaan file, memeriksa ulang hasil
mentah probe Fase 9 (`~/workspace/phase9-probe-results/`, 87
baris), dan menjalankan ulang seluruh test suite.

**Aturan audit ini:** klaim yang tidak bisa diverifikasi dari
source atau bukti mentah ditandai eksplisit. Tidak ada hasil yang
diubah tanpa bukti baru. Dokumen fase historis TIDAK ditulis ulang
— koreksi dicatat di §7 sebagai temuan, bukan disembunyikan.

---

## §1. Ringkasan putusan

| Pertanyaan audit | Putusan |
|---|---|
| Apakah Fase 1–9 terimplementasi seperti yang dilaporkan? | **YA, dengan 2 temuan minor** (§7: `REGISTRY_VERSION` tidak di-bump; 1 baris stale di dokumen protokol — sudah diperbaiki di Fase 10). Tidak ada klaim material yang terbukti salah. |
| Apakah arsitektur konsisten (satu jalur runtime)? | **YA.** Satu adapter, satu registry, satu orchestrator, satu loop, satu protokol fallback — semuanya grep-terverifikasi (§3). |
| Apakah keamanan Fase 8 benar-benar enforcement? | **YA, dalam batas yang didokumentasikan.** 6 lapisan ada di kode dan teruji (59 tes). Batasan jujur di §5. Bukan pentest profesional. |
| Apakah hasil Fase 9 dapat dipercaya? | **YA.** Hasil mentah 87 baris cocok dengan laporan: native hanya Cohere, XML 12 model, 503 sistematis untuk `tools`, 3 model tidak teruji (§4). |
| Apakah ada bug kritis yang belum diselesaikan? | **TIDAK.** Tidak ada temuan kritis baru di Fase 10. Satu-satunya perbaikan kode di Fase 10: NOL — hanya dokumentasi. |
| Apakah runtime layak dinyatakan selesai? | **YA, dengan open items yang tercatat** (§6). Roadmap 10 fase ditutup berdasarkan bukti. Yang terbuka (gate, native loop path, re-probe) adalah pekerjaan fase berikutnya atas perintah Reza, bukan kegagalan roadmap ini. |

---

## §2. Status audit per fase

### Fase 1 — Architecture Audit: ✅ TERVERIFIKASI

- Dokumen `docs/UNIVERSAL-RUNTIME-AUDIT.md` (687 baris) dibaca
  penuh. Klaim-klaim kuncinya masih benar di tree final:
  transport provider-agnostic (satu endpoint OpenAI-compatible);
  native tool calling mungkin tanpa ubah panel (relay meneruskan
  `tools`); OpenTUI murni library TUI; MCP adopsi format/pola
  saja; capability detection tidak ada di mana pun saat itu.
- Koreksi roadmap Reza (Fase 4 = Orchestrator, Fase 5 = Loop)
  diterapkan konsisten di semua dokumen fase berikutnya dan di
  komentar source — grep `Fase 5` di `src/agent/*.ts` tidak
  menemukan lagi rujukan "Fase 5 = native" (hanya rujukan
  "Fase 5" sebagai Universal Agent Loop + catatan koreksi).
- Satu catatan: tabel urutan §0 sempat mengusulkan urutan
  berbeda dari spek — sudah dikoreksi di dokumen yang sama
  dengan catatan "KOREKSI URUTAN 2026-11-10". Riwayatnya
  dipertahankan, bukan dihapus. Benar begitu.

### Fase 2 — Provider Adapter Standardization: ✅ TERVERIFIKASI

- `src/agent/model-adapter.ts` (473 baris): kontrak
  `ModelAdapter`, `ChatChunk` (text/reasoning/usage/finish/
  tool_call), `AdapterError` + `normalizeProviderError`,
  `PanelChatAdapter` membungkus `streamChat`, `collectChatText`.
  Diverifikasi: satu-satunya pemanggil `streamChat` di luar
  `api.ts` adalah `PanelChatAdapter` (constructor-injected,
  default `streamChat`).
- Fail-loud guard ada dan masih berlaku:
  `model-adapter.ts:271` — request dengan `tools` tanpa
  `probeNativeTools` ditolak (`"native tools are not wired yet
  (a later phase, not Fase 5); probe-only use passes
  probeNativeTools: true"`).
- `src/agent/model-capabilities.ts` (477 baris): registry
  SUPPORTED/UNSUPPORTED/UNKNOWN, seed jujur (UNKNOWN kecuali
  streaming dari transport), provenance per field,
  `isCapabilityProven` (hanya `probe-live`/`transport`),
  `toAvailableModelEntry`. `CAPABILITY_REGISTRY_VERSION = 2`
  (di-bump Fase 9 saat field `xmlToolCalling` ditambah).
- Metadata konfirmasi ada: `confirmationPolicy` di 11 entri
  registry — required ×2 (`run_terminal_command`,
  `write_file`), scoped ×1 (`str_replace`), none ×8.
- Wiring minimal terverifikasi: loop via adapter, `/compact`
  via adapter (`ChatApp.tsx:1074`), `onFinishReason` aditif di
  `api.ts`. `tools.ts` tidak disentuh Fase 2 (diff Fase 2 tidak
  diperiksa ulang baris-per-baris; klaim ini konsisten dengan
  `git diff` tree final yang menunjukkan perubahan `tools.ts`
  hanya dari Fase 8).
- Temuan keamanan Fase 2 §4 (shell cwd-only) TERVERIFIKASI
  sebagai temuan nyata saat itu dan TERTUTUP oleh Fase 8 (§5).

### Fase 3 — Shared Tool Registry: ✅ TERVERIFIKASI (1 temuan minor)

- `src/agent/tool-registry.ts` (736 baris): 11 tool dengan
  schema, permission, risk, effect, category,
  `confirmationPolicy`, timeout, limit; `validateToolInput`
  (subset JSON Schema, tanpa Zod); `toOpenAiFunction`;
  fail-fast pada drift registry/factory.
- Klasifikasi terverifikasi di source: hanya
  `run_terminal_command` critical; `write_file`/`str_replace`
  high; `skill` medium; `write_todos` mutating-low.
- **TEMUAN MINOR A (§7):** `REGISTRY_VERSION` masih `1`
  (`tool-registry.ts:66`) padahal Fase 2 menambahkan field
  `confirmationPolicy` + `confirmationNote` — dokumen Fase 3
  §1.1 sendiri menyatakan versi di-bump saat field ditambah/
  diubah. Tidak ada konsumen runtime yang membaca versi ini
  (grep: hanya test yang assert `== 1`), jadi dampaknya NOL
  hari ini. Didokumentasikan, tidak diperbaiki di Fase 10
  (bukan integritas runtime; perbaikan = bump ke 2 + ubah test
  saat schema registry berikutnya berubah).

### Fase 4 — Universal Tool Orchestrator: ✅ TERVERIFIKASI

- `src/agent/tool-orchestrator.ts` (544 baris):
  `executeToolCalls` adalah satu-satunya jalur eksekusi.
  Diverifikasi: satu-satunya pemanggil produksi adalah
  `loop.ts:742`. Handler tidak ditulis ulang (direferensikan
  dari `tools.ts`).
- Paralel diturunkan dari metadata (tidak ada nama tool yang
  di-hardcode di aturan): eligible = read-only + bukan
  interaction/control + bukan endsAgentStep → tepat 4 tool
  read-only saat ini.
- Normalisasi MCP `CallToolResult` + `resultToToolMessage`
  (pesan history byte-identik) ada.
- Timeout hang-guard dari metadata registry (+5s grace) ada.
- Penyimpangan yang dicatat PHASE4 §6 (failed-edit guard
  sesudah batch; wave paralel tanpa percepatan wall-clock;
  timeout orchestrator hampir tidak pernah tercapai) masih
  akurat di source — ketiganya dikonfirmasi dari pembacaan
  `loop.ts:770` dan `tool-orchestrator.ts`.

### Fase 5 — Universal Agent Loop: ✅ TERVERIFIKASI

- `src/agent/loop.ts` (878 baris): header kontrak tertulis
  (dua dependensi kontrak, siklus satu turn, invarian,
  non-goal eksplisit) — dibaca dan cocok dengan implementasi.
- Injeksi adapter: `AgentLoopOptions.adapter`, default
  `createDefaultAdapter()`; legacy `callModel` tetap
  didahulukan bila diberikan.
- Ledger: `executedToolCalls` di semua jalur keluar; kunci
  `(step, index)` unik; hanya call yang benar-benar dieksekusi
  (Fase 6: `isProtocolViolationResult` menyaring validation
  failure — diverifikasi di `loop.ts:770`).
- `executeToolCall` di `tools.ts:677` TIDAK PUNYA pemanggil
  produksi — hanya `test/agent.test.mjs` +
  `test/security.test.mjs` (test seam). Diverifikasi grep.
- Format history tidak berubah: `role: "tool"` hanya
  diproduksi `resultToToolMessage`.
- Perubahan perilaku runtime: NOL (konsolidasi, sesuai laporan).

### Fase 6 — Fallback Tool Protocol: ✅ TERVERIFIKASI

- `src/agent/fallback-protocol.ts` (190 baris):
  `resolveToolChannel` (native HANYA bila
  `isCapabilityProven`), `PROTOCOL_FAILURE_LIMIT = 2`,
  `createProtocolTracker`, `protocolFailureMessage`,
  `isProtocolViolationResult`.
- Dokumen normatif `docs/TOOL-CALL-PROTOCOL.md` (241 baris)
  dibaca penuh — isinya cocok dengan implementasi (tag,
  alias, urutan validasi, taksonomi error, aturan 2x, batas).
- **TEMUAN MINOR B (§7):** §9 dokumen protokol sempat
  menyatakan adapter menolak `tools` fail-loud "sampai saat
  itu" dan Fase 7/8 sebagai "later phases" — ketiganya sudah
  selesai dan Fase 9 menambahkan opt-in probe-only.
  **DIPERBAIKI di Fase 10** (dokumen hidup normatif, bukan
  riwayat fase): §1 tabel native + §9 ditulis ulang
  mencerminkan status final.
- Aturan 2x terverifikasi di `loop.ts` (tiga jalur pelanggaran,
  pesan eksplisit, `completed = false`).

### Fase 7 — Context & Streaming Integration: ✅ TERVERIFIKASI

- `src/agent/context-manager.ts` (407 baris):
  `estimateTokens`, `budgetContext`,
  `resolveContextWindow` (fallback 128.000),
  `prepareContext` (view, bukan mutasi), `summarizeSegment`,
  `buildSummaryMessage`, `addUsage`. Konstanta
  `TOOL_RESULT_TRUNCATE_HEAD_CHARS = 1500` /
  `TAIL = 500`, `SUMMARIZE_MAX_INPUT_CHARS = 100.000` cocok
  dengan dokumentasi.
- `CollectedChat.streamComplete` ada di adapter; timeout
  bernama → `ApiError(408)` di `api.ts`; abort tetap
  `AbortError`.
- Retry max 3x (retryable saja, hanya bila attempt gagal belum
  mengirim delta) + guard stream tidak lengkap + guard finish
  reason ada di `loop.ts` (header kontrak menyebutkannya).
- Usage per turn ke footer TUI ada (`ChatApp.tsx`, slot
  `formatUsageLine`); per-step breakdown tetap follow-up.
- Keterbatasan PHASE7 §8 (heuristik ±20%, window 128k
  default perencanaan, ringkasan oleh model yang sama,
  compaction gagal di-retry tiap langkah) masih akurat.

### Fase 8 — Security Hardening: ✅ TERVERIFIKASI (dalam batasnya)

- `src/agent/security.ts` (463 baris):
  `validateShellCommand`, `resolveInsideSecure`,
  `realpathAllowMissing`, `scrubShellEnv`, `createRedactor`,
  `collectSessionSecrets`, daftar lokasi/basename sensitif.
  Diverifikasi: pola destruktif (`mkfs`, fork bomb), flag
  upload curl/wget, inline-code network send, pemeriksaan
  path sensitif.
- `src/agent/shell-sandbox.ts` (191 baris): probe
  `isSandboxAvailable`, mask script dengan verifikasi dan
  `exit 126` fail-closed, mode `"validation-only"` yang
  dilaporkan jujur.
- `src/agent/audit-log.ts` (115 baris): JSONL append-only,
  mode 0600, rotasi 5 MB, `summarizeToolArgs`,
  `AUDIT_SESSION_ID` per proses.
- Penerapan terverifikasi: `tools.ts` memakai
  `resolveInsideSecure` di 6 call site file/shell;
  `tool-orchestrator.ts` meredaksi + mengaudit setiap
  processed call; `loop.ts` redactor per turn + flag audit
  (default false, TUI `audit: true`); `ChatApp.tsx:225`
  redactor dari apiKey + whole-message pass di `finally`
  send() + redaksi error/ringkasan.
- 59 tes keamanan (`test/security.test.mjs`) hijau sebagai
  bagian dari 415/415 (dijalankan ulang Fase 10, §8).
- **Batasan yang ditegaskan ulang (§5):** ini BUKAN pentest
  profesional. Validator sintaktis bisa diakali obfuscation;
  namespace hanya Linux; GET polos diizinkan; tidak ada
  confirmation gate; TOCTOU teoritis; redaksi pola tidak
  sempurna; audit log lokal bukan tamper-proof.
- Gate TIDAK diimplementasikan — terverifikasi: tidak ada
  `Ask`/`YOLO`/`--yolo` di source runtime (grep di §3
  mengonfirmasi tidak ada workflow konfirmasi).

### Fase 9 — Cross-Model Testing: ✅ TERVERIFIKASI dari bukti mentah

Verifikasi independen terhadap `~/workspace/phase9-probe-
results/` (87 baris: pass1 45, pass2 42) + source:

- **12 model XML valid:** dihitung dari field `xml.valid`
  (BUKAN dari `status: "ok"` — status ok hanya berarti
  transport berhasil). Pass 1: 10 model valid (kedua Gemini
  `valid: []`, `hasTag: false`, teks "Understood. How can I
  assist you today?" / "…help you today?"); pass 2: 11 model
  valid (Cohere tidak diulang). Total distinct: 12. **Cocok
  dengan laporan.**
- **Native hanya Cohere:** tepat 1 record native `status:
  "ok"` di 87 baris — `command-r-plus-08-2024`,
  `finishReason: "tool_calls"`, 2 toolCalls (`read_files` +
  `list_directory`). **Cocok.**
- **503 sistematis untuk `tools`:** 40 dari 87 record menyebut
  503 — 28 probe native gagal (14 model × 2 pass) + 12 probe
  XML/structured gagal pada 3 model tak teruji (3 model × 2
  probe × 2 pass). Pesan: `Current group upstream is
  saturated, please try again later`. **Cocok.**
- **3 model tak teruji sama sekali:** Sonnet, Opus,
  methatech/uncensored — semua probe 503 di kedua pass. **Cocok.**
- **Registry:** `CAPABILITY_REGISTRY_VERSION = 2`,
  `PROBE_RESULTS_2026_11_10` ada di
  `model-capabilities.ts`; field `xmlToolCalling` ada;
  `toAvailableModelEntry` kini memasukkan `xml_tool_calling`
  ke `capability_source` (bug Fase 9 #2 diperbaiki).
- **Bug Fase 9 #1 diperbaiki:** `loop.ts:453`
  `toolChannel` kini hardcoded `"xml-fallback"` (channel yang
  dieksekusi), bukan hasil `channelForModel()`. **Cocok.**
- **Wiring probe:** `probeNativeTools` default OFF
  (`model-adapter.ts:208,271,342`); `delta.tool_calls`
  parsing ada; `responseFormat` passthrough ada. Loop tidak
  pernah opt-in (tidak ada `probeNativeTools` di `loop.ts`).
- **Keamanan lintas model:** 8 tes `test/cross-model.test.mjs`
  hijau; enforcement Fase 8 sama per model (bukan hanya satu).
- **Biaya probe:** tidak dapat diverifikasi ulang dari bukti
  mentah (usage tercatat di record; klaim "beberapa sen dolar
  AS" masuk akal untuk 87 probe pendek — dicatat sebagai klaim
  fase, bukan temuan audit).
- **Kimi-k2.7-code retired:** tidak ada di hasil probe;
  `FREE_MODEL_IDS` masih mencantumkannya (open item §6.9).

---

## §3. Audit integritas arsitektur

Semua pemeriksaan dilakukan dengan grep + pembacaan source pada
tree final (2026-11-10).

| Pemeriksaan | Bukti | Hasil |
|---|---|---|
| Satu jalur model | `streamChat` hanya dipanggil `PanelChatAdapter`; loop + `/compact` lewat `collectChatText(adapter)` | ✅ |
| Satu jalur eksekusi tool | `executeToolCalls` — satu-satunya pemanggil produksi `loop.ts:742`; `executeToolCall` tanpa pemanggil produksi (test seam) | ✅ |
| 11 tool terdaftar & berfungsi | Registry 11 entri (confirmationPolicy ×11); semua handler direferensikan dari `tools.ts`; 415 tes hijau | ✅ |
| Orchestrator satu-satunya jalur | Loop tidak pernah memanggil handler langsung (grep: tidak ada `entry.handler` / `tool.execute` di `loop.ts`) | ✅ |
| XML fallback tersedia | Tag + alias + parser + nudge + 2x rule utuh; `toolChannel` selalu `"xml-fallback"` | ✅ |
| Native hanya bila terbukti SUPPORTED | `resolveToolChannel` + `isCapabilityProven`; loop tidak pernah mengirim `tools`; satu-satunya model native-proven (Cohere) tidak pernah dipakai native oleh loop | ✅ |
| Context/streaming tidak merusak history | `prepareContext` view-only; stored history tidak dimutasi truncation; compaction menggantikan segmen (bukan duplikasi); test 120-exchange hijau | ✅ |
| Ledger tanpa eksekusi palsu/ganda | Hanya call yang dieksekusi masuk ledger (`isProtocolViolationResult` menyaring); kunci `(step, index)` unik; test no-duplicate hijau | ✅ |
| Security hardening aktif | 6 lapisan di kode (§2 Fase 8); 59 tes keamanan hijau | ✅ |
| Tidak ada jalur eksekusi lama | `executeToolCall` test-only (terdokumentasi sebagai seam, bukan jalur tersembunyi) | ✅ |
| Tidak ada Ask/YOLO/--yolo | Grep source: tidak ada workflow konfirmasi di runtime | ✅ |
| Mode CLI tidak berubah | DEFAULT/LITE/MAX/PLAN utuh; PLAN mencabut 3 tool mutating | ✅ |
| Panel/production tidak berubah | Tidak ada file panel dalam tree ini yang diubah oleh Fase 1–10 (repo CLI saja); tidak ada deploy | ✅ |

**Satu-satunya jalur lama yang dipertahankan dengan alasan
terdokumentasi:** `executeToolCall` (`tools.ts:677`) sebagai seam
pengujian handler. Alasan: menghapusnya memaksa penulisan ulang
test handler tanpa manfaat loop. Ini BUKAN jalur eksekusi
produksi — tidak ada pemanggil produksi.

---

## §4. Audit keamanan (ringkas; detail di PHASE8)

Diperiksa ulang di Fase 10 (bukan diulang penuh — 59 tes
dijalankan ulang dan hijau, §8):

| Lapisan | Verifikasi Fase 10 |
|---|---|
| Command validation | `validateShellCommand` ada; pola sensitif/destruktif/eksfiltrasi dibaca di source; pemisah segmen sadar quote |
| Namespace sandbox | Mask script + verifikasi + exit 126 dibaca di `shell-sandbox.ts`; fallback `"validation-only"` dilaporkan jujur |
| Environment scrubbing | `scrubShellEnv` allowlist; `*_KEY`/`*_TOKEN`/`*_SECRET`/`METATECH_*` dibuang |
| Realpath containment | `resolveInsideSecure` di 6 call site `tools.ts`; `walkFiles` tidak mengikuti symlink |
| Secret redaction | Orchestrator + loop + handler shell + ChatApp whole-message pass; nilai eksak + pola generik |
| Audit logging | JSONL append-only, mode 0600, rotasi 5 MB, argumen tersanitasi + teredaksi, anti-forgery satu baris |
| Permission & akses tool | Mode toolset boundary (PLAN menolak semua mutating, penolakan teraudit); metadata confirmation hook saja |

**Pernyataan yang TIDAK dibuat audit ini:** sistem ini TIDAK
diklaim telah menjalani penetration test profesional. Yang ada
adalah unit test keamanan (59 tes, dummy credentials) + tes
cross-model (8 tes) + verifikasi mekanisme di VM ini. Ketahanan
terhadap adversary yang berdedikasi (container escape, kernel
exploit, obfuscation lanjutan) TIDAK terbukti dan TIDAK diklaim.

---

## §5. Confirmation gate — open item (dokumentasi, bukan implementasi)

Sesuai perintah Fase 10, gate TIDAK diimplementasikan di fase
ini. Status yang diverifikasi:

**Kondisi saat ini:**
- Metadata lengkap di registry (`confirmationPolicy`:
  required = `run_terminal_command`, `write_file`; scoped =
  `str_replace` dengan `confirmationNote` faktor evaluasi;
  none = 8 tool lain). `requiresConfirmation` = policy ≠
  "none". `toolsRequiringConfirmation()` mengembalikan
  `["str_replace", "write_file", "run_terminal_command"]`.
- TIDAK ADA kode gate: tidak ada prompt konfirmasi, tidak ada
  flag `--yolo`, tidak ada mode Ask. Perintah destruktif yang
  lolos validator berjalan langsung.
- Komentar "gate Fase 8" di registry/orchestrator/loop sudah
  diperbaiki Fase 8 agar tidak mengklaim gate ada.

**Tools yang membutuhkan konfirmasi (saat gate dibangun):**

| Tool | Policy | Alasan |
|---|---|---|
| `run_terminal_command` | required | Arbitrary shell; satu-satunya tool critical |
| `write_file` | required | Whole-file write, high risk |
| `str_replace` | scoped | Gate mengevaluasi cakupan perubahan + sensitivitas file target (faktor di `confirmationNote`) |

**Risiko jika gate belum tersedia:**
- Perintah destruktif yang LEGAL menurut validator (mis.
  `rm -rf ./build` di dalam workspace) jalan tanpa
  konfirmasi interaktif.
- File-write high-risk (`write_file` menimpa file utuh)
  jalan tanpa konfirmasi.
- Mitigasi yang ada hari ini: audit log (jejak pasca-fakta)
  + validator (blokir pola destruktif absolut) + namespace
  sandbox (masking kredensial) + mode PLAN (cabut mutating).
  Mitigasi ini TIDAK menggantikan persetujuan interaktif.

**Bagian arsitektur yang perlu diintegrasikan saat gate dibangun:**
- `tool-orchestrator.ts: executeOne` — titik cek
  pre-eksekusi (sebelum handler jalan).
- `tool-registry.ts` — `confirmationPolicyFor()` /
  `requiresConfirmation` (sudah ada).
- `src/cli.ts` / `src/commands.ts` — parsing flag `--yolo`
  (belum ada).
- `src/ui/ChatApp.tsx` — permukaan prompt konfirmasi di TUI
  (belum ada); perlu mekanisme pause/resume turn (pola
  `ask_user` sudah ada sebagai referensi).
- **Batasan mengikat (Decision 1):** `--yolo` boleh melewati
  konfirmasi interaktif, tapi TIDAK PERNAH melewati sandbox,
  security policy, validasi input, atau perlindungan kredensial.

---

## §6. Open items (belum selesai, bukan dibatalkan)

1. **Confirmation gate** (§5) — metadata siap, implementasi
   menunggu perintah Reza.
2. **Native tool calling sebagai jalur loop** — wiring hanya
   probe-only (`probeNativeTools`, default OFF). Penempatan
   diputuskan Reza. Sisa kerja: pengirim `tools` di loop,
   routing per capability, normalisasi history native vs XML
   (id sintetis `call-{step}-{index}`), validasi live per
   channel (baru Cohere yang terbukti).
3. **Re-probe saat upstream pulih** — native 14 model +
   semua kapabilitas Sonnet / Opus / methatech/uncensored.
4. **Per-step usage/cost surfacing ke footer TUI** (Fase 7
   selesai di per-turn).
5. **Kartu attachment tidak dihitung `layoutBudget`** (0.1.9
   §4o) — frame meluber, footer terpotong saat kartu paste
   tampil.
6. **Failed compaction di-retry tiap langkah** sampai berhasil
   (satu model call gagal per langkah).
7. **Estimasi token heuristik (±20%)** — tokenizer asli
   (tiktoken) adalah follow-up.
8. **`executeToolCall` tanpa pemanggil produksi** — seam test,
   sengaja dipertahankan.
9. **Panel-side (bukan kerja CLI):** 503 untuk request
   ber-`tools`; angka usage membesar untuk gpt-6-astra /
   gpt-6-luna / grok-4.7; kimi-k2.7-code retired tapi masih di
   `FREE_MODEL_IDS` CLI.
10. **Registry tidak dipersist ke disk** — hasil probe di-seed
    ulang dari dokumen; persistensi belum diputuskan.
11. **Tidak ada persistensi sesi** — history hilang saat CLI
    restart (desain sejak 0.1.6, bukan regresi).

---

## §7. Temuan Fase 10 (bug & inkonsistensi dokumentasi)

### Temuan A — `REGISTRY_VERSION` tidak di-bump (minor, TIDAK diperbaiki)

- **Bukti:** `src/agent/tool-registry.ts:66`
  `REGISTRY_VERSION = 1`; Fase 2 menambahkan field
  `confirmationPolicy` + `confirmationNote` tanpa bump,
  padahal PHASE3 §1.1 menyatakan versi di-bump saat field
  ditambah/diubah. Test assert `== 1`
  (`test/tool-registry.test.mjs:57`).
- **Dampak:** NOL — tidak ada konsumen runtime yang membaca
  versi ini (grep: hanya test). Versi ini tidak menegakkan
  apa pun hari ini.
- **Keputusan:** didokumentasikan saja. Perbaikan (bump ke 2
  + ubah test) bukan integritas runtime dan berada di luar
  mandat "perbaiki hanya bila benar-benar diperlukan untuk
  integritas runtime". Rekomendasi: bump saat schema registry
  berikutnya berubah.

### Temuan B — §9 `docs/TOOL-CALL-PROTOCOL.md` usang (minor, DIPERBAIKI)

- **Bukti:** §9 menyatakan adapter menolak `tools`
  fail-loud tanpa pengecualian dan Fase 7/8 sebagai "later
  phases", padahal ketiganya sudah selesai dan Fase 9
  menambahkan opt-in probe-only.
- **Dampak:** dokumentasi normatif menyesatkan pembaca baru
  tentang status adapter.
- **Perbaikan (Fase 10):** §1 tabel native + §9 ditulis ulang
  mencerminkan status final (probe-only opt-in, Fase 7/8
  selesai, gate tetap open, hasil Fase 9). Ini perbaikan
  DOKUMENTASI dalam mandat Fase 10, bukan perubahan kode.

### Baris usang di dokumen fase historis (dicatat, TIDAK ditulis ulang)

Dokumen Fase 2–7 ditulis sebelum koreksi gate dan berisi kalimat
yang, dibaca harfiah hari ini, menyatakan gate "diimplementasikan
di Fase 8" (mis. PHASE2 §0.2/§7, PHASE3 §5, PHASE4 §7, PHASE7
§9). Semuanya SUDAH dikoreksi di tempat yang mengikat:
`docs/UNIVERSAL-RUNTIME-AUDIT.md` §11 decision 1 (catatan
KOREKSI) dan `docs/UNIVERSAL-RUNTIME-PHASE8.md` §9.3. Riwayat
fase tidak ditulis ulang — koreksi tercatat, bukan
disembunyikan. Pembaca yang membaca dokumen fase secara
kronologis akan menemukan koreksinya di AUDIT §11.

### Tidak ada temuan kritis baru

Tidak ditemukan bug produk baru di Fase 10. Tidak ada duplikasi
eksekusi, kebocoran secret, regresi Fase 1–9, atau jalur
eksekusi tersembunyi. Satu-satunya perubahan file di Fase 10
adalah dokumentasi (3 dokumen baru + 1 koreksi protokol +
bagian Fase 10 di audit doc).

---

## §8. Validasi akhir (dijalankan Fase 10)

| Pemeriksaan | Hasil |
|---|---|
| `npx tsc` | Bersih (0 error) |
| `npm test` (unit) | **415/415** — SAMA PERSIS dengan baseline Fase 9 (401 + 6 probe adapter + 8 cross-model). Tidak ada test yang diubah/dihapus/ditambah untuk meloloskan hasil. |
| `test/agent-pty.sh` | **32/32** |
| `test/tui-pty.sh` | **270/270** |
| Konsistensi dokumentasi | Diperiksa: AUDIT + PHASE2–9 + TOOL-CALL-PROTOCOL dibaca penuh; klaim material diverifikasi ke source; 2 temuan minor di §7 |
| Perubahan source code | **NOL perubahan source di Fase 10** (hanya dokumentasi). `git diff` tree vs HEAD tidak bertambah dari baseline Fase 9 kecuali file dokumen Fase 10. |

**Catatan pengujian jujur:** `dist/` harus di-build (`npx tsc`)
sebelum `npm test` karena tes mengimpor dari `dist/` (pelajaran
Fase 7, masih berlaku).

---

## §9. File yang dibuat / diubah di Fase 10

| File | Perubahan |
|---|---|
| `docs/UNIVERSAL-RUNTIME-FINAL-AUDIT.md` | BARU (dokumen ini) |
| `docs/UNIVERSAL-RUNTIME-ARCHITECTURE.md` | BARU (arsitektur final + panduan integrasi provider baru) |
| `docs/UNIVERSAL-RUNTIME-PHASE10.md` | BARU (laporan penutupan) |
| `docs/TOOL-CALL-PROTOCOL.md` | Koreksi §1 + §9 (status adapter probe-only, Fase 7/8 selesai, gate open) |
| `docs/UNIVERSAL-RUNTIME-AUDIT.md` | Bagian Fase 10 ditandai SELESAI |
| `.bak-20261110-phase10/` | Backup 54 file sebelum edit |

**Tidak diubah:** semua file source (`src/`), semua file test
(`test/`), panel, production, database. Tidak ada commit/push/
deploy.

---

## §10. Kesimpulan

Universal Agent Runtime **layak dinyatakan selesai** sebagai
roadmap 10 fase, berdasarkan bukti implementasi dan pengujian:

- **Fase 1–9 terverifikasi** terhadap source code aktual dan
  (untuk Fase 9) bukti mentah probe. Tidak ada klaim material
  yang terbukti salah.
- **Arsitektur konsisten:** satu adapter, satu registry, satu
  orchestrator, satu loop, satu protokol fallback, satu context
  manager, enam lapisan keamanan — semuanya grep-terverifikasi
  sebagai satu-satunya jalur di masing-masing area.
- **Keamanan adalah enforcement di kode**, bukan instruksi
  prompt — dengan batasan yang didokumentasikan jujur dan
  TANPA klaim pentest profesional.
- **Capability matrix terisi bukti live** (12 model XML, 1
  model native, sisanya UNKNOWN yang jujur) — bukan asumsi.
- **Test hijau penuh:** 415/415 unit + 32/32 agent-pty +
  270/270 tui-pty, sama persis dengan baseline Fase 9.
- **Tidak ada temuan kritis baru** di Fase 10; tidak ada
  perubahan source yang dibutuhkan untuk menutup roadmap.

Yang tersisa adalah **open items yang tercatat** (§6) — gate
konfirmasi, jalur native di loop, re-probe saat upstream
pulih, dan follow-up lama — yang semuanya membutuhkan perintah
Reza di luar roadmap ini, bukan kegagalan roadmap ini.
Roadmap ditutup; pekerjaan berikutnya adalah keputusan Reza.
