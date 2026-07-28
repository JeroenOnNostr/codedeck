# CodeDeck 2026.07.29

Follows yesterday's release, which introduced the GSD stage strip. This one makes it usable
from a phone rather than just readable.

## Start GSD on a project that doesn't have it yet

Previously the strip only appeared for projects already running GSD — there was no way to
bootstrap one from your phone.

- The **⋯ menu** now offers **"Enable GSD for this session"**, which reveals **Start GSD** and
  **Map codebase** buttons.
- It's **per session, opt-in**: projects that already use GSD still show the strip on their own,
  and the sessions that will never use GSD stay exactly as they were.
- The choice sticks across restarts.

## The strip tells you what's happening while a phase runs

Previously it froze. During `/gsd-execute-phase` the phase counters don't move — GSD batches its
state writes until a whole wave of parallel plans finishes — so a fifteen-minute run showed the
same stale line throughout.

- **Live task progress**: `Phase 2 · plan 1/2 · task 2/3 · add payment session`, moving as each
  task lands.
- **"Waiting on you"** when a checkpoint or question blocks the run, so a stalled phase is
  obvious rather than looking idle.
- The action button **hides itself** while a phase is running or blocked — tapping "Execute
  phase 2" *during* phase 2 would have run it twice.

## Getting unstuck

Paused work, blockers and failed verifications now appear as buttons that run the command to
resolve them (`/gsd-resume-work`, `/gsd-debug`, `/gsd-verify-work`) instead of being buried in
a status word.

## Know the cost before you tap

Phase rows read **"Ready to execute · 2 plans · 1 needs you"**. Knowing a phase will stop and
ask you something is the difference between starting it on the bus and waiting until you're at
a desk.

**Requirements:** **Codedeck Bridge 2026.7.29** or newer on your laptop, plus GSD installed
there. Non-GSD sessions and older bridges are unaffected — the strip simply doesn't appear.
