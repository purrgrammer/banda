# Spike: the OS keychain from a Node 24 daemon (macOS and headless Linux)

Run 2026-11-23. Feeds docs/wallets.md ("The key's record", "The daemon is a separate Node process") and closes open
questions 2 and 4 of docs/wallets/research/os-keychain.md. Nothing here is a DESIGN.md rule yet.

## Goal

Find out which mechanism banda should use to keep a wallet's private key in the OS keychain, and which states mean
"keychain unavailable". Concretely:

- (a) macOS: `@napi-rs/keyring` (latest, pinned) set, get and delete of a 32-byte hex secret under service
  `banda-spike-<random>`, account `<home-id>/wallet/<n>`; the same through `security -i` with commands on stdin, the
  secret checked absent from every process's argv. Latency, the missing item, and whether a second process (another
  Node binary, at another path) can read it.
- (b) Linux, headless, in Docker: the same `@napi-rs/keyring` code with an unlocked keyring under `dbus-run-session`,
  with no Secret Service, and with a locked keyring. Exact errors.

## Setup

| | macOS | Linux |
|---|---|---|
| Host | darwin-arm64, Darwin 27.2.0 | Docker 29.8.2 (OrbStack) on the same Mac, linux/arm64 |
| Node | v24.22.1 and v26.12.1 (nvm installs, both signed by the Node.js team, Team ID HX7739G8FX) | v24.22.3 (`node:24-bookworm-slim`, index digest pinned in the Dockerfile) |
| Keychain | login keychain (legacy file keychain) | gnome-keyring 42.1-1+b2, libsecret 0.20.5-3, dbus 1.14.10-1~deb12u1 (Debian bookworm) |
| Library | `@napi-rs/keyring` 2.1.2 (latest; published 2026-10-19) with `@napi-rs/keyring-darwin-arm64` 2.1.2 | same, `@napi-rs/keyring-linux-arm64-gnu` 2.1.2 |

What the prebuilt binaries contain, read from their embedded cargo-auditable data with `audit-deps.mjs`:
macOS: `keyring-core` 1.0.1, `apple-native-keyring-store` 1.0.2, `security-framework` 3.7.0.
Linux: `keyring-core` 1.0.1, `dbus-secret-service-keyring-store` 1.0.1, `dbus-secret-service` 4.1.0, `libdbus-sys`
0.2.7 (libdbus statically linked), `linux-keyutils-keyring-store` 1.0.0, `openssl` 0.10.81, plus `zbus` 5.19.0 and
`secret-service` 5.2.0. `cargo audit bin <file.node>` can scan the same data in CI.

## Files

| File | What it does |
|---|---|
| `kc.mjs` | One keychain operation per process: `set` (makes a random key in-process, prints its sha256 fingerprint), `get` (AsyncEntry with an AbortSignal timeout and a 100 ms heartbeat), `del`, `bench` (latency, missing item, overwrite, raw bytes), `race`. `KC_STORE` pins the Linux store. The key never goes on argv. |
| `cross-macos.mjs` | Which Node binary reads an item another Node binary wrote, and an 8-process set race. |
| `security-i.mjs` | The same through `security -i`, the argv check, missing item and duplicate add. |
| `hang.mjs` | What an unanswered unlock prompt does to a Node process: abort, threadpool, exit. |
| `linux.sh`, `Dockerfile` | The Linux scenarios (`unlocked`, `locked`, `prompt`, `notstarted`, `nosecrets`, `nodbus`). |
| `audit-deps.mjs` | Prints the Rust crates compiled into a `.node` binary. |

## Commands

All work happens in a scratch folder outside the repo (copy this folder there; `npm install` puts `node_modules` there).

```sh
npm install                                        # @napi-rs/keyring 2.1.2, exact

# macOS (a): bench, then the cross-binary matrix, then security -i
SVC="banda-spike-$(openssl rand -hex 6)"; ACCT="home-$(openssl rand -hex 4)/wallet/0"
node kc.mjs bench "$SVC" "$ACCT" 20
mkdir -p bin/copy24 bin/adhocA bin/adhocA2 bin/adhocB
N24=~/.nvm/versions/node/v24.22.1/bin/node; N26=~/.nvm/versions/node/v26.12.1/bin/node
cp $N24 bin/copy24/node                                         # same signature, other path
cp $N24 bin/adhocA/node && codesign -f -s - bin/adhocA/node     # ad hoc: designated requirement = its cdhash
cp bin/adhocA/node bin/adhocA2/node                              # same cdhash, other path
cp $N26 bin/adhocB/node && codesign -f -s - bin/adhocB/node     # ad hoc, another cdhash
node cross-macos.mjs safe       # expected silent
node cross-macos.mjs prompt     # expected to raise a keychain prompt (bounded)
node security-i.mjs

# Linux (b), headless in Docker
TAG="banda-spike-keychain-$(openssl rand -hex 4)"
docker build -t $TAG .
for s in unlocked locked prompt notstarted nosecrets nodbus; do
  docker run --rm --name "$TAG-$s" $TAG sh linux.sh $s
done
docker run --rm --security-opt seccomp=unconfined --name "$TAG-nodbus-u" $TAG sh linux.sh nodbus  # keyutils allowed, as on a host
docker rmi $TAG
```

## Results

### A. macOS through `@napi-rs/keyring`

**Latency** (`bench`, one process, 20 iterations, ms):

| | set | get | delete |
|---|---|---|---|
| sync `Entry`, median (max) | 14.18 (48.95) | 2.41 (4.21) | 7.68 (10.66) |
| `AsyncEntry`, median (max) | 15.28 (17.67) | 2.48 (4.16) | 7.34 (10.75) |

A fresh process that only reads: 7 to 27 ms for the get, 59 to 156 ms wall time including Node's start.

**Edge cases** (`bench`, trimmed):

```json
"missing":   { "getPassword": { "returned": null }, "getSecret": { "returned": null }, "deletePassword": { "returned": false } },
"overwrite": { "secondSetThrew": false, "holds": "second" },
"raw":       { "getSecretRoundTrip": true,
               "getPasswordThrew": { "code": "GenericFailure", "message": "Password data is not valid UTF-8" } }
```

- A missing item is `null` (get) and `false` (delete), never an exception.
- **A second `setPassword` on an existing entry silently replaces the key.** Sequential sets overwrite.
- **8 concurrent first sets** (8 processes, same entry): 1 succeeded, 7 failed with
  `Platform failure: The specified item already exists in the keychain.` The concurrent case refuses, the sequential
  case overwrites: the keychain is no arbiter of "one key per wallet".
- Every error has `code: "GenericFailure"`; only the message tells them apart.

**Which binary reads an item another binary wrote** (`cross-macos.mjs`):

| Writer | Reader | Reader's code identity vs the item's ACL | Result |
|---|---|---|---|
| nvm v24 | nvm v24, new process | same binary | read silently, 22 ms |
| nvm v24 | nvm v26 (other install, other binary) | same designated requirement: Node.js team ID | **read silently**, 27 ms |
| nvm v24 | copy of v24 at another path | same signature | read silently, 20 ms |
| ad hoc A | copy of A at another path | same cdhash | read silently, 7 ms |
| ad hoc A | ad hoc B (v26) | other cdhash | **keychain prompt**; it was answered at the screen by the person at the Mac (the spike clicks nothing) and the get returned after 9406 ms |
| nvm v24 | ad hoc A | other identity | **keychain prompt**; answered at the screen, get returned after 8666 ms |

The ACL follows the executable's code signature, not its path and not the script it runs. In the prompt cases
`AsyncEntry.getPassword(AbortSignal.timeout(6000))` resolved at 9.4 s and 8.7 s: **the signal did not abort the
in-flight call.** The event loop stayed responsive meanwhile (93 heartbeats of 100 ms in 9.4 s).

The released desktop app signs ad hoc (`identity: "-"` in desktop/electron-builder.yml). On an installed release,
`codesign -dv` on `Contents/Resources/banda/node/node` shows `Signature=adhoc`, `TeamIdentifier=not set` and a
designated requirement of `cdhash H"…"`: the bundled Node is exactly the "ad hoc" row above.

### B. macOS through `security -i` (commands on stdin)

```json
"add":              { "code": 0, "processesWithKeyInArgv": 0 },
"get":              { "code": 0, "matches": true },
"addAgainWithoutU": { "code": 45, "stderr": "security: SecKeychainItemCreateFromContent (<default>): The specified item already exists in the keychain.\nadd-generic-password: returned -25299" },
"addAgainWithU":    { "code": 0 },
"delete":           { "code": 0, "stderr": "password has been deleted." },
"getMissing":       { "code": 44, "stderr": "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\nfind-generic-password: returned -25300" },
"deleteMissing":    { "code": 44, "stderr": "... delete-generic-password: returned -25300" }
```

- `ps -axww` while `security -i` held the add found the key in 0 processes' argv.
- One `security -i` process per command, spawn included, over 3 runs: add 27.6 to 32.1 ms, get 15.5 to 26.1 ms,
  delete 15.8 to 19.0 ms.
- `security -i` passes the command's exit status through (44 not found, 45 duplicate), and `add` without `-U`
  refuses a duplicate instead of overwriting.
- Items it adds trust `/usr/bin/security`, so any later `security` process reads them without a prompt (each command
  above ran in a fresh process); not run: reading a `security`-made item from Node or the reverse (each would prompt
  the person at the screen again).

### C. Linux, headless (Docker)

| Scenario | Store | Operation | Result |
|---|---|---|---|
| **unlocked** (`dbus-run-session`, `gnome-keyring-daemon --unlock`) | secret-service | 20 × set / get / delete | median 7.69 / 0.18 / 3.68 ms (max 17.04 / 0.26 / 13.25); a second process and a copy of `node` at another path read it |
| unlocked | auto (default) | set | went to the Secret Service (1 item found with `secret-tool search`) |
| unlocked | secret-service | 8 concurrent first sets | **all 8 reported success; 1 item remained, holding the last writer's key**: 7 keys silently lost |
| unlocked | `secret-tool store` | key on stdin | round trip matched, nothing on argv (open question 4: yes) |
| **locked** (collection locked over D-Bus, no display) | secret-service and auto | get, set, delete | fail in 9 to 17 ms: `Couldn't access platform storage: Secret Service: unlock prompt was dismissed` (gcr-prompter: `cannot open display`) |
| locked, then `gnome-keyring-daemon --replace --unlock` | secret-service | get | the item is intact |
| **prompt** (locked, Xvfb display, nobody answers) | secret-service | 1 get, `AbortSignal.timeout(2000)` | **still pending at 8 s**; `process.exit(0)` at 8 s **did not end the process**: SIGKILL at 20 s (status 137). SIGTERM with no handler ended it at once |
| prompt | secret-service | 4 gets (default threadpool of 4) | **`fs.readFile` and `crypto.pbkdf2` never completed** in the 7.5 s that followed; the event loop still ticked |
| **notstarted** (session bus, gnome-keyring auto-activated, no login keyring) | secret-service and auto | set | `Couldn't access platform storage: Secret Service: no result found` |
| notstarted | secret-service | get / delete | **`null` / `false`**: the same answers as a missing item |
| **nosecrets** (session bus, no Secret Service provider) | secret-service | set, get | `Platform failure: DBus error: The name org.freedesktop.secrets was not provided by any .service files` |
| nosecrets | auto | set, get, delete | fell back to keyutils: `Couldn't access platform storage: PermissionDenied` (Docker's default seccomp blocks the kernel keyring) |
| **nodbus** (no session bus) | secret-service | set | `Platform failure: DBus error: Using X11 for dbus-daemon autolaunch was disabled at compile time, set your DBUS_SESSION_BUS_ADDRESS instead` |
| nodbus | auto | set, get | `Couldn't access platform storage: PermissionDenied` (seccomp) |
| nodbus, `seccomp=unconfined` (as on a host) | auto | set, get, get from a second process | **set succeeded, in the kernel keyring**, read back by a second process, deleted after |

Linux has no per-application access control: any process of the user on the session bus reads any item of an
unlocked collection, whatever binary it runs.

Why the hung process cannot exit: libuv runs `uv_library_shutdown` as a destructor at `exit()`, which calls
`uv__threadpool_cleanup` and `uv_thread_join`s every threadpool thread; a thread blocked in a keychain call never
returns. Why the abort does nothing: napi-rs cancels an `AsyncTask` only "if it has not been started".

## Verdict

- **Use `@napi-rs/keyring` 2.1.2, pinned, with the Linux store pinned to `secret-service`.** It works on both
  platforms, the key never touches argv, and the error messages are enough to tell the unavailable states apart.
  The default Linux store is unsafe for a wallet: with no Secret Service it silently stores the key in the kernel
  keyring, which the library's own README says "will not persist across reboots", so a funded key would vanish at
  the next restart while banda believed it stored.
- **Never call it from the daemon's own threads.** A keychain call can block for as long as a person takes to answer a
  prompt, or forever. While it blocks, the AbortSignal is ignored, four such calls starve every fs, crypto and dns
  call of the daemon, and the daemon cannot exit except by SIGKILL. Run each keychain operation in a short-lived child
  process started from the daemon's own binary (`process.execPath`, so macOS sees the same code identity), one at a
  time, killed on a deadline. The child can also do the signing, so the key never enters the daemon at all.
- **`security -i` is a sound macOS-only alternative** (no dependency, exit codes passed through, add refuses
  duplicates without `-U`). But it does not help Linux, and its items trust `/usr/bin/security`, which any process of
  the user can run to read them without a prompt.
- **The keychain cannot guarantee one key per wallet** (sequential sets overwrite on both platforms; concurrent first
  sets error on macOS and silently keep the last writer on Linux). banda must make that guarantee itself.

## What it means for the design

1. **Account name carries the address**: `<home-id>/wallet/<address>`, the address derived from the key. A set for an
   account can then only ever carry that one key, so a retried or repeated create is idempotent and a second key can
   never land on a wallet's entry (instead of `<home-id>/wallet/<n>`, where two creates can pick the same n).
2. **Create is check, set, read back, then commit**: make the key, derive the address, get must return `null`, set,
   get again and compare, and only then commit the wallet to the store. A crash after the set and before the commit
   leaves a keychain entry with no doc: start-up lists them as orphans for the owner, never deletes them.
3. **One keychain operation in flight per home**, through one queue in the daemon: the concurrent-create outcome
   differs per platform, so banda never lets it happen.
4. **`null` never means "make a key".** For a wallet the store knows, `null` is "the key is gone or the keychain is not
   usable"; Linux returns `null` too when no default collection exists. Tell them apart with a canary: set, get and
   delete an entry `<home-id>/probe`. If the canary works, the wallet's key is missing; if it fails, the failure says
   which state the keychain is in.
5. **The keychain states** banda shows, with the evidence that maps to each:

   | State | macOS | Linux (pinned `secret-service`) |
   |---|---|---|
   | ready | get returns the key | get returns the key |
   | needs the owner | the helper is still waiting (keychain prompt on screen) | the helper is still waiting (unlock prompt on a display) |
   | locked | not observed (see below) | `Couldn't access platform storage: Secret Service: unlock prompt was dismissed` |
   | no keyring | — | `Couldn't access platform storage: Secret Service: no result found` on the canary set |
   | no Secret Service | — | `Platform failure: DBus error: The name org.freedesktop.secrets was not provided by any .service files` or `... set your DBUS_SESSION_BUS_ADDRESS instead` |
   | key missing | `null` with a working canary | `null` with a working canary |

   All errors are `GenericFailure`; the classification matches message prefixes (`Couldn't access platform storage:`
   is keyring-core's no-access error, `Platform failure:` its platform error), which is why the version is pinned and
   each message gets a test. In every state but "ready" the wallet is offline with the reason shown; there is no file
   fallback.
6. **The bundled Node's signature decides how often macOS prompts.** Today it is ad hoc, so its identity is its cdhash:
   every release that changes the Node binary makes the first read of each wallet's item raise a keychain prompt
   (one prompt per wallet, observed above). A Developer ID signature gives a team-based designated requirement, which
   a newer binary from the same team satisfies silently (observed with the two Node.js-signed installs). Signing the
   app with a Developer ID is therefore a prerequisite for a quiet upgrade; until then, the "needs the owner" state
   must say what to click.
7. **What the keychain protects against on macOS is narrower than "only banda"**: the ACL trusts an executable, and an
   interpreter runs any script. A Node.js-signed `node` (any install, any version) read the nvm-written item silently;
   for the released app, anything run by the bundled `node` would. Isolation from other code of the same user needs a
   dedicated signed executable as the keychain client, a choice for later.

## Not run, and open

- macOS: what Deny on the prompt returns, a locked login keychain, and a session with no GUI (SSH, launchd): each
  expected to fail with an error rather than prompt, none observed. Whether `process.exit` also hangs on macOS behind
  a prompt (expected, same libuv code; not run, to avoid prompting the person at the screen again).
- macOS: a Developer ID-signed bundle across an update (inferred from the two Node.js-signed installs, not run on
  banda's own bundle).
- Linux on a real desktop (GNOME, KDE/KWallet) and on x64; `findCredentials` for the orphan listing; Windows.

## Cleanup

Every keychain item was `banda-spike-<random>`, deleted by the binary that wrote it and then checked absent with
`security find-generic-password -s <service>` (attributes only); no other item was read. The keyutils key from the
unconfined run was deleted (`deleted: true`). All containers ran with `--rm` and the spike image was removed; the copied
Node binaries were deleted from the scratch folder.

## Sources (all accessed 2026-11-23)

- `@napi-rs/keyring` 2.1.2: `npm view @napi-rs/keyring version time optionalDependencies`; its README and
  `index.d.ts` as installed (Linux auto-selection "silently falls back to the kernel keyutils keyring"; keyutils "will
  not persist across reboots"), https://github.com/Brooooooklyn/keyring-node
- linux-keyutils-keyring-store: https://crates.io/crates/linux-keyutils-keyring-store (quoted by the README above)
- napi-rs AsyncTask and AbortSignal ("abort the AsyncTask if it has not been started"):
  https://napi.rs/docs/concepts/async-task
- libuv exit-time threadpool join: https://github.com/libuv/libuv/blob/v1.x/src/uv-common.c (`uv_library_shutdown`,
  a destructor) and https://github.com/libuv/libuv/blob/v1.x/src/threadpool.c (`uv__threadpool_cleanup`, 4 default
  threads)
- Docker's default seccomp profile blocks `add_key`, `keyctl` and `request_key` ("the kernel keyring, which is not
  namespaced"): https://docs.docker.com/engine/security/seccomp/
- `node:24-bookworm-slim` index digest: `docker buildx imagetools inspect`, recorded in the Dockerfile
