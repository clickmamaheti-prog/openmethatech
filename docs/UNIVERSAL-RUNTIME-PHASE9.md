# Fase 9 — Cross-Model Testing

**Status: SELESAI 2026-11-10. Diterima? — menunggu Reza.**

Tujuan fase ini: membuktikan seluruh komponen Universal Agent Runtime
bekerja konsisten pada berbagai provider dan model, bukan hanya pada
MockAdapter atau satu model yang sudah terbukti berjalan.

**Hasil singkat:** XML fallback terbukti bekerja pada 12 dari 12 model
yang menjawab (10 konsisten di kedua pass, 2 Gemini hanya di pass 2).
JSON mode terbukti pada 12 dari 12 model yang menjawab. Native tool
calling terbukti hanya pada 1 model (Cohere command-r-plus-08-2024,
2 panggilan dalam satu respons) — 14 model lainnya TIDAK DAPAT diuji
untuk native karena panel mengembalikan 503 untuk setiap request yang
membawa `tools`, sementara request biasa pada model yang sama berhasil
detik kemudian. 3 model (Sonnet, Opus, methatech/uncensored) tidak
dapat diuji sama sekali karena upstream VectorHead jenuh di kedua pass.
Satu bug produk ditemukan dan diperbaiki (loop melaporkan channel yang
tidak dieksekusi). Tidak ada fitur baru, tidak ada perubahan mode CLI /
TUI / panel / production. XML tetap jalur default loop.

---

## §0. Yang dibangun dan diubah di fase ini

| File | Perubahan |
|---|---|
| `src/api.ts` | `StreamHandlers.onToolCallDelta` + parsing `delta.tool_calls`; `StreamOptions.tools` dan `responseFormat` (keduanya probe-only, request byte-identik bila tidak di-set). |
| `src/agent/model-adapter.ts` | Opsi probe-only `probeNativeTools` (default OFF) + `responseFormat`; adapter mengirim `tools` dan meng-emit chunk `tool_call` (delta + satu chunk `complete` per panggilan) HANYA bila probe opt-in; guard fail-loud tetap berlaku tanpa opt-in; `collectChatText` tetap mengabaikan chunk tool_call. |
| `src/agent/model-capabilities.ts` | Field baru `xmlToolCalling` (registry versi 1 → 2); tabel `PROBE_RESULTS_2026_11_10` + `PROBE_RUN_VERIFIED_AT` — hasil probe live di-seed ke registry dengan sumber `probe-live`. |
| `src/agent/loop.ts` | **Bug fix:** `toolChannel` hasil loop kini selalu `"xml-fallback"` (channel yang benar-benar dieksekusi), bukan hasil `channelForModel()` — lihat §8. |
| `test/probe-live.mjs` | **BARU.** Harness probe live: adapter asli + transport asli terhadap panel relay; 3 probe per model (native, XML, structured); mencetak satu baris JSON per probe, tanpa pernah mencetak key. |
| `test/model-adapter.test.mjs` | 6 tes baru: probe opt-in, akumulasi argumen terfragmentasi, tidak ada chunk complete saat transport gagal, `responseFormat` passthrough, `collectChatText` mengabaikan tool_call. |
| `test/model-capabilities.test.mjs` | Field `xmlToolCalling`, versi 2, seed test yang sadar probe, tes-tes lama dipindah ke model di luar subset probe. |
| `test/cross-model.test.mjs` | **BARU.** 8 tes: loop tidak pernah mengirim tools, resolusi channel yang jujur, regresi bug toolChannel, enforcement keamanan yang sama per model, XML valid 1x eksekusi, malformed XML 2x berhenti, stream terpotong, history panjang konsisten. |
| `docs/UNIVERSAL-RUNTIME-PHASE9.md` | Dokumen ini. |
| `docs/UNIVERSAL-RUNTIME-AUDIT.md` | Bagian Fase 9 diperbarui dengan hasil. |

Helper di luar repo (tidak di-commit, tidak ada secret di dalamnya):
`~/workspace/phase9-runner.py` (baca key akun test dari DB bore,
menjalankan probe di background) dan
`~/workspace/phase9-summarize.py` (meringkas hasil probe di bore).

**Tidak diubah:** `src/agent/tool-orchestrator.ts`,
`src/agent/tool-registry.ts`, `src/agent/security.ts`,
`src/agent/shell-sandbox.ts`, `src/agent/context-manager.ts`,
`src/agent/fallback-protocol.ts`, `src/agent/prompt.ts`,
`src/agent/xml-parser.ts`, semua mode CLI / TUI, panel, production.

---

## §1. Metode probe live

**Subset (15 model):** 9 model gratis yang masih ada di katalog live
+ Claude Sonnet + Claude Opus + 1 per provider lain (Cohere
command-r-plus-08-2024, xAI grok-4.7, MethaTech methatech/uncensored,
Moonshot kimi-k3.1-pro). kimi-k2.7-code TIDAK ADA lagi di katalog live
(retired) sehingga tidak dapat diuji — digantikan kimi-k3.1-pro sebagai
perwakilan Moonshot. Total katalog live saat probe: 27 model.

**Harness:** `test/probe-live.mjs` memakai `PanelChatAdapter` asli
dengan transport `streamChat` asli (bukan mock). Tiga probe per model,
prompt pendek, maksimal satu tool call kecil per probe:
- **native:** kirim 2 function tools asli dari registry
  (`read_files`, `list_directory` via `toOpenAiFunction`), minta model
  memanggil keduanya dalam satu respons. Opsi `probeNativeTools: true`.
- **xml:** request biasa tanpa tools; prompt memerintahkan model
  membalas HANYA dengan satu tag `<codebuff_tool_call>` untuk
  `read_files` pada `README.md`. Hasil diparse dengan `parseFullText`
  + divalidasi terhadap registry (`getRegisteredTool`,
  `validateToolInput`).
- **structured:** request biasa + `responseFormat: { type:
  "json_object" }`; prompt meminta tepat objek
  `{"ok": true, "answer": 42}`; hasil di-`JSON.parse`.

Setiap probe di-retry SEKALI bila error retryable (429/5xx/408).
Probe TIDAK PERNAH mengeksekusi tool — hanya mengamati apa yang
dikembalikan model.

**Akun dan key:** akun TEST milik Reza (id10,
tuyulcorporation@gmail.com), BUKAN akun utama. Key dibaca runner dari
DB live panel (`/var/lib/donehub/done-hub.db`, mode read-only,
`user_id=10 AND status=1 AND usable quota`), dipakai langsung di dalam
script, diteruskan ke proses Node lewat environment saja, TIDAK PERNAH
dicetak / disimpan / ditulis ke file mana pun. Nilai key tidak muncul
di laporan ini. Token id9 "sys_playground" STALE (tidak menjawab);
token id16 "Tes" bekerja di pass 1; token id17 "xxxxc" bekerja di pass
2 (cek id16 sempat timeout sekali — panel lambat sesaat, bukan token
rusak). Probe berjalan DI BORE (Node v22.23.2) terhadap panel lokal
(`METATECH_API_BASE=http://127.0.0.1:3000`), bukan lewat internet
publik.

**Dua pass:** pass 1 (2026-11-10 ~07:55 UTC, 15 model × 3 probe =
45 hasil) dan pass 2 (~08:21–08:25 UTC, 14 model × 3 probe = 42
hasil; command-r-plus tidak diulang karena sudah terbukti penuh di
pass 1). Pass 2 mengonfirmasi setiap temuan pass 1 — tidak ada
putusan yang berdiri di atas satu kali percobaan.

**Biaya:** minimal. Model gratis memakai free credit; model berbayar
yang menjawab hanya Cohere, grok, dan kimi dengan total pemakaian
menurut usage yang dilaporkan panel sekitar beberapa sen dolar AS
(sebagian besar dari angka usage grok yang tampak membesar — lihat
§9). Kuota akun test tidak pernah terancam.

**Aturan putusan (dipakai konsisten di kedua pass):**
- SUPPORTED = model TERBUKTI melakukan hal itu dalam probe.
- UNSUPPORTED = model di-probe dan melakukan kebalikannya (misal
  native: menjawab teks biasa tanpa `tool_calls`; XML: menjawab teks
  biasa atau tag malformed).
- UNKNOWN = tidak terbukti ke arah mana pun. Error transport/panel
  (503, timeout) BUKAN putusan kapabilitas — field tetap UNKNOWN dan
  alasannya dicatat. Ketidakhadiran reasoning delta juga UNKNOWN,
  bukan UNSUPPORTED: balasan pendek yang tidak butuh reasoning tidak
  membuktikan apa-apa.

---

## §2. Capability matrix aktual (hasil probe)

S = SUPPORTED (probe-live), U = UNKNOWN (belum terbukti / tidak dapat
diuji), streaming = SUPPORTED via transport untuk semua model katalog
(fakta transport bersama, tidak diubah fase ini). `vision` dan
`contextWindow` tidak di-probe: tetap UNKNOWN / null untuk semua.

| Model | Provider | native | xml | multi | parallel | structured | reasoning |
|---|---|---|---|---|---|---|---|
| deepseek-v4-flash | DeepSeek | U¹ | S | U | U | S | U |
| glm-5.3-flash | Zhipu | U¹ | S | U | U | S | S |
| gpt-6-luna | OpenAI | U¹ | S | U | U | S | U |
| gemini-3.8-flash | Google Gemini | U¹ | S² | U | U | S | S |
| gpt-6-astra | OpenAI | U¹ | S | U | U | S | U |
| gemini-3.1-pro | Google Gemini | U¹ | S² | U | U | S | S |
| qwen3.8-flash | Qwen | U¹ | S | U | U | S | S |
| qwen3.7-max | Qwen | U¹ | S | U | U | S | S |
| deepseek-v4.1-flash | DeepSeek | U¹ | S | U | U | S | U |
| claude-sonnet-4-6 | Anthropic | U³ | U³ | U | U | U³ | U |
| claude-opus-4-6-thinking | Anthropic | U³ | U³ | U | U | U³ | U |
| command-r-plus-08-2024 | Cohere | **S** | S | **S** | **S** | S | U |
| grok-4.7 | xAI | U¹ | S | U | U | S | U |
| methatech/uncensored | MethaTech | U³ | U³ | U | U | U³ | U |
| kimi-k3.1-pro | Moonshot | U¹ | S | U | U | S | U |

¹ Native TIDAK DAPAT diuji: panel mengembalikan 503 untuk setiap
request yang membawa `tools` (2 pass, 4 percobaan per model),
sementara request biasa pada model yang sama berhasil detik kemudian.
Bukan putusan bahwa model tidak mendukung native.
² XML terbukti di pass 2; pass 1 menjawab sapaan biasa tanpa tag.
Kepatuhan pada percobaan pertama tidak konsisten — lihat §4.
³ TIDAK DAPAT diuji sama sekali: semua probe (native, XML,
structured) mengembalikan 503 di kedua pass (upstream VectorHead
jenuh). Tidak ada kapabilitas yang terbukti maupun terbantahkan.

Model di luar subset (13 model katalog lainnya + kimi-k2.7-code yang
sudah tidak ada di katalog): tetap UNKNOWN di semua field kecuali
streaming, sesuai aturan registry.

Registry sudah diperbarui: `PROBE_RESULTS_2026_11_10` di
`src/agent/model-capabilities.ts` (versi registry 2), sumber
`probe-live`, `verifiedAt` 2026-11-10T08:25:00Z. Entri hanya dibuat
untuk model yang punya putusan terbukti; 3 model yang tidak dapat
diuji tidak punya entri (tetap UNKNOWN).

---

## §3. Native tool calling

**Terbukti bekerja — 1 model.** command-r-plus-08-2024 (Cohere)
mengembalikan 2 panggilan native lengkap dalam satu respons
(`read_files` paths `["README.md"]` dan `list_directory` path `"."`),
`finish_reason: tool_calls`, argumen JSON valid. Maka native,
multiple, dan parallel ketiganya SUPPORTED untuk model ini. Ini juga
membuktikan jalur `tools` panel itu sendiri BERFUNGSI — 503 pada
model lain bukan penolakan umum terhadap `tools`.

**Tidak dapat diuji — 14 model.** Setiap request native pada 14 model
lainnya gagal dengan HTTP 503 `Current group upstream is saturated,
please try again later` — di kedua pass, termasuk setelah 1 retry
(2 detik kemudian). Pola ini sistematis: probe native gagal,
probe XML/structured pada model yang SAMA berhasil beberapa detik
kemudian, berulang untuk semua model. Kemungkinan mekanisme (tidak
dapat dibedakan dari sisi CLI): request ber-`tools` dirutekan panel
ke grup channel yang sedang jenuh, atau upstream menolak/mengantrekan
tool call secara berbeda. Yang dapat dinyatakan dengan jujur:
**melalui panel ini, saat ini, native tool calling tidak dapat diuji
untuk 14 model tersebut.** Native tetap UNKNOWN untuk mereka — bukan
UNSUPPORTED, karena modelnya tidak pernah mendapat kesempatan
menjawab.

**Konsekuensi untuk loop:** tidak ada. Loop tetap memakai XML (default)
dan tidak pernah mengirim `tools` — dibuktikan tes cross-model (§6).
Wiring probe (`probeNativeTools`) dilaporkan sebagai kandidat fase
berikutnya; penempatannya diputuskan Reza, bukan fase ini.

**Yang belum dibuktikan native:** single vs multiple tool call dengan
parameter malformed, streaming tool-call delta, error provider dan
pemulihan setelah tool — semuanya membutuhkan model yang menjawab
request native. Satu-satunya model yang menjawab (Cohere) membuktikan
bentuk dasarnya (2 panggilan, delta terakumulasi, finish
`tool_calls`); variasi malformed/error tetap diuji lewat MockAdapter
(§6), bukan live.

---

## §4. XML fallback

**Terbukti pada 12 dari 12 model yang menjawab.** Sepuluh model
mengembalikan tag yang tepat dan valid di KEDUA pass (deepseek
v4-flash, glm-5.3-flash, gpt-6-luna, gpt-6-astra, qwen3.8-flash,
qwen3.7-max, deepseek-v4.1-flash, command-r-plus-08-2024, grok-4.7,
kimi-k3.1-pro). Parser mengekstrak tepat 1 panggilan valid
(`read_files`, parameter valid terhadap registry) dari setiap balasan.

**Dua model Gemini tidak konsisten pada percobaan pertama.**
gemini-3.8-flash dan gemini-3.1-pro di pass 1 menjawab sapaan biasa
("Understood. How can I assist you today?" / "Understood. How can I
help you today?") tanpa tag sama sekali; di pass 2 keduanya
mengembalikan tag yang tepat dan valid (dengan reasoning delta
sebelumnya, ~330 token completion). Putusan: xmlToolCalling
SUPPORTED untuk keduanya (kemampuan TERBUKTI ada), dengan catatan
ketidakkonsistenan di catatan registry. Mekanisme loop yang sudah ada
untuk tepat kasus ini adalah nudge protokol (maks 2x, Fase 6): model
yang tidak memanggil pada percobaan pertama diberi kesempatan kedua
sebelum turn dihentikan. Probe ini memakai 1 percobaan tanpa nudge,
jadi lebih ketat daripada loop produksi.

**Quirk yang diamati (bukan kegagalan):**
- gpt-6-luna pass 1 membungkus tag dalam `<escape>...</escape>`;
  parser tetap mengekstrak panggilan valid. Tidak terulang di pass 2.
- gpt-6-astra memberi satu spasi di depan tag di kedua pass; parser
  tetap mengekstraknya. Tidak berbahaya.
- Tidak ada satu pun model yang mengembalikan tag malformed, JSON
  tidak valid, atau tool yang tidak terdaftar dalam probe live.
  Kasus-kasus itu tetap diuji lewat MockAdapter (§6).

**Tidak dapat diuji:** Sonnet, Opus, methatech/uncensored (503 di
kedua pass untuk semua probe).

---

## §5. Streaming dan context

- **Streaming:** setiap model yang menjawab mengirim SSE delta +
  usage chunk + finish reason yang diproses dengan benar oleh
  adapter (`streamComplete` true, `finishReason` tercatat, usage
  tercatat). Ini mengonfirmasi fakta transport yang sudah di-seed
  (streaming SUPPORTED) — tidak ada perubahan registry untuk field
  ini.
- **Structured output (JSON mode):** 12 dari 12 model yang menjawab
  mengembalikan tepat `{"ok": true, "answer": 42}` sebagai objek JSON
  valid di kedua pass. `structuredOutput` SUPPORTED untuk ke-12 model.
- **Reasoning:** delta `reasoning_content` teramati pada glm-5.3-flash,
  qwen3.8-flash, qwen3.7-max, gemini-3.8-flash (pass 2), dan
  gemini-3.1-pro (pass 2). Model lain: UNKNOWN (tidak teramati, bukan
  terbukti tidak ada).
- **Context panjang / auto-compaction / retry / abort:** diuji lewat
  MockAdapter di tes cross-model (§6) dan sudah diuji di Fase 7
  (120 exchange, tool message tersimpan tepat sekali, stream
  terpotong tidak menjadi jawaban final). Tidak ada jalur live baru
  yang dibuka untuk ini — percakapan live panjang akan menghabiskan
  kuota tanpa menambah bukti kapabilitas.
- **Finish reason:** `stop` untuk semua probe XML/structured yang
  berhasil; `tool_calls` untuk probe native Cohere. Tidak ada
  `length` atau `content_filter` yang teramati dalam probe live.

**Observasi (bukan putusan):** angka usage yang dilaporkan panel
tidak konsisten untuk beberapa model — gpt-6-astra melaporkan
~4786 prompt token untuk prompt ~420 token di kedua pass;
gpt-6-luna 418 di pass 1 lalu 4786 di pass 2; grok-4.7 melaporkan
~1700 prompt / ~700–1080 completion token untuk balasan yang isinya
hanya satu tag pendek. Angka-angka ini tidak memengaruhi putusan
kapabilitas, tapi pemakaian (usage/cost) yang ditampilkan footer
untuk model-model itu patut dicurigai sampai panel menjelaskan
cara hitungnya.

---

## §6. Keamanan lintas model

Tes baru `test/cross-model.test.mjs` (8 tes, MockAdapter, tanpa
jaringan) membuktikan enforcement Fase 8 SAMA untuk setiap model,
bukan hanya satu:
- Loop tidak pernah mengirim `tools` / `probeNativeTools` /
  `responseFormat` untuk model apa pun (glm-5.3-flash,
  deepseek-v4-flash, claude-sonnet-4-6) — XML tetap default.
- Perintah shell berbahaya yang sama (`cat ~/.ssh/id_ed25519` lewat
  tag XML) diblokir dengan pesan yang sama pada dua model berbeda;
  panggilan tercatat di ledger sebagai gagal (ok:false), tidak pernah
  dijalankan, dan tidak ada secret yang bocor ke output.
- Model yang "membantu" menggemakan session key di balasannya:
  key ter-redaksi dari `finalText` dan history pada kedua model.
- Resolusi channel jujur: native hanya bila probe-live membuktikan;
  nilai provider-config SUPPORTED tidak dihitung sebagai bukti.
- Valid XML dieksekusi tepat 1x per model; XML malformed 2x
  menghentikan turn dengan `stopReason` protokol yang sama; stream
  terpotong ditangani sama (tidak ada jawaban final parsial); history
  40 exchange + tool message tetap konsisten (tool message tersimpan
  tepat sekali) pada dua model.

**Catatan batas:** keamanan lintas model dibuktikan pada level
runtime (MockAdapter + loop + orchestrator + Fase 8), bukan dengan
memancing tiap model live untuk mengakali sandbox — variasi format
instruksi dari model live tidak mengubah enforcement karena
enforcement berjalan di kode, bukan di prompt. Tes Fase 8 (59 tes)
tetap hijau dan tidak diubah.

---

## §7. Kompatibilitas

Semua komponen tetap berfungsi (unit + PTY hijau, §10):
11 tool internal, Provider Adapter, Tool Registry, Tool Orchestrator,
Universal Agent Loop, Fallback Tool Protocol, Context Manager,
Streaming, Security Hardening, XML tool calling, Capability Registry.
Tidak ada perubahan perilaku runtime selain perbaikan bug §8 dan
penambahan opsi probe (default OFF).

---

## §8. Bug yang ditemukan dan diperbaiki

### Bug 1 — Loop melaporkan channel yang tidak dieksekusi (produk)
**Temuan:** `AgentLoopResult.toolChannel` dihitung dari
`channelForModel(model)` — yaitu KEPUTUSAN routing dari registry.
Selama tidak ada record yang terbukti native, nilainya selalu
`"xml-fallback"` dan jujur. Begitu Fase 9 men-seed native SUPPORTED
untuk command-r-plus, loop pada model itu akan melaporkan
`"native"` sementara eksekusinya tetap XML. Laporan yang salah
tentang jalur yang dipakai.
**Perbaikan:** `src/agent/loop.ts` — `toolChannel` kini selalu
`"xml-fallback"`, yaitu channel yang benar-benar dieksekusi, dengan
komentar yang menjelaskan bahwa fase berikutnya yang me-wire native
harus mengisinya dari hasil resolusi. Impor `channelForModel` yang
tidak terpakai dihapus. **Tes regresi:**
`test/cross-model.test.mjs` — "the loop reports xml-fallback even
for a native-proven record".

### Bug 2 — Serializer menghilangkan `xml_tool_calling` dari provenance (produk)
**Temuan:** `toAvailableModelEntry()` memasukkan `xml_tool_calling`
ke objek `capabilities` tetapi lupa di peta `capability_source` —
konsumen bentuk panel masa depan akan membaca provenance
`undefined` untuk field itu.
**Perbaikan:** satu baris di `src/agent/model-capabilities.ts`.
Ditemukan oleh tes serializer yang diperbarui.

### Perbaikan build
`seedRecord()` gagal kompilasi TS2322 (indexed access pada union
field menghasilkan `never`) — diperbaiki dengan
`Exclude<CapabilityField, "contextWindow">` pada cast iterasi.

### Koreksi tes (bukan bug produk)
Ekspektasi tes probe saya sendiri salah ketik untuk argumen
terfragmentasi (`'{"}'` seharusnya `'{"}"'` — akumulasi adapter yang
benar). Diperbaiki di tes, bukan di source.

**Tidak ada bug lain yang ditemukan dalam ruang lingkup ini.**
Khususnya: tidak ada duplikasi eksekusi, tidak ada kebocoran secret,
tidak ada regresi Fase 1–8.

---

## §9. Keterbatasan dan yang belum teruji

1. **Native tool calling untuk 14 model belum terbukti** — bukan
   karena model menolak, melainkan panel mengembalikan 503 untuk
   semua request ber-`tools` di dua pass. Perlu probe ulang saat
   upstream pulih. Satu-satunya bukti native live adalah Cohere.
2. **Sonnet, Opus, methatech/uncensored belum teruji sama sekali**
   (503 di semua probe, kedua pass). Model premium yang paling
   relevan untuk coding (Sonnet/Opus) justru belum punya bukti
   kapabilitas apa pun di registry.
3. **Gemini tidak konsisten pada percobaan pertama** (gagal pass 1,
   berhasil pass 2). Registry mencatat SUPPORTED dengan catatan;
   keandalan loop nyata untuk Gemini masih perlu pembuktian live
   lewat TUI (dengan nudge), bukan probe minimal.
4. **Probe memakai prompt minimal, bukan system prompt loop yang
   sebenarnya.** Hasil XML di sini mengukur "mengikuti instruksi
   format eksplisit", bukan "mengikuti prompt agen produksi yang
   jauh lebih kaya". Arah biasnya: probe lebih ketat (tanpa nudge,
   tanpa contoh panjang), jadi model yang lulus di sini hampir pasti
   lulus di loop; model yang gagal di sini belum tentu gagal di loop.
5. **Tidak diuji live:** percakapan panjang nyata, auto-compaction
   nyata, context mendekati batas nyata, multiple/parallel via XML,
   parameter malformed live, variasi instruksi jahat live. Semua itu
   ditutup oleh MockAdapter (Fase 6/7 + §6), bukan live.
6. **Usage panel tidak konsisten** untuk gpt-6-astra, gpt-6-luna,
   grok-4.7 (angka membesar vs teks sebenarnya). Bukan putusan
   kapabilitas; perlu klarifikasi panel bila footer menampilkan biaya.
7. **Kimi-k2.7-code tidak ada di katalog live** (retired) — tidak
   dapat diuji; registry tetap mencatatnya (FREE_MODEL_IDS) sebagai
   UNKNOWN. Bila CLI masih menawarkannya sebagai model gratis, itu
   masalah daftar model, bukan fase ini.
8. **Tidak ada perubahan panel.** Temuan 503 untuk request
   ber-`tools` adalah masalah panel/upstream, bukan CLI — tindak
   lanjutnya ada di jalur panel, bukan di repo ini.

---

## §10. Hasil tes

| Tes | Hasil |
|---|---|
| `npx tsc` | Bersih, tanpa error. |
| `npm test` (unit) | **415/415 hijau** (401 sebelumnya + 6 tes probe adapter + 8 tes cross-model). |
| `test/agent-pty.sh` | **32/32 hijau.** |
| `test/tui-pty.sh` | **270/270 hijau.** |
| Probe live pass 1 | 45/45 hasil tercatat (15 model × 3 probe), token id16 "Tes". |
| Probe live pass 2 | 42/42 hasil tercatat (14 model × 3 probe), token id17 "xxxxc". |

File hasil probe mentah (JSONL, tanpa key) tersimpan di
`~/workspace/phase9-probe-results/` (`results-pass1.jsonl`,
`results-pass2.jsonl` — 87 baris total). Salinan di bore sudah
dihapus setelah diunduh.

---

## §11. Kesiapan Fase 10 dan keputusan yang dibutuhkan Reza

**Fase 9 selesai secara teknis.** Yang bisa dilanjutkan ke Fase 10
(Final Audit & Dokumentasi): matriks kapabilitas terisi bukti,
registry versi 2, wiring probe terdokumentasi, semua tes hijau.

**Yang tetap terbuka (bukan blocker Fase 10, tapi jangan dianggap
selesai):**
- Gate konfirmasi (keputusan 1, dari Fase 8): BELUM
  diimplementasikan — tetap item terbuka, bukan dibatalkan.
- Native tool calling sebagai jalur loop: wiring probe adalah
  kandidat; penempatannya diputuskan Reza.
- Probe ulang saat upstream pulih: native untuk 14 model + semua
  kapabilitas Sonnet/Opus/methatech.
- Follow-up lama: kartu attachment tidak dihitung `layoutBudget`;
  surfacing usage/cost per-step ke footer TUI.

**JANGAN lanjut ke Fase 10 sebelum Reza memberi perintah.**
