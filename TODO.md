# TODO — Codedeck

## GSD integration

- [ ] **CD-059: the Project folder picker listed the workspace, not the projects in it** — ✅ code +
  tests done, **device-verify owed**; shipped to Zapstore in `2026.7.31` (2026-07-30). The dropdown was fed by `machineSessions.map(s => s.project)`
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

  **Steps.** (Updated for the CD-060 select — the field no longer filters as you type.)
  1. Open **New Session** on the Framework machine, tap **Project folder**.
  2. Scroll the picker; then choose **Other** and type `not-a-real-folder`.
  3. Re-open the picker, choose `yenn`, tap **Start Session**.

  **Pass oracle.** (a) Step 1 lists the real folders — `atna`, `codedeck`, `gantry`, `yenn`,
  `nostr-relays/rocket-relay`, … (45 on this workspace) — **replacing the pre-fix single entry
  naming the workspace root**. (b) The **"Create it if it doesn't exist"** checkbox is absent for
  the listed folders and appears for `not-a-real-folder`. (c) After step 3 the session opens rooted
  in `yenn`: the session card's project reads `yenn`, and the GSD strip reflects yenn's own
  `.planning/` rather than the workspace root's.
  </details>

- [ ] **CD-060: the folder picker was a datalist, so it painted over the form and hid its own
  options** — ✅ code + tests done, **device-verify owed**. CD-059 filled the picker with the real
  workspace, but the field was an `<input list="project-dirs">`, and the WebView renders a
  datalist's suggestions as a floating popup: on the phone it appeared *over the "PROJECT FOLDER"
  label above it*, and it only ever showed what the typed prefix matched — a picker you have to
  already know the answer to use, which is the same problem CD-059 set out to remove. With 45
  folders it was also unusable as a scroll list.

  It is a `<select>` now — the phone's own full-screen picker, every folder in it before a key is
  pressed — with `workspace root` first and an `Other — type a folder name…` sentinel last that
  reveals the old text input, because typing a folder that doesn't exist yet is how CD-058 starts a
  project. `resolveProjectFolder(selection, typed)` is the one place that decides what `cwd` gets
  sent, so a draft name abandoned under "Other" can't leak into a session rooted elsewhere. The
  free-text field still stands alone when there is nothing to list at all.

  Second half of the fix is diagnostic: a bridge on **v8** honours `cwd` but can't list folders, and
  that was indistinguishable on the phone from a workspace with no projects in it — the picker was
  just empty and the hint explained neither. It now names the cause ("this machine's bridge is too
  old to list the workspace's project folders"). **This is what cost a release cycle**: CD-059
  shipped to the phone while the laptop still ran the v8 bridge, and nothing on screen said so.
  137 tests (+6).

  <details><summary>Device-verification run-sheet</summary>

  **Preconditions.** Laptop running bridge **2026.7.31** (protocol v9 — verify with
  `unzip -p codedeck-bridge-2026.7.31.vsix extension/out/extension.js | grep -o 'PROTOCOL_VERSION *= *[0-9]*'`
  before installing; the vsix that shipped with the 2026.7.31 release was built *before* CDB-035 and
  still said 8) and the **window reloaded**. Phone on this build (`./dev.sh android-build`,
  `adb install -r` to **comet**, `48101FDKD000MW`) — note it reports version `2026.07.31`, the same
  as the *published* release, which does **not** contain CD-060; install from
  `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`, not from
  the `CodeDeck-v2026.07.31-android.apk` in the repo root, and bump the version before any publish.
  Paired to Framework.

  **Steps.**
  1. Open **New Session** on Framework and tap **Project folder**.
  2. Pick `yenn`, then re-open and pick **Other**, type `brand-new-thing`.
  3. Re-open and pick **workspace root**, tap **Start Session**.

  **Pass oracle.** (a) Step 1 opens the **native full-screen picker**, and the "PROJECT FOLDER"
  label stays readable — **the pre-fix symptom is a floating suggestion box drawn on top of that
  label**, with a single entry in it. (b) Step 2's "Other" reveals a text field, and "Create it if
  it doesn't exist" appears for `brand-new-thing` and not for `yenn`. (c) Step 3's session opens at
  the workspace root — i.e. the abandoned `brand-new-thing` draft was **not** sent as the cwd and no
  such directory exists on the laptop (`ls "$WORKSPACE"/brand-new-thing` → no such file). (d) With
  the **2026.7.30** bridge reinstalled and the window reloaded, the hint reads "this machine's
  bridge is too old to list the workspace's project folders" instead of the generic blurb.
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

## Pairing & settings cleanup

- [ ] **CD-064: auto-scroll fought the user mid-drag in the output stream** — ✅ code + tests done,
  **device-verify owed**. Scrolling back through old output would yank the viewport to the newest
  message. Three separate faults: `autoScrollRef` was mirrored from state during render, so a
  ResizeObserver firing in the same frame as a scroll event read a stale `true`; re-arming keyed on
  "is at bottom" alone, which a row re-measured shorter makes true by shrinking `scrollHeight` while
  the user is parked in old output; and the scroll listener was attached in an effect with only
  stable deps while the List mounts conditionally, so a session that started empty never got a
  listener and stayed latched on forever. Touch/wheel now hold a guard for 200ms after events stop
  so a fling is not fought by its own momentum. Decision logic is DOM-free in `outputScroll.ts` —
  jsdom has no layout, so real scroll geometry can only be exercised there.

  <details><summary>Device-verification run-sheet</summary>

  **Preconditions.** CodeDeck `2026.8.4` on **comet**, paired to a machine with a session holding
  several screens of output and an agent actively streaming (ask it something long).

  **Steps.**
  1. While output is streaming, drag back up into old output and hold the finger still.
  2. Release into a fling upward, let it coast to a stop.
  3. Scroll back down to the bottom by hand.
  4. Tap the **New output** pill while parked in old output.
  5. Open a session that has *no* output yet, then make it produce some.

  **Pass oracle.** (a) Steps 1-2: the viewport stays where the user put it for as long as they are
  reading — **replacing the pre-fix behaviour where it snapped to the newest message mid-drag and
  mid-fling**. (b) Step 3: reaching the bottom resumes following the stream. (c) Step 4: the pill
  jumps to the bottom and re-arms. (d) Step 5: a session that started empty still follows the
  stream — pre-fix it never attached a listener, so it was latched on and could not be scrolled
  away from.
  </details>

- [ ] **CD-061: a phone with no camera could not pair at all** — ✅ code + tests done,
  **device-verify owed**. The bridge hands out one `codedeck://pair?...` URL, but the app only ever
  consumed it through the OS deep-link handler — i.e. only by scanning the QR. There is no barcode
  dependency and no CAMERA permission in the app; scanning is delegated entirely to the phone's
  camera app. So a phone whose camera doesn't work had no way in.

  The only manual path took a **bridge npub + machine name**, and that path *cannot pair*: a
  pair-request needs the one-time `token` that exists only in the URL, so a hand-added machine
  stayed one-way and permanently disconnected unless the user also walked over to the desktop and
  pasted the phone's npub into the bridge's own manual form.

  `handleDeepLink` was already a complete parser, just trapped in `App.tsx` behind the deep-link
  event. It moves to `services/pairingLink.ts` with typed results, and Settings → Remote Machines
  gets a **Pairing link** field fed by it. Scanning is unchanged — both entry points now run the
  same code. The npub form moves under an *Advanced — add by npub* disclosure that says plainly why
  it can't pair alone. `extractPairingUrl` tolerates what a link survives on the way to a phone:
  prose prefixes, wrapping newlines, glued-on sentence punctuation.

  Pairing failure is visible now too. A rejection was `console.warn`-only and an expired window
  produced no ack at all, so a stale link looked exactly like a working one that hadn't connected
  yet. `pairToast` carries `{ ok, message }`, `bad-token` maps to "Pairing link expired", and a 20s
  no-response timer covers the silent case. Needs bridge **CDB-039** for the Copy button. 159 tests
  (+13).

  <details><summary>Device-verification run-sheet</summary>

  **Preconditions.** Bridge rebuilt with CDB-039 (`npm run build` in `codedeck-bridge-vscode/`) and
  the VSCode window reloaded. Phone on this build (`./dev.sh android-build`, `adb install -r` to
  **comet**). Start from the phone's Settings → Remote Machines with the target machine **removed**,
  so pairing runs from scratch.

  **Steps.**
  1. In VSCode run **Codedeck: Pair phone**. Confirm the URL box still shows `&mesh=…` redacted and
     a **Copy pairing link** button is present; click it.
  2. Paste the clipboard into a scratch buffer and confirm it holds the *full* URL — a real `mesh=`
     value and a `token=`, not an ellipsis.
  3. Send that link to the phone (any chat app), paste it into **Settings → Remote Machines →
     Pairing link**, tap **Link machine**.
  4. Prefix a second copy with `Here you go: ` and a trailing newline; confirm it still links.
  5. Close the Pair phone tab in VSCode, then paste the link again.
  6. Open a *new* pairing panel (fresh token) and paste the *old* link.
  7. Paste `hello` into the field.
  8. Scan a fresh QR with the phone camera as before.

  **Pass oracle.** (a) Step 3 shows a green `✓ Connected to {machine}` toast and the machine's dot
  goes green — **replacing the pre-fix behaviour where no paste field existed at all and an
  npub-added machine sat disconnected forever**; the VSCode panel flips to its "Phone paired!" box.
  (b) Step 5 produces a **red** toast *"No response from {machine} — is the Pair phone tab still
  open in VSCode?"* within ~20s, not silence. (c) Step 6 produces a red *"Pairing link expired —
  generate a new one in VSCode."* (d) Step 7 shows inline *"Not a Codedeck pairing link."* (e) Step
  8 pairs exactly as before, proving the App.tsx extraction was faithful.
  </details>

- [ ] **CD-062: remove voice mode** — ✅ code + tests done, **device-verify owed**. Never used, and
  not cheap to keep: a vendored `tauri-plugin-speech-recognizer`, `tauri-plugin-tts`, and — the part
  that actually matters — an Android `RECORD_AUDIO` permission on an app that never listened. Out go
  the settings section, the header speaker toggle, the dictation mic buttons in the input bar and DM
  view, seven frontend modules, the whole plugin directory, both capability entries and the CSS.

  Deliberately kept: `pingSound.ts` (Web Audio notification ping — its `unlock`/AudioContext calls
  read as audio code but are unrelated) and the sessionStore actions `useVoiceMode` called, which
  PermissionBar / GsdStageBar / InputBar also use.

  <details><summary>Device-verification run-sheet</summary>

  **Preconditions.** Fresh APK from `./dev.sh android-build` installed to **comet**.

  **Steps.**
  1. Open Settings and scroll the whole modal.
  2. Open a session; look at the header and the input bar.
  3. Open a DM conversation; look at the input row.
  4. On the host: `"$ANDROID_HOME"/build-tools/*/aapt dump permissions <apk> | grep -i RECORD_AUDIO`
  5. Send a message in a session and answer a permission prompt.

  **Pass oracle.** (a) No **Voice Mode** section anywhere in Settings. (b) No speaker button in the
  session header and no mic button in either input row — **replacing the pre-fix UI where both were
  present**. (c) Step 4 prints nothing (pre-fix it printed `RECORD_AUDIO`). (d) Step 5 still works,
  proving the shared sessionStore actions survived the hook's removal.
  </details>

- [ ] **CD-063: remove the Authentication settings section** — ✅ code + tests done,
  **device-verify owed**. Closes **CD-002** (the API key test had no timeout — the test is gone) and
  delivers **CD-019** together with CD-062. Anthropic API key, GitHub PAT and GitHub username: never
  used, because remote sessions run Claude Code on the paired machine and authenticate there. Out go
  the section, the Send Key / Update Key button and the "No API key" line (both read the key field
  and would have been permanently dead once it went), `test_api_key`, `sendSetCredentials`, the three
  `AppConfig` fields on both sides, `stripSecrets`, `FullConfig`, and — with its last caller gone —
  Stronghold itself.

  **Behaviour change:** local (non-bridge) sessions now read `ANTHROPIC_API_KEY` from the
  environment instead of Stronghold. Remote sessions are unaffected. Existing installs keep an
  orphaned Stronghold vault and `salt.txt` on disk; nothing reads them. A regression test covers a
  `config.json` from an older install still carrying the three removed keys.

  <details><summary>Device-verification run-sheet</summary>

  **Preconditions.** Same APK as CD-062, installed over an **existing** install (not a fresh one) so
  the old `config.json` and Stronghold vault are present — that is the migration case under test.

  **Steps.**
  1. Open Settings and scroll the whole modal.
  2. Look at a paired machine's row under Remote Machines.
  3. Change **Default Mode** and **Model**, tap Save, force-stop the app, reopen Settings.

  **Pass oracle.** (a) No **Authentication** section — **replacing the pre-fix UI with API key, PAT
  and username fields**. (b) A machine row shows only name + connection dot + **Remove**; no
  Send Key / Update Key button and no "No API key" line. (c) Step 3's settings survive the restart,
  proving the old config.json with its three stale keys still deserializes rather than resetting to
  defaults.
  </details>

## Bugs

- [ ] **CD-001: processGiftWrap swallows exceptions silently** — `nostrService.ts:169` — NIP-17 gift-wrap decryption failures return `null` with minimal logging, making DM debugging hard. Added `console.warn` but could surface to UI.
- [x] **CD-002: SettingsModal API key test has no timeout** — moot, closed by CD-063 (the API key field and its Test button are gone). Original: — `SettingsModal.tsx:43-60` — `handleTestApiKey()` calls `api.testApiKey()` with no timeout mechanism. If the network hangs, the UI shows "Testing..." indefinitely.
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
- [ ] **CD-019: Clean up settings menu** — Audit SettingsModal for unused or obsolete options and remove them. Voice Mode (CD-062) and Authentication (CD-063) are done; re-audit what is left.

## Reviews & Fixes

- [ ] **CD-027: Work through consolidated reviews document** — See [REVIEWS_AND_FIXES.md](REVIEWS_AND_FIXES.md) for all findings from 4 independent audits (efficiency, security ×2, UX) — 25 efficiency issues, 32 security findings, 30 UX issues with prioritized fix plans.

## Future Improvements

- [ ] **CD-026: Most used prompts in UI** — Implement a "most used prompts" feature in the phone UI so users can quickly access and reuse their frequently sent prompts.

## Protocol

- [ ] **CD-013: Consider ephemeral event kind for real-time output** — Currently kind 4515 (regular/stored) is used for output events. A cleaner design: use an ephemeral kind (20000-29999) for the real-time stream so relays don't store it, and rely solely on the existing `history-request` pattern for catch-up. Trade-off: breaking change to both sides.
- [ ] **CD-021: Build remote signer support** — Implement NIP-46 remote signer (Nostr Connect) support so users don't need to paste private keys into Codedeck.
