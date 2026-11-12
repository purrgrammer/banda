# #102 × #100: combined integration check (tail reads with conditional reads)

Heads: #102 `776750e` (fix/issue-33-conditional-reads) merged with #100 `a6e179d` (fix/issue-34-watch-pagination), in a
throwaway worktree. Nothing was committed to either PR or to main.

## The order that must hold in the combined `look()` loop

1. **Reuse check.** May the kept answer be carried (`mayCarry`)? If yes, carry it and `continue`.
2. **The complete tail read**, with its failure, `behind` and size checks.
3. **Record `made`** (`madeNow`) right after `answers[as] = list;`. Never before the read, never on a refused read, never
   on a `behind` read.

## Reproduce

```sh
git worktree add --detach ../int origin/fix/issue-33-conditional-reads && cd ../int
git merge --no-commit --no-ff origin/fix/issue-34-watch-pagination   # 4 conflicts
python3 resolve-102-100.py                                         # keeps both sides, the order above
cp watch-tail-conditional.test.ts test/
npm ci && cp src/core/watches.ts correct-watches.ts && bash run-integration.sh
```

`integration-776750e+a6e179d.diff` is the resulting tree against #102's head (15 files).

## Results

| merged `look()` | result (log) |
|---|---|
| order above | 13 files, 245 tests pass (`combined-suites.log`) |
| `made` recorded on a `behind` tail read (`mutation-made-on-behind.diff`) | 1 fails: the burst test (`mutation-made-on-behind.log`) |
| `made` recorded before the tail read | 2 fail: the burst test and #102's "refused at two looks running" |
| `made` not recorded in the tail branch | 9 fail: reviews and comments are never carried |

`watch-tail-conditional.test.ts` has two tests. GitHub is #100's fake, its pull request's `updated_at` set by step. Looks
are the watch's own, not Check now.

1. **A thousand reviews, `updated_at` never moving.** Pages asked per look:
   `[1,2,3] [3,4,5] [5,6,7] [7,8,9] [9,10,11] [] [] []`. Every look catches up three pages until the end, and only then
   carries. This test alone does not catch "made on behind": a list never read whole has no kept answer to carry.
2. **Reused reviews, then a burst past a look's pages.** 150 reviews, read whole and carried; 700 more arrive and
   `updated_at` moves once, then stays.
   - Correct order: `[1,2] [1,2] [] [1,2,3] [3,4,5] [5,6,7] [7,8,9] [] []`, and the new reviews wake.
   - Made on `behind`: `... [1,2,3] [3,4,5] [] [] [] []`. The old 150 are carried and the catch-up stalls for up to the
     read's period (2h).

## Limits

- **Unit scenarios only:** run through the watch scenario harness with a fake GitHub; no daemon, browser or real GitHub.
- **Not run in CI:** this tree is not a branch.
- **#100's browser test not run:** `watch-tail.browser.test.ts` was not run in this tree.
