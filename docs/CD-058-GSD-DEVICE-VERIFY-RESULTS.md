# GSD from the phone — device verification results

**Date:** 2026-07-28 · **Device:** Pixel 9 Pro Fold `48101FDKD000MW` (USB) · **Phone build:**
CodeDeck `2026.7.31` (versionCode `20260731`, release cert `c5d0cba4…fbc5`, in-place upgrade —
pairing and Nostr identity preserved) · **Laptop:** bridge `2026.7.30` (protocol v8), GSD Core
`1.8.0` installed flat at `~/.claude/commands/gsd-*.md`.

Everything below was driven on the real device over the live Nostr bridge. The phone-side changes
need **no bridge upgrade** — they were verified against the bridge the user already has running.

---

## The reported bug, reproduced first

> *"in existing sessions the header contains an option to 'enable GSD for this session' which
> displays 2 buttons, 'map codebase' idk whats that for. and 'start GSD' which does nothing."*

Reproduced exactly on `2026.7.30` before changing anything. A session at the workspace root showed:

```
GSD needs a git repository            [ Map codebase ]  [ Start GSD ]
```

`Start GSD` **was disabled** — `hasGit === false`, because
`/home/jeroen/VScode workspace for building nostr apps` is not a git repo (verified:
`git rev-parse` fails there, and `gsd-tools smart-entry --json` reports `has_git: false`). But
`.gsd-bar-action` had **no `:disabled` rule**, so the disabled button was pixel-identical to a live
one — and it carried the `--primary` border, making it look *more* clickable than the enabled
"Map codebase" beside it. Every tap was swallowed in silence. The reason was in a `title` tooltip,
which a phone never shows.

So "does nothing" was literal and by design: CD-056 had disabled the button to stop GSD running
`git init` over 27 sibling repos, and nothing said so.

## What was verified after the fix

| # | Check | Result |
|---|---|---|
| 1 | New Session shows **"Start a new GSD project"** as the first control, with a plain-English explanation | ✅ |
| 2 | Ticking it swaps the form to **Project name** + **Run hands-free**, and the hint names the folder live | ✅ |
| 3 | `Start GSD Project` creates `<workspace>/gsd-phone-demo` and `git init`s it | ✅ verified on disk |
| 4 | The session is rooted there — header reads `gsd-phone-demo`, not `Workspace` | ✅ |
| 5 | The session leaves plan mode **before** the command lands — InputBar reads `YOLO (default)` | ✅ |
| 6 | `/gsd-new-project` is sent automatically and renders in the stream | ✅ |
| 7 | The stage strip is visible from the first second, without touching the ⋯ menu | ✅ |
| 8 | GSD's interview runs and its questions arrive as tappable cards (single- and multi-select) | ✅ answered ~10 groups from the phone |
| 9 | While GSD is blocked the strip reads **"GSD is waiting on you"** and renders **no** buttons | ✅ |
| 10 | GSD writes `.planning/` (`PROJECT.md`, `config.json`, `research/`) — committed `f05e34a` | ✅ |
| 11 | The strip then flips itself to the real readout: `▸ v1.0 · Plan first phase · 0%` + meter | ✅ |
| 12 | …with GSD's own next step as a tappable chip: **"Discuss the first phase"** | ✅ |
| 13 | A session at the workspace root now reads **"GSD needs its own folder — this one isn't a git repo"** with a live **New GSD project** button | ✅ the exact screen from the bug report |

Wall-clock from tapping `Start GSD Project` to `.planning/` existing: ~12 minutes, all of it GSD's
own interview and research. No step required the laptop.

## Not exercised — still owed

These are the parts of the older run-sheets this run did **not** reach. They need a project that has
a roadmap and at least one executed phase; `gsd-phone-demo` stopped at "plan your first phase".

- **Live execution line** (CD-053 / CDB-032) — the `Phase 2 · plan 1/2 · task 2/3 · <desc>` readout
  reconstructed from GSD's atomic task commits. No phase was executed, so it never rendered.
- **Recovery chips** (CD-053) — `Resume` / `Re-verify` / `Blocked`. No paused, verify-failed or
  blocked state occurred.
- **Real phase count** (CD-054) — the `Phase 1/5 · 20%` scaling that distinguishes roadmap phases
  from `.planning/phases/` directories. Needs a ROADMAP with more phases than have been planned;
  this project has no ROADMAP.md yet.

To finish these, drive `gsd-testbed` (which has a 5-phase roadmap) rather than a fresh project:
open a session with **Project folder** = `gsd-testbed` and read the strip.

## Byproduct

`<workspace>/gsd-phone-demo/` is a real half-initialised GSD project created by this run. Its
interview answers are arbitrary (chosen by the verifying agent, not the founder) — it exists only as
evidence. Safe to delete; nothing references it.
