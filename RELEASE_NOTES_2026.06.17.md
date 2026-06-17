# CodeDeck v2026.06.17 — Remote on-device app testing over an encrypted mesh

**DRAFT — for Jeroen's review before publishing (per the changelog-review rule).**

## Headline
CodeDeck now embeds the nostr-vpn FIPS mesh as its own Android VPN service, so your office laptop can
build, install, launch, and drive **dev builds of your apps on a physical test phone from anywhere** —
fully autonomously, through Claude Code "test sessions". The only thing you install on the phones is
CodeDeck.

## What's new
- **Embedded mesh (Mesh settings → "Mesh (remote testing)")** — import an `nvpn://invite` from the
  laptop, tap Connect, and the phone joins the encrypted overlay. Split-tunnel: only the mesh subnet
  is routed, so your normal traffic and CodeDeck's own relays are never captured.
- **"Use this device as a test target" toggle** — opt a phone in (off by default) to let the laptop
  reach it over adb for installing/driving dev builds. Shows a clear "Wireless Debugging is ON for
  remote testing" indicator while active.
- **Autonomous device-test sessions (Bridge)** — a "Device test session" builds your dev APK, installs
  it over the mesh, launches it, reads the UI + logcat, screenshots back to your phone, and iterates —
  app-agnostic (Kubo, Veil, custom).
- **Self-healing connection** — adb over the mesh auto-recovers from Wireless-Debugging timeouts and
  port rotation, with no taps on the phone.

## Security & privacy hardening (pre-release audit)
- Device-test sessions are hard-blocked from reading signing keystores / secret files (enforced, not
  advisory) + a workspace `.claudeignore`.
- logcat is scoped to the app under test and secret-redacted before it leaves the laptop.
- Device screenshots carry a NIP-40 2-day expiration so they self-expire off relays.
- Port-discovery is restricted to the mesh CIDR with a time budget (no scanning arbitrary hosts).
- VPN routes are hard-capped to the mesh subnet (never an exit node).

## Notes
- Distributed via **Zapstore / direct APK** (the mesh + adb-enabler use a privileged permission that
  isn't permitted on Google Play). Pairs with **Codedeck Bridge v2026.6.171**.
- Enabling adb on a test target is a one-time `pm grant WRITE_SECURE_SETTINGS` over USB; after that
  it's zero-touch.
