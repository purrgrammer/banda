# Persistence backup and restoration

Priority: **High**. Implementation status lives in [Status](status.md).

## Findings

Blob writes sync file contents before rename, but explicit destination-directory persistence is missing. SIGKILL is not evidence of power-loss ordering. Recoverable truth includes the durable store, blobs, authoritative workspace files, auth/configuration and browser sessions; restoring only durable.db cannot recreate the band.

Entry points: ../src/core/blobs.ts, ../src/core/store.ts, ../src/home.ts, ../src/box/container.ts and ../src/core/search.ts.

## Work and exit criteria

- Verify blob file and directory persistence ordering on the selected platform before a referring store commit.
  Separate SIGKILL claims from filesystem/power-loss claims; do not describe one as proof of the other.
- Define the recovery set: durable store and its SQLite side files as applicable, referenced blobs, accepted and
  workspace-only definitions, memory, required workspace outputs, configuration and auth. Include browser state; identify disposable caches, tool downloads and search indexes explicitly.
- Establish one consistent snapshot boundary without syncing a second authority. Protect secrets in exported backups;
  document key custody and what cannot be recovered if the owner loses the key.
- Implement backup/restore progress and failures in the app. Validate manifests and hashes before activating a
  restored home; do not overwrite the current home during validation. Rebuild derived state afterward.
- Restore on a fresh home and fresh containers, then resume pending work. Unknown external outcomes still ask;
  restoration must not replay already completed sends merely because the backup predates them.
- Exit: recovery acceptance R1-R4 passes, including a corrupted or incomplete backup and pending approvals.

Follow [Delivery](delivery.md) and the relevant gates in [Verification](verification.md).

## Open work

Recheck these items against current code before implementation; an unchecked item is not a freshly verified
defect. Remove it only when its fix and acceptance evidence are recorded in a commit.

- [ ] Prove blob file and directory persistence ordering on the supported filesystem (recovery.md)
- [ ] Provide consistent backup and validated restore of the store, blobs, workspace, auth and browser state (recovery.md)
