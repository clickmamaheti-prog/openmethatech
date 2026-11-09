# Laporan Implementasi: Adopsi Agen Koding Freebuff ke MethaTech CLI (Fase 0–2)

> Status: SELESAI di working tree, BELUM di-commit / di-push / di-publish /
> di-deploy (sesuai tugas). Repo `~/workspace/metatech-cli/`, main commit
> `11e5e18` (v0.1.5 live).
>
> **DIHAPUS 2026-11-08 ~23:20 UTC atas perintah Reza ("jangan tambah-tambah,
> apa adanya aja kaya Freebuff"):** gate konfirmasi agen (`src/agent/confirm.ts`
> + kotak konfirmasi kuning + logika Allow once/always/Deny + klasifikasi
> bash/dangerous) DIHAPUS TOTAL — agen langsung jalankan tool tanpa minta
> izin, persis seperti Freebuff. Blok session-start ("New conversation
> started...") juga DIHAPUS — itu dari VectorHead, bukan Freebuff
> (AGENT-ADOPTION.md §10.1). Nama mode "Build" diganti "Default" (nama
> mode Freebuff yang benar: DEFAULT / LITE / MAX / PLAN). Bagian-bagian
> dokumen ini yang masih menyebut gate/session-start/"Build" adalah
> catatan sejarah sebelum penghapusan — kode yang berlaku sekarang tidak
> punya ketiganya.
> Rencana yang diikuti: `docs/AGENT-ADOPTION.md` (riset dari source asli
> Freebuff, clone `~/workspace/freebuff-source/`, commit `5d8bd24`,
> Apache-2.0). TIDAK ada yang diambil dari VectorHead.
>
> Identitas tetap MethaTech: hitam `#000000` + hijau neon `#39FF14`,
> tanpa iklan, API/auth/billing/model panel MethaTech tetap, tanpa kata
> "Playground". Lisensi: pola/kode yang di-port dari Freebuff membawa
> atribusi Apache-2.0 di header file masing-masing; system prompt agen
> ditulis ulang dengan bahasa sendiri (bukan salinan mentah base3).

## 1. File Freebuff yang dipakai sebagai referensi

| Area | File Freebuff |
|---|---|
| Agent loop | `packages/agent-runtime/src/run-agent-step.ts` (`loopAgentSteps` :1115, `runAgentStep`, `shouldEndTurn` :901–1030), `packages/agent-runtime/src/main-prompt.ts` |
| Tool calling | `common/src/tools/constants.ts` (`toolXmlName`, `toolNameParam = 'cb_tool_name'`, daftar tool), `packages/agent-runtime/src/util/stream-xml-parser.ts`, `packages/agent-runtime/src/tool-stream-parser.ts`, `common/src/tools/params/tool/*.ts` (schema per tool) |
| Skill | `common/src/types/skill.ts`, `common/src/constants/skills.ts`, `common/src/util/parse-skill.ts`, `common/src/util/skills.ts`, `packages/agent-runtime/src/tools/handlers/tool/skill.ts` |
| Mode | `cli/src/utils/constants.ts` (`AGENT_MODE_TO_ID`, `AGENT_MODES`), `cli/src/state/chat-store.ts` (`toggleAgentMode`), `agents/base2/base2.ts` (toolset PLAN), `agents/base3.ts` (8 tool inti root) |
| Permission | `packages/agent-runtime/src/tools/handlers/tool/run-terminal-command.ts`, `sdk/src/tools/run-terminal-command.ts` (timeout clamp, output cap, SIGTERM→SIGKILL), `cli/src/components/ask-user/index.tsx`, `cli/src/components/pending-bash-message.tsx` |
| System prompt + konteks | `agents/base3.ts` (root prompt), `agents/base2/base2.ts` (orkestrator), `common/src/constants/knowledge.ts`, `sdk/src/run-state.ts:833` (`loadKnowledgeFilesFromPaths`), `packages/agent-runtime/src/templates/strings.ts` (step prompt) |
| Progress TUI | `cli/src/utils/sdk-event-handlers.ts`, `cli/src/components/tools/run-terminal-command.tsx` (preview `` `$ <command>` ``), `cli/src/components/status-bar.tsx` |
| Error & limit | `packages/agent-runtime/src/util/turn-progress.ts` (`NO_PROGRESS_STOP_THRESHOLD = 40`), `util/file-edit-loop.ts` (3/6/12), `common/src/constants/agents.ts` (`MAX_AGENT_STEPS_DEFAULT = 600`, `MAX_SUBAGENT_STEPS_DEFAULT = 200`), `common/src/tools/params/tool/run-terminal-command.ts` (`MAX_TERMINAL_TIMEOUT_SECONDS = 600`) |

## 2. Komponen yang diadopsi

- **Parser XML tool call stateful** — port `stream-xml-parser.ts`:
  tag `<codebuff_tool_call>` + JSON (`cb_tool_name` + parameter),
  tahan chunk boundary (partial-tag buffering), teks di luar tag tetap
  tampil, teks di dalam tag tidak bocor ke chat.
- **Loop agen lokal** — port `loopAgentSteps`/`shouldEndTurn`: `while`
  per turn, hasil tool sebagai pesan role `tool` di history, error tool
  memaksa retry, `task_completed` mengakhiri turn, guard no-progress
  40 langkah dan file-edit-loop 6×.
- **Tool minimal (11)** — `read_files`, `list_directory`, `glob`,
  `code_search`, `str_replace`, `write_file`, `run_terminal_command`,
  `write_todos`, `task_completed`, `ask_user`, `skill`; nama +
  semantik mengikuti Freebuff; validasi per tool setara Zod (ditulis
  tangan — CLI tidak punya dependensi Zod/YAML).
- **System prompt agen MethaTech** — aturan kerja base3 yang
  diadaptasi dengan bahasa sendiri + format tool call XML + konteks
  proyek (file tree ≤300 entri, knowledge files `AGENTS.md` /
  `CLAUDE.md` / `*.knowledge.md`, `git status` + `git diff --stat`).
- **Skill** — format `SKILL.md` + frontmatter YAML (`name`,
  `description`, `license`, `disable-model-invocation`), validasi
  nama = nama direktori, discovery `<proyek>/.agents/skills/` +
  `~/.config/metatech/skills/` (+ `.claude` sebagai fallback),
  daftar nama+deskripsi disisipkan ke deskripsi tool `skill`, isi
  penuh dimuat hanya saat dipanggil.
- **Mode DEFAULT / LITE / MAX / PLAN** — cycling DEFAULT → LITE →
  MAX → PLAN, tampil di status bar. PLAN ditegakkan lewat toolset
  (tanpa `str_replace`, `write_file`, `run_terminal_command`).
- **Render progress per tool** — tiap tool call satu baris preview
  (`$ <command>`, `Read <file>`, `Edit <file>`), hasil ringkas satu
  baris `✓`/`✗`, to-do live via `write_todos`, indikator Thinking
  tetap jalan + `Agent step N` di baris status.
- **Perintah slash** — `/mode [default|lite|max|plan]`, `/init`
  (baca codebase → `AGENTS.md`, tidak menimpa yang sudah ada),
  `/compact` (ringkas percakapan via model), `/export` (tulis
  `metatech-export-*.md`). TIDAK ADA `/agent` toggle: agen adalah
  chat default (Freebuff `cli/src/commands/router.ts:480` "send to
  agent" — setiap pesan biasa masuk agent step; `/agent` yang
  diketik manual hanya mencetak status selalu-aktif).

## 3. File MethaTech yang diubah / dibuat

Dibuat (`src/agent/`):

| File | Isi |
|---|---|
| `src/agent/xml-parser.ts` | Parser XML tool call stateful (port Freebuff) + `formatToolCall` + `parseFullText` |
| `src/agent/tools.ts` | 11 tool + validasi + sandbox path + cap output 50.000 karakter + `toolPreview` + `executeToolCall` |
| `src/agent/modes.ts` | Mode + toolset per mode + penegakan PLAN + nama tampil Freebuff (Default/Lite/Max/Plan) |
| `src/agent/skills.ts` | Parser frontmatter + discovery + load skill + XML daftar skill |
| `src/agent/prompt.ts` | System prompt agen + konteks proyek (tree/knowledge/git) |
| `src/agent/loop.ts` | `runAgentLoop` + guard + event ke TUI |
| `src/agent/slash.ts` | `/init` / `/compact` / `/export` |
| `src/agent/index.ts` | Barrel export |

Diubah:

| File | Perubahan |
|---|---|
| `src/api.ts` | `ChatMessage.role` + `"tool"`, + `name` / `tool_call_id` opsional (hasil tool) |
| `src/ui/ChatApp.tsx` | Agen adalah chat default (semua pesan non-slash lewat `send` → agent loop; tidak ada `send` chat polos lagi, tidak ada toggle `/agent`), state agen (`/mode`, `/init`, `/compact`, `/export`), pesan kind `tool`, mode di footer + `Agent step N`, `truncateMiddle` (anti-wrap di terminal kecil) |
| `src/ui/layout.ts` | `LayoutMessage` kenal kind/role `tool`; render pesan tool (preview neon, hasil muted) |
| `src/ui/palette.ts` | 5 perintah baru di palette (agent, mode, init, compact, export) |
| `test/mock-server.mjs` | Mode `MOCK_AGENT=1`: skrip 3 respons (read_files → shell → task_completed), chunk 17 karakter |
| `test/agent.test.mjs` | (baru) 28 test unit agen |
| `test/agent-pty.sh` | (baru) 22 cek PTY agen (mock): tool call, gate konfirmasi, Plan, /init, /export |
| `test/palette.test.mjs` | Ekspektasi diperbarui: 8 → 13 perintah |
| `docs/images/agent-*.png` | 4 screenshot (lihat §6) |

Tidak diubah: `src/commands.ts` (tidak ada subcommand baru — agen hidup
di dalam TUI chat), `src/config.ts`, `src/models.ts`, `package.json`
(tanpa dependensi baru), `src/theme.ts` (token warna sudah ada).

## 4. Perbedaan kompatibilitas (disengaja, dicatat)

1. **Loop jalan lokal di CLI, bukan di server panel.** Panel MethaTech
   hanya chat OpenAI-compatible (SSE); tidak ada agent runtime di sisi
   server. Semua tool dieksekusi lokal dari disk user (Freebuff
   membagi eksekusi server/client).
2. **Tool call dieksekusi SETELAH respons satu step lengkap**, bukan
   mid-stream dengan stream di-pause (Freebuff `processStream`).
   `streamChat` tidak menyediakan jeda stream; batching per step
   adalah padanan yang jujur.
3. **Gate konfirmasi per perintah — DIHAPUS 2026-11-08 ~23:20 UTC.**
   Dulu ada sebagai penyimpangan disengaja (bukan dari Freebuff);
   atas perintah Reza ("jangan tambah-tambah, apa adanya aja kaya
   Freebuff") seluruh gate dihapus: `src/agent/confirm.ts` + kotak
   konfirmasi + logika Allow once/always/Deny + klasifikasi bash.
   Agen sekarang menjalankan tool langsung tanpa konfirmasi, persis
   seperti Freebuff.
4. **Nama mode "Build" — DIHAPUS 2026-11-08 ~23:20 UTC, diganti
   "Default".** Freebuff TIDAK punya mode Build atau YOLO (grep nol).
   TUI sekarang menampilkan nama mode Freebuff yang benar
   (Default / Lite / Max / Plan).
5. **Aturan akhir turn dilonggarkan.** Freebuff: agen yang toolset-nya
   berisi `task_completed` wajib memanggilnya, atau turn tidak
   berakhir. MethaTech: step tanpa tool call mengakhiri turn (model
   gratis panel sering menjawab teks polos tanpa pernah memanggil
   `task_completed`; aturan ketat akan mengulang sampai maxSteps di
   setiap jawaban cerewet).
6. **Maks step default 100, bukan 600.** Angka Freebuff 600 adalah
   backstop; di model gratis panel 600 langkah bisa membakar banyak
   turn sebelum guard no-progress (40) menghentikannya. Batas absolut
   tetap 600 (`MAX_AGENT_STEPS_ABSOLUTE`).
7. **Home skills aktif secara default.** Freebuff menjadikannya
   opt-in karena runtime-nya jalan di server bersama (home server ≠
   home user). CLI MethaTech jalan di mesin user sendiri, jadi
   `~/.config/metatech/skills/` + `~/.agents/skills/` aman diaktifkan.
8. **MAX berperilaku seperti DEFAULT untuk sekarang.** Best-of-n
   editor + reviewer fan-out (mahal) ditunda ke Fase 4; tidak ada
   klaim best-of-n di TUI.
9. **LITE bukan tier terpisah.** Gratis vs berbayar sudah diurus model
   picker + aturan akses panel; LITE hanya mengubah instruksi prompt
   (langkah kecil, hemat).
10. **Tidak ada Zod/AI SDK/OpenTUI/Bun/Zustand baru.** Validasi schema
    ditulis tangan; transport tetap `src/api.ts` (SSE); state tetap
    React state di `ChatApp.tsx`.
11. **`ask_user` menjeda turn.** Pertanyaan ditampilkan di chat dan
    jawaban user berikutnya melanjutkan percakapan (tidak ada formulir
    pilihan interaktif seperti Freebuff — belum dibangun).
12. **Tool `skill` memakai nama Freebuff (`skill`)**; direktori
    proyek `.agents/skills/` sama; tambahan MethaTech:
    `~/.config/metatech/skills/`.

## 4b. Audit penyamaan Freebuff — todos, tools, edit, skill, inline code, warna (2026-11-09)

Semua nilai di bawah dibaca LANGSUNG dari source Freebuff
(commit 5d8bd24), bukan dari screenshot/README/VectorHead.

**Todos** — Freebuff `cli/src/utils/todos.ts` (37 baris) + `cli/src/components/tools/write-todos.tsx`:
`TodoItem = {task: string, completed: boolean}` (tanpa id, tanpa
status enum, tanpa in_progress/cancelled). Tiap `write_todos`
MENGGANTI seluruh list; list kosong = hapus; input malformed TIDAK
mengganti list. Tampilan: header `• TODOs` (bullet + BOLD "TODOs"),
item indent 2 spasi, selesai = `✓ ` success + teks muted +
strikethrough, belum = `☐ ` foreground + teks foreground.
MethaTech sebelumnya memakai `{id, content, status: pending |
in_progress | completed | cancelled}` + tampilan `☑`/`▶` tanpa
header/warna/strikethrough — SUDAH DISAMAKAN (`src/agent/tools.ts`,
`src/ui/ChatApp.tsx` kind baru `"todos"`, `src/ui/layout.ts`).

**str_replace** — Freebuff `common/src/tools/params/tool/str-replace.ts` +
`common/src/tools/params/utils.ts` (normalizeReplacementAliases,
liftSingleReplacement): params `{path, replacements: [{oldString,
newString, allowMultiple?: boolean}]}`; alias oldString ← old /
old_str / old_string, newString ← new / new_str / new_string /
replacement; top-level `{path, oldString, newString}` diangkat jadi
satu replacements. MethaTech sebelumnya `{path, old_text, new_text}`
satu gantian — SUDAH DISAMAKAN, termasuk validasi semua replacements
dulu (gagal = tidak ada yang ditulis) + `allowMultiple: true`.

**Skill endsAgentStep** — Freebuff `common/src/tools/params/tool/skill.ts`:
`endsAgentStep: true` (marker `cb_easp` di `common/src/tools/constants.ts`).
MethaTech: `skill` ditandai `endsAgentStep: true` di definisi tool;
loop (`src/agent/loop.ts`) berhenti mengeksekusi sisa tool call di
step yang sama setelah skill — model melanjutkan di step berikutnya.
Ini padanan lokal dari mekanisme Freebuff yang sebenarnya: `sdk/src/custom-tool.ts:26`
— `endsAgentStep: true` dipakai sebagai stop sequence untuk LLM
("it will not be able to call any other tools after this one in a
single step and must wait for the tool results").

**write_todos no-op + guard todo-loop** — Freebuff
`packages/agent-runtime/src/util/todo-loop.ts` (dikonfirmasi dari
laporan riset 2026-11-09 00:20 UTC):
- List yang dikirim ulang identik = no-op dengan pesan
  `WRITE_TODOS_UNCHANGED_MESSAGE` verbatim ("To-do list unchanged:
  it is already recorded, so this call did nothing…"); `onTodos`
  tidak dipicu. Bila mode tidak punya tool edit file (Plan),
  ditambah `FILE_EDIT_TOOLS_UNAVAILABLE_NOTE` (diadaptasi tanpa
  `apply_patch`, yang tidak ada di MethaTech).
- Guard: step yang HANYA mengirim ulang list yang sama, berturut-turut
  3× → pesan recovery `TODO_LOOP_RECOVERY_MESSAGE` disisipkan sebagai
  pesan user; 6× → turn dihentikan paksa dengan
  `TODO_LOOP_STOP_MESSAGE`. List berbeda, tool lain, atau pesan user
  memutus streak. Unchanged write_todos juga tidak dihitung sebagai
  progres (tidak mereset guard no-progress 40).
Discovery tetap superset MethaTech (`.agents/skills` + `.claude/skills`
+ `~/.config/metatech/skills/`), isi penuh dimuat segar dari disk
hanya saat dipanggil — sama seperti Freebuff.

**Inline code + warna teks** — Freebuff `cli/src/utils/theme-system.ts`
(DEFAULT_CHAT_THEMES.dark + markdown) + `cli/src/utils/markdown-renderer.tsx`:
inline code = BOLD, space pad (` code `), fg `#FF8534` (oranye) di
atas bg `#374151`; code block = header `// lang` fg `#5b647a`,
body MONOKROM fg `#f1f5f9` di atas bg `#374151` (tanpa warna
per-token); heading H1–H6 = `#facc15` (kuning) + bold; link =
`#3B82F6` (biru); list bullet `#a3aed0`; blockquote border `#334155`
+ teks `#e2e8f0`; divider `#283042`; error `#ef4444`; warning
`#FFA500`; success `#22c55e`; muted `#acb3bf`; secondary `#a3aed0`;
border `#536175`; surface `#202327`. MethaTech: palet ini masuk
`src/theme.ts` (`markdown` + token semantik diperbaiki; aksen utama
tetap hijau neon `#39FF14`, background tetap `#000000`); render di
`src/ui/layout.ts` (`inlineSegments` + `markdownLines` + code block
Freebuff + kind `todos`); `src/ui/CodeBlock.tsx` juga disamakan
(monokrom + bg + `// lang`). Syntax highlight per-token TIDAK lagi
dipakai untuk code block chat (Freebuff tidak punya fitur itu).

**Hasil tool shell** — Freebuff `cli/src/components/blocks/tool-branch.tsx`:
`run_terminal_command` menampilkan 3 BARIS TERAKHIR stdout
(`...` bila lebih). MethaTech: ringkasan hasil shell di `ChatApp.tsx`
sekarang parse JSON `{stdout, stderr, exitCode}` lalu ambil 3 baris
terakhir stdout (sebelumnya menampilkan JSON mentah).

**Pesan user italic** — Freebuff `cli/src/components/blocks/single-block.tsx:102`:
seluruh blok teks user `attributes={isUser ? ITALIC : undefined}`.
MethaTech: konten pesan user kini italic (`src/ui/layout.ts`);
label "You:" tetap bold tidak miring; balasan asisten tetap tegak.
Diverifikasi di ANSI PTY (`\x1b[0;3m` sebelum teks user) + screenshot
`docs/images/tui-user-italic-desktop.png`.

## 4c. Audit penyamaan Freebuff — Ctrl+C double-tap (2026-11-09)

Semua nilai di bawah dibaca LANGSUNG dari source Freebuff
(commit 5d8bd24), bukan dari screenshot/README/VectorHead.

**Mekanisme Freebuff** — `cli/src/utils/keyboard-actions.ts`
(prioritas 3, 4, 9, 16) + `cli/src/hooks/use-exit-handler.ts` +
`cli/src/utils/status-indicator-state.ts` +
`cli/src/components/status-bar.tsx:158-159`:
- Prioritas 3: Ctrl+C + draft tidak kosong (trim) → `clear-input`.
  TANPA guard sending — prioritas 3 dicek SEBELUM prioritas 4,
  jadi dengan draft + stream hidup, Ctrl+C pertama menghapus draft
  dan stream TERUS jalan; Ctrl+C berikutnya (draft kosong) baru
  menginterupsi.
- Prioritas 4: Ctrl+C / Esc + streaming/waiting → `interrupt-stream`
  (`stopActiveRun('user-interrupt')`).
- Prioritas 9: Ctrl+C + queuePaused + queuedCount > 0 →
  `clear-queue` (tidak ada padanan di MethaTech — tidak ada queue).
- Prioritas 16: Ctrl+C → `exit-app` bila `nextCtrlCWillExit`,
  `exit-app-warning` bila tidak. Keduanya memanggil handler YANG
  SAMA (`handleCtrlC` di `use-exit-handler.ts`): bila `inputValue`
  tidak kosong → hapus input; bila flag belum set → set flag +
  `setTimeout` 2000ms untuk meresetnya; bila flag sudah set →
  `exitCliCleanly()`.
- Tampilan warning: `getStatusIndicatorState` menaruh `ctrlC` di
  prioritas TERTINGGI (di atas waiting/streaming/clipboard);
  status bar merender teks persis `Press Ctrl-C again to exit`
  warna `theme.secondary` (#a3aed0).
- Jendela double-tap: tepat 2000ms, dihitung sejak Ctrl+C pertama;
  flag HANYA direset oleh timeout (mengetik tidak meresetnya).
  Keluar (`exitCliCleanly`) menjalankan cleanup + mencetak
  `To continue this session later, run: freebuff --continue <chatId>`
  saat proses keluar — TIDAK ada padanan di MethaTech (CLI tidak
  punya `--continue`), jadi tidak di-port.
- Esc: prioritas 0 (out-of-credits → keluar mode), 1 (feedback →
  keluar mode), 1.5 (dock panel → tutup), 2 (mode non-default →
  keluar mode, SEBELUM interrupt), 4 (streaming → interrupt),
  13 (unfocus agent). Model selector menutup sendiri dengan Esc
  (`freebuff-model-selector.tsx:1361`, handler sendiri, bukan
  resolver global). Slash menu TIDAK punya handler Esc di resolver
  — Esc dengan palette terbuka jatuh ke `none` (menu tetap terbuka,
  tertutup bila draft tidak lagi cocok pola `/`).
- Ctrl+C dengan picker terbuka: selector TIDAK mengklaim Ctrl+C
  (hanya Esc/Tab/arrows/Enter), jadi Ctrl+C jatuh ke prioritas 16
  (warning/exit).

**Perbedaan yang ditemukan di MethaTech (semua diperbaiki):**
1. Ctrl+C pertama di draft kosong langsung KELUAR (kontrak PTY s6
   lama) — Freebuff hanya WARNING. → Diubah: resolver prioritas 16
   kini mengembalikan `exit-app-warning` bila flag belum set,
   `exit-app` bila sudah; dispatcher `ChatApp.tsx` menyalakan flag
   + timeout 2000ms (`armExitWarning`, `EXIT_WARNING_TIMEOUT_MS`,
   `src/ui/keyboard.ts`), status bar menampilkan teks Freebuff
   persis dengan warna `theme.secondary` (= #a3aed0, sama dengan
   Freebuff `theme.info`).
2. Prioritas 3 MethaTech punya guard `!state.sending` — dengan
   draft + stream hidup, Ctrl+C pertama langsung menginterupsi.
   → Guard dihapus; urutan Freebuff (clear dulu, interrupt
   berikutnya) dipulihkan.
3. Cabang picker di resolver menelan SEMUA tombol tak dikenal
   (`return { type: "none" }`) — Ctrl+C dengan picker terbuka tidak
   berbuat apa-apa. → Ctrl+C kini jatuh ke prioritas 16 (warning /
   exit) saat picker terbuka, sama seperti Freebuff.
4. Hint footer `Ctrl+C keluar` kini menyesatkan (sekali tekan tidak
   keluar) → diubah jadi `Ctrl+C 2x keluar` (footer + teks bantuan
   `?` + 3 assert PTY s7/s9/s19).

**Temuan terbesar (root cause, bukan sekadar perbedaan perilaku):**
`render()` ChatApp di `src/commands.ts` dipanggil TANPA opsi, jadi
Ink memakai default `exitOnCtrlC: true`. Di Ink 6.8.0
(`build/components/App.js:71`, `build/hooks/use-input.js:110`) itu
berarti: Ink langsung keluar saat `\x03` DAN handler `useInput`
tidak pernah menerima Ctrl+C. Akibatnya SELURUH cabang Ctrl+C di
resolver (clear-input prioritas 3, interrupt prioritas 4, warning/
exit prioritas 16) adalah DEAD CODE di TUI asli — hanya hidup di
unit test. Kontrak PTY s6 lama ("sekali Ctrl+C keluar") lolos
justru karena Ink yang keluar, bukan resolver. Perbaikan:
`render(..., { exitOnCtrlC: false })` HANYA untuk ChatApp; layar
one-shot `models`/`account` tetap memakai default (Ctrl+C langsung
keluar dari layar itu — perilaku yang diinginkan). Klaim lama di
ADOPTION.md ("exitOnCtrlC dimatikan lewat handler sendiri") SALAH
dan sudah dikoreksi. Bukti sebelum perbaikan: capture PTY s6/s24
kosong (sesi sudah mati saat capture), 6 kegagalan s24 + 2
kegagalan s6; sesudah perbaikan, seluruh skenario s6/s24 lolos
(lihat §5).

**Yang sengaja TIDAK diubah (di luar lingkup Ctrl+C, dicatat):**
- Aturan MethaTech "Esc dengan draft tidak kosong menghapus draft"
  (0.1.5) — Freebuff TIDAK punya aturan itu (Esc di default mode
  + draft = `none`). Tidak diubah dalam tugas ini karena bukan
  perilaku Ctrl+C; perlu perintah terpisah bila mau disamakan.
- Aturan "Esc menutup palette" (prioritas 2 MethaTech) — Freebuff
  tidak menutup slash menu dengan Esc. Sama: di luar lingkup,
  perlu perintah terpisah.

## 4d. Audit penyamaan Freebuff — scroll + indikator Thinking (2026-11-09)

Semua nilai di bawah dibaca LANGSUNG dari source Freebuff
(commit 5d8bd24), bukan dari screenshot/README/VectorHead.

**Scroll Freebuff** — `cli/src/hooks/use-scroll-management.ts` +
`cli/src/chat.tsx` (scrollbox) +
`cli/src/utils/keyboard-actions.ts` (prioritas 14) +
`cli/src/components/scroll-to-bottom-button.tsx` +
`cli/src/components/status-bar.tsx`:
- PgUp/PgDn saja (tanpa modifier, prioritas 14); page =
  `floor(viewport × 0.8)`; animasi 200ms easeOutCubic ~60fps;
  auto-scroll 50ms setelah messages berubah hanya bila
  autoScrollEnabled + tidak ada animasi + tidak collapsing;
  isAtBottom bila `|maxScroll − scrollTop| ≤ 1`.
- Tombol `↓` di status bar (`theme.info`, `↓` dim / hovered bold
  `↓ Scroll to bottom ↓`, hanya bila `!isAtBottom`, klik →
  scrollToLatest); scrollbar vertikal 1 kolom, hanya bila tidak
  streaming/waiting dan overflow; mouse wheel via scrollbox OpenTUI
  (ConstantScrollAccel 1 baris/tick).
- PgUp/PgDn jalan bahkan saat model picker terbuka (prioritas 14
  dicek sebelum cabang picker).

**Perbedaan yang ditemukan di MethaTech (semua diperbaiki):**
1. Scroll lompat instan — Freebuff beranimasi 200ms easeOutCubic.
   → Animasi via `setInterval` 16ms di `ChatApp.tsx`
   (`easeOutCubic`, `SCROLL_ANIMATION_DURATION_MS = 200`,
   `SCROLL_ANIMATION_FRAME_MS = 16`, `src/ui/layout.ts`); aksi baru
   membatalkan animasi yang berjalan; auto-scroll tidak menarik view
   saat animasi berjalan.
2. Tidak ada tombol kembali ke bawah — hanya teks indikator +
   hint footer. → Affordance `↓ PgDn (N baris)` di footer baris 2,
   warna `theme.secondary` (= Freebuff `theme.info` #a3aed0), hanya
   bila `!isAtBottom` (Ink tidak punya klik mouse; PgDn adalah
   caranya turun).
3. Tidak ada track scrollbar. → Track 1 kolom (`│`, thumb `█`
   proporsional via `scrollbarThumbRange`) di kanan area pesan,
   hanya bila tidak streaming/waiting dan overflow; baris di-rewrap
   1 kolom lebih sempit saat track tampil supaya teks tidak
   terdorong keluar viewport.
4. PgUp/PgDn DIBLOKIR saat picker terbuka (cabang picker
   mengembalikan `none` untuk semua tombol tak dikenal). → PgUp/PgDn
   kini jatuh ke scroll bahkan saat picker terbuka (prioritas 14
   Freebuff). Catatan: di terminal 80×24 picker yang terbuka hanya
   menyisakan ~1 baris untuk riwayat (budget picker yang sudah ada),
   jadi scroll dengan picker terbuka praktis baru terlihat di
   terminal yang lebih tinggi — skenario PTY s23 memakai 80×40
   karena itu.
5. Indikator `↑ N baris di atas` tampil bahkan saat sudah di bawah
   (menampilkan "133 baris di atas" padahal balasan terakhir sudah
   terlihat) — Freebuff hanya menampilkan affordance scroll bila
   `!isAtBottom`. → Indikator kini hanya tampil bila benar-benar
   scroll ke atas (`scrollOffset > 0`); di bawah, barisnya dipakai
   lagi untuk satu baris pesan.
6. Mouse wheel — Freebuff punya (OpenTUI scrollbox), Ink TIDAK
   punya input mouse. Perbedaan PAKSA, didokumentasikan di
   ADOPTION.md; PgUp/PgDn adalah satu-satunya cara scroll.

**Indikator Thinking Freebuff** — `cli/src/components/thinking.tsx`
+ `cli/src/components/shimmer-text.tsx` +
`cli/src/components/status-bar.tsx:175-208` +
`cli/src/utils/format-elapsed-time.ts`:
- Label lowercase `thinking...` (waiting) / `working...`
  (streaming) / `retrying...` — `ShimmerText` dengan
  `primaryColor theme.secondary`, interval 180ms, palet per karakter
  dari warna primer (HSL lightness ±0.22), 23% pertama BOLD, 31%
  terakhir DIM, band berjalan.
- Timer elapsed format `30s`/`1m`/`1m 30s`/`1h`/`1h 1m`,
  DISEMBUNYIKAN bila 0; tombol `■ Esc` di KANAN status bar (hanya
  saat waiting/streaming); layout status bar kiri indikator /
  kanan timer + `■ Esc`.

**Perbedaan yang ditemukan di MethaTech (semua diperbaiki):**
1. Label `Thinking...` kapital-T → lowercase `thinking...`
   (`phaseLabel`, `THINKING_LABEL`, `src/ui/thinking.ts`).
2. Shimmer MethaTech = sweep hijau 100ms (3 karakter terang
   berjalan) → shimmer Freebuff: `generateShimmerPalette` +
   `shimmerSegments` (palet HSL ±0.22 dari `theme.secondary`,
   interval 180ms, BOLD 23% pertama / DIM 31% terakhir),
   `Thinking.tsx` kini merender segmen per karakter.
   Fungsi sweep lama (`SWEEP_WIDTH`, `nextSweepIndex`,
   `sweepSegments`) DIHAPUS total (termasuk test-nya).
3. Timer menampilkan detik mentah termasuk `0s` → `formatElapsedTime`
   aturan Freebuff + disembunyikan bila 0.
4. `■ Esc to stop` (desktop) → tepat `■ Esc`; status row kini
   `justifyContent="space-between"` (shimmer kiri, timer + `■ Esc`
   kanan), menggantikan satu baris rata kiri.

## 4e. Agen jadi DEFAULT (2026-11-09) — perbaikan atas komplain Reza di Termux

**Latar:** Reza tes 0.1.6 di Termux ("cek project kita" di chat biasa)
dan model menjawab "Saya tidak dapat melihat file..." — chat biasa
tidak punya tools sama sekali. Akar masalah: agen hanya hidup di
balik toggle `/agent`, chat biasa = `send()` polos tanpa system
prompt. Di Freebuff pemisah itu TIDAK ADA.

**Bukti dari source Freebuff (dibaca langsung, bukan README):**
- `cli/src/chat.tsx:1031` `onSubmitPrompt(content, mode)` →
  `routeUserPrompt({ agentMode: mode, sendMessage, ... })`.
- `cli/src/commands/router.ts:258` `routeUserPrompt` → baris 480
  komentar "Regular message or unknown slash command - send to
  agent" → baris 555 `sendMessage({ content: trimmed, agentMode })`.
- `cli/src/hooks/use-send-message.ts:315` `sendMessage` → baris 985
  `client.run(runConfig)` (SDK run = agent loop). Tidak ada jalur
  chat-tanpa-tools di rantai ini. Mode hanya memilih definisi agen
  (`cli/src/utils/constants.ts:177-185` `AGENT_MODE_TO_ID`).
- Spacing: `cli/src/components/message-block.tsx:275` gap 1 antar
  blok konten; `cli/src/components/message-with-agents.tsx:215`
  `paddingBottom: 1` antar pesan (kecuali terakhir).
- Thinking: `cli/src/components/thinking.tsx` — header glyph
  (`•` saat reasoning, `▾`/`▸` saat expand/collapse) + BOLD
  "Thinking", preview 5 baris terakhir (`PREVIEW_LINE_COUNT = 5`),
  italic muted, `paddingLeft: 2`.
- System prompt: `agents/base3.ts` `createBase3` (~baris 128) —
  `systemPrompt` (~baris 209) + `${PLACEHOLDER.
  KNOWLEDGE_FILES_CONTENTS}` + `${PLACEHOLDER.GIT_CHANGES_PROMPT}`;
  konteks proyek `packages/agent-runtime/src/system-prompt/
  prompts.ts:86` `getProjectFileTreePrompt` (path proyek = cwd
  untuk perintah terminal) + `:153` `getSystemInfoPrompt` + `:185`
  `getGitChangesPrompt`.

**Perubahan MethaTech:**
- `src/ui/ChatApp.tsx`: fungsi `send()` chat polos DIHAPUS total
  (4.161 byte — sumber bug); `sendAgent` jadi satu-satunya `send`.
  Semua pesan non-slash lewat agent loop dengan system prompt agen
  (definisi tools + tree proyek + cwd). `/agent` dihapus dari
  palette; diketik manual hanya mencetak status selalu-aktif.
  Footer selalu menampilkan `· Agent: Default`. Harga footer
  disingkat jadi `FREE` (header sudah menampilkan `FREE $0.00`)
  + cascade overflow (cwd → nama chat) supaya `Chat: New chat`
  tidak terpotong jadi `New cha` di 80 kolom.
- `src/agent/loop.ts`: event `reasoning` baru — reasoning dari
  model diteruskan dari `streamChat.onReasoning` lewat `callModel`
  ke TUI (sebelumnya Thinking tidak pernah sampai di mode agen).
  Abort di tengah `callModel` dilaporkan sebagai `interrupted by
  user`, bukan `model call failed`.
- `src/ui/ChatApp.tsx` (lanjutan): event `reasoning` diakumulasi
  ke field `thinking` pesan assistant (kartu Thinking); setelah
  loop, bila dibatalkan tampil `Request dibatalkan.` (dulu hilang
  ditelan loop — s16/s24).
- `src/ui/layout.ts` `flattenMessages`: baris kosong setelah blok
  Thinking sebelum jawaban (Freebuff `message-block.tsx:275`
  gap 1); pesan assistant kosong tidak memancarkan baris (Freebuff
  `single-block.tsx` teks kosong → null).
- `src/ui/palette.ts`: `/agent` dihapus (12 perintah); deskripsi
  `/mode` diperbaiki (`default/lite/max/plan`).
- Tes: `test/palette.test.mjs` (12 perintah, tanpa `agent`),
  `test/layout.test.mjs` (2 tes baru: blank setelah Thinking,
  tanpa blank ganda bila jawaban kosong), `test/tui-pty.sh` s1
  (footer `Agent: Default`) + s2 (palette tanpa `/agent`),
  `test/agent-pty.sh` A1/A2 tanpa kirim `/agent` (A1 membuktikan
  agen jalan by default).

**Hasil tes (setelah perbaikan):** `npx tsc` bersih; `npm test`
118/118; `bash test/agent-pty.sh` 27/27; `bash test/tui-pty.sh`
128/128. Tes tmux manual "cek project kita" (mock agent, tanpa
`/agent`): file `hello.txt` teredit, `agent-ran.txt` tercipta
(shell jalan), preview tool + hasil tampil, XML tidak bocor.
Screenshot: `docs/images/agent-default-welcome-small.png`,
`agent-default-cek-proj-{small,desktop}.png`,
`agent-default-thinking-{small,desktop}.png` — warna + spacing
diverifikasi visual oleh GLM.

**Catatan jujur:** s23 (`PgUp` dengan picker terbuka) lolos lewat
nama chat di footer (`Chat: pesan 01`), bukan dari history yang
terlihat — satu PgUp menggeser 11 baris (0.8 × viewport 14 baris
saat picker terbuka) sementara history 8 pesan = 40 baris, jadi
`pesan 01` tidak mungkin terlihat setelah satu PgUp. Scroll-nya
sendiri benar (picker tetap terbuka, indikator `↑ 11 baris di
atas` tampil); ekspektasi tes itu lemah, bukan perilaku produk
yang salah.

## 5. Hasil build + test

- `npx tsc` (strict): BERSIH.
- `npm test`: **118/118 lolos** (115 sebelum agent-as-default + 3
  baru: palette 12 perintah tanpa `/agent`, blank setelah Thinking,
  tanpa blank ganda bila jawaban kosong).
- `bash test/tui-pty.sh`: **128/128 lolos** (127 sebelum
  agent-as-default; s1 kini memeriksa footer `Agent: Default`, s2
  memeriksa palette TIDAK berisi `/agent`; 6 kegagalan awal putaran
  ini — s16/s24 interrupt tanpa `dibatalkan`, s19 footer `Chat:
  New chat` terpotong, s20 Thinking tidak tampil di mode agen, s23
  footer terpotong — semuanya diperbaiki dan hijau).
- `bash test/agent-pty.sh`: **27/27 lolos** (28 sebelum
  agent-as-default; A1/A2 kini tanpa kirim `/agent` — A1 membuktikan
  agen jalan BY DEFAULT dari welcome screen).
  - Parser: chunk boundary per karakter, multi tool call, JSON rusak
    → parse error, tag tak tertutup → parse error.
  - Tool: baca/tulis/edit/grep/glob di direktori sementara, path
    keluar proyek ditolak, tulis yang ditolak (deny) tidak menyentuh
    disk, `str_replace` wajib unik, tool tak dikenal → error result.
  - Gate: `git status`/`ls && cat` read-only, `rm -rf`/`git push`/
    `curl|sh` berbahaya, `AlwaysAllowStore` tidak pernah menyimpan
    perintah berbahaya.
  - Loop (mock model): baca file lalu `task_completed` (2 step),
    jawaban teks polos (1 step), JSON rusak → retry, error tool →
    retry, PLAN menolak `write_file` di level toolset, `ask_user`
    menjeda turn.
  - Skill: frontmatter valid/gagal, discovery proyek + home, load.
  - Prompt: identitas MethaTech, tanpa "Buffy"/"Playground", format
    XML tercantum; `/init` + `/export` + `/compact`.
- `bash test/agent-pty.sh` (mock server, tmux asli): **22/22 lolos.**
  - A1: `/agent` → footer `Agent: Build`; kirim tugas → preview
    `Read hello.txt` + isi file tampil; kotak konfirmasi muncul
    sebelum shell dan agen menunggu di gate; tekan `1` → shell jalan
    (`agent-ran.txt` tercipta), teks akhir `task_completed` tampil;
    XML tool call tidak bocor ke chat.
  - A2: `/mode plan` → footer `Agent: Plan`; baca tetap jalan, shell
    ditolak di level toolset (`unavailable tool in this mode`), tanpa
    kotak konfirmasi.
  - A3: `/init` tidak menimpa `AGENTS.md` yang ada; `/export`
    menulis `metatech-export-*.md` di folder proyek.
- `bash test/tui-pty.sh` (suite regresi TUI lama): **106/106 lolos.**
  Satu kegagalan awal (`s2: palette lists /exit`) adalah ekspektasi
  usang: palette menampilkan jendela scroll 8 baris dan kini ada 13
  perintah, jadi `/exit` berada di bawah lipatan saat pertama dibuka
  dan baru muncul setelah Down 12×. Perilaku jendela tidak berubah;
  test diperbarui untuk menavigasi ke `/exit` (bukan menaikkan batas
  baris — 13 baris akan memeras area pesan di 24 baris).

## 6. Screenshot (capture tmux asli, `test/render-ansi-png.py`)

Semua dicek visual langsung sebelum laporan: hijau neon terlihat,
perilaku agen koding kelihatan, mode di status bar.

| File | Isi |
|---|---|
| `docs/images/agent-confirm-desktop.png` | 80×24: tool call `Read hello.txt` + hasil, `$ touch agent-ran.txt && echo hello-agent`, `working... 3s · Agent step 2`, kotak konfirmasi kuning + `[1] Allow once · [2] Allow always · [3] Deny`, footer `Agent: Build` |
| `docs/images/agent-done-desktop.png` | 80×24: run selesai — teks akhir + `Task completed ✓ task completed: selesai`, footer `Agent: Build` |
| `docs/images/agent-confirm-small.png` | 40×15: kotak konfirmasi + footer `glm-5.3-flash · Agent: Build` |
| `docs/images/agent-done-small.png` | 40×15: run selesai di terminal kecil |

Catatan visual: di terminal kecil, perintah + cwd di kotak konfirmasi
dipotong tengah (`…`) supaya tidak wrap berantakan; hasil tool yang
panjang dirapikan jadi satu baris ringkas (120 karakter, newline →
` / `).

## 7. Yang BELUM terverifikasi live (jangan diklaim sudah)

- **Model gratis panel mana yang bisa mengikuti format XML tool call
  — BELUM terverifikasi.** Semua uji agen di atas memakai mock model
  (skrip) atau mock server. Belum ada satu pun panggilan live ke
  `api.methatech.eu.org` dengan mode agen. Sebelum dipakai serius,
  uji tiap model gratis: minta 5–10 tool call XML dan hitung yang
  valid; model yang gagal harus ditolak untuk mode agen dengan pesan
  jelas (belum dibangun — saat ini mode agen mengizinkan semua model).
- **Pesan role `tool` ke panel — BELUM terverifikasi.** Loop mengirim
  hasil tool sebagai `{role: "tool", tool_call_id, name}` (format
  OpenAI-compatible). Panel mungkin menolak role ini; kalau ditolak,
  loop berakhir dengan error model call — belum diuji live.
- **Biaya/usage mode agen — BELUM tampil.** `streamChat` mengembalikan
  usage, tapi loop agen tidak (belum) menampilkannya per step di
  status bar.
- **Sub-agent (Fase 3) TIDAK dibangun** — `spawn_agents`, reviewer +
  basher paralel, compaction: belum ada.
- **`/compact` ringkasan memakai model yang sama** (bukan sub-agent
  `context-pruner`); ambang otomatis 80% konteks belum ada — `/compact`
  hanya manual.
- **Deny pada perintah shell tidak menghentikan turn secara paksa:**
  model mendapat hasil error dan bisa mencoba perintah lain; tidak
  ada "deny = akhiri turn" (perilaku ini disengaja mengikuti pola
  retry Freebuff, tapi perlu diuji perilakunya di model nyata).

## 8. Cara mencoba (lokal, tanpa publish/deploy)

```sh
cd ~/workspace/metatech-cli
npm run build
# butuh METATECH_API_KEY / login seperti biasa, lalu di TUI:
#   /agent            -> agen aktif (mode Default)
#   /mode plan        -> ganti ke Plan (baca + rencana saja)
#   kirim tugas coding; tool jalan langsung tanpa konfirmasi
# Uji mock (tanpa panel): bash test/agent-pty.sh
# Uji unit: npm test
```
