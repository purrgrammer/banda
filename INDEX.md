# Harness session UI — screenshots for PR #13

Screenshots of the real app (built `web/dist`, served by a real daemon on a throwaway home), with real harness
sessions run by a scripted ACP agent through `BANDA_HARNESSES`. Every image shows **light and dark side by side**;
`-desktop-` frames are 1280×800, `-phone-` frames 390×844.

- `before/`: `main` at c0df7b6, same method.
- `after/`: the PR branch.

## before/ (main)

| File | What it shows |
|---|---|
| `card-working-*` | The card while it works: raw `cd /var/folders/… &&` command, full folder path and session id on the card, an always-open "Tell Goose…" field, "Open" |
| `card-waiting-1-ask-*` | One ask |
| `card-waiting-3-asks-*` | Three asks stacked, all approvable at once |
| `sheet-steps-*` | The steps panel: every step expanded, raw |

## after/ (this PR)

| File | What it shows |
|---|---|
| `card-working-*` | Working: the step in the owner's words ("Running tests"), project name only, Stop, "Add a note", state in words with the clock |
| `card-waiting-1-ask-*` | Waiting on you: the ask whole, "Run / Don't run" |
| `card-waiting-3-asks-*` | Three asks: the oldest whole, "2 more waiting · change a file · open a web page", no approve-all |
| `ask-long-diff-folded-*` | A long diff in a bounded window with "Show all" |
| `ask-long-diff-show-all-*` | "Show all": the whole diff in a sheet before deciding |
| `sheet-steps-*` | The steps sheet: one line per step, folded, session id and full path in the sheet's detail |
| `sheet-following-*` | The sheet following the end while the session streams |
| `sheet-jump-to-latest-*` | Scrolled up: the sheet stays put and offers "Jump to latest" |
| `card-done-*` | Done: outcome line, files changed, "Took 0:03" |
| `card-failed-*` | Failed, with the reason in words |
| `card-stopped-*` | Stopped by the owner: "You stopped it" |
| `card-interrupted-*` | Interrupted when banda restarted; nothing was sent again |
