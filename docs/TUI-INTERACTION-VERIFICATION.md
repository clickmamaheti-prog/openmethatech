# TUI Interaction Verification — ContentBlock (0.1.9 working tree)

**Tanggal:** 2026-11-10
**Repo:** `~/workspace/metatech-cli/`, HEAD `501b073` (0.1.9)
**Yang diuji:** TUI Interaction Fix (ContentBlock) yang belum commit — 5 file diubah (`src/ui/ChatApp.tsx`, `src/ui/layout.ts`, `test/agent-pty.sh`, `test/layout.test.mjs`, `test/tui-pty.sh`) + `docs/TUI-INTERACTION-AUDIT.md`. Backup `.bak-20261110-tui-interaction/`.
**Sifat tugas:** PENGUJIAN SAJA. Tidak ada perubahan source code, tidak ada commit/tag/push/publish/deploy, tidak ada perubahan file test yang sudah ter-commit.

## Ringkasan hasil

| Skenario | Hasil | Cara uji |
|---|---|---|
| A. Normal conversation | PASS | Probe ad-hoc a-80x40, a-40x20 + suite s10 |
| B. Sequential tool calls | PASS | Suite s35 + agent-pty A1 (re-run, bukti diperiksa ulang) |
| C. Parallel tool calls | PASS | Probe ad-hoc c-80x40 |
| D. Streaming panjang | PASS | Probe ad-hoc d-80x24, d-80x40, d2-80x24 |
| E. Tool failure dan rejection | PASS | Probe ad-hoc e-80x40 + agent-pty A2 |
| F. Todos dan status | PASS | Suite s35 + agent-pty A1 (re-run, bukti diperiksa ulang) |
| G. Long conversation | PASS | Probe ad-hoc g-80x40, g-40x20 + suite s10 |
| H. Commands (/export, /compact) | PASS dengan 1 temuan minor pra-ada | Probe ad-hoc h-80x40 + agent-pty A3 |

**Bug yang ditemukan: 0 yang baru, 0 regresi ContentBlock.**
**Temuan minor pra-ada (bukan regresi, sudah ada di HEAD 501b073): 2** — lihat § Temuan.
**NOT TESTED: 0 skenario.** Pengujian Termux fisik tetap menjadi langkah Reza (lihat § Keterbatasan).

## Re-run validasi penuh vs baseline

| Pemeriksaan | Baseline | Re-run (2026-11-10) | Hasil |
|---|---|---|---|
| `npm run build` | bersih | bersih (exit 0) | sama |
| `npx tsc` | bersih (0 error) | bersih (exit 0) | sama |
| `npm test` | 419/419 | **419/419, 0 fail** | sama |
| `test/agent-pty.sh` | 32/32 | **32/32** | sama |
| `test/tui-pty.sh` | 293/293 | **293/293** | sama |

Capture suite re-run: `/tmp/methatech-tui-pty-verify/` (tui-pty) dan `/tmp/methatech-agent-pty-verify/` (agent-pty). Salinan bukti kunci disimpan di `verify-tui-20261110/suite-evidence/` (s35-done-80, s35-mid-80, s35-up-80, a1-toolcall, a2-plan-run).

## Harness probe ad-hoc

Probe PTY ad-hoc (bukan file test baru) memakai mock server sendiri dan driver tmux:

- `verify-tui-20261110/mock-verify.mjs` — mock server port 18097, mode plain / parallel / long / fail / compact. Format SSE sama seperti `test/mock-server.mjs`: chunk 17 karakter tiap 60 ms, chunk terakhir `finish_reason: "stop"` + usage, lalu `data: [DONE]`. Endpoint: `/api/available_model`, `/v1/models`, `/v1/dashboard/billing/subscription`, `/v1/dashboard/billing/usage`, `POST /v1/chat/completions`.
- `verify-tui-20261110/run-probes.sh` — driver tmux; TUI dijalankan sebagai `node dist/cli.js` dengan `METATECH_CONFIG_DIR`, `METATECH_API_KEY=test-key-pty`, `METATECH_API_BASE`, `METATECH_CONSOLE_BASE`.
- Bukti: `verify-tui-20261110/*.plain.txt` + proyek kerja `verify-tui-20261110/proj-*/` (termasuk file export yang dihasilkan probe).

Catatan harness (kesalahan probe saya, bukan bug produk): run pertama probe D memakai sleep 12/16 detik, padahal mock mengalirkan respons ~8,7 KB dengan chunk 17 karakter tiap 60 ms sehingga butuh ~31 detik sampai selesai. Export pertama (d2, 11:12:43) dengan benar berisi stream parsial 84 baris — itu bukti streaming bekerja, bukan kehilangan data. Run diulang dengan sleep 35 detik; bukti "done" yang dipakai di laporan ini adalah run kedua. Capture mid-stream run pertama tetap valid.

## A. Normal conversation — PASS

- **Perintah:** `bash run-probes.sh a-80x40` dan `bash run-probes.sh a-40x20` (4 pesan berurutan, mode plain).
- **Ukuran terminal:** 80x40 dan 40x20.
- **Bukti PTY:** `verify-tui-20261110/a-80x40-1.plain.txt`, `a-80x40-2.plain.txt`, `a-80x40-3.plain.txt`, `a-40x20-1.plain.txt`, `a-40x20-2.plain.txt`, `a-40x20-3.plain.txt`, `a-40x20-4.plain.txt`.
- **Hasil aktual:** 80x40: `You: pesan A1` tetap di baris 3 pada ketiga capture; setiap pesan tepat satu kali; input box di bawah. 40x20: A1 di baris 4 pada capture 1 dan 2 (header membungkus jadi 2 baris di lebar sempit, jadi baris 4 sudah benar); pada capture 3, A1 keluar dari jendela (3 turn × ~4 baris + header 2 + input 5 + footer 2 = 21 > 20 baris — windowing sticky-bottom yang benar, bukan bug); capture 4 menunjukkan A4 terkirim dan terjawab, input tetap bisa dipakai.
- **Expected:** urutan percakapan konsisten; pesan baru tidak mengubah posisi pesan sebelumnya.
- **Perbedaan:** tidak ada.
- **Cakupan:** suite s10 (30 pesan, 80x24) + probe ad-hoc a-80x40/a-40x20.

## B. Sequential tool calls — PASS

- **Perintah:** `test/tui-pty.sh` (skenario s35) dan `test/agent-pty.sh` (skenario A1).
- **Ukuran terminal:** 80x24 (s35), 80x50 (A1).
- **Bukti PTY:** `verify-tui-20261110/suite-evidence/s35-done-80.plain.txt`, `s35-mid-80.plain.txt`, `s35-up-80.plain.txt`, `verify-tui-20261110/suite-evidence/a1-toolcall.plain.txt`.
- **Hasil aktual (diperiksa ulang dari re-run):** s35: urutan teks → tool → teks sesudah tool terpenuhi (cek baris: "Membaca file dulu." sebelum "Read hello.txt", "Read hello.txt" sebelum "Edit file."); a1: teks sebelum read, hasil shell sebelum teks akhir "Selesai". s35-mid-80 dan s35-done-80b byte-identik setelah turn selesai (tidak ada redraw yang mengubah urutan).
- **Expected:** teks → tool pertama → hasil → teks lanjutan → tool kedua → jawaban akhir, semua block sesuai urutan kejadian.
- **Perbedaan:** tidak ada. Catatan jujur yang sudah ada di audit doc: teks final "# Selesai..." dirender DI ATAS block "Task completed" karena loop meng-emit event teks sebelum mem-parse tool call di akhir langkah — TUI merender urutan event dengan setia; mengubahnya berarti mengubah runtime (di luar cakupan).
- **Cakupan:** suite s35 + agent-pty A1; tidak perlu probe ad-hoc.

## C. Parallel tool calls — PASS

- **Perintah:** `bash run-probes.sh c-80x40` (mode parallel, 2 batch paralel).
- **Ukuran terminal:** 80x40.
- **Bukti PTY:** `verify-tui-20261110/c-80x40-done.plain.txt` (run 2, bukti benar); `verify-tui-20261110/c-80x40-done-run1-wrong-param.plain.txt` (run 1, bukti kesalahan probe saya — lihat di bawah).
- **Hasil aktual (run 2):** Batch 1: "Read alpha.txt" (ok, tanpa baris hasil sesuai aturan tool-summary) lalu "Read tidak-ada.txt" dengan error `✗ read_files: cannot read tidak-ada.txt: ENOENT...` tepat di bawah preview-nya sendiri — error TIDAK tertukar ke alpha. Batch 2: "Glob *.txt" → `✓ alpha.txt beta.txt hello.txt (+3 baris)` di bawah Glob; "Search ALPHA" → `✓ alpha.txt:1: ALPHA-001... (+3 baris)` di bawah Search. Urutan kronologis: teks → read → read → teks → glob → search → teks → task completed. Setiap preview tepat satu kali.
- **Expected:** setiap hasil masuk ke block tool yang benar; hasil tidak tertukar walau waktu selesai berbeda.
- **Perbedaan:** tidak ada.
- **Catatan run 1:** saya mengirim `code_search` dengan parameter `query` (salah — skema mewajibkan `pattern`, `src/agent/tool-registry.ts:329-336`, handler `src/agent/tools.ts:280-286`). Produk dengan benar menolaknya: `✗ code_search: pattern: missing required param`. Itu kesalahan probe saya, bukan bug produk.
- **Cakupan:** TIDAK tercakup suite (skrip MOCK_AGENT hanya satu tool per step; wave paralel orchestrator hanya diuji unit) → probe ad-hoc baru c-80x40.

## D. Streaming panjang — PASS

- **Perintah:** `bash run-probes.sh d-80x24`, `bash run-probes.sh d-80x40`, `bash run-probes.sh d2-80x24` (mode long: respons 120 baris + kalimat penutup "Selesai penjelasan panjang.").
- **Ukuran terminal:** 80x24 dan 80x40.
- **Bukti PTY:** `verify-tui-20261110/d-80x24-mid.plain.txt`, `d-80x24-done.plain.txt`, `d-80x40-mid.plain.txt`, `d-80x40-done.plain.txt`, `d2-80x24-done.plain.txt`, `d2-80x24-up1..up9.plain.txt`, `d2-80x24-export.plain.txt`; file export `verify-tui-20261110/proj-d2-80x24/metatech-export-2026-11-10T11-15-46.md`.
- **Hasil aktual:**
  - Mid-stream (4 detik): 80x24 menampilkan 14 baris terakhir stream (baris 005–015), 80x40 menampilkan 17 baris; input box + footer tetap di baris terakhir — teks tumbuh in-place, input tidak terdorong.
  - Done 80x24: jendela menampilkan 14 baris terakhir (107–120) + "Selesai penjelasan panjang."; "Baris panjang 120" tepat 1 kali; footer di baris terakhir; input box utuh.
  - Done 80x40: jendela menampilkan 30 baris terakhir; "Baris panjang 120" tepat 1 kali; "Selesai" tepat 1 kali.
  - Bukti isi penuh (d2): setelah 9× PgUp, baris 001 terlihat tepat 1 kali di `d2-80x24-up9.plain.txt` (indikator "↑ 3 baris di atas" — sudah di puncak riwayat); file export berisi ke-120 baris, "Baris panjang 001" 1 kali, "Baris panjang 120" 1 kali, **0 nomor baris duplikat**, diakhiri "Selesai penjelasan panjang.".
- **Expected:** teks bertambah in-place; tidak ada teks berpindah posisi, terduplikasi, atau tertimpa; seluruh 120 baris tiba tepat satu kali.
- **Perbedaan:** tidak ada. Satu jendela capture tmux hanya menampilkan jendela yang terlihat (14 baris di 80x24) — karena itu bukti "tepat satu kali" diambil dari file export (isi penuh) + halaman PgUp, bukan dari satu capture.
- **Cakupan:** sebagian tercakup suite s12 (stabilitas streaming) → probe ad-hoc baru d-80x24/d-80x40/d2-80x24 untuk stream 120 baris.

## E. Tool failure dan rejection — PASS

- **Perintah:** `bash run-probes.sh e-80x40` (mode fail); penolakan mode Plan juga tercakup agent-pty A2.
- **Ukuran terminal:** 80x40 (probe), 80x50 (A2).
- **Bukti PTY:** `verify-tui-20261110/e-80x40-done.plain.txt`, `verify-tui-20261110/suite-evidence/a2-plan-run.plain.txt`.
- **Hasil aktual:** Kegagalan handler `✗ read_files: cannot read tidak-ada.txt: ENOENT...` di bawah "Read tidak-ada.txt"; kegagalan validasi `✗ str_replace: each replacement needs a non-empty oldString` di bawah "Edit hello.txt" (mock mengirim str_replace berisi path saja tanpa replacements — handler menolaknya); urutan percakapan terjaga; turn berlanjut sampai selesai; input box ada; tidak ada crash. A2: penolakan tool di mode Plan tampil sebagai system line sesudah turn ("unknown or unavailable tool in this mode:..."), bukan menempel ke tool yang salah.
- **Expected:** kegagalan ditampilkan jelas di bawah tool-nya sendiri dan tidak merusak urutan percakapan.
- **Perbedaan:** tidak ada.
- **Cakupan:** penolakan tercakup agent-pty A2; kegagalan handler/validasi TIDAK tercakup suite → probe ad-hoc baru e-80x40.

## F. Todos dan status — PASS

- **Perintah:** `test/tui-pty.sh` (skenario s35) dan `test/agent-pty.sh` (skenario A1).
- **Ukuran terminal:** 80x24 (s35), 80x50 (A1).
- **Bukti PTY:** `verify-tui-20261110/suite-evidence/s35-done-80.plain.txt`, `verify-tui-20261110/suite-evidence/a1-toolcall.plain.txt`.
- **Hasil aktual (diperiksa ulang dari re-run):** s35: daftar "TODOs" tepat 1 kali, di posisi kronologis di dalam turn (2 write_todos dalam satu turn digabung jadi satu list, bukan dua); tidak ada baris status ("working...") yang masuk sebagai pesan percakapan setelah turn selesai (grep "working..." = 0 di capture done). A1: 2 write_todos dalam satu turn, satu list.
- **Expected:** todos tetap di posisi block yang benar; status task tidak masuk sebagai pesan percakapan.
- **Perbedaan:** tidak ada.
- **Cakupan:** suite s35 + agent-pty A1; tidak perlu probe ad-hoc.

## G. Long conversation — PASS

- **Perintah:** `bash run-probes.sh g-80x40` dan `bash run-probes.sh g-40x20` (15 pesan berurutan, mode plain, lalu PgUp, PgDn, lalu kirim pesan baru saat sedang scroll ke atas).
- **Ukuran terminal:** 80x40 dan 40x20.
- **Bukti PTY:** `verify-tui-20261110/g-80x40-long.plain.txt`, `g-80x40-up.plain.txt`, `g-80x40-down.plain.txt`, `g-80x40-new.plain.txt`, `g-40x20-long.plain.txt`, `g-40x20-up.plain.txt`, `g-40x20-down.plain.txt`, `g-40x20-new.plain.txt`.
- **Hasil aktual:**
  - 80x40: satu PgUp menampilkan konten lama (G05–G09) dengan indikator "↑ 19 baris di atas"; PgDn kembali ke bawah (G15 terlihat, G01 tersembunyi); kirim G16 saat scroll ke atas → view snap ke bawah (indikator hilang, G16 terlihat), input tetap bisa dipakai.
  - 40x20: satu PgUp menampilkan G12 dengan indikator "↑ 55 baris di atas" (satu halaman ≈ 3 turn di jendela sekecil ini); kirim G16 → snap ke bawah, input tetap bisa dipakai, composer membungkus jadi 2 baris di dalam kotak dan tetap utuh.
  - Tidak ada pesan hilang atau duplikat di capture mana pun (setiap "You: pesan Gnn" yang terlihat muncul tepat satu kali per capture; "Chat: pesan G01" di footer adalah nama chat, bukan duplikat pesan).
- **Expected:** scrolling, sticky-bottom, dan pemuatan riwayat bekerja; input tetap bisa digunakan; tidak ada kehilangan atau duplikasi pesan.
- **Perbedaan:** tidak ada.
- **Cakupan:** suite s10 (80x24) → probe ad-hoc baru g-80x40/g-40x20 untuk ukuran target lain.

## H. Commands (/export, /compact) — PASS dengan 1 temuan minor pra-ada

- **Perintah:** `bash run-probes.sh h-80x40` (mode compact: 2 turn lalu /compact lalu 1 turn lalu /export).
- **Ukuran terminal:** 80x40.
- **Bukti PTY:** `verify-tui-20261110/h-80x40-compact.plain.txt`, `h-80x40-after.plain.txt`, `h-80x40-export.plain.txt`; file export `verify-tui-20261110/proj-h-80x40/metatech-export-2026-11-10T11-17-57.md`.
- **Hasil aktual:**
  - /compact bekerja: riwayat diganti pesan ringkasan "Ringkasan percakapan:\nRingkasan: pengguna bertanya tentang kucing dan anjing."; turn lama (kucing/anjing) hilang dari transcript; turn baru sesudah compact ("cerita burung" → "Balasan setelah compact: burung makan biji.") bekerja normal.
  - /export bekerja: file dibuat; konfirmasi "Percakapan diekspor ke:\n<path>" tampil di transcript; file berisi turn sesudah compact (user "cerita burung" + assistant "Balasan setelah compact...").
  - **Temuan 1 (minor, pra-ada):** pesan ringkasan compact TIDAK ikut dalam file export (lihat § Temuan).
- **Expected:** penggabungan konten mempertahankan teks percakapan dan tidak merusak data block.
- **Perbedaan:** hanya Temuan 1 di bawah; tidak ada kerusakan block.
- **Cakupan:** /export tercakup agent-pty A3 (/init + /export); /compact TIDAK tercakup suite mana pun → probe ad-hoc baru h-80x40.

## Temuan

Dua temuan minor. **Keduanya sudah ada di HEAD 501b073 (0.1.9) sebelum ContentBlock** — diverifikasi dengan `git show HEAD:src/ui/ChatApp.tsx`. Keduanya BUKAN regresi dari implementasi ContentBlock. Sesuai aturan tugas: dicatat di sini, TIDAK diperbaiki, menunggu persetujuan Reza sebelum ada perubahan.

### Temuan 1 (minor): /export sesudah /compact diam-diam menghilangkan pesan ringkasan

- **Reproduksi:** jalankan 2 turn → `/compact` → 1 turn → `/export` → buka file export.
- **Bukti:** `verify-tui-20261110/proj-h-80x40/metatech-export-2026-11-10T11-17-57.md` berisi hanya turn sesudah compact; pesan "Ringkasan percakapan: ..." tidak ada di file, padahal pesan itu satu-satunya catatan percakapan sebelum compact.
- **File dan fungsi:** `src/ui/ChatApp.tsx` — `compactHistory()` membuat pesan ringkasan dengan `kind: "system"` (baris ~1178; di HEAD: baris 1083); `handleSlash` case `"export"` memfilter `.filter((m) => m.kind === "chat")` (baris ~1245; di HEAD: baris 1151); `src/agent/slash.ts` — `exportConversation()` menulis pesan yang diterimanya apa adanya.
- **Dampak:** file export diam-diam kehilangan seluruh konteks percakapan sebelum compact. Pengguna yang mengekspor sesudah compact mengira mendapat percakapan lengkap, padahal ringkasannya (satu-satunya penghubung ke konteks lama) tidak ada.
- **Penyebab teknis:** pesan ringkasan diberi kind "system" (karena ia pemberitahuan di luar turn), dan filter export hanya mengambil kind "chat". Kind yang sama dipakai untuk dua keperluan yang bertentangan: tampil sebagai system line di TUI (benar) vs ikut diekspor sebagai isi percakapan (tidak ikut).

### Temuan 2 (minor): pesan sistem tidak mengembalikan view yang sedang scroll ke atas, padahal pesan user melakukannya

- **Reproduksi:** di percakapan panjang, PgUp beberapa kali (view scroll ke atas) → jalankan `/export` → perhatikan layar.
- **Bukti:** `verify-tui-20261110/d2-80x24-export.plain.txt` — file export berhasil dibuat (11:15:46), tetapi view tetap di baris 004–018 dengan indikator "↑ 7 baris di atas" dan footer "↓ PgDn ke bawah (108 baris)"; konfirmasi "Percakapan diekspor ke" tidak terlihat sampai PgDn.
- **File dan fungsi:** `src/ui/ChatApp.tsx` — `pushSystem()` (baris ~716; di HEAD: baris 716–721) hanya menambah pesan tanpa mereset scroll; `send()` mereset scroll (`setScrollOffsetBoth(0)`, di HEAD: baris 895) sehingga pesan user baru selalu snap ke bawah — dibuktikan probe G (kirim G16 saat scroll ke atas → snap ke bawah, indikator hilang).
- **Dampak:** konfirmasi /export (dan system line lain) tidak terlihat saat pengguna sedang membaca riwayat di atas; pengguna harus PgDn dulu untuk memastikan perintahnya berhasil. Inkonsisten dengan perilaku pesan user.
- **Penyebab teknis:** tidak ada pemanggilan `setScrollOffsetBoth(0)` di `pushSystem()`, sementara jalur pesan user dan compact memilikinya.

## Keterbatasan pengujian (jujur)

1. **Pengujian Android/Termux fisik TIDAK dapat dijalankan dari VM ini.** PTY pada ukuran terminal yang sama (80x24, 80x40, 40x20) adalah proxy-nya. Perilaku khusus perangkat fisik (swipe jari, keyboard Android, ukuran terminal yang berubah saat rotasi) tetap menjadi langkah Reza. Tidak ada skenario yang dinyatakan PASS berdasarkan pengujian fisik.
2. **Mock server, bukan panel live.** Semua probe ad-hoc memakai mock SSE lokal (chunk 17 karakter tiap 60 ms, pola sama seperti `test/mock-server.mjs`). Latensi jaringan nyata, error panel nyata (mis. 503 upstream), dan perilaku model live tidak tercakup di sini. Probe live Fase 9 (2026-11-10) sudah membuktikan XML tool-call pada 12 model — itu pengujian terpisah, bukan bagian tugas ini.
3. **Satu jendela capture hanya menampilkan jendela yang terlihat.** Untuk stream 120 baris di 80x24, satu capture hanya menunjukkan 14 baris terakhir. Bukti "tepat satu kali" diambil dari file export (isi penuh) + halaman PgUp, bukan dari satu capture.
4. **Mouse/wheel tidak diuji di probe ad-hoc ini.** Scroll via roda mouse sudah tercakup suite (s33/s34 di tui-pty, 293/293 PASS); probe ad-hoc memakai PgUp/PgDn dan keyboard.
5. **Bukti suite re-run ada di /tmp** (`/tmp/methatech-tui-pty-verify/`, `/tmp/methatech-agent-pty-verify/`) — lokasi bawaan harness. Salinan bukti kunci disimpan di workspace (`verify-tui-20261110/suite-evidence/`).

## Pemetaan cakupan

| Skenario | Suite yang ada | Probe ad-hoc baru |
|---|---|---|
| A | s10 (30 pesan, 80x24) | a-80x40, a-40x20 |
| B | s35 (23 cek) + agent-pty A1 | — |
| C | — (MOCK_AGENT satu tool per step; wave paralel hanya unit test) | c-80x40 |
| D | s12 (stabilitas streaming) | d-80x24, d-80x40, d2-80x24 |
| E | agent-pty A2 (penolakan mode Plan) | e-80x40 (kegagalan handler/validasi) |
| F | s35 (2 write_todos, 1 list) + agent-pty A1 | — |
| G | s10 (80x24) | g-80x40, g-40x20 |
| H | agent-pty A3 (/export) | h-80x40 (/compact + /export sesudah compact) |

## Status akhir

- Pengujian selesai untuk semua skenario A–H (atau keterbatasannya dilaporkan jujur di atas).
- 0 bug baru, 0 regresi ContentBlock. 2 temuan minor pra-ada (bukan regresi) tercatat dengan reproduksi + bukti + file/fungsi + dampak + penyebab — **TIDAK diperbaiki dalam tugas ini, menunggu persetujuan Reza.**
- HEAD tetap 501b073 (0.1.9); `git status` bersih kecuali 5 file ContentBlock yang diubah + `docs/TUI-INTERACTION-AUDIT.md` + 4 file gambar lama yang tidak terkait + direktori `verify-tui-20261110/` (harness + bukti probe ini).
- Menunggu instruksi Reza berikutnya.
