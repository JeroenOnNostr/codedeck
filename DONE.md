# Done — Codedeck

## Zapstore release 2026.07.28 — CodeDeck 2026.7.28 (2026-07-28)

- [x] **Published CodeDeck `2026.7.28` to Zapstore** — fresh universal APK built from `feat/gsd-stage-strip`, shipping the GSD stage strip (**CD-052**, which itself stays open in TODO.md pending device-verify). versionCode `20260728`, cert SHA-256 `c5d0cba4…fbc5`, matching the kind-30509 NIP-C1 identity proof already on the relay. Signer proven **before** publishing via `zsp publish -q --offline`: all three events resolved to `f07e0b1a…c367`, the listing owner — a mismatch would have forked the listing instead of updating it. Events 32267 / 30063 / 3063 landed `2026-07-28T15:01:08Z`; CDN blob `9226c9f9…24f9` fetched back and verified byte-identical to the local APK. `zapstore.yaml` temp-injection (`release_notes` / `release_source` / `version`) reverted after, per `kubo/docs/zapstore-publish.md`. Companion bridge bumped to `2026.7.28` (commit `cc31486`) because the release notes name it as a requirement — **the VSIX is not published yet**, so the strip is inert for users until it is. (2026-07-28)

## Zapstore release 2026.7.25 + bunker-secret gitignore hole closed (2026-07-28)

- [x] **CD-051: `.env.zapstore` backups were not gitignored** — `.gitignore` ignored `.env.zapstore` but nothing else matching it, and the publish flow leaves rotation backups next to it. `.env.zapstore.bak` was sitting untracked in the working tree containing a live `bunker://...&secret=...` URL, so any `git add -A` would have committed a Nostr signing secret to a public repo. Widened the rule to `.env.zapstore.*` so `.bak` / `.pre-<date>` copies are covered too. Found while doing the Zapstore publish below. (commit `bfd57f5`, 2026-07-28)
- [x] **Published CodeDeck `2026.7.25` to Zapstore** — the listing had been stuck on `2026.6.20` for five weeks. Reused the existing tagged artifact `CodeDeck-v2026.07.25-android.apk` (versionCode `20260725`, cert SHA-256 `c5d0cba4…fbc5`, which matches the kind-30509 NIP-C1 identity proof already on the relay) rather than rebuilding. Published via `zsp publish -q --skip-preview` with `release_source` / `version` / `release_notes: ./RELEASE_NOTES_2026.07.25.md` temp-injected into `zapstore.yaml` and reverted after, per the Kubo runbook (`kubo/docs/zapstore-publish.md`). Events 32267 / 30063 / 3063 all landed at `2026-07-28T10:07:07Z` under `npub17plqkxhsv66g8quxxc9p5t9mxazzn20m426exqnl8lxnh5a4cdns7jezx0`; CDN blob `d939f01f…31fd` verified byte-identical to the local APK. **Bunker note:** the paired signer key rotated (`7dbb7ba8…` → `1b5509d6…`) — these are per-app NIP-46 signer keys, *not* the publishing identity, so a rotation is expected and harmless, but it must be proven before publishing: `zsp publish -q --offline` signs without publishing or uploading and reveals the signer pubkey. It resolved to `f07e0b1a…c367` (the listing owner) — a mismatch would have forked the listing instead of updating it. Pairing is now cached at `~/.config/zsp/bunker-keys/1b5509d6….key`. (2026-07-28)

## Claude Opus 5 selectable on mobile + default (2026-07-25)

- [x] **CD-050: Opus 5 wasn't offered in the model picker** — `src/constants/models.ts` is the single source of truth for the InputBar model popup, the Settings default-model dropdown, and the model badges; its newest entry was Opus 4.8, so Opus 5 could not be selected on the phone at all. Added `{ id: 'claude-opus-5', label: 'O5', name: 'Claude Opus 5' }` at the top of `MODELS` and moved `DEFAULT_MODEL` to `claude-opus-5` (new sessions + fresh installs); Rust default (`config.rs`) moved in lockstep so the Tauri-side agent agrees. Cost tracking: `session.rs` matched `opus-5` on the generic `opus` arm and would have billed it at the old $15/$75 tier — added a specific `opus-5 => (5.0, 25.0)` arm **above** it (Opus 5 is Opus 4.8 pricing) plus a regression test that pins the ordering. Requires bridge **CDB-028** (Agent SDK 0.3.220 / Claude Code 2.1.220) on the laptop side — an older bridge can't resolve the model ID. While here, fixed two stale Rust unit tests that had never run on this machine (the `cargo test` build was blocked by a missing `libspeechd.h` for the TTS plugin): the haiku pricing assert used a long-dead $0.80/$4 rate against the code's $1/$5, and the missing-config default asserted `claude-sonnet-4-20250514` — now derived from `AppConfig::default()` so it tracks the default instead of rotting. `tsc` + vite build clean; 59 vitest pass; `cargo check` + **53/53 cargo tests** pass (with a local speech-dispatcher header/lib shim). Phone-only (APK rebuild to deploy). (commit `8031132`, 2026-07-25)

## Swipe-between-sessions now slides only the content, input bar stays put (2026-06-23)

- [x] **CD-048: Horizontal session-cycle swipe dragged the input box + buttons along with the content** — The swipe-to-navigate gesture applied `translateX` to the whole `MainPanel` outer div, which wraps `SessionHeader` + `OutputStream` **and** `PermissionBar`/`RemotePermissionBar` + `InputBar`, so the text box and all action buttons visibly slid with the message content (looked off mid-swipe). Decoupled the touch target from the moving element: `touchHandlers` stay on the outer panel (a swipe can still start anywhere, including over the input), but only a new inner **slider** wrapping just `SessionHeader` + `OutputStream` translates; `InputBar`, the permission bars, and the optimistic-retry banner now render outside the slider and stay static. The slider is a **single stable element** reused across local/remote/empty sessions so the hook's element (captured before `onSwipe()` switches the session) doesn't go stale on a local↔remote switch — otherwise the slide-in would silently break. Renamed the hook's `containerRef`→`sliderRef` with a doc comment, added `overflow: hidden` on the panel to clip the off-screen content, and split the carousel easing into `ease-in` (exit, accelerate away) / `ease-out` (enter, decelerate in) for a more satisfying feel. Flex layout is effectively unchanged (the `flex: 1` moved onto the slider that contains `OutputStream`), so scroll/height/keyboard behavior is preserved; DM view keeps its current behavior. Frontend build + `tsc` clean; 59 tests pass. Phone-only (APK rebuild to deploy). (commit `b220175`, 2026-06-23)

## Session-list attention dot made actually visible (2026-06-23)

- [x] **CD-047: Sessions awaiting plan-approval / a question still showed no perceptible dot in the list** — Follow-up to CD-045, which added `StatusDot` to `RemoteSessionCard` but left the dot effectively invisible: `.status-dot.waiting` was a 10px white dot at the far-right edge that pulsed opacity 0.3↔1 (shared `@keyframes pulse`), so a glance/screenshot routinely caught it faded — for both `waiting_permission` (plan approval) and `waiting_question` (AskUserQuestion). It was also the *only* signal for a session that turned waiting while foreground, since the stronger `unreadSessions` path skips the active session and only marks on a state transition. Unified "needs attention" into one source of truth + one bold dot: new `sessionNeedsAttention(state, isUnread)` helper (`waiting_permission || waiting_question || isUnread`, independent of unread so it shows even on the active session); `Sidebar` collapses `StatusDot` + the old `session-unread-dot` into a single trailing `.attention-dot` (subtle grey running dot kept), also fixing the latent local/remote `waiting_question` gating mismatch; new `.attention-dot` CSS is solid white, larger, soft halo, with a scale-only `attention-breathe` keyframe that keeps opacity at 1 (the real fix) and honors `prefers-reduced-motion`; dead `.session-unread-dot`/`.status-dot.waiting` removed; `SessionHeader.useAttentionDirection` now uses the same helper for remote sessions too so the ‹ › swipe-nav hints match the dot. Phone-only (APK rebuild to deploy). `tsc` + frontend build clean; 59 tests pass (4 new for the helper). (commit `f9810e4`, 2026-06-23)

## Typed AskUserQuestion answers no longer wedge multi-question groups (2026-06-23)

- [x] **CD-046: Typed answers in a multi-question AskUserQuestion group never reach the bridge** — A grouped `AskUserQuestion` (tabbed `QuestionGroupEntry`) answered by typing manual answers hung: the card optimistically advanced to "All responses sent" while the session stayed "Waiting for your answer". `handleTextSubmit` sent the typed answer via `sendMessage`, which routes to the question-input path only while the single per-session `pendingQuestions` flag is set **and clears it** — so the first typed answer routed correctly and every subsequent one leaked to regular input, queuing behind the bridge turn blocked on `canUseTool`. Now `QuestionGroupEntry`/`QuestionEntry` `handleTextSubmit` use `answerQuestion` (the flag-independent question-input path the multi-select `handleMultiSend` already uses), so each typed answer reaches the bridge's in-order resolver. Removed the now-unused `sendMessage` decls (`noUnusedLocals`). Pairs with bridge **CDB-027**, which adds the authoritative bridge-side guard so the wedge can't recur regardless of phone routing. `tsc` clean; 55 tests pass. (commit `ee98f31`, 2026-06-23)

## Context-usage % from the SDK + waiting dot for remote sessions (2026-06-23)

- [x] **CD-044: Header context-% badge jumps up then down on bridge sessions** — CD-043 fixed the magnitude (use the bridge-advertised real window as the denominator) but not the transient: the numerator (`token_usage`) and the real window (session list) arrive as separate Nostr events, so the first turn computed `%` against the 200K model-id guess (read high) and then dropped ~5x when the real 1M window landed. Now the phone prefers the bridge-advertised `contextPercentage` (protocol v5 — read straight from the Agent SDK's `query.getContextUsage()`, the same meter the Claude Code terminal shows) and renders it directly in `SessionHeader`, falling back to the old `contextPct()` tokens/window computation only for pre-v5 bridges. New `remoteSessionContextPercentage` store map mirrored across the session-list merge, seed, rename, cleanup, delete, and undo-restore. Depends on bridge CDB-026. `tsc` clean; 55 tests pass. (commit `3f78a1f`, 2026-06-23)
- [x] **CD-045: Remote sessions awaiting attention showed no dot in the session list** — A bridge session waiting on a plan-approval / permission (or AskUserQuestion) showed the orange "Waiting for approval" pill in the header but **no** attention dot in the sidebar list, because `RemoteSessionCard` never rendered `StatusDot` (only the local `SessionCard` did) and the unread dot was explicitly suppressed for `waiting_permission`. Now `RemoteSessionCard` renders `StatusDot` too; `StatusDot` widened to the remote state union with `waiting_question` also mapping to the amber "waiting" dot; unread dot suppressed for both waiting states to avoid doubling up. Phone-only; `tsc` clean. (commit `3f78a1f`, 2026-06-23)

## Optimistic session start, mic fix, header context % (2026-06-21, v2026.6.22)

- [x] **CD-016: Microphone dictation unreliable + silent STT failures** — The native Android mic permission used a fixed-delay poll-and-retry hack (`requestPermissions` + "resolve false, frontend retries after 1.5s"), so the first-ever grant always failed; benign Android `SpeechRecognizer` error codes were swallowed and real errors never surfaced. Plugin (`SpeechRecognizerPlugin.kt`) now drives the OS dialog via Tauri's `requestPermissionForAlias` + `@PermissionCallback` + `getPermissionState`, so `request_permission` blocks until the user responds and the returned `granted` is authoritative. `useSpeechRecognition.ts` drops the fixed-delay retry, rechecks availability on mount + window focus (`recheckAvailability`), distinguishes a benign no-match/timeout following our own stop (`stopRequestedRef`) from a mid-listen one (the latter shows a "Didn't catch that" hint), and surfaces real errors. `InputBar`/`input.css` render the STT error inline. (commit `f3f4706`, 2026-06-21)
- [x] **CD-041: Optimistic session start (kill the ~17s "Starting…" wait)** — Tapping Start Session opened a blocking modal that waited on the Nostr pending→ready double round-trip. Now `NewSessionModal` fires `startOptimisticRemoteSession` and closes instantly; `sessionStore` holds a local `optimistic:` placeholder row, buffers any first message typed before the real session exists, and reconciles in place on session-ready (`adoptOptimisticSession` migrates per-session maps + active selection, no flicker, preserves the first-message title). Adoption matched via a per-machine FIFO queue; no-ack (20s) or bridge failure flips the row to `failed` with an inline Retry banner (`MainPanel`). Session-list snapshots no longer drop local placeholders (`isLocalPlaceholder`). `bridgeService.publishToMachine` resolves on the FIRST relay to ack (`Promise.any`, 4s timeout, backoff 2s→750ms) since create is on the critical path. (commit `b86ee2d`, 2026-06-21)
- [x] **CD-042: In-flight mode/effort/model change has no feedback / can silently fail** — A mode/effort/model change updated optimistically with no indication of a slow or failed bridge round-trip. Now each change sets a pending marker + arms an 8s revert timer; the bridge's `*-confirmed` clears it, while a failed send or missing confirm restores the last-confirmed value. `InputBar` shows a "pending" pulse on the mode/effort pills while a change is in flight. (commit `b86ee2d`, 2026-06-21)
- [x] **CD-043: Header context-window % + usage reset countdown + /compact** — Replaced the per-turn token in/out header line with a context-window occupancy badge (" · NN%") bundled into the model badge, computed from a per-turn context snapshot (`input + cache_read + cache_creation`) over the model's max context (`modelContextWindow` — 200K default, 1M for the `[1m]`/`-1m` beta). Added a `/compact` header button that sends the slash command verbatim to summarize history. `UsageBadge` now shows the freshest snapshot across all sessions (limits are account-global) so the chip doesn't jump when cycling sessions, in two rows (5h / wk) each with a short time-until-reset countdown that ticks once a minute. (commit `f653d8f`, 2026-06-21)

## Model selection up front + sidebar keyboard fix (2026-06-20, v2026.06.20)

- [x] **CD-039: Relocate model selection to session creation + always-on header model badge** — The Claude model was chosen via a per-turn popup in the `InputBar` and only surfaced behind the `show_model_badge` config toggle. Moved the choice to `NewSessionModal` (a `<select>` over `MODELS`, defaulting to `config.model`/`DEFAULT_MODEL`); `createRemoteSession(machine, testSession, model)` now threads the picked model to the bridge, falling back to `config.model`. Removed the in-bar model picker (button, popup, outside-click handler, `input.css` styles) and the config-gated YOLO/model badges from `SessionHeader` title and `RemoteSessionCard`. `SessionHeader` now renders a right-aligned `header-meta` column that **always** shows the live model (`liveModel ?? remoteSession.model ?? configModel`) alongside the usage chip + token in/out. `tsc` clean; 35 tests green. (commit `b5540fe`, 2026-06-20)
- [x] **CD-040: Sidebar drawer + new-DM input hidden behind the soft keyboard** — The sidebar drawer used `bottom: 0` (full window height) so it sat under the on-screen keyboard, and the `dm-section` only got `--active` in `panelMode === 'dm'`, so the new-DM pubkey input was covered/collapsed while typing. Drawer now uses `height: var(--app-height)` (tracks the visual viewport, matching `MainPanel`), and `dm-section` gets `--active` whenever `showNewDm` is set. (commit `b5540fe`, 2026-06-20)

## Hide gray per-turn metadata lines (2026-06-20)

- [x] **CD-038: Light-gray metadata lines clutter the output stream** — The session output rendered intermittent gray system lines between agent messages: `Tokens: N in / N out` (emitted every turn), `Session complete — N turns, $cost`, and the `Claude Code x.y.z (model)` banner. `OutputStream.filteredDisplay` now unconditionally drops these three metadata-only `system` lines (prefix match on `Tokens:` / `Session complete` / `Claude Code`), instead of the old `show_session_metadata` gate — which defaulted on, never covered the per-turn `Tokens:` lines, and is persisted device-side (so flipping the default would not have reached existing installs). Removed the now-inert "Show session metadata" toggle from `SettingsModal`. Frontend-only (no Rust/APK rebuild needed); `tsc --noEmit` clean. (commit `4fa7aa8`, 2026-06-20)

## Notification dot + mobile ping fix (2026-06-20)

- [x] **CD-036: Notification dot lit while session still running** — The sidebar unread dot persisted while the agent was actively working (the session-list `state` can go stale-`idle` while output streams, and nothing cleared the flag). `sessionStore.addOutput` now clears the unread flag on any non-card, non-`stream_end` output (the agent is working ⇒ not waiting on us); the dot lights only on a permission/plan/question card (blocked) or on `stream_end` (task fully done). Tests added in `__tests__/sessionStore.test.ts`. (commit `5240ea8`, 2026-06-20)
- [x] **CD-037: Audible ping never plays on mobile without OS-notification permission** — `notifyIfNeeded()` returned early on `!permissionGranted` before `playAttentionPing()`, silencing the in-app Web Audio ping on Android when the OS notification permission wasn't granted. Reordered so the ping plays independently of OS permission (still gated by the in-app Notifications toggle); only the OS notification itself requires permission. Tests added in `__tests__/notificationService.test.ts`. NOTE: a backgrounded WebView suspends Web Audio — background alerts still rely on the OS notification sound (see CD-005 Android channel). (commit `5240ea8`, 2026-06-20)

## Mesh stale-link fix (2026-06-19)

- [x] **CD-035: Mesh link goes stale after the phone backgrounds — bootstrap/transit auto-reconnect** — A test-target Pixel's laptop↔phone FIPS link went `fips participant stale` after the app backgrounded and never recovered. Root cause in the embedded nostr-vpn engine: configured bootstrap/transit peers had `auto_reconnect=false`, and fips-core's `schedule_reconnect()` early-returns on MMP dead-timeout when `!auto_reconnect`, so a bootstrap link dropped while backgrounded was never re-dialed (both NAT'd peers rendezvous through that relay path). Fix (surgical, both sides): mobile new `FIPS_BOOTSTRAP_AUTO_RECONNECT=true` const for the bootstrap loop in `fips_peer_configs_from_mesh` (`nostr-vpn/crates/nostr-vpn-app-core/src/mobile_tunnel/`); desktop split bootstrap out of `operator_static` with a dedicated `bootstrap_endpoints` arg + `auto_reconnect:true` loop on `fips_endpoint_peers_from_mesh` (`nostr-vpn/crates/nostr-vpn-cli/src/fips_private_mesh/`). Ambient learned non-roster peers stay off (battery/relay guard). Lives in the contribute-back `nostr-vpn` dep on branch `fix/bootstrap-transit-auto-reconnect` (commit 04fd59c, NOT pushed — upstream is `mmalmi/nostr-vpn`). Tests: app-core 105/0, nvpn 259/0, clippy clean. **Verified on-device:** a 2-hour-stale laptop↔Pixel 9 link recovered within seconds of loading the patched daemon (relayed→direct UDP), and a 12.7MB `adb install` over the mesh completed.

## One-QR Mesh Onboarding (2026-06-18)

- [x] **CD-034: One-QR mesh onboarding — auto-import mesh invite + one-tap role prompt + zero-serial test device** — Scanning the bridge's (now mesh-bundled) QR auto-joins the mesh and asks one question. `App.tsx handleDeepLink` reads the `mesh`/`netid` params and auto-imports the invite (`meshClient.importMeshInvite`), then opens a one-time **role prompt** (`RolePrompt.tsx`, state in `uiStore.rolePrompt`): "This is my controller" or "This is a test device". Controller = done (never touches the mesh). Test device = persist the test-target opt-in, `connectMesh()` (fires VPN consent), read the phone's REAL mesh identity (`getMeshIdentity` → `tunnelIp`+`ownPubkeyHex` from `mesh_status`, since the mesh engine has its own key separate from the app key), and send `set-device-config` with `role:'test-target'` + `meshIp` + `meshPubkey` — no serial typed. New `services/meshClient.ts` centralizes mesh ops (shared `TEST_TARGET_KEY`); `MeshSection.tsx` reworded to "scan the QR" with the manual invite paste as a fallback, and its test-target toggle now uses the shared helper. `DeviceConfig` gains optional `role`/`meshIp`/`meshPubkey` and `serial` is now optional. Verified on-device end-to-end (Pixel 9 → test device, serial == real tun0; Fold → controller, stays off mesh).

## Frictionless Pairing + DM Profile Metadata (2026-06-15, v2026.06.15.1)

- [x] **CD-032: Zero-touch auto-pairing + first-run keypair** — Scanning the bridge QR now fully pairs the phone with no manual npub entry. After the deep-link adds the machine, the phone auto-sends an encrypted `pair-request` (own npub + label + the QR's one-time token) via the existing `publishToMachine`; on the bridge's `pair-ack` it marks the machine connected and shows a "Connected to …" toast (`PairToast.tsx`). A fresh install now **auto-generates a Nostr keypair on first launch** (`App.tsx`) so pairing AND DMs work out of the box — importing an nsec in Settings still overwrites it. New `pair-request`/`pair-ack` protocol messages, `sendPairRequest` + `onPairAck` in `bridgeService.ts`, `pairWithMachine`/`pairToast` in `sessionStore.ts`.
- [x] **CD-033: Reliable DM profile metadata (outbox + avatars)** — Profiles now resolve reliably instead of getting stuck on a raw npub. New `profileService.ts` uses an outbox model (fetch the contact's NIP-65 kind-10002 from aggregator relays — purplepag.es / relay.nostr.band — then query kind-0 from their write relays + a broad fallback set) with 3 retry rounds, in-flight dedup, and full metadata (name, displayName, **picture**, nip05, about). New `Avatar` component renders the picture with a deterministic identicon fallback, plus loading shimmer and tap-to-retry on failure, wired into `DmTile` and `DmConversationView`. `dmStore` reworked to a `profiles` map with graceful migration from the old name-only cache; removed the dead single-relay `fetchProfileName`.

## Model & Effort Modernization (2026-06-15, v0.8.0)

- [x] **CD-029: Per-session model selection over the bridge** — Phone can now choose the Claude model for a remote bridge session (previously the model dropdown only affected the local Tauri agent and never reached the bridge). Added `model` to the `create-session`/`model`/`model-confirmed` protocol messages, `remoteSessionModel` store state + `setModel` action, undo-snapshot persistence, and a model picker popup in `InputBar` (`src/constants/models.ts` is the single source of truth). Bridge applies it via `Options.model` at session creation and `query.setModel()` mid-session.
- [x] **CD-030: Refresh model list + defaults + pricing** — Settings model dropdown now lists Opus 4.8 / Opus 4.7 / Sonnet 4.6 / Haiku 4.5 / Fable 5; default model bumped to `claude-opus-4-8` (TS + Rust + fixed stale config test). Token pricing table in `session.rs` updated to June 2026 rates (Opus 4.8/4.7 $5/$25, Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5, Fable 5 $10/$50).
- [x] **CD-031: Add `xhigh` effort + model badge** — `EffortLevel` widened with `xhigh` (cycle + Settings dropdown); new `show_model_badge` config (default on) renders a model badge in `SessionHeader` and `Sidebar` mirroring the mode/commit badges.

## Bug Fixes (2026-03-01)

- [x] **Seq counters reset on bridge extension restart** — Fixed: `sessionWatcher.ts:loadFullHistory()` derives seq counters from JSONL content on restart, `extension.ts` persists `lastSeenTimestamp` in `globalState` for crash recovery.
- [x] **sendToClaudeTerminal ignores sessionId** — Fixed: `terminalBridge.ts` now has full session-to-terminal mapping via `TerminalRegistry`.
- [x] **Phone subscription should use `since` filter** — Fixed: `bridgeService.ts:connectToMachine()` uses `since: lastSeenTimestamp - 5` with 5-minute fallback window on first connect.

## Reliability Audit — Bridge (2026-03-03)

- [x] **Relay reconnection with exponential backoff** — `nostrRelay.ts` — `scheduleReconnect()` with 2s->30s cap.
- [x] **Output queue cap increased** — `nostrRelay.ts` — `MAX_OUTPUT_QUEUE_SIZE` raised from 200 to 500.
- [x] **TOCTOU fix in readNewLines** — `sessionWatcher.ts` — `openSync()` first, `fstatSync(fd)` second.
- [x] **Terminal liveness checks** — `terminalBridge.ts` — `exitStatus !== undefined` guard before each `sendText()`.
- [x] **Pending timer cleanup** — `terminalBridge.ts` — `pendingTimers` Set tracked and cleared in `dispose()`.
- [x] **Flush guard** — `terminalBridge.ts` — `flushingSession` Set prevents concurrent `flushPendingInputs()`.
- [x] **LRU history eviction** — `sessionWatcher.ts` — standalone 5-minute interval evicts idle sessions when total exceeds 10K entries.
- [x] **Dead session pruning** — `sessionWatcher.ts` — `pruneDeletedSessions()` checks `fs.existsSync` every ~36s.
- [x] **Dispose lifecycle** — `nostrRelay.ts` — `dispose()` method prevents reconnection after deactivation.

## Reliability Audit — Codedeck App (2026-03-03)

- [x] **Decryption failure tracking** — `bridgeService.ts` — After 5 consecutive failures, emits `onStatus('disconnected')`.
- [x] **Per-session card tracking** — `sessionStore.ts` + `OutputStream.tsx` — `respondedCards` is `Map<sessionId, Set<cardId>>`.
- [x] **History chunk tracker keyed by requestId** — `sessionStore.ts` — eliminates race when second history-request arrives before first completes.
- [x] **Capped seq dedup** — `sessionStore.ts` — `seenBridgeSeqs` Set capped at 1000 entries per session.
- [x] **Handler re-registration** — `sessionStore.ts` — `initBridgeService()` always re-registers handlers.
- [x] **Periodic rumor ID cleanup** — `nostrService.ts` — 5-minute interval evicts stale `sentRumorIds`.
- [x] **DM profile fetch timeout** — `nostrService.ts` — `fetchProfileName()` wrapped in `Promise.race()` with 5s timeout.

## Swipe-to-Delete Sessions (2026-03-06)

- [x] **Swipe-to-delete sessions** — New swipe gesture for session deletion with close-session protocol message to bridge (`2df9f35`, 2026-03-06)
- [x] **Undo toast UI** — Added missing undo toast for swipe-to-delete (`eb61726`, 2026-03-07)

## Mode Cycle & Plan Mode Overhaul (2026-03-07 — 2026-03-23)

- [x] **Correct mode cycle order** — Fixed to PLAN→BYPASS→EDITS with plan as default fallback (`dea1ecf`, 2026-03-07)
- [x] **Prevent bridge overwriting phone bypass mode** — Bridge no longer overwrites phone's mode with default (`e276e75`, 2026-03-07)
- [x] **Plan approval card matches Claude Code 4-option menu** — Updated card to reflect Claude Code's actual options (`1a27209`, 2026-03-07)
- [x] **Auto-approve read-only tools in plan mode** — Read/Glob/Grep/etc. auto-approved (`cd7df2d`, 2026-03-08)
- [x] **Hide auto-approved permission cards in plan mode** — Cards no longer flash on screen (`223fccc`, 2026-03-08)
- [x] **Handle session-replaced events** — Merge plan option 1 sessions correctly (`83bf067`, 2026-03-08)
- [x] **Initialize session mode on creation** — Plan auto-approve works for fresh sessions (`eb89ff1`, 2026-03-09)
- [x] **Sync mobile UI mode on plan approval** — Mobile mode state stays in sync (`76ae9d4`, 2026-03-09)
- [x] **Remove ExitPlanMode from auto-approve set** — Prevents unintended plan exits (`1826c72`, 2026-03-23)
- [x] **CD-014: Remove phone-side auto-approve logic** — Phone no longer auto-approves; bridge is sole authority. Removed PLAN_AUTO_APPROVE set, mode subscription, useEffect dispatch from PermissionRequestEntry (`1713db0`, 2026-03-29)

## Question Card UX & Free-Text Input (2026-03-08 — 2026-03-23)

- [x] **Free-text input on question cards** — Cards now support typed answers, not just button choices (`5a7d856`, 2026-03-08)
- [x] **Plan revision text input** — Dedicated "Type your revision below" field for plan revision option (`1af519c`, 2026-03-08)
- [x] **Detect free-text options at any position** — Free-text option no longer required at end of menu (`9daa467`, 2026-03-09)
- [x] **Tabbed multi-question cards** — Multiple AskUserQuestion prompts grouped into tabbed card (`b0e778c`, 2026-03-23)

## Blossom Upload Fixes (2026-03-08 — 2026-03-15)

- [x] **AES-256-GCM for Blossom uploads** — Switched from NIP-44 to AES-256-GCM encryption (`0c91091`, 2026-03-08)
- [x] **HTTPS in CSP for Blossom** — Updated Content Security Policy to allow HTTPS Blossom endpoints (`845fc51`, 2026-03-15)

## Misc Fixes (2026-03-06 — 2026-03-09)

- [x] **Notification dot accuracy** — Only shows when session actually needs user input (`b244a8b`, 2026-03-07)
- [x] **TypeScript build fix** — Removed unused `DISMISSED_TTL_MS` constant (`5533ceb`, 2026-03-06)
- [x] **Speech-recognizer permission cleanup** — Removed nonexistent `allow-register-listener`, fixed `scrollToRow` stale index crash (`c341cd5`, `350513c`, 2026-03-09)

## Auto-Scroll Fix (2026-03-31)

- [x] **CD-023: Auto-scroll chat on new incoming messages** — Added `useEffect` watching `display.length` to trigger `safeScrollToEnd()` directly, bypassing unreliable ResizeObserver on mobile WebView (`ea3af0d`, 2026-03-31)

## Completed (2026-03-31)

- [x] **CD-020: Set up Nostr relay for Codedeck on Cloudflare** — Deployed dedicated Nostr relay on Cloudflare for Codedeck bridge traffic (2026-03-31)
- [x] **CD-025: Add build mode effort functionality** — Added build mode effort setting/control in the Codedeck UI (2026-03-31)

## Pairing Improvements (2026-04-02)

- [x] **CD-027: Apply blossom + relay config from pairing deep link** — Deep link handler now merges pairing relays into DM relay list and applies Blossom server URL in a single atomic config update (`30682c3`, 2026-04-02)

## DM Swipe Navigation (2026-04-07)

- [x] **CD-028: Swipe left/right to navigate between DM conversations** — Reuses existing `useSwipeToNavigate` hook for DM panel mode, cycling through conversations sorted by most recent message (`a0fecb9`, 2026-04-07)

## TODO Cleanup (2026-04-07)

- [x] **CD-018: Increase DM row height in sidebar** — Direct message rows in the left column height increased for better readability (2026-04-07)
- [x] **CD-024: Fix excess "1111111" in terminal tool approval** — Fixed excess `1111111` characters in the tool approval UI (2026-04-07)
