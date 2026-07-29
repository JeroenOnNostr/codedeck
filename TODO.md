# TODO — Codedeck

## GSD integration

- [ ] **CD-059: the Project folder picker listed the workspace, not the projects in it** — ✅ code +
  tests done, **device-verify owed**. The dropdown was fed by `machineSessions.map(s => s.project)`
  — the folder names of sessions already running — so on a workspace where every session starts at
  the root it offered a single entry: *"VScode workspace for building nostr apps"*. Choosing a
  project meant typing its folder name from memory, on a phone, which is the one place that is
  hardest to do.

  It now reads the real listing a **v9** bridge sends with the session list (CDB-035), stored per
  machine as `machineFolders` next to `machineProtocolVersion` and pruned with the machine.
  `orderProjectFolders()` floats folders that already host a session to the top of the workspace
  list — the likeliest next pick — and falls back to exactly the old list when the bridge sends
  none, so an un-upgraded bridge loses nothing. "Create it if it doesn't exist" now only appears for
  a name the workspace listing doesn't already contain; for a folder the bridge just said exists it
  was a question about nothing. Field and hint unchanged otherwise: still free text, because typing
  a new folder name is how CD-058 starts a project. 131 tests (+5).

  <details><summary>Device-verification run-sheet</summary>

  **Preconditions.** Bridge on the laptop rebuilt with CDB-035 and the window reloaded (a v8 bridge
  sends no folders and the picker correctly stays as it was). Phone on this build
  (`./dev.sh android-build`, `adb install -r` to **comet**). Paired to Framework.

  **Steps.**
  1. Open **New Session** on the Framework machine, tap **Project folder**.
  2. Type `nostr`, then clear it and type `not-a-real-folder`.
  3. Clear again, pick `yenn` from the list, tap **Start Session**.

  **Pass oracle.** (a) Step 1 shows the real folders — `atna`, `codedeck`, `gantry`, `yenn`, … —
  **replacing the pre-fix single entry naming the workspace root**; step 2 narrows to
  `nostr-relays` and its nested projects. (b) The **"Create it if it doesn't exist"** checkbox is
  absent while a listed folder is typed and appears for `not-a-real-folder`. (c) After step 3 the
  session opens rooted in `yenn`: the session card's project reads `yenn`, and the GSD strip
  reflects yenn's own `.planning/` rather than the workspace root's.
  </details>

- [x] **CD-058: you could not actually start a GSD project from the phone** — ✅ code + tests done,
  **device-verified 2026-07-28** (`docs/CD-058-GSD-DEVICE-VERIFY-RESULTS.md`). Everything CD-052…057
  built was reachable only by a route nobody would find, and it dead-ended:
  *Project folder* never said GSD, the checkbox that creates the folder never said GSD, the opt-in
  hid in an overflow menu, and the button at the end of it — at the workspace root, the only place
  most sessions start — was **disabled with no disabled styling**, so it looked live and ate every
  tap in silence. That is the whole "Start GSD does nothing" report.

  New Session now opens with **"Start a new GSD project"**: name it, and the bridge creates the
  folder, `git init`s it, roots the session there, takes the session out of plan mode, and sends
  `/gsd-new-project` — with the strip already opted in so it is visible for the interview instead of
  only after it. The order matters: GSD's workflows *write*, and in plan mode Claude Code plans them
  instead of running them, so the command waits for `mode-confirmed` (6s fallback, under the store's
  8s revert). Phone-only — works against the **v8 bridge already installed**, no upgrade needed.

  Also: `.gsd-bar-action:disabled` now looks disabled; a non-repo directory offers **New GSD
  project** instead of a dead Start; setup mode reports **"Setting GSD up…" / "GSD is waiting on
  you"** mid-turn instead of rendering three buttons that ignore taps; the buttons say what they do
  (**Map existing code** / **Start GSD here**) with outcomes in their tooltips; and once setup has
  been sent the primary says **Restart GSD setup**, because between "started" and `.planning/`
  existing the old label read as *continue* and would have thrown the interview away.
  (2026-07-28)

- [◑] **CD-053: GSD start button + waiting / live / recovery states** — start button and the
  waiting state **device-verified 2026-07-28**; two sub-checks remain, both needing a project
  further along than a fresh one: (a) the **live execution line**
  (`Phase 2 · plan 1/2 · task 2/3 · <desc>`) reconstructed from GSD's atomic task commits — no phase
  has been executed from the phone yet; (b) the **recovery chips** (`Resume` / `Re-verify` /
  `Blocked`) — no paused, verify-failed or blocked state has occurred. Drive `gsd-testbed`, not a
  new project. Evidence so far: `docs/CD-058-GSD-DEVICE-VERIFY-RESULTS.md`.

- [◑] **CD-054: strip reads "Phase 1 of 1 · 100%" on a 5-phase project** — fix shipped and unit
  tested (`resolvePhaseTotals`); **not yet exercised on device**, because the verification project
  never got a ROADMAP.md and so never rendered an `N/M` readout at all. Remaining sub-check: open a
  session on `gsd-testbed` (5-phase roadmap, 1 phase planned) and confirm the strip reads
  **Phase 1/5 · 20%**, not `Phase 1/1 · 100%`.

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
