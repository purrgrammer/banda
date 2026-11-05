# Installation updates and support

Priority: **High**. Implementation status lives in [Status](status.md).

## Findings

Process restart is well considered, but packaged runtime delivery, least-authority supervision, clean-machine installation, complete restore and update recovery are not established. Local dependency pins do not alone make every image/toolchain build reproducible or an update safe.

Entry points: ../src/cli/index.ts, ../src/daemon.ts, ../src/box/container.ts, ../box/Dockerfile, ../proxy/Dockerfile, ../src/home.ts and ../package.json.

## Work and exit criteria

- Package and supervise the selected runtime with the least host authority; isolate Docker socket access and prove
  rootless operation or an equivalent supported boundary. Pin and verify artifacts and dependency versions.
- Provide clean installation, provider setup, autostart, shutdown, sleep/wake and offline behavior. The app must
  explain a missing runtime, full disk, provider outage or failed update with a concrete next action.
- Spike signed distribution/update installation on the selected platform. Updates stop work safely, back up first,
  verify artifacts and activate atomically. Define application/store compatibility and restore behavior; do not add
  speculative migrations during pre-release. Binary rollback alone is not data rollback.
- Add owner-controlled diagnostics with redaction, explicit export and retention. Document token rotation, backup key
  loss, uninstall/data retention and recovery. No telemetry or outbound support upload without owner action.
- Exit: a clean supported machine installs, runs, updates and recovers without CLI or hand-installed Docker.

Follow [Delivery](delivery.md) and the relevant gates in [Verification](verification.md).

## Open work

Recheck these items against current code before implementation; an unchecked item is not a freshly verified
defect. Remove it only when its fix and acceptance evidence are recorded in a commit.

- [ ] Rootless box, and a supervisor that alone holds the Docker socket
- [ ] The box's runtime brought by banda: no Docker installed by hand
- [ ] Pairing the phone to the daemon, and reaching it off the home network
- [ ] Push notifications that carry no content
- [ ] Qualify recoverable updates, owner-controlled diagnostics and the exact packaged candidate (operations.md, verification.md)
- [ ] The daemon runs the checkout's code: merged work takes effect only at a restart
