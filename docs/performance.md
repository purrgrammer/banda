# Resource bounds search and projections

Priority: **Medium**. Implementation status lives in [Status](status.md).

## Findings

Shell subscribers independently build broad projections; search catch-up visits chats inside a store transaction and uses synchronous SQLite. FTS optimization/VACUUM can block the event loop. JSON request bodies lack bounds, and box/proxy memory limits and per-chat budgets remain gaps.

Entry points: ../src/server/transcript.ts, ../src/core/search.ts, ../src/server/http.ts, ../src/core/routines.ts and ../src/box/container.ts.

## Work and exit criteria

- Bound JSON/upload/MCP/proxy response sizes, timeouts, concurrency, queue pressure and disk growth; set box/proxy
  memory and process limits. Surface budget exhaustion and disk/runtime failures without losing pending work.
- Share expensive shell projections per daemon without creating another authority; move long scans outside commit
  critical sections where the substrate permits a consistent snapshot. Measure synchronous FTS/VACUUM impact.
- Bound history through the substrate's compaction mechanism while preserving accepted state, provenance and pending
  work. Verify cache-prefix stability; defer speculative cache warming until measured demand warrants it.
- Narrow area dependencies around admission, workspace mutation and projections as touched. Keep protocol adapters
  at explicit boundaries; avoid a whole-core rewrite or introducing an event bus to conceal broad dependencies.
- Exit: performance acceptance L1-L4 passes with resources and history representative of sustained personal use.

Performance acceptance L1-L4 is defined in [Verification](verification.md). See [Architecture](architecture.md) for
interface work; resource safety should be pulled forward when an earlier trust-boundary change needs it.

Follow [Delivery](delivery.md) and the relevant gates in [Verification](verification.md).

## Open work

Recheck these items against current code before implementation; an unchecked item is not a freshly verified
defect. Remove it only when its fix and acceptance evidence are recorded in a commit.

- [ ] Warm the prompt cache while the owner types: prepare the request when the composer gets focus
- [ ] Compaction eval: three agents' chats through three successive compactions keep names, dates, promises and open work (a journey eval); it settles the 50% share in `src/core/compaction.ts`
- [ ] A window under about ten times the prompt (banda's is 5–10k tokens; a 32–64k model) compacts every band of growth: raise its budget, or warn when the owner picks one
- [ ] Raw transcript, still missing: a stacked breakdown of the context (prefix, summary, kept messages, tool results), "what the model saw" at a checkpoint via `context({ at })`, cache writes held 1h, and a compaction's cost (upstream, Substrate)
- [ ] The context meter is read when entries come or a run ends, not live while a compaction runs
- [ ] Recall over a chat's own compacted history: `recall` searches memory only, so detail a summary dropped is lost to the agent though still in the store
- [ ] Follow-up: cache-aware summarizing (summarize as the next message of the chat's own cached request) would make compacting a warm chat cheap; raise upstream once the above is measured
- [ ] A container memory limit for the box (and the proxy)
- [ ] Bound protocol responses, queues, disk growth and projection/search work with accumulated history (performance.md)
- [ ] Request bodies are read whole by the HTTP server
