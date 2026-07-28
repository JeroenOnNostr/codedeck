# TODO — Codedeck

## GSD integration

- [x] **CD-053: GSD start button + waiting / live / recovery states** — ✅ code + tests done, **device-verify owed**. Needs bridge **CDB-032 (protocol v7)**.

  <details><summary>Device-verification run-sheet</summary>

  **Preconditions.** Phone build from this commit; laptop running the CDB-032 bridge. Two working dirs:
  a GSD one (`cp -r ../codedeck-bridge-vscode/src/__tests__/fixtures/gsd-project /tmp/gsd-verify`) and a
  plain one with no `.planning/` (`mkdir /tmp/plain-verify && git init /tmp/plain-verify`).

  **Steps + pass oracle.**
  1. Open a session on `/tmp/plain-verify`. → **No strip.** (Pre-fix: also no strip, but no way to get one.)
  2. ⋯ menu → it offers **"Enable GSD for this session"**. Tap it. → A quiet strip appears reading
     *GSD not set up here* with **Map codebase** and **Start GSD** buttons. **This is the whole point of
     the change — before it, this state was unreachable.**
  3. Tap **Start GSD**. → `/gsd-new-project` appears in the stream and Claude Code begins the interview.
     An `Unknown slash command` error means the flat/namespaced command detection picked wrong.
  4. Kill the session, reopen it. → The opt-in survived (persisted per sessionId).
  5. Open a session on `/tmp/gsd-verify` **without** enabling anything. → Strip appears anyway; a real
     GSD project must never need the toggle.
  6. Tap the recommended chip (`/gsd-execute-phase 2`) and watch during the run. → The strip switches to
     **`Phase 2 · plan 1/2 · task N/3 · <task name>`** and the numbers **move as tasks commit**. Pre-fix
     behaviour: a frozen `Phase 2/3 · Executing · 50%` for the entire run. The action chip disappears
     while running.
  7. When GSD hits a checkpoint / asks a question. → Strip reads **"Waiting on you"**, bold, no chip.
  8. Open the sheet on phase 2. → Row reads **"Ready to execute · 2 plans · 1 needs you"**.

  **Recovery states (harder to induce; verify at least one).** Run `/gsd-pause-work` in the session →
  strip should show a **Resume** chip sending `/gsd-resume-work`.
  </details>

- [x] **CD-052: GSD stage strip under the session header** — ✅ code + tests done, device-verify owed.
  Collapsible one-line strip (`GsdStageBar.tsx`) showing milestone · phase N/M · situation · %, with a
  tappable chip that sends the next `/gsd-*` command; expands to a bottom sheet (`GsdStagePanel.tsx`)
  listing every phase with GSD's own Discuss/Plan/Execute marks (`utils/gsdStages.ts`) and the
  recommended actions. Fed by the bridge's `gsd-state` message (**CDB-031**), gated on protocol v6, and
  hidden entirely for non-GSD sessions. Re-polls on session open and on turn end.

  <details><summary>Device-verification run-sheet</summary>

  **Preconditions.** Phone build from this commit (`./dev.sh android-build`, `--target aarch64`),
  installed over the mesh. Laptop running the bridge build that includes CDB-031 (protocol v6) —
  an older bridge means the strip correctly never appears, which would be a false negative here.
  A GSD project to point at: `cp -r ../codedeck-bridge-vscode/src/__tests__/fixtures/gsd-project /tmp/gsd-verify`.

  **Steps.** See the CDB-031 run-sheet in `codedeck-bridge-vscode/TODO.md` — same six steps, driven
  from the phone. Additionally, on the phone specifically:
  7. With the strip visible, open the keyboard and type a message.
  8. Rotate / check on the smallest supported screen.

  **Pass oracle.** Steps 1-6 as in CDB-031, plus:
  - Step 7: the strip does **not** push the input bar off-screen and does not fight
    `--keyboard-offset`; the output stream shrinks instead.
  - Step 8: the summary line ellipsizes rather than wrapping to two lines or overflowing.
  - Tapping the chip must feel like typing the command — the command text appears in the stream.
    **Pre-fix behaviour: the only way to run a GSD command from the phone was typing it in full on
    the touch keyboard**, and nothing on screen said which phase you were on.
  </details>

- [x] **CD-054: strip reads "Phase 1 of 1 · 100%" on a 5-phase project** — ✅ code + tests done,
  **device-verify owed**. Fixed in `3f29615` / bridge `46926e4`: `resolvePhaseTotals()` in
  `gsdState.ts` prefers `roadmap_total_phases` and scales the percentage by the fraction of the
  roadmap GSD can see. Verified against the real `gsd-testbed` project:
  `Phase 1/1 · 100%` → `Phase 1/5 · 20%`. Needs **bridge protocol v8** (the phone reads the
  corrected `totalPhases`/`percent` the bridge now sends). 174 bridge tests, 113 phone tests.

  <details><summary>Device-verification run-sheet</summary>

  **Preconditions.** Phone build from this commit; laptop running the CDB-033 bridge. A GSD project
  whose ROADMAP.md has **more phases than have been planned** — `gsd-testbed/` in this workspace is
  exactly that (5 phases, only phase 1 planned and executed). Confirm the raw disagreement first:
  `cd gsd-testbed && node ~/.claude/gsd-core/bin/gsd-tools.cjs smart-entry --json` → shows
  `total_phases: 1` next to `roadmap_total_phases: 5`.

  **Steps.**
  1. Start a session with **Project folder** = `gsd-testbed` (needs CD-056/CDB-033 below).
  2. Read the collapsed strip line.

  **Pass oracle.** The strip reads **`Phase 1/5`** and the meter shows **20%**.
  **Pre-fix behaviour it replaces:** `Phase 1/1` at **100%** — i.e. the phone claimed the project
  was finished when four of its five phases had not been started. Seeing `1/1` or `100%` is a fail.
  A project where every phase is already planned is NOT a valid test — the two counts agree there
  and the bug is invisible.
  </details>

- [x] **CD-055: strip actions are silently dropped when the session is busy** — ✅ code + tests done,
  **device-verify owed**. Fixed in `3f29615`: `GsdStageBar.run()` refuses while the session is
  `running` / `waiting_question` / `waiting_permission`, the recommended chip is suppressed, and
  recovery chips render `disabled` with a reason in the tooltip.
  *Original repro (observed twice, 2026-07-28):* with a turn in flight, tap `Start GSD` —
  `/gsd-new-project` rendered as a sent message, nothing ran, no error.

  <details><summary>Device-verification run-sheet</summary>

  **Preconditions.** Phone build from this commit; a GSD project session (`gsd-testbed` works).

  **Steps + pass oracle.**
  1. Send any prompt that takes a few seconds ("count slowly to 20"). While it is still running,
     look at the strip. → The recommended-action chip is **gone**, and any recovery chip is
     visibly **disabled**. Tapping a disabled chip does nothing and posts nothing to the stream.
     **Pre-fix: the chip stayed live, the tap posted the command into the stream as if sent, and
     the command silently never ran.**
  2. Wait for the turn to finish. → The chip comes back and a tap runs the command normally.
     This half matters as much as the first: the guard must not brick the ordinary path.
  </details>

- [x] **CD-056: `Start GSD` is offered where GSD would do real damage** — ✅ code + tests done,
  **device-verify owed**. Fixed in `3f29615` + bridge `46926e4`: the bridge now surfaces `has_git`
  on `GsdState`, and setup mode disables `Start GSD` when it is `false`, reading
  *"GSD needs a git repository"*. `hasGit` is optional — an older bridge omits it and `undefined`
  must not read as "no repo", or the button would go dead against an un-upgraded laptop.
  *Why it mattered:* at the workspace root `has_git: false`, and `new-project.md` §1 says
  *"If `has_git` false: `git init`"* — a tap would have run `git init` over **27 sibling repos**
  and scaffolded one `.planning/` treating yenn + kubo + gantry + atna + rocket-pilot as one project.

  <details><summary>Device-verification run-sheet</summary>

  **Preconditions.** Phone build from this commit; laptop on bridge `46926e4`+.
  Two dirs: a non-repo (`mkdir -p /tmp/not-a-repo`) and a real repo (`gsd-testbed`).

  **Steps + pass oracle.**
  1. Session with **Project folder** = a path that is not a git repo. ⋯ menu → *Enable GSD for this
     session*. → Strip reads **"GSD needs a git repository"** and `Start GSD` is **disabled**;
     tapping it posts nothing. **Pre-fix: the button was enabled and would have run `git init`.**
  2. Session with **Project folder** = `gsd-testbed`, GSD enabled. → Strip reads its normal GSD
     line (that project is already set up), i.e. the guard did not over-fire.
  3. Point a session at a git repo with no `.planning/` (`git init /tmp/plain-verify`), enable GSD.
     → Reads "GSD not set up here" with `Start GSD` **enabled**. This is the case the guard must
     NOT block; if it is disabled here, the `hasGit` plumbing is broken.
  </details>

## Bugs

- [ ] **CD-001: processGiftWrap swallows exceptions silently** — `nostrService.ts:169` — NIP-17 gift-wrap decryption failures return `null` with minimal logging, making DM debugging hard. Added `console.warn` but could surface to UI.
- [ ] **CD-002: SettingsModal API key test has no timeout** — `SettingsModal.tsx:43-60` — `handleTestApiKey()` calls `api.testApiKey()` with no timeout mechanism. If the network hangs, the UI shows "Testing..." indefinitely.
- [ ] **CD-003: App.tsx deep link errors silently swallowed** — `App.tsx:74-79` — `getCurrent()` and `onOpenUrl()` promise rejections are caught with empty `.catch(() => {})`. If deep link init fails, pairing via QR code won't work with no feedback.

## Notifications (v0.6.5)

- [ ] **CD-004: Bridge relay must stay alive when backgrounded** — `App.tsx` disconnects all relays on `document.hidden`, so `onOutput` never fires when the app is backgrounded and notifications are dead. Fix: only disconnect DM relay on background, keep bridge relay connected.
- [ ] **CD-005: Create Android notification channel** — Android 8+ requires a notification channel or notifications silently fail. Call `createChannel()` in `notificationService.ts:initNotifications()`.
- [ ] **CD-006: Add notifications toggle in settings** — No way to disable notifications. Add a `notifications_enabled` flag to config and a toggle in `SettingsModal.tsx`.
- [ ] **CD-007: Detect session completion** — Currently only `permission_request`, `plan_approval`, and `ask_question` trigger notifications. Add detection for when a remote session finishes.

## Performance

- [ ] **CD-008: Reduce highlight.js bundle size** — `rehype-highlight` pulls all ~180 languages. Switch to `lowlight` with a curated subset (~12 languages) to cut ~80% of the highlight bundle.

## UX Improvements

- [ ] **CD-009: Session badge/counter for background activity** — When viewing one session, show a badge on other sessions in the sidebar that have received new output since last viewed.
- [ ] **CD-010: Better error surfacing** — Several silent failures (gift-wrap decryption, deep link init, API key timeout) should show toast notifications or inline error messages instead of logging to console.
- [ ] **CD-011: TodoWrite checklist rendering** — Render Claude's `TodoWrite` tool output as a proper checklist card in the output stream instead of raw tool_use content.
- [ ] **CD-012: Session pinning / archiving** — Pin active sessions to the top of the sidebar, archive old ones to reduce clutter.

## UX / Layout

- [ ] **CD-015: Option to move session column to right side** — Add a setting to move the left session sidebar to the right-hand side of the screen.
- [ ] **CD-017: Remove local sessions functionality** — Strip out local session support; Codedeck should only handle remote/bridge sessions.
- [ ] **CD-019: Clean up settings menu** — Audit SettingsModal for unused or obsolete options and remove them.

## Reviews & Fixes

- [ ] **CD-027: Work through consolidated reviews document** — See [REVIEWS_AND_FIXES.md](REVIEWS_AND_FIXES.md) for all findings from 4 independent audits (efficiency, security ×2, UX) — 25 efficiency issues, 32 security findings, 30 UX issues with prioritized fix plans.

## Future Improvements

- [ ] **CD-026: Most used prompts in UI** — Implement a "most used prompts" feature in the phone UI so users can quickly access and reuse their frequently sent prompts.

## Protocol

- [ ] **CD-013: Consider ephemeral event kind for real-time output** — Currently kind 4515 (regular/stored) is used for output events. A cleaner design: use an ephemeral kind (20000-29999) for the real-time stream so relays don't store it, and rely solely on the existing `history-request` pattern for catch-up. Trade-off: breaking change to both sides.
- [ ] **CD-021: Build remote signer support** — Implement NIP-46 remote signer (Nostr Connect) support so users don't need to paste private keys into Codedeck.
