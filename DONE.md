# Done — Codedeck

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
