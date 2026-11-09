# Laporan Adopsi Freebuff → MethaTech CLI (Ink + React)

Tanggal: 2026-11-08. Repo: `~/workspace/metatech-cli/`, HEAD `11e5e18`
(v0.1.5 live). TIDAK ada publish npm, commit/push, atau deploy panel
dalam pekerjaan ini. Backup file yang diubah:
`.bak-20261108-fullscreen/` (ditambah `src/ui/*`, `src/config.ts`,
`src/api.ts`, `test/tui-pty.sh` versi sebelum adopsi).

## 1. File Freebuff yang dijadikan referensi (commit 5d8bd24)

| File Freebuff | Fungsi yang dipakai |
|---|---|
| `cli/src/utils/keyboard-actions.ts` (494 baris) | `resolveChatKeyboardAction` — resolver murni berprioritas bernomor 0–16 |
| `cli/src/hooks/use-chat-keyboard.ts` | Satu listener global, baca state segar dari store |
| `cli/src/hooks/use-suggestion-engine.ts` (766 baris) | `parseSlashContext` (regex + `startIndex===0`), `filterSlashCommands` (prefix id → substring id → substring deskripsi, dedupe `Set`, highlight indices), `fuzzyMatch` (gap×10 − consecutive×5 − boundary×15 + posisi awal) |
| `cli/src/components/suggestion-menu.tsx` (225 baris) | `suggestionWindow` (item terpilih di tengah), `maxVisible` 5/15/10 |
| `cli/src/components/freebuff-model-selector.tsx` (1902 baris) | Urutan murah→mahal, baris LOCKED dua langkah Enter, navigasi `focusedId`, baris 2 baris |
| `cli/src/state/freebuff-chat-store.ts:49` | `openFreebuffModelPicker` |
| `cli/src/utils/freebucks.ts:85` | `sortModelsByPrice` |
| `cli/src/chat.tsx:2233, 1287, 2119, 2123` | Root flex column + scrollbox `flexGrow 1`, `maxVisible` responsif, `maxHeight = floor(terminalHeight/2)`, `shouldCenterInputVertically` |
| `cli/src/hooks/use-scroll-management.ts` | easeOutCubic 200ms/16ms, page 0,8 viewport, auto-scroll 50ms, ambang dekat-bawah 1 baris |
| `cli/src/components/thinking.tsx` + `cli/src/utils/text-layout.ts` | Blok Thinking collapsible, preview 5 baris terakhir, `...`, toggle `•`/`▸`/`▾`, single `**bold**` < 100 char disembunyikan |
| `cli/src/components/status-bar.tsx:175-208` + `shimmer-text.tsx` | Shimmer `thinking...` / `working...` / `retrying...`, timer elapsed, `■ Esc` stop |
| `cli/src/components/message-with-agents.tsx:217,258` + `message-block.tsx:198` | Border kiri 1 kolom pesan user, `paddingBottom` 1, timestamp `[HH:MM]` muted |
| `cli/src/utils/markdown-renderer.ts` | Markdown pesan |
| `cli/src/utils/freebuff-wordmark.ts` | Wordmark 6 baris + compact 5 baris, varian dipilih yang muat `min(68, terminalWidth-5)` |
| `cli/src/components/freebuff-chat-header.tsx:74-150` | Info box border + padding 1 |
| `cli/src/components/suggested-prompts.tsx` (184 baris) | 3 starter prompt, hilang permanen setelah prompt pertama (`hasSubmittedFirstPrompt` / `markFirstPromptSubmitted`) |
| `cli/src/components/chat-input-bar.tsx` (595 baris) + `multiline-input.tsx` (1239 baris) | SuggestionMenu di atas input dalam box yang sama, Enter submit, Shift/Alt/Backslash+Enter atau Ctrl+J newline, `maxHeight` setengah terminal |
| `cli/src/components/freebuff-chat-footer.tsx` | `{model} • {effort} · {cwd} · /model to change · Chat: {nama}` + hint `← for history · ? for help` |
| `cli/src/hooks/use-terminal-layout.ts` | Breakpoint lebar xs < 50 / sm / md ≥ 100 / lg ≥ 150; tinggi xs < 20 / sm / md ≥ 40 |
| `cli/src/index.tsx` main() + `cli/src/utils/renderer-cleanup.ts`, `terminal-watchdog.ts` | Urutan bootstrap (probe OSC → auth paralel → renderer alternate screen) — hanya polanya yang dicatat, Ink mengelola renderer sendiri |

Tidak ada salinan verbatim kode Freebuff: semua ditulis ulang untuk Ink.

## 2. Komponen asli yang diadopsi (langsung / porting)

- **Resolver keyboard berprioritas** (porting): `src/ui/keyboard.ts`
  (`resolveKeyboardAction`) + dispatcher di `src/ui/ChatApp.tsx`.
  Prioritas 0/2/2.5/3/4/5/6/8/10.5/11/14/15/16; state dibaca dari
  ref sinkron.
- **Suggestion engine + windowing** (porting, skor fuzzy identik):
  `src/ui/suggestions.ts` (`parseSlashContext`,
  `filterSlashCommands`, `fuzzyMatch`, `suggestionWindow`,
  `suggestionMaxVisible`); palette memakai filter ini
  (`src/ui/palette.ts`, alias `quit` → `exit`).
- **Model picker** (porting): `src/ui/picker.ts` (`isLocked`,
  `lockedExplanation`) + `src/ui/ModelPicker.tsx` (baris LOCKED,
  baris detail ke-2 di bawah baris terpilih).
- **Root layout + scrolling** (porting, windowing manual):
  `src/ui/layout.ts` (`windowLines`, `pageScrollOffset`,
  `AUTO_SCROLL_DELAY_MS = 50`, `SCROLL_NEAR_BOTTOM_THRESHOLD = 1`).
- **Thinking** (porting): `src/ui/thinking.ts`
  (`getLastNVisualLines`, `thinkingPreview`, `PREVIEW_LINE_COUNT = 5`,
  `phaseLabel`, `toggleThinkingState`) + `src/ui/Thinking.tsx`
  (shimmer) + render blok di `src/ui/layout.ts` (`flattenMessages`).
  Reasoning dari `delta.reasoning_content` (`src/api.ts`
  `onReasoning`).
- **Message rendering** (porting): border `│ ` (`theme.userLine`),
  timestamp `[HH:MM]`, inline `**bold**`/`` `code` ``, blok ```
  tetap syntax highlight tema MethaTech.
- **Welcome / empty state** (porting): wordmark `bannerLines`,
  info box, `STARTER_PROMPTS` 3 item Inggris (kunci `1`/`2`/`3`
  mengirim langsung), persist `firstPromptSubmitted` di
  `src/config.ts`.
- **Input + footer** (porting): palette/picker di zona bawah yang
  sama di atas input; input multiline (maks `floor(rows/2)`);
  Shift+Enter / Ctrl+J newline; footer 2 baris model · cwd · Chat.
- **Resize reaktif** (langsung polanya): `breakpoints` yang sama,
  tanpa SIGWINCH manual.

## 3. Perubahan di MethaTech (file)

- BARU `src/ui/keyboard.ts`, `src/ui/suggestions.ts`
- BARU `test/keyboard.test.mjs`, `test/suggestions.test.mjs`
- BARU `test/render-ansi-png.py` (render capture tmux ANSI → PNG)
- UBAH `src/ui/ChatApp.tsx` (dispatcher resolver, history Up/Down,
  interrupt abort, timer elapsed, footer 2 baris, starter 1/2/3,
  auto-scroll 50ms, input multiline, guard saldo $0 di send-time)
- UBAH `src/ui/layout.ts` (timestamp + border + inline Markdown +
  blok Thinking di `flattenMessages`; starter Inggris; baris detail
  picker terpilih; `paletteRenderedRows` pakai `suggestionWindow`;
  konstanta scroll)
- UBAH `src/ui/palette.ts` (filter prioritas Freebuff),
  `src/ui/picker.ts` (`isLocked`, `lockedExplanation`),
  `src/ui/ModelPicker.tsx` (LOCKED + detail),
  `src/ui/CommandPalette.tsx` (`suggestionWindow`),
  `src/ui/thinking.ts` (preview + fase + label),
  `src/ui/Thinking.tsx` (prop `label`),
  `src/ui/index.ts` (ekspor modul baru)
- UBAH `src/api.ts` (`streamChat` opsi `signal` + `onReasoning`),
  `src/config.ts` (`firstPromptSubmitted` + helper),
  `src/theme.ts` (`theme.userLine`)
- UBAH `test/layout.test.mjs`, `test/picker.test.mjs`,
  `test/thinking.test.mjs` (ekspektasi baru + tes Thinking block,
  timestamp, inline Markdown, LOCKED, starters),
  `test/mock-server.mjs` (`MOCK_REASONING=1` mengirim
  `reasoning_content`), `test/tui-pty.sh` (footer 2 baris +
  skenario 15–20), `test/tui-bg-probe.py` (input di `ROWS-2`)
- UBAH `docs/ADOPTION.md` (tabel adopsi lengkap + bukti
  kompatibilitas + perbedaan yang dipertahankan)

## 4. Perbedaan yang terpaksa dipertahankan (dengan bukti spesifik)

Lihat `docs/ADOPTION.md` bagian "Perbedaan yang terpaksa
dipertahankan". Ringkasnya: tetap Ink karena OpenTUI 0.3.4 gagal di
semua Node (`bun-ffi-structs` butuh `node:ffi`, lalu `usize` tidak
didukung di 59 definisi simbol — Node 24.22.1 dan 26.13, tes nyata
`~/workspace/compat-test/OPENTUI_COMPAT_REPORT.md`); 0.5.8/0.8.3
butuh Node ≥ 26.9 (target MethaTech Node ≥ 20 + Termux, dan
kompatibilitas Termux/Bionic belum terbukti). Windowing manual
karena Ink tidak punya ScrollBox. Input tidak di-center vertikal
(kontrak PTY: input pin di `rows-2`). Baris picker 1 baris kecuali
yang terpilih. Mode out-of-credits tidak memblokir input (guard di
send-time + LOCKED). Label waiting `Thinking...` dipertahankan
(kapital T, sudah di-assert PTY). Ctrl+C pertama di draft kosong
langsung keluar (kontrak PTY s6); double-tap berlaku sebagai
hapus-draft/hentikan-stream dulu, tekan kedua keluar. Blok Thinking
hanya muncul bila server mengirim reasoning (panel hari ini tidak
mengirim `reasoning_content`; plumbing sudah ada).

## 5. Bukti screenshot

Render PNG dari capture tmux asli (ANSI dipertahankan,
`test/render-ansi-png.py`), di `docs/images/`:

- `tui-adopt-welcome-desktop.png` — welcome 80×24
- `tui-adopt-welcome-small.png` — welcome 40×15
- `tui-adopt-chat-desktop.png` — percakapan (border `│ ` user,
  timestamp `[HH:MM]`, footer 2 baris)
- `tui-adopt-palette.png` — palette `/`
- `tui-adopt-picker.png` — picker (grup FREE/PAID, baris detail)
- `tui-adopt-thinking.png` — `Thinking...` + timer + `■ Esc`
- `tui-adopt-thinking-block.png` — blok Thinking reasoning sebelum jawaban
- `tui-adopt-resize-small.png` — resize 80×15, input tetap pin
  (di-render ulang dari run final setelah perbaikan quirk resize,
  lihat §7).

## 6. Hasil build + test

- `npm run build` (tsc strict): bersih.
- `npm test`: 64/64 lolos (baru: `test/keyboard.test.mjs` 15 tes
  prioritas resolver, `test/suggestions.test.mjs` 6 tes trigger /
  filter / fuzzy / window / maxVisible; tambahan tes Thinking
  preview, LOCKED, timestamp, inline Markdown, starters).
- `bash test/tui-pty.sh` (run final `/tmp/methatech-tui-pty5`,
  2026-11-08): **PASS=78 FAIL=0**, termasuk s9 shrink 80×24 →
  80×15 (input baris 13, footer baris 15) dan grow back ke 80×24,
  plus bg-probe 6/6 di kedua ukuran.

## 7. Quirk resize-shrink Ink 6 — ditemukan dan diperbaiki

Gejala: setelah shrink 80×24 → 80×15, frame rusak dan PERSISTEN
(header hilang, baris pertama banner lama), padahal fresh start
di 80×15 benar dan grow back benar; keystroke apa pun memperbaiki
frame. Penyebab, di-root-cause ke source Ink
(`node_modules/ink/build/ink.js`, handler `resized()`): handler
itu hanya me-render ulang tree yang sudah ter-commit dan hanya
mengupdate lebar Yoga root — ia tidak pernah menjalankan ulang
komponen, jadi shrink yang hanya mengubah tinggi (lebar tetap)
tidak pernah memperbarui prop root `height={rows}` dan Ink terus
mengirim frame lama yang lebih tinggi ke terminal yang lebih
pendek sampai ada state change yang memaksa render React.
Percobaan yang GAGAL: timer 50ms keyed `[columns, rows]`
(chicken-and-egg: effect hanya jalan setelah render, padahal
render itulah yang tidak terjadi) dan clear-screen `\x1b[2J`
di timer yang sama. Perbaikan yang BERHASIL
(`src/ui/ChatApp.tsx`): dengarkan event `resize` stdout secara
langsung (`stdout.on("resize", …)`) dan bump state tick — listener
menyala saat SIGWINCH terlepas dari render, render paksa itu lalu
membaca `stdout.rows` yang segar. Diverifikasi: capture 1 detik
setelah shrink kini menampilkan header baris 1, wordmark kompak,
info box, input baris 13, footer baris 14–15; PTY final 78/78.
Freebuff tidak pernah kena ini: OpenTUI melukis ulang seluruh
layar saat resize.
