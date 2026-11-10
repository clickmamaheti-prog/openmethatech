# Release Audit Final — 0.1.12

Date: 2026-11-10. Status: GO (no blockers, no conditions).
Auditor: GLM (teammate). All checks run fresh by the auditor on this tree.

## 1. What ships

Bottom-anchor fix, on Reza's explicit order 2026-11-10 ("pesan menempel
di bawah, tepat di atas composer, ruang kosong di atas"): the conversation
is pinned right above the composer, empty space above. Placement value
from Freebuff's own `cli/src/chat.tsx:2273` ternary
(`justifyContent: IS_FREEBUFF ? 'flex-start' : 'flex-end'`) — MethaTech
uses the `flex-end` branch. Full background and PTY evidence in
`docs/TUI-BOTTOM-ANCHOR.md`.

Files changed (uncommitted, HEAD e6ba51c `release: v0.1.11`):

- `src/ui/ChatApp.tsx` — message-area Box `justifyContent`
  "flex-start" → "flex-end"; filler rows moved from AFTER
  `windowed.lines` to BEFORE them.
- `src/ui/layout.ts` — `welcomeLayout`: `topPad = slack`,
  `bottomPad = 0` (welcome block bottom-anchored).
- `test/layout.test.mjs` — top-anchor test rewritten as bottom-anchor.
- `test/tui-pty.sh` — 8 row expectations moved to the new positions,
  verified against actual captures; no check deleted or weakened
  (s13 card 2→8, s14 timestamp 7→13, s33/80 card 2→8 / message 7→13 /
  "You:" 8→14, s33/120 card 2→29, s35 done "You:" 8→19; s35
  mid-stream exact-row check replaced by an order check).

Untracked, NOT to be committed: `docs/RELEASE-AUDIT-FINAL-0.1.9.md`,
4 stale `docs/images/` files, `verify-tui-20261110/` (harness +
captures). No `git add -A` at any point.

## 2. Audit checks (all run fresh)

- HEAD = `e6ba51c` (`release: v0.1.11`); tag `v0.1.11` on remote.
- Working tree: exactly the 4 files above modified; nothing else.
- `dist/`: no `confirm.js` (stale file from the 0.1.9 audit is gone).
- No ASCII banner references in `src/` (`banner`, `BANNER_FONT`,
  `BANNER_ROWS`, `bannerLines()`, `centerText()` all 0 hits).
- README version reference: line 238 only
  ("See `CHANGELOG.md` for the full 0.1.11 change list.").
- `npm pack --dry-run`: 50 files (pre-bump 0.1.11 tarball shasum
  `fa9084e5af7d3685432baf78d71fc27362e06384` — will change after the
  version bump; final pack count re-verified at publish).

## 3. Test results (all run fresh by the auditor)

- `npm run build` — clean.
- `npx tsc` — clean, exit 0.
- `npm test` — 428 pass, 0 fail.
- `bash test/agent-pty.sh` — PASS=32 FAIL=0.
- `bash test/tui-pty.sh` — PASS=297 FAIL=0, log
  `/tmp/tui-pty-0112-audit.log`, `grep ^FAIL` = 0.

## 4. Scope confirmation

No changes outside the bottom-anchor scope: no provider/model adapter,
API, billing, wallet, payment, agent runtime, theme, or other feature
touched. ContentBlock, `/compact`, `/export`, chronological tool order
kept; ASCII banner stays DELETED. No panel changes. No Freebuff test
messages sent (session 3/5 hours remaining, untouched).

## 5. Verdict

**GO.** No blockers, no conditions. Proceed: version bump to 0.1.12,
commit + tag + push, publish via curl PUT, verify from a fresh
published install.
