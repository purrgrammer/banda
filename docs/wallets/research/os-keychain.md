# Research: storing an EVM private key in the OS secret store from a Node 24 daemon

Status: research, dated 2026-11-23. Feeds docs/wallets.md ("The key's record", "The daemon is a separate Node process").
Nothing here is a DESIGN.md rule yet (principle 6: each mechanism needs its spike first).

## Summary

- **Recommended default: `@napi-rs/keyring` 2.1.2, pinned exactly.** It is a Rust `keyring-rs` binding that loads a
  per-platform prebuilt `.node` binary through `optionalDependencies`. It runs in-process in the daemon, so no secret
  ever touches argv or a child process. Verified on darwin-arm64 with Node v24.22.1 (set, get, delete).
- **Do not use `keytar` or `@github/keytar`.** `atom/node-keytar` was archived 2022-12-15 (read-only); `@github/keytar`
  is marked deprecated on npm. Both are C++ native builds with a history of install failures.
- **macOS needs no dependency if one is unwanted.** The `security` CLI in interactive mode (`security -i`, command on
  stdin) keeps the secret out of argv. Verified: add, read back, delete. Caveats: a newline in the secret starts a
  second command, and `find-generic-password -w` hex-encodes non-printable bytes, so store the key as ASCII hex.
- **Keychain ACLs are tied to the calling binary's code signature.** Replacing the bundled Node in an update can
  trigger a macOS "wants to use the keychain item" prompt, or refuse access. This is the largest unverified risk and
  needs its own spike on a signed bundle (see Open questions).
- **Linux is the weakest path.** Headless or locked Secret Service leaves no prompt-free unlock. The RFC's rule (wallet
  offline, no file fallback) is the right default. A GUI keyring prompt cannot be answered by a headless daemon.
- **Industry pattern to avoid:** GitHub CLI and Electron's `safeStorage` Linux fallbacks write credentials to
  plaintext or weak storage when the keyring is missing. The RFC already rejects this.

## Findings with sources

Access date for all sources: 2026-11-23.

### 1. Package facts (npm registry, `npm view`)

| Package | Latest | Published | Notes |
|---|---|---|---|
| `@napi-rs/keyring` | 2.1.2 | 2026-10-19 | MIT; engines `node >= 10`; npm provenance attestation present (SLSA v1); maintainers: 2 |
| `keytar` | 7.9.0 | 2022-02-17 | MIT; last release; upstream archived 2022-12-15 |
| `@github/keytar` | 7.10.6 | 2026-02-06 | MIT; npm marks it deprecated ("no longer supported") |
| `cross-keychain` | 2.0.0 | 2026-11-08 | MIT; engines `>= 20.19.0`; created 2025-09-30; provenance present; single maintainer; 15 days old at this date |

Sources: `npm view <pkg> version time --json` and `npm view <pkg> dist.attestations`, run 2026-11-23. Repository URLs:
`git+https://github.com/Brooooooklyn/keyring-node.git` (napi), `git+https://github.com/atom/node-keytar.git` (keytar),
`git+https://github.com/magarcia/cross-keychain.git` (cross-keychain).

`node-keytar` is not an npm package (404), so it is excluded.

### 2. Advisories

- GitHub Advisory Database (`gh api "/advisories?ecosystem=npm&affects=<pkg>"`) returned an empty list for all four
  packages on 2026-11-23.
- OSV (`api.osv.dev/v1/query`, npm, each package) returned `{}` (no known vulnerabilities) for all four.
- These are negative results, not proof of safety. Re-run before any adoption, and re-run in CI.

### 3. Prebuilt binaries for `@napi-rs/keyring`

- The package is a loader plus per-platform packages in `optionalDependencies`. Search results show
  `@napi-rs/keyring-linux-x64-gnu` (about 255K weekly downloads per Socket) and the loader references
  `@napi-rs/keyring-darwin-arm64`, Windows x64 MSVC, Linux arm64 GNU, Android, FreeBSD and darwin-x64/universal.
  Sources: https://socket.dev/npm/package/@napi-rs/keyring-linux-x64-gnu (search results, 2026-11-23),
  https://socket.dev/npm/package/@napi-rs/keyring/diff/1.3.0.
- **Verified in this run:** `npm i @napi-rs/keyring@2.1.2` on darwin arm64 installed `@napi-rs/keyring-darwin-arm64`
  (spike below). Linux x64 was not run here (no Linux host).
- Replacing keytar with `@napi-rs/keyring` for the same reason (prebuilt binaries, no native compile) is the choice an
  Apify MCP PR made: https://github.com/apify/mcpc/pull/7 (search result, 2026-11-23).

### 4. keytar status

- Upstream archived 2022-12-15, README says `@github/keytar` is deprecated.
  Source: https://raw.githubusercontent.com/github/node-keytar/4b609509f7fb2cf3ffc707cee576c0ce27142b70/README.md
  (search result, 2026-11-23); https://www.npmjs.com/package/keytar.
- VS Code removed its keytar shim in the August 2023 release (dates differ across sources, 1.80 in one community guide).
  Sources: https://bitbucket.org/atlassianlabs/atlascode/issues/5345/keytar-migration-plan;
  https://jira.mongodb.com/browse/VSCODE-435 (search results, 2026-11-23).

### 5. macOS `security` CLI and the secret off argv

- `security -i` reads commands from stdin, one tokenized command per line. The RubyGems macOS backend uses this to keep
  the secret out of argv. Its docs warn that a newline starts a second command, and that `find-generic-password -w`
  prints non-printable bytes as hex.
  Source: https://docs.ruby-lang.org/en/master/Gem/CredentialStore/MacOSBackend.html (search result, 2026-11-23).
- Apple's `security(1)` man page: `-w` with no value prompts for the password (the recommended way to avoid argv). This
  is not a stdin read of raw bytes.
  Source: man page excerpt in search results (2026-11-23); verify with `man security` on the target macOS.
- **Verified (spike):** `printf 'add-generic-password ... -w <secret>\n' | security -i` wrote a `banda-spike-*` item,
  `find-generic-password -w` returned the same value, `delete-generic-password` removed it. A `ps -axww` check while
  `security -i` ran found 0 matches for the secret in any process's argv (the initial count of 1 was grep matching its
  own command line, corrected on re-run).

### 6. macOS keychain ACLs and the calling binary's signature

- A keychain item's access control list (ACL) records the app that created it, referenced by its designated requirement
  (DR), which is tied to the code signature. A rebuilt or re-signed binary may stop matching it, and the user gets a
  prompt. The partition list (`security set-key-partition-list`) adds a second check on apple/teamid entries.
  Sources: https://developer.apple.com/forums/thread/98182 (partition list, DTS answers),
  https://developer.apple.com/forums/thread/845980 (how ACL and partition list combine),
  https://developer.apple.com/forums/thread/115425 (signed app rules), 2026-11-23 search results.
- These are community and DTS forum answers. Apple's own docs for the "wants to use" prompt logic were not found.
  Treat them as hypotheses until run on a signed bundle (open question 1).
- **Consequence for banda:** the daemon's Node binary is what calls the keychain. Updates that change its signature,
  team or identifier can prompt, or fail, the first time. The RFC's "wallet offline, say why" is the correct failure
  mode; the design must also say how the owner re-grants access ("Always Allow") and never silently re-create a key.

### 7. Linux: Secret Service, libsecret, KWallet, locked and headless

- Electron's `safeStorage` on Linux uses `kwallet`, `kwallet5`, `kwallet6` or `gnome-libsecret`, selected by desktop
  session or the `--password-store` flag. Its `basic_text` fallback is weak. Sources: https://www.electronjs.org/docs/api/safe-storage
  (search result, 2026-11-23; the `basic_text` behavior is from memory and not verified in this run).
- VS Code (on Electron) back-ends SecretStorage on `safeStorage`; community guides advise installing `gnome-keyring` and
  passing `--password-store="gnome"` to pick the keyring explicitly. Sources: https://control-plane.io/posts/abusing-vscode-from-malicious-extensions-to-stolen-credentials-part-2/
  (search result, 2026-11-23); https://nwater23.github.io/... (community guide, low authority).
- **Not found in search:** official Secret Service API spec text on locked collections and the prompt flow, and
  gnome-keyring behavior on a headless host. This is an open question. From general knowledge (not verified here): a
  locked collection triggers a `Prompt` object on D-Bus, and a headless daemon has no one to answer it, so the call fails
  or hangs. A test run in Docker with `dbus-run-session` and `gnome-keyring-daemon --unlock` would settle it.
- **systemd-creds:** encrypts a credential into a file, keyed by TPM2 (`systemd-analyze has-tpm2`) or the host key,
  decryptable only on that machine. Sources: https://www.freedesktop.org/software/systemd/man/257/systemd-creds.html
  (search result, 2026-11-23). It is a file on disk, so it conflicts with the RFC's "no file fallback" rule unless the
  owner accepts encrypted-at-rest backups. Not recommended as a default; a possible headless option to decide later.

### 8. Other established apps

- **GitHub CLI (`gh`):** the manual says `gh auth login` stores the token in the system credential store and falls back
  to a plaintext file if the store is missing or fails. Later PRs added an opt-in `--secure-storage` flag. A Flox post
  reports silent plaintext fallback on Linux when the keyring is locked. Sources:
  https://cli.github.com/manual/gh_auth_login; https://github.com/cli/cli/pull/7023; https://flox.dev/blog/get-secure-github-cli-auth-you-can-take-with-you-anywhere
  (search results, 2026-11-23). Lesson: a plaintext fallback is the failure to avoid.
- **Docker credential helpers:** one helper binary per store (`osxkeychain`, `secretservice`, `wincred`, `pass`),
  selected by `credsStore` in `~/.docker/config.json`, speaking a store/get/erase/list stdin protocol. Latest v0.9.3,
  2025-03-14, MIT. Source: https://pkg.go.dev/github.com/docker/docker-credential-helpers (search result, 2026-11-23).
  Lesson: a helper protocol lets the store be swapped without touching the caller.
- **1Password CLI:** does not store the secret itself; the desktop app unlocks each account with explicit biometric
  approval, one account per authorization. Service accounts use an env token. Sources:
  https://developer.1password.com/docs/cli/app-integration-security; https://www.1password.dev/cli/use-biometric-unlock/
  (search results, 2026-11-23). Lesson: per-use authorization of a key held elsewhere.
- **VS Code:** SecretStorage on `safeStorage` (see section 7).

### 9. Windows Credential Manager

- Generic credentials: blob size cap `CRED_MAX_CREDENTIAL_BLOB_SIZE` = 5 × 512 = 2560 bytes. A 32-byte key (64 hex
  chars) fits easily. Sources: https://learn.microsoft.com/windows/win32/api/wincred/ns-wincred-credentialw (search
  result, 2026-11-23; the 2560 figure comes from the 5 × 512 definition and a third-party wincred doc).
- `@napi-rs/keyring` ships a Windows x64 MSVC binding (loader code, section 3). Not run here.

## Libraries table

| Option | Version (date) | Platforms | Fit for banda | Verdict |
|---|---|---|---|---|
| `@napi-rs/keyring` | 2.1.2 (2026-10-19) | darwin, Windows, Linux (GNU + musl via napi bindings) | In-process, no argv; prebuilt; MIT; provenance | **Recommended**, pin `2.1.2` exactly |
| `security -i` (macOS CLI) | system tool | macOS only | No dependency; secret on stdin | Fallback for macOS, or the only option if no native module is wanted |
| `secret-tool` (libsecret CLI) | system tool | Linux with libsecret | Reads secret from stdin (not verified here) | Candidate Linux fallback, untested |
| `keytar` | 7.9.0 (2022-02-17) | — | Archived 2022-12-15 | Avoid |
| `@github/keytar` | 7.10.6 (2026-02-06) | — | Deprecated on npm | Avoid |
| `cross-keychain` | 2.0.0 (2026-11-08) | — | Young, single maintainer, Node >= 20.19 | Watch, do not adopt yet |
| Electron `safeStorage` | Electron docs | — | Requires the Electron main process; the daemon is not one (RFC) | Not applicable |
| `docker-credential-helpers` (pattern) | v0.9.3 (2025-03-14) | per helper | Pattern for helper-per-store, not a Node library | Use the pattern |

## Risks / CVEs

| Risk | Severity | Source | Mitigation |
|---|---|---|---|
| No GitHub advisories and no OSV vulns for the four packages on 2026-11-23 | info | `gh api`, `api.osv.dev` | Re-check in CI; pin exact versions |
| Supply chain: npm packages with native binaries | medium | npm provenance is present for napi and cross-keychain | Pin exact version, verify provenance in CI, lockfile integrity |
| `cross-keychain` 15 days old, single maintainer | medium | npm `time`, `maintainers` | Do not adopt yet |
| macOS ACL prompt on bundled Node replacement (update) | high (functional) | DevForums (section 6), unverified | Spike on a signed bundle before design; owner re-grant flow |
| Secret on argv (`security add -w <value>`) | high | `ps` | Use `security -i` (stdin) or napi; never pass as argv |
| Newline or non-printable bytes in `security -i` | medium | RubyGems docs | Store the key as ASCII hex |
| Plaintext fallback when keyring fails (gh, Electron) | high | gh manual; Flox post | Wallet offline on any keyring failure; no file fallback |
| Headless Linux locked Secret Service hangs or prompts | high (functional) | general knowledge, unverified | Detect the locked state, fail fast, show the reason in the wallet tool |
| Electron `basic_text` backend (weak) | medium | Electron docs (from memory) | Not used: the daemon is not Electron |

## Spikes run (2026-11-23, darwin-arm64, Node v24.22.1, macOS 27.2.1)

Scratch folder: a temporary folder outside the repository (`<scratch>/os-keychain`)

All entries were named `banda-spike-<random>` (`banda-spike-*` prefix plus random suffix), with a random dummy secret,
and each was deleted. A final audit of the keychain found no leftover `banda-spike-*` item.

1. `security -i` add, read and delete: OK. Secret absent from every process's argv during the call (0 matches).
2. `@napi-rs/keyring@2.1.2` set, get, delete: OK. `getPassword()` on a missing entry returns `null` and does not throw
   (corrected from an initial wrong expectation). Plan the wrapper for `null`, not an exception.
3. Not run (needs a signed bundle, a Linux host or a D-Bus session): ACL behavior after binary change, Linux locked
   Secret Service, Windows.

## Recommendations

1. **Use `@napi-rs/keyring` pinned to `2.1.2`** behind one `KeyStore` interface in the daemon. Read `null` as absent. Pin
   the platform bindings through the lockfile and verify npm provenance in CI.
2. **Store the key as ASCII hex** (64 chars for 32 bytes), keyed by a service name made of the home's id and the account
   (as the RFC says), so another home, a test or a fork cannot read it.
3. **Never pass the secret in argv.** Prefer napi. If the owner rejects a native dependency, use `security -i` on macOS
   and `secret-tool` on Linux (untested), with a fault test for newlines and non-printable bytes.
4. **Fail closed.** Locked, missing, denied, or prompt-required keychain means the wallet is offline with a reason shown
   to the owner. No plaintext or file fallback (matches gh's failure mode, which the RFC rejects).
5. **Owner export at creation** (requirement 5) reads the key through the same `KeyStore` with a user gesture, and shows
   it once, with a copy action. Log nothing about it.
6. **Before the design is frozen,** run the signed-bundle ACL spike (open question 1): build a signed Node bundle, store
   an entry, replace the binary with a new signature and an updated one, and record the prompt behavior.
7. **Add a Linux headless spike** in Docker with `dbus-run-session` and a locked `gnome-keyring-daemon`, to pin the
   behavior of a locked collection. Record the exact error and the time it takes.

## Open questions

1. How does a macOS keychain item created by a signed Node bundle behave after an update that keeps the same team and
   identifier, and after one that changes them? (Needs a signed-bundle spike.)
2. What does a locked or absent Secret Service do under a headless daemon: error, hang or prompt? Which error code should
   the wallet tool map to "offline"? (Needs a Docker spike.)
3. Is a native dependency acceptable under AGENTS.md principle 13 ("prefer no new dependency")? The `security -i` path
   avoids it on macOS but not on Linux or Windows.
4. Does `secret-tool store` read the secret from stdin without argv exposure? (Not verified here.)
5. Is systemd-creds acceptable as a headless Linux option, given the RFC's rule against file fallbacks?
6. What is `cross-keychain`'s track record? (Too new to judge at 2026-11-23.)

## Sources (all accessed 2026-11-23)

- npm registry: `npm view` for `@napi-rs/keyring`, `keytar`, `cross-keychain`, `@github/keytar`
- OSV: https://api.osv.dev/v1/query (npm, four packages), empty results
- GitHub Advisory Database: `gh api "/advisories?ecosystem=npm&affects=<pkg>"`, empty results
- https://docs.ruby-lang.org/en/master/Gem/CredentialStore/MacOSBackend.html
- https://developer.apple.com/forums/thread/98182, /845980, /115425
- https://socket.dev/npm/package/@napi-rs/keyring-linux-x64-gnu, /diff/1.3.0
- https://github.com/apify/mcpc/pull/7
- https://raw.githubusercontent.com/github/node-keytar/4b609509f7fb2cf3ffc707cee576c0ce27142b70/README.md
- https://bitbucket.org/atlassianlabs/atlascode/issues/5345/keytar-migration-plan
- https://jira.mongodb.com/browse/VSCODE-435
- https://www.electronjs.org/docs/api/safe-storage
- https://control-plane.io/posts/abusing-vscode-from-malicious-extensions-to-stolen-credentials-part-2/
- https://www.freedesktop.org/software/systemd/man/257/systemd-creds.html
- https://cli.github.com/manual/gh_auth_login; https://github.com/cli/cli/pull/7023; https://flox.dev/blog/get-secure-github-cli-auth-you-can-take-with-you-anywhere
- https://pkg.go.dev/github.com/docker/docker-credential-helpers
- https://developer.1password.com/docs/cli/app-integration-security; https://www.1password.dev/cli/use-biometric-unlock/
- https://learn.microsoft.com/windows/win32/api/wincred/ns-wincred-credentialw
