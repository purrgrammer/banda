# Substrate conformance and upstream work

Check pi-env, pi-durable and chord before adding local mechanisms. Preserve exact lockstep versions. Reproduce
upstream failures with a small conformance case, retain necessary local safeguards and remove them only once a
verified upstream version makes them redundant.

## Acceptance

Watch-event loss must not silently strand accepted-definition changes. A cancelled command kills its process group
and cannot leave authoritative workflow work running outside its task. Verify sanitizer behavior and skip/window
semantics with recorded conformance cases before changing wrappers or claiming support. A skipped case is not proof.

Follow [Delivery](delivery.md), [Verification](verification.md) and [Status](status.md).

## Open work

Recheck these items against current code before implementation; an unchecked item is not a freshly verified
defect. Remove it only when its fix and acceptance evidence are recorded in a commit.

- [ ] chord's output sanitizer drops a lone `\r`, so a progress bar's frames run together in a bash step
- [ ] Upstream: chord's sanitizer should drop whole escape sequences, making `src/box/ansi.ts` redundant
- [ ] Upstream: pi-env's windowed exec can come up short on its skip count under load (box.test skips that conformance case; banda runs no command with a window)
- [ ] Upstream: pi-durable's `pi.compaction` entry should carry `tokensBefore` and the summary's usage (pi-coding-agent's does); `pi.usage` folds summary spend into the model's bucket, so a compaction's cost cannot be shown. Until then, tokens before derive from the last turn's usage and cost goes unshown
- [ ] Upstream: pi-durable needs a per-conversation default summary prompt in settings; threshold compactions take no instructions and use the coding-agent prompt (files, functions). A `beforeCompact` summary would bypass its durable summarize-and-retry, so it is no substitute. Until then every compaction uses the coding prompt, so this blocks the agent's summary
- [ ] Upstream: pi-durable's `selectCut` counts the system entries it writes again after each compaction as summarizable, so a chat whose kept context sits near the threshold compacts on every turn (40 of 40 in `test/compaction.test.ts`). banda's `beforeCompact` declines a threshold compaction that would summarize less than the background band of what was said; the guard belongs in pi-durable
- [ ] The faux provider counts the uncached part of a prompt twice (`input` and `cacheWrite`), so the first answer after a compaction looks larger than it was and can bring a second one; real providers report `input` without cache writes
- [ ] pi-env's watch on macOS drops file events under load: raise it upstream (a box change to an agent file or memory may show in the app only at the next push)
