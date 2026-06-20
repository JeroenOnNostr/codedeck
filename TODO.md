# TODO — Codedeck

## Bugs

- [ ] **CD-001: processGiftWrap swallows exceptions silently** — `nostrService.ts:169` — NIP-17 gift-wrap decryption failures return `null` with minimal logging, making DM debugging hard. Added `console.warn` but could surface to UI.
- [ ] **CD-002: SettingsModal API key test has no timeout** — `SettingsModal.tsx:43-60` — `handleTestApiKey()` calls `api.testApiKey()` with no timeout mechanism. If the network hangs, the UI shows "Testing..." indefinitely.
- [ ] **CD-003: App.tsx deep link errors silently swallowed** — `App.tsx:74-79` — `getCurrent()` and `onOpenUrl()` promise rejections are caught with empty `.catch(() => {})`. If deep link init fails, pairing via QR code won't work with no feedback.

## Notifications (v0.6.5)

- [ ] **CD-004: Bridge relay must stay alive when backgrounded** — `App.tsx` disconnects all relays on `document.hidden`, so `onOutput` never fires when the app is backgrounded and notifications are dead. Fix: only disconnect DM relay on background, keep bridge relay connected.
- [ ] **CD-005: Create Android notification channel** — Android 8+ requires a notification channel or notifications silently fail. Call `createChannel()` in `notificationService.ts:initNotifications()`.
- [ ] **CD-006: Add notifications toggle in settings** — No way to disable notifications. Add a `notifications_enabled` flag to config and a toggle in `SettingsModal.tsx`.
- [ ] **CD-007: Detect session completion** — Currently only `permission_request`, `plan_approval`, and `ask_question` trigger notifications. Add detection for when a remote session finishes.
- [ ] **CD-036: Notification dot lit while session still running** — The sidebar unread dot persisted while the agent was actively working (stale-`idle` session-list `state` + nothing clearing the flag). Now `addOutput` clears the unread flag on any non-card, non-`stream_end` output (agent is working ⇒ not waiting on us); the dot only shows when blocked (permission/plan/question) or task done (`stream_end`). `sessionStore.ts` `addOutput`; tests in `__tests__/sessionStore.test.ts`.
- [ ] **CD-037: Audible ping never plays on mobile without OS-notification permission** — `notifyIfNeeded()` returned early on `!permissionGranted` before `playAttentionPing()`, so the in-app Web Audio ping was silenced on Android when the OS notification permission wasn't granted. Reordered so the ping plays independently of OS permission (still gated by the in-app Notifications toggle); OS notification alone requires permission. `notificationService.ts`; tests in `__tests__/notificationService.test.ts`. NOTE: backgrounded WebView suspends Web Audio — background alerts still rely on the OS notification sound (see CD-005 Android channel).

## Performance

- [ ] **CD-008: Reduce highlight.js bundle size** — `rehype-highlight` pulls all ~180 languages. Switch to `lowlight` with a curated subset (~12 languages) to cut ~80% of the highlight bundle.

## UX Improvements

- [ ] **CD-009: Session badge/counter for background activity** — When viewing one session, show a badge on other sessions in the sidebar that have received new output since last viewed.
- [ ] **CD-010: Better error surfacing** — Several silent failures (gift-wrap decryption, deep link init, API key timeout) should show toast notifications or inline error messages instead of logging to console.
- [ ] **CD-011: TodoWrite checklist rendering** — Render Claude's `TodoWrite` tool output as a proper checklist card in the output stream instead of raw tool_use content.
- [ ] **CD-012: Session pinning / archiving** — Pin active sessions to the top of the sidebar, archive old ones to reduce clutter.

## UX / Layout

- [ ] **CD-015: Option to move session column to right side** — Add a setting to move the left session sidebar to the right-hand side of the screen.
- [ ] **CD-016: Fix microphone button functionality** — Microphone button is not working correctly; investigate and fix speech input.
- [ ] **CD-017: Remove local sessions functionality** — Strip out local session support; Codedeck should only handle remote/bridge sessions.
- [ ] **CD-019: Clean up settings menu** — Audit SettingsModal for unused or obsolete options and remove them.

## Reviews & Fixes

- [ ] **CD-027: Work through consolidated reviews document** — See [REVIEWS_AND_FIXES.md](REVIEWS_AND_FIXES.md) for all findings from 4 independent audits (efficiency, security ×2, UX) — 25 efficiency issues, 32 security findings, 30 UX issues with prioritized fix plans.

## Future Improvements

- [ ] **CD-026: Most used prompts in UI** — Implement a "most used prompts" feature in the phone UI so users can quickly access and reuse their frequently sent prompts.

## Protocol

- [ ] **CD-013: Consider ephemeral event kind for real-time output** — Currently kind 4515 (regular/stored) is used for output events. A cleaner design: use an ephemeral kind (20000-29999) for the real-time stream so relays don't store it, and rely solely on the existing `history-request` pattern for catch-up. Trade-off: breaking change to both sides.
- [ ] **CD-021: Build remote signer support** — Implement NIP-46 remote signer (Nostr Connect) support so users don't need to paste private keys into Codedeck.
