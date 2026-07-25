# CodeDeck 2026.07.25

## Claude Opus 5

- **Opus 5 is now in the model picker — and is the new default** for sessions you start from the phone. Pick it when you create a session, or switch mid-session as usual.
- Needs **Codedeck Bridge 2026.7.25** (or newer) on your laptop — the bridge ships the Claude Code build that knows the model.

## Start sessions without the wait

- **Tapping Start Session is instant.** The new session appears in the list right away and fills in when the laptop confirms — no more staring at a blocking "Starting…" dialog for ~17 seconds. If the bridge never answers, the row turns into a Retry banner instead of hanging.
- **You can type your first message immediately** — it's buffered and sent as soon as the session is live, and it becomes the session title.
- **Mode, effort and model changes show a pending pulse** while the laptop confirms, and roll back on their own if the change doesn't land.

## Knowing what needs you

- **One clear attention dot.** Sessions waiting on a plan approval, a permission, or a question now show a bold, always-visible dot in the session list — including the session you're currently looking at. (It respects reduce-motion.)
- **Context usage in the header.** The model badge now carries a live context-window percentage, read straight from the same meter the Claude Code terminal shows, so it no longer jumps around at the start of a session.
- **Usage chip with reset countdowns.** The 5-hour and weekly subscription rows each show how long until they reset, ticking once a minute.
- **A `/compact` button** in the session header to summarize history without typing the command.

## Fixes

- **Typed answers to multi-question prompts no longer wedge the session.** Answering an AskUserQuestion group by typing (rather than tapping) used to deliver only the first answer and leave the session stuck on "Waiting for your answer".
- **Swiping between sessions now slides only the conversation.** The input box and buttons stay put instead of sliding along with it.
- **Microphone dictation is reliable.** The first-ever permission grant no longer fails, and speech errors surface inline instead of failing silently.
- **Mobile polish:** overflow menu for the session header, aligned usage badge, a bigger SEND button, and no accidental pinch-zoom.
