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

## Native packaging

Native packaging compiles the pinned Microsandbox source with banda's existing-only execution patch. The packaging
helper verifies source, compiler and guest-agent inputs, uses a private Rust 1.99.1 toolchain and Cargo cache under
`release/cache/computer/runtime`, and records the build inputs and actual executable hash in the installed manifest.
The original vendor archive remains a verified firmware input. A source build failure has no fallback to ordinary exec.

Mac packaging needs the platform's C toolchain and targets macOS 14. Linux packaging runs the source build inside the
upstream digest-pinned manylinux 2.28 Docker image and checks that baseline before installation. Those are packaging
requirements. The installed native Mac and Linux applications use their bundled executables and need neither Rust
nor Docker. Windows keeps its existing backend until native qualification.

## Open work

- [ ] Qualify native recovery through host sleep/wake and prolonged outages, and reduce the preflight cost without
  losing proxy recovery or retrying interrupted actions. Run the new restoration fault sweeps in CI.
- [ ] Qualify the bundled Linux computer on x64 and ARM64 with KVM: staged runtime and image hashes,
  guarded networking, persistent folders, lazy browser loading, desktop/phone-width use and complete cleanup.
  The release workflow's optional native-computer check runs `scripts/verify-computer.ts`; ordinary release
  smoke checks do not exercise the VM. The browser archive is supplied locally with its exact pinned bytes,
  so public download delivery remains separate.
- [ ] Spike the Windows native computer's directory ACLs, local named-pipe permissions and VM mount isolation
  before selecting it in the desktop app. The current runtime ships Windows binaries and requires WHP;
  the banda adapter is not qualified for Windows. The native Mac computer requires Apple silicon and macOS 14 or newer.

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
- [ ] The phone on a real network: a real Android phone on cellular, the daemon on home Wi-Fi, across NAT through
  n0's relays, pairs and chats, and survives sleep, backgrounding and a network change. The shell (`mobile/`) pairs,
  chats, keeps its key across a daemon restart and pairs again once revoked on the arm64 emulator over n0; no real
  phone has run it
- [ ] A signed release APK: the release workflow builds the APK unsigned, then signs it as
  `banda-<version>-android-arm64.apk` in a job of its own that runs no npm or Gradle, and refuses to tag one without
  banda's key in the repository's secrets (BANDA_ANDROID_KEYSTORE_BASE64, _KEYSTORE_PASSWORD, _KEY_ALIAS,
  _KEY_PASSWORD). The key is set; a signed workflow run still needs trying, and the APK
  installing over the one before
- [ ] The phone's shell on iOS: out of scope for now. It implements the same plugin contract as Android's
  (`BandaPlugin` in `web/src/lib/transport.ts`) with iroh-ffi's Swift bindings, and needs a real iPhone to try
- [ ] The phone's shell, once paired: a device revoked while the app is open goes to the pairing screen (covered by
  tests, not yet tried on a phone), and the app's files come with the shell, so a new build reaches the phone only as
  a new APK
- [ ] Windows endpoint-key publication: Node flushes the key file before rename, but does not expose directory
  fsync on Windows; qualify power-loss recovery on a Windows filesystem
- [ ] Push notifications that carry no content
- [ ] Qualify recoverable updates, owner-controlled diagnostics and the exact packaged candidate (operations.md, verification.md)
- [ ] The daemon runs the checkout's code: merged work takes effect only at a restart
