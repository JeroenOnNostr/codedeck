# CodeDeck 2026.6.18

## One-QR setup for multi-device mesh testing

Setting up a phone — and a second phone as a remote test device — used to be three separate, fiddly steps (pair, paste a mesh invite, type a mesh IP). Now it's **one QR scan**.

- **Scan the bridge's Pair QR once.** The phone auto-pairs *and* auto-joins your private mesh from the same code — no invite to copy/paste.
- **One question:** the phone asks whether it's your **controller** or a **test device**. That's the only choice you make.
- **Pick "test device"** and it just works: Wireless Debugging turns on, the device joins the mesh, and it registers itself with the bridge automatically — **no mesh IP or serial to type**. The laptop can then install & drive dev builds on it over the mesh.
- **Controllers stay private:** a phone you set as a controller never joins the mesh, so a shoulder-surfed QR can't grant mesh access.

Under the hood: the Pair QR now bundles a fresh mesh invite; the bridge auto-whitelists a paired phone on your private relay (so pairing can use an open relay while high-frequency session traffic stays on your private one); and the phone reports its real mesh identity so the bridge can reach it with zero manual config.

## Known issue
A test device's mesh link can go stale if the CodeDeck app is backgrounded for a long time, which can interrupt a large install-over-mesh until you re-open the app. A fix for automatic reconnection is in progress.
