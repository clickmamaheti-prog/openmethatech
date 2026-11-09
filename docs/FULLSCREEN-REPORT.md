# Full-Screen TUI MethaTech CLI — Laporan Implementasi (0.1.6-dev, belum rilis)

Status: **SELESAI, build + test lolos. BELUM publish npm, BELUM commit/push,
BELUM deploy panel.**
Repo: `~/workspace/metatech-cli/`, main `11e5e18` (v0.1.5 live).
Stack tetap: TypeScript + Ink 6.8.0 + React 19 + Node.js + npm (tanpa Bun,
tanpa OpenTUI, tanpa dependensi baru).

Masalah yang diperbaiki (screenshot Reza, Termux): TUI 0.1.5 tidak
full-screen — header + input menumpuk di atas, sisa layar kosong besar,
input tidak di bawah, area kosong warna teal (background terminal),
prompt shell `$ methatech` masih terlihat di atas header.

## Keputusan framework (tetap, sesuai audit)

TETAP Ink + React. OpenTUI 0.3.4 (versi di repo Freebuff) Bun-only;
OpenTUI 0.5.8 butuh Node ≥ 26.4 + `--experimental-ffi`; VM ini Node
24.22.1, target MethaTech Node 20+. Yang diadopsi dari Freebuff adalah
LOGIKA/POLA, bukan kode OpenTUI. Detail + atribusi lisensi:
`docs/ADOPTION.md`.

## File yang diubah / dibuat

Backup sebelum mengubah: `.bak-20261108-fullscreen/` (ChatApp.tsx,
commands.ts, CommandPalette.tsx, tui-pty.sh — di-ignore git).

| File | Perubahan |
|---|---|
| `src/ui/ChatApp.tsx` | Utama. Root `height={rows}` + `width={columns}`; area pesan `flexGrow={1}` + `justifyContent="flex-end"` (satu pola spacer, tanpa spacer Box tambahan); windowing manual lewat `layout.ts`; filler hitam eksplisit (`" ".repeat(columns-2)` berlatar `#000000`) agar viewport kosong tetap hitam; status bar tetap (usage + posisi scroll + hint, baris terakhir); input di `rows−2`; breakpoint Freebuff ganti cek `columns < 60`; PgUp/PgDn scroll riwayat (↑↓ tetap ganti model); hint kosong + hint picker/palette dihitung dalam budget (bungkus teks, bukan 1 baris asumsi); hint status pendek di terminal sempit supaya "Ctrl+C keluar" tidak terpotong |
| `src/ui/layout.ts` | BARU. Logika murni (tanpa Ink/React): `breakpoints` (lebar xs < 50, sm 50–100, md 100–150, lg > 150; tinggi xs < 20, sm 20–40, md > 40), `wrapText`/`wrapLineCount`, `flattenMessages` (pesan → baris visual persis, warna syntax blok kode dipertahankan via `tokenizeCode`), `layoutBudget`, `pickerMaxRowsFor` (dinamis: `rows − fixed − 6` chrome, floor 1, cap 16), `pickerRenderedRows` + `paletteRenderedRows` (hitungan baris persis, sinkron dengan komponen), `pickerHint`/`paletteHint` (bentuk pendek di terminal sempit), `windowLines` (offset 0 = bawah, `isAtBottom` ambang 1 baris), `pageScrollOffset` (page = 0,8 viewport) |
| `src/commands.ts` | HANYA call site `cmdChat`: `process.stdout.write("\x1b[2J\x1b[H")` kini TANPA SYARAT (dulu hanya jalur setelah login). Fungsi login tidak disentuh |
| `src/ui/CommandPalette.tsx` | Tambah prop opsional `maxRows` + windowing `visibleWindow()` (daftar panjang tidak mendorong input keluar viewport); hint via `paletteHint(maxWidth)` |
| `src/ui/ModelPicker.tsx` | Hanya hint via `pickerHint(maxWidth)` (bentuk pendek di terminal sempit). Logika picker tidak berubah |
| `test/layout.test.mjs` | BARU. 11 test unit layout (breakpoint, wrap, flatten, budget, picker/palette rows, windowing, page scroll, hint) |
| `test/tui-bg-probe.py` | BARU. Probe PTY mentah: baca byte yang Ink keluarkan, pastikan tiap baris frame membawa escape background hitam + posisi header/input/footer |
| `test/tui-pty.sh` | Skenario baru s7–s12 (posisi per baris, resize, 30 pesan + PgUp/PgDn, picker/palette 40x15, Thinking/streaming) + helper `row_of`/`check_row`/`check_absent`/`restart_mock` |
| `docs/ADOPTION.md` | BARU. Lisensi/atribusi Freebuff (Apache-2.0, commit 5d8bd24) + tabel adopsi vs tidak diadopsi |
| `docs/images/tui-fullscreen-*.png` | BARU. Screenshot render dari capture tmux asli (ANSI dipertahankan): `small` (40x15), `desktop` (80x24), `scroll` (riwayat 30 pesan, PgUp), `picker-small` (picker 40x15) |

Tidak disentuh (sesuai spek): `src/api.ts`, `src/config.ts`,
`src/models.ts`, `src/cost.ts`, fungsi login di `commands.ts`,
`src/theme.ts`, `palette.ts`, `picker.ts`, `thinking.ts`,
`Thinking.tsx`, `syntax.ts`, `CodeBlock.tsx`, `DiffView.tsx`,
`package.json`. `ModelsScreen.tsx`/`AccountScreen.tsx` sengaja belum
diubah (opsional, menunggu ChatApp terbukti — masih pola lama tanpa
height). Perintah `/` yang sudah ada tidak berubah.

## Hasil build + test

- `npm run build` (tsc strict): **bersih, exit 0**.
- `npm test`: **32/32 pass** (21 lama + 11 layout baru).
- `bash test/tui-pty.sh`: **51/51 PASS** (12 lama + 39 baru):
  - s1–s6 (lama): TUI terbuka, palette, streaming mock, picker, 40 kolom, Ctrl+C — 12/12.
  - s7 posisi: 40x15, 48x20, 80x24, 120x40, 200x50 — header baris 1, input `rows−2`, footer baris terakhir — 15/15.
  - s8 background hitam (probe PTY mentah): 80x24 + 40x15 — semua baris membawa escape background hitam `48;5;16`, tanpa prompt shell — 12/12 cek probe.
  - s9 resize: 80x24 → 80x15 → 80x24, input tetap di bawah, tidak crash — 3/3.
  - s10 percakapan panjang: 30 pesan, hanya N baris terakhir tampil, input tetap baris 23; 1× PgUp tampilkan `pesan 27` + indikator scroll; 9× PgUp sampai `pesan 01`; 10× PgDn kembali ke bawah — 9/9.
  - s11 picker + palette 40x15: picker/palette tidak mendorong input keluar (input tetap baris 14), Esc kembali normal — 6/6.
  - s12 Thinking + streaming: posisi input/footer stabil selama Thinking (delay SSE 3 detik) dan setelah streaming — 4/4.
- Regresi login (mock, non-PTY + tmux): non-TTY tanpa key → pesan jelas + exit 1 tanpa hang; `login --paste` (key divalidasi mock, tersimpan 0600) → lalu `methatech chat` buka TUI — lolos. Jalur device-code approve tidak bisa dites mock ini (mock tidak punya `/api/device/token`); tidak ada skrip tes login di repo (9/9 di laporan 0.1.5 adalah manual).

## Temuan penting saat verifikasi (3 bug tertangkap tes baru)

1. **Budget picker salah 2 baris** — `pickerMaxRowsFor` mengurangi 4 baris
   chrome, padahal chrome picker sebenarnya 6 (gap + judul + hint + 2
   header grup + "N lagi"). Di 40x15 picker meluber 2 baris dan
   mengacaukan render (judul hilang, baris bertumpuk). Perbaikan:
   kurangi 6, floor 1 baris.
2. **Baris hint yang membungkus tidak dihitung** — hint kosong
   ("Ketik pesan…", 57 karakter) membungkus jadi 2 baris di 40 kolom
   tapi budget menghitung 1; hint picker/palette juga membungkus.
   Perbaikan: hint kosong lewat `wrapText` + dihitung barisnya,
   disembunyikan saat picker/palette terbuka; hint picker/palette
   punya bentuk pendek (`pickerHint`/`paletteHint`).
3. **Status bar terpotong di 40 kolom** — hint penuh 62 karakter
   dipotong jadi "Ctrl+C kelua". Perbaikan: hint pendek di
   `contentWidth < 66` + slice status ke `columns − 2`.

## Temuan tmux vs terminal asli (penting untuk verifikasi warna)

- `tmux capture-pane -e` (termasuk `-N`) **tidak bisa** membuktikan
  background hitam pada baris kosong: tmux membuang atribut background
  sel spasi-trailing di grid-nya. Baris filler yang Ink tulis dengan
  `48;5;16` tetap tampil polos di capture tmux.
- Bukti yang benar: **byte mentah PTY** — frame Ink 80x24 dan 40x15
  masing-masing 24/15 baris, SEMUA baris membawa `48;5;16`
  (diperiksa dengan parser byte, bukan emulator layar).
  Probe ini yang dipakai s8 (`test/tui-bg-probe.py`).
- Ink menulis background hitam untuk seluruh viewport: root Box
  `backgroundColor #000000` + filler eksplisit; keduanya terverifikasi
  di byte stream (bukan asumsi).

## Tabel adopsi vs porting (ringkas; lengkap di `docs/ADOPTION.md`)

Dipakai (ditulis ulang untuk Ink): root flex column + scroll area
`flexGrow` + pesan menempel bawah; page scroll 0,8 viewport + ambang
bawah 1 baris; single keyboard handler; katalog + fallback; picker
termurah-dulu; tema terpusat; palette `/`.
Tidak dipakai: iklan/admission/Freebucks (SKIP TOTAL), backend
Codebuff, OpenTUI + alternate screen (ditunda fase 2 bila Reza
minta), mouse, multiline input penuh, Thinking collapsible, probe OSC.

## Keterbatasan yang belum terselesaikan

1. **Belum dites di Termux asli / panel live.** Semua tes memakai mock
   server lokal; verifikasi hitam-penuh di Termux Reza masih menunggu
   dia menjalankan `methatech` 0.1.6-dev di HP-nya.
2. **Alternate screen manual (P2) belum dikerjakan** — keputusan:
   ditunda ke fase 2 bila Reza memintanya. `height + clear-on-entry`
   menyelesaikan gejala yang dilaporkan; tanpa alternate screen, output
   TUI tetap tertinggal di scrollback setelah keluar.
3. **Input sangat panjang (> lebar terminal) masih membungkus** dan
   bisa menggeser footer 1 baris — perilaku lama, belum ditangani
   (butuh truncation/ellipsis input).
4. **Status bar terpotong saat usage + indikator scroll tampil
   bersamaan** di 80 kolom (teks total > 78 kolom, di-slice) — info
   penting (usage + "PgDn ke bawah") tetap terlihat; hint paling
   kanan yang terpotong.
5. **`ModelsScreen`/`AccountScreen` masih pola lama** (tanpa height)
   — belum full-screen; diubah terpisah sesudah ChatApp terbukti.
6. **Jalur device-code approve tidak teruji** di mock ini (tidak ada
   `/api/device/token`); kode login tidak disentuh, jadi risikonya
   hanya dari perubahan `cmdChat` (clear tanpa syarat — sudah dites
   lewat `methatech` polos + `chat` + setelah `login --paste`).
7. **Test mengimpor `dist/`** — `npm run build` wajib dulu sebelum
   `npm test` (sama seperti sebelumnya).
