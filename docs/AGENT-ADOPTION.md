# Rencana Adopsi Sistem Agen Koding Freebuff ke MethaTech CLI

> **Sumber TUNGGAL: source asli Freebuff** — clone `~/workspace/freebuff-source/`,
> commit `5d8bd24` ("Sync public snapshot from freebuff-private"), lisensi Apache-2.0.
> Semua file/fungsi di bawah dibaca langsung dari source itu, bukan dari README,
> dokumentasi, screenshot, atau produk turunan.
>
> **Aturan tetap Reza (2026-11-08 22:20 UTC): JANGAN kutip/salin dari VectorHead.**
> VectorHead adalah adopsi Freebuff milik Reza sendiri, BUKAN sumber. Bagian
> eksplisit soal ini ada di akhir dokumen (§10): apa saja yang ternyata
> bersumber dari VectorHead dan apa padanan Freebuff aslinya (atau tidak ada).
>
> **Status dokumen ini: riset + rencana saja.** Tidak ada kode MethaTech yang
> diubah, tidak ada commit/publish/deploy. Tanggal riset: 2026-11-08 (UTC).
> Repo MethaTech CLI saat riset: `~/workspace/metatech-cli/`, main commit
> `11e5e18` (v0.1.5 live), working tree berisi adopsi TUI Freebuff yang belum
> di-commit (chat, input box berbordir, session block).

## 0. Temuan arsitektur paling penting (baca dulu)

Freebuff **bukan** agen yang jalan sepenuhnya di dalam CLI. Arsitekturnya
terbelah dua:

| Lapisan | Di mana | Isi |
|---|---|---|
| **Agent runtime (otak)** | Server Codebuff (backend), package `packages/agent-runtime/` | Agent loop, tool handler server-side, system prompt, sub-agent, compaction, loop guard |
| **CLI (tangan + mata)** | Lokal, `cli/` + `sdk/` | TUI OpenTUI+React, eksekusi tool lokal (baca file, shell), render progress, state Zustand |

Alurnya: CLI kirim prompt + `fileContext` (snapshot proyek) ke server lewat SDK
(`sdk/src/run.ts`, `callMainPrompt`); server menjalankan `loopAgentSteps`;
setiap kali agen butuh sesuatu yang lokal (baca file, jalanin shell), server
mendelegasikan balik ke CLI lewat `requestClientToolCall`; CLI mengeksekusi di
mesin user dan mengembalikan hasilnya; server memasukkannya ke `messageHistory`
dan lanjut loop. Event progress (`tool_call`, `tool_result`, `subagent_start`,
`subagent_finish`, `finish`, `error`) di-stream ke CLI
(`cli/src/utils/sdk-event-handlers.ts`).

**Konsekuensi terbesar buat MethaTech:** panel MethaTech (`api.methatech.eu.org`)
adalah API chat OpenAI-compatible (SSE) — **tidak ada agent runtime di sisi
server**. Jadi adopsi tidak bisa "colok runtime Freebuff ke panel". Ada dua
jalur, dan dokumen ini merekomendasikan jalur pertama dulu (§9):

1. **Loop agen di dalam CLI (Node, lokal)** — CLI sendiri yang menjalankan
   loop `minta respons model → parse tool call → eksekusi tool lokal → kirim
   hasil balik sebagai pesan → ulang`. Tanpa perubahan panel. Ini jalur yang
   realistis untuk fase lanjutan.
2. **Runtime agen di sisi panel (server)** — membangun ulang `agent-runtime`
   di backend panel. Pekerjaan besar, butuh endpoint baru + otorisasi + billing
   per step. Bukan fase pertama.

Temuan korektif kedua: **mode "Build" dan "YOLO" TIDAK ADA di source Freebuff
ini.** Grep seluruh repo (`cli/`, `common/src/`, `packages/`, `agents/`,
`docs/`) untuk `yolo`/`YOLO` menghasilkan NOL. Mode Freebuff yang asli adalah
`DEFAULT / LITE / MAX / PLAN` (§5). Premis "status bar menunjukkan Build dan
YOLO" tidak berasal dari Freebuff — jangan diadopsi sebagai perilaku Freebuff
(lihat §10).

Temuan korektif ketiga: **Freebuff tidak punya gate konfirmasi per perintah.**
Perintah shell agen dieksekusi langsung oleh SDK tanpa persetujuan user
(§6). Yang ada sebagai pengaman adalah: mode PLAN (toolset tanpa tool
mutasi), tool `ask_user`, dan instruksi system prompt. Kalau MethaTech mau
konfirmasi sebelum perintah berbahaya, itu **tambahan baru yang dirancang
sendiri**, bukan adopsi — dan memang layak ditambahkan karena CLI jalan di
mesin user sendiri.

---

## 1. Agent loop: rencana → eksekusi → verifikasi

### 1.1 Komponen Freebuff

**Entry point — `packages/agent-runtime/src/main-prompt.ts`**

- `mainPrompt(params)` — memilih `agentType` dari `agentId` (pilihan CLI) atau
  dari `costMode`: `ask → ask`, `free/lite → base_free`, `normal → base`,
  `max → base_max`, `experimental → base2`. Lalu memanggil `loopAgentSteps`.
- `callMainPrompt(params)` — merakit template agen lokal dari `fileContext`
  (`assembleLocalAgentTemplates`), menolak config agen invalid sebelum jalan,
  mengirim event `response-chunk` bertipe `start`/`finish` ke client, dan
  mengembalikan `sessionState` + `output`. Catatan: server me-reset
  `creditsUsed` ke 0 (otoritas biaya di server, client tidak bisa memanipulasi).

**Loop utama — `packages/agent-runtime/src/run-agent-step.ts`**

- `loopAgentSteps(params)` (baris 1115) — `while (true)` per turn:
  1. Ambil `agentTemplate` (`getAgentTemplate`, dari `templates/agent-registry.ts`).
  2. Bangun `stepPrompt` per langkah (`getAgentPrompt`, `templates/strings.ts`)
     dan gabung ke `messageHistory`.
  3. Estimasi token konteks; kalau melewati ambang, jalankan compaction
     (§1.3) sebelum lanjut.
  4. Panggil `runAgentStep` → satu respons LLM + eksekusi semua tool call di
     dalamnya (`processStream`, `tools/stream-parser.ts`).
  5. Tentukan `shouldEndTurn` (§1.2); kalau belum, loop lagi. Ada
     `drainSteeringMessages` (host bisa "menyetir" agen yang sedang jalan tanpa
     abort) dan `deadlineAt` (batas waktu wall-clock dari host).
- `runAgentStep(params)` (baris ~600) — satu langkah:
  1. `getAgentStreamFromTemplate` → stream mentah dari AI SDK
     (`prompt-agent-stream.ts`).
  2. `processStream` → parse tool call dari stream sambil jalan, eksekusi
     tool **segera** saat tag tool call lengkap diterima (stream di-pause
     selama eksekusi tool).
  3. Kumpulkan `toolCalls` + `toolResults`, append ke
     `agentState.messageHistory`, hitung `shouldEndTurn`.

**Kapan satu turn berakhir (`shouldEndTurn`, baris 901–1030):**

- Agen yang toolset-nya berisi `task_completed` **wajib** memanggil
  `task_completed` (atau `end_turn` untuk kompatibilitas) — kalau tidak,
  turn tidak berakhir walau tidak ada tool call.
- Agen tanpa `task_completed`: turn berakhir kalau tidak ada tool call yang
  "memaksa langkah berikut" (daftar `TOOLS_WHICH_WONT_FORCE_NEXT_STEP`, lihat
  §2.3) — kecuali respons hanya berisi tag `<think>…</think>` (dianggap masih
  berpikir, lanjut).
- Tool call error memaksa satu langkah lagi supaya agen bisa retry.
- Pengecualian lain: nudge `gravity_index` (agen harus melaporkan rekomendasi
  yang dipakai), nudge to-do belum selesai saat `suggest_followups` dipanggil,
  dan `suggest_prompts` sebelum jawaban — semuanya menyisipkan pesan sistem
  (`withSystemTags(...)`) lalu `shouldEndTurn = false`.

**Verifikasi (bukan fase terpisah, tapi perilaku yang diprompt + diorkestrasi):**

- Prompt root base3 (`agents/base3.ts`): "Verify the final edited files:
  after a repair, rerun the affected checks; earlier passing results do not
  cover later changes… Fix the cause of a failing check. Do not skip tests,
  weaken assertions, swallow errors, or add type/lint suppressions just to
  make verification pass… Report checks that failed or could not run as
  limitations, never as passes."
- Prompt orkestrator base2 (`agents/base2/base2.ts`): pola kerja baku yang
  ditulis sebagai contoh di system prompt — kumpulkan konteks → buat rencana
  → **spawn paralel: code-reviewer + basher typecheck + basher test** → perbaiki
  temuan → tulis ringkasan akhir yang sangat pendek. Verifikasi = sub-agent
  reviewer + sub-agent shell yang menjalankan typecheck/test, lalu agen utama
  memperbaiki (bukan agen yang memverifikasi dirinya sendiri tanpa cek).
- `agents/base2/base2.ts` juga melarang klaim speedup tanpa pengukuran, dan
  melarang `git push`/reset/deploy kecuali user yang minta.

### 1.2 Yang BISA diadopsi (Ink + React + Node)

- **Struktur loop `while(true)` + `shouldEndTurn`** — murni logika TypeScript,
  tidak tergantung OpenTUI/Bun. Bisa dipindah 1:1 ke modul `src/agent/loop.ts`
  di CLI, dengan `api.ts` (SSE) sebagai transport ganti AI SDK.
- **Aturan akhir turn** (wajib `task_completed`, think-only lanjut, error
  memaksa retry, daftar tool yang tidak memaksa langkah berikut) — semuanya
  aturan data, bukan framework.
- **Pola verifikasi via sub-agent** — reviewer + basher paralel (§4), dan
  aturan prompt verifikasi base3 (kutip secukupnya ke system prompt MethaTech,
  tulis ulang dengan bahasa sendiri; jangan salin mentah prompt Freebuff yang
  panjang — lihat catatan lisensi §9.4).
- **Steering & deadline** — `drainSteeringMessages` (pesan user yang masuk
  saat agen jalan ikut antre sebagai prompt berikut) dan `deadlineAt` mudah
  ditiru di loop lokal.

### 1.3 Yang TIDAK bisa / berbeda

- **Loop tidak bisa jalan di server panel tanpa membangun runtime baru.**
  Panel MethaTech hari ini hanya chat completions; `loopAgentSteps` butuh
  state `messageHistory` + eksekutor tool + pencatat run (`startAgentRun` /
  `addAgentStep` / `finishAgentRun`) di sisi yang menjalankan loop. Di fase
  pertama, semua itu tinggal di CLI.
- **Compaction** (`compact-history.ts`, `conversation-summary.ts`,
  `compaction.ts`, ambang `compactionThreshold()` = 80% `maxContextLength`,
  `common/src/constants/compaction-policy.ts`) — mekanismenya bisa ditiru
  (ringkas history jadi satu pesan summary saat konteks >80%), tapi di
  Freebuff compaction memakai sub-agent `context-pruner` (programmatic, tanpa
  model call? — lihat `run-programmatic-step.ts`) dan policy per model
  (default idle 1 jam + min 140k token; DeepSeek V4 Flash 15 menit + 40k
  token karena prefix cache Luminal). Untuk MethaTech fase pertama: compaction
  sederhana (ringkas via model yang sama, atau potong tool result lama)
  sudah cukup; policy per model ditunda.
- **AI SDK (`ai` package) + `generateText`/`streamText`** — Freebuff memakai
  Vercel AI SDK sebagai lapisan LLM (`getAgentStreamFromTemplate`,
  `prompt-agent-stream.ts`). MethaTech sudah punya `src/api.ts` (SSE ke panel
  OpenAI-compatible) — jangan tarik AI SDK hanya demi loop; loop bicara ke
  `api.ts` yang sudah ada.

---

## 2. Tool calling

### 2.1 Komponen Freebuff

**Daftar tool — `common/src/tools/constants.ts`**

`toolNames` (36 tool): `apply_patch`, `add_subgoal`, `add_message`,
`ask_user`, `browser_logs`, `code_search`, `cloud_plan_ready`, `create_plan`,
`end_turn`, `find_files`, `glob`, `gravity_index`, `list_directory`,
`lookup_agent_info`, `propose_str_replace`, `propose_write_file`, `read_docs`,
`read_files`, `read_subtree`, `read_url`, `render_ui`,
`report_project_profile`, `run_file_change_hooks`, `run_terminal_command`,
`set_messages`, `set_output`, `skill`, `spawn_agents`, `spawn_agent_inline`,
`str_replace`, `suggest_followups`, `task_completed`, `think_deeply`,
`update_subgoal`, `web_search`, `write_file`, `write_todos`.

Handler masing-masing ada di `packages/agent-runtime/src/tools/handlers/tool/`
dan didaftarkan di `tools/handlers/list.ts` (`codebuffToolHandlers`).

Kelompok fungsional:

| Kelompok | Tool |
|---|---|
| Baca / cari | `read_files`, `read_subtree`, `read_docs`, `read_url`, `list_directory`, `glob`, `find_files`, `code_search`, `gravity_index` |
| Tulis / edit | `write_file`, `str_replace`, `apply_patch`, `propose_str_replace`, `propose_write_file` |
| Shell | `run_terminal_command` |
| Perencana | `create_plan`, `write_todos`, `add_subgoal`, `update_subgoal` |
| Orkestrasi | `spawn_agents`, `spawn_agent_inline`, `skill`, `lookup_agent_info` |
| Komunikasi | `ask_user`, `suggest_followups`, `set_output`, `set_messages`, `add_message`, `end_turn`, `task_completed`, `think_deeply`, `render_ui`, `report_project_profile`, `run_file_change_hooks`, `browser_logs`, `cloud_plan_ready` |

**Definisi tool (schema) — `common/src/tools/params/tool/*.ts` + `common/src/tools/list.ts`**

- Setiap tool punya file params sendiri berisi **Zod schema** (`zod/v4`) untuk
  input, `outputSchema`, deskripsi, dan contoh pemakaian. Contoh:
  `run-terminal-command.ts` (clamp timeout, `MAX_TERMINAL_TIMEOUT_SECONDS = 600`,
  sentinel `-1` = tanpa timeout, `process_type: SYNC | BACKGROUND`).
- `getToolSet` (`packages/agent-runtime/src/tools/prompts.ts:362`) merakit
  `ToolSet` AI SDK dari `toolNames` + `toolParams`: untuk tiap nama, ambil
  definisi Zod, terapkan varian tampilan bila ada (`readStyleDisplayVariants`:
  windowed vs legacy file reads), sisipkan XML daftar skill ke deskripsi tool
  `skill` (`formatAvailableSkillsXml`).
- Custom tool dari SDK (`customToolDefinitions`, JSON Schema) dikonversi ke
  Zod (`convertJsonSchemaToZod`, `ensureZodSchema`).

**Format tool call — DUA jalur, dan ini penting:**

1. **Native (AI SDK):** chunk `tool-call` dari provider yang mendukung
   function calling. Input JSON sudah ter-parse; kalau AI SDK hanya memberi
   string JSON mentah, di-`JSON.parse` dulu (`tool-stream-parser.ts`,
   `processToolCallObject`).
2. **XML (fallback untuk model tanpa function calling):**
   `packages/agent-runtime/src/util/stream-xml-parser.ts` — parser stateful
   yang mengekstrak tool call dari teks stream:
   - Tag: `<codebuff_tool_call>\n{...JSON...}\n</codebuff_tool_call>`
     (nama tag `toolXmlName = 'codebuff_tool_call'`,
     `common/src/tools/constants.ts`).
   - Isi tag = **JSON** dengan nama tool + parameter (bukan XML per field).
     Contoh bentuk yang dipakai prompt `/export`:
     `<write_file>` legacy juga dikenal di beberapa prompt, tapi jalur runtime
     adalah JSON dalam `<codebuff_tool_call>`.
   - Parser tahan chunk boundary: state `insideToolCall` + buffer menahan
     tag start yang terpotong; teks di luar tag diteruskan sebagai teks biasa
     (difilter dari tool call), teks di dalam tag tidak bocor ke chat.
   - `processStreamWithTools` (`tool-stream-parser.ts`): tiap chunk teks
     di-parse; kalau ada tool call, buffer teks di-flush dulu (supaya event
     teks terkirim sebelum event tool), lalu tool dieksekusi **segera**,
     stream di-pause selama eksekusi.
   - Input tool yang rusak diperbaiki: `common/src/tools/repair-tool-json.ts`,
     `packages/agent-runtime/src/util/repair-custom-tool-input.ts`.

**Cara hasil tool dikembalikan ke model — `run-agent-step.ts`**

- Setiap eksekusi tool menghasilkan `ToolMessage` (role `tool`) yang
  di-append ke `agentState.messageHistory` (baris 703, 735, 829, 877).
- Hasil berupa `ToolResultOutput[]`: umumnya `{type: 'json', value: {...}}`
  atau `{type: 'text', value: ...}` (`common/src/types/messages/content-part`,
  `common/src/util/messages.ts` `jsonToolResult`).
- Contoh hasil shell (`cli/src/utils/bash-messages.ts`,
  `createRunTerminalToolResult`): `{command, startingCwd, stdout, stderr,
  exitCode}` atau `{command, startingCwd, errorMessage}`.
- Error tool call (parse gagal / tool tidak dikenal / handler throw) menjadi
  pesan user bertag `TOOL_CALL_ERROR` di history dan **memaksa satu langkah
  lagi** (`hadToolCallError` → `shouldEndTurn = false`) supaya agen retry.
  Saat output sub-agent dihitung, pesan bertag `TOOL_CALL_ERROR` di-strip
  (`util/agent-output.ts`, `EXCLUDED_OUTPUT_TAGS`).

**Eksekusi tool lokal — arsitektur client/server:**

- Tool yang butuh akses lokal (`read_files`, `run_terminal_command`, …)
  dieksekusi **di CLI**, bukan di server: handler server memanggil
  `requestClientToolCall` (`tools/handlers/tool/run-terminal-command.ts`),
  CLI/SDK mengeksekusinya (`sdk/src/tools/run-terminal-command.ts`:
  `spawn` via bash, output cap 50.000 karakter dengan head+tail
  `BoundedOutputBuffer`, kill eskalasi SIGTERM→SIGKILL 1500 ms).
- Tool yang murni server-side (baca file dari `fileContext` snapshot,
  `code_search` di index server, `spawn_agents`) dieksekusi di server.

### 2.2 Yang BISA diadopsi

- **Format XML `<codebuff_tool_call>` + JSON** — ini jalur paling portabel
  buat MethaTech: model-model gratis panel belum tentu mendukung native
  function calling (belum terverifikasi), sementara XML bekerja di atas
  **teks biasa** dari SSE yang sudah ada di `src/api.ts`. Parser stateful
  (`stream-xml-parser.ts`, ~177 baris) bisa di-port ke Node dengan sedikit
  perubahan (tanpa dependensi Bun/OpenTUI). Ini fondasi fase pertama.
- **Zod schema per tool** (`common/src/tools/params/tool/*.ts`) — Zod jalan
  di Node; pola "satu file params per tool: inputSchema + outputSchema +
  deskripsi + contoh" bisa ditiru untuk tool MethaTech. Validasi input +
  repair JSON rusak ikut diadopsi.
- **Pola hasil tool sebagai pesan role `tool`** — tinggal append ke history
  chat yang sudah ada di `ChatApp.tsx`; format `{command, stdout, stderr,
  exitCode}` untuk shell bisa dipakai apa adanya.
- **Subset tool fase pertama** (lihat §9): `read_files`, `list_directory`,
  `glob`, `code_search` (grep lokal), `str_replace`, `write_file`,
  `run_terminal_command`, `write_todos`, `task_completed`, `ask_user`,
  `skill`. Sisanya (MCP, gravity, browser, render_ui, cloud) ditunda.

### 2.3 Yang TIDAK bisa / berbeda

- **Native function calling AI SDK** — tidak ada di MethaTech (transportnya
  SSE mentah panel, bukan AI SDK). Jalur native hanya relevan kalau suatu
  hari panel menambah endpoint yang mendukungnya; sampai saat itu XML adalah
  jalur utama, bukan fallback.
- **`TOOLS_WHICH_WONT_FORCE_NEXT_STEP`** (`think_deeply`, `set_output`,
  `set_messages`, `add_message`, `update_subgoal`, `create_plan`,
  `render_ui`, `suggest_followups`, `suggest_prompts`, `task_completed`,
  `report_project_profile`) — konsepnya diadopsi (tool bookkeeping tidak
  memaksa langkah berikut), tapi daftarnya disesuaikan ke subset tool
  MethaTech.
- **Eksekusi tool server-side** — di Freebuff sebagian tool jalan di server
  Codebuff atas snapshot `fileContext`. Di MethaTech fase pertama **semua**
  tool jalan lokal di CLI (file dibaca dari disk user langsung, bukan
  snapshot). Ini justru lebih sederhana dan lebih cocok buat coding lokal;
  snapshot `fileContext` hanya perlu ditiru sebagian (file tree + knowledge
  files, §7) sebagai konteks awal, bukan sebagai sumber baca file.
- **MCP tools** (`packages/agent-runtime/src/mcp.ts`, `mcp-constants.ts`) —
  tidak diadopsi fase pertama.

---

## 3. Skill

### 3.1 Komponen Freebuff

**Format file skill:**

- Satu skill = satu direktori berisi `SKILL.md` (nama file
  `SKILL_FILE_NAME`, `common/src/constants/skills.ts`).
- Frontmatter YAML divalidasi `SkillFrontmatterSchema`
  (`common/src/types/skill.ts`):
  - `name`: wajib, lowercase alfanumerik + hyphen tunggal, panjang maks
    `SKILL_NAME_MAX_LENGTH`, **harus sama dengan nama direktori**.
  - `description`: wajib, dipotong ke `SKILL_DESCRIPTION_MAX_LENGTH`.
  - `license`: opsional.
  - `disable-model-invocation`: opsional boolean — kalau `true`, hanya user
    yang boleh memanggil skill, model tidak.
  - `metadata`: bebas (record string→unknown; dipakai registry seperti
    skills.sh yang menulis blok `hermes:`).
- Isi `SKILL.md` = instruksi Markdown lengkap (prosedur, contoh, aturan)
  yang dimuat ke konteks saat skill dipakai.

**Discovery & load:**

- Direktori yang dipindai (`packages/agent-runtime/src/tools/handlers/tool/skill.ts`,
  `loadSkillFromDisk`):
  - Proyek (prioritas tertinggi dulu): `<project>/.agents/skills/<nama>/`,
    `<project>/.claude/skills/<nama>/`.
  - Home (OPT-IN saja, parameter `includeHomeSkills` — komentar di source
    menjelaskan alasannya: di server, `os.homedir()` adalah home server,
    bukan home user; skill server bisa tertukar dengan skill repo orang lain):
    `~/.agents/skills/<nama>/`, `~/.claude/skills/<nama>/`.
  - Proyek mengalahkan global; `.agents` mengalahkan `.claude`.
- Skill di-preload ke cache saat session start; `skill` tool memuat dari
  disk bila skill dibuat di tengah sesi (parser sama:
  `parseSkillFileContent`, frontmatter wajib YAML, nama harus cocok dengan
  direktori).
- Util: `common/src/util/skills.ts` (`formatSkillContent`,
  `isSkillModelInvocable`, `formatAvailableSkillsXml`), parser
  `common/src/util/parse-skill.ts`.

**Cara agen memilih & memakai skill:**

- Daftar skill yang tersedia (nama + deskripsi saja) disisipkan sebagai XML
  ke dalam **deskripsi tool `skill`** (`formatAvailableSkillsXml` di
  `getToolSet`) — jadi model "menemukan" skill lewat deskripsi tool, bukan
  lewat system prompt yang memuat semua isi skill.
- Model memanggil tool `skill` dengan nama skill; handler memuat **isi penuh**
  `SKILL.md` dan mengembalikannya sebagai hasil tool → isi skill masuk
  konteks percakapan, agen mengikuti instruksinya.
- Prompt discovery: `SKILL_DISCOVERY_GUIDANCE` di `agents/constants.ts`
  (dipakai base2/base3) mengarahkan model kapan memakai skill.
- Skill juga bisa dipanggil user langsung (slash command / perintah),
  dan skill dengan `disable-model-invocation: true` hanya bisa dipanggil user.

### 3.2 Rencana adopsi ke MethaTech

- **BISA langsung:** format `SKILL.md` + frontmatter (validasi Zod di Node
  tanpa perubahan berarti); direktori `.agents/skills/` di proyek user;
  tool `skill` yang memuat isi penuh ke konteks; daftar nama+deskripsi
  disisipkan ke deskripsi tool (hemat konteks — jangan muat semua isi skill
  ke system prompt).
- **Perbedaan:** home skills (`~/.agents/skills`) di MethaTech AMAN untuk
  diaktifkan default (CLI jalan di mesin user sendiri, bukan server orang
  lain — justru kebalikan dari peringatan Freebuff). Tetap sediakan opsi
  mematikan.
- **Skill bawaan MethaTech (diusulkan):** skill-skill yang relevan dengan
  workflow Reza (mis. skill "metatech-cli" berisi aturan repo ini) bisa
  dibundel di CLI; skill user tetap di `.agents/skills/` proyeknya.
- **Tidak diadopsi:** registry skill remote (skills.sh dkk.) — fase jauh.

---

## 4. Sub-agent

### 4.1 Komponen Freebuff

**Tool & handler:**

- `spawn_agents` — spawn paralel beberapa sub-agent sekaligus.
  Batasan (`common/src/tools/params/tool/spawn-agents.ts`):
  `MAX_SPAWN_AGENTS_PER_CALL = 6`, `MAX_LIVE_SUBAGENTS_PER_ROOT = 20`.
  Ada cap khusus Freebuff Projects (`FREEBUFF_PROJECTS_MAX_LIVE_SUBAGENTS`).
- `spawn_agent_inline` — varian inline (satu agen, hasilnya langsung
  di-stream ke parent).
- Handler: `packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts`
  (+ `spawn-agent-utils.ts`, `spawn-agent-inline.ts`).
- `executeSubagent` (`spawn-agent-utils.ts:377`): menjalankan sub-agent
  sebagai **`loopAgentSteps` rekursif** dengan `agentType` = id agen yang
  di-spawn, `ancestorRunIds` = rantai run parent, `prompt` = permintaan
  parent (bukan prompt user), `promptIsContinuation = false`. Gambar/konten
  image TIDAK diteruskan ke sub-agent (hanya via `includeMessageHistory`).
  Event `subagent_start` / `subagent_finish` dikirim ke client lewat
  `onResponseChunk` supaya TUI bisa menampilkan sub-agent yang hidup.
- Hasil kembali ke parent: `outputForParent` / `getAgentOutput`
  (`util/agent-output.ts`) — tergantung `outputMode` template:
  `last_message` (pesan terakhir), `structured_output` (nilai `output`),
  atau seluruh turn terakhir (pesan asisten + pesan tool sesudahnya,
  tanpa pesan bertag `TOOL_CALL_ERROR`). Batas langkah sub-agent:
  `MAX_SUBAGENT_STEPS_DEFAULT = 200` (root: 600,
  `common/src/constants/agents.ts`).

**Agen-agen yang bisa di-spawn (per template):**

- Template mendefinisikan `spawnableAgents` — daftar id agen yang boleh
  di-spawn. Contoh base2 (`agents/base2/base2.ts`): `file-picker`,
  `code-searcher`, `researcher-web`, `researcher-docs`, `basher` (shell),
  `editor` (tulis file), `thinker`, `code-reviewer`,
  `code-reviewer-multi-prompt` (khusus MAX), `opus-agent`, `gpt-5-agent`,
  `browser-use`, `tmux-cli`, `context-pruner`.
- Definisi tiap agen: `agents/base2/*.ts`, `agents/base-chat.ts`, dan
  `agents/base3*.ts` (varian per model). Setiap agen = `AgentTemplate`:
  `systemPrompt` sendiri + `toolNames` sendiri (subset, mis. `editor`
  hanya punya tool tulis; `basher` hanya shell) + `model` sendiri +
  `inputSchema`/`outputMode`.
- Aturan penting: `@NamaAgen` di pesan user wajib di-spawn oleh orkestrator.
- `context-pruner` adalah sub-agent **programmatik** (tanpa LLM call penuh,
  `run-programmatic-step.ts`) yang dipakai runtime untuk compaction —
  bukan agen yang dipanggil model.

**Streaming sub-agent ke TUI:**

- `cli/src/utils/sdk-event-handlers.ts`: event `subagent_start` /
  `subagent_finish` → state chat; teks sub-agent masuk ke blok pesannya
  sendiri (`message-with-agents.tsx`, `blocks/*`). Ada test khusus
  (`__tests__/subagent-streaming.test.ts`, `spawn-agents-live-cap.test.ts`,
  `prompt-caching-subagents.test.ts`).

### 4.2 Rencana adopsi ke MethaTech

- **BISA:** pola `spawn_agents` sebagai tool biasa yang memanggil
  `loopAgentSteps` rekursif dengan template berbeda — di CLI lokal ini
  berarti satu fungsi loop yang sama dipakai parent & child, dengan
  `AgentTemplate` (system prompt + tool subset + model) per peran.
  Cap 6 per panggilan & 20 live per root diadopsi sebagai angka awal.
  Event `subagent_start/finish` ditiru sebagai event internal CLI untuk
  render blok sub-agent di Ink.
- **Agen pertama yang dibutuhkan (minimal):** `file-picker` (cari file
  relevan), `code-searcher` (grep), `basher` (shell: typecheck/test),
  `editor` (tulis file), `code-reviewer` (review perubahan). `thinker` /
  model kuat lain ditunda (butuh model reasoning khusus + biaya).
- **TIDAK bisa 1:1:** `editor-multi-prompt` + `code-reviewer-multi-prompt`
  (mode MAX) memakai best-of-n (beberapa kandidat edit lalu dipilih) —
  mahal (n× biaya) dan butuh logika seleksi; ditunda sampai ada kebutuhan
  dan model yang cocok di panel. `tmux-cli` (agen yang mengendalikan
  terminal interaktif via tmux) tidak relevan untuk CLI Node tanpa tmux.
- **Perbedaan dipaksakan:** di Freebuff, sub-agent jalan di server dan
  hasilnya di-stream sebagai event; di MethaTech semua jalan di proses CLI
  yang sama — lebih sederhana (tanpa serialisasi event jaringan), tapi
  perlu hati-hati supaya output sub-agent tidak membanjiri konteks parent:
  yang kembali hanya `outputForParent` (ringkasan hasil), bukan seluruh
  history sub-agent. Ini sudah pola Freebuff — dipertahankan.

---

## 5. Mode: DEFAULT / LITE / MAX / PLAN (bukan Build/YOLO)

### 5.1 Komponen Freebuff

**Definisi mode — `cli/src/utils/constants.ts`**

```ts
AGENT_MODE_TO_ID = {
  DEFAULT: 'base3',        // harness saat ini (CLI_HARNESS = 'base3')
  LITE:    'base2-free',   // Freebuff: mode gratis
  MAX:     'base2-max',
  PLAN:    'base2-plan',
}
AGENT_MODE_TO_COST_MODE = {
  DEFAULT: 'normal', LITE: 'free' (Freebuff) / 'lite' (Codebuff),
  MAX: 'max', PLAN: 'normal',
}
```

Urutan cycling: DEFAULT → LITE → MAX → PLAN (`AGENT_MODES`,
`toggleAgentMode` di `cli/src/state/chat-store.ts`).

**Kunci: di Freebuff, mode toggle DIMATIKAN.**

- `AgentModeToggle` (`cli/src/components/agent-mode-toggle.tsx`):
  `if (IS_FREEBUFF) return null` — komponen tidak dirender sama sekali.
- `setAgentMode` / `toggleAgentMode` di `chat-store.ts`:
  `if (IS_FREEBUFF) return` — no-op.
- `agentMode` awal Freebuff dikunci `'LITE'` (`chat-store.ts:218`).
  Freebuff menyelesaikan LITE lewat model gratis yang dipilih saat kirim.
- Jadi **yang dilihat user Freebuff bukanlah pilihan Build/YOLO**; status
  bar Freebuff (`cli/src/components/status-bar.tsx`,
  `freebuff-chat-footer.tsx`) menampilkan: **nama model + reasoning effort
  + countdown sesi gratis + pemakaian konteks**, bukan mode agen.
- Mode DEFAULT/LITE/MAX/PLAN hanya hidup di Codebuff (produk berbayar)
  lewat komponen toggle yang sama.

**Apa bedanya per mode (perilaku agen, bukan sekadar label):**

| Mode | Agent id | Perilaku |
|---|---|---|
| DEFAULT | `base3` | Root base3: 8 tool inti (`read_files`, `str_replace`, `write_file`, `run_terminal_command`, `code_search`, `glob`, `list_directory`, `write_todos`) + appendix CLI. Prompt menekankan: kerjakan seukuran permintaan, verifikasi file hasil edit, jangan klaim tanpa ukur. |
| LITE | `base3-lite` / `base2-free` | Sama dengan DEFAULT tapi model gratis + `costMode: 'free'` (session gate, rate limit, 0 kredit untuk kombinasi agen+model allowlist). |
| MAX | `base2-max` | Orkestrator base2 dengan **multi-prompt editor** (`editor-multi-prompt`) + **reviewer fan-out** (`code-reviewer-multi-prompt`): beberapa kandidat edit dihasilkan paralel lalu dipilih yang terbaik. Komentar source: "the ceremony IS the product there" — mahal, untuk tugas kompleks. |
| PLAN | `base2-plan` | **Tidak menyentuh file sama sekali.** Ditegakkan lewat **toolset**, bukan cuma prompt — komentar di `agents/base2/base2.ts`: "Plan mode is enforced by the toolset, not only by the prompt. Prose alone lost: a user who picked PLAN got the whole feature built and committed, because every capability a build turn has was still here." Tool yang **dicabut** di PLAN: `str_replace`, `write_file`, `propose_str_replace`, `propose_write_file`, `basher`, `tmux-cli`, `editor`, `editor-multi-prompt`, `code-reviewer*`, `thinker-best-of-n-opus`. Alasan `basher` dicabut: "`git commit` reached the repository through basher even while the prompt said not to touch anything." PLAN memakai flow `<PLAN>` khusus (lihat `sdk-event-handlers.ts`) dan prompt plan-only yang di-tune untuk base2. |

**Ganti mode:** klik/hover segmented control (`AgentModeToggle`, expand
saat hover, `OPEN_DELAY_MS = 0`, `CLOSE_DELAY_MS = 250`) atau cycling
`toggleAgentMode`. Pilihan disimpan (`saveModePreference`) — kecuali di
Freebuff yang mengabaikannya.

**Tidak ada di Freebuff (verifikasi grep):**

- `yolo` / `YOLO`: **0 hasil** di seluruh `cli/`, `common/src/`,
  `packages/`, `agents/`, `docs/`. Tidak ada mode YOLO, tidak ada flag
  YOLO, tidak ada teks YOLO.
- Label `Build` sebagai mode: **tidak ada**. Kata "Build" yang muncul
  adalah kata kerja biasa ("build the smallest version…") di prompt.

### 5.2 Rencana adopsi ke MethaTech

- **Adopsi mode sebagai konsep, dengan nama Freebuff:** `DEFAULT`, `LITE`,
  `MAX`, `PLAN` — atau, karena MethaTech tidak punya tier berbayar Codebuff,
  sederhanakan jadi **tiga mode yang bermakna di panel MethaTech**:
  - `Plan` (baca + rencana saja, toolset tanpa mutasi — tiru penegakan
    via toolset, bukan via prompt),
  - `Build` (mode kerja normal = DEFAULT Freebuff; nama "Build" di sini
    adalah **nama MethaTech sendiri**, bukan dari Freebuff — jangan klaim
    ini perilaku Freebuff),
  - `Max` (ditunda; butuh best-of-n + biaya — catat sebagai fase jauh).
  - `Lite` tidak perlu sebagai mode terpisah: di MethaTech, model gratis
    vs berbayar sudah dipilih lewat model picker + aturan akses panel
    (user topup vs free trial 10 model).
- **Penegakan PLAN via toolset** adalah pelajaran terpenting bagian ini:
  jangan percaya prompt saja; cabut tool mutasi dari `toolNames` saat
  mode Plan aktif.
- **UI ganti mode:** segmented control di atas input (seperti
  `AgentModeToggle`) + shortcut keyboard untuk cycle; tampilkan mode aktif
  di footer/status bar bersama nama model. Di Ink, hover tidak ada —
  ganti hover-expand dengan klik/Enter atau tombol `/mode`.

---

## 6. Permission / konfirmasi

### 6.1 Komponen Freebuff — temuan jujur: TIDAK ADA gate konfirmasi

Hasil pencarian menyeluruh di source Freebuff:

- **Perintah shell dieksekusi langsung, tanpa konfirmasi.**
  `handleRunTerminalCommand`
  (`packages/agent-runtime/src/tools/handlers/tool/run-terminal-command.ts`)
  hanya meneruskan ke client (`requestClientToolCall`, `mode: 'assistant'`,
  `process_type`, `timeout_seconds`, `cwd`). SDK
  (`sdk/src/tools/run-terminal-command.ts`) mengeksekusinya via `spawn`
  (bash; Git Bash di Windows) tanpa prompt persetujuan. Tidak ada allowlist,
  denylist, atau deteksi perintah berbahaya di jalur ini (grep
  `confirm|approval|allow` di `sdk/src/` hanya mengenai URL runtime &
  publisher trust, bukan perintah).
- **`PendingBashMessage` BUKAN konfirmasi.**
  `cli/src/components/pending-bash-message.tsx` (59 baris) adalah kotak
  berbordir putus-putus yang menampilkan perintah **user sendiri** yang
  sedang jalan + outputnya, dengan catatan "Will be added to chat history
  when it completes". Ini tampilan perintah user yang pending, bukan
  persetujuan untuk perintah agen.
- **Pengaman yang benar-benar ada:**
  1. **System prompt** — base3: "Don't run destructive or hard-to-undo
     commands (git push, resets, deploys) unless the user asks for them."
     dan "Stay inside the project folder."
  2. **Mode PLAN** — tool mutasi dicabut dari toolset (§5).
  3. **Tool `ask_user`** — agen bertanya ke user saat ragu. UI-nya
     `cli/src/components/ask-user/index.tsx` (`MultipleChoiceForm`):
     semua pertanyaan tampil sekaligus (accordion/FAQ), tiap pertanyaan
     punya opsi pilihan + opsi kustom, ada tombol Skip, submit mengirim
     `{question, answer}[]` balik sebagai hasil tool. Ini alat klarifikasi,
     bukan gate izin.
  4. **Tool `propose_*`** — `propose_str_replace` / `propose_write_file`
     TIDAK menulis ke disk; mereka menerapkan edit ke **in-memory proposed
     content store** (`tools/handlers/tool/proposed-content-store.ts`,
     keyed by `runId`) supaya editor best-of-n bisa menghasilkan beberapa
     kandidat edit dan memilih yang terbaik. Bukan UI persetujuan user —
     tidak ada komponen approval untuk proposed content di CLI.
  5. **Batas teknis shell** — timeout model di-clamp maks 600 detik
     (`clampTerminalTimeoutSeconds`), output di-cap 50.000 karakter
     (`COMMAND_OUTPUT_LIMIT`), `process_type: BACKGROUND` untuk proses
     panjang. Ini batas sumber daya, bukan izin.
- **Catatan mode:** `mode: 'assistant'` pada client tool call membedakan
  perintah yang diminta agen vs perintah yang diketik user sendiri
  (mode user). Pembedaan ini dipakai untuk tampilan & histori, bukan
  untuk gate izin.

### 6.2 Rencana adopsi ke MethaTech — di sinilah MethaTech HARUS lebih ketat dari Freebuff

Karena CLI MethaTech jalan di mesin user (Termux/Android termasuk) dan
mengeksekusi shell lokal, **tambahkan gate konfirmasi yang tidak ada di
Freebuff** (penyimpangan yang disengaja, demi keamanan):

| Kategori perintah | Perilaku yang diusulkan |
|---|---|
| Baca saja (`ls`, `cat`, `grep`, `git status/diff/log`, `npm ls`) | Jalan langsung, tanpa konfirmasi |
| Tulis file / edit | Tampilkan diff dulu (CLI sudah punya `src/ui/DiffView.tsx`), konfirmasi sekali per file atau per batch |
| Shell aman (`npm test`, `tsc`, `git add` file tertentu) | Konfirmasi pertama kali per sesi, lalu "always allow" per perintah |
| Berbahaya (`rm -rf`, `git push`, `git reset --hard`, `deploy`, `curl … \| sh`, perintah di luar folder proyek) | Selalu minta konfirmasi eksplisit; tolak mentah perintah di luar folder proyek kecuali path eksplisit dari user (tiruan aturan base3 "Stay inside the project folder") |
| Mode Plan | Semua mutasi ditolak di level toolset (§5), bukan ditanya |

- UI konfirmasi di Ink: tiru pola `ask_user` Freebuff (pertanyaan + opsi +
  kustom + skip) tapi untuk izin: `[Allow once] [Allow always] [Deny]`
  dengan tampilan perintah + cwd + preview efek (file yang akan berubah).
- Keputusan "always allow" disimpan per proyek (bukan global) dan bisa
  di-reset; jangan simpan keputusan berbahaya (hapus/push) sebagai always.
- System prompt MethaTech harus memuat larangan yang sama dengan base3
  (destructive command hanya atas permintaan user; tetap di dalam folder
  proyek) — ini adopsi langsung.

---

## 7. Prompt sistem agen + konteks proyek

### 7.1 Komponen Freebuff

**System prompt — berlapis:**

1. **Root prompt per agen** (`AgentTemplate.systemPrompt`):
   - base3 (`agents/base3.ts`, `createBase3`): "You are Buffy, the coding
     agent behind Codebuff…" + aturan kerja (seukuran permintaan; cocokkan
     konvensi proyek; verifikasi library sudah dipakai; edit file yang ada
     daripada buat baru; verifikasi file hasil edit; jangan klaim speedup
     tanpa ukur; jangan perintah destruktif; tetap di folder proyek) +
     `${AGENT_PROGRESS_GUIDANCE}` (beri update progres sebelum tool call
     berikut bila masih ada kerja) + `${AGENT_VERIFICATION_GUIDANCE}` +
     placeholder `KNOWLEDGE_FILES_CONTENTS` + `GIT_CHANGES_PROMPT` +
     panduan batching (opsional, per model: "kerjakan sebanyak mungkin per
     respons; cari/baca dalam satu batch").
   - base2 (`agents/base2/base2.ts`): "You are Buffy, the strategic coding
     assistant…" + contoh `<example>` pola kerja (kumpulkan konteks →
     rencana → spawn reviewer+basher paralel → perbaiki → ringkasan pendek)
     + aturan spawn `@AgentName`.
   - Prompt root base3 diuji kontraknya: "the appendix is APPENDED. The root
     prompt must keep its canonical opening first" — pembuka kanonik tidak
     boleh diubah urutannya.
2. **Step prompt per langkah** (`getAgentPrompt`, `templates/strings.ts`,
   `promptType: 'stepPrompt'`): instruksi tambahan yang disuntik tiap
   langkah (mis. pengingat batching satu baris,
   `BASE3_BATCHING_STEP_PROMPT`).
3. **Prompt tambahan perintah slash** (`system-prompt/prompts.ts`,
   `additionalSystemPrompts`): `/init` (buat/isi `knowledge.md`: apa itu
   proyek, di mana kode kunci, perintah install/dev/test/lint/build),
   `/export` (tulis ringkasan Markdown percakapan ke file
   `codebuff-export-*.md`), `/compact` (ringkas history untuk menggantikan
   history). Ketiganya instruksi sistem, bukan sekadar alias.
4. **Nudge sistem di tengah jalan** (`withSystemTags(...)`): pesan user
   sintetis bertag (mis. `FILE_EDIT_LOOP_RECOVERY`,
   `TODO_PROGRESS_REMINDER`, `FOLLOWUP_TODO_NUDGE`) yang memberi tahu model
   soal loop/ingatan tanpa mengubah peran pesan.

**Konteks proyek — apa yang dibaca saat start:**

- `ProjectFileContext` (`common/src/util/file.ts`): `fileTree` (struktur
  file proyek, di-truncate berdasar budget token:
  `system-prompt/truncate-file-tree.ts`), `knowledgeFiles`,
  `agentTemplates` (agen lokal dari repo), `customToolDefinitions`,
  `gitChanges` (ringkasan git), `systemInfo`.
- **Knowledge files** (`common/src/constants/knowledge.ts`,
  `sdk/src/run-state.ts:833` `loadKnowledgeFilesFromPaths`):
  file yang otomatis dibaca & disuntik ke system prompt
  (`PLACEHOLDER.KNOWLEDGE_FILES_CONTENTS`):
  `AGENTS.md`, `CLAUDE.md`, dan `*.knowledge.md` — disajikan sebagai fenced
  block berlabel path, dengan header
  "Project instructions: Each fenced block below is one instructions file,
  labeled with its path. Follow them for the rest of the session."
  Perintah `/init` membuat `knowledge.md` bila belum ada.
- **Project profile** (`packages/agent-runtime/src/project-profile.ts`,
  tool `report_project_profile`): agen bisa melaporkan profil proyek
  (pemahaman codebase) yang dipakai untuk konteks.
- **Skills** dimuat sesuai kebutuhan (§3), bukan semuanya di awal.
- **File tree truncation:** tree dipangkas berdasar budget token supaya
  system prompt tidak meledak; file dibaca penuh hanya saat agen memanggil
  `read_files` (windowed reads: baca per jendela baris, bukan seluruh file
  besar sekaligus — `readStyleDisplayVariants` di `getToolSet`).

### 7.2 Rencana adopsi ke MethaTech

- **BISA:** struktur system prompt berlapis (root prompt MethaTech +
  step prompt + nudge bertag); knowledge files `AGENTS.md` (+ `*.knowledge.md`)
  dibaca saat `methatech chat` dimulai di sebuah folder proyek dan
  disuntik sebagai fenced block — pola ini murah dan sangat berguna
  (repo MethaTech sendiri sudah punya `AGENTS.md` sebagai "operating manual",
  jadi dogfooding langsung).
- **File tree:** kirim ringkasan tree (bukan isi file) sebagai konteks awal;
  baca isi file hanya lewat tool `read_files` dengan window (baris awal/akhir)
  untuk file besar.
- **Git context:** sertakan `git status/diff --stat` ringkas di konteks awal
  (lewat tool lokal, tanpa kirim ke panel — konteks dirakit di CLI).
- **Perbedaan:** di Freebuff, `fileContext` dirakit CLI lalu dikirim ke
  server dan jadi sumber baca file server-side. Di MethaTech, konteks
  dirakit & dipakai **di CLI yang sama** (tidak ada server yang perlu
  dikirimi snapshot) — lebih sederhana, tanpa serialisasi `fileContext`.
- **Perintah slash adopsi:** `/init` (buat `knowledge.md` proyek),
  `/compact` (ringkas history), `/export` (tulis ringkasan ke file) —
  ketiganya cocok dengan CLI MethaTech dan tidak butuh server.
- **Identitas:** system prompt MethaTech tetap identitas sendiri (bukan
  "Buffy", bukan "Codebuff/Freebuff"); nama agen, warna (#000000 + #39FF14),
  tanpa iklan, tanpa kata "Playground". Aturan-aturan kerja base3 di atas
  diadaptasi bahasanya, bukan disalin mentah.

---

## 8. Hal lain yang relevan

### 8.1 Cara agen menampilkan progress tool call di TUI

- **Event → store → blok.** SDK mengirim event (`tool_call`,
  `tool_result`, `subagent_start/finish`, teks stream) ke
  `cli/src/utils/sdk-event-handlers.ts` (`handleToolCall`,
  `handleToolResult`, `handleSubagentStart/Finish`); state Zustand
  (`cli/src/state/chat-store.ts`, `message-block-store.ts`) menyimpan
  pesan sebagai daftar **blok** (teks / tool / sub-agent).
- **Satu renderer per tool.** `cli/src/components/tools/*.tsx`:
  `defineToolComponent({toolName, render})` mengembalikan
  `{content, collapsedPreview}` — mis. `run-terminal-command.tsx`:
  preview ringkas `` `$ <command>` ``, konten `TerminalCommandDisplay`
  (command tebal + output indent, expandable, maks 5 baris terlihat).
  Pola ini sudah mirip dengan yang ada di MethaTech
  (`src/ui/ChatApp.tsx` + `Thinking.tsx`) — adopsi polanya: tiap tool
  punya renderer + preview satu baris.
- **To-do sebagai progres live.** Prompt base3: "The user watches the
  list as your live progress: each time you finish an item, call
  write_todos again with it marked completed before you start the next
  one." Jadi progres bukan spinner semata — daftar to-do yang dicentang
  satu per satu adalah indikator utama. (Catatan: file
  `cli/src/components/agent-checklist.tsx` BUKAN ini — itu checklist
  dependensi antar-agen untuk tampilan info agen.)
- **Perintah user yang pending** tampil sebagai kotak dashed
  (`pending-bash-message.tsx`) sampai selesai, baru masuk history.
- **Status bar** (`status-bar.tsx`): elapsed time, pemakaian konteks
  (`formatContextUsage`), countdown sesi, model aktif. Untuk MethaTech:
  tampilkan model + konteks terpakai + jumlah step + biaya (panel
  mengembalikan usage) — bukan countdown sesi gratis.

### 8.2 Cara agen menangani error tool

- Error tool call → pesan user bertag `TOOL_CALL_ERROR` di history +
  langkah tambahan untuk retry (§2.1). Pesan error di-strip dari output
  akhir sub-agent.
- Error jaringan transient (`isTransientNetworkError`,
  `FETCH_IDLE_TIMEOUT_USER_MESSAGE`) ditangani di `run-agent-step.ts`
  (retry/abort yang membedakan error sementara vs fatal).
- **Loop guard** (semua di `packages/agent-runtime/src/util/`):
  - `turn-progress.ts`: `NO_PROGRESS_STOP_THRESHOLD = 40` langkah tanpa
    progres (tidak ada file berubah & tidak ada hasil tool baru) →
    berhenti dengan pesan jujur ke user ("I stopped here because my last
    40 steps changed no files… This task is not finished.").
  - `file-edit-loop.ts`: edit yang ditolak berulang ke file yang sama →
    recovery guidance di 3×, berhenti di 6× (edit identik) / 12× (edit
    bervariasi).
  - `todo-loop.ts`: `TODO_LOOP_RECOVERY_THRESHOLD = 3`,
    `TODO_LOOP_STOP_THRESHOLD = 6`.
  - `context-size-guard.ts`: `assertUserContentSize` — tolak prompt user
    yang terlalu besar sebelum dibakar.
  - `truncated-write-guard.ts` + `fit-tool-results.ts` /
    `simplify-tool-results.ts`: hasil tool yang terlalu panjang dipotong/
    disederhanakan sebelum masuk konteks (terminal output cap 50.000
    karakter, §2.1).
  - Semua angka ini adalah **konstanta bernama** — adopsi angkanya sebagai
    titik awal, bukan angka magis tersebar.

### 8.3 Batasan / loop limit

- `MAX_AGENT_STEPS_DEFAULT = 600` (root turn),
  `MAX_SUBAGENT_STEPS_DEFAULT = 200` (sub-agent),
  `MAX_AGENT_STEP_ROWS = 1_000` (baris transport) —
  `common/src/constants/agents.ts`. Komentar source: "a backstop for a turn
  that never stops, not a work limit. A turn that has stalled ends well
  before it."
- Compaction: ambang 80% `maxContextLength`; policy idle 1 jam / min
  140k token (default) — §1.3.
- Sub-agent: maks 6 per panggilan, maks 20 live per root (§4).
- Timeout shell: maks 600 detik, `-1` = tanpa batas (§2.1).
- Semua batas ini **host-enforced** (parameter `maxAgentSteps` masuk
  lewat `sdk/src/run.ts:676`) — di MethaTech, batas ditegakkan di loop
  CLI, bukan di panel.

---

## 9. Rencana adopsi ke MethaTech (Ink + React + Node)

### 9.1 Matriks kompatibilitas

| Aspek | Freebuff | MethaTech | Keputusan |
|---|---|---|---|
| Runtime JS | Bun | Node.js + npm | **Tetap Node.** Jangan pindah ke Bun (perintah Reza; Bun terlalu berat buat Termux). Semua kode adopsi harus jalan di Node. |
| TUI | OpenTUI + React (`@opentui/core`, `<box>`) | Ink + React | **Port pola, bukan komponen.** OpenTUI tidak jalan di Node (0.3.4 butuh Bun FFI; 0.5.8/0.8.3 hanya di Node 26 — sudah dibuktikan). Komponen `<box style>` harus ditulis ulang sebagai komponen Ink (`<Box>`, `<Text>`). Yang diadopsi: perilaku & struktur (blok pesan, renderer per tool, preview satu baris, to-do live, status bar), bukan JSX-nya. |
| State | Zustand (`chat-store.ts` dkk.) | React state/context di `ChatApp.tsx` | **Tetap pola MethaTech.** Zustand bisa dipakai di Node/Ink secara teknis, tapi jangan tambah dependensi demi adopsi — state yang ada sudah cukup; tambah store kecil bila loop agen butuh (mis. daftar tool call aktif). |
| Transport LLM | Vercel AI SDK → backend Codebuff | `src/api.ts` SSE → panel OpenAI-compatible | **Tetap `api.ts`.** Loop agen memanggil `api.ts` seperti chat biasa. Jangan tarik AI SDK. |
| Tool calling | Native AI SDK + XML fallback | **XML `<codebuff_tool_call>` + JSON sebagai jalur utama** | Model gratis panel belum terverifikasi dukung native function calling; XML bekerja di atas teks SSE yang sudah ada. |
| Runtime agen | Server Codebuff | **Loop di CLI (lokal)** | Fase pertama: semua di CLI. Runtime server panel adalah proyek terpisah (butuh endpoint, otorisasi, billing per step). |
| Tool eksekusi | Sebagian server, sebagian client | **Semua lokal di CLI** | Lebih sederhana; file dibaca dari disk langsung. |
| Model | Model Freebuff (DeepSeek V4 Flash dkk. via backend) | 10 model gratis + model berbayar panel MethaTech | Agen memakai model yang dipilih user di picker; **verifikasi dulu** model mana yang bisa mengikuti format XML tool call dengan andal — model yang tidak bisa harus ditolak untuk mode agen dengan pesan jelas, bukan dibiarkan ngawur. |
| Billing | Kredit server-side | Kredit panel (usage dari SSE) | Tampilkan biaya/step di status bar; hentikan turn bila kredit habis (error dari panel → akhiri dengan pesan, jangan retry buta). |
| Identitas | Buffy / Freebuff, ada iklan | MethaTech: hitam #000000 + neon #39FF14, **tanpa iklan**, tanpa kata "Playground" | System prompt & TUI tetap identitas MethaTech. |
| Lisensi | Apache-2.0 | — | Cantumkan atribusi Apache-2.0 untuk pola/kode yang di-port dari Freebuff (seperti perintah Reza untuk adopsi TUI). Jangan salin prompt system Freebuff mentah-mentah; adaptasi dengan bahasa sendiri. |

### 9.2 Urutan implementasi yang disarankan

**Fase 0 — Fondasi (tanpa agen dulu, prasyarat semua fase)**
1. Parser XML tool call stateful (port `util/stream-xml-parser.ts`) +
   eksekutor tool hasil parse + pengembali hasil sebagai pesan `tool`.
   Unit test: tag terpotong di tengah chunk, beberapa tool call dalam satu
   respons, teks di luar tag tetap tampil.
2. Definisi tool minimal sebagai Zod schema (satu file per tool, pola
   `common/src/tools/params/tool/*.ts`): `read_files`, `list_directory`,
   `glob`, `code_search`, `str_replace`, `write_file`,
   `run_terminal_command`, `write_todos`, `task_completed`, `ask_user`.
3. Verifikasi model: uji tiap model gratis panel — bisakah mengikuti format
   `<codebuff_tool_call>` + JSON dengan andal (5–10 panggilan uji per
   model)? Catat model yang lolos sebagai "model agen"; yang gagal
   ditolak untuk mode agen.

**Fase 1 — Loop agen dasar (mode Build)**
4. `loopAgentSteps` lokal: `while(true)` + `runAgentStep` (minta respons
   via `api.ts` → parse tool call → eksekusi → append hasil → tentukan
   `shouldEndTurn`). Aturan akhir turn §1.1 + daftar tool yang tidak
   memaksa langkah berikut.
5. System prompt agen MethaTech (adaptasi base3, §7): aturan kerja,
   verifikasi, larangan destruktif, batas folder proyek, knowledge files
   (`AGENTS.md`, `*.knowledge.md`) + file tree ringkas + `git status`
   sebagai konteks awal.
6. Render progress per tool di Ink (renderer + preview satu baris per
   tool, pola `defineToolComponent`); to-do live via `write_todos`;
   status bar: model + step + konteks + biaya.
7. Loop guard: no-progress 40, file-edit loop 3/6/12, todo loop 3/6,
   maks step 600 (angka awal Freebuff), timeout shell clamp 600 detik,
   cap output tool.
8. Gate konfirmasi (§6.2) — ini pembeda MethaTech, dibangun sejak awal,
   bukan ditempel belakangan. Diff preview untuk tulis file (pakai
   `DiffView.tsx` yang sudah ada).

**Fase 2 — Skill + Plan mode**
9. Tool `skill` + loader `SKILL.md` (`.agents/skills/`,
   `~/.agents/skills/`; frontmatter Zod; daftar skill di deskripsi tool).
10. Mode Plan: toolset tanpa mutasi (penegakan di level toolset, §5) +
    UI ganti mode + slash `/init`, `/compact`, `/export`.

**Fase 3 — Sub-agent + verifikasi paralel**
11. Tool `spawn_agents` (cap 6/panggilan, 20 live) + template agen
    (`file-picker`, `code-searcher`, `basher`, `editor`, `code-reviewer`)
    sebagai `AgentTemplate` dengan tool subset masing-masing; hasil kembali
    hanya ringkasan (`outputForParent`).
12. Pola verifikasi base2: setelah edit, spawn paralel reviewer + basher
    (typecheck + test), perbaiki temuan, ringkasan pendek.
13. Compaction sederhana saat konteks >80% (ringkas history via model,
    simpan sebagai pesan summary; policy per model ditunda).

**Fase 4 — Jauh (hanya bila dibutuhkan & ada perintah)**
14. Mode Max (best-of-n editor + reviewer fan-out) — mahal, butuh evaluasi
    biaya dulu.
15. `propose_*` + pemilihan kandidat edit (best-of-n) — prasyarat Max.
16. Runtime agen server-side di panel — proyek terpisah, butuh desain
    endpoint + billing per step + otorisasi; jangan dimulai sebelum Fase 1–3
    terbukti di CLI.
17. MCP tools, `render_ui`, `browser-use`, `tmux-cli` — tidak relevan /
    ditunda.

### 9.3 Yang sengaja TIDAK diadopsi

- Iklan di tengah chat (`cli/src/ads/*`, `display-ad-*`, `partner-ad-*`) —
  perintah Reza: MethaTech tanpa iklan.
- Mode LITE sebagai mode terpisah — di MethaTech, gratis vs berbayar sudah
  diurus model picker + aturan akses panel.
- Mode YOLO / label Build sebagai perilaku Freebuff — **tidak ada di
  Freebuff** (§5, §10).
- Blok session-start "New conversation started…" — **bukan dari Freebuff**
  (§10).
- AI SDK, OpenTUI, Bun, Zustand — diganti padanan MethaTech yang sudah ada.
- Prompt system Freebuff mentah — diadaptasi, bukan disalin.
- `context-pruner` programmatik & policy compaction per model — ditunda
  ke Fase 3 (versi sederhana dulu).

### 9.4 Catatan lisensi

Freebuff berlisensi Apache-2.0. Kode yang di-port (mis. parser XML tool
call) dan pola yang diadopsi wajib membawa atribusi Apache-2.0 sesuai
perintah Reza untuk adopsi TUI. Prompt system ditulis ulang dengan bahasa
sendiri (ide & aturan boleh sama, teks jangan disalin mentah).

---

## 10. Koreksi sumber: bagian yang ternyata dari VectorHead, BUKAN Freebuff

Atas aturan tetap Reza (2026-11-08 22:20 UTC), bagian ini mencatat secara
eksplisit apa saja di pekerjaan adopsi MethaTech CLI yang sumbernya ternyata
VectorHead (adopsi Freebuff milik Reza sendiri), dan apa padanan Freebuff
aslinya. **Riset di dokumen ini (§1–§9) TIDAK memakai VectorHead sama sekali**
— semuanya dibaca dari `~/workspace/freebuff-source/` commit `5d8bd24`, dan
klaim "tidak ada di Freebuff" di bawah diverifikasi dengan grep langsung
ke clone tersebut.

### 10.1 Blok session-start ("New conversation started…") — dari VectorHead

- **Lokasi di MethaTech CLI (working tree, belum di-commit):**
  `src/ui/ChatApp.tsx:135–166` — komentar di kodenya sendiri menulis
  "Session-start block (VectorHead-style, adopted from the session…"
  dan "(top of the conversation, scrolls away like VectorHead)".
  Juga didokumentasikan di `docs/ADOPTION.md` § "Session-start block
  (VectorHead-style)" (baris ~134–154) yang merujuk eksplisit ke
  "screenshot chat VectorHead" dan "gaya VectorHead".
- **Padanan Freebuff aslinya: TIDAK ADA.** Grep `New conversation started`
  di seluruh `cli/`, `packages/`, `common/src/` Freebuff menghasilkan
  **nol**. Freebuff tidak menampilkan blok pengumuman session-start.
  Yang ditampilkan Freebuff saat chat dibuka adalah: header wordmark
  (`cli/src/components/freebuff-chat-header.tsx`, `FREEBUFF_WORDMARK`) +
  banner/promo terkait sesi + footer model
  (`freebuff-chat-footer.tsx`: nama model + reasoning effort + `/model`).
- **Tindakan:** blok session-start di `ChatApp.tsx` harus dinilai ulang
  dari nol — bukan sebagai "adopsi Freebuff" (karena memang bukan), dan
  tidak boleh dipertahankan dengan alasan "Freebuff begitu". Keputusan
  mempertahankannya atau menghapusnya ada di Reza; dokumen ini hanya
  mencatat asal-usulnya yang benar.
- **DIHAPUS 2026-11-08 ~23:20 UTC** atas perintah Reza ("jangan
  tambah-tambah, apa adanya aja kaya Freebuff"): blok session-start
  dihapus dari `src/ui/ChatApp.tsx` (state `session`, `sessionContent`,
  `sessionLines`), dan skenario PTY s22 di `test/tui-pty.sh` diubah
  menjadi asersi ketiadaan blok tersebut.

### 10.2 Mode "Build" dan "YOLO" di status bar — bukan dari Freebuff

- **Klaim asal (dari tugas riset awal):** "status bar Freebuff menunjukkan
  'Build' dan 'YOLO'".
- **Hasil verifikasi source Freebuff:** `yolo`/`YOLO` = **0 hasil** di
  seluruh repo (termasuk `docs/`). Label mode `Build` = **tidak ada**.
  Mode yang ada: `DEFAULT / LITE / MAX / PLAN`
  (`cli/src/utils/constants.ts`, `AGENT_MODE_TO_ID`), dan di Freebuff
  sendiri toggle mode **disembunyikan** (`AgentModeToggle` return `null`
  saat `IS_FREEBUFF`; `setAgentMode`/`toggleAgentMode` no-op; mode
  dikunci `LITE`). Status bar Freebuff menampilkan nama model + effort +
  countdown sesi, bukan mode Build/YOLO (§5).
- **Padanan Freebuff aslinya: TIDAK ADA.** Nama "Build"/"YOLO" sebagai
  mode kemungkinan berasal dari produk lain (VectorHead atau alat agen
  lain) — dokumen ini tidak menelusurinya karena penelusuran di luar
  Freebuff dilarang aturan tetap, dan sumber pastinya tidak bisa
  dikonfirmasi dari clone Freebuff. **Jangan adopsi Build/YOLO sebagai
  perilaku Freebuff.** Kalau Reza tetap mau nama mode "Build" di MethaTech,
  itu nama MethaTech sendiri yang perilakunya dipetakan ke DEFAULT
  Freebuff (§5.2) — bukan klaim adopsi.

### 10.3 Hal lain yang diperiksa dan dinyatakan bersih

- Chat, input box berbordir, command palette, model picker, thinking
  shimmer di working tree MethaTech CLI — pola-pola ini **ada padanannya
  di Freebuff** (`cli/src/components/chat-input-bar.tsx`,
  `multiline-input.tsx`, `chat-history-screen.tsx`, dsb.) dan sudah
  dicatat di `docs/ADOPTION.md` / `docs/ADOPTION-REPORT.md` sebagai
  adopsi Freebuff; bukan bagian dari koreksi ini.
- Dokumen ini tidak menemukan bagian riset §1–§9 yang bersumber dari
  VectorHead, karena seluruh referensi file di atas adalah file
  Freebuff (`packages/agent-runtime/`, `common/src/`, `cli/src/`,
  `sdk/src/`, `agents/`).

---

## Lampiran: file Freebuff paling relevan (jalan pintas baca ulang)

| Area | File utama |
|---|---|
| Agent loop | `packages/agent-runtime/src/run-agent-step.ts` (`loopAgentSteps` :1115, `runAgentStep`, `shouldEndTurn` :901–1030), `packages/agent-runtime/src/main-prompt.ts` |
| Tool calling | `common/src/tools/constants.ts` (daftar + tag XML), `packages/agent-runtime/src/util/stream-xml-parser.ts`, `packages/agent-runtime/src/tool-stream-parser.ts`, `packages/agent-runtime/src/tools/prompts.ts:362` (`getToolSet`), `packages/agent-runtime/src/tools/handlers/list.ts`, `common/src/tools/params/tool/*.ts` |
| Skill | `common/src/types/skill.ts`, `common/src/constants/skills.ts`, `packages/agent-runtime/src/tools/handlers/tool/skill.ts`, `common/src/util/skills.ts`, `common/src/util/parse-skill.ts` |
| Sub-agent | `packages/agent-runtime/src/tools/handlers/tool/spawn-agents.ts`, `spawn-agent-utils.ts:377` (`executeSubagent`), `packages/agent-runtime/src/util/agent-output.ts`, `common/src/tools/params/tool/spawn-agents.ts` |
| Mode | `cli/src/utils/constants.ts` (`AGENT_MODE_TO_ID`), `cli/src/state/chat-store.ts` (`setAgentMode`/`toggleAgentMode`), `cli/src/components/agent-mode-toggle.tsx`, `agents/base2/base2.ts` (toolset PLAN), `agents/base3.ts` |
| Permission | `packages/agent-runtime/src/tools/handlers/tool/run-terminal-command.ts`, `sdk/src/tools/run-terminal-command.ts`, `cli/src/components/pending-bash-message.tsx`, `cli/src/components/ask-user/index.tsx`, `common/src/tools/params/tool/run-terminal-command.ts` |
| System prompt + konteks | `agents/base3.ts` (root prompt), `agents/base2/base2.ts` (orkestrator), `packages/agent-runtime/src/system-prompt/prompts.ts`, `packages/agent-runtime/src/templates/strings.ts`, `common/src/constants/knowledge.ts`, `sdk/src/run-state.ts:833` (`loadKnowledgeFilesFromPaths`), `packages/agent-runtime/src/project-profile.ts` |
| Progress TUI | `cli/src/utils/sdk-event-handlers.ts`, `cli/src/components/tools/run-terminal-command.tsx`, `cli/src/components/status-bar.tsx`, `cli/src/components/freebuff-chat-footer.tsx` |
| Error & limit | `packages/agent-runtime/src/util/turn-progress.ts`, `util/file-edit-loop.ts`, `util/todo-loop.ts`, `common/src/constants/agents.ts` (`MAX_AGENT_STEPS_DEFAULT = 600`), `common/src/constants/compaction-policy.ts` |
| Arsitektur CLI↔server | `sdk/src/run.ts`, `packages/agent-runtime/src/run-programmatic-step.ts`, `cli/src/chat.tsx`, `cli/src/app.tsx` |
