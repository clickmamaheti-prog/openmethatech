# Adopsi Pola Freebuff ke MethaTech CLI

Dokumen ini mencatat apa yang diadopsi dari Freebuff, apa yang ditulis
ulang, dan apa yang sengaja TIDAK diadopsi. Tujuannya: atribusi lisensi
yang benar dan jejak keputusan arsitektur.

## Sumber

- **Proyek:** CodebuffAI/freebuff (Freebuff CLI)
- **Commit yang dipelajari:** `5d8bd24`
- **Salinan lokal (referensi saja, bukan dependensi):**
  `~/workspace/freebuff-source/` — JANGAN ubah isinya.
- **Lisensi:** Apache License 2.0 — lihat
  `~/workspace/freebuff-source/LICENSE`
  (http://www.apache.org/licenses/LICENSE-2.0)
- **NOTICE:** Copyright 2025 Codebuff
  (`~/workspace/freebuff-source/NOTICE`)

Laporan studi pola (2026-11-08): `~/workspace/freebuff-study/LAPORAN.md`.
Laporan uji kompatibilitas OpenTUI (2026-11-08):
`~/workspace/compat-test/OPENTUI_COMPAT_REPORT.md`.

## Keputusan arsitektur: TETAP Ink + React (bukan OpenTUI)

Freebuff memakai OpenTUI 0.3.4 di atas Bun. MethaTech TETAP Ink 6.8.0
+ React 19 (Node.js ≥ 20). Yang diambil adalah logika dan polanya,
bukan kode OpenTUI-nya. Implementasi MethaTech ditulis ulang dari nol
untuk Ink; tidak ada salinan verbatim dari file Freebuff, sehingga
tidak ada file MethaTech yang membutuhkan header atribusi Apache.

Bukti spesifik (tes nyata, bukan asumsi — lihat laporan kompatibilitas):

- OpenTUI 0.3.4 (versi Freebuff) TIDAK BISA jalan di Node versi berapa
  pun. Node 24.22.1: `Error: bun-ffi-structs requires Bun or Node.js
  with node:ffi enabled` (`node:ffi` tidak ada di binary 24;
  `node --experimental-ffi` = bad option). Node 26.13: `Node FFI
  backend does not support usize until (yet)` — bundle 0.3.4 memakai
  `usize` di 59 definisi simbol native.
- OpenTUI 0.5.8 dan 0.8.3 JALAN di Node 26.13 tanpa flag (render +
  keypress terbukti), MUSTAHIL di Node 20/24 (`OpenTUI native FFI is
  not available for this runtime yet`). `node:ffi` baru ada sejak
  26.1.0, default-on sejak 26.9.0; Node 26.13 kini LTS.
- "Tidak kompatibel Termux" BELUM terbukti ke arah mana pun:
  Freebuff jalan di Termux karena didistribusikan sebagai binary Bun
  prebuild (bukan Node+npm). Risiko terbuka: (a) apakah build Node
  Termux menyertakan `node:ffi`; (b) `.so` mana yang dipilih npm di
  Bionic (glibc arm64 butuh `libc.so.6` yang tidak ada di Android;
  musl hanya butuh `libc.so`, belum terbukti bisa di-dlopen di
  Bionic); (c) memori executable untuk callback FFI bisa ditolak
  Android.
- Vonis: migrasi penuh ke OpenTUI baru layak bila upgrade ke ≥ 0.5.8
  + paksa Node 26.9+ + lolos tes on-device di Termux Reza. Sampai
  saat itu, adopsi = PORT POLA ke Ink.

## Yang diadopsi (pola/ide, ditulis ulang untuk Ink + React)

| Pola | Asal Freebuff | Implementasi MethaTech |
|---|---|---|
| Satu global keyboard handler berprioritas bernomor, fungsi murni | `cli/src/utils/keyboard-actions.ts` (`resolveChatKeyboardAction`, 494 baris) + `cli/src/hooks/use-chat-keyboard.ts` (satu listener, baca state segar dari store) | `src/ui/keyboard.ts` (`resolveKeyboardAction`, prioritas 0/2/2.5/3/4/5/6/8/10.5/11/14/15/16) + `src/ui/ChatApp.tsx` (dispatcher `handleAtomicKey`, state dibaca dari ref sinkron) |
| Suggestion engine: trigger slash, filter berprioritas, fuzzy match | `cli/src/hooks/use-suggestion-engine.ts` (766 baris: `parseSlashContext` regex `/^(\s*)\/([^\s]*)$/` + `startIndex===0`; `filterSlashCommands` prefix id → substring id → substring deskripsi, dedupe `Set`, highlight indices; `fuzzyMatch` skor gap×10 − consecutive×5 − boundary×15 + posisi awal) | `src/ui/suggestions.ts` (`parseSlashContext`, `filterSlashCommands`, `fuzzyMatch` — skor identik); `src/ui/palette.ts` memakai `filterSlashCommands` (alias `quit` → `exit`) |
| Suggestion window terpusat | `cli/src/components/suggestion-menu.tsx` (`suggestionWindow`: `start = min(max(0, selected − floor((visible−1)/2)), count − visible)`; `maxVisible` 5 compact / 15 bila `terminalHeight > 35` / 10) | `src/ui/suggestions.ts` (`suggestionWindow`, rumus identik; `suggestionMaxVisible` 5/15/10); `src/ui/CommandPalette.tsx` + `src/ui/layout.ts` (`paletteRenderedRows`) |
| Model picker murah→mahal, baris LOCKED dua langkah Enter | `cli/src/components/freebuff-model-selector.tsx` (1902 baris; `sortModelsByPrice` murah→mahal; baris LOCKED untuk model berbayar tanpa plan, Enter pertama penjelasan, kedua buka halaman plans; navigasi gerakkan `focusedId`, Enter/Space commit; tiap baris 2 baris) + `cli/src/state/freebuff-chat-store.ts:49` (`openFreebuffModelPicker`) | `src/ui/picker.ts` (`groupCatalog` FREE dulu + PAID murah→mahal; `isLocked` paid + saldo $0, `lockedExplanation`); `src/ui/ModelPicker.tsx` (baris LOCKED, baris detail ke-2 di bawah baris terpilih); `src/ui/ChatApp.tsx` (Enter pertama penjelasan, kedua buka pay site) |
| Root layout flex + sticky bottom + auto-scroll | `cli/src/chat.tsx:2233` (root `<box column flexGrow 1>`, `<scrollbox flexGrow 1>` + zona bawah `flexShrink 0`); `cli/src/hooks/use-scroll-management.ts` (animasi easeOutCubic 200ms/16ms; page = 0,8 viewport; auto-scroll 50ms setelah messages berubah kecuali user scroll ke atas, ambang dekat-bawah 1 baris; `programmaticScrollRef`); `cli/src/components/scroll-to-bottom-button.tsx` (tombol `↓` di status bar, `theme.info`, hanya bila `!isAtBottom`); scrollbox OpenTUI (track 1 kolom + thumb proporsional, hanya bila tidak streaming/waiting dan overflow); `cli/src/utils/keyboard-actions.ts` (PgUp/PgDn prioritas 14, jalan bahkan saat picker terbuka) | `src/ui/ChatApp.tsx` (root `height={rows}`, area pesan `flexGrow={1}`, zona bawah `flexShrink: 0`); `src/ui/layout.ts` (`windowLines`, `pageScrollOffset` 0,8, `AUTO_SCROLL_DELAY_MS = 50`, `SCROLL_NEAR_BOTTOM_THRESHOLD = 1`, `easeOutCubic` + `SCROLL_ANIMATION_DURATION_MS = 200` / `SCROLL_ANIMATION_FRAME_MS = 16`, `scrollbarThumbRange`); animasi scroll via `setInterval` 16ms di `ChatApp.tsx` (aksi baru membatalkan animasi yang berjalan; auto-scroll tidak menarik view saat animasi berjalan); scrollbar track 1 kolom (`│`, thumb `█`) di kanan area pesan, hanya bila tidak streaming/waiting dan overflow, baris di-rewrap 1 kolom lebih sempit saat track tampil; affordance `↓ PgDn (N baris)` di footer baris 2 warna `theme.secondary` (= Freebuff `theme.info` #a3aed0), hanya bila `!isAtBottom`; `src/ui/keyboard.ts` PgUp/PgDn prioritas 14 mendahului cabang picker (scroll jalan saat picker terbuka); Ink tidak punya ScrollBox, windowing manual dalam baris visual |
| Thinking: blok collapsible + status bar shimmer | `cli/src/components/thinking.tsx` (preview 5 baris terakhir `getLastNVisualLines`, prefix `...`, toggle `•`/`▸`/`▾`, isi italic muted, single `**bold**` < 100 char disembunyikan) + `cli/src/components/status-bar.tsx:175-208` (`ShimmerText` "thinking..." waiting / "working..." streaming / "retrying..."; timer elapsed; tombol `■ Esc` stop) + `cli/src/components/shimmer-text.tsx` + `cli/src/utils/format-elapsed-time.ts` (format `30s`/`1m`/`1m 30s`/`1h`, timer disembunyikan bila 0) | `src/ui/thinking.ts` (`getLastNVisualLines`, `thinkingPreview`, `PREVIEW_LINE_COUNT = 5`, `phaseLabel` lowercase `thinking...`/`working...`/`retrying...`, `generateShimmerPalette` + `shimmerSegments` (palet HSL ±0.22 dari `theme.secondary`, interval 180ms, BOLD 23% pertama / DIM 31% terakhir), `formatElapsedTime` aturan Freebuff); `src/ui/layout.ts` (`flattenMessages` merender blok Thinking SEBELUM jawaban); `src/ui/Thinking.tsx` (shimmer per karakter, bukan sweep hijau); `src/ui/ChatApp.tsx` (status row `justifyContent="space-between"`: shimmer kiri, kanan timer + `■ Esc` (timer disembunyikan bila 0s, tepat `■ Esc` tanpa `to stop`), Ctrl+T toggle semua blok; reasoning dari `delta.reasoning_content` via `src/api.ts` `onReasoning`) |
| Message rendering: garis kiri user + timestamp | `cli/src/components/message-with-agents.tsx:217,258` (border kiri 1 kolom untuk pesan user, `paddingBottom` 1 kecuali pesan terakhir) + `cli/src/components/message-block.tsx:198` (timestamp `[HH:MM]` muted di atas konten) + `cli/src/utils/markdown-renderer.ts` | `src/ui/layout.ts` (`flattenMessages`: prefix `│ ` warna `theme.userLine` untuk pesan user, timestamp `[HH:MM]` muted, pesan AI tanpa garis, `**bold**`/`` `code` `` inline; blok ``` tetap via `src/ui/syntax.ts` tema MethaTech) |
| Welcome / empty state: wordmark + info box + starter | `cli/src/utils/freebuff-wordmark.ts` (varian dipilih yang muat `min(68, terminalWidth-5)`, fallback teks); `cli/src/components/freebuff-chat-header.tsx:74-150` (box border + padding 1: status sesi, plan); `cli/src/components/suggested-prompts.tsx` (3 item, tampil bila `!hasSubmittedFirstPrompt()`, sekali kirim → `markFirstPromptSubmitted()` + hilang permanen, klik = submit langsung; `maxItems=2` bila tinggi compact); `cli/src/chat.tsx:2123` (`shouldCenterInputVertically` bila 0 pesan) | `src/ui/layout.ts` (`bannerLines` MethaTech 5 baris + varian teks bila tidak muat; `welcomeLayout` info box model/saldo; `STARTER_PROMPTS` 3 item Inggris, `1`/`2`/`3` mengirim langsung, `showStarters`); `src/config.ts` (`hasSubmittedFirstPrompt` / `markFirstPromptSubmitted`, persist di `credentials.json`) |
| Input: suggestion di atas input, Enter submit, Shift+Enter newline | `cli/src/components/chat-input-bar.tsx` (595 baris: SuggestionMenu di atas input dalam box yang sama; `MultilineInput maxHeight={floor(terminalHeight/2)}`); `cli/src/components/multiline-input.tsx` (Enter submit, Shift/Alt/Backslash+Enter atau Ctrl+J newline; `onKeyIntercept`) | `src/ui/ChatApp.tsx` (palette + picker di zona bawah yang sama, di atas input; input multiline, `inputRows` dihitung dari draft, maks `floor(rows/2)`; Shift+Enter / Ctrl+J = newline) |
| Footer model · cwd · Chat | `cli/src/components/freebuff-chat-footer.tsx` (`{model} • {effort} · {cwd} · /model to change · Chat: {nama}` + hint `← for history · ? for help`) | `src/ui/ChatApp.tsx` (footer 2 baris: baris 1 model • harga/FREE · cwd · `/model to change` · `Chat: {nama}`; baris 2 usage + scroll + hint `↑↓ history · ? help · Ctrl+C 2x keluar`) |
| Resize reaktif tanpa SIGWINCH | `cli/src/hooks/use-terminal-layout.ts` (breakpoint lebar xs < 50 / sm / md ≥ 100 / lg ≥ 150; tinggi xs < 20 / sm / md ≥ 40; `contentMaxWidth = min(terminalWidth-4, 80)`); TIDAK ada SIGWINCH handler — reaktif via `useTerminalDimensions()` | `src/ui/layout.ts` (`breakpoints`, breakpoint yang sama); `src/ui/ChatApp.tsx` (baca `useStdout().columns/rows` tiap render; TIDAK ada SIGWINCH manual) |
| Bootstrap / cleanup | `cli/src/index.tsx` main() (probe tema OSC sebelum renderer; `loadStoredAuthToken()` paralel, tidak blokir first paint; `createCliRenderer({exitOnCtrlC:false, screenMode:'alternate-screen'})`); `cli/src/utils/renderer-cleanup.ts`, `terminal-watchdog.ts` | Ink mengelola renderer + alternate screen sendiri; urutan yang dipertahankan: kredensial dibaca sebelum render. `exitOnCtrlC: false` HARUS eksplisit di `render()` ChatApp (`src/commands.ts`) supaya Ctrl+C sampai ke resolver — sebelum 2026-11-09 opsi ini tidak ada, jadi Ink (default true) menelan SEMUA Ctrl+C dan cabang Ctrl+C resolver (clear/interrupt/warning) adalah dead code di TUI asli; hanya `models`/`account` (one-shot) yang memakai default (Ctrl+C langsung keluar) |
| Katalog model + fallback, coercion model pensiun ke fallback | `cli/src/chat.tsx`, insiden #1801 | `src/models.ts`, `src/commands.ts`, `src/ui/ChatApp.tsx` (`setModelById`) |
| Tema terpusat satu modul | `cli/src/theme-config.ts` / `use-theme.ts` | `src/theme.ts` (+ `theme.userLine` untuk border pesan user) |
| Command palette (`/` + filter + ↑↓ + Enter + Esc) | `cli/src/components/suggestion-menu.tsx` | `src/ui/palette.ts` + `src/ui/CommandPalette.tsx` |
| Windowing manual percakapan + budget baris dinamis + breakpoint terminal | `cli/src/chat.tsx` (breakpoints), `use-scroll-management.ts` | `src/ui/layout.ts`: `breakpoints`, `wrapText`, `flattenMessages`, `layoutBudget`, `pickerMaxRowsFor`, `pickerRenderedRows`, `paletteMaxRowsFor`, `paletteRenderedRows`, `windowLines`, `pageScrollOffset` |

## Yang TIDAK diadopsi

- **Sistem iklan / admission / Freebucks** — SKIP TOTAL atas perintah
  Reza. MethaTech TUI tanpa iklan. Komponen iklan Freebuff
  (`cli/src/ads/*`, `ad-banner.tsx`, `display-ad-*.tsx`,
  `sponsored-account-prompt.tsx`, dsb.) tidak pernah dibuka untuk
  diadopsi.
- **Backend Codebuff** (auth, billing, subscription, project files) —
  MethaTech memakai panel/API sendiri (`src/api.ts`, `src/config.ts`).
- **OpenTUI / `createCliRenderer` / alternate screen manual** — lihat
  bukti di atas. Ink JS murni dan sudah terbukti jalan di Termux Reza.
- **Sub-agent tree, profile survey, @mention agents, file menu** —
  tidak relevan untuk MethaTech (tidak ada sub-agent tree; agen
  coding lokal SUDAH dibangun dan adalah chat default sejak perbaikan
  agent-as-default — Freebuff `cli/src/commands/router.ts:480`
  "send to agent"). Prioritas keyboard yang merujuk ke sana
  dipetakan ulang: Tab membuka model picker (bukan file menu),
  Ctrl+Q inert (tidak ada queue), Ctrl+T toggle Thinking (bukan
  toggle-all agent).
- **Interaksi mouse, probe OSC** — tidak dikerjakan di fase ini
  (keyboard-only, benar untuk Termux).

## Perbedaan yang terpaksa dipertahankan (karena kompatibilitas)

| Perbedaan | Alasan |
|---|---|
| Ink, bukan OpenTUI (`<Box>`/`<Text>`/`useInput`, bukan `<box>`/`<scrollbox>`/`useKeyboard`) | OpenTUI 0.3.4 gagal di semua Node (bukti di atas); 0.5.8+ butuh Node ≥ 26.9, target MethaTech Node ≥ 20 + Termux |
| Windowing manual, bukan ScrollBox sticky | Ink tidak punya ScrollBox; potong messages ke viewport + auto-scroll 50ms (ambang 1 baris) + animasi easeOutCubic 200ms/16ms via `setInterval` + track scrollbar 1 kolom dengan thumb proporsional + affordance `↓ PgDn` di footer |
| Mouse wheel (OpenTUI scrollbox, ConstantScrollAccel 1 baris/tick) | Ink tidak punya input mouse — tidak ada padanannya; PgUp/PgDn adalah satu-satunya cara scroll di MethaTech |
| Input TIDAK di-center vertikal saat 0 pesan | Freebuff `shouldCenterInputVertically` memindahkan input ke tengah layar; MethaTech mempertahankan kontrak PTY yang sudah ada (input pin di `rows-2`, footer di baris terakhir). Yang diadopsi: BLOK WELCOME di-center vertikal di dalam area pesan, input tetap pin di bawah |
| `Thinking` block hanya muncul bila server mengirim reasoning | API panel MethaTech tidak mengirim `delta.reasoning_content` hari ini (mock server mengirimnya untuk tes); plumbing `onReasoning` sudah ada, blok muncul saat datanya ada — indikator shimmer `thinking...`/`working...` tetap jalan tanpa reasoning |
| Baris picker 1 baris, kecuali baris terpilih (2 baris) | Freebuff tiap baris 2 baris (nama + detail); di terminal 40×15 itu memangkas separuh model yang terlihat — MethaTech hanya melebarkan baris terpilih |
| Mode out-of-credits TIDAK memblokir input | Freebuff memblokir hampir semua input dalam mode itu; MethaTech harus tetap bisa dipakai untuk pindah ke model gratis — guard saldo $0 hidup di send-time + baris LOCKED picker, bukan sebagai mode pemblokir |
| History Up/Down di draft non-kosong = ganti model | Freebuff: panah di draft non-kosong menggerakkan kursor (Ink tidak punya kursor); MethaTech mempertahankan perilaku 0.1.5 (↑↓ ganti model) untuk draft terisi, history hanya dari draft kosong / draft hasil recall |
| Ctrl+C pertama di draft kosong langsung keluar | ~~Freebuff: Ctrl+C pertama = warning, kedua = keluar. MethaTech: sekali Ctrl+C harus keluar bersih (kontrak PTY s6)~~ — SUDAH DISAMAKAN 2026-11-09 (AGENT-IMPLEMENTATION.md §4c): Ctrl+C pertama = warning `Press Ctrl-C again to exit` + flag 2 detik, kedua = keluar; tekan-1 hapus draft (prioritas 3) / hentikan stream (prioritas 4, draft kosong) tetap berlaku |

## Aturan bila ada salinan verbatim di masa depan

Bila suatu saat ada potongan kode Freebuff yang disalin verbatim ke
repo ini, tambahkan header atribusi Apache License 2.0 di file
tersebut, sebutkan file asal dan commit `5d8bd24`, dan catat di tabel
di atas. Sampai 2026-11-08, belum ada salinan verbatim — semua yang
diadopsi adalah pola/ide yang ditulis ulang.

## Session-start block + hapus label "Muse:" (2026-11-08, sesudah adopsi chatbox)

### Label "Muse:" dihapus
Freebuff dan VectorHead menampilkan jawaban asisten LANGSUNG tanpa
label nama (bukti: screenshot VectorHead Reza — jawaban "Halo! Ada
yang bisa saya bantu dengan project ini?" tanpa label; Freebuff
`message-block.tsx` tidak merender label nama untuk asisten).
MethaTech sempat merender `Muse:` hijau sebelum jawaban asisten
(`src/ui/layout.ts:291`). Dihapus: jawaban asisten kini tampil
langsung (teks jawaban saja), tetap setelah blok Thinking bila ada
reasoning. Pesan user tidak berubah (timestamp `[HH:MM]` + border
hijau solid + label `You:`). Test: `test/layout.test.mjs`
(session-start test menegaskan tidak ada `Muse:`) + PTY s21/s22
(`check_absent "Muse:"`).

### Session-start block (VectorHead-style)
Reza menunjukkan screenshot chat VectorHead dengan kotak hijau di
atas layar: `New conversation started (session:
2026-11-08T17-15-36.828Z). Provider set to qwin. Model set to
deepseek-v4.1-flash.` dan meminta hal yang sama di MethaTech
("di awal sebelum masuk tui").

**Temuan dari source Freebuff (jujur):** string `New conversation
started` / `Provider set to` / `Model set to` TIDAK ADA di clone
Freebuff (`cli/src/`, `common/src/`). Yang Freebuff punya di awal
chat adalah `FreebuffChatHeader` (wordmark + info box: `Your first
message starts the session.` + jam tersisa + plan + referral) dan
`FreebuffActiveSessionSummary` (kuota sesi, hanya saat sesi aktif).
Jadi blok teks session-start BUKAN dari Freebuff — ia diadopsi dari
VectorHead (adopsi Freebuff milik Reza sendiri), yang polanya sama:
umumkan sesi + model di awal chat. MethaTech tidak mengklaim ini
sebagai fitur Freebuff.

**DIHAPUS 2026-11-08 ~23:20 UTC** atas perintah Reza ("jangan
tambah-tambah, apa adanya aja kaya Freebuff"): blok session-start
dihapus dari `src/ui/ChatApp.tsx`; skenario PTY s22 diubah menjadi
asersi ketiadaan blok tersebut. Screenshot
`tui-session-start-*.png` adalah bukti sejarah sebelum penghapusan.
Yang tersisa di awal chat adalah header info box Freebuff (wordmark
+ "Pesan pertama memulai sesi." + model + FREE + balance) — itu
padanan Freebuff yang asli.

**Implementasi MethaTech (SEBELUM DIHAPUS)** (`src/ui/ChatApp.tsx`):
- Blok 2 baris, pesan sistem (muted): `New conversation started
  (session: <id ISO, titik-dua jadi strip, gaya VectorHead>).` +
  `Model set to <model> · FREE $0.00 · Balance $<saldo>.` (model
  berbayar memakai teks harga). Tanpa iklan.
- Elemen PERTAMA riwayat chat (di atas pesan user pertama), ikut
  scroll seperti pesan lain. `/clear` mulai sesi baru (id baru,
  model saat ini).
- TIDAK di state `messages` dan TIDAK di atas welcome: percobaan
  pertama (pesan sistem di `messages[0]`, dirender di atas welcome)
  memecahkan 3 hal — welcome terpotong di 40x15 (info box + `Try:`
  hilang), pesan sistem (`?` help) tersembunyi di balik welcome,
  tombol starter 1/2/3 mengetik ke input. Ketiganya kembali hijau
  setelah blok dipindah ke riwayat saja. Welcome tetap utuh dan
  info box-nya sudah mengumumkan model / FREE / balance di awal.

**Bukti:** PTY s22 (`test/tui-pty.sh`), screenshot
`docs/images/tui-session-start-desktop.png` (chat + blok sesi +
jawaban tanpa label) dan
`docs/images/tui-session-start-welcome-desktop.png` (welcome utuh).
