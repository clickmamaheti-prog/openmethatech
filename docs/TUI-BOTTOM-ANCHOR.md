# TUI Bottom Anchor — Freebuff Re-verification and Fix

Date: 2026-11-10. Status: implemented, uncommitted, all tests green.
No commit, tag, push, publish, deploy, or new release. ASCII banner stays deleted.

## 1. What Reza rejected

Live Termux screenshot 2026-11-10 23:14 WIB, CLI 0.1.11, qwen3.8-flash
FREE, Balance $0.0476: header + "Sesi aktif." card + "[23:14] You: hallo"
+ Thinking block + reply "Hallo! Ada yang bisa saya bantu hari ini?" ALL
AT THE TOP, big empty area below, composer at the very bottom. Model
answered correctly — purely vertical position. His order: messages stick
to the BOTTOM, right above the composer, empty space ABOVE the
conversation — like a normal chat and like Freebuff as he perceives it.

## 2. Where the previous audit was wrong

docs/TUI-LAYOUT-RESTORE.md §2 claimed "MethaTech's top-anchored
(flex-start) conversation was ALREADY the correct Freebuff branch
(IS_FREEBUFF)". That reading of the ternary was technically CORRECT —
and that is exactly the problem. The audit answered the wrong question:
"does MethaTech match Freebuff's code branch?" instead of delivering
the visual result Reza ordered. It never ran the real Freebuff binary
and never validated against Reza's requirement, so it stopped at
branch-matching and shipped a layout Reza had already rejected on
sight.

The honest finding, from the real source AND the real binary:

- Freebuff CLI 0.2.36 run in PTY at 80x40, one message sent: banner
  rows 1-6, session card rows 8-11, "[04:21 PM] hallo" rows 13-14,
  reply rows 20-25, empty space below, input at the bottom.
  TOP-ANCHORED — structurally identical to MethaTech 0.1.11.
- Freebuff CLI 0.2.36 at 80x24 startup: content overflows, scrollbar
  visible, view pinned to the bottom (banner top row cut off). That
  is `stickyScroll` + `stickyStart="bottom"` working when content
  OVERFLOWS — which is why Reza perceives Freebuff as bottom-anchored
  on his phone (small viewport / long conversations). With short
  content on a tall terminal, Freebuff is top-anchored too.
- So the audit's §2 conclusion ("already correct") was wrong as a
  DELIVERY verdict, not as a code reading. The bottom-anchoring is
  implemented because Reza explicitly ordered it; the placement value
  comes from the SAME Freebuff ternary — the `flex-end` branch.

## 3. Freebuff files re-read (commit 5d8bd24, ~/workspace/freebuff-source/)

- `cli/src/utils/constants.ts:9` —
  `IS_FREEBUFF = getCliEnv().FREEBUFF_MODE === 'true'`
- `cli/scripts/freebuff-mode.ts` — `FREEBUFF_MODE` is a BUILD-TIME
  literal frozen by `bun build --compile`; the freebuff build refuses
  to build unless `FREEBUFF_MODE=true`. The published binary therefore
  has `IS_FREEBUFF=true`.
- `cli/src/chat.tsx:2244` — scrollbox `stickyScroll`,
  `stickyStart="bottom"`, `scrollbarOptions: { visible: false }`.
  Sticky-bottom pins the view only when content overflows.
- `cli/src/chat.tsx:2273` — contentOptions
  `justifyContent: IS_FREEBUFF ? 'flex-start' : 'flex-end'`.
  Freebuff branch = `flex-start` (top). The `flex-end` branch is the
  Codebuff/non-freebuff side of the same ternary.
- `cli/src/chat.tsx:2280-2297` — scrollbox children: TopBanner, then
  the header box (FreebuffChatHeader / ChatHeader) as unconditional
  first children, then messages.
- `cli/src/components/freebuff-chat-header.tsx:121-126` — session line
  conditional: 'Session active' / 'Next message switches from X.' /
  'Your first message starts the session.'
- `cli/src/hooks/use-scroll-management.ts` (via use-chat-ui.ts) and
  `cli/src/components/message-with-agents.tsx`, `status-bar.tsx` —
  checked for vertical placement mechanics; no second placement
  mechanism exists. The only vertical placement control is the
  `justifyContent` ternary plus sticky-bottom overflow pinning.

Cost note: the one 80x40 Freebuff test message moved the session from
5/5 to 3/5 hours remaining. Do not send further Freebuff test messages
without need. The 80x24 send was NOT completed (a model-switch
confirmation appeared; Esc pressed, session killed, no hour spent).

## 4. What was adopted (port of the Freebuff flex-end branch)

Ink has no ScrollBox, so the manual windowing is kept; only the
placement value changes, taken from the same Freebuff ternary.

- `src/ui/ChatApp.tsx` — message-area Box `justifyContent`
  "flex-start" → "flex-end"; filler rows moved from AFTER
  `windowed.lines` to BEFORE them (order now: scroll indicator,
  filler, lines). Filler exists only while content is shorter than
  the budget (short conversation, necessarily at the bottom); when
  history overflows the filler is 0 and windowing pins to the latest
  (same sticky-bottom as Freebuff). Scrolled-up layout unchanged.
- `src/ui/layout.ts` — `welcomeLayout`: `topPad = slack` (all slack
  above), `bottomPad = 0`. The welcome block (card + Try + starters
  + hint) now sits right above the composer, so the card does not
  jump from the top to the bottom when the first message arrives.
- `test/layout.test.mjs` — top-anchor test rewritten as bottom-anchor
  test (available 36: first row blank, card "╭" at row 26 = 36-10,
  last row is the hint with "/models").

Kept: ContentBlock architecture, /compact, /export, chronological
tool order, MethaTech identity/text/colors, ASCII banner DELETED.
Untouched: provider/model adapter, API, billing, wallet, payment,
agent runtime, theme, all other features.

Backup: `~/workspace/metatech-cli/.bak-20261110-bottom-anchor/`
(ChatApp.tsx, layout.ts, layout.test.mjs, tui-pty.sh).

## 5. PTY evidence — before vs after

Before = `verify-tui-20261110/restore/before/` + `restore/verify/`
(top-anchored 0.1.11 code). After = `verify-tui-20261110/restore/bottom/`
(8 probes: startup 80x24/80x40/120x40, firstmsg, mid streaming,
err503, longhist, pgup).

After, first message at 80x40 (`bottom/firstmsg-80x40.plain.txt`):

- Header row 1; 22 blank rows (empty space above); card rows 24-28
  ("Sesi aktif."); timestamp row 29; "You: hallo" row 30; blank 31;
  reply row 32; composer rows 34-38; footer 39-40. Messages pinned
  right above the composer — the exact layout Reza ordered.

After, startup at 80x24 (`bottom/startup-80x24.plain.txt`): header
row 1, 6 blank rows, card rows 8-12, Try 13, starters 14-16, hint 17,
composer 18-22, footer 23-24.

After, long history at 80x40 (`bottom/longhist-80x40.plain.txt`): 5
turns chronological, card rows 4-8 with only 2 blank rows above
(content 30 rows in a 32-row area, filler 2) — long content fills
the viewport and the header sits higher, as in Freebuff.

After, error 503 (`bottom/err503-80x40.plain.txt`): card rows 22-26,
"You: hallo" row 28, error block rows 31-33, pinned above composer.

After, mid-stream (`bottom/mid-80x40.plain.txt`): streaming lines flow
down, "working... Agent step 1 4s ■ Esc" status row directly above
the composer, no collision.

## 6. Test updates (test/tui-pty.sh) — expectations moved, none removed

The suite's first run against the new layout failed exactly 8 checks,
all row-position expectations from the deliberate behavior change.
Each was updated to the new correct position, verified against the
actual capture — no check deleted, none weakened:

- s13 welcome card: row 2 → 8 (10-row block in the 16-row area,
  topPad 6).
- s14 first timestamp: row 7 → 13 (first turn is 10 rows: card 5 +
  timestamp + "You:" + blank + reply + trailing blank; filler 6).
- s33/80 welcome card: row 2 → 8; first message row 7 → 13;
  "You:" row 8 → 14 (timestamp directly above, §4p preserved).
- s33/120 welcome card: row 2 → 29. This leg runs after the 80 leg
  already submitted a first prompt, so `firstPromptSubmitted` is
  persisted in credentials.json (`src/config.ts:85-95`) and the
  starters are gone for good — the welcome is card-only (5 rows) in
  the 32-row area, topPad 27, card at 2+27=29. Designed behavior,
  not a missing block.
- s35 mid-stream: the exact-row check ("You:" on row 8) is replaced
  by an order check ("You:" above the first streamed text). Under
  bottom-anchoring the user message legitimately RISES as streamed
  content grows below it, so its absolute row mid-stream depends on
  how much has streamed at capture time and cannot be an exact row.
  The surviving invariant is order, which the check now asserts.
  The `check_order`/`check_count` helpers were moved above the
  mid-stream checks so the mid check can use them.
- s35 done: "You:" row 8 → 19 (49-row turn in the 60-row area,
  filler 11; deterministic once the turn completes, proven by the
  passing "working..." absent check and the byte-identical redraw
  check).

## 7. Full validation results

- `npm run build` — clean.
- `npx tsc` — clean, exit 0.
- `npm test` — 428 pass, 0 fail.
- `bash test/agent-pty.sh` — PASS=32 FAIL=0.
- `bash test/tui-pty.sh` — PASS=297 FAIL=0 (was 289/8 before the
  expectation updates; all 8 now pass, no new failures).

## 8. Scope confirmation

Changed files (uncommitted, HEAD e6ba51c v0.1.11):

- `src/ui/ChatApp.tsx`
- `src/ui/layout.ts`
- `test/layout.test.mjs`
- `test/tui-pty.sh`

No changes outside this scope: no provider/model adapter, API,
billing, wallet, payment, agent runtime, theme, or other feature
touched. No commit, tag, push, publish, or deploy. Awaiting Reza's
live Termux verification before any release step.
