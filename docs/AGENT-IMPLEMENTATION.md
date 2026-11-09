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

## 4f. Adopsi text rendering Freebuff — semantic colors, typography, Markdown (2026-11-09)

**Latar:** Reza kirim TASK adopsi text rendering Freebuff ke TUI
MethaTech (0.1.8): warna berdasarkan peran semantik teks (bukan
satu warna rata), hierarki tipografi (bold/italic/dim), Markdown
dirender penuh (bukan simbol mentah), output tool/agent ikut
styling status eksekusi. Audit GLM menemukan 14 gap di 0.1.7
(lihat bawah). Syarat: jangan ubah logika agen, tool execution,
provider model, atau komponen TUI lain; backup + git checkpoint
dulu; jangan commit/push/deploy (0.1.8 hanya jalan bila Reza
bilang "gaz").

**Bukti dari source Freebuff (dibaca langsung, bukan README):**
- `cli/src/utils/theme-system.ts` dark theme: primary #9EFC62,
  secondary #a3aed0, success #22c55e, error #ef4444, warning
  #FFA500, info #9EFC62, link #3B82F6, foreground #f1f5f9, muted
  #acb3bf, border #536175, surface #202327, aiLine #6b7280,
  userLine #9EFC62. Markdown palette: codeBackground #374151,
  codeHeaderFg #5b647a, inlineCodeFg #FF8534, codeTextFg #f1f5f9,
  headingFg semua level #facc15, listBulletFg #a3aed0,
  blockquoteBorderFg #334155, blockquoteTextFg #e2e8f0, dividerFg
  #283042, codeMonochrome false.
- `cli/src/utils/markdown-renderer.tsx`: unified + remark-parse +
  remark-gfm + remark-breaks → mdast; `MarkdownPalette`;
  `renderMarkdown` / `renderStreamingMarkdown` /
  `renderStreamingMarkdownIncremental` (cache + safe boundaries);
  wrapText pakai stringWidth (Unicode-aware); renderTable =
  tabel box-drawing (border ┌┬┐├┼┤└┴┘, header bold + headingFg,
  border dividerFg, sel wrap, shrink proporsional);
  parseInlineFallback; heading = bold + headingFg + '\n\n';
  inline code = fg inlineCodeFg + bg codeBackground + BOLD +
  spasi; code block header `// lang` codeHeaderFg, body
  monochrome; list marker listBulletFg (`- `, `N. `, `[x] `,
  `[] `); blockquote `> ` borderFg + teks blockquoteTextFg;
  link fg linkFg; strong BOLD; emphasis ITALIC; delete
  (strikethrough) DIM; thematic break '─' lebar max(10,
  min(codeBlockWidth, 80)) dividerFg; paragraf '\n\n' (tight
  '\n' sebelum blockquote/list).
- `cli/src/components/blocks/single-block.tsx:102`: teks user
  ITALIC; teks kosong render null; blok reasoning return null.
- `cli/src/components/blocks/tool-branch.tsx`:
  run_terminal_command tampilkan 3 baris stdout TERAKHIR;
  `$ command` preview; tool call tersembunyi collapse.
- `cli/src/components/tools/tool-call-item.tsx`: header `• `/`▸ `/
  `▾ ` + nama tool BOLD foreground; ` running` primary + DIM;
  collapsed preview muted + ITALIC.
- `cli/src/components/tools/run-terminal-command.tsx` +
  `terminal-command-display.tsx`: `$ ` success green, command
  BOLD foreground, timeout muted + DIM, output muted, `Show N
  more lines` secondary + UNDERLINE; parseTerminalOutput gabung
  stdout + stderr, error → `Error:...`.
- `cli/src/components/thinking.tsx`: PREVIEW_LINE_COUNT = 5;
  `•` reasoning / `▾` expanded / `▸` collapsed + BOLD
  "Thinking"; preview = 5 baris terakhir, italic muted,
  paddingLeft 2; satu `**bold**` di bawah 100 karakter render
  NOTHING.
- `cli/src/components/blocks/content-with-markdown.tsx`:
  streaming pakai incremental cache; tanpa markdown → raw text.
- `common/src/util/terminal-safe-text.ts`:
  sanitizeTerminalOutput strip ESC/OSC/CSI/C0/C1/invisible
  Unicode; newline survive, tab → 2 spasi, bare `\r` hanya
  simpan teks setelah `\r` terakhir.
- `message-block.tsx:275` gap 1 antar blok;
  `message-with-agents.tsx:226` paddingBottom 1 antar pesan
  (kecuali terakhir).

**Audit MethaTech 0.1.7 (HEAD 3897be2) — 14 gap:**
1. `*italic*`/`_italic_` tidak diparse inlineSegments (hanya
   `**bold**`, `` `code` ``, `[link](url)`).
2. `~~strike~~` tidak diparse (VisualSegment punya flag
   strikethrough tapi tak pernah diset dari `~~`).
3. Item list tidak parse inline markdown.
4. Tidak ada task list `- []`/`- [x]`.
5. Tidak ada tabel (`| a | b |` tampil mentah).
6. Blockquote pakai `▎` bukan `> ` Freebuff.
7. Divider tidak di-cap (Freebuff cap min(width, 80)).
8. Code fence tak tertutup saat streaming ikut di-markdown-parse
   (Freebuff tampilkan pending fence mentah sebagai code).
9. wrapText pakai panjang string JS, bukan Unicode-aware
   (Freebuff pakai stringWidth, wide char = 2 sel).
10. TIDAK ADA sanitasi ANSI di mana pun.
11. Pesan tool string polos — preview accentSecondary non-bold,
    hasil muted apa pun statusnya (✗ harusnya merah error).
12. Heading tidak parse inline code di dalamnya.
13. Pesan user tidak parse inline markdown.
14. Tidak ada tight-followup (paragraf sebelum list/blockquote
    '\n' di Freebuff, '\n\n' di MethaTech).

**Keputusan yang dicatat:** heading tetap semua kuning #facc15
(tema dark Freebuff; ide judul utama cyan/biru di TASK tidak ada
di source Freebuff, TIDAK diadopsi); preview tool BOLD foreground
(Freebuff) dengan `$ ` success green untuk shell; `✓` success
green + teks muted, `✗` error red + teks error; 3 baris terakhir
digabung " / " dipertahankan (pilihan ringkas MethaTech);
`~~` → DIM (Freebuff delete → DIM), todos tetap strikethrough;
blok error ChatApp sudah merah (baris 1463).

**Perubahan MethaTech:**
- `src/ui/terminal-safe.ts` (BARU): port verbatim
  sanitizeTerminalText/sanitizeTerminalOutput dari Freebuff
  (Apache-2.0) — regex DEFAULT_IGNORABLE diverifikasi
  byte-identik dengan source asli.
- `src/ui/layout.ts`: `cellWidth`/`textWidth` Unicode-aware
  (dipakai wrapText/splitSegments/lineLength); `VisualSegment.dim`
  baru; `inlineSegments` ditulis ulang jadi scanner
  (`***bold+italic***`, `**bold**`, `__bold__`, `~~strike~~` →
  DIM, `` `code` ``, `[link](url)`, `*italic*`, `_italic_` —
  dengan aturan word-boundary CommonMark supaya
  `some_variable`/`a*b*c` tetap literal); `markdownLines`:
  heading parse inline (tetap bold kuning), blockquote `> `,
  list task checkbox + inline parsing, divider cap 80;
  `tableLines` (BARU, export): tabel box-drawing, header bold
  kuning, border dividerFg, wrap + shrink proporsional,
  alignment `:---`/`---:`/`:---:`, padding dari lebar visible
  (bukan panjang mentah bermarker); `flattenMessages`: deteksi
  run baris tabel, tight-followup (tanpa blank sebelum
  list/blockquote/heading/divider/tabel), blank beruntun collapse
  jadi satu (pendingBlank di level parts — blank sebelum code
  block dipertahankan), pesan tool terstruktur
  (`LayoutMessage.tool` {name, preview, shell, results[]} —
  preview BOLD, `$ ` hijau sukses + command BOLD di-wrap per
  kata (lanjutan indent 2 spasi, tidak pernah putus tengah
  kata), `✓` hijau / `✗` merah), pesan user parse inline
  markdown (tetap italic, label `You: ` bold non-italic);
  sanitasi di render boundary `flattenMessages` (content +
  thinking + todos + tool preview/results) — SATU choke point
  tempat semua teks eksternal dibersihkan sebelum mencapai
  terminal.
- `src/ui/syntax.ts`: `splitMessageParts` — fence tak tertutup
  jadi part `code` (pending fence tampil sebagai code dengan
  header `// lang`, isinya tidak di-markdown-parse saat
  streaming).
- `src/agent/tools.ts`: `toolPreview` disanitasi di sumber
  (display-only, tidak masuk history model).
- `src/ui/ChatApp.tsx`: `pushTool(preview, toolName)` +
  `appendToLastTool(summary, ok)` terstruktur (content tetap
  simpan render teks polos untuk konsumen lain); `pushSystem`,
  `setError` (2 site), ringkasan `/compact` disanitasi;
  `dimColor={seg.dim}` di kedua render site segmen (welcome +
  pesan); streamed text/reasoning SENGAJA disimpan mentah —
  sanitasi per-delta akan merusak escape sequence yang terbelah
  antar chunk (parameter byte chunk kedua bocor jadi teks
  "31m"); sanitasi terjadi di `flattenMessages` atas konten
  penuh yang sudah tersusun ulang.
- Tes: `test/terminal-safe.test.mjs` (BARU, 9 tes),
  `test/layout.test.mjs` (+27 tes: lebar Unicode, emphasis,
  strikethrough, task list, tabel, tight-followup, tool
  terstruktur, user inline, ANSI strip, unclosed fence,
  blank teks→code), `test/mock-server.mjs` respons
  `MOCK_MARKDOWN=1` (showcase semua fitur Markdown),
  `test/tui-pty.sh` s25 (13 check: marker mentah TIDAK ada,
  bentuk render ADA) + perbaikan bug helper `check`/
  `check_absent` (needle diawali `-` harus pakai `grep -qF --`,
  sebelumnya "lolos" palsu karena grep error).
- TIDAK ada dependency tambahan. TIDAK ada commit/push/deploy
  (checkpoint branch `checkpoint-text-rendering-0.1.7` di
  3897be2; kerja ini untuk 0.1.8, publish hanya bila Reza
  bilang "gaz").

**Hasil tes (setelah perbaikan):** `npx tsc` bersih;
`npm test` 154/154 (118 lama + 36 baru); `bash test/tui-pty.sh`
141/141 (128 lama + 13 s25 baru); `bash test/agent-pty.sh`
27/27. Screenshot (capture tmux asli,
`test/render-ansi-png.py`): `docs/images/text-rendering-s25-small.png`
(80x24), `docs/images/text-rendering-s25-desktop.png` (120x36) —
heading kuning bold, italic miring, strikethrough redup,
blockquote `> `, tabel header kuning, inline code oranye di bg
abu, link biru, divider ter-cap 80 di desktop — diverifikasi
visual oleh GLM dari ANSI capture (kode warna 220/215/75/59
cocok dengan palet Freebuff).

**Catatan jujur:** perbaikan `check`/`check_absent` (`grep -qF
--`) ditemukan karena s25 check `- [x]` mencetak `grep:
invalid option` tapi tetap PASS — grep yang error dianggap
"tidak ketemu". Check itu sudah diverifikasi manual ke file
capture (`grep -F -- "- [x]"` exit 1 = memang tidak ada) dan
suite penuh diulang sesudah perbaikan helper. Preview tool
panjang awalnya hard-split tengah kata (`lin/e4`) — diperbaiki
jadi word-wrap sebelum suite final.

## 4g. Adopsi horizontal gutter Freebuff — SIDE_GUTTER (2026-11-09)

**Latar:** Reza kirim screenshot (tampilan TUI di galeri HP-nya,
dengan panah hijau ke kiri dan kanan terminal) + TASK: konten TUI
terlalu dekat dengan batas terminal, tidak ada jarak kiri-kanan
(gutter). Perintah: referensi WAJIB source asli Freebuff, audit
dulu, implementasi spacing Freebuff, FOKUS HANYA horizontal
spacing/layout (jangan ubah warna, typography, tema, ikon, sistem
rendering, agent runtime, tool calling, shell, logika percakapan,
arsitektur TUI), backup file, tes di 40/80/120 kolom dengan
screenshot yang dicek visual sendiri. Untuk 0.1.8 bersama text
rendering; TIDAK commit/push/publish/deploy sebelum Reza bilang
gaz.

**Referensi Freebuff (commit 5d8bd24, dibaca langsung dari source,
bukan README/screenshot/asumsi):**

| File:baris | Yang ditemukan |
|---|---|
| `cli/src/hooks/use-terminal-dimensions.ts` | `separatorWidth = Math.max(1, Math.floor(terminalWidth) - 2)`; `contentMaxWidth = Math.max(10, Math.min(terminalWidth - 4, 80))` |
| `cli/src/chat.tsx` (scrollbox contentOptions) | `paddingLeft: 1, paddingRight: 2` (kanan 2 = 1 gutter + 1 track scrollbar); ad row wrapper `marginLeft: 1, marginRight: 1` |
| `cli/src/components/message-with-agents.tsx:105,148-149` | `SIDE_GUTTER = 1`; contentBoxStyle `paddingLeft: SIDE_GUTTER, paddingRight: SIDE_GUTTER`, width 100% |
| `cli/src/components/chat-header.tsx:46-47` dan `freebuff-chat-header.tsx:110-111` | `paddingLeft: 1, paddingRight: 1` (di dalam scrollbox) |
| `cli/src/components/status-bar.tsx:41,279-280` | `paddingLeft: 1, paddingRight: 1` (root level, di luar scrollbox) |
| `cli/src/components/chat-input-bar.tsx:485-499` | ClickableTitleBox `width: '100%'` + `paddingLeft: 1, paddingRight: 1` (border selebar terminal, gutter DI DALAM border); baris dalam juga padding 1/1 |
| `cli/src/components/separator.tsx:30` | `separatorWidth = Math.max(1, width - widthOffset)`; pemanggil passing `terminalWidth - 2` |
| `cli/src/hooks/use-chat-ui.ts:61` | `messageAvailableWidth = separatorWidth` |

Geometri Freebuff yang dihasilkan (lebar terminal W): teks pesan di
kol 2 (scroll 1 + message 1), lebar W-5; teks header kol 2 (scroll
1 + header 1); teks status bar kol 1 (root 1); teks input kol 2
(border kol 0 + padding 1); separator kol 1..W-2. Root box chat.tsx
TIDAK punya padding — semua gutter berasal dari layer dalam.

**Audit MethaTech sebelum perubahan (diukur live di tmux, 80 kol,
MOCK_MARKDOWN=1):** root `<Box paddingX={1}>` sudah memberi gutter
1 kol (layer scroll container); `contentWidth = columns - 4`;
teks pesan mulai kol 1 (bar user di kol 1, teks user kol 3);
heading/tabel/divider mulai kol 1; divider 76 lebar (kol 1..76);
border input kol 1..78, teks input kol 3; footer kol 1. Penyebab
keluhan: teks pesan hanya 1 kol dari tepi — di layar HP 1 kol
hampir tidak terlihat, jadi konten terasa menempel di tepi.
Freebuff menaruh teks pesan di kol 2 (1 scroll + 1 message).

**Implementasi (layered, mengikuti Freebuff, bukan angka statis):**

- `src/ui/layout.ts`: konstanta baru `SIDE_GUTTER = 1`
  (Freebuff message-with-agents.tsx:105) + komentar layering.
  `flattenMessages` kini prepend 1 spasi gutter ke SETIAP baris
  hasil flatten (termasuk blank separator, Thinking, todos, tool,
  system) — `width` yang diterima adalah lebar TEKS (sudah minus
  gutter), jadi divider/tabel mempertahankan tepi kanan yang sama.
  `markdownLines`/`tableLines` TIDAK diubah (fungsi konten murni;
  gutter hanya di level perakitan pesan).
- `src/ui/ChatApp.tsx`: `messageWidth = contentWidth - SIDE_GUTTER`
  dipakai di dua pemanggilan `flattenMessages` (tanpa scrollbar dan
  `messageWidth - 1` saat scrollbar tampil); header Box dapat
  `paddingLeft={1}` (Freebuff chat-header, teks header → kol 2).
- Hasil di 80 kol: teks pesan kol 2..76 (lebar 75 = W-5, PERSIS
  Freebuff), gutter kiri 2 kol, kanan 3 kol; teks user kol 4
  (gutter + bar + spasi, sama seperti Freebuff); divider 75 lebar
  (kol 2..76); tabel di dalam area konten; scrollbar tetap di
  kol 78 (track di dalam root padding).
- Perbedaan yang disengaja (dicatat, bukan kelalaian):
  - Footer/status row TETAP kol 1 (Freebuff status-bar root-level
    padding 1 — sama).
  - Input box TETAP border kol 1, teks kol 3. Freebuff menaruh
    border input di kol 0 (menempel tepi) — MethaTech sengaja
    mempertahankan border inset 1 supaya border tidak menyentuh
    tepi, sesuai tujuan TASK. Teks input 1 kol lebih kanan dari
    teks pesan adalah konsekuensi border box, bukan inkonsistensi.
  - Picker TIDAK diubah: baris terpilih memakai highlight
    background full-row; menambah gutter akan memotong highlight.
    Picker adalah overlay sementara, bukan konten pesan.
  - Welcome screen TIDAK diubah: kontennya centered, sudah inset
    jauh dari tepi dengan sendirinya.
- Adaptif: tidak ada angka padding statis yang baru — gutter
  adalah konstanta 1 kol per layer (seperti Freebuff), lebar wrap
  dihitung dari `columns`; `contentWidth` floor 20 → `messageWidth`
  tidak pernah di bawah 19, jadi terminal sempit tidak rusak.
- Backup sebelum modifikasi: `.bak-20261109-gutter/`
  (layout.ts, ChatApp.tsx, layout.test.mjs, tui-pty.sh).

**Test:**

- `npx tsc` (strict): BERSIH.
- `npm test`: **157/157 lolos** (154 sebelum gutter + 3 baru:
  SIDE_GUTTER = 1; setiap baris flattenMessages diawali gutter
  tepat 1 spasi, plain, tanpa warna; gutter tidak mendorong baris
  melewati width + 1 di terminal sempit). 13 assertion string
  eksak lama diperbarui mengikuti gutter (bukan perilaku yang
  berubah — hanya prefix spasi).
- `bash test/tui-pty.sh`: **159/159 lolos** (141 sebelum gutter +
  18 s26 baru) — skenario gutter di 80/40/120 kol dengan
  MOCK_MARKDOWN=1, mengukur leading space tiap elemen dari capture
  tmux asli. s26/80: header 2, heading 2, tabel 2, user 4,
  footer 1, border input 1, placeholder ` │ ▋Enter…` (box tidak
  berubah), divider 75. s26/40: header/heading/tabel/user sama
  (heading + user dicek di capture atas setelah PgUp, tabel di
  capture tengah — viewport ~6 baris tidak muat semuanya sekaligus),
  divider 34 — BUKAN 35: saat scrollbar tampil semua baris di-rewrap
  1 kolom lebih sempit (mekanisme lama: baris user = gutter + bar +
  spasi + teks, jadi lebar teks harus mengecil supaya track muat)
  dan divider mengikuti lebar wrap. s26/120: sama, divider cap 80
  (konten tidak membentang tepi ke tepi). Semua check s1–s25 lama
  tetap lolos — warna, typography, agen, tools tidak berubah.
- `bash test/agent-pty.sh`: **27/27 lolos** (tidak berubah).

**TEMUAN SELAMA TES (bukan regresi gutter, dilaporkan untuk
tindak lanjut terpisah):** di 40 kol, baris `Hasil pemeriksaan dan
~~yang lama~~ sudah diperbarui.` tampil dengan marker `~~` mentah
(`Hasil pemeriksaan dan ~~yang` / `lama~~ sudah diperbarui.`).
Penyebab: `markdownLines` membungkus teks MENTAH dulu (`wrapText`,
marker dihitung sebagai lebar terlihat) baru parse inline per
baris (`inlineSegments`) — kalau wrap jatuh di dalam span
`~~…~~` / `**…**` / `` `…` ``, parser per baris melihat marker
tidak tertutup dan membiarkannya literal. Terbukti bocor di lebar
34, 35, DAN 36 — jadi ini cacat bawaan renderer text 0.1.8 yang
sudah ada sebelum gutter (lebar lama pun membelah span ini),
bukan efek perubahan ini; tes s25 di 80/120 kol tidak pernah
menangkapnya karena wrap tidak jatuh di dalam span. Perbaikannya
(parse-dulu-baru-wrap, atau wrap yang sadar marker) adalah
perubahan sistem rendering — DI LUAR scope task gutter ini, butuh
keputusan/task terpisah. Tidak disembunyikan: capture
`s26-gutter-40-top.plain.txt` menunjukkan kebocorannya.

**Screenshot (dicek visual sendiri):**
`docs/images/gutter-s26-80.png`, `gutter-s26-40.png`,
`gutter-s26-120.png` (render `test/render-ansi-png.py` dari
capture tmux s26; teks pesan jelas inset 2 kol dari tepi kiri,
divider/tabel tidak menyentuh tepi, input tetap rapi, warna dan
typography sama seperti s25).

## 4h. Adopsi Markdown renderer Freebuff — parse-dulu-baru-wrap (2026-11-09)

**Latar:** Reza kirim screenshot Termux 0.1.7 (sesi "cek project
kita" 17:38 UTC): karakter Markdown mentah (`**`, `*`, `` ` ``,
`###`) masih terlihat di output percakapan. TASK: perbaiki
rendering teks area percakapan dengan mengadopsi implementasi
Markdown asli Freebuff — BUKAN regex/string hiding. Scope:
audit Freebuff, audit MethaTech, implementasi rendering yang
benar (bold, italic, strikethrough, inline code, fenced code,
heading, bullet + numbered list, blockquote, tabel, link),
streaming, konsistensi visual (semantic colors MethaTech),
validasi semua sintaks + streaming + terminal sempit/lebar.
Batasan: JANGAN ubah agent runtime, tool calling, shell, sistem
model, atau gutter (§4g). Untuk 0.1.8 bersama text rendering +
gutter; TIDAK commit/push/publish/deploy sebelum Reza bilang
gaz.

**Referensi Freebuff (commit 5d8bd24, dibaca langsung dari source,
bukan README/screenshot/asumsi):**

| File:baris | Yang ditemukan |
|---|---|
| `cli/package.json:47-48,53` | Parser: `unified ^11.0.0` + `remark-parse ^11.0.0` + `remark-gfm ^4.0.1` + `remark-breaks ^4.0.0` |
| `cli/src/utils/markdown-renderer.tsx:109-112` | Processor tunggal: `unified().use(remarkParse).use(remarkGfm).use(remarkBreaks)`; parse SELURUH teks jadi AST mdast dulu, baru render blok dari AST |
| `cli/src/utils/markdown-renderer.tsx:1019` | `renderMarkdown(markdown, options)` — parse + render penuh; palette (inlineCodeFg, codeBackground, headingFg per depth, listBulletFg, blockquoteBorderFg/TextFg, dividerFg, linkFg) |
| `cli/src/utils/markdown-renderer.tsx:1110` | `renderStreamingMarkdown` — tanpa Markdown → teks polos; ada fence backtick terbuka → render bagian lengkap + sisakan fence pending mentah |
| `cli/src/utils/markdown-renderer.tsx:1238` | `renderStreamingMarkdownIncremental` + `StreamingMarkdownCache` — commit teks sebelum `lastSafeBoundary` (di luar fence, sesudah baris kosong, sebelum blok baru), parse ulang hanya ekornya; Markdown non-lokal (definisi link, blok HTML) memaksa render ulang penuh |
| `cli/src/utils/markdown-renderer.tsx:237,314,361` | `parseInlineFallback` / `applyInlineFallbackFormatting` — remark melewatkan pola emphasis tertentu (mis. `Other**.github/**`); node teks sisa di-split ulang pada marker `*`/`**`. `nodeToPlainText` untuk lebar kolom tabel |
| `cli/src/utils/markdown-renderer.tsx:168,655,710` | `splitNodesByNewline`, `wrapText` (word wrap sadar Unicode via `string-width`), `renderTable` (border box-drawing, lebar kolom dari lebar teks polos sel, shrink proporsional, sel di-wrap) |
| `cli/src/utils/markdown-renderer.tsx:467,515,551` | `renderNodes` / `renderBlockquote` / `renderList` — strong → BOLD, emphasis → ITALIC, delete → DIM, inlineCode → bold + spasi + fg/bg, heading → bold + warna per depth, link → label saja (URL tidak ditampilkan), code block → monochrome + header `// lang`, thematicBreak → divider cap 80 |
| `cli/src/components/blocks/content-with-markdown.tsx:27-40` | `ContentWithMarkdown`: `hasMarkdown` → teks polos; streaming → render inkremental dengan cache; selesai → `renderMarkdown` |

**Audit MethaTech sebelum perubahan (akar masalah):** pipeline
lama membungkus teks MENTAH dulu (`wrapText` di layout.ts,
marker dihitung sebagai lebar terlihat) lalu parse inline per
baris dengan scanner regex (`inlineSegments`), dan menangani
blok per baris mentah dengan regex (`markdownLines`,
`tableLines` membungkus teks sel mentah lalu parse inline per
baris). Setiap wrap yang jatuh di dalam span membocorkan marker
mentah — terbukti di lebar 34, 35, 36 (§4g). Penanganan blok
berbasis regex per baris membuat konstruksi multi-baris tidak
pernah diparse sebagai dokumen. Itulah yang terlihat di
screenshot Reza: marker mentah di output.

**Probe parser (diverifikasi dengan menjalankan kode):** remark
mem-parse semua konstruk dengan benar (inlineCode, list termasuk
checkbox, ordered dengan start, tabel dengan align, blockquote
dengan strong di dalam, heading, link, autolink → node link,
hard break → node `break`, nested list, linkReference +
definition, escape `\*` → literal `*`). Perilaku CommonMark
yang penting: `Other**.github/**` tetap SATU node teks literal
(makanya Freebuff punya fallback); `**bold` / `~~strike` yang
belum tertutup tetap teks literal (keadaan sementara saat
streaming, selesai saat marker penutup tiba); `a*b*c` →
emphasis pada "b" (CommonMark mengizinkan `*` intraword —
paritas Freebuff; regex lama MethaTech sengaja membiarkannya
literal — perubahan perilaku yang didokumentasikan);
`some_variable` tetap literal (`_` intraword tidak bisa membuka
emphasis); `2*3` tetap literal. **Catatan:** `remark-breaks`
adalah transform yang hanya jalan di `.process()`/`.run()`,
BUKAN `.parse()` — jadi di Freebuff MAUPUN MethaTech (keduanya
pakai `.parse()`) plugin itu inert; soft break di dalam nilai
teks ditangani pemisahan `\n` di wrap (cerminan
`splitNodesByNewline` Freebuff). Tabel tepat sesudah baris
blockquote tanpa baris kosong ditelan blockquote via lazy
continuation CommonMark (Freebuff akan melakukan hal yang sama
— konten mock diperbaiki dengan baris kosong, seperti respons
model asli).

**Implementasi (parse-dulu-baru-wrap, mengikuti Freebuff):**

- Dependensi baru (major sama seperti Freebuff):
  `unified@^11`, `remark-parse@^11`, `remark-gfm@^4`,
  `remark-breaks@^4` + dev `@types/mdast@^4` (71 paket).
- File baru `src/ui/cells.ts` (166 baris): `cellWidth` +
  `textWidth` dipindah verbatim dari layout.ts supaya
  markdown.ts bisa mengukur teks tanpa import sirkular;
  layout.ts me-re-export keduanya (test lama tetap jalan).
- File baru `src/ui/markdown.ts` (~900 baris): renderer
  parse-first. `parseMarkdown` (processor tunggal),
  `applyInlineFallbackFormatting` + `parseInlineFallback`
  (port Freebuff), `nodeToPlainText` (port Freebuff),
  `inlineSegmentsFromNodes` (strong→bold, emphasis→italic,
  delete→dim, inlineCode→oranye bold di bg abu + spasi,
  link→label biru, linkReference→label polos, image→kosong
  paritas Freebuff, break→spasi, html→teks mentah),
  `inlineGroupsFromNodes` (pisah di node `break`),
  `renderInlineText` (parser fragmen untuk sel tabel/baris
  user; fragmen berbentuk blok fallback ke teks polos),
  `wrapSegments` (wrap segmen ber-style di lebar: greedy word
  wrap, hard-split kata terlalu panjang per sel, whitespace
  menciut jadi satu spasi, prefix keluar dari budget baris,
  gabung atom se-gaya supaya satu run tetap satu segmen,
  potong spasi akhir saat flush kecuali pad inline-code yang
  ber-backgroundColor, pad inline-code dipertahankan di awal/
  akhir baris), `renderBlocks` (paragraf dengan aturan
  tight-followup, heading bold+kuning, list dengan marker/
  checkbox/task/nested indent/ordered start, blockquote prefix
  `> ` + lewati baris kosong, code monochrome, tabel via
  `renderTable`, thematicBreak divider cap 80, html sebagai
  baris polos, definition tidak terlihat), `renderList`,
  `renderTable` (box-drawing, sel diparse DULU jadi segmen
  lalu di-wrap per lebar kolom, alignment dari
  mdast `table.align`, shrink proporsional — algoritma sama
  seperti `tableLines` lama), `renderMarkdownText` →
  `{lines, startsTight, startsBlank, endsBlank}` (baris kosong
  akhir dipotong; blank sesudah paragraf kecuali blok berikut
  tight: blockquote/list/heading/divider/table — aturan
  MethaTech lama yang dipertahankan).
- Streaming: jaminan sama seperti Freebuff — emphasis yang
  belum tertutup tampil literal untuk satu flush lalu selesai
  saat marker penutup tiba; fence yang belum tertutup tetap
  bagian code via `splitMessageParts` (syntax.ts, tidak
  diubah).
- `src/ui/layout.ts` (operasi bedah, tsc bersih): import
  markdown.ts + cells.ts; HAPUS `inlineSegments`,
  `markdownLines`, `isTableRow`/`splitTableRow`/
  `isSeparatorRow`/`cellAlign`/implementasi lama `tableLines`,
  `lineKind`, `isTightFollowup` (aturan tight pindah ke
  markdown.ts sebagai `isTightFollowupType`).
  `tableLines(rows, width)` dipertahankan sebagai adapter
  tipis: parse baris mentah dengan remark, delegasi ke
  `renderTable` markdown.ts (output sama, tanpa duplikasi
  box-drawing). Cabang user `flattenMessages`: tiap baris
  mentah diparse via `renderInlineText` + italic, di-wrap via
  `wrapSegments` (label "You: " 5 kol keluar dari budget
  baris pertama); konten user tetap inline-only (tanpa render
  blok — sama seperti perilaku lama dan
  `UserBlockTextWithInlineCopy` Freebuff). Cabang assistant:
  text part lewat `renderMarkdownText`; logika pendingBlank
  batas part dipertahankan (`startsBlank`/`endsBlank`/
  `startsTight` + flag `emitted` kini di level loop part dan
  diset juga oleh code part). Cabang tool/todos/system/
  thinking TIDAK berubah. `wrapText`, `splitSegments`,
  `splitMessageParts` TIDAK berubah.
- Perubahan perilaku vs renderer lama (didokumentasikan di
  kode + test): `a*b*c` kini meng-italic-kan "b" (paritas
  CommonMark/Freebuff); image tampil sebagai kosong (paritas
  Freebuff); tabel tanpa baris delimiter tampil sebagai
  paragraf literal (CommonMark — kode lama berbasis baris
  menampilkannya sebagai tabel ber-border); `text\n---`
  adalah setext H2 (CommonMark — kode lama menampilkan
  divider).
- Spacing antar-blok kini mengikuti Freebuff secara struktural
  (tiap blok mendorong `'\n\n'`/`'\n'` sesudahnya: blank
  sesudah list/blockquote/tabel/divider — renderer lama lebih
  padat karena aturan tight-followup meniadakan blank itu).
  Konsekuensi terukur: pesan showcase s25/s26 kini 22 baris
  (dulu 18) di area 18 baris pada 80×24 — scrollbar tampil,
  divider 74 (bukan 75), heading/user dicek via capture atas
  setelah PgUp. Ini perilaku Freebuff yang benar, bukan
  regresi; ekspektasi test diperbarui mengikuti perilaku
  baru, bukan sebaliknya.
- Backup sebelum modifikasi: `.bak-20261109-markdown/`
  (layout.ts, syntax.ts, layout.test.mjs, tui-pty.sh,
  mock-server.mjs, package.json) + skrip probe
  (probe-remark.mjs, probe-tree.mjs, probe2–5.mjs).

**Test:**

- `npx tsc` (strict): BERSIH.
- `npm test`: **167/167 lolos** (157 sebelum Markdown +
  10 baru: Freebuff inline fallback `Other**.github/**`,
  unclosed vs closed `**`, escapes + autolink, nested list,
  ordered list start, **tes regresi §4g (tidak ada `~~`
  mentah di lebar 34/35/36/40/80, tidak ada `**` mentah saat
  wrap, tidak ada backtick mentah saat wrap)**, wrapSegments
  hard-split + prefix). 5 kegagalan awal diperbaiki:
  granularitas segmen (gabung atom se-gaya di wrapSegments),
  spasi pad inline-code (pertahankan pad ber-backgroundColor
  di awal/akhir baris), ekspektasi intraword dikoreksi ke
  CommonMark.
- `bash test/tui-pty.sh`: **171/171 lolos** (159 sebelum
  Markdown + 12 s27 baru). s25: semua check tabel/divider/
  marker mentah kini lolos; heading dicek di capture atas
  (1× PgUp). s26/80: divider 74 (scrollbar tampil — pesan
  22 baris di area 18 baris), heading/user kol 2/4 dicek di
  capture atas; tabel tetap kol 2. s26/40: tabel via 2× PgUp,
  heading/user via 4× PgUp (pesan 24 baris di 40 kol), divider
  34. s26/120: sama seperti dulu, divider cap 80. **s27
  (baru, MOCK_MARKDOWN_FULL)**: showcase sintaks lengkap
  (H1/H2, bold, italic, strikethrough, bold+italic, inline
  code, task list, plain list, numbered list, blockquote
  multi-baris, tabel 3 kolom, divider, fenced code `js`,
  link) dikirim per 17 karakter — emphasis dan fence tiba
  TERBELAH antar chunk stream — dan TIDAK ADA marker mentah
  di 80 maupun 40 kol (bukti streaming + regresi §4g di level
  TUI). Semua check s1–s24 lama tetap lolos — warna,
  typography, agen, tools, gutter tidak berubah.
- `bash test/agent-pty.sh`: **27/27 lolos** (tidak berubah).
- Mock: `MOCK_MARKDOWN` diperbaiki (baris kosong sebelum
  tabel — lazy continuation CommonMark menelan tabel ke dalam
  blockquote tanpa itu; Freebuff mem-parse sama); mock baru
  `MOCK_MARKDOWN_FULL` (semua sintaks, chunk 17 karakter).
- **Bug renderer screenshot ditemukan saat cek visual:**
  `test/render-ansi-png.py` `parse_line` memajukan indeks
  hanya `i += 2` sesudah `38;5;N`/`48;5;N` — indeks warna
  `N` lalu diproses ulang sebagai kode SGR; `N=102`
  (codeHeaderFg `#5b647a`) jatuh di rentang 100–107 sehingga
  background baris header code `// js` digambar hijau terang
  palsu. Output TUI (capture ANSI) BENAR — hanya PNG-nya
  yang salah. Diperbaiki: `i += 3` untuk `;5;` dan `i += 5`
  untuk `;2;` (cabang RGB juga laten salah dengan cara yang
  sama). Screenshot di-render ulang sesudah perbaikan;
  screenshot lama (s25/gutter) tidak terpengaruh karena
  warnanya tidak jatuh di rentang itu.

**Screenshot (dicek visual sendiri):**
`docs/images/markdown-s27-80-top.png` (H1 kuning, bold/
italic/strike/bold+italic, inline code oranye, H2, task list,
numbered list, blockquote — tanpa marker mentah),
`markdown-s27-80-bottom.png` (tabel 3 kolom header kuning,
divider, code block `// js` abu + body di bg abu, link biru),
`markdown-s27-40-top.png` (40 kol: span `~~` yang membelah
wrap TIDAK bocor — regresi §4g tertutup di level TUI),
`markdown-s26-80.png`, `markdown-s26-120.png` (spacing blok
Freebuff, gutter tetap kol 2, divider cap 80 di lebar).

## 4i. Mouse wheel scrolling — swipe Termux / wheel desktop (2026-11-09)

**Keluhan Reza (screenshot Termux, panah hijau ke scrollbar):**
riwayat percakapan hanya bisa digulir dengan Arrow Up/Down dan
PgUp/PgDn. Maunya: swipe layar HP ke atas/bawah seperti aplikasi
Android — swipe ke atas lihat percakapan lama, swipe ke bawah
kembali ke terbaru; natural dan responsif; scrollbar kanan
mengikuti viewport; posisi scroll tidak lompat saat AI streaming;
baca riwayat lama tidak ditarik paksa ke bawah; di paling bawah,
respons baru tetap auto-follow; input prompt dan status bar tetap.

**Jawaban atas pertanyaan kuncinya dulu: YA, Ink bisa menerima
event mouse wheel.** Ink 6.8.0 TIDAK punya API mouse (grep
`mouse|1002|1006|wheel` di `node_modules/ink/build/` kosong —
perbedaan terpaksa yang sudah dicatat sejak 0.1.6), TAPI eventnya
sampai ke `useInput` secara utuh: input-parser Ink memotong
sequence CSI di final byte-nya, dan keypress parser-nya
melewatkan sequence yang tidak dikenal apa adanya (bukan arrow
key), jadi handler menerima e.g. `"[<64;10;5M"` (satu ESC depan
sudah dikupas Ink). **Dibuktikan empiris, bukan dari teori:**
probe Ink minimal di tmux (`/tmp/ink-mouse-probe/probe.mjs`,
`tmux send-keys -H` injeksi byte SGR) — wheel up
`\x1b[<64;10;5M`, wheel down `\x1b[<65;10;5M`, tap click
press `\x1b[<0;10;5M` + release `\x1b[<0;10;5m`, dan tombol
biasa `a` semua sampai utuh sebagai satu event `useInput`.
Satu temuan probe: sequence yang terbelah di dua read stdin
dengan jeda (Ink flush partial CSI sesudah satu event-loop
turn) tiba sebagai `"[<64;1"` lalu `"0;5M"` — parser menelan
kedua potongan itu (flag `fragmentPending`) supaya tidak
pernah terketik ke draft. X10 (`ESC [ M` + 3 byte) TIDAK
didukung: parser Ink mengakhiri CSI di byte `M` dan 3 byte
payload tiba sebagai teks biasa — tidak bisa dikenali andal.
Semua terminal modern mengirim SGR begitu 1006h aktif, jadi
ini hanya memengaruhi terminal pra-SGR.

**Mekanisme Freebuff yang diadopsi (source asli, bukan README):**
- `cli/src/chat.tsx:2241` — `<scrollbox stickyScroll
  stickyStart="bottom" scrollX={false}>`; scrollbar vertikal
  hanya tampil saat `!streaming && !waiting && overflow`.
- `cli/src/hooks/use-scroll-management.ts` (206 baris) —
  `scrollTop/scrollHeight/viewport.height`;
  `animateScrollTo` easeOutCubic 200ms/16ms; PgUp/PgDn =
  0.8 viewport; auto-scroll 50ms sesudah messages berubah
  HANYA bila `autoScrollEnabled` (dimatikan selama animasi
  programmatic, dikembalikan ke `isNearBottom` di akhir);
  scroll user mengeset `autoScrollEnabled = isNearBottom`
  lewat event `change` verticalScrollBar;
  `SCROLL_NEAR_BOTTOM_THRESHOLD = 1`.
- OpenTUI 0.3.4 (tag v0.3.4, sumber dibaca langsung):
  `renderer.ts:170,1144` `enableMouse` default true;
  `zig/terminal.zig` `setMouseMode` — enable menulis
  `1003l` dulu lalu `1000h + 1002h + 1006h` (movement=false),
  disable menulis `1003l, 1002l, 1000l, 1006l`;
  `lib/parse.mouse.ts` `decodeSgrEvent` — scroll =
  `button & 64`, arah = `button & 3` (0 up, 1 down), wheel
  up = SGR 64, wheel down = 65, hanya saat press `M`;
  `renderables/ScrollBox.ts:530` `onMouseEvent` — wheel
  memakai `scrollAccel.tick(now)`, default
  `LinearScrollAccel` = 1 baris per tick, diterapkan
  LANGSUNG ke `scrollTop` (tanpa animasi); `stickyScroll`
  menahan bawah saat konten baru masuk kecuali user sudah
  scroll.
- `cli/src/utils/keyboard-actions.ts` — PgUp/PgDn prioritas
  14 → scroll-up/scroll-down (tetap jalan, tidak diubah).

**Mekanisme swipe Termux (source asli termux-app monorepo,
bukan asumsi):** `TerminalView.java` — drag jari →
`GestureDetector.onScroll` → `doScroll(e, deltaRows)`,
`deltaRows = distanceY / fontLineSpacing` dengan
`mScrollRemainder` (pecahan baris diakumulasi, halus).
`doScroll`: bila mouse tracking aktif (`isMouseTrackingActive`
= DECSET 1000 ATAU 1002) → kirim SATU event
`MOUSE_WHEELUP_BUTTON` (64) / `MOUSE_WHEELDOWN_BUTTON` (65)
per baris yang didrag; bila TIDAK aktif dan alternate screen
aktif → kirim DPAD_UP/DOWN (inilah perilaku HARI INI: swipe
di TUI mengirim arrow key → ganti model / recall history,
bukan scroll — akar keluhan Reza); bila tidak aktif dan
bukan alternate screen → Termux menggerakkan transcript-nya
sendiri. Fling: mouse tracking on di awal fling → Scroller
terus memanggil `doScroll` dengan inersia (batas ±mRows/2).
Tap + mouse tracking on → press+release tombol kiri (klik;
aplikasi harus menelannya). `TerminalEmulator.java:553`
`sendMouseEvent` — mode SGR (1006 set) →
`\x1b[<Cb;Cx;CyM` / `m`, koordinat 1-based; semua event wheel
satu gesture melaporkan posisi touch-DOWN. Arah: jari ke
BAWAH → WHEELUP (64) = pesan lama; jari ke ATAS → WHEELDOWN
(65) = pesan baru — sama dengan konvensi desktop. Seleksi
teks tetap jalan: long-press masuk selection mode, dan saat
selecting, touch bypass mouse reporting (`isSelectingText`).

**Yang diubah di MethaTech (semua di 0.1.8, belum commit):**
- BARU `src/ui/mouse.ts` — `MOUSE_ENABLE`
  (`\x1b[?1003l\x1b[?1000h\x1b[?1002h\x1b[?1006h`) dan
  `MOUSE_DISABLE` (`\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1006l`,
  urutan persis OpenTUI; 1003h any-event TIDAK PERNAH
  diaktifkan supaya motion mouse tidak membanjiri input);
  `WHEEL_LINES = 1` (paritas LinearScrollAccel; 1 baris
  Termux per event = 1:1 dengan jari); `parseMouseInput`
  (murni, unit-tested): ekstrak wheel up/down dari SGR
  lengkap (dengan/tanpa ESC depan), telan klik/drag/motion/
  release/wheel horizontal, kembalikan sisa teks untuk jalur
  keyboard, telan sequence terbelah (`fragmentPending`).
- `src/ui/layout.ts` — BARU `wheelScrollOffset`
  (1 baris per event, clamp dua ujung) di samping
  `pageScrollOffset`; TIDAK ada perubahan lain di file ini.
- `src/ui/ChatApp.tsx` — intercept mouse di `useInput`
  SEBELUM splitter atomik (tanpa ini sequence wheel
  dicacah jadi karakter `"[<64;10;5M"` yang terketik ke
  draft); wheel membatalkan animasi PgUp yang sedang jalan
  (Freebuff: user scroll membatalkan animasi) lalu
  diterapkan LANGSUNG via `setScrollOffsetBoth` (tanpa
  animasi 200ms — fling mengirim banyak event sekaligus);
  saat picker terbuka wheel memindah seleksi picker
  (`pickerPrev/pickerNext`), saat palette terbuka memindah
  seleksi palette (`palettePrevIndex/paletteNextIndex`),
  selebihnya menggulir riwayat. **Regresi yang ditemukan
  suite PTY (2026-11-09, SUDAH DIPERBAIKI):** versi pertama
  menulis `if (rest.length === 0) return;` — padahal event
  key-only (Arrow Up/Down, PgUp/PgDn, Tab, Esc) tiba dari
  Ink dengan `input === ""` dan maknanya di flag `key`
  (dibuktikan probe2: semua enam tombol itu `len: 0` +
  flag), jadi semuanya tertelan dan s2/s10/s15/s16/s17/s23
  gagal (21 check). Perbaikan: bila `rest` kosong DAN
  `inputKey` kosong, tetap panggil `handleAtomicKey("",
  key)` — persis perilaku pra-mouse untuk input panjang
  <= 1. Routing key-only ini tidak bisa di-unit-test
  (hidup di callback `useInput` ChatApp); yang menjaganya
  adalah skenario PTY s2/s10/s15/s16/s17/s23. Auto-scroll 50ms yang sudah
  ada TIDAK diubah: ia hanya snap ke 0 bila
  `scrollOffset <= 1`, jadi baca riwayat lama saat streaming
  tidak ditarik ke bawah, dan di paling bawah respons baru
  tetap auto-follow. Input prompt, status bar, Markdown
  renderer, warna, gutter, agent runtime, tool calling —
  TIDAK disentuh.
- `src/commands.ts` `cmdChat` — enable mouse reporting
  sebelum `render()`, disable sesudah `waitUntilExit()` +
  guard `process.on("exit")` (idempotent) supaya crash/
  exit tidak meninggalkan shell dalam mouse mode. Hanya
  untuk TUI chat; layar one-shot (models/account) tidak
  mengaktifkannya. Hard kill (SIGKILL) tidak bisa menjalankan
  guard — reset manual:
  `printf '\e[?1006l\e[?1002l\e[?1000l'`.
- Backup: `.bak-20261109-scroll/` (ChatApp.tsx,
  commands.ts, layout.ts, layout.test.mjs, tui-pty.sh).

**Dampak mouse mode terhadap seleksi teks (diperiksa,
bukan diasumsikan):** selama TUI jalan, terminal mengirim
klik/drag ke aplikasi, bukan seleksi native. Termux:
long-press selection TETAP jalan (bypass saat selecting).
Desktop: Shift+drag biasanya bypass app mouse mode
(tergantung terminal). Mouse mode mati lagi begitu TUI
keluar, jadi seleksi shell normal kembali.

**Tes:**
- `test/mouse.test.mjs` (BARU, 8 tes): enable/disable =
  set DECSET OpenTUI; wheel 64/65 dengan/tanpa ESC; burst
  fling multi-event berurutan; klik/drag/motion/release/
  wheel horizontal ditelan; teks biasa lolos utuh; wheel +
  teks dalam satu delivery terpisah benar; sequence terbelah
  dua read ditelan; wheel + modifier (Ctrl/Shift) tetap
  scroll.
- `test/layout.test.mjs` — `wheelScrollOffset` (1 tes,
  11 assert): 1 baris per tick, clamp atas/bawah, burst 3.
- `npm test`: **176/176 lolos** (167 lama + 9 baru).
- `bash test/tui-pty.sh`: **s28 (BARU, 19 check)** —
  helper `wheel()`/`tap()` injeksi SGR via
  `tmux send-keys -H` (satu write membawa N event, seperti
  fling Termux): bottom → wheel ke top (indikator tepat 1,
  H1 tampil) → down 12 (indikator 13) → up 5 (indikator 8)
  → kembali ke bottom (tanpa indikator) → tap tidak
  mengubah view dan tidak mengetik apa pun → wheel ke atas
  DI TENGAH streaming, stream selesai, view TETAP di atas
  (tidak di-yank ke bawah) → 40 kol (top = 1, down 8 = 9,
  tanpa marker `~~`). Angka indikator: hiddenAbove =
  maxOffset − offset + 1 saat baris indikator tampil (baris
  itu memakan 1 baris budget pesan) — di top selalu tepat 1
  apa pun totalnya, jadi check berjangkar di top, bukan di
  maxOffset yang tergantung konten mock. Suite penuh:
  **190/190 lolos** (lihat §5).
- `bash test/agent-pty.sh`: **27/27 lolos** (tidak berubah).

**Screenshot (dicek visual sendiri):**
`docs/images/wheel-s28-80-top.png`,
`wheel-s28-80-down12.png`, `wheel-s28-80-streaming.png`,
`wheel-s28-40-down8.png` (render dari capture tmux asli
s28).

**Yang BELUM terverifikasi — jujur, jangan diklaim:**
- Swipe di HP Android FISIK belum dites (tidak ada perangkat
  Android di sini). Rantai bukti: source Termux (doScroll →
  wheel 64/65 SGR) + probe Ink (SGR sampai utuh ke useInput)
  + PTY s28 (injeksi SGR byte-identik). Verifikasi live di
  Termux Reza tetap diperlukan sebelum klaim "swipe jalan".
- Wheel desktop (iTerm2/WezTerm/Kitty/Windows Terminal/
  GNOME Terminal) memakai byte SGR yang sama saat 1006h
  aktif — mekanisme sama, tapi belum dites di tiap terminal
  itu (hanya tmux di Linux).
- Mouse mode di terminal yang tidak mendukung SGR (pra-1006)
  tidak dites; X10 tidak didukung (lihat atas).

## 5. Hasil build + test


- `npx tsc` (strict): BERSIH.
- `npm test`: **176/176 lolos** (167 sesudah Markdown + 9 baru
  wheel: 8 `test/mouse.test.mjs` + 1 `wheelScrollOffset` di
  `test/layout.test.mjs`).
- `bash test/tui-pty.sh`: **190/190 lolos** (171 sesudah Markdown
  + 19 s28 baru wheel: top-anchored 1/13/8, tap ditelan, streaming
  tanpa yank, 40 kol; SERTA perbaikan regresi key-only —
  versi pertama intercept mouse menelan event Arrow/PgUp/Tab/Esc
  yang tiba dengan `input === ""`, 21 check s2/s10/s15/s16/s17/s23
  sempat gagal, diperbaiki dan suite penuh hijau lagi).
- `bash test/agent-pty.sh`: **27/27 lolos** (tidak berubah;
  A1 membuktikan agen jalan BY DEFAULT dari welcome screen).
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
| `docs/images/text-rendering-s25-small.png` | 80×24 (0.1.8): showcase Markdown — heading kuning bold, italic, strikethrough redup, task list `[x]`/`[ ]`, blockquote `> `, tabel box-drawing header kuning, inline code oranye di bg abu, link biru |
| `docs/images/text-rendering-s25-desktop.png` | 120×36 (0.1.8): showcase sama di desktop — divider ter-cap 80 kolom (tidak melebar penuh) |
| `docs/images/markdown-s27-80-top.png` | 80×24 (0.1.8 §4h): showcase sintaks lengkap — H1/H2 kuning, bold/italic/strike/bold+italic, inline code oranye, task list, numbered list, blockquote; tanpa marker mentah |
| `docs/images/markdown-s27-80-bottom.png` | 80×24 (0.1.8 §4h): tabel 3 kolom header kuning, divider, code block `// js` + body di bg abu, link biru |
| `docs/images/markdown-s27-40-top.png` | 40×15 (0.1.8 §4h): span `~~` yang membelah wrap TIDAK bocor — regresi §4g tertutup di level TUI |
| `docs/images/markdown-s26-80.png` | 80×24 (0.1.8 §4h): spacing blok Freebuff di showcase s26 — divider 74 saat scrollbar tampil, gutter tetap kol 2 |
| `docs/images/markdown-s26-120.png` | 120×36 (0.1.8 §4h): showcase sama di desktop — divider cap 80, semua blok terlihat, tanpa scrollbar |

Catatan visual: di terminal kecil, perintah + cwd di kotak konfirmasi
dipotong tengah (`…`) supaya tidak wrap berantakan; hasil tool yang
panjang dirapikan jadi satu baris ringkas (120 karakter, newline →
` / `).

## 7. Yang BELUM terverifikasi live (jangan diklaim sudah)

- **Text rendering + Markdown 0.1.8 di Termux Reza (live, model
  asli) — BELUM terverifikasi.** Semua bukti di atas memakai
  mock server (tmux + `MOCK_MARKDOWN=1` /
  `MOCK_MARKDOWN_FULL=1`) dan unit test. Cacat §4g (marker `~~`
  bocor di lebar sempit) SUDAH diperbaiki di level renderer
  (§4h) dan dibuktikan di mock 40 kol — tapi rendering
  Markdown dari model ASLI di Termux (wrapping jawaban panjang,
  tabel lebar, code fence saat streaming) baru terbukti bila
  Reza mencoba 0.1.8 live — publish hanya bila dia bilang
  "gaz".
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
