# MethaTech CLI — Build Report

**Date:** 2026-11-08
**Status:** Fase chat SELESAI dan teruji. Belum publish ke npm.
**Repo:** `~/workspace/metatech-cli/` (package `@methatech-cli/cli` v0.1.1, PUBLISHED live 2026-11-08; first tried `@methatech/cli`, then renamed to `@metatech-cli/cli` — misspelled, missing the H — then corrected 2026-11-08 to `@methatech-cli/cli` to match Reza's org `methatech-cli`, because the `@methatech` npm org is taken by someone else; v0.1.0 got stuck in npm staging, so 0.1.1 is the first live version)

## 1. Keputusan OpenTUI vs Ink — INK MENANG (terbukti)

Satu-satunya hal yang belum terverifikasi sebelum build adalah apakah OpenTUI
jalan di Node. Hasil tes, Node v24.22.1:

- **OpenTUI 0.3.4 (versi yang dipakai Freebuff): GAGAL.** Modul
  `@opentui/react` mengimpor `react-reconciler/constants` tanpa ekstensi —
  resolver ESM Node menolaknya (`ERR_MODULE_NOT_FOUND`). Jalan di Bun
  karena resolver Bun lebih longgar.
- **OpenTUI 0.8.3 (latest): GAGAL juga.** Impor berhasil, tapi
  `createCliRenderer()` melempar `Failed to initialize OpenTUI render
  library: OpenTUI native FFI is not available for this runtime yet`.
  Penyebab: backend FFI OpenTUI butuh `bun:ffi` (Bun) atau `node:ffi`
  (Node). `node:ffi` TIDAK ADA di Node 24.22.1 di mesin ini
  (`ERR_UNKNOWN_BUILTIN_MODULE`, flag `--experimental-ffi` pun tidak dikenal).
  README OpenTUI sendiri menyatakan: butuh **Node.js 26.4.0+ dengan
  `--experimental-ffi`**. Itu di luar target runtime (Node 20+) dan rapuh
  untuk pengguna Termux — jadi OpenTUI DITOLAK.
- **Ink 6.8.0 + React 19.3.1: JALAN.** Tes render di tmux: layar tampil
  lengkap, input keyboard jalan, `q` keluar dengan exit code 0.

Keputusan: **CLI dibangun dengan Ink.** Tidak ada dependensi Bun di mana pun
(grep `bun` di `src/`, `dist/`, `package.json` = kosong).

## 2. Struktur file

```
~/workspace/metatech-cli/
  package.json          @methatech-cli/cli 0.1.1, bin: metatech -> dist/cli.js
  tsconfig.json         TypeScript strict, jsx react-jsx, outDir dist
  README.md             cara pakai
  BUILD-REPORT.md       laporan ini
  probe-bore-1.py       probe API live (bagian 1: models + billing) — bore-side, tanpa secret
  probe-bore-2.py       probe API live (bagian 2: chat free + paid) — bore-side, tanpa secret
  shot-chat-desktop.png screenshot chat (lebar desktop 100 kolom)
  shot-chat-narrow.png  screenshot chat (sempit 80 kolom, gaya Termux)
  shot-models-desktop.png screenshot daftar model
  src/
    cli.ts              entry (shebang node)
    commands.ts         wiring Commander + login/keys/topup/logout
    config.ts           ~/.config/metatech/credentials.json (0600, dir 0700),
                        env METATECH_API_KEY, METATECH_CONFIG_DIR,
                        METATECH_API_BASE / METATECH_CONSOLE_BASE
    theme.ts            token warna MethaTech (lihat §3)
    models.ts           10 model FREE + harga terkompilasi (fallback) + fetch live
    api.ts              client /v1/chat/completions (SSE), /v1/models, billing
    cost.ts             hitung biaya $ dari usage
    ui/ChatApp.tsx      TUI chat (Ink)
    ui/ModelsScreen.tsx daftar model (Ink)
    ui/AccountScreen.tsx akun + saldo (Ink)
```

Install: `npm install` (46 paket) → `npm run build` (`tsc`) → `dist/`.
Jalankan: `node dist/cli.js ...` (atau `npm link` untuk perintah `metatech`).

## 3. Warna — token identitas MethaTech, eksak

Dipakai di semua layar TUI (chat, models, account, login):

| Token | Nilai |
|---|---|
| background | `#050807` |
| secondary | `#0A100D` |
| aksen lime | `#A3FF45` |
| aksen sekunder | `#78E62E` |
| teks | `#F5F7F5` |
| muted | `#A1AAA4` |
| dim | `#69746D` |

## 4. Perintah yang sudah jalan

| Perintah | Status |
|---|---|
| `metatech login` | JALAN. Tampilkan URL login + halaman token, coba buka browser (best-effort), minta tempel key (input ter-mask `*`, raw mode, key tidak pernah tampil di layar), validasi key sekali lewat `/v1/models`, simpan ke `credentials.json` (0600). |
| `metatech chat [--model <id>]` | JALAN. TUI Ink: header (model + harga/FREE + Balance $), riwayat chat, streaming jawaban, token masuk/keluar + biaya $ per jawaban, `↑↓` ganti model, `/models`, `/model <id>`, `/clear`, `/help`, `/exit`, `Ctrl+C` keluar. Tanpa argumen = chat dengan model default. Model tidak dikenal di-coerce ke fallback (pelajaran insiden Freebuff #1801). |
| `metatech models` | JALAN. Bagian FREE $0.00 (10 model), bagian PAID ($ per 1M in/out + owner), harga live dari `/api/available_model` ($ = rasio × 2), fallback tabel terkompilasi kalau server tidak menjawab, `(live)`/`(offline)` ditandai. |
| `metatech account` | JALAN. Spending limit $, used $, balance $ dari endpoint billing Bearer. Email + free credits TIDAK tersedia lewat endpoint Bearer mana pun — tidak dikarang, layar menampilkan link panel. |
| `metatech keys` | JALAN (jujur, minimal). Menunjukkan status key + URL halaman token panel. |
| `metatech topup` | JALAN. Tampilkan + coba buka `https://pay.methatech.eu.org`. |
| `metatech logout` | JALAN. Hapus `credentials.json`. |

Semua harga dalam dolar ($). Tidak ada angka quota mentah di layar mana pun.
Kata terlarang itu tidak ada di mana pun (grep kosong di `src/`, `dist/`,
`package.json`, `README.md`).

## 5. Hasil tes

### 5.1 Chat live ke API sungguhan (bore-side, token tes Reza, key tidak pernah tampil)

Probe `probe-bore-2.py` (token id 16 "Tes", read-only DB, curl, config 0600
dihapus sesudahnya). Prompt: "What is 2+2? Answer in one word.",
`max_tokens: 20`:

| Model | Jawaban | Usage | Biaya |
|---|---|---|---|
| glm-5.3-flash (FREE) | `4` | 372 in / 3 out | $0.0001 (tarif $0.25/$0.85) |
| glm-5.3-flash, stream + `include_usage` | `Four` (stream) | 372 in / 3 out, usage di chunk SSE terakhir | $0.0001 |
| claude-sonnet-4-6 (PAID) | `Four` | 2019 in / 4 out | $0.0102 (tarif $5.00/$25.00) |

Terbukti: streaming + `stream_options.include_usage` mengembalikan usage di
chunk terakhir (jadi TUI bisa menampilkan token + biaya). Token prompt
terlihat besar karena relay menambah system prompt — itu perilaku API, CLI
menampilkan apa adanya.

Probe `probe-bore-1.py`: `GET /v1/models` (Bearer) mengembalikan 27 model.
`GET /v1/dashboard/billing/subscription` → `hard_limit_usd` dkk.
`GET /v1/dashboard/billing/usage` → `total_usage` dalam **sen**
(terverifikasi: used_quota 191.137 → 38,2274; balance = limit − total/100).
`GET /v1/user/self` TIDAK ADA (`Invalid URL`) — tidak ada endpoint email
lewat Bearer. Token id 9 (token lama di panel) SUDAH STALE (403 invalid token).

### 5.2 Tes CLI end-to-end (mock API lokal, bentuk SSE sama persis dengan live)

Mock server `/tmp/mock-metatech-api.mjs` (127.0.0.1:18099, sudah dimatikan
sesudah tes) meniru bentuk respons live di atas. Hasil:

- `metatech models`: daftar tampil lengkap, 28 model (27 live + kimi-k2.7-code
  yang hanya ada di daftar FREE), harga $ benar semua.
- `metatech account`: Limit $12.5000, Used $4.1000, Balance $8.4000 (sesuai
  data mock) — hitungan balance benar.
- `metatech chat --model glm-5.3-flash`: kirim pertanyaan → jawaban `Four`
  ter-stream → `372 in / 3 out · $0.0001`.
- `metatech chat --model claude-sonnet-4-6`: `2019 in / 4 out · $0.0102`.
- `/models` di dalam chat: daftar inline tampil. `/model <id>`: ganti model.
  `↑↓`: ganti model (glm → qwen3.8-flash → deepseek-v4-flash → …).
  `/clear`: bersihkan layar. `Ctrl+C`: keluar bersih (exit 0).
- `metatech chat --model model-tidak-ada`: `Model model-tidak-ada tidak
  dikenal, memakai deepseek-v4-flash.` (coerce ke fallback).
- `metatech chat` tanpa key: `Belum login. Jalankan: metatech login` (exit 1).
- `metatech login` (mock): key ter-mask `*******************`, file
  tersimpan 0600, `Login berhasil.` Lalu `metatech logout` menghapus file.
- `metatech keys`, `metatech topup`: output benar.

Catatan kecil: sekali, Enter pertama setelah mengetik cepat di tmux tidak
terkirim (kemungkinan race handler input Ink); Enter kedua langsung jalan.
Bukan cacat fungsional — pengetikan manusia normal tidak kena ini.

### 5.3 Screenshot (dicek sendiri sebelum diserahkan)

- Chat desktop (100 kolom): `shot-chat-desktop.png`
- Chat sempit (80 kolom, gaya Termux): `shot-chat-narrow.png` — header
  `claude-sonnet-4-6 · $5.00 / $25.00 per 1M · Balance $8.4000` muat penuh
  di 80 kolom, jawaban + `2019 in / 4 out · $0.0102` tampil.
- Daftar model desktop: `shot-models-desktop.png`

![chat desktop](sandbox://workspace/metatech-cli/shot-chat-desktop.png)

![chat sempit 80 kolom](sandbox://workspace/metatech-cli/shot-chat-narrow.png)

![daftar model](sandbox://workspace/metatech-cli/shot-models-desktop.png)

## 6. Yang BELUM dikerjakan (follow-up terpisah)

1. **Mode agen coding** — FASE LANJUTAN, sengaja tidak dibangun sekarang.
   Butuh: tool baca/tulis file, jalanin perintah, batas langkah, konfirmasi
   sebelum perintah berbahaya (pola Freebuff §8 no. 14–15).
2. **Login browser + polling penuh** — butuh endpoint device-code di panel
   (panel saat ini belum punya). Fase ini: tempel key manual setelah login
   browser. Jangan bangun endpoint panel di repo CLI ini.
3. **Publish npm (`@methatech-cli/cli`)** — JANGAN publish sekarang. Paket
   `private: true`. Reza sudah menyiapkan NPM API token (2026-11-08) yang
   akan masuk lewat Secure Vault nanti; publish hanya sesudah build selesai
   DAN dia bilang go.
4. **Repo vector-agent** (clickmamaheti-prog/vector-agent, privat, adopsi
   Freebuff oleh Reza): TIDAK dibedah dalam-dalam (sesuai catatan: pola
   Freebuff sudah dipelajari lewat laporan). Build tetap di repo ini, repo
   itu tidak diubah.
5. **Akun: email + free credits** tidak bisa tampil lewat Bearer API —
   butuh endpoint panel baru atau login session; untuk sekarang layar akun
   menampilkan link panel.
6. **Harga `kimi-k2.7-code`** tidak ada di `/api/available_model` live
   (model sudah deprecated di panel) — tampil di daftar FREE tanpa harga,
   sesuai data live.

## 7. Cara menjalankan lokal

```sh
cd ~/workspace/metatech-cli
npm install
npm run build
node dist/cli.js login     # tempel key dari panel
node dist/cli.js chat      # chat TUI
node dist/cli.js models    # daftar model
node dist/cli.js account   # saldo
```

Env untuk tes lokal: `METATECH_API_BASE`, `METATECH_CONSOLE_BASE`,
`METATECH_API_KEY`, `METATECH_CONFIG_DIR`.
