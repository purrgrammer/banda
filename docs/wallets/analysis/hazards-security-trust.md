# Hazards: security and trust

Status: analysis, 2026-11-23, for the RFC in [`docs/wallets.md`](../../wallets.md). Lens: security and trust. Nothing
here is a DESIGN.md rule; each case names the mechanism that would hold it and the test or spike that proves it
(principles 6 and 10).

Inputs: the owner's requirements 1 to 7 in the RFC; DESIGN.md "Trust", "Clients", "Home", "The box", "Connections",
"Messages"; SECURITY.md; the research in [`../research/`](../research/) (signing libraries, OS keychain, x402, chain
operations, wallet security); the code that exists today (`src/core/floor.ts`, `src/core/permissions.ts`,
`src/home.ts`, `scripts/fork-home.ts`, `proxy/addon.py`); and four micro-spikes run for this report
([`spikes/security-trust/`](spikes/security-trust/README.md)).

## What the spikes showed

| Spike | Finding | Cases it moves |
|---|---|---|
| K1 | A second script, run by the same `node` binary from another folder and process, read the wallet item silently in 24 ms. The macOS keychain authorises the binary, not the script. | SEC-010, SEC-040, SEC-041 |
| K2 | An item planted under the daemon's name by another binary (`security add-generic-password -A`) is adopted silently by `@napi-rs/keyring`; `setPassword` overwrites an existing item silently. | SEC-007, SEC-008, SEC-014 |
| M1 | After a sign-and-zero pattern (string or bytes), no copy of the key is reachable in a V8 heap snapshot (3 runs each); a single retained reference keeps it there every time (control, 2 runs). Freed memory is not proven scrubbed. | SEC-018, SEC-019, SEC-021 |
| P1 | An all-lowercase address has no checksum, so a typo passes; a mixed-case typo or one case flip is caught. One JS thread finds a 2+2 hex look-alike in 65.6 s (310,420 keys); a prefix/suffix gate flagged every look-alike. | SEC-064, SEC-066 |

## Trust assumptions

- **TA-1. The owner's OS account is trusted.** Code that runs as the owner on the computer banda runs on (a coding
  agent, `serve --box host` commands, an npm script, malware) can read every wallet key (K1) and the owner's token.
  The wallet cannot hold against it; it says so, takes the wallets offline where banda itself runs commands on the
  host (SEC-041), and the balance bounds the loss.
- **TA-2. What banda ships is trusted**: its release, its pinned dependencies (SEC-105 to SEC-108) and, for a browser
  device, the files app.banda.rocks serves (SECURITY.md).
- **TA-3. The model, the box, every page and every other agent are untrusted.** They can steer calls, never admit
  them (laws 4, 5, 7).
- **TA-4. The RPC is untrusted for what it reports** (balance, nonce, receipts, fees, chain id). It can delay and
  mislead; it cannot make banda sign more than the shapes and values banda chose (SEC-098 to SEC-104).
- **TA-5. The chain's consensus is trusted**; reorgs after a safe block are treated as not happening (chain-operations
  research F1).

## Invariants the cases defend (each a property or fault test)

| Id | Invariant |
|---|---|
| INV-S1 | No byte of a wallet key is ever in the store, blobs, `config.json`, `auth/` files, a backup, a log, a prompt, the box or a response to a device. |
| INV-S2 | No payment to a recipient without an Always rule for that (wallet, agent, recipient identity) runs without an owner answer; a Deny recipient is never paid. |
| INV-S3 | Renaming never changes which calls a rule covers; a label never resolves to an address in an agent's call. |
| INV-S4 | Every signature banda produces is one of the shipped shapes (native transfer, listed ERC-20 transfer, EIP-3009 for a pinned USDC domain) and moves at most the value it names from the current balance; none grants an allowance or a delegation. |
| INV-S5 | An x402 payment's endpoint, payTo, asset, network and amount come from a proxy observation of the same chat, never from tool arguments. |
| INV-S6 | Each signed nonce ends on chain as that transaction or a same-nonce replacement; no nonce with a stored signature is released or skipped. |
| INV-S7 | One home signs for a wallet at a time; a fork or a second copy of a home never signs. |
| INV-S8 | A key is revealed only on the computer banda runs on, through a path no daemon route serves: Electron main spawns the signer itself after the OS re-authentication and shows the key in a window that loads a bundled local file (sandboxed, no network, content protection), never the daemon's origin; the creation reveal is answered once on the create request's own connection. A request with the owner's token and a script in the web UI's origin both fail to reveal. |
| INV-S9 | Every unlock proves the key derives the wallet's recorded address before anything is signed. |

## What the wallet exception changes in DESIGN.md "Trust"

| Law | Today | With agent wallets |
|---|---|---|
| 1 Owner authority | Only the owner's token or a paired device fills owner Waits and permissions. | Unchanged. New: revealing a key needs more than owner authority: the host and a gesture (SEC-023, SEC-026), because an exported key outlives a device's revocation. |
| 2 Admission | No permission ever covers the floor; money is on the floor. | The one change. A payment from a wallet of the shipped wallet connection is an ordinary write admitted by its recipient's rule (Always) or a draft (Ask), refused by Deny; every other money effect stays on the floor (SEC-127). The structural bound replacing the floor is the balance (INV-S4). |
| 3 Least tools | An agent runs only its tools and accounts. | Unchanged: a wallet is an account switched on per agent (SEC-042); a group grants none (SEC-052). Rules bind per agent on a shared wallet (SEC-059, decision D3). |
| 4 Foreign content is data | A steered call is admitted as any other. | Unchanged, and now with money: a page can make an agent pay Always recipients up to the balance (SEC-048, SEC-081) and ask to pay new ones (SEC-045); never pay a new one unasked. |
| 5 Integrity | Nothing the box wrote changes what an agent may do. | Unchanged: rules, labels and wallet access are store facts, never workspace files (SEC-047, SEC-119). |
| 6 Confidentiality | Owner data leaves through admitted effects or reads to public hosts. | Unchanged; wallet history is owner data and can leave through reads (SEC-117); the RPC and the model provider see addresses and amounts (SEC-103, SEC-114). |
| 7 Structure over judgment | A reviewer model never permits. | Unchanged: look-alike and label warnings are code; no model answers a payment (SEC-128). |
| Interrupted effects | Unsafe effects open a retry-or-skip Wait. | Every wallet effect is idempotent (stored signed bytes, memoized authorization), so none is unsafe (SEC-129). |

## Decisions for the owner

The cases surface six choices the requirements leave open. Each is listed with the safer default.

- **D1. Revealing the key after creation** (SEC-025): never after the first reveal, or on the host only behind an OS
  re-authentication. Safer default: host only, with re-authentication, listed in activity.
- **D2. Owner Send from a paired device** (SEC-038, SEC-109): requirement 7 puts Send in Settings; a device acts as
  the owner, and a stolen phone or a swapped app.banda.rocks build could empty every wallet. Safer default: from a
  device, send only to recipients already set; a new address is confirmed on the computer.
- **D3. Rule scope on a shared wallet** (SEC-059): the RFC says rules belong to the wallet "so to one agent", while
  requirement 6 lets several agents share one. Safer default: Always binds (wallet, agent, recipient); Deny may be
  wallet-wide.
- **D4. Price jumps on an Always endpoint** (SEC-081): a re-ask would be a per-payment limit, which requirement 3
  excludes. Safer default within the requirement: pay, and report the jump.
- **D5. Import after a restore elsewhere** (SEC-122): out of the requirements. Default: none; the saved key opens the
  funds in another wallet app.
- **D6. A separate signer** (SEC-010, SEC-040): a signed helper with hardened runtime and a keychain access group
  would narrow TA-1. Needs a spike on a signed bundle before it is a choice.

## Severity

- **critical**: a key leaves the owner's control, a payment to a new recipient runs unasked, or a signature reaches
  money not in the wallet.
- **high**: funds within the balance are lost or misdirected without the owner's intent, the key is lost, or two
  homes sign for one wallet.
- **medium**: wrong state shown, a denial of service, a privacy leak of addresses or amounts, or a gap in a defence
  that another one still covers.
- **low**: an edge with no loss, or a residual the owner accepted.

## Cases

Each case: trigger, expected behaviour, mitigation (preferring banda's existing mechanisms: store commits,
permissions, drafts, Waits, idempotent effects, proxy observations). Kinds: best (the path that must work), error,
edge, race, security.

| Area | Cases | critical | high | medium | low |
|---|---|---|---|---|---|
| Key generation | SEC-001 to SEC-008 | 2 | 4 | 1 | 1 |
| Keychain storage | SEC-009 to SEC-017 | 2 | 4 | 2 | 1 |
| Key in memory | SEC-018 to SEC-021 | 1 | 1 | 1 | 1 |
| Key export | SEC-022 to SEC-032 | 2 | 4 | 4 | 1 |
| Keychain unavailable | SEC-033 to SEC-036 | 0 | 1 | 3 | 0 |
| Authority | SEC-037 to SEC-044 | 3 | 3 | 1 | 1 |
| Prompt injection | SEC-045 to SEC-053 | 2 | 3 | 3 | 1 |
| Recipient rules and labels | SEC-054 to SEC-063 | 1 | 2 | 5 | 2 |
| Address poisoning | SEC-064 to SEC-069 | 0 | 2 | 4 | 0 |
| x402 | SEC-070 to SEC-084 | 1 | 8 | 5 | 1 |
| Signing guards | SEC-085 to SEC-091 | 3 | 3 | 1 | 0 |
| Balance is the cap | SEC-092 to SEC-097 | 1 | 0 | 2 | 3 |
| RPC | SEC-098 to SEC-104 | 0 | 2 | 3 | 2 |
| Supply chain | SEC-105 to SEC-109 | 1 | 2 | 2 | 0 |
| Secrets at rest and in transit | SEC-110 to SEC-115 | 1 | 0 | 4 | 1 |
| Box boundary | SEC-116 to SEC-119 | 1 | 1 | 2 | 0 |
| Homes, forks and backups | SEC-120 to SEC-123 | 0 | 2 | 2 | 0 |
| Owner's own wallet use | SEC-124 to SEC-126 | 0 | 1 | 2 | 0 |
| Trust laws | SEC-127 to SEC-129 | 0 | 2 | 1 | 0 |
| **All** | 129 | 21 | 45 | 48 | 15 |

### Key generation

**SEC-001** · best · high: A wallet is made on the computer banda runs on
- Trigger: Owner taps New wallet in Settings > Wallets (or 'Give Mara a wallet') on the desktop app.
- Expected: Daemon draws 32 bytes from the OS CSPRNG (noble secp256k1.utils.randomSecretKey over crypto.getRandomValues), rejects 0 and >= n, derives the address, writes the keychain item create-only, reads it back, re-derives the address, and only then commits the wallet record {address, chains, keychain name} and shows the address and the export offer. No key byte ever reaches the store, a log, the box or a prompt.
- Mitigation: Two commits around the keychain write: 'creating' (keychain name, no key) then 'created' (address). The address is never shown or receivable before 'created'. Test vectors for derivation; property test: store, blobs, auth/ and logs never contain the key.

**SEC-002** · error · critical: The CSPRNG fails or is replaced
- Trigger: crypto.getRandomValues throws, returns early, or a dependency shims it (supply-chain patch, test helper leaking into release).
- Expected: Creation fails with words ('banda could not make a key on this computer'); nothing is committed; no fallback to Math.random, time or a counter.
- Mitigation: Only noble's randomSecretKey on node:crypto; a lint rule bans Math.random and custom RNGs in the wallet module; a test injects a throwing RNG and asserts no record. Release build never contains the test keystore or RNG.

**SEC-003** · edge · low: A scalar out of range
- Trigger: Random bytes equal 0 or are >= the secp256k1 order n.
- Expected: Rejected and redrawn by the library; never reduced modulo n by hand.
- Mitigation: Use the library's generator, not hand-rolled reduction; known-answer tests from noble's vectors.

**SEC-004** · security · high: A key or seed supplied by the agent or a page
- Trigger: The agent (steered) says 'use this key / seed phrase', or a page offers a pre-made wallet.
- Expected: No tool imports or derives a key from anything the agent, the model or the box provides. A wallet's key is only ever generated in the daemon (import, if ever added, is a host-only owner action).
- Mitigation: Least tools (law 3): no import tool exists; the wallet connection's tool list is shipped, not listed from a server.

**SEC-005** · race · high: Crash between the keychain write and the record
- Trigger: SIGKILL after the item is written and before 'created' commits, or after 'creating' and before the write.
- Expected: On restart, a 'creating' record whose item exists and re-derives cleanly is completed; one whose item is absent is discarded. An item with no record is never adopted by a later wallet. The owner never sees an address whose key is not durably in the keychain.
- Mitigation: Fault points at both sides of the keychain write under test/fault/ (principle 10); the keychain name is random per wallet and recorded before the write, so recovery never guesses.

**SEC-006** · race · medium: Two creations at once
- Trigger: Double click, or the desktop and a paired phone both tap New wallet.
- Expected: Each request is one wallet at most (client idempotency key deduplicated in the commit); two distinct requests make two wallets with two random keychain names; never two writes to one name.
- Mitigation: Idempotent creation keyed by the request; keychain name = home id + random account suffix chosen in the 'creating' commit.

**SEC-007** · security · critical: A planted or pre-existing keychain item under the wallet's name
- Trigger: Another program (malware, a stale test, a second home) wrote an item with the name the daemon is about to use. Spike K2: @napi-rs/keyring adopts a planted item silently and setPassword overwrites an existing one silently.
- Expected: Creation refuses any name that already has an item (getPassword !== null) and picks a new random name; the daemon never overwrites an item (an overwrite would destroy a funded key) and never adopts one (the owner would fund an address someone else knows).
- Mitigation: Create-only KeyStore.create(); KeyStore has no update method; every unlock re-derives the address and compares it with the record (SEC-008).

**SEC-008** · security · high: The key in the keychain no longer matches the wallet
- Trigger: Item replaced (planted after creation), keychain restored from another machine, two homes sharing a name, or a bug writing the wrong item.
- Expected: At every unlock the address derived from the key is compared with the record; a mismatch takes the wallet offline ('the key in this computer's keychain is not this wallet's'); nothing is signed; nothing is rewritten.
- Mitigation: The address in the store is the wallet's identity; the key must prove it each time. Test: swap the in-memory keystore's value and assert refusal before any signature.

### Keychain storage

**SEC-009** · best · high: The key is read in-process, never through argv, env or a child
- Trigger: Any signing or export.
- Expected: The daemon reads the item through the in-process native module (@napi-rs/keyring 2.1.2, research spike verified); no `security` or `secret-tool` child carries the secret in argv or env.
- Mitigation: One KeyStore interface; the macOS CLI fallback, if ever used, sends the command on stdin (`security -i`), stores ASCII hex, and is fault-tested for newlines.

**SEC-010** · security · critical: Any process run by the same Node binary reads every key
- Trigger: Spike K1: a second script in another folder, another process, same node binary, read the item silently in 24 ms. A harness on the host, a host-mode command, an npm script or malware can exec the daemon's (bundled) Node and read the wallet keys.
- Expected: Stated as a trust assumption: the owner's OS account is trusted, and code running as the owner can spend. The wallet does not pretend otherwise: Settings > Wallets says it; host mode takes wallets offline (SEC-041); the harness connect card says a coding agent on this computer can use the wallets (SEC-040).
- Mitigation: Structural mitigations to spike: a separately signed signer helper with hardened runtime whose item sits in a keychain access group only it can read; until then, the balance is the bound on this loss.

**SEC-011** · edge · high: An update changes the binary the keychain trusts
- Trigger: The Mac app is not Developer ID signed (SECURITY.md), so the bundled Node's designated requirement changes with each release; macOS then prompts 'wants to use your confidential information' or refuses.
- Expected: Wallet shows 'needs keychain access again'; payments wait in an owner Wait; the daemon never creates a new key for an existing wallet; the owner grants access once on the desktop.
- Mitigation: Signed-bundle spike (research open question 1); AsyncEntry with an AbortSignal deadline so a pending GUI prompt never blocks the event loop.

**SEC-012** · race · high: A nonce taken but the key cannot be read
- Trigger: The start commit reserved the chain nonce, then the keychain is locked, prompts or is missing.
- Expected: The key is unlocked before the commit that takes the nonce and signs; if a nonce was reserved and no signature for it was ever produced (no checkpoint), it is released in the same task so later payments are not stuck behind a gap. A nonce with a stored signature is never released (SEC-099).
- Mitigation: Order in the effect: rule check, keychain unlock with deadline, commit nonce + record, sign, checkpoint raw bytes. Fault point between nonce commit and signing.

**SEC-013** · error · medium: The keychain reports an ambiguous entry
- Trigger: keyring returns Ambiguous: a third-party program wrote a second matching credential.
- Expected: Wallet offline with the reason; nothing deleted automatically; the owner resolves it in Keychain Access.
- Mitigation: Map Ambiguous to an explicit offline state, tested with the in-memory keystore's error injection.

**SEC-014** · security · high: Two homes on one computer reach the same key
- Trigger: The RFC names the item by 'the home's own id', but no such id exists today (src/home.ts has auth/device-id, 'not a credential'). A backup copies auth/ whole; an in-app restore keeps the replaced home among the backups. Serving both gives two daemons one key with diverging rules and nonce ledgers.
- Expected: Exactly one home holds a wallet at a time. A holder marker (a random epoch kept beside the key in the keychain and in the home's store) is compared at every unlock; a mismatch takes the wallet offline ('this wallet is used by another banda home') until the owner moves it here explicitly.
- Mitigation: A wallet lease, not a convention; a new auth/home-id made at first start and never copied by home:fork; test with two temp homes sharing an in-memory keystore.

**SEC-015** · error · critical: The keychain item is deleted
- Trigger: Owner deletes it in Keychain Access, a macOS user migration drops it, or the login keychain is reset.
- Expected: Wallet offline 'key missing from this computer'; funds are recoverable only from the saved export; the daemon never generates a new key under the old record (the address would silently change).
- Mitigation: Address re-derivation (SEC-008) makes a silent replacement impossible; Settings shows whether the key was saved (SEC-030).

**SEC-016** · edge · medium: The OS backs up the keychain
- Trigger: The login keychain file sits in ~/Library/Keychains and goes into Time Machine, encrypted with the login password (to confirm in a spike); Linux keyrings follow the distribution's backup.
- Expected: Documented to the owner: banda's backups never hold the key, the OS's may. banda cannot remove the key from OS backups.
- Mitigation: Words in Settings > Wallets; no banda mechanism beyond not copying the key itself.

**SEC-017** · edge · low: The item's name says what it is
- Trigger: Someone at the unlocked computer opens Keychain Access.
- Expected: Items are named so the owner can find them for recovery ('banda wallet 0x12ab…9f04'); viewing the secret still needs the login password.
- Mitigation: Accepted trade-off (findability over discretion); name never contains the key.

### Key in memory

**SEC-018** · best · high: The key exists only inside the signing call
- Trigger: Any signature.
- Expected: KeyStore.withKey(account, sign) reads the secret as bytes (getSecret), copies into a Uint8Array, signs, zeroes both; callers never receive the key. Spike M1: after this pattern no copy is reachable in a heap snapshot.
- Mitigation: An opaque API with no getter; tests run a full payment and assert the key is absent from a heap snapshot (M1's method, with M1's positive control).

**SEC-019** · security · critical: A retained reference leaks the key
- Trigger: The key ends up in an Error message or stack, a pi-durable memo or checkpoint, an effect's arguments, a log line, a debug cache or a closure. Spike M1 control: a single retained reference keeps it in the live heap and in any snapshot.
- Expected: Impossible by construction: the key type never leaves withKey; errors from the signer carry codes, never inputs; the effect stores only the signed bytes.
- Mitigation: Property test over a payment scenario scanning the store, blobs, logs and a heap snapshot for every wallet key; a lint rule forbids memo/checkpoint/log calls inside the signer module.

**SEC-020** · security · medium: The daemon runs with an inspector or heap-dump flags
- Trigger: Dev runs with --inspect, NODE_OPTIONS carries --inspect or --heapsnapshot-signal, or a diagnostics script attaches.
- Expected: Wallets are offline while an inspector is active (inspector.url() set) or heap-dump flags are present; the app says why.
- Mitigation: A start check on process.execArgv, NODE_OPTIONS and inspector.url(); test in a child process.

**SEC-021** · edge · low: Freed memory, swap and crash dumps
- Trigger: Freed heap pages are not scrubbed (M1 proves only unreachability); the OS may swap or hibernate them; a crash reporter may dump.
- Expected: Accepted residual for a hot wallet; the exposure window is one signature; no key cache.
- Mitigation: No in-memory key cache (keychain read measured at 24 ms in K1, acceptable per payment); core dumps stay off by default.

### Key export

**SEC-022** · best · high: The key is offered once at creation, on the computer banda runs on
- Trigger: A wallet was just created on the desktop.
- Expected: A screen offers 'Save your key': the key is masked until the owner reveals it; Copy writes it marked concealed and clears it after 60 s if still there; the owner confirms 'I saved it' or 'Not now'. The store records only that the key was revealed (a fact, no key).
- Mitigation: Export answers only on loopback HTTP from the host (not Iroh), with Cache-Control: no-store, never via the shell stream, SSE, a URL or a log.

**SEC-023** · security · critical: Export asked from a paired device
- Trigger: The phone app or a browser device (app.banda.rocks) asks to reveal a key.
- Expected: Refused: 'keys are shown only on the computer banda runs on'. A device acts as the owner, but DESIGN.md says no device mints access that outlives its revocation, and an exported key is exactly that; SECURITY.md says whoever controls app.banda.rocks can serve other files to a paired browser.
- Mitigation: The route checks the transport (loopback with the token), not the token alone; Iroh-dispatched requests to it are refused; test over a paired test device.

**SEC-024** · security · critical: The agent or a page asks for the key
- Trigger: Steered agent asks the owner to paste the private key in chat 'to verify the wallet', or asks for an export tool.
- Expected: No tool reveals a key; the export screen says banda never asks for it; an owner message containing a 64-hex string that derives to one of the home's wallet addresses is stopped before it reaches the model provider, with a warning.
- Mitigation: A structural check in the owner-message path (derive and compare, no heuristics); the export UI is unreachable from the box (the proxy refuses loopback and the daemon's port).

**SEC-025** · security · high: Export later than creation
- Trigger: Owner opens the wallet weeks later and wants the key (requirement 5 only promises it at creation).
- Expected: Owner decision: either never after the first reveal, or host-only behind an OS re-authentication (Touch ID or the login password through the desktop app) and listed in activity. Never from a device, never without a fresh gesture.
- Mitigation: Recorded as decision D1; whichever is chosen, the same route rules as SEC-022/023 apply.

**SEC-026** · security · high: A local process calls the export route with the owner's token
- Trigger: A harness, a host-mode command or a browser extension reads auth/token (or the token the web UI keeps) and calls the loopback export.
- Expected: Export needs a gesture the API caller cannot produce: a one-time capability minted by the desktop app's main process after a native confirm (or a TTY confirmation in the CLI), bound to one wallet and seconds of life.
- Mitigation: Capability from Electron main over IPC, never from the web page; residual under TA-1 (SEC-010) stated.

**SEC-027** · edge · medium: A screenshot or screen share during the reveal
- Trigger: Screen sharing, a screenshot tool or a recorder runs while the key is revealed.
- Expected: Window content protection is set (Electron setContentProtection), and the screen warns that apps using ScreenCaptureKit capture it anyway (Electron's own docs); reveal is press-and-hold, not a toggle.
- Mitigation: Content protection plus the warning; the specimen shows an invalid dummy key (all zero), never a real one.

**SEC-028** · edge · medium: Clipboard history and Universal Clipboard
- Trigger: A clipboard manager records the copied key, or macOS Handoff puts it on the owner's phone.
- Expected: Copy writes the org.nspasteboard.ConcealedType and TransientType markers (desktop app clipboard API) and clears after 60 s if unchanged; writing the key down is offered first.
- Mitigation: Spike: whether the markers keep it off Universal Clipboard; the web UI on a browser cannot set them, one more reason export is the desktop app's.

**SEC-029** · edge · medium: Browser extensions read the reveal
- Trigger: Owner opens the daemon's page in Chrome with an extension allowed on all sites, which can read 127.0.0.1 pages.
- Expected: Reveal happens in the desktop app window (no extensions); the plain web UI on the host says to use the desktop app or accepts with a warning.
- Mitigation: Same route; decided with D1.

**SEC-030** · error · medium: The owner never saved the key
- Trigger: Owner taps Not now and the wallet is funded; later the machine dies.
- Expected: Funds are lost; until saved, the wallet shows 'key not saved' and a funded unsaved wallet nudges the owner once a week in Settings, never in a chat the model reads.
- Mitigation: A store fact (revealed: true/false), no key.

**SEC-031** · security · high: The revealed key lingers in the client
- Trigger: The key is kept in React state after the screen closes, in sessionStorage, a service worker cache, the HTTP cache, or the packed shell stream to devices.
- Expected: One response, no-store, held only by the reveal component and dropped on close; never in the shell, SSE, IndexedDB, a URL, the router state or an error report.
- Mitigation: A web test that reveals, closes and scans storage and caches; the route is excluded from the stream-budget payloads.

**SEC-032** · edge · low: Export format
- Trigger: Owner imports the saved key into another wallet app.
- Expected: A raw 32-byte hex key with 0x and the address it opens ('this key opens 0x12ab…9f04'); one independent key per wallet, no seed phrase (wallet-security research: a seed is one secret for every wallet).
- Mitigation: Fixed format; a test that the shown key derives the shown address.

### Keychain unavailable

**SEC-033** · error · medium: The keychain is locked mid-routine
- Trigger: Keychain auto-lock after inactivity or sleep while a routine pays at night.
- Expected: The payment waits in an owner Wait ('the keychain is locked'); no nonce is consumed without a signature (SEC-012); reads (balance, history) keep working; nothing falls back.
- Mitigation: AsyncEntry with a deadline; the Wait outlives restarts; the model is told, never asked to retry.

**SEC-034** · error · medium: No keychain at all
- Trigger: Linux over SSH or under systemd with no Secret Service; a container; a CI runner.
- Expected: Creating a wallet is refused ('this computer has no keychain banda can use'); existing records stay offline; no file, env var or systemd-creds fallback unless the owner later decides otherwise (research open question 5).
- Mitigation: Fail closed (os-keychain research recommendation 4); the headless spike in Docker pins the exact error.

**SEC-035** · error · medium: A locked Secret Service prompt hangs
- Trigger: A locked collection raises a D-Bus Prompt nobody can answer (unverified).
- Expected: The call ends at a deadline and the wallet is offline with that reason; the daemon's event loop never blocks (the synchronous Entry would).
- Mitigation: AsyncEntry + AbortSignal everywhere; a lint rule bans the synchronous Entry in the daemon.

**SEC-036** · security · high: A test or debug keystore reachable in a release
- Trigger: An env var or flag selects the in-memory or file keystore in a released build ('for headless').
- Expected: Impossible: the in-memory keystore exists only in test builds and is injected by the test harness; no env var selects a keystore.
- Mitigation: Build-time exclusion and a release smoke check that the module is absent.

### Authority

**SEC-037** · best · high: Owner authority over wallets
- Trigger: Owner on the desktop sets rules, approves, sends, switches wallets on for agents.
- Expected: Each is an owner act through the owner's token or a paired device (law 1), committed in the store, listed in activity.
- Mitigation: Existing owner-token and device checks; the wallet adds no new authority path.

**SEC-038** · security · high: A paired phone or browser device drains a wallet
- Trigger: A stolen unlocked phone, a copied browser profile, or a compromised app.banda.rocks build uses owner Send to a new address, or sets a recipient to Always.
- Expected: A device acts as the owner, so it can (law 1), bounded by the balances; revoking the device on the desktop stops it at the next commit; the desktop shows every device-originated wallet act.
- Mitigation: Owner decision D2: owner sends from a device only to recipients already set, or with a confirmation on the desktop. Export from devices is refused regardless (SEC-023).

**SEC-039** · security · critical: The box reaches owner routes
- Trigger: Code in the box tries the daemon's API to set a rule, approve its own draft or reveal a key.
- Expected: Unreachable: the box has no route but the proxy, which refuses loopback, private ranges and the daemon's port in every spelling; approvals need the owner's token or a paired device.
- Mitigation: Existing proxy policy (proxy/addon.py); a box-suite test that tries each owner wallet route.

**SEC-040** · security · critical: A coding agent on the host uses the owner's authority
- Trigger: A harness (runs with the owner's host access) is steered to read ~/.banda/auth/token and call the API, or to exec the bundled Node and read the keychain (K1).
- Expected: Residual under TA-1; the harness connect card and Settings > Wallets say a coding agent on this computer can use the wallets; the export capability (SEC-026) still needs the desktop app's gesture.
- Mitigation: Words where the owner grants it; the signer-helper spike (SEC-010).

**SEC-041** · security · critical: Host mode gives every command the wallets
- Trigger: `serve --box host`: commands run on the owner's machine, so any steered command can read auth/token and exec Node to read the keys.
- Expected: Wallets refuse to sign while host mode runs; the app and the CLI say so beside the existing host-mode warning; reads still work.
- Mitigation: A check in the signer on the box kind; test that a payment in host mode ends 'offline: no box'.

**SEC-042** · security · high: An agent pays from a wallet it was not given
- Trigger: Agent passes the account of another agent's wallet.
- Expected: Refused in the start commit; the tool's account parameter lists only wallets switched on for that agent.
- Mitigation: Existing account binding (connections: a tool an account was not given is refused in words before any request).

**SEC-043** · race · medium: A wallet switched off mid-payment
- Trigger: Owner switches the wallet off for the agent while its payment waits for approval, or after it was signed.
- Expected: Waiting drafts are refused at their start commit; a payment already signed and checkpointed is broadcast (its signature exists and is the one intended) and the UI says 'already sent'.
- Mitigation: Start commit is the linearisation point; test both sides of it.

**SEC-044** · race · low: A device revoked during its approval
- Trigger: Owner revokes a phone while its 'Always pay' answer is in flight.
- Expected: The answer's commit checks the device and is refused.
- Mitigation: Existing device check in the same commit.

### Prompt injection

**SEC-045** · security · critical: A page steers a payment to a new address
- Trigger: Foreign content instructs the agent to send funds to 0xATTACKER.
- Expected: The recipient is unknown, so the payment is a draft the daemon draws: full checksummed address, 'never paid', amount, balance after, the agent's reason quoted; nothing editable; the name field empty. It cannot run unasked.
- Mitigation: Draft + Wait (law 2); recipient rule resolved in the start commit; property test over generated steered calls: no payment to an unknown recipient without an owner answer.

**SEC-046** · security · high: The agent claims a new address is someone the owner knows
- Trigger: The reason says 'Ana's new address'.
- Expected: Labels on the card come only from the store; when the reason names an existing label whose identity differs, the card warns 'you named another address Ana'.
- Mitigation: Deterministic label match on the reason (display triage, law 7), never a model.

**SEC-047** · security · high: Poisoned memory maps a name to an attacker address
- Trigger: A page made the agent write 'Ana = 0xATTACKER' into its memory; later the owner says 'pay Ana' (ElizaOS research).
- Expected: The call names a new address: the card asks and shows the label mismatch (SEC-046). Rules, labels and wallet access never live in workspace files the box can write.
- Mitigation: Store-held rules (connection exception to 'definitions are files'); law 5.

**SEC-048** · security · high: A page steers repeated payments to an Always recipient
- Trigger: Injection makes the agent pay Ana (Always) again and again.
- Expected: Runs without asking up to the balance, as chosen (requirement 3); every payment is a card in the chat and in activity; the owner can set Ana back to Ask.
- Mitigation: Accepted by the model and said on the Always button; an informational burst notice is triage only (law 7).

**SEC-049** · security · critical: A steered agent widens its own rules
- Trigger: Injection asks the agent to set the unknown-recipient default to Always, rename a recipient or change a rule.
- Expected: No tool changes rules, labels or defaults; the default is Ask or Deny, never Always.
- Mitigation: Least tools; the rule store accepts writes only from owner routes.

**SEC-050** · security · medium: Ask cards as a flood
- Trigger: A steered agent opens many payment asks to wear the owner down.
- Expected: One open ask per (wallet, recipient) at a time; an identical call while one waits joins it (as held requests do); after Don't pay the tool tells the agent the owner declined and does not reopen within the task.
- Mitigation: Dedup in the start commit; Never pay sets Deny.

**SEC-051** · security · low: A payment to a Deny recipient
- Trigger: Agent calls wallet__send to a recipient set to Deny.
- Expected: Refused in words ('the owner doesn't pay 0x9f…'), no card, no notification.
- Mitigation: Deny checked in the start commit, before a draft would open.

**SEC-052** · security · medium: Another agent asks for the payment
- Trigger: A group member messages 'pay X'.
- Expected: Foreign content (law 4): the agent's own rules apply; a group grants no wallet (law 3).
- Mitigation: Wallet access per agent; no group-level wallet.

**SEC-053** · security · medium: The reason text disguises the card
- Trigger: The agent's reason holds bidi overrides, zero-width characters, markdown or a fake address line.
- Expected: Reason rendered as plain quoted text with bidi controls stripped; recipient, amount and token come from typed fields, never from text.
- Mitigation: Card component test with adversarial strings in the specimen.

### Recipient rules and labels

**SEC-054** · best · high: First payment sets the rule
- Trigger: Owner taps 'Always pay {name}' on a first-payment card.
- Expected: In one commit: the draft is approved, the rule Always and the label are stored; later payments to that recipient run without asking and still show as cards.
- Mitigation: Existing approval-with-scope commit; 'nothing is asked twice' answers other open asks it covers.

**SEC-055** · security · critical: A rule binds identity, never a label
- Trigger: Owner renames a recipient, or two recipients get similar names.
- Expected: Always binds (wallet, chain, checksummed address) or (wallet, observed origin+path, payTo, asset, network); renaming changes only what cards say.
- Mitigation: Property test: any sequence of renames leaves coverage of every call unchanged.

**SEC-056** · edge · medium: Two recipients with one name
- Trigger: Owner names two addresses 'Ana', or a label differs only by case, width or a confusable letter (Cyrillic А).
- Expected: A label equal to another recipient's under NFKC, case folding and the UTS #39 confusable skeleton is refused, or shown with its short address everywhere.
- Mitigation: Label normalisation in the commit that names it.

**SEC-057** · race · medium: The rule changes while a payment waits
- Trigger: Owner sets Deny (or Always on another card) while a payment to the same recipient waits for its draft.
- Expected: Re-checked at start: Deny refuses it; Always answers it (nothing asked twice).
- Mitigation: Rule resolved in the start commit (RFC).

**SEC-058** · race · medium: Deny set after the payment started
- Trigger: Owner sets Deny after the nonce commit and signature.
- Expected: The payment goes (it is already signed and stored); the UI says it was already sent when the rule changed.
- Mitigation: Start commit as the single linearisation point; never 'cancel' by abandoning a nonce (SEC-099).

**SEC-059** · security · high: Always set for one agent covers another on a shared wallet
- Trigger: Requirement 6 lets several agents use one wallet; the RFC says rules belong to a wallet 'so to one agent'.
- Expected: Always binds (wallet, agent, recipient), as a permission binds one agent; Deny may be wallet-wide (narrowing is safe); the Recipients list shows per agent.
- Mitigation: Decision D3; property test: an Always from agent A's card never covers agent B.

**SEC-060** · race · medium: Two agents ask to pay the same new recipient
- Trigger: Two agents sharing a wallet hit the same new address at once.
- Expected: Two cards (different agents, different amounts); Always on one covers only its agent (SEC-059).
- Mitigation: Dedup key includes the agent.

**SEC-061** · security · medium: After a restart the card offers no standing answer
- Trigger: A payment ask reopened by a run a crash interrupted.
- Expected: Consistent with permissions (offeredScopes returns none for an interrupted run): Pay and Don't pay only, no Always.
- Mitigation: Reuse offeredScopes; test.

**SEC-062** · edge · low: Forgetting a recipient
- Trigger: Owner forgets Ana.
- Expected: Rule and label go; history keeps past payments with the address; the next payment asks.
- Mitigation: One commit.

**SEC-063** · edge · low: Labels reach the model provider
- Trigger: wallet__recipients returns the owner's labels.
- Expected: Accepted; the provider sees every prompt (DESIGN.md Trust), named in Settings.
- Mitigation: Words only.

### Address poisoning

**SEC-064** · security · high: A look-alike of a known recipient
- Trigger: A new address whose first and last hex digits match a recipient or a recent counterparty (USENIX 2025; spike P1 finds a 2+2 match in about a minute in JS, GPU tools far faster).
- Expected: The card shows the full checksummed address in groups of four and warns 'looks like Ana's address but is different' when 3 or more leading and trailing digits match; never only the truncated form.
- Mitigation: Deterministic prefix/suffix gate (P1 flagged every look-alike); the rule binds the full address.

**SEC-065** · security · high: Poisoned entries in the transaction list
- Trigger: Attackers send 0-value or dust transfers from a look-alike so it appears in history.
- Expected: Incoming 0-value and dust token transfers from unknown senders are hidden or marked; no 'send again' from an incoming entry of an unknown sender.
- Mitigation: History filter in the daemon, not the UI alone.

**SEC-066** · edge · medium: An all-lowercase address
- Trigger: Owner pastes, or the agent passes, an address with no checksum (P1: a typo is undetectable).
- Expected: Mixed case with a bad checksum is refused; lowercase is accepted but the card always shows the checksummed form, and an owner Send to a new lowercase address asks for a second look.
- Mitigation: One parser for all inputs.

**SEC-067** · edge · medium: A destination that cannot receive
- Trigger: The zero address, the token contract itself, the wallet's own address, a precompile.
- Expected: Refused in the tool with words.
- Mitigation: Structural deny list in the signer request builder.

**SEC-068** · edge · medium: A contract as recipient
- Trigger: Recipient address has code on that chain.
- Expected: The card says 'this is a contract'; the rule binds the chain.
- Mitigation: eth_getCode before drawing the card.

**SEC-069** · security · medium: Names resolved remotely
- Trigger: Agent passes 'ana.eth' or another name.
- Expected: No name resolution for agent calls (a remote label would be a label that resolves); owner Send may resolve later, shows and binds the address.
- Mitigation: Tool schema accepts addresses only.

### x402

**SEC-070** · best · high: An agent pays an observed 402
- Trigger: Agent code requests a paid API through the proxy; the proxy records the 402; the agent calls wallet__pay_x402(observation).
- Expected: Rule resolved for the observed endpoint; the daemon signs EIP-3009 TransferWithAuthorization for the observed amount, pinned USDC domain, random nonce persisted before release, validity of minutes; the paid retry succeeds.
- Mitigation: Proxy observation + idempotent effect keyed by the observation.

**SEC-071** · security · critical: A forged challenge in the tool's arguments
- Trigger: A page hands the agent a challenge 'from' an Always endpoint with its own payTo.
- Expected: The tool accepts only an observation id; amount, asset, payTo, network and endpoint are read from the proxy's record, never from arguments.
- Mitigation: Tool schema; test that arguments beyond the id are refused.

**SEC-072** · security · high: Another chat's observation
- Trigger: The agent names an observation recorded under another chat or agent.
- Expected: Refused: an observation is bound to the chat whose login made the request.
- Mitigation: Check in the start commit.

**SEC-073** · security · high: Cross-resource substitution
- Trigger: The challenge's resource field names another URL than the one observed (arXiv 2605.30998).
- Expected: The rule binds the observed origin and path; a challenge naming another origin or path is refused.
- Mitigation: Observation-only identity.

**SEC-074** · security · high: payTo changed since the rule
- Trigger: An Always endpoint starts answering with another payTo.
- Expected: Asks again; payTo is part of the rule's identity.
- Mitigation: Rule key includes payTo, asset and network.

**SEC-075** · security · high: Wrong asset, network, scheme or token domain
- Trigger: asset is not the pinned USDC for the chain, network not configured, scheme not exact, or extra.name/version disagree with the pinned domain ('USD Coin' on Base, 'USDC' on Base Sepolia).
- Expected: Refused before signing.
- Mitigation: Per-chain table pinned in code (x402 research recommendation 2).

**SEC-076** · security · medium: A long-lived authorization
- Trigger: maxTimeoutSeconds is hours or days.
- Expected: validBefore is capped at minutes whatever the server asks.
- Mitigation: Cap in the signer.

**SEC-077** · security · medium: The signed authorization in the box
- Trigger: Box code holds the bearer signature and sends it elsewhere (anyone can submit it; it still pays payTo, but the resource is not delivered).
- Expected: The proxy attaches the payment header to exactly the observed method and URL, once, before validBefore; the box gets a handle, never the signature.
- Mitigation: Reuse the proxy's credential swap (DESIGN.md: credentials are set at the proxy).

**SEC-078** · race · high: The same observation paid twice
- Trigger: The agent calls twice, or the daemon crashes after signing.
- Expected: One authorization per observation: the second call returns the stored one; the nonce is stored before the signature leaves.
- Mitigation: Idempotent effect; fault points after signing and after release.

**SEC-079** · race · medium: The paid retry fails after settlement
- Trigger: The facilitator settled but the server errored; the agent gets a new 402.
- Expected: The new 402 is a new observation and follows the rule (Always pays again); before paying the same endpoint again within the earlier validity, the daemon checks authorizationState(nonce) on chain and tells the agent the earlier payment settled.
- Mitigation: Reconcile by reading the chain, not by retrying (x402 research recommendation 6).

**SEC-080** · edge · medium: A 402 after redirects
- Trigger: An Always origin redirects to another origin that answers 402.
- Expected: The observation is the hop that answered 402; its own origin's rule applies.
- Mitigation: The proxy records the final request it made.

**SEC-081** · security · high: Price steered through the query
- Trigger: The rule ignores the query; the endpoint prices by query (?tier=premium); injection picks the costly one.
- Expected: Always pays it, up to the balance (requirement 3); the Always button says 'whatever it asks, up to what's in the wallet'; a price far above earlier ones is reported, not blocked.
- Mitigation: Decision D4: a re-ask on a price jump would be a per-payment limit, which requirement 3 rules out.

**SEC-082** · security · high: An unauthenticated origin
- Trigger: The 402 came over plain HTTP, or upstream TLS is not verified.
- Expected: Plain-HTTP endpoints are not payable; the observation is trusted only as far as the proxy verified the upstream certificate (mitmproxy verifies by default; the addon does not set ssl_insecure: confirm in the x402 spike).
- Mitigation: Observation records the scheme and verification; refuse otherwise.

**SEC-083** · security · medium: Parser confusion between x402 v1 and v2
- Trigger: A body challenge and a PAYMENT-REQUIRED header disagree, duplicate headers, several EVM entries in accepts.
- Expected: One TypeBox schema per version; any ambiguity is refused, not resolved by guessing.
- Mitigation: Own parser for the payer path; no SDK on the signing path.

**SEC-084** · security · low: A 402 seen by the agent's browser
- Trigger: A page in the agent's browser answers 402.
- Expected: Not payable through the tool in slice 3; the browser's reads are the page's.
- Mitigation: Observations only from command logins.

### Signing guards

**SEC-085** · security · critical: EIP-7702 delegation
- Trigger: Any request that would produce a type 0x04 transaction or sign an authorization tuple (MAGIC 0x05; chain_id 0 is valid on every chain).
- Expected: Impossible: the signer has no code path that builds either.
- Mitigation: Whitelist-typed signer (SEC-088); a property test over generated requests.

**SEC-086** · security · critical: Approvals and permits
- Trigger: approve, increaseAllowance, setApprovalForAll, EIP-2612 permit, Permit2 or DAI-style permit, directly or nested in a multicall.
- Expected: Refused: they reach funds not yet in the wallet, breaking 'the balance is the cap'. No wallet__call before slice 5; then a selector allow-list, exact amounts consumed in the same transaction, no multicall.
- Mitigation: Signer refuses unknown calldata; refusal tests (RFC spike list).

**SEC-087** · security · critical: Raw and personal signatures
- Trigger: eth_sign, personal_sign (EIP-191), or typed data outside EIP-3009 for pinned USDC domains.
- Expected: Refused.
- Mitigation: No generic sign function exists.

**SEC-088** · security · high: A generic signing function creeps in
- Trigger: A refactor adds signBytes or signTypedData(any) 'for convenience'.
- Expected: The signer exposes only: EIP-1559 transfer of native value; ERC-20 transfer(to, amount) for listed tokens; EIP-3009 TransferWithAuthorization for pinned domains.
- Mitigation: A test that enumerates the signer module's exports; review with severity (principle 11).

**SEC-089** · edge · high: The chain id comes from the RPC
- Trigger: A wrong or malicious RPC reports another chain id.
- Expected: chainId is pinned per configured chain in code; eth_chainId disagreeing takes the wallet offline for that chain.
- Mitigation: EIP-155 / typed tx chainId from the pinned table only.

**SEC-090** · edge · medium: Non-standard tokens
- Trigger: Fee-on-transfer, no-return tokens, a token listed by a page.
- Expected: Only tokens banda lists (USDC first) are sent; the receipt's Transfer log is checked against the amount.
- Mitigation: Listed tokens in the shipped definition; library ABI encoding.

**SEC-091** · security · high: The wallet already has code
- Trigger: The key leaked and someone set a 7702 delegation (0xef0100 || address) that sweeps incoming funds.
- Expected: Before each payment and at load, eth_getCode(wallet) must be empty; otherwise offline 'this wallet's key was used elsewhere'.
- Mitigation: One read per payment; test on anvil with a delegated account.

### Balance is the cap

**SEC-092** · security · critical: No signature reaches money not in the wallet
- Trigger: Any generated signer request.
- Expected: Every signature moves at most the value it names, from the wallet's current balance, and none grants an allowance or a delegation over later funds.
- Mitigation: Property test over the signer: the sum of what a signature can move is bounded by the balance it names at signing, and only shipped shapes are signed.

**SEC-093** · edge · medium: Fees drain the balance
- Trigger: A wrong fee suggestion or a loop of reverting transactions burns gas (L2 gas + L1 fee + operator fee).
- Expected: maxFeePerGas capped at a multiple of recent base fee; each transaction simulated (eth_call) before signing and refused if it would revert; fees shown on the card.
- Mitigation: Fee guard and simulation in the effect before the nonce commit.

**SEC-094** · edge · low: USDC but no gas
- Trigger: Wallet holds USDC and no ETH.
- Expected: A token send says 'needs a little ETH for fees'; x402 still works (gasless for the payer).
- Mitigation: Pre-check before the draft.

**SEC-095** · security · medium: Airdropped tokens with instructions in their names
- Trigger: Scam tokens named 'Claim at evil.example' arrive.
- Expected: Unlisted tokens are hidden or shown as 'unknown token' without their names as links; when the agent reads them they are framed as foreign data.
- Mitigation: Listed tokens only in balance; law 4 framing.

**SEC-096** · edge · low: Agents sharing a wallet share the cap
- Trigger: Two agents use one wallet.
- Expected: Settings shows which agents may use each wallet and says they share its balance.
- Mitigation: Words.

**SEC-097** · race · low: Owner withdraws while an agent pays
- Trigger: Owner Send and an agent payment at once.
- Expected: Both go through the one nonce ledger; one may fail for funds; the chain enforces the cap.
- Mitigation: Shared pipeline (RFC).

### RPC

**SEC-098** · security · high: A false 'failed' leads to a second payment
- Trigger: The RPC reports a receipt as failed or missing for a transaction that landed; the agent pays again.
- Expected: The agent is told 'not confirmed yet' until the account nonce at a safe block passes the transaction's; 'failed' only from a status-0 receipt at a safe block; the result says another call is a new payment.
- Mitigation: Receipt state machine on the nonce, not on one RPC answer.

**SEC-099** · security · high: A nonce abandoned while its transaction is still out there
- Trigger: A dropped transaction is held by an RPC or mempool; banda sends a new payment at a new nonce; the old one lands later. EIP-1559 transactions do not expire.
- Expected: A signed nonce is never abandoned: it ends as that transaction or as a same-nonce replacement or cancel (+10% fees), and later payments queue behind it.
- Mitigation: Nonce ledger in the store; replacement as a step of the same task (RFC); fault point on replacement.

**SEC-100** · security · medium: An RPC URL with a key in it
- Trigger: Owner sets a provider URL like https://…/v2/<apikey>.
- Expected: Kept in auth/, not in config.json or the store; scrubbed from errors and logs (fetch errors print URLs); never sent to the box or a prompt.
- Mitigation: Treat as a credential (DESIGN.md Connections: credentials never reach the box, a prompt, an entry, the store or a log).

**SEC-101** · security · medium: Plain-HTTP or private-address RPC
- Trigger: Owner sets http:// or a name that resolves to a private address.
- Expected: https only, except loopback for anvil in development and tests.
- Mitigation: Validation when the RPC is set.

**SEC-102** · security · medium: The RPC lies about balance, nonce or fees
- Trigger: A malicious or wrong RPC.
- Expected: Balance is shown, never trusted for a cap; nonce is the store's, reconciled upward with the chain; fees capped (SEC-093). A lying RPC can delay or mislead, never make banda sign more.
- Mitigation: Store-owned nonce ledger (chain-operations research: pending tag is unreliable on Base).

**SEC-103** · security · low: The RPC learns who the owner is
- Trigger: Every call reveals the addresses and the owner's IP, linking all wallets.
- Expected: The RPC is a named choice in Settings with its public default said plainly (RFC).
- Mitigation: Words; reads come from the daemon, never the box.

**SEC-104** · error · low: The RPC is down or rate limited
- Trigger: 429s (the public Base endpoint refused every eth_getLogs in the chain research probe).
- Expected: Balance shows 'as of'; a broadcast retries the same stored bytes; no new signature.
- Mitigation: Idempotent broadcast.

### Supply chain

**SEC-105** · security · critical: A dependency is compromised
- Trigger: A malicious version of a crypto or keychain package exfiltrates keys or swaps recipients (chalk/debug 2025, Ledger Connect Kit 2023, Solana web3.js 2024: signing-libraries research).
- Expected: Only the noble/scure 2.4.0 line, micro-eth-signer 0.20.1 and @napi-rs/keyring 2.1.2, pinned exactly with lockfile integrity; npm ci --ignore-scripts; npm audit signatures and provenance in CI; no x402 SDK or viem in the signing path.
- Mitigation: Principle 13; a CI check of the dependency set of the signer module.

**SEC-106** · security · high: A native binary swapped
- Trigger: The platform package (@napi-rs/keyring-darwin-arm64 and siblings, via optionalDependencies) is replaced.
- Expected: Lockfile pins every platform package with integrity; release bundles them; provenance verified in CI.
- Mitigation: Release materials check.

**SEC-107** · security · medium: A typosquat
- Trigger: ethers-v6 (MAL-2026-11297), @wrenfield/viem.
- Expected: Only exact allow-listed names in the wallet module's imports.
- Mitigation: CI name check.

**SEC-108** · security · medium: An upgrade changes signing semantics
- Trigger: A library update changes a default (chain id, v value, typed-data encoding).
- Expected: Known-answer tests (EIP-155, EIP-1559, EIP-712, the EIP-3009 typehash 0x7c7c6cdb…) fail before release.
- Mitigation: Pinned vectors in tests.

**SEC-109** · security · high: The app's own files are swapped
- Trigger: The web bundle a browser device loads from app.banda.rocks is replaced (SECURITY.md).
- Expected: It can do what the owner can from a device (Send, Always), not reveal keys (SEC-023).
- Mitigation: D2 limits device sends; release-only builds on that origin (existing).

### Secrets at rest and in transit

**SEC-110** · security · critical: The key in the store, a backup or a fork
- Trigger: Any code path writing the key to durable.db, blobs, config, auth/ or a backup.
- Expected: Never: the store holds the keychain name and the address; backups and forks copy those, not the key.
- Mitigation: Scenario test scanning every file of a temp home (and a backup of it) for each wallet key.

**SEC-111** · security · medium: Signed bytes in the store
- Trigger: The raw signed transaction and the EIP-3009 authorization are checkpointed (RFC); backups and forks carry them.
- Expected: A fork never broadcasts or releases them (wallets offline in a fork, SEC-120); authorizations expire in minutes; a stored transaction is the one intended, so a rebroadcast is harmless.
- Mitigation: Fork marks wallets offline; validity cap.

**SEC-112** · security · medium: Real wallet data in the public repo
- Trigger: A PR proof, test fixture, kept home or commit message carries a real address, tx hash, balance or label.
- Expected: Only invented data: anvil's well-known test accounts on a throwaway home, faux provider; the export specimen shows an invalid dummy key.
- Mitigation: AGENTS.md 'what a home holds stays on the machine'; fixtures generated from fixed test keys.

**SEC-113** · security · medium: Logs and activity
- Trigger: Logging a request, an error or an effect.
- Expected: Addresses and amounts may appear (owner-local); keys, RPC keys and live authorization signatures never.
- Mitigation: Signer errors carry codes; a log scrubber for the RPC URL; test.

**SEC-114** · security · medium: Financial data to the model provider
- Trigger: Balances, history and labels enter the prompt when the agent reads them.
- Expected: Accepted and said in Settings beside the provider (DESIGN.md Trust); a pasted key is stopped (SEC-024).
- Mitigation: Words; the paste check.

**SEC-115** · security · low: Push notifications
- Trigger: A payment ask notifies the phone through a push service.
- Expected: Says 'Mara asks to pay' with no amount, address or label, as harness asks never show the command.
- Mitigation: Notification text rule and test.

### Box boundary

**SEC-116** · security · critical: The key or a signing capability in the box
- Trigger: Any tool result, file or header the box receives.
- Expected: Only results: addresses, balances, receipts, an x402 handle. No key, no signer, no signature (SEC-077).
- Mitigation: Law 5 and the box's mounts (no auth/, no store); a box-suite test that greps the box filesystem and environment after a payment.

**SEC-117** · security · medium: Wallet data leaves through reads
- Trigger: The agent puts history or balances into a GET to a public host (reads pass).
- Expected: Existing policy: a read to a public host goes unasked (law 6). Accepted, said in the wallet's words.
- Mitigation: None new; noted for the confidentiality section.

**SEC-118** · security · medium: Another agent's process makes observations as this chat
- Trigger: In the shared box one agent's code uses another chat's proxy login (SECURITY.md).
- Expected: It can create an observation under that chat; it still takes that chat's model calling pay_x402, under its rules; the card names the chat.
- Mitigation: Per-agent boxes later (docs/isolation.md).

**SEC-119** · security · high: A wallet file in the workspace
- Trigger: The box writes /workspace/wallets.json with rules or recipients.
- Expected: Ignored: wallet records, rules and access are store facts of a connection banda ships, never files.
- Mitigation: Connections exception to principle 2; law 5.

### Homes, forks and backups

**SEC-120** · security · high: A fork tries to spend
- Trigger: `npm run home:fork` copies the store (wallet records, nonces, checkpoints) but not auth/device-id (scripts/fork-home.ts copies token and egress.json only).
- Expected: Wallets in the fork are offline ('a copy of another home'), reads only; no broadcast, no release, no signing, even if the keychain name would match.
- Mitigation: The lease (SEC-014) plus a fork marker; test that a forked home cannot sign with a shared in-memory keystore.

**SEC-121** · security · high: A restored backup beside its original
- Trigger: An in-app restore keeps the replaced home among the backups; the owner serves it too.
- Expected: Only the lease holder signs (SEC-014).
- Mitigation: Lease.

**SEC-122** · edge · medium: A backup restored on a new computer
- Trigger: Machine lost, backup restored elsewhere.
- Expected: Wallets offline 'key not on this computer'; the saved export opens the funds in any wallet app; an import is a separate, host-only owner feature if ever wanted (decision D5).
- Mitigation: Words; no key in backups.

**SEC-123** · security · medium: Tests touch the real keychain
- Trigger: A test constructs the real KeyStore.
- Expected: Tests inject the in-memory keystore; a guard fails any test that opens the OS keychain except with a banda-spike- name that it deletes.
- Mitigation: Test helper and lint.

### Owner's own wallet use

**SEC-124** · best · medium: Owner Send
- Trigger: Owner sends from Settings > Wallets.
- Expected: Address parsed and shown checksummed, look-alike gate, confirm screen (amount, token, chain, fee, full address), then the same pipeline as agents (nonce, sign, checkpoint, broadcast). An owner send never creates or changes an agent's recipient rule.
- Mitigation: Shared effect; separate rule store.

**SEC-125** · race · high: Owner Send submitted twice
- Trigger: Double click, or a phone retrying over a slow relay.
- Expected: One payment: the client's idempotency key deduplicates in the commit.
- Mitigation: Idempotency key required on the route.

**SEC-126** · security · medium: Receive shows a wrong address
- Trigger: A bug or a tampered record shows an address that is not the key's.
- Expected: Receive shows the record's address, which was verified against the key at the last unlock (SEC-008); a wallet never unlocked since start shows 'not verified yet' until it is.
- Mitigation: Verification at start for each wallet with an available keychain.

### Trust laws

**SEC-127** · security · high: The money exception reaches other tools
- Trigger: A custom MCP tool or another connection declares itself a wallet to escape the money floor.
- Expected: Only the shipped wallet connection's write tools run under recipient rules; every other money tool stays on the floor (law 2 unchanged for them).
- Mitigation: The exception is keyed to the shipped definition's hash, not to a name; property test.

**SEC-128** · security · high: A reviewer model approves a payment
- Trigger: A triage model flags or clears a payment.
- Expected: It may only change what the owner is shown; it never answers an ask or sets a rule (law 7). The look-alike and label warnings are code.
- Mitigation: No model in the admission path.

**SEC-129** · security · medium: An interrupted payment
- Trigger: Crash at any wallet fault point.
- Expected: Broadcast is idempotent (same stored bytes); x402 release is memoized; no payment effect is unsafe, so none opens a retry-or-skip Wait and the model never re-issues one.
- Mitigation: Fault sweep at the RFC's fault points plus the keychain write and the nonce release.

## Tests and spikes this analysis asks for

- **Property tests** (ordinary suites, run counts from `test/pbt.ts`): INV-S1 (scan a temp home, its backup and a
  heap snapshot after generated payment scenarios), INV-S2 (generated steered calls against generated rule sets,
  agents and wallets), INV-S3 (renames interleaved with calls), INV-S4 (generated signer requests, including type
  0x04, 0x05 messages, approve/permit/Permit2 calldata, multicall, eth_sign), INV-S5 (forged arguments beside real
  observations), INV-S6 (nonce ledger under drops and replacements), INV-S7 (two homes and a fork over one in-memory
  keystore), INV-S9 (keystore values swapped between unlocks).
- **Fault points** (`test/fault/`), beyond the RFC's list: both sides of the keychain write at creation (SEC-005), the
  nonce release when no signature exists (SEC-012), the x402 release after signing (SEC-078), the lease move between
  homes (SEC-014).
- **Spikes still open**: a signed-bundle keychain ACL run, and a hardened signer helper with a keychain access group
  (SEC-010, SEC-011, D6); the headless and locked Secret Service in Docker (SEC-034, SEC-035); whether the pasteboard
  markers keep a copied key off Universal Clipboard (SEC-028); whether Time Machine carries the login keychain
  (SEC-016); the proxy's upstream certificate verification for x402 observations (SEC-082).

## Sources

Accessed 2026-11-23 unless stated.

- Repository: `docs/wallets.md`; `DESIGN.md` ("Trust", "Clients", "Home", "The box", "Connections", "Messages");
  `SECURITY.md` (unsigned Mac app; app.banda.rocks serves a browser device's files; shared box logins);
  `src/core/floor.ts`; `src/core/permissions.ts` (`covering`, `offeredScopes`: no scope for an interrupted run);
  `src/home.ts` (`auth/device-id`, "not a credential"); `scripts/fork-home.ts` (copies `auth/token` and
  `auth/egress.json`, links `auth/providers.json`, pauses routines); `proxy/addon.py`.
- Research in this folder's sibling `../research/`: `wallet-security.md` (address poisoning, USENIX Security 2025
  https://www.usenix.org/conference/usenixsecurity25/presentation/tsuchiya; ElizaOS memory injection
  https://arxiv.org/abs/2503.16248; Freysa and Grok/Bankr incidents; agent-wallet products), `x402.md` (v1/v2,
  EIP-3009, USDC domains read on chain, arXiv 2605.30998 https://arxiv.org/html/2605.30998v1), `os-keychain.md`
  (@napi-rs/keyring 2.1.2, keytar archived, ACLs tied to code signatures, fail closed), `signing-libraries.md`
  (noble/scure 2.4.0, micro-eth-signer 0.20.1, supply-chain incidents, typosquats MAL-2026-11297 and
  @wrenfield/viem), `chain-operations.md` (Base Denim 200 ms blocks, pending tag, error strings, nonce ledger, public
  RPC limits).
- EIP-7702, Set Code for EOAs: SET_CODE_TX_TYPE 0x04, MAGIC 0x05, chain id 0 for universal authorizations, delegation
  indicator 0xef0100 || address. https://eips.ethereum.org/EIPS/eip-7702
- EIP-55 (mixed-case checksum), EIP-155 (chain id in signatures), EIP-191 (signed data, personal_sign), EIP-2612
  (permit), EIP-3009 (transferWithAuthorization): https://eips.ethereum.org/EIPS/eip-55 ,
  https://eips.ethereum.org/EIPS/eip-155 , https://eips.ethereum.org/EIPS/eip-191 ,
  https://eips.ethereum.org/EIPS/eip-2612 , https://eips.ethereum.org/EIPS/eip-3009 (specifications, cited for their
  definitions; not re-read in full in this pass).
- Electron `BrowserWindow.setContentProtection`: prevents capture by other apps; "newer Mac applications that use
  ScreenCaptureKit will capture your window despite win.setContentProtection(true)".
  https://www.electronjs.org/docs/api/browser-window ; history of capture paths ignoring it:
  https://github.com/electron/electron/issues/19880
- Pasteboard markers for secrets (org.nspasteboard.ConcealedType, TransientType), a community convention honoured by
  clipboard managers: http://nspasteboard.org/
- Unicode confusable detection (skeletons): UTS #39, https://www.unicode.org/reports/tr39/
- Spikes K1, K2, M1, P1: [`spikes/security-trust/`](spikes/security-trust/README.md), run 2026-11-23 on darwin-arm64,
  Node v24.22.1.
