# Architecture assessment and boundaries

Overall assessment: **7/10** for the reviewed architecture. The durable core and product model are coherent;
production confidence is limited by cross-process boundaries, concurrency and recovery. These are qualitative
review scores, not benchmark results or release gates. Reproduce findings against the implementation before fixing.

| Axis | Score | Main implication |
|---|---:|---|
| Architectural coherence | 9 | Preserve vocabulary, ownership and core primitives |
| State ownership and consistency | 8 | Resolve proxy/workspace ownership exceptions explicitly |
| Workflow durability | 8 | Extend daemon-crash proofs to independent component loss |
| Verification architecture | 9 | Preserve generated scenarios and SIGKILL boundary sweeps |
| Security and isolation | 5 | Align effective authority with actual shared execution domains |
| Privacy enforcement | 5 | Replace universal heuristic claims with enforceable secret boundaries |
| Modularity and maintainability | 7 | Narrow orchestration and area dependencies where changed |
| Extensibility | 7 | Verify protocol subsets and bind accepted tool authority |
| Performance and resource control | 6 | Bound work and measure accumulated-history behavior |
| Operations and recoverability | 4 | Prove complete restoration and packaged installation |
| Product and API architecture | 8 | Preserve derived views and shared API types; complete app acceptance |

## Preserve

One daemon owns the store. pi-durable owns workflow state. Accepted definitions bind the shown bytes. Common
admission checks and stores drafts/permissions/attempts transactionally. Unsafe uncertain effects ask the owner.
Consumer status views are derived. These mechanisms do not need a replacement architecture.

## Work

- `core` currently includes orchestration, storage, protocols and presentation-oriented descriptions. Inspect actual
  dependency direction before splitting modules; file size alone is not a defect.
- Narrow area dependencies around admission, workspace mutation and projections instead of handing every feature
  unrestricted harness/workspace access. Preserve one transaction for each invariant that requires it.
- Keep MCP/OAuth/network adapters explicit and test their supported contract. Prefer existing substrate support;
  adding a custom protocol layer increases security and maintenance obligations.
- Maintain a precise authority inventory: durable runtime state, accepted file versions, authoritative workspace
  definitions/memory, auth and byte storage. Derived indexes must be rebuildable. Do not create a second store to
  paper over proxy or workspace consistency problems.
- Validate prompt-prefix stability as configuration changes; new accepted information should use the established
  entry mechanism. Cache warming is an optimization after measurements, not a prerequisite for correctness.

## Acceptance

A critical invariant can be traced through a bounded interface and its tests without following unrelated UI or
protocol machinery. No new authority or synchronization store is introduced. Targeted refactors preserve the app
and fault properties. Security and data-preservation fixes take precedence over a broad module rewrite.

Related sections: [Isolation](isolation.md), [Connections](connections.md), [Performance](performance.md) and
[Recovery](recovery.md). Existing entry points include ../src/daemon.ts, ../src/core/turn.ts,
../src/server/routes/area.ts and ../src/core/store.ts.

## Open work

Recheck these items against current code before implementation; an unchecked item is not a freshly verified
defect. Remove it only when its fix and acceptance evidence are recorded in a commit.

- [ ] Narrow touched orchestration dependencies around admission, workspace mutation and projections (architecture.md)
