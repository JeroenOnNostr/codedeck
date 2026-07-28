# CodeDeck 2026.07.30

The last two releases put a GSD stage strip on your phone and gave it a Start button. This one
makes it actually usable: you can now **start a new GSD project from your phone**, and the strip
stops telling you things that aren't true.

## Start a new project from your phone

Until now every CodeDeck session opened in the same place — your VSCode workspace root. If that
root is a folder holding many separate projects, GSD had nothing real to look at, so the strip
could only ever offer to initialise the whole workspace as one giant project. There was no way to
point a session at a single repo, and no way at all to begin a new one.

- **New Session** gains a **Project folder** field. Leave it blank for the workspace root
  (exactly as before), or name a subdirectory to root the session in that one project.
- Tick **"Create it if it doesn't exist"** and the laptop creates the folder and initialises a
  git repo in it — so you can go from nothing to a new GSD project without touching the laptop.
- The folder is confined to your workspace root. A path trying to escape it is refused and the
  session opens at the root instead.

## Start GSD no longer offers to do something destructive

`Start GSD` runs GSD's project initialisation, which runs `git init` when the directory isn't
already a repo. Offered at a folder full of sibling repositories, that meant creating a repository
on top of all of them.

- The button is now **disabled outside a git repository**, and the strip says
  **"GSD needs a git repository"** instead of pretending it's ready.

## The strip stops claiming you're finished

On a five-phase project with one phase done, the strip read **"Phase 1 of 1 · 100%"** — it counted
only the phases that had been planned, so finishing the first one looked like finishing everything.

- It now reads the real phase count from your roadmap: **"Phase 1 of 5 · 20%"**.

## Taps while the session is busy aren't silently swallowed

Tapping a strip button mid-turn used to post the command into the conversation and then quietly
drop it — it looked sent, and nothing happened.

- Strip buttons are now disabled while a turn is running or waiting on you, with the reason in the
  tooltip, instead of accepting a tap that goes nowhere.

## Requires

The companion **Codedeck Bridge** VSCode extension at **protocol v8** (2026.7.30). On an older
bridge the Project folder field is hidden rather than shown-but-ignored, so nothing silently
misbehaves — you just don't get the new capability until the extension is updated.
