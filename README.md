# PR #102 (#33, conditional watch reads): live run evidence

A real banda daemon from the PR's head `f0f64de` (`startDaemon`, the built web app, host box, faux model) on a
throwaway home and an OS-assigned port. GitHub was the repo's fake MCP server (`test/fixtures/github-objects.ts`) on
loopback: no real GitHub and no writes anywhere. The watch was followed through the app (panel, Routines, Add, Follow)
and then looked on its own clock. The run's copy of the shipped definition looks at the pull request every 2 minutes
instead of 5, so it fits a session. The reads, their `unless`, the rules and all daemon code are as in the PR.

Reproduce: `npm ci && npm run build:web`, then from the worktree `node live-run.ts "$PWD" <outdir>` (Chrome required).

`evidence.jsonl` is the run's log. Each `look` lists the reads the fake GitHub served for that look, and each PASS/FAIL
states what was checked. Result: PASS, 11 looks and 31 reads (44 had every look read everything).

| look | world | reads |
|---|---|---|
| baseline | checks done, approved by ana | all 4 |
| confirm | unchanged | all 4 (the baseline's answers were not yet sure) |
| quiet | unchanged | `get` only; the rest carried |
| label | a label starts a `deploy` check on the same head; `updated_at` moves | all 4 |
| completion | `deploy` fails; `updated_at` and head unchanged | checks read (a check was running) |
| wake | unchanged | `get`, checks ("done" had just come true); woke: deploy failed, checks finished |
| quiet ×2 | unchanged | `get`, checks (wake look was inside the sure minute), then `get` only |
| reviews-fail | carol approves (`updated_at` moves); GitHub refuses `get_reviews` once | reviews failed; no change |
| recover | GitHub answers again | reviews read again (a failed read is never "made"); carol approved woke |

Screenshots show what the app drew at those points. They are not proof of the backend; the read log is.
