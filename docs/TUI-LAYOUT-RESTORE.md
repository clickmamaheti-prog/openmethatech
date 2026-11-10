# TUI Layout Restore — Freebuff Source Adoption

MethaTech CLI, on top of release v0.1.10 (commit `b588026`).
Status: implemented, uncommitted. No commit, tag, push, publish, or deploy.

Reza's live Termux screenshots (2026-11-10 21:02 WIB, CLI 0.1.10,
glm-5.3-flash FREE, Balance $0.0615) showed two layout regressions.
Both are fixed here by adopting the implementation of the original
Freebuff source, not by a new design of our own.

Binding change during the work (Reza, 2026-11-10 14:18 WIB): the ASCII
banner "METHA TECH" is DELETED totally, never used again. Problem B
below is therefore banner removal plus a neat standalone welcome card.
The Freebuff ASCII banner was not adopted or repositioned.

## 1. Freebuff source used

- Repository: https://github.com/CodebuffAI/freebuff.git
- Commit: `5d8bd24c761783504d205b8b8ebf043bb918e158`
  ("Sync public snapshot from freebuff-private")
- Local clone: `~/workspace/freebuff-source/` (verified: remote is
  CodebuffAI/freebuff, HEAD is 5d8bd24)
- License: Apache-2.0. Reference only; the clone was not modified.
- NOT used as a source: vector-agent (clickmamaheti-prog/vector-agent),
  Reza's own Freebuff adoption.

### Freebuff files actually read

| File | What was taken from it |
| --- | --- |
| `cli/src/chat.tsx` (2520 lines) | Root column box; scrollbox `stickyScroll`, `stickyStart="bottom"`, scrollbar hidden; header (TopBanner + ChatHeader) is an UNCONDITIONAL first child of the scrollbox, never hidden by `messages.length`; `updateHeaderVisibility` only tracks visibility for the sheen animation; bottom chrome box (`flexShrink: 0`) holds SuggestedPrompts, ads, StatusBar, input bar, footer; content `justifyContent` is `flex-start` (top-anchored) when `IS_FREEBUFF` (`FREEBUFF_MODE === 'true'`); SuggestedPrompts set false when `messages.length > 0` (lines 1112-1116) and rendered in the bottom chrome, not in the scrollbox |
| `cli/src/hooks/use-scroll-management.ts` (206 lines) | Auto-scroll 50ms after messages change ONLY when at bottom; page scroll = 0.8 viewport; near-bottom threshold 1 line; programmatic-scroll guard so user wheel events are not swallowed |
| `cli/src/components/freebuff-chat-header.tsx` | Outer column box, `alignItems: flex-start`, `width: 100%`, `marginBottom: 1`; wordmark text `marginBottom: 1`; bordered box width `max(16, min(68, terminalWidth - 5))`, border, padding left/right 1; session line conditional: session active + same model → "Session active"; session active + different model → "Next message switches from X."; else → "Your first message starts the session." |
| `cli/src/components/chat-header.tsx` | Non-Freebuff branch (for contrast): column box, padding left/right 1, logo box `marginBottom: 1`, `marginTop: 2` |
| `cli/src/utils/freebuff-wordmark.ts` | Wordmark variants FREEBUFF_WORDMARK (6 rows, ~67 cols) / FREEBUFF_WORDMARK_COMPACT |
| `cli/src/utils/status-indicator-state.ts` (107 lines) | Single state machine, priority ctrlC > clipboard > reconnected > retrying > capacityWait > connecting > paused (ask_user) > waiting > streaming > idle |
| `cli/src/components/status-bar.tsx` (362 lines) | ONE row directly above the input bar, `flexShrink: 0`, padding left/right 1, gap 1; thinking.../working... shimmer (160ms) + elapsed timer + ■ Esc; `↓` scroll-to-bottom button only when not at bottom |
| `cli/src/components/message-with-agents.tsx` | Message box `paddingBottom: 1` except last message (gap 1 between messages); SIDE_GUTTER = 1, padding left/right 1 |
| `cli/src/components/message-block.tsx` | Root column gap 1 (1 blank line between blocks); timestamp directly above user text |

Existence checked, not fully read: `cli/src/types/chat.ts`,
`use-chat-messages.ts`, `message-tree-utils.ts`, `blocks-renderer.tsx`,
`tool-branch.tsx`, `use-send-message.ts`, `message-updater.ts`.

### What was deliberately NOT adopted

- OpenTUI ScrollBox native: Ink has none; MethaTech manual windowing kept.
- Message tree parentId / sub-agent: not relevant to these two regressions.
- StatusBar always-on at idle: Freebuff also toggles it via
  `shouldShowStatusLine`.
- Freebuff ads/surveys (`cli/src/ads/*`): MethaTech never includes ads.
- Freebuff ASCII wordmark: deleted per Reza's order, not adopted.

## 2. Root causes (measured, not guessed)

### Problem A — chat viewport

MethaTech `showWelcome = messages.length === 0` (ChatApp.tsx:591):
the whole welcome block (banner + card + starters, ~11-17 rows)
VANISHED the moment the first message was sent, so the conversation
jumped to the very top of a mostly empty viewport. Freebuff keeps the
header as a permanent first child of the scrollbox; it only scrolls
away naturally when content overflows. The thinking/status position
itself already matched Freebuff (status row directly above the
composer); it only looked stranded because the header had vanished.

The 503 error in Reza's screenshot 1 (`API error 503: Current group
upstream is saturated, please try again later`, request id
`20261110203448318310hxVhEFgt`) is panel upstream saturation, NOT a
TUI bug. Only the layout around it was the problem, and the fix was
verified against a mock returning that exact 503 shape.

MethaTech's top-anchored (flex-start) conversation was ALREADY the
correct Freebuff branch (`IS_FREEBUFF`); the layout.ts header comment
claiming `justifyContent: flex-end` cited the non-Freebuff (Codebuff)
branch and was wrong, but the code itself was right.

### Problem B — banner and welcome screen

Measured from Reza's screenshot 3 with PIL pixel analysis: banner rows
at y=62,80,98,116,134 (pitch 18px), box top border at y=176. The gap
is only 1 blank row, the same as Freebuff's `marginBottom: 1`. The
"far apart" perception came from different widths and left edges:
banner 53 cols centered vs box ~38 cols centered, so the card floated
as a detached narrow island. With the banner deleted per Reza's order,
this is moot: the card alone remains, centered, 5 rows.

## 3. MethaTech files changed

Backup of all four pre-change files:
`.bak-20261110-tui-restore/` (ChatApp.tsx, layout.ts,
layout.test.mjs, tui-pty.sh). No commit, tag, push, publish, deploy.

```
src/ui/ChatApp.tsx   |  32 +++++++++--
src/ui/layout.ts     | 156 +++++++++++++++++++++++++--------------------------
test/layout.test.mjs |  79 +++++++++++++++++++++++++-
test/tui-pty.sh      | 102 ++++++++++++++++++++-------------
4 files changed, 224 insertions(+), 145 deletions(-)
```

### `src/ui/layout.ts`

- `BANNER_FONT`, `BANNER_ROWS`, `bannerLines()` DELETED entirely.
  `centerText()` deleted (only used by the banner and the narrow
  "MethaTech" text). grep "banner" in layout.ts = 0 matches.
  `WelcomeLayout.banner` field removed.
- New `HeaderOptions` interface + `infoBoxContent(opts)` (shared by
  welcome + persistent header): session line / model (+ price) /
  Balance; wide model line only when it fits, else narrow model line.
  Session line follows Freebuff's conditional: hasMessages=false →
  "Pesan pertama memulai sesi."; hasMessages=true → "Sesi aktif."
- New `headerLayout(opts): VisualLine[]`: persistent conversation
  header = the 5-row info box ONLY (top border, 3 content lines,
  bottom border), via the existing centered `boxLines`. Doc comment
  cites Freebuff chat.tsx:2243-2275.
- `welcomeLayout()` rewritten: content = headerLayout
  (hasMessages:false) + "Try:" + starters + hint (all centered as
  before), top-anchored, padded to exactly `available` rows. Content
  is now 10 rows (was 16 with banner); at 80x24 (available 16) it fits
  with 6 rows slack below. No banner logic, no narrow "MethaTech"
  text branch.

### `src/ui/ChatApp.tsx`

- Imported `headerLayout`. Comment above `showWelcome` corrected
  (starters disappear on first message; the card PERSISTS).
- `const flatLines = showWelcome ? [] : [...header,
  ...flattenMessages(messages, messageWidth, { thinkingExpanded })]`
  — header rows prepended to the flattened message lines before
  windowing, so PgUp/PgDn, auto-scroll, and the scroll indicator treat
  the header as the first lines of scrollable content (Freebuff's
  header-inside-scrollbox). Header is render-only: /export and
  /compact read the message list, never these rows. In the empty state
  flatLines was already `[]` (messages empty), so no behavior change
  there.

### Tests updated (deliberate behavior change, same precedent as the §4j test update in Fase 6)

`test/layout.test.mjs`: removed `bannerLines` import + test; removed
`w.banner` assertions; top-anchor test now asserts the first row is
the box top border "╭" and firstBlank == 10 (5 card + 1 Try +
3 starters + 1 hint); added `headerLayout` tests (exactly 5 rows; no
"M   M"/"EEEEE"; no "Try:" in header; "Sesi aktif." when
hasMessages=true and "Pesan pertama memulai sesi." absent then);
"tiny terminal" test fixed (it asserted `narrow.banner === false`,
now asserts no ASCII art + invite line present).

`test/tui-pty.sh`: s13 banner-row check → card top border "╭" on row 2
+ check_absent "M   M"; s14 rewritten as "welcome card PERSISTS as
the conversation header" (checks: "Sesi aktif." present, "Pesan
pertama memulai sesi" absent, "Try:" absent, "M   M" absent, reply
renders, first timestamp on row 7); s33 ts 2→7, You 3→8, banner checks
→ card "╭" row 2 (80x24 and 120x40); s35 terminal 80x56→80x68 (turn
is now 57 rows: 5-row header + user + 11 blocks + chrome), "You:"
row 3→8, input bottom border row 54→66, and the stale label strings
"row 3"/"row 54" corrected to "row 8"/"row 66".
s30 (relative ts/You +1, 4 leading spaces) unchanged and passing.

Two further harness fixes found while closing out the suite (see §6):
s27 "1. pertama" check moved from the top capture to the mid capture
(the 5-row persistent header pushes the numbered list one page down;
the renderer is unchanged — same pattern as the existing §4o
blockquote comment in that scenario); `start_tui` sleep 2s → 3s
(startup race, see §6).

## 4. PTY evidence before / after

Ad-hoc restore harness: `verify-tui-20261110/run-restore-probes.sh`,
mock `verify-tui-20261110/mock-verify.mjs` (extended with a NEW
`error503` mode returning HTTP 503
`{"success":false,"error":{"message":"Current group upstream is
saturated, please try again later (request id:
20261110203448318310hxVhEFgt)","code":"upstream_saturated"}}`,
matching the panel shape; original mock backed up at
/tmp/mock-verify-orig.mjs).

Captures: `verify-tui-20261110/restore/before/` and
`verify-tui-20261110/restore/after/` (each a `.txt` ANSI capture plus
a `.plain.txt` text copy).

### BEFORE (old code)

- 80x40 after first message: header row, "[14:15] You: hallo",
  blank, "Halo! Ini balasan mock.", ~28 rows void.
- 80x40 err503: same shape with the 3-line 503 error — exact
  reproduction of Reza's screenshot 1.

### AFTER (new code)

- Startup 80x40: fixed header, card rows 2-6 ("Pesan pertama memulai
  sesi." / Model / Balance), Try row 7, starters 8-10, hint row 11,
  void below, composer, footer. NO banner anywhere.
- Startup 80x24: card rows 2-6, Try 7, starters 8-10, hint 11,
  5 blank rows, composer 18-22, footer 23-24.
- Startup 120x40: card centered rows 2-6, Try/starters/hint centered
  below, neat.
- First message 80x40: card ("Sesi aktif.") rows 2-6, timestamp
  row 7, "You: hallo" row 8, blank, "Halo! Ini balasan mock." row 10.
- err503 80x40: card ("Sesi aktif.") rows 2-6, timestamp row 7,
  "You: hallo" row 8, blank, 3-line 503 error rows 11-13 — continuous
  flow, matching Reza's screenshot 1 except the header now persists.
- Long streaming 80x40: card, user msg, 120-line reply streaming
  down, "working... Agent step 1 4s ■ Esc" status row directly above
  the composer.
- Long history 80x40: card + 5 turns chronological, all visible.
- PgUp 80x40: identical to the bottom view — probe limitation,
  content (5 turns + header ≈ 30 rows) fits the 32-row message area
  so PgUp is a no-op (maxOffset 0); real PgUp with overflow is covered
  by suite s10/s34.
- Mid-stream-done and PgUp-down captures also saved
  (`mid-80x40-done`, `pgup-80x40-down`); the s27 top capture in the
  suite confirms the header-at-top behavior in the other direction:
  scrolled fully up it shows the header card rows 3-6 with the scroll
  indicator "↑ 1 baris di atas" (exactly 1 line above: the header's
  top border row).

### Side-by-side vs Reza's Termux screenshots

| Reza's screenshot | After fix (PTY) |
| --- | --- |
| S1: "You: hallo" at top, 503 error, void below | Card ("Sesi aktif.") rows 2-6, "You: hallo" row 8, 503 error rows 11-13, continuous flow |
| S2: "You: hallo" top, huge empty area, thinking/status stranded just above composer | Card rows 2-6, user message row 8, reply row 10, status row directly above composer only while streaming |
| S3: ASCII banner top, welcome card far below | No banner anywhere; card rows 2-6, Try/starters/hint directly below it |

## 5. Validation results

- `npm run build`: clean.
- `npx tsc`: clean (exit 0).
- `npm test`: **428/428, 0 fail**.
- `bash test/agent-pty.sh`: **32/32**.
- `bash test/tui-pty.sh`: **297/297, 0 fail** (baseline 293 + 4 new checks:
  s13 +1, s14 +3). These are the numbers of the final full run after the
  §6 harness fixes. /compact, /export, ContentBlock, and tool order
  covered by the suite scenarios (s22, s18, s35, s10, s34) and all
  passing.

## 6. Closing out the suite: the 1 FAIL, the flake, and the fixes

The first full `test/tui-pty.sh` run after the restore returned
PASS=296 FAIL=1, but its output was piped through `tail -25`, so only
the last 25 lines survived and the failing check was unidentified.
A full re-run with the output saved (`/tmp/tui-pty-rerun.log`)
returned PASS=292 FAIL=5. The five failures were exactly two causes:

1. **s27, deterministic, caused by the intended change (1 check).**
   `s27/80: numbered list renders` — needle "1. pertama" not found
   in the top capture. The top capture shows the persistent header
   card rows 3-6, then H1 "Panduan Lengkap" row 10, bold text row 12,
   task list rows 16-17; the numbered list is 5 rows lower than
   before and sits just below the fold. It DOES render: the mid
   capture (one PageDown down) contains "1. pertama" at row 8. The
   renderer is unchanged; the top viewport now legitimately holds the
   5-row header. Fix: moved the check to the mid capture with an
   explanatory comment, the same pattern as the existing §4o
   blockquote comment in that scenario. This was also the single FAIL
   of the first 296/297 run (same code, same deterministic shift).

2. **s1, startup race flake, NOT caused by the change (4 checks).**
   The re-run's s1 capture (`/tmp/methatech-tui-pty/s1-tui-open.plain.txt`)
   was 24 completely blank lines: the TUI had not painted yet when
   `capture` ran 2s after `start_tui`. The change touches nothing on
   the startup path (no init, API, or render-loop change). Proof it is
   environmental: the FIRST full run passed s1 with the same changed
   code (296/297, fail was s27 only); a manual re-run of the exact s1
   steps on an idle machine paints 18 non-blank lines at 2s
   (header + card + Try + starters); the blank captures happened only
   while the machine was loaded (re-run started seconds after the
   previous 8-minute suite). Fix: `start_tui` sleep 2s → 3s (harness
   only, no product code), with a comment recording the flake.

After both fixes the full validation was re-run from scratch: build,
tsc, npm test, agent-pty, tui-pty — all green (numbers in §5).

## 7. Scope confirmation

Changed: `src/ui/layout.ts`, `src/ui/ChatApp.tsx`,
`test/layout.test.mjs`, `test/tui-pty.sh` only (plus this doc).

NOT changed: provider or model adapter; API, billing, wallet, or
payment; agent runtime; theme; ContentBlock architecture; /export and
/compact logic (header is render-only); any unrelated feature.

Historical docs `docs/ADOPTION-REPORT.md` and `docs/ADOPTION.md`
mention the old banner — they are historical records of what 0.1.6
shipped; left untouched. README.md / CHANGELOG.md do NOT mention the
banner and were not touched; the removal belongs in the NEXT release's
changelog section when that release is prepared. No commit, tag, push,
publish, or deploy was made.
