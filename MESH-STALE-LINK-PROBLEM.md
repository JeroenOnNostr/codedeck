# Problem brief: CodeDeck mesh link goes stale after the phone backgrounds

**Status:** RESOLVED 2026-06-19 (CD-035). Fix landed in the contribute-back `nostr-vpn` dep on
branch `fix/bootstrap-transit-auto-reconnect` (commit 04fd59c, not yet pushed — upstream is
`mmalmi/nostr-vpn`). The hypothesis below ("CodeDeck-side reconnect on foreground") turned out to be
the WRONG layer: on mobile `connect_vpn()` only refreshes UI state and `update_peers()` diffs rather
than re-dialing. Real root cause + fix: configured bootstrap/transit peers had `auto_reconnect=false`,
so fips-core's `schedule_reconnect()` early-returns on MMP dead-timeout and never re-dials the
relay-bootstrapped path. Fix = enable `auto_reconnect` for the (small, trusted) bootstrap set on BOTH
mobile and desktop, keeping it off for ambient learned peers. Verified on-device: a 2-hour-stale
laptop↔Pixel 9 link recovered within seconds of the patched daemon (relayed→direct UDP) and a 12.7MB
adb install over the mesh completed. The Tick-based `mesh_refresh` scaffolding stays removed (the fix
is engine-side). Details: codedeck/DONE.md CD-035. Original diagnosis kept below for history.

---


**Scope:** CodeDeck phone app (`codedeck/`) + its embedded mesh engine (`../nostr-vpn`, a contribute-back dependency — **never fork**). Does NOT affect the one-QR onboarding feature (that's done + released).

## Symptom
A phone designated as a **test target** joins the mesh fine and is reachable from the laptop over adb-over-mesh (`adb connect 10.44.x.y:<port>` works, verified). But after the CodeDeck app **backgrounds / the screen sleeps for a while**, the laptop↔phone mesh link goes **stale and never recovers on its own**:

```
nvpn status →  ✗ d0b28c30… 10.44.92.113/32 pending  endpoint:fips transport:None  "fips participant stale"  (last=4000s+ and climbing)
```

The phone's `tun0` stays UP (data plane survives via the foreground VpnService), but the **FIPS control link is dead**, so the laptop can no longer reach the phone — breaking autonomous on-device testing (e.g. a 12MB `adb install` over the mesh hangs forever).

## Root cause
In the engine: `nostr-vpn/crates/nostr-vpn-app-core/src/mobile_tunnel/endpoint_control.rs:11-12`
```rust
const FIPS_ROSTER_AUTO_RECONNECT: bool = true;
const FIPS_TRANSIT_AUTO_RECONNECT: bool = false;   // ← the problem
```
The laptop↔phone link bootstraps via a **FIPS transit (relay-bootstrapped) link** (both peers behind NAT; even when a direct UDP path is later negotiated on the same LAN, the control link that bootstraps it is transit). **Transit links do not auto-reconnect.** When the phone backgrounds and the transit link drops, nothing re-establishes it.

## What does NOT fix it (already tried, on-device, 2026-06-19)
- Calling the engine's `Tick`/`refresh` action on foreground (this was the `mesh_refresh` plugin command + `App.tsx` visibility-handler call — see "scaffolding to reuse or remove" below). The peer stayed stale through a phone HOME→relaunch cycle.
- Laptop `nvpn reload`.
- Foregrounding the app (`tun0` is already up; the dead part is the control link).

## What SHOULD fix it (hypothesis — verify on-device)
A full mesh **reconnect cycle** rebuilds transit links: engine `DisconnectVpn` then `ConnectVpn` (the same actions the MeshSection "Disconnect"/"Connect" buttons drive via `mesh_action`). Likely correct fix: on app **foreground**, if this device is a test target with a stale/unreachable mesh link, perform a leave→join cycle (debounced; don't thrash). Consider doing it only when `mesh_status` shows the link isn't healthy, to avoid a needless VPN re-setup on every foreground.

Open design question worth weighing: should the fix live in CodeDeck (force reconnect on foreground) OR in the engine (enable `FIPS_TRANSIT_AUTO_RECONNECT` on mobile / add a mobile keepalive for transit links)? The engine is a contribute-back dep — an engine fix may be the more correct, upstreamable answer, but a CodeDeck-side reconnect-on-foreground is self-contained and ships without an engine release. Evaluate both.

## How to reproduce + verify a fix (on-device)
- Test target: Pixel 9 (mesh IP currently `10.44.92.113`, mesh pubkey `d0b28c30b01e12a1a9cbef4bb578418a61fd4c51f16dfb5bed941cd48e7f9038`). Laptop mesh `10.44.247.175`, daemon `nvpn` (pid varies), network `a237c978`.
- Laptop adb: `$HOME/Android/Sdk/platform-tools/adb`. Pixel 9 LAN-adb `192.168.2.10:37975`. Both on wifi `192.168.2.x`.
- Repro: bring CodeDeck to foreground + mesh up (`nvpn status` shows the peer `✓ reachable`), then HOME the app / let the screen sleep several minutes → `nvpn status` shows the peer `✗ ... fips participant stale`.
- Verify fix: after the stale state, foreground CodeDeck → within ~10-20s `nvpn status` should show the peer `✓ reachable` again, and `adb connect 10.44.92.113:<port>` + `adb -s ... shell true` should work. Gold standard: a full `adb install` of a ~12MB APK (e.g. `kubo/android/app/build/outputs/apk/debug/app-debug.apk`) over the mesh completes after a background→foreground cycle.
- Release WebView has no devtools; build a DEBUG APK for WebView CDP if you need to see JS console. Add a native log line in the plugin if you need to confirm the reconnect path fires.

## Scaffolding already in place (decide: reuse or remove)
The insufficient Tick-based attempt was wired but is being **removed** before the 2026.6.18 release so it doesn't ship half-done. If you want to build on it instead, it was:
- Plugin command `mesh_refresh` (→ Kotlin `meshRefresh` → `AppCoreClient.refresh()` = engine `Tick`): `codedeck/tauri-plugin-mesh/src/{commands,mobile,desktop,lib}.rs`, `permissions/`, `android/.../MeshPlugin.kt`.
- `codedeck/src/services/meshClient.ts` `refreshMesh()` + call in `codedeck/src/App.tsx` visibility handler (foreground branch).
A reconnect-based fix would reuse this exact plumbing but make the command (or a new `mesh_reconnect`) dispatch `DisconnectVpn`+`ConnectVpn` instead of `Tick`, and gate it on a stale-link check.
