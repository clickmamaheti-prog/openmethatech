# Final Release Audit — MethaTech CLI v0.1.10

- **Tanggal audit:** 2026-11-10
- **Repo:** `~/workspace/metatech-cli/`
- **HEAD:** `501b073` (`release: v0.1.9`)
- **Kandidat:** v0.1.10 (working tree, belum commit)
- **Sifat audit:** read-only, kecuali file laporan ini. Tidak ada source yang diedit,
  tidak ada staging, commit, tag, push, publish, deploy, atau perubahan versi.
- **Basis bukti:** source code, Git diff, hasil pengujian yang dijalankan ulang
  dalam audit ini, dan isi paket aktual (`npm pack --dry-run`). Laporan audit
  sebelumnya (`docs/RELEASE-AUDIT-FINAL-0.1.9.md`) hanya dipakai sebagai
  pembanding, bukan sebagai bukti — semua klaim di bawah diverifikasi ulang
  dari source dan output tool.

## A. Release Decision: CONDITIONAL GO

**Keputusan: CONDITIONAL GO** — bukan GO penuh, bukan NO-GO.

Seluruh test lulus pada baseline, seluruh diff source terverifikasi sesuai
dengan yang diklaim, keamanan bersih, dan isi paket npm bersih. Tiga blocker
dari audit 0.1.9 (B1 tabrakan versi, B2 CHANGELOG, B3 lockfile basi) **sudah
terselesaikan** oleh tahap persiapan metadata. Namun audit ini menemukan
**satu ketidakakuratan dokumentasi** yang menghalangi GO penuh:

- **C1 (satu-satunya kondisi): README.md:238 masih menulis
  "See `CHANGELOG.md` for the full 0.1.9 change list."** — padahal kandidat
  ini adalah 0.1.10 dan README tidak menyebut 0.1.10 sama sekali
  (grep `0.1.10` di README = 0 hasil). Perbaikan: satu baris, ubah menjadi
  0.1.10. Tanpa perubahan source, tanpa dampak test; setelah diperbaiki
  cukup jalankan ulang `npm pack --dry-run` untuk konfirmasi paket.
  Kondisi ini mekanis, bukan blocker source atau keamanan.

Tidak ada blocker source, tidak ada blocker keamanan, tidak ada artefak
sensitif, dan allowlist release jelas. Setelah C1 dibereskan, kandidat
layak masuk staging dan release sebagai v0.1.10.

## B. Git & Repository State

| Item | Kondisi aktual (diverifikasi) |
|---|---|
| HEAD | `501b073 release: v0.1.9` |
| Tag | Hanya `v0.1.9`. Tag `v0.1.10` **belum ada** (`git tag -l "v0.1.10"` kosong) |
| `package.json` | `"version": "0.1.10"` |
| `package-lock.json` | `"version": "0.1.10"` (root dan `packages[""]`) |
| Staged (`git diff --cached`) | Kosong — tidak ada file yang di-stage |
| Modified (unstaged) | 9 file (lihat klasifikasi) |
| Untracked | 9 entri: 8 file + direktori `verify-tui-20261110/` |
| `git diff --check` | Bersih (tidak ada whitespace error) |

### Klasifikasi file

**Wajib masuk release (source + test):**

| File | Alasan |
|---|---|
| `src/agent/slash.ts` (+40/−0) | `selectConversationMessages` + `selectExportMessages` — satu definisi konten percakapan untuk /export dan /compact |
| `src/ui/ChatApp.tsx` (+251/−~) | Model ContentBlock, `isSummary`, reset scroll konfirmasi slash |
| `src/ui/layout.ts` (457 baris berubah) | Type `AssistantBlock`, `flattenMessages` render block berurutan |
| `test/agent-pty.sh` | Penyesuaian ukuran terminal (80x50) + komentar |
| `test/layout.test.mjs` | 6 fixture ke bentuk block + 4 test baru |
| `test/tui-pty.sh` | Skenario baru s35 (23 cek) + penyesuaian ukuran |

**Metadata release:**

| File | Alasan |
|---|---|
| `package.json` | Versi 0.1.9 → 0.1.10 (1 baris) |
| `package-lock.json` | Sinkronisasi versi root 0.1.7 → 0.1.10 + 2 baris normalisasi `dev` → `devOptional` (lihat §E) |
| `CHANGELOG.md` | Section baru `## [0.1.10]` (+31 baris, hanya penambahan) |

**Dokumentasi release (baru):**

| File | Alasan |
|---|---|
| `docs/TUI-INTERACTION-AUDIT.md` | Audit pra-implementasi ContentBlock |
| `docs/TUI-INTERACTION-VERIFICATION.md` | Laporan pengujian menyeluruh A–H |
| `docs/RELEASE-AUDIT-FINAL-0.1.10.md` | Laporan audit ini |

**Test baru:**

| File | Alasan |
|---|---|
| `test/slash.test.mjs` | 9 regression test (export selection + rantai compact) |

**Bukti audit yang tidak perlu dipublikasikan (dikecualikan):**

| File | Alasan |
|---|---|
| `verify-tui-20261110/` (170 entri, 976K) | Harness probe + capture PTY + log request; bukti audit lokal, bukan bagian produk |
| `docs/RELEASE-AUDIT-FINAL-0.1.9.md` | Laporan audit 0.1.9 — sudah tidak relevan untuk commit 0.1.10 (tetap di repo sebagai arsip? **Tidak**: file ini untracked; audit 0.1.9 sudah selesai dan keputusannya sudah dieksekusi lewat persiapan metadata. Tidak masuk commit 0.1.10.) |

**Artefak lokal / file lama (dikecualikan, ignored):**

- 26 direktori `.bak-*/` (total ~4.9 MB), termasuk `.bak-20261110-tui-interaction/`,
  `.bak-20261110-two-bugfix/`, `.bak-20261110-compact-slash/` — backup lokal, ignored.
- `dist/` (build output, ignored; 47 file JS).
- `node_modules/` (ignored).
- `methatech-cli-cli-0.1.9.tgz` (tarball lokal, ignored).
- `src/api.ts.bak-20261108-devicelogin`, `src/commands.ts.bak-20261108-devicelogin`,
  `src/commands.ts.bak-20261108-versionfix` (ignored).
- 4 file `docs/images/`: `status-before-thinking.ansi.txt`,
  `status-before-working.ansi.txt`, `timestamp-p-after-40.png`,
  `timestamp-p-after-80.png`. Koreksi terhadap audit sebelumnya: dua file PNG
  **disebut** oleh glob `docs/images/timestamp-p-after-*.png` di
  `docs/AGENT-IMPLEMENTATION.md:1933` (bukti §4p), dan dua file `.ansi.txt`
  disebut hanya sebagai file yang dikecualikan di kedua laporan audit 0.1.9.
  Keduanya tetap **dikecualikan** dari commit 0.1.10 — sengaja tidak masuk
  commit 0.1.9, dan tidak ada link dokumen yang akan rusak karenanya.

## C. Validation Results

Seluruh pemeriksaan dijalankan ulang dalam audit ini (bukan mengutip laporan
sebelumnya):

| Pemeriksaan | Baseline | Hasil audit | Exit |
|---|---|---|---|
| `npm run build` | bersih | bersih | 0 |
| `npx tsc` | bersih | bersih | 0 |
| `npm test` | 428/428 | **428/428, 0 fail** | 0 |
| `bash test/agent-pty.sh` | 32/32 | **32/32** (PASS=32 FAIL=0) | 0 |
| `bash test/tui-pty.sh` | 293/293 | **293/293** (PASS=293 FAIL=0) | 0 |
| `npm pack --dry-run` | — | `methatech-cli-cli-0.1.10.tgz`, 50 file, 159.6 kB / 539.1 kB, shasum `a7077848fea265b9b0889376f91283bc2ff8cfa9` | 0 |
| `npm ci --dry-run` | — | `up to date in 299ms` (lockfile valid) | 0 |
| `npm audit` | — | **Tidak dapat dijalankan** — endpoint audit diblokir kebijakan registry (`403 policy_denied`); kerentanan dependensi tidak terverifikasi dalam audit ini | — |

Catatan: `test/tui-pty.sh` dijalankan di background (~8 menit) dan selesai
293/293; tiga cek terakhir yang terlihat di log adalah s35 (dua block
write_todos, redraw byte-identik, indikator scroll + urutan terjaga saat
scroll ke atas). Tidak ada test yang diubah atau dihapus untuk mendapatkan
hasil hijau.

## D. Source Audit

Diff sejak baseline `501b073` hanya menyentuh 9 file (781 insertions /
320 deletions). **Tidak ada perubahan** pada provider, model, tool registry,
orchestrator, fallback protocol, security, atau fitur lain — diverifikasi
dari `git diff --name-only` (hanya `CHANGELOG.md`, `package-lock.json`,
`package.json`, `src/agent/slash.ts`, `src/ui/ChatApp.tsx`,
`src/ui/layout.ts`, `test/agent-pty.sh`, `test/layout.test.mjs`,
`test/tui-pty.sh`).

### TUI ContentBlock (src/ui/ChatApp.tsx, src/ui/layout.ts)

- **Satu assistant message per turn:** `send()` membuat pesan assistant
  dengan `blocks: []` (ChatApp.tsx, hunk send). `appendAssistantText`
  meng-append ke block teks terakhir atau membuka block teks baru sesudah
  tool — teks tidak lagi menumpuk di atas semua tool call. Diverifikasi
  dari diff.
- **Urutan blok:** `pushTool` menambah block tool ke pesan turn itu (bukan
  pesan top-level terpisah). `appendToolResult` menargetkan block tool
  terdepan yang belum selesai (`done` false), cocok nama dulu, lalu
  fallback ke block tool belum selesai mana pun — aman untuk batch paralel
  (semua `onCallStart` jalan sebelum semua `onCallResult`). Bila tidak ada
  block yang cocok (tool ditolak mode / tidak dikenal), hasil muncul
  sebagai system line, bukan hilang.
- **TODOs:** `upsertTodosMessage` mengganti block todos di dalam turn;
  posisi kronologis dipertahankan, satu list saja.
- **Streaming append-only:** delta teks memperpanjang block teks terakhir;
  `content` tetap dijaga sebagai teks gabungan turn untuk /export dan
  /compact. Redaction pass `finally` juga me-redact isi block
  (teks, preview/hasil tool, task todos).
- **Catch:** pesan hanya di-splice bila teks kosong **dan** tanpa block —
  turn yang hanya menjalankan tool tidak terhapus.
- **layout.ts:** type baru `AssistantBlock` (text / tool + flag `done` /
  todos); `LayoutMessage.kind` menjadi `"chat" | "system"`;
  `flattenMessages` me-render block berurutan dengan 1 blank line antar
  block; pesan tanpa block fallback ke `content`. `windowLines` **tidak
  disentuh** (0 kemunculan di diff) — mekanisme windowing/sticky-bottom
  tidak berubah.
- **Tidak ada duplikasi/pesan hilang:** dibuktikan PTY s35 (redraw setelah
  selesai byte-identik) + suite 293/293 hijau.

### Conversation management (src/agent/slash.ts, src/ui/ChatApp.tsx)

- **Satu definisi konten percakapan:** `selectConversationMessages()`
  (slash.ts:142) — `kind === "chat"` ATAU `isSummary === true`, urutan
  asli, output `ChatMessage[]`. `selectExportMessages()` kini
  mendelegasikan ke fungsi ini (slash.ts:153-154).
- **/export setelah /compact:** case `"export"` memakai
  `selectExportMessages(messagesRef.current)` (ChatApp.tsx:1274);
  ringkasan (`kind: "system"` + `isSummary: true`, ChatApp.tsx:1193)
  ikut diekspor; system notice biasa tetap keluar. Tidak regresi —
  dibuktikan probe h2 + file export dibaca langsung pada pekerjaan
  sebelumnya dan unit test 9/9 hijau.
- **Rantai /compact berulang:** `compactHistory()` memakai
  `selectConversationMessages` (ChatApp.tsx:1170), bukan filter
  `kind === "chat"`. Bukti request asli diverifikasi ulang dalam audit
  ini dari `verify-tui-20261110/h2-requests.jsonl`: req 5 (compact 2)
  memuat ringkasan 1 ("kucing dan anjing") + turn baru; req 7 (compact 3)
  memuat ringkasan 2 ("Sudah selesai") saja — ringkasan 1 tersubsumsi,
  tanpa duplikasi. `compactPrompt()` memfilter `role !== "system"` dan
  ringkasan ber-role `"assistant"`, jadi prompt tidak membuang ringkasan.
- **System notice biasa tidak masuk konteks:** selector hanya meloloskan
  chat + `isSummary`; "Mode agen" / "Agen berhenti" dikeluarkan (unit
  test membuktikan).
- **Export hanya memuat ringkasan terbaru:** sesuai perilaku yang diuji —
  histori diganti satu summary per compact; file export akhir hanya berisi
  ringkasan terbaru.

### Scroll behavior (src/ui/ChatApp.tsx)

- `pushSystem()` (baris 723-729) **tidak diubah**: hanya append pesan,
  tanpa menyentuh scroll. Diverifikasi dari body fungsi.
- Reset scroll `setScrollOffsetBoth(0)` ditambahkan tepat di jalur
  konfirmasi perintah, konsisten dengan perbaikan /export:
  - case `"agent"` (baris ~1227), case `"mode"` cabang error "Mode tidak
    dikenal" (~1237) dan konfirmasi sukses (~1250), case `"init"` sesudah
    if/else (~1263), case `"export"` sesudah `pushSystem` konfirmasi
    (~1283, dengan komentar penjelas).
  - Sudah ada sebelumnya dan tidak berubah: `send()` (~975), sukses
    `/compact` (~1198), `/clear` (~1292), auto-scroll effect
    (`scrollOffset <= 1`, ~512).
- **Bukti PTY dibaca ulang dalam audit ini** (`verify-tui-20261110/`):
  - `s-80x24-mode.plain.txt` baris 15: "Mode agen: Lite…" terlihat.
  - `s-80x24-agent.plain.txt` baris 13: "Agen koding selalu AKTIF
    (mode Lite)…" terlihat.
  - `s-80x24-init.plain.txt`: ekor ringkasan AGENTS.md (`## Key code`,
    `` - `AGENTS.md` ``, `## Commands`…) terlihat di bawah.
  - Kontrol negatif `s-80x24-help.plain.txt`: view tetap di atas
    ("↑ 122 baris di atas") — `pushSystem` yang tidak diubah memang tidak
    sembarangan mereset scroll.
  - PgUp/PgDn normal: indikator `↑` muncul saat scroll ke atas, PgDn
    kembali ke bawah, pesan baru sesudah PgDn terkirim dan view di bawah.
- **Tidak ada regresi PgUp/PgDn/sticky-bottom:** suite tui-pty 293/293
  hijau, termasuk s35 (indikator scroll + urutan terjaga saat scroll).

### Universal Agent Runtime (fase 1–10) — tidak berubah

Seluruh file runtime **tidak ada di diff**: `model-adapter.ts`,
`model-capabilities.ts`, `tool-registry.ts`, `tool-orchestrator.ts`,
`loop.ts`, `fallback-protocol.ts`, `context-manager.ts`, `security.ts`,
`shell-sandbox.ts`, `audit-log.ts`, `tools.ts`, `xml-parser.ts`,
`prompt.ts`, `modes.ts`, `skills.ts`. Klaim kunci diverifikasi ulang
dari source:

- **Adapter fail-loud** (`model-adapter.ts:271`): request membawa `tools`
  ditolak dengan `AdapterError` kecuali `probeNativeTools: true`
  (harness probe saja). Loop produksi tidak pernah mengirim tools.
- **Native tool calling — status probe sebenarnya dipertahankan:**
  `nativeToolCalling: "SUPPORTED"` hanya pada
  `"command-r-plus-08-2024"` (`model-capabilities.ts:240`, dengan komentar
  "Cohere is the ONE model whose native probe answered: 2 native tool
  calls … finish_reason tool_calls"). Model lain mencatat "native NOT
  TESTED — panel 503 for every tools request" (14 model UNKNOWN;
  Sonnet/Opus/`methatech` tidak teruji). **Native TIDAK diklaim tersedia
  untuk semua model.**
- **`toolChannel` hardcode `"xml-fallback"`** (`loop.ts:453`) — loop
  melaporkan channel yang benar-benar dieksekusi.
- **Confirmation gate TIDAK diimplementasikan** (tetap open item):
  hanya metadata `confirmationPolicy` + helper
  `confirmationPolicyFor()` di `tool-registry.ts` dan komentar penjelas
  ("No confirmation gate / Ask / YOLO / --yolo", `loop.ts:95`,
  `tool-orchestrator.ts:55`). Tidak ada flag `--yolo`, tidak ada workflow
  Ask di runtime. **Gate TIDAK diklaim ada.**
- **Security dan authorization:** tidak berubah; redaction pass kini juga
  mencakup isi block (lihat ContentBlock di atas). `REGISTRY_VERSION`
  masih 1 (dampak nol, temuan Fase 10 yang sudah didokumentasikan).

## E. Documentation & Package

### Metadata

| Item | Hasil |
|---|---|
| `package.json` version | `0.1.10` ✓ |
| `package-lock.json` version | `0.1.10` (root + `packages[""]`) ✓ |
| `package.json` bin | `methatech` → `./dist/cli.js` ✓ |
| `package.json` files | `["dist", "README.md"]` (LICENSE selalu ikut oleh npm) ✓ |
| Lockfile diff | Hanya 2 baris versi (0.1.7 → 0.1.10) + 2 baris normalisasi `dev` → `devOptional` pada `@types/react` dan `csstype`. **Tidak ada perubahan versi dependensi, resolved URL, integrity hash, atau license.** `npm ci --dry-run`: `up to date in 299ms` ✓ |
| CHANGELOG 0.1.10 | Section baru di atas `## [0.1.9]`; isi mencerminkan perubahan aktual (ContentBlock, /export, rantai /compact, konfirmasi slash, regression test); test counts `428/428`, `32/32`, `293/293` sesuai hasil aktual audit ini ✓ |
| CHANGELOG 0.1.9 dan sebelumnya | Tidak berubah — diff CHANGELOG hanya +31 baris penambahan, 0 penghapusan ✓ |

### README.md — satu temuan (kondisi C1)

README akurat dan jujur pada klaim substansial (diverifikasi dengan grep):

- "Native tool calling is proven on exactly **one** model: Cohere …"
  (baris 174) ✓
- "**No confirmation gate.** The registry carries `confirmationPolicy` …
  mode, or `--yolo` flag. A destructive command that passes validation
  runs without confirmation." (baris 212-215) ✓
- "**Native tool calling is not the production path.** … **No MCP
  integration.** The runtime adopts MCP formats and patterns … but does
  not integrate the MCP SDK or any MCP server." (baris 216-220) ✓
- Instalasi `npm install -g @methatech-cli/cli` (baris 9) sesuai
  implementasi ✓
- Keterbatasan yang diketahui didokumentasikan dengan jujur: attachment
  `layoutBudget`, per-step usage belum ada, `kimi-k2.7-code` retired
  upstream tapi masih terdaftar (baris 232-236) ✓

**Temuan C1 (satu-satunya kondisi):** README.md:238 masih menulis
"See `CHANGELOG.md` for the full 0.1.9 change list." — padahal kandidat
ini 0.1.10 dan README tidak menyebut `0.1.10` sama sekali (grep = 0
hasil). Satu baris, perbaiki menjadi 0.1.10. Tidak ada klaim MCP,
native universal, atau gate yang tidak terbukti di README.

Catatan: tidak ada file `AUDIT.md` di root repo (yang ada adalah
`docs/UNIVERSAL-RUNTIME-AUDIT.md` dan sejenisnya) — bukan temuan, hanya
klarifikasi cakupan.

### Isi paket npm (`npm pack --dry-run`, diperiksa langsung)

- Nama file: `methatech-cli-cli-0.1.10.tgz`, versi paket 0.1.10, shasum
  `a7077848fea265b9b0889376f91283bc2ff8cfa9`.
- 50 file: `LICENSE` + `README.md` + `package.json` + **47 file `dist/`**.
- **Tidak ada** `test/`, `docs/`, `src/`, `.bak`, `verify-tui-20261110/`,
  `.env`, secret, `.tgz`, atau source map (`.map`) di dalam paket
  (grep pola terlarang pada daftar isi = 0 temuan).
- `confirm.js` lama **tidak muncul kembali** (0 temuan).
- `dist/` sinkron dengan source: 47 file JS di paket = 47 file JS di
  `dist/` pada disk = 47 file TS/TSX di `src/` (17 `dist/agent/*.js` +
  30 `dist/*.js` + `dist/ui/*.js`); `dist/agent/confirm.js` tidak ada.

## F. Security Audit

(Tanpa mencetak nilai secret apa pun.)

| Pemeriksaan | Hasil |
|---|---|
| Pola `sk-…` / `hsurr:` / `ghp_` / `gho_` / `AKIA…` / `BEGIN … PRIVATE KEY` / assignment password di worktree (tidak termasuk `.git`, `node_modules`, `dist`, `.bak`, `verify-tui-20261110`) | **0 temuan nyata** |
| File `.env` | Tidak ada di repo |
| Data probe | Tanpa key; config harness berisi dummy `test-key-pty` (diketahui dari audit sebelumnya, pola scan di atas mengonfirmasi tidak ada credential asli) |
| Backup / artefak lokal | Semua ignored; tidak ada di dalam paket npm |
| Source map / file debug | Tidak ada di `dist/` maupun di paket |
| Build tidak sinkron | Tidak ada — 47 file JS dist = 47 file source |
| Dependensi | Lockfile valid (`npm ci --dry-run` up to date); **tetapi** `npm audit` tidak dapat dijalankan (endpoint diblokir kebijakan registry, `403 policy_denied`), jadi kerentanan dependensi **tidak terverifikasi** dalam audit ini (risiko yang dapat diterima, lihat §G) |
| Secret handling di source | Redaction pass mencakup isi block; adapter menolak tools kecuali probe; tidak ada perubahan pada security layer dalam diff ini |

## G. Remaining Risks

### RELEASE BLOCKER

**Tidak ada blocker source atau keamanan.** Satu-satunya kondisi adalah C1
(dokumentasi, satu baris) — lihat §A.

### ACCEPTABLE RISK (terdokumentasi, bukan blocker)

| # | Risiko | Dasar |
|---|---|---|
| R1 | Confirmation gate belum diimplementasikan | Metadata `confirmationPolicy` lengkap, tidak ada kode gate; perintah destruktif yang lolos validator berjalan tanpa konfirmasi. Open item sejak keputusan Reza; bukan regresi |
| R2 | Native tool execution masih probe-only | Loop produksi tidak pernah mengirim `tools`; native SUPPORTED hanya command-r-plus; 14 model UNKNOWN (panel 503), Sonnet/Opus/`methatech` tidak teruji |
| R3 | Model UNKNOWN karena panel 503 | Masalah panel/upstream, bukan CLI; XML fallback terbukti pada 12 model yang menjawab |
| R4 | `kimi-k2.7-code` retired upstream tapi masih terdaftar di `FREE_MODEL_IDS` | Didokumentasikan di README dan audit Fase 9; model sudah tidak ada di katalog live |
| R5 | Usage 3 model tidak konsisten | Panel melaporkan angka inflated untuk gpt-6-astra / gpt-6-luna / grok-4.7 (observasi Fase 9) |
| R6 | `REGISTRY_VERSION` masih 1 | Dampak nol (tidak ada consumer runtime); temuan Fase 10 |
| R7 | MAX mode stub; attachment `layoutBudget` | Didokumentasikan di README sebagai known minor issues |
| R8 | `npm audit` tidak terverifikasi | Endpoint diblokir (`403 policy_denied`); kerentanan dependensi belum diperiksa pada audit ini |
| R9 | Termux live verification masih pending | PTY pada ukuran terminal yang sama adalah proxy; swipe jari / keyboard Android / rotasi layar tetap langkah Reza |

### FOLLOW-UP WORK (bukan blocker, jangan dikerjakan dalam release ini)

| # | Temuan | Lokasi | Status |
|---|---|---|---|
| F1 | Konfirmasi `/help`, `/account`, `/keys`, `/topup`, dan perintah tidak dikenal tidak reset scroll saat PgUp | `src/ui/ChatApp.tsx` case `"help"` (~1294, `pushSystem(HELP_LINES…)` tanpa reset), `"account"` (~1304), `"keys"` (~1314), `"topup"` (~1322), `default` (~1326) — diverifikasi dari source, tidak ada `setScrollOffsetBoth` di sekitar case-case tersebut | Pola laten yang sama dengan Bug 2; sengaja di luar scope perintah perbaikan (hanya /mode, /agent, /init) |
| F2 | Notis `/compact` saat riwayat kosong ("Belum ada percakapan untuk diringkas.") lewat `pushSystem` tanpa reset | `src/ui/ChatApp.tsx:1172`; jalur sukses /compact sudah memanggil `setScrollOffsetBoth(0)` | Di luar dua temuan yang diperintahkan |
| F3 | `pushSystem` global tidak diubah | Sengaja — system notice biasa harus tetap "don't yank while reading" | Keputusan desain yang dipertahankan |

## H. Exact Release File Allowlist

Daftar file yang layak masuk commit v0.1.10. Setiap file memiliki alasan.
Total **13 file** (+ `README.md` bersyarat, lihat catatan):

| File | Alasan |
|---|---|
| `src/agent/slash.ts` | `selectConversationMessages` + `selectExportMessages` (export + rantai compact) |
| `src/ui/ChatApp.tsx` | Model ContentBlock, `isSummary`, reset scroll konfirmasi slash |
| `src/ui/layout.ts` | Type `AssistantBlock`, `flattenMessages` block |
| `test/agent-pty.sh` | Penyesuaian ukuran terminal + komentar |
| `test/layout.test.mjs` | Fixture block + 4 test baru |
| `test/tui-pty.sh` | Skenario s35 + penyesuaian ukuran |
| `test/slash.test.mjs` (baru) | 9 regression test export + compact chain |
| `docs/TUI-INTERACTION-AUDIT.md` (baru) | Audit pra-implementasi ContentBlock |
| `docs/TUI-INTERACTION-VERIFICATION.md` (baru) | Laporan pengujian menyeluruh A–H |
| `docs/RELEASE-AUDIT-FINAL-0.1.10.md` (baru) | Laporan audit ini |
| `package.json` | Versi 0.1.10 |
| `package-lock.json` | Lockfile 0.1.10 (valid, `npm ci --dry-run` up to date) |
| `CHANGELOG.md` | Section `## [0.1.10]` |
| `README.md` (**bersyarat C1**) | Masuk commit **hanya sesudah** baris 238 diperbaiki menjadi 0.1.10; tanpa perbaikan, jangan masukkan README lama yang menyebut 0.1.9 sebagai "full change list" |

## I. Exclusion List

File yang **tidak boleh** masuk release:

| File / pola | Alasan |
|---|---|
| `verify-tui-20261110/` (170 entri) | Harness + bukti probe; artefak audit lokal |
| `.bak-*/` (26 direktori, ~4.9 MB) | Backup lokal, ignored |
| `dist/` | Build output, ignored; diregenerasi oleh `npm run build` |
| `node_modules/` | Dependensi, ignored |
| `methatech-cli-cli-0.1.9.tgz` | Tarball lokal, ignored |
| `src/*.bak-*` (3 file) | Backup file lama, ignored |
| `docs/images/status-before-thinking.ansi.txt`, `docs/images/status-before-working.ansi.txt`, `docs/images/timestamp-p-after-40.png`, `docs/images/timestamp-p-after-80.png` | Artefak lama; sengaja tidak masuk commit 0.1.9; tidak ada link dokumen yang rusak karenanya (dua PNG hanya disebut lewat glob di AGENT-IMPLEMENTATION.md:1933, dua .ansi.txt hanya disebut sebagai file yang dikecualikan di laporan audit 0.1.9) |
| `docs/RELEASE-AUDIT-FINAL-0.1.9.md` | Laporan audit 0.1.9 — arsip audit sebelumnya, bukan bagian commit 0.1.10 |
| `docs/RELEASE-CANDIDATE-AUDIT-0.1.9.md` | Laporan audit RC 0.1.9 — sudah masuk commit 0.1.9, tidak disentuh |

## J. Recommended Release Sequence

1. **Perbaiki C1:** ubah `README.md:238` menjadi "See `CHANGELOG.md` for the full
   0.1.10 change list." (satu baris; hanya file ini yang berubah pada langkah
   ini).
2. **Validasi ulang minimal:** `npm pack --dry-run` — pastikan nama file
   tetap `methatech-cli-cli-0.1.10.tgz` dan isi paket tidak berubah
   (README ada di paket; tidak perlu menjalankan ulang seluruh PTY suite
   untuk perubahan satu baris dokumentasi).
3. **Staging terkontrol berdasarkan allowlist §H** — stage per path
   secara eksplisit; **jangan `git add -A`**.
4. **Periksa staged diff:** `git diff --cached` harus memuat tepat 13 file
   allowlist (+ `README.md` bila C1 sudah diperbaiki); periksa ulang tidak
   ada file dari §I yang ikut; secret re-check pada staged diff
   (pola §F = 0 temuan).
5. **Commit release:** pesan `release: v0.1.10` (+ body singkat bila perlu).
6. **Tag:** `git tag v0.1.10` pada commit release.
7. **Push:** `git push` commit dan tag ke GitHub (repo
   `clickmamaheti-prog/openmethatech`, memakai GIT_ASKPASS helper yang
   sudah ada).
8. **Publish npm via curl PUT** (bukan `npm publish` — client npm gagal
   ECONNRESET dari VM ini; helper `scripts/publish-curl.mjs`, token
   surrogate via `write_npmrc.py`, hanya jalan di Muse VM). Registry
   mengembalikan HTTP 202; `npm view` dapat 404 selama beberapa menit
   (read-side lag) — jangan publish ulang.
9. **Verifikasi registry + instalasi bersih:** `npm view
   @methatech-cli/cli@0.1.10 version` = `0.1.10`; unduh tarball terbitan
   dan periksa isinya (50 file, 0 `confirm.js`, `package.json` versi
   0.1.10, bin `methatech`); `npm install @methatech-cli/cli@0.1.10` di
   direktori bersih dan jalankan `methatech --version` (= 0.1.10).
10. **Verifikasi live Termux oleh Reza** (langkah Reza): instal 0.1.10 di
    Termux dan uji alur agen + TUI seperti verifikasi 0.1.9.

---

**STOP setelah laporan ini.** Tidak ada staging, commit, tag, push, publish,
atau deploy yang dilakukan dalam audit ini. Menunggu persetujuan eksplisit
Reza sebelum tindakan release apa pun.
