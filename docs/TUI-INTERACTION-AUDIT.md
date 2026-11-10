# TUI Interaction Audit — Freebuff Source vs MethaTech 0.1.9

Tugas: perbaiki perilaku interaksi dan rendering percakapan MethaTech CLI TUI
(perintah Reza 2026-11-10, dari screenshot live Termux 0.1.9).
Target: kesetaraan perilaku dengan source Freebuff asli, bukan desain baru.

Aturan kerja: backup dulu, NO commit/push/deploy/publish, NO bump versi,
NO ubah Universal Agent Runtime, skill, atau logika pemanggilan model.

---

## BAGIAN A — SEBELUM IMPLEMENTASI (audit)

### A.1 File dan komponen Freebuff yang dijadikan referensi

Clone: `~/workspace/freebuff-source/`, commit 5d8bd24. Semua dibaca dari
source langsung, bukan README/dokumentasi.

| File Freebuff | Yang dipelajari |
|---|---|
| `cli/src/chat.tsx` (2520 baris) | Root layout: `<box>` kolom, `<scrollbox>` flexGrow 1 `stickyScroll` `stickyStart="bottom"`, `scrollX={false}`, `scrollbarOptions={{visible: false}}`, vertical scrollbar hanya saat `!isStreaming && !isWaitingForResponse && hasOverflow`; content `flex-start` (Freebuff top-anchored), paddingLeft 1, paddingRight 2. Di bawah scrollbox SATU `<box flexShrink: 0>` berisi urutan tetap: SuggestedPrompts, iklan/survey, HelpBanner, StatusBar, lalu SATU dari AdReportPrompt / ChatControls / ReviewScreen / QueuePanel / TodoPanel / ChatInputBar, lalu FreebuffChatFooter. |
| `cli/src/types/chat.ts` | `ChatMessage = {id, variant, content, blocks?, timestamp, parentId?, agent?, isComplete?, metadata?, ...}`; variant = user \| ai \| agent \| error \| system. `ContentBlock` union: text, thinking, tool, agent, agent-list, ask-user, image, mode-divider, plan, html, sponsored-proposal. |
| `cli/src/hooks/use-chat-messages.ts` | `MESSAGE_BATCH_SIZE = 6` pesan top-level terlihat; `visibleTopLevelMessages = topLevelMessages.slice(-visibleMessageCount)`; LoadPreviousButton muat 6 lagi. Collapse toggle set flag `isUserCollapsing` (reset setTimeout 0) yang menahan auto-scroll. |
| `cli/src/utils/message-tree-utils.ts` | `buildMessageTree`: pesan dengan `parentId` jadi child dari parent-nya (Map); sisanya top-level. |
| `cli/src/components/message-with-agents.tsx` (506 baris) | Satu pesan top-level (MessageBlock) lalu agent children DI BAWAHNYA dalam AgentChildrenGrid di box parent yang sama; `paddingBottom: isLastMessage ? 0 : 1` antar pesan. User message: garis vertikal solid lebar 1 (marginTop/Bottom 0, merentang SELURUH pesan termasuk baris timestamp) + content box SIDE_GUTTER = 1. AI message: tanpa garis vertikal. |
| `cli/src/components/message-block.tsx` (346 baris) | Timestamp `[HH:MM]` DIM tepat di atas teks user (tanpa gap); bila `blocks` ada → BlocksRenderer, bila tidak → UserContentWithCopyButton; attachment user di bawah pesan; AI message dapat MessageFooter (waktu selesai, credits); `isLoading = isAi && content === '' && !blocks && isWaitingForResponse`. |
| `cli/src/components/blocks/blocks-renderer.tsx` | `processBlocks` mengelompokkan block CONSECUTIVE sejenis: reasoning → ThinkingBlock, tool berurutan → ToolBlockGroup, implementor → ImplementorGroup, agent → AgentBlockGrid, sisanya SingleBlock. Handler stabil (empty deps) membaca props terbaru dari ref. Block APPEND-ONLY selama streaming. |
| `cli/src/components/blocks/tool-branch.tsx` | `isStreaming` dari `streamingAgents.has(toolCallId)`; `isCollapsed` default; preview = 3 baris terakhir input+output, prefix `...` bila lebih; toggle via onToggleCollapsed(toolCallId). |
| `cli/src/hooks/use-send-message.ts` + `cli/src/hooks/helpers/send-message.ts` | SATU shell AI message per turn: `createAiMessageShell(aiMessageId)`, di-append SEKALI via `setMessages(prev => [...autoCollapsePreviousMessages(prev, aiMessageId), aiMessage])` — digabung dengan auto-collapse pesan sebelumnya dalam satu update atomik anti-flicker. |
| `cli/src/utils/message-updater.ts` | `createBatchedMessageUpdater(aiMessageId, setMessages)`: chunk stream meng-update pesan ITU di tempat BERDASARKAN ID — block di-append sesuai urutan kedatangan (text, tool, text, tool...), flush berkala per interval, satu copy array block per flush. Abort handler update pesan yang sama di tempat (markRunningAgentsAsCancelled + appendInterruptionNotice) lalu tandai complete. |
| `cli/src/utils/status-indicator-state.ts` + `cli/src/components/status-bar.tsx` (362 baris) | `getStatusIndicatorState` SATU-SATUNYA sumber kebenaran status, prioritas: ctrlC > clipboard > reconnected > retrying > capacityWait > connecting > waiting > streaming > paused (ask_user aktif, timer beku) > idle. StatusBar SATU baris tetap di bawah scrollbox, di atas input: zona kiri teks status (shimmer "thinking..."/"working..." SHIMMER_INTERVAL_MS 160, "retrying..." warning, "high demand — in line, starting soon..." warning), zona kanan timer elapsed (hanya saat waiting/streaming/paused, sembunyi saat 0; formatElapsedTime: <60s "Xs", 60–3599s "Xm [Ys]", 3600s+ "Xh [Ym]") + tombol `■ Esc` (hanya saat waiting/streaming) + ScrollToBottomButton (hanya saat !isAtBottom). Background abu saat ada konten. Idle tampilkan info BYOK/sesi atau kosong. |
| `cli/src/hooks/use-scroll-management.ts` (206 baris) | OpenTUI ScrollBox `stickyScroll`/`stickyStart="bottom"` menjaga view menempel; `isAtBottom` dari event perubahan scrollbar, threshold SCROLL_NEAR_BOTTOM_THRESHOLD = 1; auto-scroll hanya bila `autoScrollEnabledRef` true (user scroll ke atas mematikannya sampai kembali ke bawah); auto-scroll tertunda 50ms setelah pesan berubah (AUTO_SCROLL_DELAY_MS 50); page scroll = 0.8 viewport (PAGE_SCROLL_FRACTION 0.8); animasi easeOutCubic 200ms ~60fps. |
| `cli/src/hooks/use-message-queue.ts`, `cli/src/hooks/use-chat-streaming.ts` | Antrian pesan user; status stream: `waiting` → `streaming` → `idle`; `isWaitingForResponse`, `isStreaming`, `timerStartTime` dari runtime; `streamMessageIdRef` melacak id pesan yang sedang di-stream. |
| `cli/src/components/tools/read-files.tsx`, `cli/src/components/tools/run-terminal-command.tsx` | ReadFilesComponent hanya render `Read <paths>` — isi file TIDAK PERNAH tampil; TerminalCommandDisplay maxVisibleLines 5, expandable. |

Prinsip Freebuff yang relevan (ringkas):
1. **Satu pesan AI per turn, berisi block berurutan append-only.** Tool call
   adalah block DI DALAM pesan AI itu, bukan pesan terpisah.
2. **Stream update in place by id.** Pesan tidak pernah berpindah posisi;
   hanya isinya yang tumbuh, sesuai urutan kedatangan.
3. **Status BUKAN pesan.** Status hidup hanya di satu baris tetap
   (StatusBar) di bawah scrollbox, di atas input, dari satu state machine
   berprioritas.
4. **System message hanya untuk pemberitahuan di luar alur turn**
   (error, consent, compact, session-end); interupsi turn ditempel ke
   dalam block pesan AI-nya sendiri, bukan pesan baru.
5. **Scrollbox sticky-bottom + windowing 6 pesan** menjaga view stabil;
   pesan lama tidak di-render ulang penuh setiap frame.

### A.2 File MethaTech yang perlu disesuaikan

| File MethaTech | Peran saat ini |
|---|---|
| `src/ui/ChatApp.tsx` (1905 baris) | `DisplayMessage` (kind chat/system/tool/todos), `send()` (buat pesan assistant kosong di awal turn), `appendAssistantText` (cari mundur pesan assistant terakhir), `pushTool` (pesan tool top-level terpisah), `appendToLastTool` (hasil ke pesan tool terakhir), `upsertTodosMessage` (replace in place), `pushSystem`, status row, input, footer. |
| `src/ui/layout.ts` (1156 baris) | `flattenMessages` (pre-wrap SEMUA pesan jadi baris visual), `windowLines` (iris N baris terakhir + scrollOffset), budget layout. |
| `src/ui/thinking.ts` (371 baris) | Shimmer + formatElapsedTime + statusRightItems — sudah setara Freebuff, TIDAK diubah. |
| `src/ui/tool-summary.ts` (54 baris) | Ringkasan hasil tool — sudah setara Freebuff (§4m), TIDAK diubah. |
| `src/ui/markdown.ts` (952 baris) | Render markdown per bagian — sudah diadopsi (§4h), TIDAK diubah. |
| `src/agent/loop.ts`, `src/agent/tool-orchestrator.ts`, runtime lain | TIDAK DIUBAH (aturan tugas). Event `tool_call`/`tool_result`/`todos`/`text` tetap seperti sekarang. |

### A.3 Perbedaan mekanisme keduanya

| Aspek | Freebuff | MethaTech 0.1.9 |
|---|---|---|
| Unit percakapan per turn | SATU pesan AI berisi block berurutan (text, tool, text, tool...) | Daftar FLAT pesan top-level: 1 pesan assistant (semua teks) + N pesan tool terpisah + 1 pesan todos terpisah |
| Urutan teks vs tool | Urutan kedatangan dipertahankan di dalam pesan (text → tool → text) | SEMUA teks turn (termasuk teks yang model hasilkan SETELAH tool jalan) dirender DI ATAS semua tool call |
| Update saat streaming | In place by id, batched per interval, satu pesan | Teks di-append ke pesan assistant lama (posisi tetap) tapi pesan tool baru di-append di bawahnya — posisi relatif teks vs tool salah |
| Tool result | Menempel pada block tool-nya sendiri (per toolCallId) | Menempel pada pesan tool TERAKHIR (`appendToLastTool`) — pada batch paralel (wave), SEMUA onCallStart jalan dulu baru semua onCallResult, jadi hasil call pertama menempel ke pesan tool kedua (salah) |
| Todos | Block di dalam pesan AI turn itu | Pesan top-level terpisah, di-replace in place di posisi PERTAMA kali dibuat — bisa berakhir DI ATAS teks/tool yang datang sesudahnya |
| Status | Satu baris tetap, satu state machine berprioritas, tidak pernah jadi pesan | Baris status sudah tetap (§4k, setara) — bagian ini SUDAH benar |
| System/notice | System message hanya untuk hal di luar turn; interupsi masuk ke block pesan AI | `pushSystem` ("Agen berhenti:...", notice auto-compaction, pertanyaan ask_user) masuk daftar flat yang sama — posisinya benar (setelah turn) tapi ask_user seharusnya block di dalam pesan AI (Freebuff AskUserContentBlock) |
| Scroll | ScrollBox sticky-bottom native + windowing 6 pesan top-level | Windowing manual: flatten SEMUA pesan tiap render lalu iris N baris terakhir (Ink tidak punya scrollbox) — benar sebagai pengganti, tapi setiap insert menggeser semua baris di bawahnya |
| Render ulang | Block append-only; ad/posisi stabil karena posisi node | Re-flatten penuh tiap render; teks tidak terduplikasi (window slice deterministik) tapi urutan kronologis sudah salah sejak struktur datanya |

### A.4 Penyebab teknis masalah saat ini

**PENYEBAB UTAMA (inti keluhan Reza — teks di atas, tool di bawah):**
`send()` di `src/ui/ChatApp.tsx` membuat SATU pesan assistant kosong di awal
turn. `appendAssistantText` meng-append SETIAP delta teks dengan mencari mundur
pesan assistant terakhir berkind `"chat"`. Tool call di-push sebagai pesan
top-level TERPISAH (`pushTool`, kind `"tool"`) SETELAH pesan assistant itu, dan
hasil di-append ke pesan tool terakhir (`appendToLastTool`). Maka dalam satu
turn multi-step, urutan array selalu:

`[user, assistant(teks, terus tumbuh), tool1, tool2, ...]`

Semua teks assistant — termasuk teks yang model hasilkan SETELAH tool berjalan —
dirender DI ATAS semua tool call, tanpa peduli urutan kedatangan sebenarnya.
Di Freebuff, tool call adalah block DI DALAM pesan AI yang sama, di-append
sesuai urutan kedatangan (text, tool, text, tool), sehingga turn terbaca
dalam urutan sebenarnya dan pesan tidak pernah berpindah posisi.

Bukti dari mock MOCK_AGENT (script 6 langkah): satu turn menghasilkan teks
"Buat daftar tugas dulu." → write_todos → "Membaca file dulu." → read_files →
"Edit file." → str_replace → ... tetapi render 0.1.9 menampilkan keenam
teks dulu, baru keenam tool call di bawahnya. Test PTY lama (agent-pty A1)
hanya memeriksa KEBERADAAN elemen, bukan URUTANNYA — itu sebabnya bug ini
lolos.

**PENYEBAB KEDUA (hasil tool menempel ke tool yang salah pada batch paralel):**
`executeToolCalls` (tool-orchestrator.ts) menjalankan wave paralel via
`Promise.all`: SEMUA `onCallStart` (→ `pushTool`) jalan sebelum SEMUA
`onCallResult` (→ `appendToLastTool`). Untuk wave [list_directory, glob]:
pushTool A, pushTool B, lalu hasil A menempel ke B, hasil B menempel ke B.
Hasil tool pertama salah alamat. (Untuk read_files yang sukses dampaknya
tidak terlihat karena ringkasannya null — §4m — tapi untuk tool lain yang
punya baris hasil, salah tempel ini nyata.)

**PENYEBAB KETIGA (TODOs bisa mengambang di atas konten yang lebih baru):**
`upsertTodosMessage` me-replace pesan todos DI TEMPATNYA (indeks pertama kali
dibuat). Update todos berikutnya tidak memindahkan posisinya, sementara teks
dan tool baru terus di-append sesudahnya — daftar TODOs bisa tampil DI ATAS
teks/tool yang datang sesudahnya. Di Freebuff, todos adalah block di dalam
pesan AI turn itu, jadi selalu berada di posisi kronologisnya.

**PENYEBAB KEEMPAT (notice turn masuk ke alur percakapan):**
`pushSystem` ("Agen berhenti: ...", notice auto-compaction, pertanyaan
ask_user) dimasukkan ke daftar flat yang sama dengan percakapan. Posisinya
(setelah turn) secara kasar benar, tetapi ask_user di Freebuff adalah block
di dalam pesan AI (AskUserContentBlock), bukan pesan sistem terpisah —
pertanyaan agen terasa terlepas dari turn yang mengajukannya.

**BUKAN penyebab (sudah benar, jangan diubah):**
- Status row sudah satu baris tetap di bawah area pesan (§4k) — setara
  Freebuff StatusBar. Toggle 0/1 baris saat turn mulai/selesai juga terjadi
  di Freebuff (`shouldShowStatusLine`), bukan divergensi.
- Thinking shimmer + formatElapsedTime + statusRightItems sudah port
  Freebuff (thinking.ts).
- Tool-summary sudah port Freebuff (§4m): read_files hanya path, shell
  3 baris terakhir.
- Timestamp tepat di atas `You:` dengan garis hijau kontinu (§4p) — port
  Freebuff message-block.tsx + message-with-agents.tsx.
- Viewport top-anchored + composer 5 baris (§4o) — port Freebuff chat.tsx.
- Scrollbar dihapus total atas perintah Reza (§4q); fungsi scroll utuh.
- Tidak ada duplikasi teks pada redraw: window slice deterministik dari
  flatLines; duplikasi yang terlihat di screenshot adalah AKIBAT urutan
  yang salah (teks yang sama tampil "di atas dan di bawah" karena teks
  pasca-tool dirender di atas tool), bukan render ganda.

---

## BAGIAN B — SETELAH IMPLEMENTASI

### B.1 Source Freebuff yang benar-benar diadopsi

Semua dari clone `~/workspace/freebuff-source/`, commit 5d8bd24 (source
langsung, bukan README/dokumentasi, bukan VectorHead):

1. **Satu pesan AI per turn berisi block berurutan append-only**
   (`cli/src/types/chat.ts` ChatMessage.blocks + ContentBlock;
   `cli/src/components/blocks/blocks-renderer.tsx` processBlocks;
   `cli/src/hooks/helpers/send-message.ts` createAiMessageShell +
   `cli/src/utils/message-updater.ts` createBatchedMessageUpdater).
   Diadopsi sebagai `AssistantBlock` di `src/ui/layout.ts`: satu pesan
   assistant per turn, block `text` / `tool` / `todos` tumbuh sesuai
   urutan kedatangan.
2. **Update stream in place by id** (message-updater.ts). Diadopsi
   secara perilaku: teks di-append ke block teks TERAKHIR pesan
   assistant turn itu; bila block terakhir adalah tool/todos, dibuka
   block teks baru sesudahnya. Pesan tidak pernah berpindah posisi.
3. **Tool call sebagai block di dalam pesan AI** (tool-branch.tsx,
   message-with-agents.tsx). Diadopsi: `pushTool` kini menambah block
   tool ke pesan assistant turn itu, bukan pesan top-level terpisah.
4. **To-dos sebagai block di dalam pesan AI** (write-todos.tsx).
   Diadopsi: `upsertTodosMessage` mengganti block todos DI DALAM pesan
   assistant turn itu (posisi pertama kali muncul dipertahankan).
5. **Gap 1 baris antar block dalam satu pesan**
   (message-block.tsx:275). Diadopsi: satu blank line antar block yang
   ter-render; Thinking dihitung sebagai block yang sudah ter-render,
   jadi gap setelah Thinking adalah aturan yang sama, bukan kasus
   khusus.
6. **Status bukan pesan** (status-indicator-state.ts + status-bar.tsx).
   SUDAH diadopsi di §4k; ditegaskan di sini: status row tetap di luar
   transcript, dan `pushSystem` tidak dipakai untuk status.
7. **System message hanya untuk pemberitahuan di luar alur turn**
   (chat.tsx getSystemMessage). Diadopsi sebagian: penolakan tool yang
   tidak pernah mendapat tool_call event (mode-rejected / unknown tool)
   kini muncul sebagai system line, bukan hilang diam-diam dan bukan
   menempel ke tool yang salah (perilaku lama).

TIDAK diadopsi (dicatat jujur, bukan pura-pura):
- ScrollBox native OpenTUI + windowing 6 pesan top-level: Ink tidak
  punya scrollbox; windowing manual (`flattenMessages` + `windowLines`)
  dipertahankan sebagai pengganti yang sudah terbukti.
- Message tree parentId / agent children grid: MethaTech tidak punya
  sub-agent; tidak relevan.
- StatusBar selalu render + session info saat idle: MethaTech
  mempertahankan status row kondisional §4k (Freebuff juga
  men-toggle bar-nya via `shouldShowStatusLine`).

### B.2 File MethaTech yang berubah

| File | Perubahan |
|---|---|
| `src/ui/layout.ts` | `LayoutMessage.kind` kini `"chat" \| "system"`; field `tool?`/`todos?` diganti `blocks?: AssistantBlock[]` (type baru `AssistantBlock`: text / tool (+`done`) / todos). `flattenMessages`: sanitasi per block; cabang `kind === "tool"` / `"todos"` dihapus; branch assistant me-render block berurutan (teks via logika parts/markdown yang sama, tool via preview + hasil yang sama, todos via daftar yang sama) dengan 1 blank line antar block. Pesan assistant tanpa `blocks` fallback ke `content` sebagai satu text block (kompatibel). |
| `src/ui/ChatApp.tsx` | `DisplayMessage` ikut bentuk baru + import `AssistantBlock`. `send()`: pesan assistant dibuat dengan `blocks: []`. `appendAssistantText`: append ke block teks terakhir (atau buka block teks baru sesudah tool/todos); `content` tetap dijaga sebagai teks gabungan turn (untuk /export + /compact). `pushTool`: tambah block tool ke pesan assistant turn itu. `appendToLastTool` → `appendToolResult`: hasil menempel ke block tool TERDEPAN yang belum selesai (`done === false`, cocok nama dulu, fallback block apa pun yang belum selesai); summary null tetap menandai `done` (kasus read_files sukses §4m). Bila tidak ada block yang cocok (tool ditolak mode / tidak dikenal — tidak pernah ada tool_call event), hasil dimunculkan sebagai system line, bukan hilang. `upsertTodosMessage`: upsert block todos di dalam pesan assistant turn itu. Catch di `send()`: pesan assistant hanya di-splice bila kosong teks DAN tanpa block (turn yang hanya menjalankan tool tidak kehilangan tool-nya saat error). Pass redaksi `finally`: redact juga isi block (teks, preview + hasil tool, task todos). Handler `tool_result`: selalu panggil `appendToolResult` (termasuk summary null). |
| `test/layout.test.mjs` | 6 fixture `kind: "tool"`/`"todos"` diubah ke bentuk block (output yang diharapkan TIDAK berubah). +4 test baru: urutan text→tool→text, posisi block todos antar teks, hasil tool menempel ke block-nya sendiri (urutan wave paralel), fallback content tanpa block. Total unit 415 → 419. |
| `test/agent-pty.sh` | A1: terminal 80x40 → 80x50 (turn ~4 baris lebih tinggi karena gap antar block). A2: 80x24 → 80x50 (notis penolakan + preview read harus sama-sama terlihat). Tidak ada perubahan ekspektasi isi. |
| `test/tui-pty.sh` | +Skenario s35 (23 cek): urutan turn 6 langkah, stabilitas posisi saat streaming, input tetap di area input, tanpa duplikasi, redraw byte-identik, scroll + urutan saat scroll (leg 80x56 + leg 80x24). s31 narrow: 40x15 → 40x20 (turn lebih tinggi; yang diuji adalah lebar sempit, bukan tinggi pendek). |
| `docs/TUI-INTERACTION-AUDIT.md` | BARU: dokumen ini (audit + implementasi). |
| Backup | `.bak-20261110-tui-interaction/` (ChatApp.tsx, layout.ts, layout.test.mjs, tui-pty.sh, agent-pty.sh kondisi 0.1.9). |

TIDAK berubah (sesuai aturan): seluruh Universal Agent Runtime
(`src/agent/*`: loop, orchestrator, registry, adapter, fallback,
context, security, capabilities), sistem skill, logika pemanggilan
model (`src/api.ts`), `thinking.ts`, `tool-summary.ts`,
`markdown.ts`, panel/production. `package.json` TIDAK di-bump
(tetap 0.1.9). TIDAK ada commit/push/deploy/publish.

### B.3 Perilaku yang berhasil disamakan

1. **Urutan turn kronologis.** Satu turn 6 langkah mock kini dirender
   `teks → tool → teks → tool → teks → tool → teks → tool → teks →
   tool` sesuai kedatangan — sebelumnya semua teks di atas semua tool.
   Bukti: capture `a1-toolcall` (agent-pty) dan `s35-done-80`
   (tui-pty) — "Membaca file dulu." → "Read hello.txt" → "Edit
   file." → "Edit hello.txt" → "Tandai yang sudah selesai." →
   "Update to-dos" → "Sekarang jalankan perintah." → "$ touch..."
2. **Hasil tool menempel ke tool-nya sendiri**, termasuk pada batch
   paralel (wave): hasil pertama tidak lagi jatuh ke pesan tool kedua.
   Diuji unit (dua block tool + hasil) + PTY (shell result di bawah
   preview-nya sendiri).
3. **Daftar TODOs di posisi kronologisnya** dan hanya satu list
   (upsert replace in place di dalam turn, bukan mengambang di atas
   konten yang lebih baru).
4. **Penolakan tool terlihat dan jujur.** Di Plan mode, `str_replace`
   dan `run_terminal_command` yang ditolak kini muncul sebagai system
   line "unknown or unavailable tool in this mode: ..." — sebelumnya
   hasil penolakan menempel ke pesan tool terakhir yang kebetulan ada
   (read_files), dan pada model block akan hilang sama sekali tanpa
   fallback ini.
5. **Pesan tidak berpindah saat streaming.** Pesan user tetap di baris
   3 pada capture tengah-streaming dan setelah turn selesai (bila
   seluruh turn muat di viewport); input tetap di area input (border
   bawah di baris yang sama); redraw setelah selesai byte-identik.
6. **Scroll panjang benar + urutan bertahan saat scroll.** Indikator
   `↑ N baris di atas` + affordance footer tetap jalan; irisan yang
   terlihat saat PgUp tetap dalam urutan kedatangan.
7. **Yang sudah benar tetap benar.** Status bar (§4k), thinking
   shimmer, tool-summary (§4m), timestamp (§4p), viewport + composer
   (§4o), tanpa scrollbar (§4q) — semua test lama terkait tetap hijau;
   tidak ada regresi pada 270 cek tui-pty lama.

Catatan jujur — satu urutan berasal dari loop, bukan dari TUI:
pada langkah terakhir mock, teks final "# Selesai..." dirender DI
ATAS block "Task completed", karena loop meng-emit event teks
langkah itu SEBELUM mem-parse tool call di akhir langkah. TUI
merender urutan kedatangan event dengan setia; mengubahnya berarti
mengubah runtime (di luar aturan tugas). Dicatat di skenario s35
sebagai perilaku yang diharapkan, bukan bug TUI.

Perubahan tinggi yang disengaja: satu turn kini ~4 baris lebih
tinggi (blank line antar block, Freebuff gap 1). Viewport harness
A1/A2/s31/s35 disesuaikan; ini BUKAN regresi, melainkan harga dari
kesetaraan perilaku.

### B.4 Hasil build dan seluruh test

- `npx tsc`: bersih, 0 error.
- `npm test`: **419/419** (baseline 0.1.9: 415/415; +4 test layout
  baru, 0 test diubah ekspektasinya selain konversi bentuk fixture).
- `test/agent-pty.sh`: **32/32** (baseline 32/32; dijalankan pada
  tree final).
- `test/tui-pty.sh`: **293/293** (baseline 0.1.9: 270/270; +23 cek
  skenario s35 baru, 0 regresi).

Perjalanan verifikasi (dicatat jujur):
- Run tui-pty pertama mati di tengah karena service restart (SIGTERM,
  tanpa output) — diulang dari awal.
- Run kedua: 291/293. Dua FAIL keduanya harness viewport, bukan
  produk: (1) s35 cek "user message di baris 3 setelah turn" — turn
  lengkap 52 baris tidak muat di terminal 50 baris; diperbaiki ke
  80x56. (2) Satu FAIL awal yang tidak tertangkap ekor output.
- Run ketiga (log lengkap): 291/293 lagi. FAIL: (1) s31/40 "Read
  big.txt" — turn lebih tinggi membuat preview scroll keluar dari
  message area 7 baris pada 40x15; diperbaiki ke 40x20 (yang diuji
  adalah lebar sempit). (2) s35 scroll — PgUp pada 80x56 adalah no-op
  yang benar (seluruh turn muat, tidak ada yang bisa di-scroll);
  diganti leg kedua 80x24 khusus scroll.
- Run keempat (final): **293/293**, `SUITE_EXIT=0`. Tidak ada FAIL
  yang disembunyikan: semua kegagalan di atas adalah penyesuaian
  harness yang dijelaskan di sini, bukan perubahan ekspektasi produk.

### B.5 Bukti pengujian PTY

- `test/agent-pty.sh` → `/tmp/methatech-agent-pty-final/` (32/32):
  `a1-toolcall.plain.txt` menunjukkan urutan turn yang benar
  (teks → Update to-dos → TODOs → Membaca file dulu. → Read
  hello.txt → Edit file. → Edit hello.txt + ✓ → Tandai... →
  Update to-dos → Sekarang... → $ touch... + ✓ ... line3 /
  line4 / hello-agent → Selesai → teks final).
  `a2-plan-run.plain.txt` menunjukkan notis penolakan sebagai system
  line setelah turn ("unknown or unavailable tool in this mode:
  str_replace" dan "...: run_terminal_command").
- `test/tui-pty.sh` → `/tmp/methatech-tui-pty-tui4/` (293/293):
  `s35-mid-80.plain.txt` (tengah streaming: user di baris 3,
  "■ Esc" terlihat, border input baris 54);
  `s35-done-80.plain.txt` (10 cek urutan + 4 cek hitungan + redraw
  byte-identik);
  `s35-done-80b.plain.txt` (identik dengan s35-done-80);
  `s35-up-80.plain.txt` (indikator "↑ 17 baris di atas ·
  PgUp/PgDn riwayat", urutan terjaga saat scroll).
- File kerja sementara skenario (hello.txt, agent-ran.txt, big.txt)
  sudah dihapus oleh skenario; `git status` bersih kecuali 5 file
  yang diubah + dokumen audit baru + backup (di luar git, seperti
  backup fase sebelumnya).

SELESAI — menunggu perintah Reza berikutnya. Tidak ada commit,
push, deploy, atau publish yang dilakukan.
