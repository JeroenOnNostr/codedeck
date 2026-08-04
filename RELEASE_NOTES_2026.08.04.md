# CodeDeck 2026.8.4

Pair a phone that has no camera, and two settings sections gone.

Needs **Codedeck Bridge `2026.8.4`** for the new pairing path
([release](https://github.com/JeroenOnNostr/codedeck-bridge-vscode/releases/tag/v2026.8.4)).
Protocol **v9**, unchanged — older bridges keep working, they just don't offer the copy button.

## Pair a phone that has no camera

**CD-061** — the bridge hands out one `codedeck://pair?...` URL, and until now the app only ever
consumed it through the OS deep-link handler. That means **only by scanning**: there is no barcode
dependency and no CAMERA permission in the app, so scanning is delegated entirely to the phone's
camera app. A phone whose camera doesn't work had no way in.

The manual field was not a substitute. It took a bridge npub and a machine name, and that path
*cannot pair* — a pair-request needs the one-time `token` that exists only in the URL. A hand-added
machine stayed one-way and permanently disconnected unless you also walked over to the desktop and
pasted the phone's npub into the bridge's own manual form.

So: **Settings → Remote Machines → Pairing link**. Paste the link, tap **Link machine**. In VSCode,
`Codedeck: Pair phone` now has a **Copy pairing link** button (bridge CDB-039) that copies the full
URL — mesh invite included — without ever rendering the secret on screen.

Scanning is unchanged. `handleDeepLink` was already a complete parser, just trapped in `App.tsx`
behind the deep-link event; it moved to `services/pairingLink.ts` and both entry points now run the
same code. The npub form is still there under *Advanced — add by npub*, now stating plainly why it
can't pair on its own. Pasting tolerates what a link survives on the way to a phone: prose
prefixes, wrapping newlines, glued-on sentence punctuation.

**Pairing failure is visible now.** A rejection was `console.warn`-only and an expired window
produced no ack at all — the bridge tears down the listening subscription when the window closes, so
there is nobody left to reject you. A stale link therefore looked exactly like a working one that
hadn't connected yet. Expired now shows *"Pairing link expired — generate a new one in VSCode."*,
and 20s of silence shows *"No response from {machine} — is the Pair phone tab still open in
VSCode?"*. The bridge's pairing window also went from 3 to 10 minutes, because a copied link has to
travel through a chat app before anyone can paste it.

## Two settings sections removed

**CD-062 — Voice Mode.** Never used, and not cheap to keep: a vendored speech-recognizer plugin, a
TTS plugin, and an Android **`RECORD_AUDIO` permission on an app that never listened**. Gone: the
settings section, the speaker toggle in the session header, the dictation mic buttons in the input
bar and the DM view, seven frontend modules, the whole plugin directory, both capability entries.
This APK **requests no microphone permission at all** — verified with `aapt dump permissions`, which
is worth stating because the first build of this release still carried it: the permission turned out
to be hardcoded in the generated Android manifest rather than merged in from the plugin, so deleting
the plugin did not remove it. Filed as **CD-065**, since that manifest sits in a gitignored
directory and the fix will not survive a `cargo tauri android init`.

**CD-063 — Authentication.** The Anthropic API key, GitHub PAT and GitHub username fields, never
used: remote sessions run Claude Code on the paired machine and authenticate there. Gone with them:
the Send Key / Update Key button and the "No API key" line (both read the key field and would have
been permanently dead), the key-test command, and — once its last caller went — **Stronghold**
encrypted storage entirely.

> **Behaviour change:** local (non-bridge) sessions now read `ANTHROPIC_API_KEY` from the
> environment instead of Stronghold. Remote sessions are unaffected. Existing installs keep an
> orphaned Stronghold vault and `salt.txt` on disk; nothing reads them, and a `config.json` from an
> older install still loads (covered by a regression test).

Together these close **CD-002** and deliver most of **CD-019**.

## Fixes

**CD-064** — scrolling back through old output would yank the viewport to the newest message. Three
separate faults: `autoScrollRef` was mirrored from state during render, so a `ResizeObserver` firing
in the same frame as a scroll event read a stale `true`; re-arming keyed on "is at bottom" alone,
which a row re-measured shorter makes true by shrinking `scrollHeight` while you are parked in old
output; and the scroll listener was attached in an effect with only stable deps while the list mounts
conditionally, so a session that started empty never got a listener and stayed latched on forever.
Touch and wheel now hold a guard for 200ms after events stop, so a fling is not fought by its own
momentum.

**CD-060** — the project folder picker was an `<input list=…>` datalist, which the WebView renders as
a floating popup: on the phone it painted over the "PROJECT FOLDER" label above it and only showed
what the typed prefix matched — a picker you had to already know the answer to use. It is a
`<select>` now, so the phone renders its own full-screen list with all folders visible before a key
is pressed, plus an explicit "Other" entry for typing a new folder name.

## Verification

`./dev.sh check` clean (TypeScript, Vite, Rust). 159 vitest tests across 10 files (+13 for the
pairing-link parser, +the scroll-decision tests) and 53 Rust tests.

arm64-v8a only, as always. versionCode `20260804`.

Everything user-visible here is marked **device-verify owed** in `TODO.md`, each with a
self-contained run-sheet: the pairing paste path and its failure toasts (CD-061), the absence of the
settings sections and of `RECORD_AUDIO` in the APK (CD-062/063), and the scroll behaviour (CD-064).
