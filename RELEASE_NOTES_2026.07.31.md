# CodeDeck 2026.07.31 — starting a GSD project from the phone actually works

`versionCode 20260731` · needs bridge **protocol v8** (`2026.7.30`, already shipped — **no bridge
upgrade required for anything below**).

## The problem

The last three releases built a GSD stage strip, a start button, a per-session cwd and a folder
field — and it was still not possible to start a GSD project from the phone. The route existed but
nothing pointed at it: *Project folder* never mentioned GSD, the "create it if it doesn't exist"
checkbox never mentioned GSD, the opt-in was an item in an overflow menu, and the button at the end
of that trail was **disabled at the workspace root** with no disabled styling — so it looked live
and swallowed every tap without a word.

## Start a new GSD project

New Session now opens with a named entry point:

> ☑ **Start a new GSD project**
> Guided plan-driven workflow: GSD interviews you, writes a roadmap, then plans and executes it
> phase by phase — and the stage strip drives it from here.

Give it a project name and tap **Start GSD Project**. One tap then does the five things that
previously had to be assembled by hand:

1. creates `<workspace>/<name>` and `git init`s it (GSD needs a repo, and giving it one of its own
   is what keeps it out of the sibling projects),
2. roots the session there,
3. takes the session **out of plan mode** — GSD's workflows write, and in plan mode Claude Code
   plans them instead of running them,
4. sends `/gsd-new-project`,
5. shows the stage strip immediately, so it is there *for* the interview rather than after it.

The command is held until the mode change is confirmed. Sent together, the first turn can run in
the wrong mode, which looks exactly like the button doing nothing.

**Run hands-free** (on by default) auto-approves tools. GSD runs its own CLI, git and sub-agents
constantly; approving each from a phone would stall the interview. You still answer every question
it asks, and the header switches modes in one tap.

## The strip stops lying

- **Disabled buttons look disabled.** `.gsd-bar-action:disabled` had no styling at all — the single
  line that made "Start GSD does nothing" possible.
- **A non-repo directory is not a disabled button, it's the wrong directory.** The workspace root now
  reads *"GSD needs its own folder — this one isn't a git repo"* and offers **New GSD project**,
  which opens the flow above. It still never offers to `git init` there.
- **Mid-turn it reports, it doesn't pretend.** *"Setting GSD up…"* while a turn is in flight,
  *"GSD is waiting on you"* when it is blocked — instead of buttons that ignore taps.
- **The buttons say what they do.** *Map codebase* → **Map existing code** ("Analyse the existing
  code into `.planning/codebase/`"); *Start GSD* → **Start GSD here** ("Interview → requirements →
  roadmap").
- **No accidental restarts.** GSD writes nothing to `.planning/` until its interview is well under
  way, so the project keeps reporting "not set up" throughout. The primary now reads **Restart GSD
  setup** once setup has been sent — the old label read as *continue* and would have thrown a
  half-finished interview away.
- **The strip appears on a session that is already busy.** It used to poll only when the session was
  idle, so a session running from its first second — which "New GSD project" always is — rendered
  nothing until it stopped.

Also in the ⋯ menu: **New GSD project…**, reachable from any session, so starting one never depends
on standing in the right directory first.

## Verified

Driven end to end on a Pixel 9 Pro Fold against the live bridge: folder created and `git init`ed,
session rooted, mode switched, `/gsd-new-project` sent, ~10 question groups answered by tapping,
`.planning/` written and committed, and the strip flipped itself to `v1.0 · Plan first phase · 0%`
with **Discuss the first phase** as a tappable chip. Full results:
`docs/CD-058-GSD-DEVICE-VERIFY-RESULTS.md`.

126 phone tests, 186 bridge tests, `tsc` clean on both.

## Companion bridge `2026.7.31` (optional)

Not required for anything above. It fixes **CDB-034**: the bridge appends a metadata request to a
session's first message, and Claude Code treats everything after a slash command's name as that
command's arguments — so `/gsd-execute-phase 2` was arriving as phase
`"2\n\n<!-- emit-session-meta: … -->"`. Slash commands are now left byte-identical, and the metadata
is asked for on the first ordinary message instead. Installing it needs a VSCode window reload.
