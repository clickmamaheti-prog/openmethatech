# MethaTech CLI — Full-Screen Interactive TUI Upgrade (0.1.4, unreleased)

Status: **SELESAI, build + test lolos. BELUM publish npm, BELUM commit/push.**
Repo: `~/workspace/metatech-cli/`, branch main (terakhir 9f8a506).
Stack tetap: TypeScript + Ink 6.8.0 + React 19 + Node.js + npm (tanpa Bun).

## Audit (sebelum implementasi)

- Theme lama tersebar per komponen (warna hardcode di ChatApp/ModelsScreen/
  AccountScreen, background #050807, label `dim`/`muted` tidak konsisten).
- ChatApp lama: satu `useInput` tapi tanpa palette/picker; tidak ada thinking
  indicator; tidak ada syntax highlighting untuk blok kode; header satu baris
  (pecah di tengah kata pada terminal 40 kolom).
- Tidak ada test sama sekali di repo.
- Pola FreeBuff yang diadaptasi (bukan disalin): satu global keyboard handler,
  command registry + router, model picker dengan highlight + scroll,
  status bar/footer dengan model aktif, tema terpusat.
  Referensi: `~/workspace/freebuff-study/LAPORAN.md`.

## File yang berubah

| File | Perubahan |
|---|---|
| `src/theme.ts` | Rewrite: satu sistem theme terpusat. background/surface `#000000`; accent `#39FF14`; accentSecondary `#A3FF5F`; text `#F5F5F5`; secondary `#A0A0A0`; muted `#666666`; error `#FF5555`; warning `#FFD75F`; success `#39FF14`; userLabel `#7DD3FC`; `syntax.*` (keyword/function/string/variable/comment/number/type/punctuation); `agentTheme.*` (fileTree/diff/task/tool/log/confirm); helper `luminance()` + `contrastRatio()` |
| `src/ui/ChatApp.tsx` | Rewrite total: root background `#000000`; header MethaTech + model + FREE/harga + Balance (dua baris otomatis kalau lebar < 60 kolom); pesan assistant per `MessagePart` (teks + `CodeBlock`); footer hint; Thinking indicator; **satu `useInput` pusat** prioritas Ctrl+C → picker → palette → chat; perintah `/account`, `/keys`, `/topup` sebagai pesan sistem; `/model` tanpa arg buka picker; coercion model tak dikenal ke fallback; SSE streaming + billing + FREE label dipertahankan |
| `src/ui/palette.ts` | Baru, logic murni: `COMMANDS` (8 perintah), `filterCommands()` (prefix/substring, case-insensitive), `paletteNextIndex/PrevIndex/ClampIndex` (wrap) |
| `src/ui/picker.ts` | Baru, logic murni: `groupCatalog()` (FREE dulu, PAID urut harga input termurah), `flattenGroups()`, `pickerNext/Prev`, `visibleWindow()` (page-anchoring) |
| `src/ui/thinking.ts` | Baru, logic murni: `nextSweepIndex()`, `sweepSegments()`, `shouldShowThinking()` (hanya saat sending + belum ada delta + tanpa error) |
| `src/ui/Thinking.tsx` | Baru: animasi "Thinking..." sapuan hijau terang di atas teks redup, interval 100 ms |
| `src/ui/CommandPalette.tsx` | Baru, presentasional: pilihan aktif background accent + teks hitam |
| `src/ui/ModelPicker.tsx` | Baru, presentasional: header FREE/PAID, `▸` = model aktif, label harga, scroll |
| `src/ui/syntax.ts` | Baru: tokenizer regex single-pass (`tokenizeLine`, `tokenizeCode`, `splitMessageParts` untuk blok ```) |
| `src/ui/CodeBlock.tsx` | Baru: render blok kode dengan warna syntax theme |
| `src/ui/DiffView.tsx` | Baru: diff viewer (siap coding agent, belum di-wire ke agent apa pun) |
| `src/ui/index.ts` | Baru: barrel export (termasuk `DiffView`) |
| `src/ui/ModelsScreen.tsx`, `src/ui/AccountScreen.tsx` | Migrasi ke token theme baru |
| `src/commands.ts` | Login sukses → otomatis masuk TUI; `methatech` tanpa argumen: ada key → langsung TUI, tanpa key → login dulu lalu TUI; non-TTY → pesan jelas tanpa hang; `cmdChat({ clearScreen })` (layar bersih sebelum Ink render); device-code + `--paste` + penyimpanan kredensial tidak berubah |
| `package.json` | Hanya tambah script `test`: `node --test "test/*.test.mjs"` (`node --test test/` gagal di Node 24.22 VM ini: MODULE_NOT_FOUND) |
| `test/` | Baru: `mock-server.mjs` (mock API zero-dep + `MOCK_SSE_FIRST_DELAY_MS`), `tui-pty.sh` (tmux, 6 skenario), `palette.test.mjs` (8), `picker.test.mjs` (8), `thinking.test.mjs` (5) |
| `docs/images/tui-*.png` | Screenshot render dari capture tmux (desktop, palette, picker, small 40 kolom, thinking) |

Backup file yang diubah: `.bak-20261108-tui/` (theme.ts, ChatApp.tsx, commands.ts,
ModelsScreen.tsx, AccountScreen.tsx).

## Perbaikan dari temuan saat verifikasi (oleh koordinator)

1. **Stale closure di `useInput`** — mode diputuskan dari closure state; tombol cepat
   (tmux send-keys) bisa memproses Enter sebelum re-render. Perbaikan: ref
   sinkron (`inputRef`, `pickerOpenRef`, `pickerSelectedRef`,
   `paletteSelectedRef`) + helper `set*Both`.
2. **Header pecah di tengah kata pada 40 kolom** — header satu baris di-wrap Ink
   secara paksa. Perbaikan: header dua baris otomatis kalau lebar < 60 kolom.
3. **Ink coalescing (akar masalah "/exit butuh Enter dua kali")** — Ink 6
   menggabungkan run karakter yang datang dalam satu chunk menjadi SATU event
   (`"halo\r"`), dan `key.return` hanya true untuk `"\r"` persis (terbukti dari
   `node_modules/ink/build/input-parser.js` + `parse-keypress.js` + docstring
   `useInput`). Enter di akhir chunk cepat/paste tertelan ke dalam teks input.
   Perbaikan: `useInput` memecah run multi-karakter jadi keypress atomik
   (CRLF = satu Return; `\x03` → Ctrl+C; `\x7f`/`\x08` → backspace) dan
   menjalankan tiap atom lewat handler yang sama, berurutan.

## Hasil build + test

- `npm run build` (tsc strict): **bersih, exit 0**.
- `npm test`: **21/21 pass, 0 fail**.
- `bash test/tui-pty.sh` (tmux, mock server): **12/12 PASS**
  - s1 bare `methatech` buka TUI 80x24 (header, model aktif, Balance)
  - s2 palette muncul di `/`, filter `/mod` → /model + /models, Esc menutup
  - s3 kirim pesan → balasan mock ter-stream
  - s4 `/model` → picker, Down + Enter ganti model, TUI tetap hidup
  - s5 terminal 40x15: header tampil, tidak ada teks terpotong
  - s6 Ctrl+C keluar bersih
- Tes manual tambahan (mock delay 3 dtk): **Thinking tampil saat menunggu,
  hilang saat streaming mulai, balasan + usage tampil**; rapid `/exit` + Enter
  dalam satu send-keys → **keluar pada Enter pertama** (sebelum perbaikan:
  butuh Enter kedua). Probe 4 kasus (one-call, split, separate-args,
  halo+Enter) semua lolos setelah perbaikan.
- Tes login/entry (mock panel 127.0.0.1:18099, PTY 120x40, kredensial
  terisolasi): 9/9 PASS — login device-code → TUI, `methatech` tanpa key →
  login → TUI, dengan key → langsung TUI, `--paste` sukses/gagal/kosong,
  device-code ditolak, non-TTY tanpa hang.

## Hasil pengujian wajib (spek §10)

| # | Poin | Hasil |
|---|---|---|
| 1 | Login berhasil langsung buka TUI | PASS (mock panel, 9/9 skenario login) |
| 2 | `methatech` saat sudah login buka TUI | PASS |
| 3 | Background semua komponen benar-benar hitam | PASS (`theme.background` `#000000` di root + semua panel; screenshot) |
| 4 | Warna teks terbaca + konsisten | PASS (satu theme terpusat; screenshot desktop + kecil) |
| 5 | Coding agent pakai palet MethaTech | PASS sebagian — theme + komponen siap (`agentTheme`, `DiffView`, `CodeBlock`, `Thinking`); agent belum dibangun (sesuai spek) |
| 6 | Syntax highlighting terbaca di hitam | PASS (unit test tokenizer + `CodeBlock`; visual live belum — butuh balasan mock berisi blok kode) |
| 7 | Thinking shimmer jalan + berhenti dengan benar | PASS (live tmux, delay 3 dtk) |
| 8 | Command palette muncul saat ketik `/` | PASS |
| 9 | Filtering command jalan | PASS |
| 10 | Arrow Up/Down + Esc jalan | PASS (palette + picker + Esc menutup) |
| 11 | Model picker bisa pilih model | PASS |
| 12 | Model terpilih benar-benar dipakai | PASS (header + pesan sistem `Model aktif: <id>`; dipakai di request berikutnya via `modelRef`) |
| 13 | Layout jalan di Termux + desktop | PASS 40 kolom + 80x24; Termux asli belum dites |
| 14 | Terminal pulih dengan benar setelah ditutup | PASS (Ctrl+C exit 0; raw mode dikembalikan Ink; `askHidden` pulihkan stdin sebelum TUI) |

## Keterbatasan yang belum terselesaikan

1. **Belum dites di Termux asli / panel live.** Semua tes TUI memakai mock
   server lokal; login sukses memakai mock panel (bukan panel live); jalur
   kedaluwarsa kode device-code tidak dites langsung (kodenya return `false`
   seperti jalur ditolak yang sudah dites).
2. **Syntax highlighting belum terlihat di screenshot live** — butuh balasan
   chat berisi blok ``` dari mock (mock saat ini membalas teks biasa).
3. **Picker memakai keberadaan key, bukan validasi live** — sama seperti
   perilaku `methatech chat` sebelumnya; key env tidak valid tetap membuka
   TUI (saldo `—`, kirim chat gagal dengan error API), bukan dialihkan ke login.
4. **Test mengimpor `dist/`** — `npm run build` wajib dulu sebelum `npm test`.
5. **Esc di palette mengosongkan input** (perilaku yang didokumentasikan di
   kode, bukan bug).
6. **Animasi shimmer Thinking** tampil sebagai sapuan hijau terang di atas teks
   redup; di capture statis hanya satu frame yang terlihat.
