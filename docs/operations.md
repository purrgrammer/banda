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
- [ ] The box's runtime brought by banda: no Docker installed by hand. Pre-release binaries still require it
- [ ] Sign and notarize the desktop app (Developer ID, Windows code signing), then add updates that back up first and
  activate atomically. Pre-release binaries are unsigned and update by hand
- [ ] Run the release workflow end to end and fix what each runner turns up (Windows fast tests, linux arm64 deb).
  Then install each artifact on a clean machine: the desktop app and the CLI archive are tried only on macOS arm64
- [ ] Windows: a graceful daemon stop (Quit ends the process outright), and a pass over atomic renames and paths
- [ ] A smaller release: bundle the daemon so provider SDKs and web-only packages don't ship whole
- [ ] Spike the daemon side of Iroh: an endpoint (ALPN `banda/0`, key in the home's `auth/`) that carries the HTTP
  API unchanged. Exit: SSE stays open, a retried message dedupes and a reconnect catches up from `ready.tail`, over a
  direct and a relayed path, with first-byte latency. Direct path done on loopback; the relayed path is blocked
  until the owner allows a public relay (or names a self-hosted one), and a path across NAT is unrun
- [ ] Spike the phone's Iroh client: the PWA with iroh's wasm build, or a native shell only if that fails. Exit: the
  phone on cellular, the daemon on home Wi-Fi, one real answer from `/api/agents`. Desktop Chrome got it through a
  hand-built wasm and a loopback relay; the phone on cellular over a public relay is the owner's manual run
- [ ] Pairing slice: the Iroh listener authorizes by the remote endpoint id among the paired phones, in place of the
  single `auth/token` check, and is not held to the loopback Host/Origin check; Settings lists, renames and revokes
  each phone, pairing by QR. Exit: a fault sweep at the pairing commit and a desktop and phone walkthrough
- [ ] Off-network reach slice: the app's files and API over Iroh from the phone, cached by `web/public/sw.js`. Exit:
  the installed app opens and chats off the home network, and survives sleep, backgrounding and a network change
- [ ] Push notifications that carry no content
- [ ] Qualify recoverable updates, owner-controlled diagnostics and the exact packaged candidate (operations.md, verification.md)
- [ ] The daemon runs the checkout's code: merged work takes effect only at a restart
