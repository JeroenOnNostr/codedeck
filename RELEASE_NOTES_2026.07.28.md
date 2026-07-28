# CodeDeck 2026.07.28

## Drive a GSD workflow from your phone

If you run [GSD](https://github.com/open-gsd/gsd-core) on your laptop, CodeDeck now shows where
you are in it — and gets you to the next step in one tap.

- **A stage strip under the session header** reads `v1.0 — MVP · Phase 2/3 · Executing · 50%`,
  with a progress meter. No more scrolling back to work out which phase you're on.
- **The next command is a button.** The chip on the right sends the command GSD recommends —
  `/gsd-execute-phase 2`, `/gsd-plan-phase 3` — instead of you typing it on a touch keyboard.
- **Tap the strip for the whole roadmap.** A sheet lists every phase with GSD's own
  Discuss/Plan/Execute marks, so `✓ ✓ ○` reads as "discussed, planned, not yet executed" exactly
  as it does in `/gsd-manager` on the desktop. Any phase with a next step is tappable too.
- **"Verification required" stays visible.** A phase whose plans are all written but not yet
  verified is called out rather than being lumped in with "complete".

A tapped command behaves exactly like typing it: it appears in the conversation and runs there,
so nothing happens invisibly.

**Requirements:** **Codedeck Bridge 2026.7.28** or newer on your laptop, plus GSD installed there.
Sessions that aren't GSD projects — and older bridges — look exactly as they did before: the strip
simply doesn't appear.
