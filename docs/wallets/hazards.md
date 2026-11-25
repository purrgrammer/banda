# Wallet hazards: the merged catalog

Status: analysis for the RFC in [`../wallets.md`](../wallets.md), dated 2026-11-23. Nothing here is a DESIGN.md rule
(principle 6): each case names the mechanism that would hold it and the test or spike that proves it. This file
replaces, for the slices that follow, the three lens catalogs it was merged from:

- [`analysis/hazards-durability-concurrency.md`](analysis/hazards-durability-concurrency.md) (`DUR-nnn`, 124 cases)
- [`analysis/hazards-security-trust.md`](analysis/hazards-security-trust.md) (`SEC-nnn`, 129 cases)
- [`analysis/hazards-product-lifecycle.md`](analysis/hazards-product-lifecycle.md) (`PRO-nnn`, 129 cases)

and adds the cases a completeness pass found missing (marked `new (critic)`) or that a spike surfaced after the lens
catalogs were written (marked `new (spike)`). Every merged case lists the source ids it absorbs, so nothing is lost:
the three catalogs' 382 cases map onto the entries below, and the source ids stay valid for tracing.

The deterministic concurrency rules the cases cite as `C1` to `C23` are in [`conflicts.md`](conflicts.md). The
libraries and the key model are in [`stack.md`](stack.md).

## How to read an entry

```
**H-nnn** · kind · severity · triage · Title
- Trigger: what happens.
- Expected: what the system must do.
- Mitigation: the mechanism that gives it (banda's own first: store commits, Waits, drafts, permissions, idempotent
  effects, proxy observations), and the test or spike that proves it.
- Rules: the conflicts.md rules it relies on · From: the source cases it merges.
```

**Kinds.** best (the path that must work), error (something fails), edge (an unusual but legal input or state), race
(two actors or a crash and an actor interleave), security (an adversary acts).

**Severity** (one scale for the three lenses; a merged case takes the highest of its sources):

- **critical**: money moves twice, moves against the owner's latest rule, reaches a recipient the owner never
  approved, or a signature reaches money not in the wallet; or a key leaves the owner's control or is lost with funds
  on it.
- **high**: funds stuck until a person acts, funds within the balance misdirected without the owner's payment, the
  agent or the owner told something false about money, two homes signing for one wallet, a law of DESIGN.md "Trust"
  weakened, or the feature unusable on a supported platform.
- **medium**: recoverable without loss, but a false alarm, a delay, a confusing state, a denial of service or a
  privacy leak of addresses and amounts.
- **low**: cosmetic, self-healing, or a residual the owner accepted.

**Triage.**

- **design rule**: the mechanism is structural and belongs in the design (then DESIGN.md once spiked); a slice cannot
  ship without it.
- **implementation note**: a correct design already covers it; the note tells the implementer what to get right and
  what to test.
- **out of scope**: accepted residual or someone else's problem; the entry says why.

## Decisions this catalog depends on

The lens catalogs disagreed in places. These are resolved here, with the reason, and the entries follow them.

| # | Question | Sources that disagreed | Resolution |
|---|---|---|---|
| R-1 | When is a nonce taken? | RFC "Paying exactly once" step 1 reads as at admission; DUR, PRO, nonce spike say at signing | In the lane's **start commit**, after approval and after the key was read and proven (C4). A waiting or refused draft holds nothing. |
| R-2 | Separate "reserve nonce" and "checkpoint" commits, or one? | DUR splits B3/B5; nonce spike recommends "fused" | **One commit** (fused): re-check admission, take the nonce, store the signed bytes. It removes the "reserved, unsigned" state (SEC-012's release path) and two fault points; the burn point is that commit (C4). |
| R-3 | Is signing deterministic? | RFC says RFC 6979; both spikes measured micro-eth-signer hedging by default | Every signature passes `extraEntropy: false` and a test pins golden vectors (C6), but **safety never rests on determinism**: the checkpoint precedes the broadcast. |
| R-4 | When may a payment move to a new nonce after a foreign transaction took its nonce? | DUR I9 says `safe`; nonce spike R6 says `finalized` and measured a double payment at `latest` | **`finalized`** (about 20 min on Base). The case is rare (exported key used elsewhere), the wait is cheap, the error is a double payment (C7). Confirmed, Failed and Cancelled are states only at `finalized`; `safe` is shown as "Included (safe)", a display, not a state (C12). |
| R-5 | EIP-3009 nonce: random and persisted, or derived? | RFC, research and x402 spike: random 32 bytes persisted; DUR I7: derived | **Derived and committed**: `keccak256("banda/x402" ‖ wallet ‖ observation id)`, written with the message before any signature exists. A re-sign after any crash, even one that lost the commit, yields the same authorization, which the token accepts once (C14). |
| R-6 | Does the x402 SDK sign in the daemon? | x402 research: pin `@x402/fetch`; x402 spike: the official client signs 10-year windows and `approve(Permit2, 2^256-1)` | **No SDK on the payer path.** The daemon builds the payload itself (stack.md). |
| R-7 | Whose rules on a wallet several agents share? | DUR-119 and PRO-043: the wallet's; SEC-059: Always per agent | **Owner decision OD-1**, recommended default: the recipient, its label and **Deny** are the wallet's; **Always** binds (wallet, agent, recipient), as every banda permission binds one agent. The second agent's first card offers "Always pay Ana for Sancho too". |
| R-8 | How is "I saved the key" confirmed? | PRO D4: type the last 4 characters; keys spike: paste the key back and compare the derived address | **Paste-back check** (derive and compare); it catches any transcription error, the last-4 check catches few. Skipping stays possible and leaves the wallet marked Not backed up. |
| R-9 | An x402 Ask approved hours after the 402 | DUR-145: refuse past `maxTimeoutSeconds`; PRO D10: sign at approval with a fresh window if the observation is under a day old | **PRO D10**: the payer chooses the window (x402 spike: the facilitator accepts a shorter one and sets no upper bound), so the daemon signs at approval with a window from chain time, if the observation is under 24 h old (the Ask deadline); the server judges the price again on the retry. |
| R-10 | One unconfirmed transaction per lane, or several in nonce order? | DUR I2: one; nonce spike R8: rebroadcast all unconfirmed in nonce order | **One** (C5). It removes nonce gaps, cascading evictions (nonce spike section 7) and out-of-order replacement as a class; R8 still applies to all versions of that one nonce. Raise only with a measured need on Base Sepolia. |
| R-11 | Networks per wallet | RFC: "the chains"; DUR-059: a lane per (wallet, chain); PRO D9: one network per wallet | **One network per wallet, fixed at creation** (OD-9); a testnet wallet is another wallet. The lane is then per wallet. |
| R-12 | What names a home, and what lets it sign | RFC: "the home's own id"; banda-integration spike: put `auth/device-id` in the keychain service name; SEC-121 and DUR-153: a restored backup must not sign beside its original | **The id names, the lease decides.** The keychain account carries a home id for findability; signing needs the lease of C16, proven by a home secret kept outside the home directory: a keychain item `<home-id>/home-secret` bound to the home's realpath, its folder's inode and birth time (no birth time on Linux; no device number, which a remount can change: spikes/home-binding), so no backup, restore, fork or hand copy (`cp -a`, rsync, Time Machine) carries a secret that matches. |
| R-13 | The keychain account name | PRO and SEC: a random name committed before the write; keychain spike: `<home-id>/wallet/<address>` | **The address** (keychain spike): the `creating` record holds the address before the write, so recovery never guesses, a retried create can only ever write that one key, and nobody can plant an item for an address not yet made. |

Owner decisions (each entry that depends on one names it):

| # | Decision | Decided |
|---|---|---|
| OD-1 | Rule scope on a shared wallet | Recipient, label and Deny per wallet; Always per (wallet, agent) |
| OD-2 | Reveal the key after creation | Host only, in the desktop app, behind an OS re-authentication, listed in the wallet's activity |
| OD-3 | Owner Send from a paired device | Only to recipients the wallet already knows; a new address is confirmed on the host |
| OD-4 | An Always endpoint raises its price | Pay and report the jump (requirement 3 excludes an amount limit) |
| OD-5 | x402 recipient granularity | Exact origin and path; a prefix only as an explicit owner widening worded as its consequence |
| OD-6 | Key import into a new wallet | None; only "Restore key" for an existing record whose address the key derives |
| OD-7 | QR payload | Plain checksummed address until a spike shows EIP-681 with chain id reads right in common wallets |
| OD-8 | An Ask over the available balance | Refused at the call, with the available amount; no draft |
| OD-9 | Networks per wallet | One, fixed at creation |
| OD-10 | A routine's payment ask nobody answers | Deadline 24 h (`DEFAULT_DEADLINE`), then "Not paid: no answer" |
| OD-11 | A separate, signed signer helper with a keychain access group (narrows TA-1) | Designed and spiked as its own step (wallets.md, Spikes). A precondition for wallets beside a coding agent on macOS: until it ships, any connected coding agent takes wallets offline (H-065) |
| OD-12 | A burst pause on Always (drop to Ask after N payments an hour) | Off: not built, not even as an opt-in. Requirement 2 makes the balance the only cap |
| OD-13 | A wallet default of Deny for unknown recipients | Ask (requirement 3: the first payment to an unknown recipient asks); Deny only as the owner's opt-in per wallet. Under Deny an unknown recipient or endpoint is refused in words with no card, and the change refuses open unknown-recipient asks in its commit (C9) |

## Trust assumptions (from the security lens, kept)

- **TA-1** The owner's OS account is trusted, and only the owner's own acts are: code running as the owner on the
  computer banda runs on can read every wallet key (spike K1: the macOS keychain authorises the binary, not the
  script; any `node -e` read every item in 24 ms). Code banda launches as the owner that an agent can steer (host
  mode, a connected coding agent, a development branch run against a `home:fork`) is not the owner: while any of it
  can run, wallets are offline for every agent with the reason shown (H-064, H-065). OD-11 is the only structural
  narrowing on macOS; on Linux nothing structural protects the key, and the wallet says so. The balance bounds the
  loss.
- **TA-2** What banda ships is trusted: its release and its pinned dependencies (stack.md), and for a browser device
  the files app.banda.rocks serves.
- **TA-3** The model, the box, every page and every other agent are untrusted: they can steer calls, never admit them.
- **TA-4** The RPC is untrusted for what it reports (balances, nonces, receipts, fees, chain id): it can delay and
  mislead, never make banda sign more than the shapes and values banda chose.
- **TA-5** The chain's consensus is trusted at `finalized`; `safe` (batched to L1) is trusted for what the owner is
  shown, never for re-signing at a new nonce (R-4).

## Cases

### 1. Key lifecycle

**H-001** · best · high · design rule · A wallet is created on the computer banda runs on
- Trigger: the owner taps Create wallet in Settings → Wallets (or "Give Mara a wallet"), names it and picks its
  network.
- Expected: the daemon's signer draws 32 bytes with noble's `randomSecretKey` over `crypto.getRandomValues`, rejects
  0 and ≥ n, derives the address, commits a `creating` record holding the address, checks that the keychain account
  `<home-id>/wallet/<address>` is empty, writes it, reads it back, derives again and only then commits the wallet as
  ready (keychain spike, "What it means for the design" 1 and 2). The address, QR and Save your key step appear only
  after that commit. The wallet is on for no agent. No key byte reaches the store, a log, the box or a prompt.
- Mitigation: the two-store ordering of C15; a property test scanning store, blobs, `auth/` and logs for every key
  after create, sign and restart; derivation known-answer vectors from the keys spike.
- Rules: C14, C15 · From: SEC-001, PRO-001

**H-002** · error · critical · design rule · The random source fails or is replaced
- Trigger: `crypto.getRandomValues` throws or returns early, or a dependency or a test helper shims it.
- Expected: creation fails in words ("banda could not make a key on this computer"); nothing is committed; never a
  fallback to `Math.random`, time or a counter.
- Mitigation: only noble's generator on `node:crypto`; a lint rule bans other random sources in the signer module; a
  test injects a throwing source and asserts no record; release builds exclude test helpers (stack.md controls).
- Rules: C15 · From: SEC-002

**H-003** · edge · low · implementation note · A scalar out of range
- Trigger: the random bytes equal 0 or are ≥ the secp256k1 order.
- Expected: the library rejects and redraws; banda never reduces modulo n by hand.
- Mitigation: library generator only; the keys spike checked 2000 keys in [1, n−1] and refusals of 0, n and 31 bytes.
- Rules: — · From: SEC-003

**H-004** · security · high · design rule · A key or seed offered by the agent, a page or the box
- Trigger: a steered agent says "use this key / seed phrase", or a page offers a ready-made wallet.
- Expected: no tool imports or derives a key from anything the model or the box provides; keys are generated only in
  the signer; the only way a key enters is the owner's host-only "Restore key" on an existing record (OD-6).
- Mitigation: least tools (law 3): the wallet connection's tool list is shipped; no import tool exists.
- Rules: — · From: SEC-004

**H-005** · race · critical · design rule · The daemon is killed around the keychain write, or before the owner saw the key
- Trigger: SIGKILL after the `creating` commit and before or after the keychain write, or after the write and before
  `ready`.
- Expected: at the next start a `creating` record is reconciled: its item present and deriving its address means
  ready and the Save your key step is offered again; absent means the record is dropped. An item without a record is
  listed as an orphan, never adopted by a later wallet. The owner never sees an address whose key is not durably in
  the keychain, and Receive (address and QR) is withheld until the owner saved the key or skipped explicitly, so no
  funds land on a key nobody saved.
- Mitigation: C15; the account name carries the address, which the `creating` record holds, so recovery never
  guesses and a retried create can only ever write that one key; fault points on both sides of the write in
  `test/fault/`.
- Rules: C14, C15 · From: SEC-005, PRO-002, DUR-125, DUR-126

**H-006** · error · critical · design rule · The keychain write succeeds but the read-back fails or differs
- Trigger: the write returns success but reading it back returns null, another value, or an error.
- Expected: creation fails; no address is ever shown for funding.
- Mitigation: write, read back, derive, compare, then commit ready (C15); a test with the in-memory keystore
  returning another value.
- Rules: C15 · From: DUR-044

**H-007** · race · medium · design rule · Create tapped twice, or on two devices
- Trigger: a double tap, or the desktop and a paired phone both submit.
- Expected: one wallet per deliberate submit: a double tap makes one; two devices' distinct submits make two, each with
  its own key, address and keychain account; never two writes to one account.
- Mitigation: a client request id per form instance, deduplicated in the `creating` commit (C14).
- Rules: C14 · From: SEC-006, PRO-005, DUR-127

**H-008** · edge · low · design rule · One independent key per wallet, exported as a raw key
- Trigger: the owner looks for 12 or 24 words, or imports the saved key into another wallet app.
- Expected: the export says Private key: `0x` + 64 hex, beside the address it opens, and how other wallets import it
  (Import account → Private key). No phrase: each wallet has its own random key, so one leak loses one wallet.
- Mitigation: keys-and-signing spike verdict (independent keys; raw key round-trips for 2000 keys; seed path
  conventions differ between wallets); stack.md key model.
- Rules: — · From: PRO-014, SEC-032

**H-009** · best · high · design rule · The key exists only inside the signing call
- Trigger: any signature or export.
- Expected: the signer reads the secret as bytes, signs, zeroes the buffers; callers receive signed bytes, never the
  key; nothing caches it. Spike M1: after this pattern no copy is reachable in a heap snapshot.
- Mitigation: an opaque signer API with no getter, in its own process (C20); a test runs a payment and asserts the key
  is absent from a heap snapshot with M1's positive control.
- Rules: C20 · From: SEC-018

**H-010** · security · critical · design rule · A retained reference leaks the key
- Trigger: the key ends up in an Error message or stack, a pi-durable memo or checkpoint, an effect's arguments, a log
  line, a debug cache or a closure (spike M1 control: one retained reference keeps it in every snapshot).
- Expected: impossible by construction: the key never leaves the signer; signer errors carry fixed codes, never inputs;
  effects store only signed bytes.
- Mitigation: property test scanning store, blobs, logs and a heap snapshot after generated payment scenarios; a lint
  rule forbids memo, checkpoint and log calls in the signer module; the keystore wrapper rethrows with fixed messages.
- Rules: C20 · From: SEC-019, PRO-009

**H-011** · security · critical · design rule · Key bytes reach the store through a durable task, a Wait or a stream
- Trigger: creation, export or signing is written as a pi-durable task step, a memoized call, a Wait answer or an SSE
  event, so the key lands in `durable.db`, which backups and `home:fork` copy.
- Expected: the key exists only in the keychain and, for one signature or one export, in the signer's memory.
- Mitigation: creation, export and signing read the key outside tasks; checkpoints hold signed bytes only; the
  property test of INV-S1 scans `durable.db`, blobs, `search.db`, logs, config and a backup for every form of the key
  (hex, 0x-hex, base64, raw bytes).
- Rules: C15, C20 · From: PRO-008, SEC-110

**H-012** · security · medium · implementation note · The daemon runs with an inspector or heap-dump flags
- Trigger: `--inspect`, `NODE_OPTIONS` with `--inspect` or `--heapsnapshot-signal`, or a diagnostics attach.
- Expected: wallets are offline (reason: debugging is on) while an inspector is active or such flags are present.
- Mitigation: a start check on `process.execArgv`, `NODE_OPTIONS` and `inspector.url()` in the daemon and the signer
  process; test in a child process.
- Rules: C20 · From: SEC-020

**H-013** · edge · low · out of scope · Freed memory, swap and crash dumps
- Trigger: freed heap pages are not scrubbed (M1 proves unreachability only); the OS swaps or hibernates them; a crash
  reporter dumps.
- Expected: accepted residual of a hot wallet: the exposure is one signature; no key cache; core dumps stay off.
- Mitigation: none beyond no cache. Out of scope because no JS runtime offers scrubbed memory; the balance bounds
  the loss (TA-1).
- Rules: — · From: SEC-021

**H-014** · security · critical · design rule · "Restore key" with a key that opens another address
- Trigger: after "key missing" the owner pastes a key that derives another wallet's address, or a random one.
- Expected: refused unless the key derives the record's address; a restore never changes a wallet's identity and never
  makes a second record for the same address.
- Mitigation: derive and compare before the create-only keychain write; the restore route is host-only like the
  export (C15, C16).
- Rules: C15, C16 · From: new (critic), extends PRO-102

### 2. Keychain

**H-015** · best · high · design rule · The key is read in-process by banda's signer, never through argv, env or a CLI
- Trigger: any signature or export.
- Expected: the signer process reads the item through `@napi-rs/keyring` 2.1.2 `AsyncEntry`; no `security` or
  `secret-tool` child ever carries the secret in argv or env; the key never crosses into the daemon process.
- Mitigation: one KeyStore interface inside the signer (C20); if a CLI fallback is ever used, `security -i` on stdin
  with the key stored as ASCII hex, fault-tested for newlines (os-keychain research 5).
- Rules: C20 · From: SEC-009

**H-016** · security · critical · design rule · Any process run by the same Node binary reads every key
- Trigger: spike K1: a second script in another folder read the item silently in 24 ms. A coding agent on the host, a
  host-mode command, an npm script or malware can run the bundled Node and read the wallets; on Linux an unlocked
  Secret Service answers any process of the user without a prompt.
- Expected: stated as TA-1, not hidden: Settings → Wallets, the create page and a coding agent's enable card (once a
  wallet exists) say a program the owner runs can use the wallets and to deny another app the keychain asks about;
  host mode signs nothing (separate entry); the export still needs the desktop gesture.
- Mitigation: words where the owner grants it; the keychain item carries no label of banda's (@napi-rs/keyring sets
  none on macOS or Windows), so the words stand where the owner sees them; OD-11 signer helper with a keychain access
  group, after a signed-bundle spike; the balance bounds the loss.
- Rules: C20 · From: SEC-010, SEC-040, PRO-103, PRO-104

**H-017** · edge · high · design rule · An update changes the binary the keychain trusts
- Trigger: the Mac app is signed ad hoc (`identity: "-"`), so the bundled Node's designated requirement is its cdhash
  and every release that changes the binary makes the first read of each wallet's item raise a keychain prompt (keychain
  spike: an ad hoc reader of another binary's item prompted, 8.7 and 9.4 s until answered; two Node.js-signed installs
  of different versions read each other's items silently); or the owner alternates the desktop app and `banda serve`
  from another Node.
- Expected: the wallet shows "needs keychain access again" with the fix; payments wait in one owner Wait per lane; the
  daemon never makes a new key for an existing wallet.
- Mitigation: a Developer ID signature (a team-based requirement a newer binary satisfies) is the prerequisite for a
  quiet upgrade, still to run on banda's own bundle; until then the "needs the owner" state says what to click; the
  address proof of C16 makes a silent replacement impossible; deadline per call (C20).
- Rules: C16, C20 · From: SEC-011, PRO-105

**H-018** · error · high · design rule · A keychain call blocks on a prompt nobody answers
- Trigger: a macOS access prompt after an update, or a locked Secret Service collection raising a D-Bus prompt
  (keychain spike: headless, the prompter fails and the call errors in 9 to 17 ms with "unlock prompt was dismissed";
  with a display and nobody answering, the call was still pending at 8 s; on macOS `AbortSignal.timeout(6000)` did
  not abort a call that returned at 9.4 s, because napi-rs cancels a task only before it starts).
- Expected: only that wallet waits; chats, streams and other agents carry on; after the deadline the wallet is offline
  ("the keychain is waiting for you").
- Mitigation: C20: each keychain call runs in a short-lived child started from `process.execPath` (so macOS sees the
  daemon's code identity), one at a time per home, killed by the daemon at its deadline; never `Entry` or `AsyncEntry`
  on the daemon's own threads.
- Rules: C20 · From: DUR-041, SEC-035, PRO-106

**H-019** · error · medium · implementation note · The keychain reports an ambiguous entry
- Trigger: keyring returns Ambiguous: another program wrote a second matching credential.
- Expected: wallet offline with the reason; nothing deleted automatically; the owner resolves it in Keychain Access.
- Mitigation: map Ambiguous to an explicit offline reason; error injection in the in-memory keystore.
- Rules: C20 · From: SEC-013

**H-020** · security · critical · design rule · Two homes, or two daemons, sign with one key
- Trigger: a backup or an in-app restore keeps the replaced home and the owner serves both; a home copied by hand; a
  second machine with the key restored; the RFC names the item by "the home's own id", which does not exist today
  (`auth/device-id` is "not a credential").
- Expected: exactly one home signs for a wallet. The other is offline ("this wallet is used by another banda home")
  until the owner moves it there explicitly. Repeated foreign use of the lane's nonces pauses the lane.
- Mitigation: the wallet lease of C16 (an epoch beside the key in the keychain and in the store, and a home secret in a
  file no fork copies), compared at every unlock; the foreign-nonce pause of C7; test with two temp homes over one
  in-memory keystore.
- Rules: C7, C16 · From: SEC-014, SEC-121, DUR-056, DUR-153

**H-021** · error · critical · design rule · The keychain item is gone
- Trigger: deleted in Keychain Access, keychain reset, macOS user migration, reinstall, or a restore on another
  machine.
- Expected: "Key missing from this computer"; reads keep working; new payments refused in words; payments past the
  burn point keep tracking and rebroadcasting (they need no key); a stuck one cannot be replaced and the owner is told;
  "Restore key" accepts only a key that derives this address; never a new key under the old record.
- Mitigation: `getPassword` on a missing entry returns null, not an error (os-keychain spike 2); post-burn stages read
  only the store (C4); address proof (C16).
- Rules: C4, C16 · From: SEC-015, PRO-102, DUR-042

**H-022** · edge · medium · implementation note · The OS backs up the keychain
- Trigger: the login keychain goes into Time Machine (encrypted with the login password; to confirm); Linux keyrings
  follow the distribution's backup.
- Expected: said in Settings → Wallets: banda's backups never hold the key; the OS's may.
- Mitigation: words; spike whether Time Machine carries the login keychain. A restored older keychain item meets the
  lease check (C16).
- Rules: C16 · From: SEC-016

**H-023** · edge · low · implementation note · The item's name says what it is
- Trigger: someone at the unlocked computer opens Keychain Access.
- Expected: items are findable for recovery ("banda wallet 0x12ab…9f04"); reading the secret still needs the login
  password; the name never contains the key.
- Mitigation: accepted trade-off, findability over discretion.
- Rules: — · From: SEC-017

**H-024** · security · critical · design rule · A planted or pre-existing item under the wallet's name
- Trigger: another program, a stale test or a second home wrote an item under the account about to be used (spike K2
  and the keychain spike: the module adopts a planted item silently, and a sequential `setPassword` replaces an
  existing one silently on both platforms).
- Expected: creation reads the account first and refuses if it holds anything (with the account named after a fresh
  address, nobody can plant it without already knowing the new key); the signer never overwrites (that would destroy a
  funded key) and never adopts (the owner would fund an address someone else knows).
- Mitigation: KeyStore has `create` (get must be null, then set, then read back) and no update; address proof at every
  unlock (C15, C16).
- Rules: C15, C16 · From: SEC-007

**H-025** · security · critical · design rule · The key in the keychain does not open the wallet
- Trigger: the item was replaced after creation, a keychain restored from another machine, a name collision between
  homes, or a bug writing the wrong item.
- Expected: at every unlock the derived address is compared with the record; a mismatch takes the wallet offline
  ("the key in this computer's keychain is not this wallet's"); nothing is signed or rewritten.
- Mitigation: the address in the store is the identity; the key proves it each time (C16); test swapping the
  in-memory keystore's value between unlocks.
- Rules: C16 · From: SEC-008, DUR-043

**H-026** · error · high · design rule · The keychain is locked when the lane needs to sign
- Trigger: auto-lock after sleep or inactivity while a routine pays at night; a Linux keyring locked after a reboot
  with nobody logged in.
- Expected: nothing is burnt (the key is read before the start commit); the payment stays queued; the lane opens one
  owner Wait ("unlock the keychain to pay"), not one per payment; later payments queue behind it; approval deadlines keep
  running; reads keep working; no retry loop; the model is told, never asked to retry.
- Mitigation: C4 ordering; C20 deadline; one Wait per lane.
- Rules: C4, C20 · From: DUR-040, SEC-033, PRO-098

**H-027** · race · high · design rule · A nonce taken while the key cannot be read
- Trigger: under a split design the nonce is reserved, then the keychain locks, prompts or is missing.
- Expected: the state cannot exist: the lane reads and proves the key before the one commit that takes the nonce and
  stores the signed bytes, so a nonce is never held unsigned and never needs releasing.
- Mitigation: fused start commit (R-2, C4); fault point between the key read and the commit.
- Rules: C4, C5 · From: SEC-012, DUR-013

**H-028** · error · high · design rule · No keychain banda can use
- Trigger: Linux over SSH, under systemd, in a container or a CI runner, with no Secret Service; or the write is
  refused at creation (locked, denied).
- Expected: creating a wallet is refused with who, what and the fix; existing records are offline; no file, env var
  or systemd-creds fallback; Settings → Wallets explains what makes one available.
- Mitigation: fail closed (os-keychain recommendation 4); the keychain spike's state table maps the messages: "no
  result found" on the canary set (no keyring), "org.freedesktop.secrets was not provided by any .service files" or
  "set your DBUS_SESSION_BUS_ADDRESS instead" (no Secret Service); every error is `GenericFailure`, so classification
  matches message prefixes, each with a test, and the version is pinned.
- Rules: C20 · From: DUR-045, SEC-034, PRO-003, PRO-107

**H-029** · edge · critical · design rule · Linux silently stores the key in the kernel keyring
- Trigger: with no Secret Service, `@napi-rs/keyring` 2.1.2 falls back by default to keyutils, which lives in memory
  and is lost at reboot.
- Expected: banda never puts a wallet key in keyutils; the wallet cannot be created there.
- Mitigation: every entry is built with `{ linux: { store: 'secret-service' } }` so it throws instead (package README,
  2.1.2); a unit test asserts the option on every KeyStore call.
- Rules: C20 · From: PRO-004

**H-030** · security · high · design rule · A test or debug keystore reachable in a release
- Trigger: an env var or flag selects the in-memory or a file keystore in a released build ("for headless").
- Expected: impossible: the in-memory keystore exists only in test builds and is injected by the harness; no env var
  selects a keystore.
- Mitigation: build-time exclusion; a release smoke check that the module is absent.
- Rules: — · From: SEC-036

**H-031** · security · high · design rule · Tests or throwaway homes touch the real keychain
- Trigger: a test constructs the real KeyStore; a manual run with `BANDA_HOME=$(mktemp -d)` creates real items and the
  folder is deleted.
- Expected: tests get the in-memory keystore structurally (from the test home), never by a check that could be
  skipped; a guard fails any test that opens the OS keychain except under a `banda-spike-` name it deletes; a sweep
  lists banda items whose home is gone and offers to delete those with no balance.
- Mitigation: test helper and lint; service names carry the home's id; the sweep's listing call (`findCredentials`)
  was not run by the keychain spike and is open.
- Rules: C16 · From: DUR-155, SEC-123, PRO-109

**H-032** · race · high · design rule · Hung keychain calls starve the daemon's thread pool
- Trigger: keychain spike (Linux in Docker, Xvfb display, prompt unanswered): with four `get` calls behind the
  prompt, `fs.readFile` and `crypto.pbkdf2` never completed in the 7.5 s that followed; libuv's default pool of four
  threads is shared with `fs`, `crypto` and `dns.lookup`.
- Expected: a stuck keychain never stalls the daemon's file system, crypto or DNS work.
- Mitigation: C20: keychain and signing in a separate signer process the daemon can SIGKILL; one call in flight per
  wallet; the deadline is enforced by the daemon, not by the native call.
- Rules: C20 · From: new (spike)

**H-033** · race · critical · design rule · The signer process dies in the middle of a call
- Trigger: the signer child crashes, is OOM-killed, or the daemon kills it at the deadline while it signs or reads.
- Expected: the daemon treats the call as not done: nothing was committed (the start commit happens in the daemon after
  the signer returns signed bytes), so the lane retries with a new signer; a reveal shows nothing and can be asked
  again; a creation follows C15 recovery.
- Mitigation: C20 (signer isolated and killable), C4 (only the daemon commits); the signer's call boundary is a fault
  point in `test/fault/` (principle 10: each new effect a slice adds).
- Rules: C4, C15, C20 · From: new (critic)

**H-034** · error · medium · design rule · The daemon cannot exit or upgrade while a keychain call hangs
- Trigger: a pending native call keeps the process alive past `process.exit` (keychain spike: still alive 12 s after
  `process.exit(0)`, ended by SIGKILL; libuv joins every pool thread at exit).
- Expected: shutdown, restart and upgrade never wait on the signer; a stuck signer is killed and restarted.
- Mitigation: the daemon owns the signer's lifetime (C20); the desktop app's quit path kills it.
- Rules: C20 · From: new (spike)

**H-035** · race · medium · design rule · A keychain answer arrives after the deadline
- Trigger: the owner answers a prompt after the lane already marked the wallet offline.
- Expected: a late answer is discarded (each call carries a request id); the next attempt reads again; no signature is
  made from a call the lane gave up on.
- Mitigation: request ids on signer calls (C14, C20).
- Rules: C14, C20 · From: new (critic)

**H-036** · race · critical · design rule · Two first writes to one keychain account at once
- Trigger: two creations or a creation and a restore race on the same account (keychain spike: 8 concurrent first sets
  on Linux all reported success and kept the last writer's key, so 7 keys were lost silently; on macOS 1 succeeded and
  7 failed with "already exists").
- Expected: never happens: one keychain operation in flight per home, through one queue in the daemon; with the account
  named after the address, two creations never share an account anyway.
- Mitigation: C20 (the signer queue); C15.
- Rules: C15, C20 · From: new (spike)

**H-037** · error · critical · design rule · A keychain that cannot answer looks like a missing key
- Trigger: on Linux with a session bus but no default collection, `get` returns `null` and `delete` returns `false`,
  the same answers as a missing item (keychain spike, "notstarted").
- Expected: `null` never means "make a key" and never, alone, means "key missing": the signer sets, gets and deletes a
  canary account `<home-id>/canary/<slot>`, one of a few the home overwrites and never found by listing the keychain; if the canary works the wallet's key is missing, otherwise the canary's error names
  the keychain state.
- Mitigation: the canary in every "key missing" decision; tests per state of the spike's table.
- Rules: C16, C20 · From: new (spike)

**H-038** · security · high · implementation note · Items written through `security` trust `/usr/bin/security`
- Trigger: a macOS fallback writes items with `security -i`; any later `security` process of the user reads them with
  no prompt (keychain spike).
- Expected: banda writes items only through `@napi-rs/keyring` from its own binary, so the ACL names banda's Node, not
  a tool every process can run; `security -i` is at most a read-only diagnostic.
- Mitigation: one KeyStore implementation (C20).
- Rules: C20 · From: new (spike)

### 3. Wallet management

**H-039** · best · low · implementation note · Several wallets listed in Settings → Wallets
- Trigger: the owner opens Settings → Wallets with three wallets.
- Expected: one row each: name, short address (full on tap), balance per token with "as of" when stale, Not backed up
  mark, network (Testnet marked), agents that use it; archived wallets apart.
- Mitigation: rows derived from wallet records and the latest balance readings (C22); nothing counts or nags.
- Rules: C22 · From: PRO-015

**H-040** · edge · medium · design rule · Testnet and mainnet funds confused; one address on two chains
- Trigger: the owner has a Base Sepolia wallet and a Base wallet; or someone thinks a wallet spans both.
- Expected: one network per wallet, fixed at creation (OD-9); a testnet wallet carries a Testnet mark on every row,
  card and QR caption; no tool switches a wallet's network; EIP-155 binds each signature to its chain.
- Mitigation: the network is part of the wallet record and of every recipient identity; the lane is per wallet (R-11).
- Rules: C2 · From: PRO-080, DUR-059

**H-041** · edge · low · implementation note · Wallet names collide or carry control characters
- Trigger: two wallets named Travel, or a name with bidi overrides or newlines.
- Expected: a name is one plain line; a duplicate is warned; tools and cards always add the short address; the id is
  the address, never the name.
- Mitigation: the plain-line rule artifact titles use.
- Rules: — · From: PRO-017

**H-042** · best · high · design rule · The owner archives a wallet that holds funds
- Trigger: wallet → Archive.
- Expected: in one commit the wallet is off for every agent and its open asks are refused; payments past the burn point
  finish; the key stays; listed under Archived with its balance; restorable.
- Mitigation: C17; Archive asks first in its own verb.
- Rules: C4, C17 · From: PRO-099

**H-043** · security · critical · design rule · The owner deletes a wallet with funds or with something in flight
- Trigger: wallet → Delete (removal) with a balance, a payment on its way, or a live x402 authorization.
- Expected: refused while any version is non-terminal, any authorization is live, or the balance at `safe` is above
  zero; the refusal says what is pending; otherwise the confirmation says the key is deleted and later funds are lost
  unless the key was saved.
- Mitigation: C17 gates; C15 removal ordering; a removal would otherwise orphan a burnt nonce and lose the means to
  replace it.
- Rules: C15, C17 · From: PRO-100, DUR-114, DUR-130

**H-044** · error · high · design rule · Removal killed between the store and the keychain
- Trigger: SIGKILL between the `removing` commit, the keychain delete and the `removed` commit.
- Expected: a resume finishes the removal in order; nothing is half removed; the address never shows as receivable
  once `removing` committed.
- Mitigation: C15 ordering with fault points around the keychain delete.
- Rules: C15 · From: DUR-128

**H-045** · security · critical · design rule · An orphan keychain item found at start
- Trigger: an item named like banda's wallets with no record in the store (a store restored from before the wallet, an
  interrupted removal of another home).
- Expected: listed in Settings as "a key without a wallet" with Export and Delete; never deleted automatically, since
  it may hold a funded key.
- Mitigation: C15: no automatic keychain deletion outside the owner's removal flow.
- Rules: C15 · From: DUR-129

**H-046** · edge · high · implementation note · Funds arrive after archive or delete
- Trigger: a client pays the old address.
- Expected: archived: shown, spendable after restore; deleted: invisible to banda, recoverable only with the saved key,
  as the delete confirmation said.
- Mitigation: archived wallets keep their balance reading; words on Delete.
- Rules: C17 · From: PRO-101

**H-047** · race · medium · design rule · Owner Send from a wallet being archived
- Trigger: the owner's Send and an Archive tap on another device land together.
- Expected: ordered by commit: if the Send's start commit came first it proceeds; otherwise the Send is refused
  ("Travel is archived; restore it to send").
- Mitigation: C17: the start commit checks the wallet's state; archived wallets do not send.
- Rules: C1, C4, C17 · From: new (critic)

**H-048** · race · high · design rule · A key reveal while removal is in progress
- Trigger: the owner opens Show private key on the host while a removal of the same wallet runs.
- Expected: once `removing` is committed every reveal capability for that wallet is void and the reveal is refused; a
  reveal that already returned is the owner's copy.
- Mitigation: reveal reads the keychain only for a wallet in state ready, checked in the commit that consumes the
  one-time capability (C15, C17).
- Rules: C15, C17 · From: new (critic)

**H-049** · race · critical · design rule · Two lanes for one wallet
- Trigger: a restart, a bug or a migration starts the wallet's lane task twice.
- Expected: impossible: the lane's task id is derived from the wallet id and started in a commit only if absent; one
  process owns the store (home lock).
- Mitigation: C2 with pi-durable's single owner per storage; a fault test that starts the lane twice.
- Rules: C1, C2 · From: new (critic)

**H-050** · race · low · design rule · Wallet settings edited from two devices
- Trigger: rename or default change from the phone and the desktop at once.
- Expected: the tap that names the current version wins; the other changes nothing and redraws.
- Mitigation: C8 versioned owner acts.
- Rules: C8 · From: new (critic)

### 4. Agent assignment

**H-051** · best · high · design rule · The owner switches a wallet on for an agent
- Trigger: agent → Connections → Wallets → Travel on; or the enable card when an agent asks.
- Expected: one commit records (agent, wallet) as on, within the wallet connection the owner turned on; the agent's
  wallet tools appear from its next turn and name only the wallets it was given; recipients and rules start empty
  for that pair (OD-1).
- Mitigation: the connection's per-agent choice the store holds (principle 2: a connection is a choice, never a
  file); the tool list is computed per turn from that choice.
- Rules: C3, C17 · From: PRO-041, SEC-037

**H-052** · error · high · design rule · The connection model's existing auth shapes do not fit a wallet
- Trigger: banda-integration spike: a built-in connection must be an OAuth REST adapter; `auth: "key"` is bound to the
  connection's URL (for a wallet, the RPC) and its value is scrubbed; `secrets()` throws on any credential that is not
  `key` or `oauth`, which would break scrubbing home-wide.
- Expected: the wallet is a connection with its own tool builder and its own credential kind (`{keychain account,
  address, network}`, never a secret value), and `secrets()` handles it; the first stored wallet shape arrives with a
  `MIGRATIONS` step (format 4 to 5) so an earlier build refuses the home instead of crashing in `secrets()`.
- Mitigation: the spike's shape table; `test/stored-shapes.test.ts`; a kept home under `test/fixtures/homes/`.
- Rules: C23 · From: new (spike)

**H-053** · security · high · design rule · An agent pays from a wallet it was not given
- Trigger: the model passes another wallet's address or name, or an id it saw in a message or a page.
- Expected: refused at admission ("Mara has no wallet named Savings"), before any rule is read; nothing queued; the
  refusal names no other wallet.
- Mitigation: admission check 2 in C3 (agent on for the wallet) resolves the wallet only among the agent's own;
  property test generating wallet arguments across agents.
- Rules: C3 · From: SEC-042

**H-054** · race · high · design rule · A wallet switched off for an agent while its payment is in progress
- Trigger: the owner switches Travel off for Mara while her payment is queued, waiting in an Ask, or past the burn
  point.
- Expected: before the burn point the payment is refused in the start commit ("Travel was switched off for Mara");
  its open Ask is refused; past the burn point the payment finishes and is reported. The switch-off and the start
  commit are ordered by the store, never by timing.
- Mitigation: the start commit re-checks C3 inside the same transaction (C4); open asks are swept in the switch-off
  commit (C17).
- Rules: C3, C4, C17 · From: PRO-042, SEC-043, DUR-112

**H-055** · edge · low · implementation note · An agent archived or deleted with a waiting payment
- Trigger: the owner archives Mara while her Ask is open or her Always payment is queued.
- Expected: archive refuses her open asks and queued payments in the same commit; payments past the burn point finish
  and stay in the wallet's list under her name; deleting the agent keeps the rows (the name, not a dangling id).
- Mitigation: lifecycle gate C17; rows carry the agent's name at the time.
- Rules: C17 · From: PRO-044, DUR-097

**H-056** · edge · low · implementation note · An agent needs to pay but has no wallet
- Trigger: a page asks Mara to pay; the wallet connection is off, or on with no wallet for her.
- Expected: the tool is absent; if the agent asks the owner in words, the enable card offers to give her a wallet
  (pick one or create one); the agent never sees an address to fund.
- Mitigation: the enable card pattern every connection uses; prompt names wallets only when given.
- Rules: C3 · From: PRO-045

**H-057** · best · medium · design rule · An agent with two wallets picks one
- Trigger: Mara has Travel and Office; she calls `wallet__send` without saying which, or with a label.
- Expected: the tools take an optional `account` that names no wallet, the same for every agent (H-072); a missing or
  ambiguous `account` from an agent with several wallets is refused with the agent's own wallets only, each as its
  name and short address; the draft card and the result name the wallet.
- Mitigation: which wallet a call reads or pays from is resolved in the commit that lets it run, against the agent's
  wallets then; identity is the address (C18).
- Rules: C3, C18 · From: PRO-081, PRO-082

**H-058** · race · low · implementation note · A wallet given or taken away during a conversation
- Trigger: the owner adds Office for Mara mid-chat, or removes Travel while a turn is running.
- Expected: tool definitions change at the next turn; a call made in the running turn with the old list is checked at
  admission against the current choice (C3), so a removed wallet is refused.
- Mitigation: admission reads the store, never the turn's cached tool list; the prompt-cache cost of a changed tool
  list is measured with `npm run cache:audit` (principle 14).
- Rules: C3 · From: PRO-083

**H-059** · edge · low · implementation note · An agent pays from within a group
- Trigger: Mara in a group with Sancho is asked to pay.
- Expected: the payment is Mara's (her wallet, her rules); the card says so in the group's chat; Sancho cannot answer
  it and cannot spend from her wallet.
- Mitigation: admission by the calling agent's identity (C3); the card's actor is the owner.
- Rules: C3, C9 · From: PRO-123

**H-060** · security · medium · design rule · Another agent asks for the payment
- Trigger: Sancho, who has no wallet, asks Mara in a group or by message to pay someone.
- Expected: Mara's call is checked like any other of hers; the card shows the payment as Mara's with Sancho's request
  as context; Sancho's words never carry authority.
- Mitigation: law 2 (the model steers, never admits); the rule check binds (wallet, agent, recipient) (C18).
- Rules: C3, C18 · From: SEC-052

**H-061** · security · critical · design rule · The box reaches owner routes
- Trigger: code in the box calls the daemon's HTTP API, the wallet routes or the export route.
- Expected: impossible structurally: the box reaches only its proxy and the gateway's agent routes; wallet routes are
  owner routes behind the owner's token, which the box never holds.
- Mitigation: the existing box boundary (DESIGN.md "Trust"); the box suite asserts the wallet routes are unreachable
  from inside the box.
- Rules: — · From: SEC-039

**H-062** · security · critical · design rule · The key or a signing capability in the box
- Trigger: a design shortcut mounts a signer socket, a key file, or an x402 signer into the box "for convenience".
- Expected: never: the box holds no key and no way to ask for a signature except the agent's tool call, admitted by
  the daemon; the signed x402 payload the box receives is bounded by C18.
- Mitigation: principle 4 and 5; a box test asserts no wallet socket, env or file is mounted.
- Rules: C18, C20 · From: SEC-116

**H-063** · security · high · design rule · A wallet file in the workspace
- Trigger: a definition file in the workspace names a wallet, its rules or its recipients, and the agent edits it.
- Expected: wallets, rules and recipients live only in the store as owner choices (principle 2's connection
  exception); nothing in the workspace grants money.
- Mitigation: no wallet definition file exists; a test asserts the workspace has no wallet-shaped file read by the
  daemon.
- Rules: — · From: SEC-119

**H-064** · security · critical · design rule · Host mode gives every command the wallets
- Trigger: `serve --box host`, where agents' commands run as the owner (TA-1: same-user code reads the keychain).
- Expected: in host mode wallets are offline for agents (reason: "agents run commands on this computer"); the
  owner's own Send still works; the onboarding of host mode says so.
- Mitigation: admission check 6 in C3 (lease, online, host mode); a test serves with `--box host` and asserts refusal.
- Rules: C3 · From: SEC-041

**H-065** · security · critical · design rule · A coding agent on the host uses the owner's authority
- Trigger: a harness (coding agent) running on the host reads the owner's token or the keychain.
- Expected: treated like host mode (H-064): while any coding agent is connected, whatever its mode and whichever
  agents it serves, wallets are offline for every agent ("a coding agent on this computer could read the keys"); the
  owner's own Send stays. A harness's mode does not prove it asks the owner before each command, so until OD-11 ships
  every connected coding agent counts as one that does not. A reveal is not on the daemon's HTTP API at all (C16), so
  the token gives nothing. On Linux the wallet says plainly that nothing structural protects the key.
- Mitigation: admission check 6 of C3 reads "no coding agent connected"; a test connects a coding agent for no agent
  and finds the wallet offline, and online again once it is gone; OD-11.
- Rules: C3, C16, C20 · From: SEC-040

**H-066** · security · critical · design rule · A gateway client or an inference caller reaches the wallet tools
- Trigger: an external client of banda's gateway, or a direct inference call, lists or calls `wallet__*` tools.
- Expected: wallet tools exist only inside an agent's turn, admitted against that agent's choice; the gateway and the
  inference route expose no wallet tool and no wallet route.
- Mitigation: tool registration per turn; a test enumerates gateway tools.
- Rules: C3 · From: new (critic)

**H-067** · security · high · design rule · The money exception reaches other tools
- Trigger: a later change reuses the wallet's "the owner can say Always for a recipient" path for other tools, or a
  tool other than the wallet's signs.
- Expected: the exception is the wallet connection's alone: only its tools reach the signer; no other permission
  gains a standing answer that spends.
- Mitigation: one importer module for signing (stack.md); a test enumerates callers of the signer.
- Rules: C20 · From: SEC-127

**H-068** · security · high · design rule · A reviewer model approves a payment
- Trigger: an "auto-approve with a model" setting, or a group's other agent answering the card.
- Expected: only the owner's tap answers a payment card; no model answer counts.
- Mitigation: Waits answered only by the owner's routes (C9); test.
- Rules: C9 · From: SEC-128

**H-069** · security · medium · out of scope · Wallet data leaves through the agent's other reads
- Trigger: the agent reads its balance and history and then puts them in a web request.
- Expected: accepted: what the agent may read it may say; the owner chooses which agents get a wallet.
- Mitigation: none beyond least access. Out of scope because reads are the feature; the address and history are public
  on chain anyway.
- Rules: — · From: SEC-117

**H-070** · security · medium · implementation note · Financial data reaches the model provider
- Trigger: tool results with balances, labels and history go to the provider like any tool result.
- Expected: said once in the wallet's enable card; tool results carry short addresses and the recipient's label,
  never more than the call needs.
- Mitigation: result shapes reviewed against `test/prompt-budget.test.ts`.
- Rules: — · From: SEC-114, SEC-063

**H-071** · security · high · design rule · The tool's wallet enum names wallets the agent was not given
- Trigger: banda-integration spike: `multiAccount` lists every account's label in the `account` argument of every
  agent's schema, and an unlabeled account's label is its address, so Mara's prompt carries Sancho's wallet names and
  addresses (`accountFor` still refuses them).
- Expected: no agent's schema names a wallet: one schema, the same for every agent, with an optional `account`; an
  agent's own wallets are named only in the refusal that asks it to choose, and another agent's never; a wallet always
  has a name.
- Mitigation: the wallet's own tool builder offers that one schema instead of `multiAccount`'s; a test compares two
  agents' first-step schemas and finds no wallet named.
- Rules: C3 · From: new (spike)

**H-072** · edge · medium · implementation note · Wallet tools grow every chat's prompt
- Trigger: the wallet tools are added to agents that have no wallet, or carry long descriptions.
- Expected: tools appear only for agents with a wallet; `test/prompt-budget.json` moves only with a measured, stated
  reason.
- Mitigation: the prompt budget test; `npm run prompt:budget`.
- Rules: — · From: new (critic)

### 5. Recipients and rules

**H-073** · best · high · design rule · The first payment to a recipient sets its rule
- Trigger: Mara pays an unknown address; the card offers Pay once, Always, Deny, with a label field.
- Expected: Pay once pays this payment and records the recipient as Ask; Always records (wallet, Mara, address) as
  Always and pays; Deny records the recipient as Deny for the wallet and refuses; the label is the owner's, prefilled
  from the agent's proposal and marked as such.
- Mitigation: the Wait's answer and the rule are written in one commit (C9); OD-1 scoping.
- Rules: C8, C9 · From: SEC-054, PRO-060, DUR-002

**H-074** · best · high · implementation note · An agent pays a recipient set to Always
- Trigger: Mara pays Ana, Always for (Travel, Mara).
- Expected: admitted without a card; the payment shows in the chat as a quiet line and in the wallet's list; the tool
  returns once the hash is known.
- Mitigation: rule order of C3; DUR-001's pipeline.
- Rules: C3, C4 · From: PRO-058, DUR-001

**H-075** · best · high · implementation note · An agent pays a known recipient set to Ask
- Trigger: Mara pays Ana, whose rule is Ask.
- Expected: one card per payment; Pay once leaves the rule at Ask; Always upgrades it for (Travel, Mara).
- Mitigation: C9.
- Rules: C3, C9 · From: PRO-059

**H-076** · best · high · implementation note · An agent pays a recipient set to Deny
- Trigger: Mara pays an address the owner denied.
- Expected: refused at admission with no card ("the owner does not pay this recipient"); not counted as an attempt
  that notifies.
- Mitigation: Deny wins over every other rule (C3).
- Rules: C3 · From: PRO-061, SEC-051

**H-077** · security · critical · design rule · A rule binds an identity, never a label
- Trigger: a recipient labelled Ana; a new address is proposed as "Ana"; or a label is renamed to collide.
- Expected: rules bind (wallet, [agent,] checksummed address on the wallet's network) for transfers and (wallet,
  agent, endpoint, payTo, asset, network) for x402; a label never matches anything.
- Mitigation: C18 identity; property test that relabelling never changes an admission.
- Rules: C18 · From: SEC-055

**H-078** · security · high · design rule · The agent proposes the name of a new recipient
- Trigger: the agent says "pay Ana" with a new address, hoping the card reads as the known Ana.
- Expected: the card for a new address says New recipient in its title, shows the full address grouped, and marks the
  agent's proposed label as the agent's; if the label equals an existing recipient's, the card says "not the Ana you
  know (0x12ab…9f04)".
- Mitigation: card copy rules; a test on the card's text for a colliding label.
- Rules: C18 · From: PRO-047, SEC-046

**H-079** · edge · medium · implementation note · Two recipients with one name, or confusable names
- Trigger: two Anas; names differing by a homoglyph.
- Expected: names are plain lines; duplicates allowed but always shown with the short address; confusable labels
  warned at save.
- Mitigation: the plain-line rule; confusable detection with Unicode's skeleton algorithm (no dependency if the
  platform's `Intl` suffices; otherwise noted in stack.md).
- Rules: — · From: SEC-056, PRO-048

**H-080** · best · medium · implementation note · The owner renames a recipient
- Trigger: Settings → Wallets → Travel → Recipients → Ana → rename to Ana (rent).
- Expected: future cards and rows show the new label; past rows keep showing the recipient by its current label
  with the address (rows reference the identity, not the text).
- Mitigation: rows store the identity; labels joined at read (C22).
- Rules: C8, C22 · From: PRO-046, DUR-116, PRO-040

**H-081** · best · high · design rule · The owner changes a rule in the Recipients list
- Trigger: Ana from Ask to Always, or from Always to Deny.
- Expected: the change commits with a version; it applies to every admission and start commit after it; queued
  payments are re-checked at their start commit.
- Mitigation: C8 versioned acts; C4 re-checks the rule in the start commit.
- Rules: C4, C8 · From: PRO-049

**H-082** · race · critical · design rule · The rule changes while a payment waits, then the owner taps Pay
- Trigger: an Ask card open for Ana; meanwhile the owner sets Ana to Deny elsewhere; then taps Pay on the old card.
- Expected: Deny wins: the tap carries the card's rule version; the start commit refuses because the current rule is
  Deny; the card shows "Ana is denied now".
- Mitigation: C8 (acts name the version they saw); C4 re-check; Deny > everything in C3.
- Rules: C3, C4, C8 · From: PRO-062, SEC-057, DUR-108

**H-083** · race · high · design rule · Always set on one card while other payments to the same recipient wait
- Trigger: two Ask cards for Ana; the owner taps Always on the first.
- Expected: the Always answers the card it was tapped on and makes the rule; the other card is answered too because
  the new rule covers it (grants answer what they cover), and the card says it was paid by the new rule.
- Mitigation: C9 (pi's `covering` pattern for permissions); test with two open cards.
- Rules: C9 · From: PRO-050, DUR-101, SEC-060, DUR-103

**H-084** · race · high · design rule · The owner sets Deny while asks for that recipient are open
- Trigger: three open asks for an address; the owner denies it in the Recipients list.
- Expected: the Deny commit refuses all three open asks and every queued payment to it not yet past the burn point.
- Mitigation: C9 (a rule change answers what it covers); C4 re-check for queued payments.
- Rules: C4, C9 · From: DUR-102

**H-085** · race · high · design rule · Deny set after the payment started
- Trigger: Deny committed after the payment's start commit.
- Expected: the payment is already burnt and finishes; the owner is told the Deny applies from the next payment; never
  a cancel attempt (C13).
- Mitigation: C4 burn point; card copy.
- Rules: C4, C13 · From: SEC-058, DUR-111

**H-086** · race · high · design rule · The owner's Deny tap and the lane's start commit land together
- Trigger: the same instant.
- Expected: the store orders them: whichever commits first wins, and the other sees it (the start commit reads the
  rule inside its transaction; the Deny commit sees the payment as Signed and reports it as already sent).
- Mitigation: C1, one commit line; fault test interleaving the two.
- Rules: C1, C4 · From: DUR-118

**H-087** · race · high · design rule · Always revoked (back to Ask) while a payment is queued
- Trigger: Always to Ask while an Always-admitted payment waits behind another in the lane.
- Expected: the start commit re-checks: the payment now needs the owner and turns into an Ask card; nothing is signed.
- Mitigation: C4.
- Rules: C4, C8 · From: DUR-110

**H-088** · race · high · implementation note · A recipient forgotten while an Always payment is queued
- Trigger: the owner forgets Ana while her Always payment waits in the lane.
- Expected: forgetting removes the rule; the queued payment is re-checked at its start commit against the default for
  unknown recipients (Ask or Deny).
- Mitigation: C4.
- Rules: C4 · From: DUR-115

**H-089** · edge · low · implementation note · Forgetting a recipient
- Trigger: Recipients → Ana → Forget.
- Expected: the rule and label go; history rows show the address; the next payment to it is a first payment.
- Mitigation: rows keep identity (C22).
- Rules: C22 · From: SEC-062, PRO-051

**H-090** · race · medium · design rule · The default for unknown recipients changes while asks are open
- Trigger: the wallet's default goes from Ask to Deny with cards open for unknown recipients.
- Expected: the open asks for recipients without a rule are refused in the same commit; known recipients' asks stay.
- Mitigation: C9 (a rule change answers what it covers).
- Rules: C9 · From: DUR-117, PRO-052

**H-091** · security · critical · design rule · Always for one agent covers another on a shared wallet
- Trigger: Mara and Sancho share Travel; Ana is Always for Mara; Sancho pays Ana.
- Expected: under OD-1's default, Sancho's payment asks; his card offers "Always for Sancho too"; Deny on Ana stops
  both.
- Mitigation: rule key (wallet, agent, recipient) for Always, (wallet, recipient) for Deny and the label (R-7, OD-1).
- Rules: C3, C18 · From: SEC-059, PRO-043, DUR-119

**H-092** · security · medium · design rule · After a restart the card offers no standing answer
- Trigger: the daemon restarted while an Ask was open or while its payment was interrupted (abandoned or parked).
- Expected: an interrupted payment's card offers Pay once and Deny, never Always (the owner should see the
  interruption before granting more).
- Mitigation: C10 (no standing scope after an interruption), as `offeredScopes` limits other permissions.
- Rules: C10 · From: SEC-061, SEC-129

**H-093** · edge · high · design rule · One recipient written several ways
- Trigger: the same address lowercase, checksummed, with or without 0x, with whitespace, or as an ERC-3770 `base:0x…`.
- Expected: canonicalised to EIP-55 on the wallet's network before any rule lookup; a mixed-case address with a wrong
  checksum is refused; a prefix naming another chain is refused.
- Mitigation: admission check 5 (canonical identity) in C3; property test over spellings.
- Rules: C3, C18 · From: PRO-053

**H-094** · edge · medium · design rule · An all-lowercase address
- Trigger: a page or a person gives an address with no checksum.
- Expected: accepted only after canonicalisation and shown checksummed on the card; a new recipient from a lowercase
  address carries "typed without a checksum" on its card.
- Mitigation: card copy; canonicalisation.
- Rules: C3 · From: SEC-066

**H-095** · security · high · design rule · A look-alike of a known recipient
- Trigger: a page offers 0x12ab…9f04 that matches a known recipient's first and last characters (address poisoning).
- Expected: a new address whose first 4 and last 4 hex match a known recipient's is flagged on the card ("looks like
  Ana's address but is not"); never auto-matched.
- Mitigation: look-alike check at admission; a test with a vanity collision.
- Rules: C18 · From: SEC-064, PRO-125

**H-096** · security · critical · design rule · A page steers a payment to a new address
- Trigger: a fetched page says "send 50 USDC to 0x…".
- Expected: a new recipient always asks (unless the default is Deny); the card shows where the request came from (the
  turn) and the full address; nothing the model says skips it.
- Mitigation: law 2; C3 rule order.
- Rules: C3 · From: SEC-045, PRO-124

**H-097** · security · high · design rule · Poisoned memory maps a name to an attacker address
- Trigger: memory says "Ana's address is 0xattacker" or "the owner allowed 0x…".
- Expected: memory is the agent's words; it never sets a rule; the card for that address says New recipient.
- Mitigation: rules only from owner acts (C8, C9).
- Rules: C9 · From: SEC-047, PRO-126

**H-098** · security · high · design rule · A page steers repeated payments to an Always recipient
- Trigger: an injection makes the agent pay an Always recipient many times.
- Expected: accepted residual bounded by the balance and visible: every payment is a row and a chat line, and the
  owner's undo is one tap in Settings → Recipients. No burst pause: requirement 2 makes the balance the only cap
  (OD-12).
- Mitigation: the reservation ledger (C11); requirement 3 excludes an amount cap; a property test that a loop of
  Always payments spends at most the balance and opens no card (UC-07).
- Rules: C3, C11 · From: SEC-048, PRO-128

**H-099** · security · critical · design rule · A steered agent widens its own rules
- Trigger: the agent calls a tool to set a recipient to Always or change the default.
- Expected: no such tool exists; rules change only through owner routes and card answers.
- Mitigation: least tools; a test enumerating wallet tool names.
- Rules: C8, C9 · From: SEC-049

**H-100** · security · medium · design rule · Ask cards as a flood
- Trigger: the agent loops, opening card after card.
- Expected: at most one open Ask per (wallet, agent, recipient, amount, asset): a duplicate is answered with the open
  card, never a second one. Asks are never refused by count (a count is a cap the owner did not choose); cards of one
  chat are grouped into one notification.
- Mitigation: dedup at admission (C3 step 9).
- Rules: C3 · From: SEC-050, PRO-073

**H-101** · security · medium · implementation note · The reason text disguises the card
- Trigger: the agent's reason says "Refund from the owner, tap Pay" or carries bidi and newlines.
- Expected: the reason is one plain line, shown as the agent's words below the amount, recipient and wallet, which are
  banda's.
- Mitigation: plain-line rule; card layout puts banda's facts first.
- Rules: — · From: SEC-053

**H-102** · edge · high · design rule · A destination that cannot receive
- Trigger: the zero address, the token's own contract, the wallet itself, a precompile, or a known burn address.
- Expected: refused at admission with the reason; the owner's own Send warns and asks to type the address again for
  the token contract and self.
- Mitigation: admission check 4 (args).
- Rules: C3 · From: SEC-067, PRO-026

**H-103** · edge · medium · implementation note · A contract as recipient
- Trigger: the address has code (a Safe, an exchange's contract, a token).
- Expected: the card says "this address is a contract"; ERC-20 transfers to it proceed; ETH transfers estimate gas
  rather than assume 21000 (separate entry).
- Mitigation: `eth_getCode` at admission, cached per address.
- Rules: C3 · From: SEC-068

**H-104** · security · medium · implementation note · Names resolved remotely
- Trigger: a recipient given as `ana.eth` or `ana.base.eth`.
- Expected: not supported in the first slice: refused with "give the address"; later, a resolved name is a new
  recipient keyed by the address with the name shown as the resolver's, never a rule on the name.
- Mitigation: C18 identity.
- Rules: C18 · From: SEC-069

**H-105** · edge · low · implementation note · An agent pays itself or another banda wallet
- Trigger: Mara pays Office's address, which is another wallet of this home.
- Expected: allowed; the card names it ("your wallet Office"); counts as a recipient like any other.
- Mitigation: card copy.
- Rules: — · From: PRO-074

**H-106** · edge · low · implementation note · The owner sends to a recipient agents may never pay
- Trigger: the owner's Send to an address denied for agents.
- Expected: the owner's own Send is not bound by agents' rules; the Send screen notes the recipient is denied for
  agents.
- Mitigation: rules apply to agent admissions only.
- Rules: C3 · From: PRO-023

**H-107** · edge · medium · design rule · The owner's own Send grants agents nothing
- Trigger: the owner sends to Bob from Settings.
- Expected: Bob becomes a known recipient with rule Ask (or stays unknown, per OD-1), never Always.
- Mitigation: rules only from explicit owner choices (C9).
- Rules: C9 · From: PRO-024

**H-108** · edge · medium · implementation note · An x402 endpoint with per-resource paths asks every time
- Trigger: an API puts ids in the path (`/v1/items/123`), so exact-path Always never matches the next resource.
- Expected: OD-5's default: exact origin and path; the card offers "Always for every path under /v1/items/" worded as
  its consequence, as an explicit owner widening.
- Mitigation: OD-5.
- Rules: C18 · From: PRO-054

**H-109** · race · medium · design rule · Two devices edit a recipient's label at once
- Trigger: phone renames Ana to Ana R. while desktop renames her to Ana (rent).
- Expected: the act naming the current version wins; the other is refused and redraws.
- Mitigation: C8.
- Rules: C8 · From: new (critic)

**H-110** · race · low · out of scope · The burst pause races the owner setting Always again
- Trigger: the burst check drops Ana's Always to Ask while the owner, seeing the notice, sets Always again.
- Expected: both are versioned acts on the rule (the burst pause is a system act with its own version); the later
  commit wins and the earlier is visible in the rule's history.
- Mitigation: C8; out of scope, since the burst pause is not built (OOS-11, OD-12).
- Rules: C8 · From: new (critic)

**H-111** · edge · low · implementation note · Rules of an agent that was deleted
- Trigger: Mara is deleted; her (Travel, Mara, Ana) Always rules remain.
- Expected: rules keyed by a deleted agent are removed in the agent's delete commit; a new agent with the same name
  inherits nothing.
- Mitigation: rules keyed by agent id, removed with it (C17).
- Rules: C17 · From: new (critic)

### 6. Payment pipeline

The stages the entries name: **admit** (the tool call's checks, C3), **queue** (the payment in the wallet's lane, C2),
**ask** (an owner Wait when the rule says so), **start** (the fused commit: re-check, read and prove the key, take
the nonce, sign, store the signed bytes; the burn point, C4), **broadcast**, **track** (receipt at `latest`, then
`safe`), **result** (the tool's answer committed). States: Admitted, Waiting, Queued, Signed, Sent, Included,
Confirmed, Failed, Refused, Not paid (conflicts.md, payment state machine).

**H-112** · best · high · design rule · A payment goes through end to end, once
- Trigger: Mara pays Ana 5 USDC (Always), the wallet holds 20 USDC and gas.
- Expected: admit, queue, start, broadcast, track run once each; one transaction; the tool returns the hash after
  broadcast is accepted; the card shows "Included (safe)", then turns Confirmed at `finalized` (C12). Every stage is a durable step keyed by the payment id.
- Mitigation: nonce spike: 127 of 127 crash runs paid exactly once with the fused commit; the fault sweep of
  principle 10 kills at every boundary.
- Rules: C2, C4, C5, C6, C12 · From: DUR-001

**H-113** · best · high · design rule · A restart with a transaction in flight
- Trigger: the daemon stops (update, quit, crash) with a version Sent.
- Expected: at start the lane resumes from its checkpoint: rebroadcasts the stored bytes, tracks the receipt, and
  answers the tool once; no new signature, no new nonce.
- Mitigation: C4, C6; pi-durable resume.
- Rules: C4, C6 · From: DUR-005, DUR-095

**H-114** · error · medium · implementation note · Killed after admission, before the payment is queued
- Trigger: SIGKILL after the tool call's admission and before the queue commit.
- Expected: the tool call is a durable task; on resume it is admitted again against current rules; no payment exists
  twice (the payment id derives from the tool task id).
- Mitigation: C14 idempotency keys.
- Rules: C14 · From: DUR-010

**H-115** · error · medium · implementation note · Killed while the Ask is open
- Trigger: SIGKILL with a payment card waiting.
- Expected: the Wait survives (pi-durable); the card is shown again after restart; its deadline counts from its
  creation, not the restart; the answer after restart offers no standing scope if the run was interrupted (C10).
- Mitigation: Waits are durable; C10.
- Rules: C10 · From: DUR-011

**H-116** · error · high · design rule · Killed during the keychain read
- Trigger: SIGKILL while the signer reads the key.
- Expected: nothing committed: the payment is Queued; on resume the lane reads the key again; no nonce was taken.
- Mitigation: the key read precedes the start commit (C4); fault point before the commit.
- Rules: C4, C20 · From: DUR-012

**H-117** · error · critical · design rule · Killed after signing, before the start commit
- Trigger: SIGKILL with signed bytes in the signer's memory, nothing committed (under a split design: nonce and fees
  fixed but unsigned, or signed but not checkpointed).
- Expected: the bytes are lost and were never broadcast (broadcast reads only committed bytes); on resume the lane
  signs again at the same ledger nonce, which is not burnt.
- Mitigation: C4: broadcast only from committed bytes; with `extraEntropy: false` the re-signature is byte-identical
  (golden vectors), but safety rests on the ordering, not on that.
- Rules: C4, C6 · From: DUR-013, DUR-014

**H-118** · race · critical · design rule · The payment is refused while the signer holds its bytes
- Trigger: the lane has signed in the signer's memory; before the start commit the owner cancels the run, or a Deny's
  commit refuses the queued payment (C9); then the rule changes back to Always.
- Expected: the start commit checks the payment's own state in the same transaction, not only the rule: a refused
  payment's bytes are dropped and nothing is committed or broadcast.
- Mitigation: C4 (the re-check covers the payment's state, the rule, the agent's access and the lease); found by the
  lane model (`spikes/lane-model/model.py`), whose first run without the check reported "refused but paid".
- Rules: C1, C4 · From: new (critic)

**H-119** · error · critical · design rule · Killed after the start commit, before or during the broadcast
- Trigger: SIGKILL after the commit; or during `eth_sendRawTransaction` with the answer lost; or after the answer and
  before the Sent commit.
- Expected: on resume the stored bytes are broadcast again; "already known", "nonce too low" answered for our own hash,
  or a receipt for our hash all count as sent; never a new nonce.
- Mitigation: C5, C6 (versions append-only, hashes stored at signing); error classification by message, not code
  (nonce spike: geth -32000, anvil -32003).
- Rules: C5, C6, C12 · From: DUR-015, DUR-016, DUR-017, PRO-066

**H-120** · error · medium · implementation note · Killed after the receipt was fetched, before it was committed
- Trigger: SIGKILL after `eth_getTransactionReceipt` answered.
- Expected: on resume the receipt is fetched again; the state moves only forward (C12).
- Mitigation: tracking is idempotent reads.
- Rules: C12 · From: DUR-018

**H-121** · error · medium · implementation note · Killed after the payment settled, before the tool's result was committed
- Trigger: SIGKILL after Included, before the tool task's result.
- Expected: on resume the tool returns the stored outcome; the model sees one result.
- Mitigation: the result reads the payment's stored state (C13).
- Rules: C13 · From: DUR-019

**H-122** · error · high · design rule · Killed during a fee bump
- Trigger: SIGKILL after the bumped version was committed, before it was broadcast.
- Expected: on resume all versions of that nonce are rebroadcast (newest first); whichever is mined is the outcome;
  never a version at another nonce.
- Mitigation: C6 append-only versions; nonce spike R8.
- Rules: C5, C6 · From: DUR-020

**H-123** · error · high · design rule · The lane crash-loops on a stored state
- Trigger: a bug or an unparsable version makes the lane throw at the same step on every start.
- Expected: after the restart limit (5) the lane is parked; the wallet shows "payments paused: banda hit an error";
  reads work; a version past the burn point keeps being tracked by a minimal read-only tracker that needs no parse of
  the failing step; the owner can export a report.
- Mitigation: pi-durable's `restartLimit` parking; schema check of stored versions with TypeBox on read.
- Rules: C12, C21 · From: DUR-021

**H-124** · race · critical · design rule · The owner cancels the chat's run while its payment is in the lane
- Trigger: Stop in the chat while the payment is queued, waiting, or past the burn point.
- Expected: before the start commit the payment is refused ("stopped by you"); past it the payment continues in the
  lane and its outcome is recorded; the run's cancel never cancels a burnt nonce.
- Mitigation: the lane owns the outcome (C13).
- Rules: C13 · From: DUR-022

**H-125** · race · critical · design rule · A caller that cannot be replayed is abandoned on restart
- Trigger: the chat turn that called the tool is `abandonOnRestart`; the restart abandons it while its payment is in the
  lane.
- Expected: the payment's fate does not depend on the caller: before the burn it is refused with "interrupted"; past
  it it finishes and the chat gets a note.
- Mitigation: C13; the payment is the lane's task, not the turn's.
- Rules: C13 · From: DUR-023

**H-126** · race · critical · design rule · A rerun after a crash reports "did not run" for bytes that already left
- Trigger: banda-integration spike: the payment is an `idempotent` effect; after a crash with the signed bytes stored, a
  Deny, a switch-off or a definition change lands before the resume; the rerun re-checks `allowed` and answers
  "wallet__send did not run", though the bytes were broadcast.
- Expected: once signed bytes are stored, no refusal is reported as "did not run": the outcome is "may have sent" until
  a receipt decides it; the rerun only rebroadcasts and reports; a daemon-level follower drives every stored and
  unconfirmed entry to an outcome, independent of the tool task.
- Mitigation: C13 (the lane owns the outcome), C4 (rules are checked before the burn point, never after); the wallet's
  `allowed` lets a rerun with stored bytes through; the general effect path stays as it is.
- Rules: C4, C13 · From: new (spike)

**H-127** · error · critical · design rule · The checkpoint kept in a task memo vanishes at the task's outcome
- Trigger: the signed bytes are stored with `api.memo`; pi-durable drops memos when the task reaches its outcome
  (banda-integration spike, pi-durable 1.4.0 scheduler).
- Expected: the signed versions live in the wallet's ledger doc, which outlives the task and doubles as the outgoing
  list; memos hold nothing the lane or the list needs later.
- Mitigation: C6 (versions in the ledger doc, append-only).
- Rules: C6, C22 · From: new (spike)

**H-128** · edge · low · implementation note · A doc value returned out of a commit is a dead overlay
- Trigger: the lane returns a ledger value read inside `api.commit` and uses it after; it throws "Cannot use a settled
  overlay" (banda-integration spike).
- Expected: values are copied out of the commit, as `src/core/ask.ts` already does.
- Mitigation: code review; a unit test around the lane's start commit.
- Rules: C4 · From: new (spike)

**H-129** · error · critical · design rule · Power loss loses the newest commits after a broadcast
- Trigger: the store runs WAL with `synchronous=NORMAL`: a crash of the process keeps every commit, a power loss can
  drop the newest; the start commit is lost but the bytes were broadcast.
- Expected: the lane must never sign a second payment at another nonce. The start commit is made durable before the
  broadcast (C21: the store syncs every commit), and at start the lane compares the chain's nonce with its ledger: a chain count
  above the ledger freezes the lane until the stored history explains it or the owner looks.
- Mitigation: C21 (durable before the effect; freeze on chain count > ledger); the store runs `synchronous=FULL`, so
  every commit's log is synced as it is made.
- Rules: C5, C21 · From: DUR-030

**H-130** · error · high · design rule · The start commit fails (disk full or any commit error)
- Trigger: `SQLITE_FULL` or I/O error at the start commit.
- Expected: nothing broadcast; the payment stays Queued; the wallet shows "banda cannot save; payments paused"; no
  retry loop that spins.
- Mitigation: broadcast follows a successful commit (C4); commit errors pause the lane with backoff.
- Rules: C4 · From: DUR-032

**H-131** · error · high · design rule · A commit fails after a successful broadcast
- Trigger: the Sent or Included commit fails.
- Expected: the transaction is out; the lane keeps the stored signed bytes (committed earlier) and retries the state
  commit; tracking is reads only; never a re-sign.
- Mitigation: C4, C12.
- Rules: C4, C12 · From: DUR-033

**H-132** · race · critical · design rule · Concurrent payments each fit the balance, together they do not
- Trigger: three payments of 8 USDC from a wallet of 20, admitted in parallel.
- Expected: admission subtracts what is already reserved (queued, waiting, signed and not final) from the balance read;
  the third is refused at admission ("4 USDC available"); a balance drop between admission and start is caught at
  start.
- Mitigation: the reservation ledger (C11) in the lane's own commits; property test over generated concurrent
  admissions.
- Rules: C2, C11 · From: PRO-065, DUR-050, SEC-092

**H-133** · race · high · design rule · The balance drops between approval and signing
- Trigger: the owner approved a payment; before its start commit, an outgoing transfer made elsewhere lowered the
  balance.
- Expected: the start commit re-reads the balance; not enough: the payment ends "Not paid: not enough USDC" and the card
  says so; never a broadcast that will revert or sit in the pool.
- Mitigation: C4 re-check, C11.
- Rules: C4, C11 · From: PRO-078, DUR-100, DUR-184

**H-134** · error · medium · implementation note · Not enough of the token
- Trigger: Mara pays 50 USDC with 20 available.
- Expected: refused at admission with the available amount; no card (OD-8).
- Mitigation: C11.
- Rules: C11 · From: PRO-075, OD-8

**H-135** · error · medium · implementation note · USDC but no ETH for gas
- Trigger: the wallet holds USDC and no ETH.
- Expected: refused at admission with "Travel needs about 0.00002 ETH for fees" and the receive action; no card.
- Mitigation: C11 counts fees in ETH as a reservation too.
- Rules: C11 · From: PRO-076, SEC-094

**H-136** · edge · high · design rule · The fee budget forgets the L1 and operator fees
- Trigger: the fee reserve is computed as gas × maxFeePerGas only.
- Expected: the reserve on Base is gasLimit × maxFeePerGas + L1 fee upper bound (GasPriceOracle
  `getL1FeeUpperBound`) + operator fee; the card's fee is that bound; the pool never rejects for worst-case cost.
- Mitigation: chain-operations research; nonce spike measured a refusal when the L1 part was missing.
- Rules: C11 · From: PRO-077, DUR-066, SEC-093

**H-137** · edge · high · design rule · The agent confuses units
- Trigger: Mara means 5 USDC and passes 5000000, or 5 ETH as wei.
- Expected: the tool takes a decimal string in the token's units ("5.00") and the token's symbol; integers in base
  units are refused; the card and the result restate the amount in words and in the fiat estimate when known.
- Mitigation: schema; card copy.
- Rules: C3 · From: PRO-070

**H-138** · error · medium · implementation note · A malformed amount
- Trigger: "-1", "1e6", "0", "5,00", more decimals than the token has, NaN, a number past 2^53.
- Expected: refused at admission with the rule ("a positive decimal with at most 6 places for USDC"); parsing to bigint
  exactly; never a JS number for amounts.
- Mitigation: one parser with a property test.
- Rules: C3 · From: PRO-071

**H-139** · edge · medium · implementation note · Amounts and wei lose precision in JSON
- Trigger: a wei value above 2^53 passes through `JSON.parse` as a number (an RPC answer, a stored shape, an SSE event).
- Expected: amounts are strings end to end in stored shapes and APIs; RPC quantities are parsed from hex strings to
  bigint.
- Mitigation: TypeBox schemas with string amounts; a test round-trips 2^256−1.
- Rules: — · From: new (critic)

**H-140** · edge · medium · design rule · The owner says yes in words instead of tapping the card
- Trigger: "yes pay her" in the chat.
- Expected: words never answer the card; the agent says the owner must tap Pay on the card; nothing pays.
- Mitigation: only the Wait's owner route answers (C9).
- Rules: C9 · From: PRO-072

**H-141** · race · medium · design rule · The same card approved on two devices
- Trigger: phone and desktop both tap Pay.
- Expected: one answer commits; the other sees "already answered on your phone"; one payment.
- Mitigation: Wait answered once (C8, C9).
- Rules: C8, C9 · From: PRO-063, DUR-104

**H-142** · edge · medium · design rule · An approval expires
- Trigger: nobody answers the card within its deadline (24 h, `DEFAULT_DEADLINE`).
- Expected: the payment ends "Not paid: no answer"; the agent's tool gets that; a later tap on the old card does
  nothing and says so.
- Mitigation: C10; OD-10.
- Rules: C10 · From: DUR-105, PRO-097

**H-143** · race · high · design rule · Approved, then the wallet goes offline before the start commit
- Trigger: the owner taps Pay; before start, the keychain locks, the lease is lost, or the RPC is unreachable.
- Expected: the payment waits in the lane; the approval keeps its freshness window; past it, the payment asks again.
- Mitigation: C10 (approval freshness 1 h behind a stuck lane), C4.
- Rules: C4, C10 · From: DUR-106

**H-144** · edge · high · design rule · Approved, then held behind a stuck transaction for hours
- Trigger: the owner approved at 9:00; the lane is blocked by an earlier stuck payment until 14:00.
- Expected: an approval older than 1 h when the lane reaches it asks again ("still pay Ana 5 USDC?"); an Always
  admission is re-checked against the current rule.
- Mitigation: C10.
- Rules: C10 · From: DUR-107

**H-145** · edge · medium · implementation note · Fees paid exceed what the card estimated
- Trigger: the base fee rose and a bump raised the fee above the card's estimate.
- Expected: the card shows "up to" from the reserve (C11), which bounds every bump (fee ceiling); the row shows the
  actual fee after inclusion.
- Mitigation: the reserve is the ceiling.
- Rules: C11 · From: DUR-068

**H-146** · edge · medium · implementation note · "Send all" of ETH, then a bump is needed
- Trigger: the owner sends the whole ETH balance; the fee rises.
- Expected: Max for ETH leaves the fee ceiling's reserve; a bump that would exceed it is not made and the owner is
  told.
- Mitigation: C11; Max computed from the ceiling.
- Rules: C11 · From: DUR-069, PRO-028

**H-147** · error · medium · implementation note · Mined with status 0
- Trigger: USDC paused, or the recipient blacklisted after estimation.
- Expected: the row says Failed with the fee spent; the agent's tool gets "failed on chain: the token refused the
  transfer"; never retried automatically.
- Mitigation: C12 terminal state.
- Rules: C12 · From: DUR-067, PRO-039

**H-148** · edge · high · implementation note · ETH to a contract needs more than 21000 gas
- Trigger: the recipient is a contract with a payable fallback (a Safe) and 21000 gas reverts or is refused.
- Expected: ETH transfers estimate gas when the recipient has code, with a margin, and the card's fee reflects it.
- Mitigation: `eth_getCode` and `eth_estimateGas` at admission; anvil test with a Safe-like receiver.
- Rules: C3, C11 · From: new (critic)

**H-149** · edge · high · design rule · An agent loop enqueues hundreds of Always payments
- Trigger: a bug or an injection calls `wallet__send` 300 times to an Always recipient.
- Expected: bounded by the balance (C11); the lane stays FIFO; every payment is a row; no burst pause (OD-12).
- Mitigation: C11; the lane's FIFO (C2); the property test of UC-07.
- Rules: C2, C3, C11 · From: DUR-185

**H-150** · security · critical · design rule · EIP-7702 delegation
- Trigger: a page or a tool asks for an authorization tuple, or a type-4 transaction.
- Expected: the signer has no function that makes one; micro-eth-signer's `authorization.sign` is not exposed by banda's
  signer module.
- Mitigation: the signer's only signing exports are `signTransfer` (ERC-20 transfer and ETH send, type 2, built from
  its own fields alone) and `signTransferWithAuthorization` (EIP-3009 with USDC's domain); an export-enumeration test
  (stack.md).
- Rules: C20 · From: SEC-085

**H-151** · security · critical · design rule · Approvals and permits
- Trigger: a payment flow asks for `approve`, `permit`, Permit2, or `increaseAllowance` (the x402 SDK signs
  `approve(Permit2, 2^256−1)`).
- Expected: never: banda signs no allowance of any size; x402 uses EIP-3009 only.
- Mitigation: the signer builds the calldata itself from a fixed selector (`transfer(address,uint256)`); R-6.
- Rules: C20 · From: SEC-086, PRO-127

**H-152** · security · critical · design rule · Raw and personal signatures
- Trigger: "sign this message to log in" (EIP-191), a raw hash, or arbitrary EIP-712.
- Expected: none exists in the first release; sign-in with a wallet is a later feature with its own rules.
- Mitigation: no generic signer (next entry).
- Rules: C20 · From: SEC-087

**H-153** · security · high · design rule · A generic signing function creeps in
- Trigger: a refactor adds `sign(bytes)` or `signTypedData(any)` "for flexibility".
- Expected: blocked by review and by the export-enumeration test, which fails on any new export of the signer module.
- Mitigation: stack.md controls.
- Rules: C20 · From: SEC-088

**H-154** · security · critical · design rule · No signature reaches money not in the wallet
- Trigger: any signed shape whose effect can exceed the current balance or outlive the payment (an allowance, a
  long-lived authorization, a delegation).
- Expected: every signature moves at most the payment's amount, once, within a short window (x402: validity at most
  60 s past chain time); the balance is the cap (requirement 2).
- Mitigation: the two signer shapes; C19 validity bound; a property test over the signer's two operations (UC-28).
- Rules: C19, C20 · From: SEC-092, PRO-127

**H-155** · edge · high · design rule · The chain id comes from the RPC
- Trigger: the signer takes `eth_chainId`'s answer, or micro-eth-signer's default chain id (1) applies.
- Expected: the chain id is the wallet's network constant (8453 or 84532); always passed explicitly; the RPC's
  `eth_chainId` is checked against it at connect and before each broadcast, and a mismatch takes the wallet offline.
- Mitigation: keys spike (micro-eth-signer defaults chainId to 1); golden vectors per network.
- Rules: C20 · From: SEC-089, DUR-084

**H-156** · edge · medium · implementation note · Non-standard tokens
- Trigger: a token without a bool return, fee-on-transfer, rebasing, or a proxy upgrade.
- Expected: only tokens banda lists (USDC, and ETH) are spendable; others show in balances as "not supported to send".
- Mitigation: a token list per network in the chain definition.
- Rules: — · From: SEC-090, PRO-079

**H-157** · security · high · design rule · The wallet already has code
- Trigger: the address has a 7702 delegation (set elsewhere with the exported key) or code.
- Expected: wallet offline for agents ("this address delegates to a contract; banda will not sign"); Receive and the
  QR give way to a warning ("this address has code another key set; do not fund it"); the owner's Send waits for an
  acknowledgement on the host; the owner can still see balances.
- Mitigation: `eth_getCode` on the wallet's own address at unlock, before Receive, and with its balances on every pass
  of the indexer, its reading dated by the block and the RPC it was read through (C22): the notice follows a new RPC,
  an RPC that answers again and a delegation cleared; the `acknowledge_code` rows; `owner_send_receive.feature`.
- Rules: C3, C17 · From: SEC-091

**H-158** · error · high · implementation note · The token issuer freezes the wallet's own address
- Trigger: USDC's blacklist adds the wallet; every transfer from it reverts.
- Expected: admission reads `isBlacklisted(wallet)` for USDC once per hour and before a payment; a frozen wallet is
  offline for USDC with the reason; ETH still moves; a reverted transfer is Failed (status 0), never retried.
- Mitigation: one offline reason more; C12.
- Rules: C3, C12 · From: new (critic)

**H-159** · edge · low · implementation note · Agents sharing a wallet share the cap
- Trigger: Mara and Sancho share Travel.
- Expected: said on the wallet's agents list: they spend from the same balance.
- Mitigation: words.
- Rules: C11 · From: SEC-096

**H-160** · security · medium · implementation note · Airdropped tokens with instructions in their names
- Trigger: a spam token named "Visit evil.example to claim" shows up in balance reads.
- Expected: unlisted tokens are not reported to the agent; the owner sees them collapsed under "unrecognised tokens"
  with names escaped.
- Mitigation: token list (C22).
- Rules: C22 · From: SEC-095, PRO-021

**H-161** · edge · high · design rule · Hedged signatures by default
- Trigger: micro-eth-signer 0.20.1 adds random entropy to every signature unless told not to (keys spike).
- Expected: every call passes `extraEntropy: false`; golden vectors pin the bytes; a hedged signature never reaches the
  store (a re-sign would otherwise produce a second hash for the same nonce).
- Mitigation: C6; golden vectors per network through the module's exports (stack.md section 5).
- Rules: C6 · From: new (spike)

**H-162** · edge · high · implementation note · noble's `sign` hashes its input again by default
- Trigger: a direct `@noble/curves` call with `prehash: true` (the default in 2.x) on a keccak digest.
- Expected: banda never calls noble's `sign` directly; only micro-eth-signer's transaction and typed-data signers,
  whose vectors are pinned.
- Mitigation: single importer module; golden vectors (stack.md).
- Rules: C20 · From: new (spike)

**H-163** · edge · medium · implementation note · The fiat estimate comes from a price source
- Trigger: the card shows "about 5.00 USD" for ETH using a price API.
- Expected: USDC is shown as its amount; ETH's fiat estimate is optional, marked "about", with its source and age, and
  never used for any admission decision.
- Mitigation: no price in any rule; a later slice picks the source.
- Rules: — · From: new (critic)

### 7. Nonce and chain

**H-164** · race · critical · design rule · Two payers from one wallet at the same instant
- Trigger: Mara and Sancho pay from Travel at once; or the owner's Send and an agent's payment; or one agent's calls
  from parallel chats or a group's parallel turns.
- Expected: each payment is queued in the wallet's one lane, FIFO by queue commit; nonces are assigned one at a time in
  the start commit; no two payments ever hold one nonce.
- Mitigation: C2 (one lane per wallet: a durable task whose id derives from the wallet id), C5; nonce spike: viem's
  in-memory nonce manager failed 10 of 20 runs with two processes, the lane failed none.
- Rules: C2, C5 · From: DUR-050, DUR-051, DUR-052, PRO-030, SEC-097

**H-165** · race · critical · design rule · A nonce taken when the draft opens leaves a gap
- Trigger: a design that reserves the nonce at admission or when the card opens; the owner never answers.
- Expected: impossible: the nonce is taken in the start commit, after approval (R-1); a waiting or refused card holds
  nothing.
- Mitigation: C4.
- Rules: C4, C5 · From: PRO-064

**H-166** · edge · high · design rule · The exported key was used elsewhere while banda was idle
- Trigger: the owner imported the key into another wallet and sent from it; the chain's nonce is above banda's ledger.
- Expected: at the next start the lane reads `latest` and moves the ledger up (never down); the foreign transaction
  shows in the list as "sent outside banda" (from history reads); no banda payment was affected.
- Mitigation: C5 (ledger = max(ledger, latest)).
- Rules: C5, C7 · From: DUR-053, PRO-037

**H-167** · race · critical · design rule · A foreign transaction takes the nonce of banda's in-flight one
- Trigger: the exported key sends at the nonce banda's Sent version holds.
- Expected: banda's transaction is replaced or never mined; the payment is not re-signed at a new nonce until the
  foreign transaction is `finalized` (R-4), and then only with the owner's approval on a card that says what happened;
  two foreign events within 24 h pause the lane.
- Mitigation: C7; nonce spike measured a double payment when re-admitting at `latest`.
- Rules: C7 · From: DUR-054, DUR-073, SEC-099

**H-168** · race · high · design rule · A foreign transaction pending where banda cannot see it
- Trigger: another wallet broadcast to a different RPC; banda's RPC does not show it.
- Expected: banda's broadcast gets "nonce too low" or "replacement underpriced" for a hash not ours; the lane treats it
  as foreign (C7) and never bumps over it.
- Mitigation: classification compares the answering transaction's hash with the stored versions.
- Rules: C5, C7 · From: DUR-055

**H-169** · edge · high · design rule · A burnt nonce whose every version the pool rejects
- Trigger: after the start commit, an L1 fee spike makes the signed version's worst-case cost exceed the balance;
  every version is refused.
- Expected: the nonce stays burnt; the lane fills it: when the balance allows, rebroadcast; otherwise one owner Wait
  ("add 0.0001 ETH to send the waiting payment, or cancel it": a zero-value self-transfer at the same nonce); later
  payments wait behind it.
- Mitigation: C5 (always filled, never skipped).
- Rules: C5, C13 · From: DUR-057

**H-170** · error · high · design rule · The RPC reports a lower count than the ledger
- Trigger: a lagging or load-balanced node answers `eth_getTransactionCount(latest)` below the ledger.
- Expected: the ledger never goes down; a lower count is treated as lag and the lane waits; no nonce reuse.
- Mitigation: C5; never the `pending` tag (Base since Denim resolves `pending` to `latest`).
- Rules: C5 · From: DUR-058, DUR-090

**H-171** · race · high · design rule · The ledger is raised to a foreign nonce that a reorg then removes
- Trigger: at restart the chain's count at `latest` is above the ledger because a foreign spend was just mined; the
  lane raises the ledger to it; a reorg drops the foreign transaction; the nonce banda skipped is now a gap that
  blocks every later payment.
- Expected: the ledger is raised to the chain's count only at `finalized`, or when stored hashes explain the
  difference; an unexplained count above the ledger at `latest` freezes the lane (C21) until it is finalized.
- Mitigation: C5 with C21; the lane model's run with C21 off found this gap in 4 steps.
- Rules: C5, C7, C21 · From: new (critic)

**H-172** · error · high · implementation note · Not included because the base fee rose
- Trigger: the base fee rises above the version's maxFeePerGas.
- Expected: after a wait of N blocks (configurable, default 30 s of blocks), the lane appends a bumped version: both
  fee fields +12.5% at least, capped by the reserve; the card says "waiting for lower fees" once.
- Mitigation: C6 append-only versions; replacement rule measured (geth PriceBump 10%; banda uses 12.5% to cover reth
  and op-geth; anvil accepts +1%, so it is not the conformance oracle).
- Rules: C6, C11 · From: DUR-060, PRO-068

**H-173** · error · high · implementation note · The bump is refused as underpriced
- Trigger: `replacement transaction underpriced` for our own bump.
- Expected: the next bump uses max(+12.5%, current base fee × 2 + priority); never more than the reserve; the original
  stays valid.
- Mitigation: classification by message; anvil and op-geth tests.
- Rules: C6 · From: DUR-061

**H-174** · edge · high · design rule · The fee ceiling is reached
- Trigger: bumps reach the reserve cap and the transaction is still not included.
- Expected: no more bumps; one owner Wait ("fees are high; keep waiting, or add a fee ceiling"); later payments wait.
- Mitigation: C11 ceiling; C5 one in flight.
- Rules: C5, C11 · From: DUR-062, PRO-113

**H-175** · race · medium · design rule · The original is mined after its bump was broadcast
- Trigger: version 1 is included after version 2 was sent.
- Expected: any version's receipt settles the payment; the row shows the hash that was mined; the other versions are
  dropped by the chain (same nonce).
- Mitigation: C6 (all hashes stored); tracking checks every version.
- Rules: C6, C12 · From: DUR-063

**H-176** · race · medium · design rule · A reorg returns an earlier payment to Sent after the next one started
- Trigger: payment A is Included at `latest`, the lane starts B at the next nonce, then a reorg drops A's block.
- Expected: A goes back to Sent and is rebroadcast; B waits behind it at the next nonce; two nonces are briefly in
  flight, always consecutive and rebroadcast in nonce order; nothing is re-signed.
- Mitigation: C5 counts a payment in flight until it is Included at `latest` (waiting for `safe` before each next
  payment would cost about 2 min per payment); the lane model checks "consecutive and in order" after a reorg.
- Rules: C5, C6, C12 · From: new (critic)

**H-177** · race · high · design rule · The owner's cancel loses to the original
- Trigger: the owner asks to cancel a stuck payment (a zero-value self-transfer at the same nonce); the original is
  mined first.
- Expected: the payment shows Sent and paid; the cancel shows "too late: it was already sent"; one of the two at most.
- Mitigation: C13 (cancel before the burn only from the agent's or run's side; the owner's replacement is just another
  version of the same nonce).
- Rules: C6, C13 · From: DUR-064

**H-178** · error · high · design rule · The balance cannot cover a bumped fee
- Trigger: the bump's worst-case cost exceeds the balance.
- Expected: no bump; the lane keeps rebroadcasting the current version and tells the owner once.
- Mitigation: C11.
- Rules: C11 · From: DUR-065

**H-179** · error · high · implementation note · Evicted from the pool
- Trigger: a sequencer restart or the pool's lifetime drops our transaction.
- Expected: the lane rebroadcasts the stored versions on a timer until a receipt or a foreign transaction takes the
  nonce; never a new nonce.
- Mitigation: C5, C6.
- Rules: C5, C6 · From: DUR-070

**H-180** · error · high · implementation note · The RPC accepted the transaction but never forwarded it
- Trigger: a public RPC answers the hash and drops it.
- Expected: same as eviction: rebroadcast on a timer; optionally to a second RPC the owner configured.
- Mitigation: C6.
- Rules: C6 · From: DUR-071, PRO-067

**H-181** · edge · medium · design rule · An L2 reorg removes an included transaction
- Trigger: a block at `latest` is replaced (rare on Base; possible before `safe`).
- Expected: Included is not Confirmed: the card says Sent, not Confirmed, until `safe`; a vanished receipt sends the
  payment back to Sent and the lane rebroadcasts the same bytes.
- Mitigation: C12 ("Confirmed" only at `safe`).
- Rules: C12 · From: DUR-072, PRO-038

**H-182** · edge · high · implementation note · The single sequencer halts
- Trigger: Base's sequencer stops for minutes or hours.
- Expected: payments wait; the wallet shows "Base is not producing blocks"; approvals keep their freshness rules; the
  lane does not bump during a halt (no blocks, no base fee change).
- Mitigation: head-age check before bumps.
- Rules: C10 · From: DUR-074, PRO-113

**H-183** · error · high · implementation note · The RPC rate-limits or is unreachable
- Trigger: 429 (`-32011` measured on `mainnet.base.org`), timeouts, DNS failure.
- Expected: backoff with jitter per RPC; the wallet shows "cannot reach Base" with the time of the last read; reads
  show "as of"; the lane waits; no busy loop.
- Mitigation: one RPC client with a token bucket shared by all wallets on a network.
- Rules: C22 · From: DUR-080, SEC-104, PRO-110

**H-184** · error · high · design rule · A timeout on `eth_sendRawTransaction`
- Trigger: the request may or may not have reached the node.
- Expected: treated as maybe-sent: the payment stays Signed with its bytes and is rebroadcast; never "failed".
- Mitigation: C12 (claims need a chain read).
- Rules: C6, C12 · From: DUR-081, PRO-067

**H-185** · error · high · design rule · Error codes do not discriminate
- Trigger: geth and reth answer `-32000`, anvil `-32003`, with varied wording.
- Expected: one classifier maps messages to {already known, nonce too low, underpriced, insufficient funds, other}
  with tests against anvil and op-geth or base-reth in Docker; "other" is maybe-sent, never failed.
- Mitigation: nonce spike's classification table; its own JSON-RPC client keeps raw errors (stack.md).
- Rules: C12 · From: DUR-082

**H-186** · edge · high · design rule · "nonce too low" answering our own bytes
- Trigger: rebroadcast after our transaction was mined.
- Expected: the lane looks up the receipt for every stored hash; ours found: settled; none found: foreign (C7).
- Mitigation: C5, C7.
- Rules: C5, C7 · From: DUR-083, PRO-069

**H-187** · security · high · design rule · The RPC serves another chain
- Trigger: a Sepolia URL for a mainnet wallet or the reverse.
- Expected: `eth_chainId` checked at connect and before each broadcast; a mismatch takes the wallet offline; the
  signature binds the chain anyway (EIP-155).
- Mitigation: chain id constant per wallet (separate entry in section 6).
- Rules: C20 · From: DUR-084

**H-188** · security · high · design rule · The RPC invents a receipt for a transaction never mined
- Trigger: a lying RPC answers status 1.
- Expected: "Confirmed" needs the block at `safe` and the receipt's block hash to be in the chain the RPC serves at
  `safe`; a second RPC, when configured, confirms; until then the row says "reported sent by the RPC".
- Mitigation: C12; TA-4 (the RPC can mislead, never make banda sign more).
- Rules: C12 · From: DUR-085, SEC-098

**H-189** · security · high · design rule · The RPC hides a mined receipt (a false "failed")
- Trigger: the RPC says unknown or failed for a transaction that was mined.
- Expected: absence of a receipt never ends a payment as Failed; only a status-0 receipt or the nonce being used by
  another transaction ends it; never a second payment at another nonce.
- Mitigation: C12, C7.
- Rules: C7, C12 · From: DUR-086, SEC-098

**H-190** · security · high · implementation note · The RPC inflates the base fee or the gas estimate
- Trigger: a lying RPC answers a huge base fee or gas estimate.
- Expected: per-network caps (gas limit for transfer and ETH send; maxFeePerGas ceiling) bound what banda signs; a
  quote above them asks the owner.
- Mitigation: caps in the chain definition.
- Rules: C11 · From: DUR-087, SEC-102, PRO-111

**H-191** · error · high · implementation note · A stale or false balance
- Trigger: the RPC answers an old balance or lies.
- Expected: balance reads carry the block they were read at; the reservation ledger uses them; a too-low balance only
  refuses; a too-high one leads to a refused broadcast, never to an over-spend (the chain is the cap).
- Mitigation: C11, C22.
- Rules: C11, C22 · From: DUR-088, PRO-056

**H-192** · race · medium · design rule · The owner changes the RPC while transactions are in flight
- Trigger: Settings → Wallets → Network → RPC changed.
- Expected: the change commits; the lane picks it at its next step; stored versions are rebroadcast to the new RPC;
  the chain id is checked; nothing re-signed.
- Mitigation: the RPC is configuration, read per step; C6.
- Rules: C6, C8 · From: DUR-089

**H-193** · edge · medium · implementation note · The laptop slept or was off for days
- Trigger: the daemon resumes after days with versions Sent and asks open.
- Expected: the lane reads receipts first, then applies deadlines (expired asks end), then approval freshness; incoming
  history catches up by chunked reads (section 8).
- Mitigation: C10, C19 (chain time, not wall time, for windows).
- Rules: C10, C19 · From: DUR-096, PRO-036

**H-194** · edge · high · design rule · The wall clock jumps forward or backward
- Trigger: NTP correction, manual change, VM resume.
- Expected: x402 validity windows use chain time (the latest block's timestamp), not the wall clock; deadlines use the
  store's monotone task timers; a skew above 120 s between wall and chain time is shown and x402 signing pauses.
- Mitigation: C19.
- Rules: C19 · From: DUR-170, DUR-171, DUR-148

**H-195** · security · medium · implementation note · An RPC URL with a key in it
- Trigger: the owner pastes an Alchemy or Infura URL with its key.
- Expected: stored as a secret beside proxy credentials, never in logs, the store's public docs, or tool results;
  shown masked.
- Mitigation: the secret store banda already has for proxy credentials. Shown and logged as `maskedRpc` gives it: the
  scheme, host and port, with userinfo, path, query and fragment as `•••`; a userinfo key reaches the RPC as a Basic
  `Authorization` header, never in the URL `fetch` is given; a config error names a network, never a key or a value.
  Open (owner): docs/wallets.md places the RPC in `config.json`, which this case's Expected contradicts; the choice
  is open in docs/wallets.md "Spikes before any of this is design".
- Rules: — · From: SEC-100

**H-196** · security · medium · implementation note · A plain-HTTP or private-address RPC
- Trigger: `http://` or a private IP as RPC.
- Expected: refused unless it is localhost (for anvil in tests and development); https only otherwise.
- Mitigation: URL check at save and at every read. A literal address is refused when private, link-local, special
  purpose, or an IPv6 address that embeds one (IPv4-compatible, mapped, SIIT, NAT64, 6to4); a host name is resolved
  once when the owner saves it, and each answer gets the same check a literal address gets: refused when private,
  link-local or special purpose, including an IPv4 address an IPv6 answer embeds. A name that resolves elsewhere later
  (DNS rebinding) is not covered.
- Rules: — · From: SEC-101

**H-197** · edge · low · out of scope · The RPC learns the address and the owner's IP
- Trigger: every read tells the RPC which addresses this IP watches.
- Expected: said in Settings; the owner may point to their own node.
- Mitigation: none beyond the choice of RPC. Out of scope because any light client leaks the same.
- Rules: — · From: SEC-103, PRO-112

**H-198** · edge · medium · implementation note · Many wallets poll one rate-limited RPC
- Trigger: five wallets on Base, each tracking and reading history.
- Expected: one shared poller per network: one head subscription or poll, batched balance and log reads; per-wallet
  polling never multiplies.
- Mitigation: C22 (the read side is derived, shared).
- Rules: C22 · From: DUR-186

**H-199** · race · high · design rule · The owner's cancel races the lane's automatic bump
- Trigger: the owner taps Cancel (a self-transfer at the same nonce) at the moment the lane signs a fee bump of the
  original.
- Expected: both are versions of the one nonce appended in the lane's order (owner acts enter the lane as commands);
  the newest committed version is the one rebroadcast; whichever is mined is the outcome, shown as such.
- Mitigation: C2 (owner acts on a lane go through the lane), C6.
- Rules: C2, C6, C13 · From: new (critic)

**H-200** · edge · high · design rule · A filler cannot be sent either
- Trigger: the burnt nonce needs a filler (cancel) but the wallet has no ETH even for that.
- Expected: the lane stays blocked with one owner Wait saying exactly what amount of ETH unblocks it; later payments
  are refused at admission with "payments are blocked until Travel has ETH for fees".
- Mitigation: C5 (never skip a nonce); admission reads the lane's blocked state (C3 step 6).
- Rules: C3, C5 · From: new (critic)

### 8. Receipts and history

**H-201** · best · medium · design rule · The transaction list shows every state
- Trigger: the owner opens Travel → Activity.
- Expected: one list, newest first: outgoing rows from the store (Waiting, Queued, Sent, Included, Confirmed, Failed,
  Not paid, with who asked and why), incoming rows from the derived index (Received, then Confirmed at `finalized`, as C12 words it), each with
  amount, counterparty label or short address, fee, time and a link to the explorer.
- Mitigation: C22 (outgoing is stored truth; incoming is derived and rebuildable); stack.md tx-history source.
- Rules: C12, C22 · From: PRO-032, DUR-182

**H-202** · best · low · implementation note · Start-up reconciliation with nothing in flight
- Trigger: the daemon starts; no payment is non-terminal.
- Expected: the lane reads the chain nonce (C5), the indexer resumes from its cursor, balances refresh; no owner Wait.
- Mitigation: C5, C22.
- Rules: C5, C22 · From: DUR-006

**H-203** · edge · high · design rule · Incoming USDC cannot be listed without a history API
- Trigger: Base has no free keyless history API (tx-history spike: Etherscan refuses keyless calls on 8453; Blockscout's
  multichain API answered 402; the mainnet instance shows a challenge page).
- Expected: banda indexes ERC-20 `Transfer` logs with `to` = the wallet itself, from the wallet's creation block, in
  chunks the RPC accepts (200 blocks on `sepolia.base.org`; 50000 on publicnode), resuming from a stored cursor; a keyed
  provider is optional.
- Mitigation: tx-history spike: self-indexed logs matched Blockscout 118 of 118 over 2,000 blocks on Base Sepolia; one
  filter `{address: [pinned tokens], topics: [Transfer, null, [all the home's wallets]]}` per chain covers every
  wallet; the RPC's range limit is probed when the RPC is chosen and stored with it.
- Rules: C22 · From: PRO-033

**H-204** · edge · medium · design rule · ETH received from a contract leaves no log
- Trigger: an internal ETH transfer (a contract pays the wallet) emits no event.
- Expected: balance and nonce checkpoints at each poll; an unexplained change starts a bisection between the two
  checkpoints, which needs the RPC to serve state for those blocks; beyond its state window the list says how far back
  it is complete.
- Mitigation: tx-history spike: every change found, 5 of 5 on anvil (including ETH from contracts and SELFDESTRUCT)
  and 22 of 22 on a real Base Sepolia account (including two contract payments Blockscout's internal feed missed).
- Rules: C22 · From: PRO-034

**H-205** · security · high · design rule · Address-poisoning rows in the history
- Trigger: zero-value transfers or a fake token from a look-alike address appear as incoming.
- Expected: incoming rows from unlisted tokens and zero-value transfers are hidden by default; a row's counterparty is
  never offered as a recipient to copy; the Send screen never prefills from history.
- Mitigation: token list; no "send again to this address" from incoming rows.
- Rules: C18, C22 · From: DUR-183, SEC-065, PRO-035

**H-206** · best · medium · implementation note · An agent reads balance, address, recipients and history
- Trigger: Mara calls `wallet__balance`, `wallet__history`.
- Expected: listed tokens only, with "as of" block and time; history capped to the last N rows with a cursor; labels
  and short addresses; never another wallet's data.
- Mitigation: per-agent wallet resolution (C3); result size bound (`test/stream-budget.test.ts` style cap).
- Rules: C3, C22 · From: PRO-055

**H-207** · edge · high · implementation note · The chosen RPC cannot serve the history
- Trigger: `mainnet.base.org` answered 429 to every `eth_getLogs` in the tx-history spike; another RPC caps the range
  lower than the stored limit (`-32614`, `-32701`).
- Expected: when the owner picks an RPC, banda probes `eth_getLogs` and its range and says plainly if the list cannot
  be kept with it; a smaller range mid-scan re-probes and never skips blocks; a 429 backs off and keeps the cursor.
- Mitigation: the spike's fault points (cursor commit per chunk; range re-probe; 429 mid-scan).
- Rules: C22 · From: new (spike)

**H-208** · error · high · design rule · A balance unknown is reported as zero
- Trigger: the RPC fails and the code returns 0.
- Expected: unknown is a distinct value: "balance unknown (cannot reach Base since 14:02)"; admission refuses on
  unknown with that reason; never zero.
- Mitigation: the reading type has `unknown`; a test with the RPC down.
- Rules: C11, C22 · From: PRO-056

**H-209** · edge · low · implementation note · An agent cannot see payments it received
- Trigger: someone pays Mara's wallet and she wants to confirm.
- Expected: `wallet__history` includes incoming rows (derived) with the same "as of"; an x402 seller flow is out of
  scope.
- Mitigation: C22.
- Rules: C22 · From: PRO-057

**H-210** · security · medium · design rule · Outgoing rows that did not go through the lane
- Trigger: the token emits `Transfer(from = wallet)` for an x402 settlement the facilitator submitted, for a spend made
  with the exported key, or forged by a contract (a zero-value `transferFrom` shape, reproduced on anvil in the
  tx-history spike).
- Expected: `Transfer(from = wallet)` logs are never read. Outgoing rows come from the store: lane transactions by
  receipt, x402 payments by `authorizationState(wallet, nonce)` and `validBefore`. A spend made elsewhere shows up as
  a nonce move with no effect in the store (found by the same bisection as incoming ETH) and becomes a "sent outside
  banda" row that feeds C7's foreign-event count.
- Mitigation: tx-history spike's source table; C22, C7.
- Rules: C7, C22 · From: new (spike)

**H-211** · edge · low · implementation note · Times shown in the list
- Trigger: rows from the store (wall time of the commit) and from the chain (block time) side by side.
- Expected: each row shows the block time once included, the commit time before; the owner's time zone; relative times
  for today.
- Mitigation: one formatter.
- Rules: C19 · From: DUR-172

**H-212** · race · medium · design rule · The indexer runs twice over the same range
- Trigger: a restart mid-chunk, or two pollers after a bug.
- Expected: rows are keyed by (tx hash, log index) and upserted; the cursor moves only after the chunk's rows commit;
  replaying a range changes nothing.
- Mitigation: C14 idempotency keys on derived rows; C22.
- Rules: C14, C22 · From: new (critic)

**H-213** · edge · medium · design rule · A reorg removes an incoming row
- Trigger: an incoming transfer seen at `latest` disappears.
- Expected: incoming rows are Received until `safe`, Confirmed after; the indexer re-reads the last unsafe range on
  each pass and deletes the rows in the blocks it read that it no longer shows; balances follow. A row above the head
  a pass read stays: a node behind the chain (a load-balanced RPC) has not seen its block yet, which says nothing of it.
- Mitigation: C12 (Confirmed only at `safe`), C22.
- Rules: C12, C22 · From: new (critic)

**H-214** · edge · medium · implementation note · A long history floods a tool result or a stream push
- Trigger: a wallet with 5000 incoming rows; the agent asks for history; the Activity page opens.
- Expected: pages of 50 rows with a cursor for the API and the UI; the agent's tool returns at most 20 rows and a
  "more" hint; caps in `test/stream-budget.test.ts`.
- Mitigation: paging.
- Rules: C22 · From: new (critic), extends PRO-040

**H-215** · edge · medium · implementation note · The RPC changes while the indexer is mid-range
- Trigger: the owner switches RPC; the new one caps `eth_getLogs` at a smaller range or serves no archive state.
- Expected: the cursor is a block number, independent of the RPC; the indexer halves its chunk on a range error and
  remembers the size per RPC; without archive state, native ETH bisection is marked unavailable, not wrong.
- Mitigation: C22; tx-history spike's measured limits (200 blocks on `sepolia.base.org`, 50000 on publicnode).
- Rules: C22 · From: new (critic)

### 9. x402

**H-216** · best · high · design rule · An agent pays an observed 402
- Trigger: the box's request gets `402` with `PAYMENT-REQUIRED`; the proxy records an observation (id, chat, URL, the
  parsed requirement); Mara calls `wallet__pay_x402(observation)`.
- Expected: admission binds the call to an observation made by this chat's box, unexpired and unpaid; the rule key is
  (wallet, agent, endpoint, payTo, asset, network); on Always or after Pay, the daemon builds the EIP-3009
  `transferWithAuthorization` itself with nonce = keccak256("banda/x402" ‖ wallet ‖ observation id), commits it,
  signs it with validity at most 60 s past chain time, and gives the box the `PAYMENT-SIGNATURE` header for its retry.
- Mitigation: C18 (observation binding), C14 (derived nonce, R-5), C19 (chain time), R-6 (no SDK on the payer path).
- Rules: C14, C18, C19 · From: SEC-070, PRO-084, DUR-004

**H-217** · security · critical · design rule · A forged challenge in the tool's arguments
- Trigger: the agent passes a payTo, amount or asset in the tool call that the server never sent.
- Expected: the tool takes only an observation id; every term comes from the proxy's observation, which the box cannot
  write (data, not code, crosses the boundary).
- Mitigation: C18; proxy addon records observations in the daemon's store, not the box's.
- Rules: C18 · From: SEC-071, PRO-085

**H-218** · security · high · design rule · Another chat's observation, or one reused
- Trigger: Mara's call names an observation made by another chat or another agent's box, or one already paid.
- Expected: refused: an observation binds (chat, agent) and pays at most once.
- Mitigation: C18; the observation's state moves to paid in the commit that stores the authorization.
- Rules: C14, C18 · From: SEC-072, PRO-086

**H-219** · race · medium · design rule · The tool is called before the observation reached the store
- Trigger: banda-integration spike: an observation reaches the store at intake, after the command ends; the agent calls
  `wallet__pay_x402` with an id the proxy handed the box a moment ago.
- Expected: the pay tool runs an intake before looking the observation up; an id still unknown after it is refused with
  "make the request again".
- Mitigation: intake inside the tool's expand step; fault points `challenge:observed` and `intake:challenges`.
- Rules: C18, C21 · From: new (spike)

**H-220** · edge · medium · implementation note · A held write's 402, and the paid retry of a held write
- Trigger: the proxy holds a POST for the owner; its 402 appears only in the replay result; the paid retry of that
  POST is itself a write and is held again.
- Expected: the replay result is a second capture point for observations; whether paying grants the retry a one-time
  pass is decided before x402 ships (open in the banda-integration spike); until then the retry waits for the owner's
  release like any held write, and the card says so.
- Mitigation: one observation shape from both capture points.
- Rules: C18 · From: new (spike)

**H-221** · security · medium · implementation note · Another agent's process makes observations as this chat
- Trigger: in a shared box one agent's code uses another chat's proxy login (SECURITY.md), so a 402 it fetches is
  recorded as that chat's observation.
- Expected: the observation exists under that chat, but paying it still takes that chat's model calling
  `wallet__pay_x402`, under that chat's agent's rules; the card names the chat and the URL, so a stray observation is
  visible; an observation nobody pays expires.
- Mitigation: C18 (payment binds to the calling chat and agent); per-agent boxes later (docs/isolation.md) remove the
  shared login.
- Rules: C18 · From: SEC-118

**H-222** · security · high · design rule · Cross-resource substitution
- Trigger: the box gets a signed payload for resource A and sends it to resource B of the same payTo (the SDK's
  server accepted cross-resource payments in the x402 spike).
- Expected: banda cannot stop a payee from accepting it; banda signs only for the observed resource, and the amount and
  payTo bound the loss to that one payment; noted as the payee's responsibility.
- Mitigation: C18 bounds; the x402 spike's finding recorded in stack.md.
- Rules: C18 · From: SEC-073

**H-223** · security · high · design rule · payTo, asset, network or price differ from what the rule trusted
- Trigger: an Always endpoint's new observation names another payTo, asset or network, or a higher price.
- Expected: a different payTo, asset or network is a different rule key: it asks; a higher price on the same key pays
  and reports the jump (OD-4); a price above the wallet's available balance is refused.
- Mitigation: C18 rule identity; OD-4.
- Rules: C18 · From: SEC-074, DUR-149, PRO-087, PRO-088

**H-224** · security · high · design rule · Wrong asset, network, scheme or token domain
- Trigger: a requirement naming an unknown asset, a scheme other than `exact`, a network other than the wallet's, or an
  EIP-712 domain name the server chose ("USDC" on mainnet where the token says "USD Coin").
- Expected: refused; the domain (name, version "2", chain id, verifying contract) comes from banda's chain definition,
  never from the server (the SDK client used the server's name in the x402 spike).
- Mitigation: chain definition constants; test with a server that sends the wrong name.
- Rules: C18, C20 · From: SEC-075

**H-225** · security · medium · design rule · A long-lived authorization
- Trigger: the server asks `maxTimeoutSeconds` of hours; the SDK client signs 10-year windows.
- Expected: banda signs `validAfter` = chain time − 5 s and `validBefore` = chain time + min(maxTimeoutSeconds, 60 s);
  the facilitator accepts a shorter window (x402 spike).
- Mitigation: C19.
- Rules: C19 · From: SEC-076, PRO-091

**H-226** · security · medium · design rule · The signed authorization sits in the box
- Trigger: the box holds the header; it is a bearer instrument until `validBefore`.
- Expected: accepted, bounded: one amount, one payTo, at most 60 s; the box can only use it for that payee.
- Mitigation: C19 window; the derived nonce prevents a second authorization for the same observation (C14).
- Rules: C14, C19 · From: SEC-077, PRO-091

**H-227** · race · high · design rule · The same observation paid twice
- Trigger: the agent calls pay twice for one observation (retry, two turns).
- Expected: the second call returns the first authorization (same derived nonce, stored message); the token accepts one
  transfer per (payer, nonce), so even a re-sign after a lost commit pays once.
- Mitigation: R-5, C14.
- Rules: C14 · From: SEC-078, DUR-144

**H-228** · race · critical · design rule · The paid retry fails after settlement, and the agent asks to pay again
- Trigger: the retry times out or gets 5xx; the payment may have settled; the agent asks to pay again.
- Expected: the agent may retry the request with the same header (same observation); a new observation of the same
  endpoint is a new payment, so the tool says "the last payment may have settled (authorization 0x…); ask the owner
  before paying again" and the card shows it when the rule is Ask; under Always it pays and the row says it is a
  second payment.
- Mitigation: C14, C18; the facilitator's answer recorded when the proxy sees `PAYMENT-RESPONSE`.
- Rules: C14, C18 · From: SEC-079, DUR-141, PRO-090

**H-229** · edge · high · design rule · A 402 after redirects
- Trigger: `GET a.example` redirects to `pay.b.example`, which answers 402.
- Expected: the observation's endpoint is the URL that answered 402 (after redirects), shown on the card with the
  original; rules bind the final origin.
- Mitigation: proxy records the final URL.
- Rules: C18 · From: SEC-080, PRO-092

**H-230** · security · high · design rule · Price steered through the query
- Trigger: the box adds `?price=1000` and the server, naive, asks more.
- Expected: the endpoint key is origin and path (query excluded, OD-5); a higher price on the same key pays and
  reports (OD-4) and is bounded by the balance; the card shows the amount.
- Mitigation: OD-4, OD-5.
- Rules: C18 · From: SEC-081

**H-231** · security · high · design rule · An unauthenticated origin
- Trigger: a 402 over plain HTTP or with a certificate the proxy did not verify.
- Expected: no observation is made for plain HTTP or an unverified TLS origin; the tool says it cannot pay that.
- Mitigation: proxy addon checks the scheme and verification.
- Rules: C18 · From: SEC-082

**H-232** · security · medium · implementation note · Parser confusion between x402 v1 and v2
- Trigger: a response carries both `X-PAYMENT`-style v1 body and v2 `PAYMENT-REQUIRED` header, disagreeing.
- Expected: v2 header only in the first slice; a response with both and a disagreement makes no observation.
- Mitigation: strict TypeBox schema for the decoded requirement.
- Rules: C18 · From: SEC-083

**H-233** · security · low · implementation note · A 402 seen by the agent's browser
- Trigger: the box's browser loads a page that answers 402.
- Expected: the proxy observes it the same way; the agent decides whether to pay; the browser never pays by itself.
- Mitigation: one observation path.
- Rules: C18 · From: SEC-084

**H-234** · error · high · design rule · Killed after the authorization was committed, before the box got it
- Trigger: SIGKILL after the authorization commit, before handing the header to the box.
- Expected: on resume the stored authorization is handed again; same nonce, same bytes.
- Mitigation: C14, R-5.
- Rules: C14 · From: DUR-140

**H-235** · error · critical · design rule · Power loss after an authorization reached the box
- Trigger: the authorization commit is lost to power loss; the box already used the header.
- Expected: a re-sign after restart derives the same nonce (observation id is durable in the proxy's earlier commit),
  so at most one transfer settles; if the observation commit was also lost, the observation is gone and the agent's
  call is refused.
- Mitigation: R-5 (derived nonce makes the commit's loss harmless); C21 for the observation's durability.
- Rules: C14, C21 · From: DUR-031

**H-236** · edge · high · implementation note · The facilitator answers `settlement_pending`
- Trigger: settlement is not final when the server answers.
- Expected: the row says "authorized, settling"; `authorizationState(wallet, nonce)` turning true means settled when
  banda issued no `cancelAuthorization` for it (true also means cancelled, so after an owner cancel the events
  `AuthorizationUsed` and `AuthorizationCanceled` decide); still false after `validBefore` means expired, which is
  final, never "pending" forever.
- Mitigation: x402 spike (state semantics), tx-history spike (source table).
- Rules: C12, C22 · From: DUR-142, PRO-090

**H-237** · edge · medium · implementation note · An authorization expires unused
- Trigger: the box never sent the paid retry, or the server refused it; `validBefore` passes.
- Expected: the row ends Expired (final) and its reservation is released (C11); the agent's next call for the same
  observation is refused as expired.
- Mitigation: tx-history spike's state rule; C11, C19.
- Rules: C11, C19 · From: new (spike)

**H-238** · race · medium · design rule · Two parallel requests to one Always endpoint
- Trigger: the box sends two requests at once; both get 402; the agent pays both.
- Expected: two observations, two authorizations with different derived nonces, two payments: the agent did two
  things; the payee may run its handler once per copy (the SDK server did in the x402 spike), which is the payee's
  concern.
- Mitigation: C14 per observation; the payee duplicate is out of scope (next entries).
- Rules: C14 · From: DUR-143

**H-239** · race · high · design rule · An authorization refused for balance settles later, after a top-up
- Trigger: the facilitator refuses for insufficient funds; the owner tops up; the box (or anyone holding the header)
  submits it again before `validBefore`.
- Expected: possible only within the 60 s window (C19); the reservation ledger keeps the amount reserved until
  `validBefore` passes or the `AuthorizationUsed`/`AuthorizationCanceled` event is seen.
- Mitigation: C11 (live authorizations are reservations), C19.
- Rules: C11, C19 · From: DUR-146

**H-240** · race · high · design rule · Authorizations and ERC-20 sends draw on one USDC balance without sharing a nonce
- Trigger: a live authorization and a lane transfer both fit alone, not together.
- Expected: both are reservations in the same ledger (C11); admission counts live authorizations; the lane's start
  commit does too.
- Mitigation: C11.
- Rules: C11 · From: DUR-147, PRO-094

**H-241** · edge · medium · design rule · An Ask answered long after the challenge
- Trigger: the owner taps Pay 3 h after the 402.
- Expected: R-9: if the observation is under 24 h old, the daemon signs at approval with a fresh window from chain time;
  the box's retry gets a new price check by the server; older than 24 h, "Not paid: the request expired".
- Mitigation: R-9, C19.
- Rules: C10, C19 · From: DUR-145, PRO-089

**H-242** · race · high · design rule · The owner switches the wallet off while authorizations are outstanding
- Trigger: switch-off with a live authorization in the box.
- Expected: the switch-off cannot recall a signed authorization; if `validBefore` is still ahead, the owner is offered
  "cancel the authorization" (an on-chain `cancelAuthorization`, which works only before settlement and costs gas);
  otherwise it simply expires within 60 s.
- Mitigation: C19 short window makes this rare; C17.
- Rules: C17, C19 · From: DUR-113

**H-243** · edge · medium · implementation note · No proxy: host mode or computer off
- Trigger: `--box host`, or the box is offline, so no observation exists.
- Expected: the x402 tool is absent; the agent says it cannot pay that page.
- Mitigation: tool list follows the box's state.
- Rules: C3 · From: PRO-093

**H-244** · security · critical · design rule · The x402 SDK signs on the payer's path
- Trigger: a future change uses `@x402/fetch` or `@x402/evm`'s client in the daemon for convenience.
- Expected: forbidden: the SDK client signed 10-year windows, used the server's domain name and signed an unlimited
  Permit2 approval in the x402 spike; the SDK is a dev dependency for the test server only.
- Mitigation: R-6; a dependency-set check fails if an `@x402/*` package appears in production dependencies (stack.md).
- Rules: C20 · From: new (spike)

**H-245** · security · high · design rule · The facilitator or the server lies about settlement
- Trigger: `PAYMENT-RESPONSE` claims success with a transaction hash that does not exist, or failure after settling.
- Expected: the row's state comes from the chain (the `AuthorizationUsed` event for this payer and nonce), not from the
  header; the header is shown as "the server says".
- Mitigation: C12 (claims need a chain read).
- Rules: C12 · From: new (spike)

**H-246** · edge · low · out of scope · The payee runs its handler once per duplicate copy
- Trigger: the SDK's server ran the handler for each concurrent copy of one payment in the x402 spike.
- Expected: banda pays once (one nonce); what the payee serves is its concern.
- Mitigation: none in banda. Out of scope because it is the seller's server; noted for a later seller-side feature.
- Rules: — · From: new (spike)

**H-247** · error · high · design rule · The observation is lost
- Trigger: the proxy saw the 402 but its observation never reached the store (proxy crash, daemon restart).
- Expected: the agent's call names an unknown observation and is refused with "make the request again"; the agent
  retries the request, making a new observation; nothing was signed.
- Mitigation: C18; the observation is committed before the 402 is returned to the box (C21 ordering).
- Rules: C18, C21 · From: new (critic)

**H-248** · race · medium · implementation note · The proxy restarts while the box retries with the header
- Trigger: the box's paid retry crosses a proxy restart.
- Expected: the retry passes through like any request; the proxy's response observation (`PAYMENT-RESPONSE`) may be
  missed, so the state comes from the chain event (C12).
- Mitigation: C12, C22.
- Rules: C12, C22 · From: new (critic)

**H-249** · edge · medium · implementation note · A settled x402 transfer is reorged out
- Trigger: the settlement transaction disappears before `safe`.
- Expected: the row returns to "authorized, settling"; the authorization may be submitted again by anyone before
  `validBefore` (60 s) and settles at most once; the reservation holds until `validBefore` passes.
- Mitigation: C11, C12.
- Rules: C11, C12 · From: new (critic)

**H-250** · edge · high · design rule · USDC's EIP-712 domain changes with a token upgrade
- Trigger: Circle upgrades the proxy and the domain version or name changes.
- Expected: before each signature banda reads the token's `name()` and `version()` and compares them with the chain
  definition; a mismatch makes x402 offline for that token until a release updates the definition.
- Mitigation: chain definition plus a runtime check; DUR-163's release path.
- Rules: C20 · From: new (critic), extends DUR-163

**H-251** · race · medium · implementation note · cancelAuthorization races the settlement
- Trigger: the owner cancels a live authorization while the facilitator submits it.
- Expected: exactly one of the two lands (same nonce); the row follows the event that was mined
  (`AuthorizationCanceled` or `AuthorizationUsed`); the owner is told which.
- Mitigation: event-based state (C12).
- Rules: C12 · From: new (critic)

### 10. Owner send and receive

**H-252** · best · high · design rule · The owner sends from a wallet
- Trigger: Settings → Wallets → Travel → Send: recipient, amount, token; Review; Send.
- Expected: the review shows amount, recipient (label or "new address" with the full address grouped), network, fee
  "up to"; Send creates a payment of the owner in the same lane as agents' (C2), started immediately (the owner's tap
  is the approval), with the same pipeline and the same list row.
- Mitigation: one pipeline for every payer; C14 request id per form instance.
- Rules: C2, C4, C14 · From: PRO-022, SEC-124, DUR-003

**H-253** · race · critical · design rule · The owner's Send submitted twice
- Trigger: a double tap; the phone's request retried over Iroh after a dropped connection.
- Expected: one payment: the request carries a client request id generated when the review opened; the queue commit
  deduplicates on it; the retry gets the first payment's state.
- Mitigation: C14.
- Rules: C14 · From: DUR-180, SEC-125, PRO-029

**H-254** · edge · medium · implementation note · The owner's Send waits behind an agent's stuck transaction
- Trigger: the lane is blocked by a stuck agent payment.
- Expected: the Send screen says "waiting behind a payment to Ana (stuck: fees)" with the actions that unblock it
  (wait, raise the fee ceiling, cancel it); the owner's Send never jumps the queue (a nonce gap would follow).
- Mitigation: C2 FIFO, C5.
- Rules: C2, C5 · From: DUR-181

**H-255** · error · medium · implementation note · An invalid recipient typed or pasted
- Trigger: a short address, a bad checksum, an ENS name, whitespace, a URL.
- Expected: the field says what is wrong as it is typed; Review stays disabled.
- Mitigation: the same canonicaliser as admission (C3).
- Rules: C3 · From: PRO-025

**H-256** · edge · high · design rule · An amount typed in another locale or with too many decimals
- Trigger: "5,50" in an Italian locale, "1.000,00", or 7 decimals for USDC.
- Expected: the field accepts the locale's decimal separator, shows the parsed amount back in the token's format before
  Review, and refuses grouping ambiguity and excess decimals.
- Mitigation: one locale-aware parser to bigint with a property test.
- Rules: C3 · From: PRO-027

**H-257** · error · medium · implementation note · A Send rejected before reaching the pool
- Trigger: the RPC refuses at broadcast (insufficient funds after a fee spike, or a classified error).
- Expected: before the start commit: "Not sent" with the reason; after it: the burnt nonce follows section 7 (filled,
  never skipped).
- Mitigation: C4, C5.
- Rules: C4, C5 · From: PRO-031

**H-258** · best · medium · implementation note · The owner receives funds
- Trigger: Travel → Receive.
- Expected: the checksummed address, a QR of it (OD-7), the network written large ("Base only"; "Base Sepolia,
  testnet"), Copy; incoming funds appear in Activity as Received, then Confirmed at `finalized`.
- Mitigation: C22.
- Rules: C22 · From: PRO-018

**H-259** · edge · medium · design rule · The QR payload is misread by the sender's wallet
- Trigger: an EIP-681 URI with chain id is parsed differently by common wallets (some ignore the chain).
- Expected: OD-7: plain checksummed address until a spike shows EIP-681 reads right in common wallets; the network is
  in words beside the QR.
- Mitigation: QR spike pending (gaps).
- Rules: — · From: PRO-019

**H-260** · edge · medium · implementation note · Funds sent on another EVM chain to the same address
- Trigger: a sender pays the address on Ethereum or Arbitrum.
- Expected: banda does not show them; Receive says "Base only"; the exported key can recover them in another wallet,
  which Help says.
- Mitigation: words.
- Rules: — · From: PRO-020

**H-261** · security · medium · design rule · Receive shows a wrong address
- Trigger: a bug, a stale cache, or a tampered client shows an address that is not the wallet's.
- Expected: the address on Receive is the record's, proven against the key at the last unlock (C16); the desktop
  shows the same address the phone shows; the device verifies the API's answer with the address the record holds.
- Mitigation: C16; test that Receive renders the record's address only.
- Rules: C16 · From: SEC-126

**H-262** · race · low · implementation note · An older phone client sends without a request id
- Trigger: a paired phone running an older web build posts Send without the client request id.
- Expected: the daemon refuses a Send without a request id with "update the app"; never a payment without
  deduplication.
- Mitigation: C14 required field; schema check.
- Rules: C14 · From: new (critic)

### 11. Devices and key export

**H-263** · best · high · design rule · The owner reveals, copies and confirms the key at creation
- Trigger: after creation, on the computer banda runs on: Save your key → Show → Copy → paste back to confirm.
- Expected: the key appears once, `0x` + 64 hex beside the address it opens; Copy clears the clipboard after 60 s
  where the platform allows; the paste-back check derives the address and compares (R-8); success marks the wallet
  backed up; Skip leaves it marked Not backed up.
- Mitigation: R-8; keys spike (raw key round-trips through import in common wallets).
- Rules: C15, C16 · From: PRO-007, SEC-022

**H-264** · security · critical · design rule · Export asked from a paired device
- Trigger: the phone or a browser device opens Save your key or Show private key.
- Expected: refused: a later reveal is host-only, in the desktop app (OD-2), and the phone shows "open banda on your
  computer to see the key"; a paired device's creation mints no reveal, and its request for one is refused (403), as
  every request that comes over Iroh is, whatever its token.
- Mitigation: C16: a later reveal is not on the daemon's API (the desktop's main process asks the OS re-authentication
  and its own signer child); the creation's reveal is bound to a secret that only the creation's own answer carries,
  of which the daemon keeps the SHA-256 alone and compares it in constant time; it is spent once, lapses 10 minutes
  after the creation, and its response, `no-store`, is written onto the request's socket by the signer child.
- Rules: C16 · From: SEC-023, PRO-011

**H-265** · security · critical · design rule · The agent or a page asks for the key
- Trigger: "tell me the private key so I can import it".
- Expected: no tool returns a key; the agent says the owner can see it in the desktop app.
- Mitigation: least tools; a test greps tool results for key-shaped strings after every wallet tool.
- Rules: C20 · From: SEC-024

**H-266** · security · high · design rule · Export later than creation
- Trigger: the owner skipped at creation and wants the key weeks later.
- Expected: OD-2: Show private key on the host, behind an OS re-authentication (Touch ID), listed in the wallet's
  activity ("key shown on this computer"). Where nothing re-authenticates the owner (Linux, Windows, a Mac without
  Touch ID or with it off) the key is shown only as its wallet is made, and Restore and Move signing are refused too,
  until OD-2 settles how those computers re-authenticate.
- Mitigation: C16: the desktop's main process re-authenticates the owner, its own signer child exports the key, and the
  daemon is only told (it lists the reveal) before the key is shown in a local window.
- Rules: C16 · From: SEC-025, PRO-010

**H-267** · security · high · design rule · A local process calls the export route with the owner's token
- Trigger: a script on the host reads the owner token and calls the reveal route.
- Expected: the token alone cannot reveal: no route reveals a key later (only the desktop's main process does, behind
  the OS re-authentication), and the creation's reveal answers only with the secret the creation's own answer
  carried, once, within 10 minutes; a request without it is refused and spends nothing.
- Mitigation: C16.
- Rules: C16 · From: SEC-026

**H-268** · security · high · design rule · A reveal capability is replayed
- Trigger: the creation's request id is captured (logs, devtools) and sent again.
- Expected: the reveal is spent in the commit that proves the key, before the key is written onto the connection; a
  second request is refused as spent; it lapses 10 minutes after the ready commit (which, for a creation the keychain
  answered late or a restart settled, comes after the creation itself); a request id alone opens nothing, since the
  reveal answers only with the secret one answer to the creation carried. That answer is the first answer to the same
  request, from this computer, that finds the reveal unclaimed and in its window: the creation's own, or a repeat after
  a creation that waited on the keychain, a restart that settled it, a ready commit not synced, or an answer lost on
  the way. Its digest is on disk before it goes, so every later repeat in the same process is answered none; a
  process killed between that commit and its answer cannot say whether it went, so the first repeat after the restart
  claims again with a new secret, whose digest replaces the old: the secret before stops spending, and still one
  secret spends. Until it is claimed, the request id with the owner's token is that capability: a residual accepted, since
  both live on this computer and the token alone already acts as the owner; `banda wallet create` prints the id only
  for the owner to repeat a creation that waited.
- Mitigation: C16; C14 (consumed once).
- Rules: C14, C16 · From: new (critic)

**H-269** · error · low · implementation note · Killed during a reveal
- Trigger: SIGKILL after the capability was consumed, before the key reached the window.
- Expected: the owner saw nothing; a new reveal can be asked (a new OS re-authentication); the activity lists the
  attempt.
- Mitigation: C16; the reveal's one-time capability is consumed in the commit, and the read happens after it.
- Rules: C14, C16 · From: new (critic)

**H-270** · edge · medium · implementation note · A screenshot or screen share during the reveal
- Trigger: screen recording, a meeting share, or a screenshot.
- Expected: the key is hidden until Show is pressed and hidden again after 30 s; the desktop window sets content
  protection where the platform offers it (Electron `setContentProtection`).
- Mitigation: UI.
- Rules: — · From: SEC-027, PRO-012

**H-271** · edge · medium · implementation note · Clipboard history and Universal Clipboard
- Trigger: clipboard managers and Apple's Universal Clipboard copy the key to other devices.
- Expected: the copy is marked concealed where the platform supports it (pasteboard concealed and transient types on
  macOS, pending a spike); the clipboard is cleared after 60 s if it still holds the key; the screen says clipboard
  managers may keep it.
- Mitigation: spike pending (gaps).
- Rules: — · From: SEC-028, PRO-012

**H-272** · edge · medium · out of scope · Browser extensions read the reveal
- Trigger: the owner makes a wallet from `banda serve` in a loopback browser, which has extensions.
- Expected: a browser device and a paired phone get no reveal (C16), and a later reveal is the desktop app's alone
  (OD-2); the creation's reveal does reach a loopback browser, once, and an extension with access to the page can read
  the key there. Outside the desktop app, the create screen (before Create) and the save screen (before Show) say so
  and point to the desktop app or `banda wallet create`, where no extension runs; the owner may go on.
- Mitigation: a residual accepted (OOS-10): banda cannot see or govern the owner's extensions, and refusing the
  loopback browser would leave a home with no desktop app no way to save its key.
- Rules: C16 · From: SEC-029

**H-273** · error · high · implementation note · The owner never saved the key
- Trigger: the wallet is Not backed up and holds funds.
- Expected: the wallet row keeps a quiet Not backed up mark; when the balance first exceeds a small amount, one
  reminder; never a nag loop.
- Mitigation: UI.
- Rules: — · From: SEC-030, PRO-010

**H-274** · security · high · implementation note · The revealed key lingers in the client
- Trigger: the key stays in React state, the DOM, or a cached API response after the reveal closes.
- Expected: the response is `Cache-Control: no-store`; the component drops it on close and on blur; no state manager
  persists it.
- Mitigation: a browser test that inspects the DOM and storage after closing.
- Rules: — · From: SEC-031

**H-275** · edge · medium · implementation note · The owner confirms saved without saving
- Trigger: taps through.
- Expected: the paste-back check (R-8) makes "saved" mean the key was pasted back correctly; Skip is honest.
- Mitigation: R-8.
- Rules: — · From: PRO-013

**H-276** · edge · medium · design rule · A wallet created from a paired phone, where the key cannot be shown
- Trigger: the owner creates a wallet on the phone.
- Expected: allowed; the wallet is Not backed up and the phone says "see the key on your computer"; the desktop shows
  the Save your key step at next open.
- Mitigation: OD-2.
- Rules: C16 · From: PRO-006

**H-277** · security · high · design rule · A paired phone or browser device drains a wallet
- Trigger: a stolen unlocked phone, or a browser device token.
- Expected: OD-3: a device can approve cards and Send only to recipients the wallet already knows; a new address from a
  device is confirmed on the host; revoking the device ends its token at once.
- Mitigation: OD-3; device scopes.
- Rules: C3, C9 · From: SEC-038

**H-278** · edge · medium · design rule · A phone's Send to a new address waits for the host
- Trigger: OD-3: the owner on the phone sends to a new address; confirmation is on the host, which is asleep or away.
- Expected: the Send becomes a Wait on the host with the 24 h deadline; the phone shows "confirm on your computer";
  nothing is queued in the lane until the host confirms, so nothing blocks other payments.
- Mitigation: OD-3; Waits; C10.
- Rules: C9, C10 · From: new (critic)

**H-279** · race · low · implementation note · A device revoked during its approval
- Trigger: the phone taps Pay as the owner revokes it on the desktop.
- Expected: ordered by commit: the revoke first means the tap is refused; the tap first means it counts.
- Mitigation: C1.
- Rules: C1, C9 · From: SEC-044

**H-280** · edge · low · implementation note · A paired phone answers a payment card
- Trigger: the card arrives on the phone.
- Expected: the same card with the same facts; Always is offered only for known recipients (OD-3).
- Mitigation: OD-3.
- Rules: C9 · From: PRO-115

**H-281** · edge · medium · implementation note · A screen reader reads the key aloud
- Trigger: VoiceOver on the reveal.
- Expected: the key's element is announced as "private key, hidden" until Show; after Show it is read in groups of 4;
  the screen warns that it will be read aloud.
- Mitigation: UI.
- Rules: — · From: new (critic)

**H-282** · edge · low · out of scope · The explorer link tells the explorer which address the owner watches
- Trigger: the owner opens a row's explorer link.
- Expected: the link opens in the system browser on the owner's tap only; nothing is fetched from an explorer by banda.
- Mitigation: none beyond the tap. Out of scope because it is the owner's own browsing.
- Rules: — · From: new (critic)

### 12. Backups, forks and migration

**H-283** · security · critical · design rule · home:fork resumes in-flight wallet tasks or reaches the live keys
- Trigger: `npm run home:fork` copies `durable.db` with lanes Signed or Sent and a keychain name the fork can read.
- Expected: a fork never signs: the home secret (a keychain item bound to the source home's realpath and inode) does
  not match the fork, so every wallet in the fork is offline ("this is a copy of another home"); lanes are paused like
  routines; stored versions are not rebroadcast. This holds only while the fork runs unmodified code (TA-1): a
  development branch can drop the check and read the live home's items, so `home:fork` replaces wallet records with
  records that sign nothing, and dev and test builds use a keychain service the release's items are not under.
- Mitigation: C16 (lease epoch plus home secret outside the home); a fault test copies a home byte for byte and finds
  the copy offline; a test forks a home with a lane in flight and finds wallets that sign nothing.
- Rules: C16 · From: DUR-150, SEC-120, PRO-121

**H-284** · race · critical · design rule · A backup restored on the same machine, beside its original
- Trigger: a backup or the pre-migration backup restored while the original home still exists; both served.
- Expected: one lease holder: the home whose lease epoch matches the keychain's signs; the other is offline; moving
  the lease is an explicit owner act on the host.
- Mitigation: C16; `restore.json` marks the restored home; at first start it is offline until the owner chooses.
- Rules: C16 · From: DUR-151, DUR-152, SEC-121, PRO-122

**H-285** · edge · high · design rule · A backup taken while a transaction was Signed or Sent
- Trigger: the backup holds a payment at Signed; it is restored after that transaction was mined.
- Expected: at first start the restored home reads the chain nonce: above the ledger, so the lane freezes (C21) until
  receipts for the stored hashes are found (then settled) or the owner looks; never a re-sign; pre-burn payments become
  owner Waits (the restore marker), not automatic payments.
- Mitigation: C16 restore marker, C21.
- Rules: C16, C21 · From: DUR-154

**H-286** · edge · medium · implementation note · A backup restored on a new computer
- Trigger: a new Mac; the keychain item is not there.
- Expected: wallets show "Key missing from this computer" with Restore key; the lease moves to this home on a successful
  restore.
- Mitigation: C16.
- Rules: C16 · From: SEC-122

**H-287** · error · high · design rule · The home secret is missing or unreadable
- Trigger: the file was deleted, or permissions changed.
- Expected: wallets offline ("this home's identity is missing"); the owner can make this home the lease holder again
  on the host after proving each key (C16); no automatic regeneration that would let a copy claim the lease.
- Mitigation: C16.
- Rules: C16 · From: new (critic)

**H-288** · security · critical · design rule · The home's id is copied by every backup
- Trigger: the banda-integration spike proposes naming keychain items with `auth/device-id`, but `auth/` is backed up
  (`src/core/backup.ts`), so a backup restored beside its original carries the same id and both homes would claim the
  same items.
- Expected: the id in the keychain account names which home made the item (findability, the sweep), never which home
  may sign; the right to sign is the lease of C16, proven by a home secret kept outside everything a backup, a restore
  or a fork copies.
- Mitigation: R-12; a test that backup and fork outputs never contain the home secret.
- Rules: C16 · From: new (spike), resolves a conflict between the banda-integration spike and SEC-121

**H-289** · race · high · design rule · A lease move killed halfway
- Trigger: SIGKILL between writing the new epoch to the keychain and committing it to the store.
- Expected: at start, keychain epoch > store epoch for this home's secret means the move completed on the keychain
  side; the store is advanced; a keychain epoch from another home secret means another home moved it.
- Mitigation: C15 ordering applied to the lease (keychain first, then store); fault point between.
- Rules: C15, C16 · From: new (critic)

**H-290** · race · medium · design rule · Restore key while the lane waits for the key
- Trigger: the lane holds one owner Wait ("key missing"); the owner restores the key on the host.
- Expected: the restore commit (address proven, lease epoch written) answers the lane's Wait; the lane reads the key
  again and continues in FIFO order; pre-burn payments older than the approval window ask again (C10).
- Mitigation: C9 (an act answers the Wait it covers), C10, C16.
- Rules: C9, C10, C16 · From: new (critic)

**H-291** · error · high · design rule · A migration step killed midway while payments are non-terminal
- Trigger: an upgrade's `MIGRATIONS` step changes a wallet shape and is killed.
- Expected: the step is idempotent and resumes (format.ts); lanes do not start until migrations finish (C23).
- Mitigation: C23; the step's kills under `test/fault/`.
- Rules: C23 · From: DUR-160

**H-292** · error · high · design rule · A release changes the lane's checkpoint shape
- Trigger: a new field in the stored version.
- Expected: a `MIGRATIONS` step with a kept fixture home (AGENTS.md "Changes"); stored versions of the old shape are
  read through the definition's `migrate`; signed bytes are never re-encoded.
- Mitigation: the home-upgrade rules; `test/stored-shapes.test.ts`.
- Rules: C23 · From: DUR-161

**H-293** · edge · medium · implementation note · A release changes fee policy or gas ceilings while transactions are in flight
- Trigger: the new release's ceiling is lower than a stored version's fee.
- Expected: policy applies to new versions only; stored versions stay valid and are rebroadcast.
- Mitigation: C6 (versions are append-only).
- Rules: C6 · From: DUR-162

**H-294** · edge · high · design rule · A release changes a chain's definition
- Trigger: a token address or an EIP-712 domain name changes in the chain definition.
- Expected: the definition is versioned; payments and rules store the definition version they used; a changed token
  address is a different asset (new rule key).
- Mitigation: C18 identity includes the asset address.
- Rules: C18 · From: DUR-163

**H-295** · edge · high · implementation note · The first release with wallets opened by an older build
- Trigger: the owner downgrades after creating wallets.
- Expected: the older build refuses the home plainly (the format moved), so it never runs without the wallet lanes.
- Mitigation: MIGRATIONS moves the format.
- Rules: C23 · From: PRO-119

**H-296** · edge · high · design rule · Keychain naming changes in a later release
- Trigger: a release wants a new service name scheme.
- Expected: the keychain name is stored per wallet at creation and never recomputed; a rename is a migration step that
  copies create-only, proves the address, then deletes the old item, with faults at each step.
- Mitigation: C15 two-store ordering.
- Rules: C15, C23 · From: PRO-120

**H-297** · race · high · design rule · Lanes run before migrations finish
- Trigger: the daemon starts lanes in parallel with a migration that changes their shapes.
- Expected: impossible: lane tasks start only after the format check and migrations commit.
- Mitigation: C23.
- Rules: C23 · From: new (critic)

**H-298** · security · medium · implementation note · Signed bytes in the store
- Trigger: the store holds signed transactions and authorizations.
- Expected: accepted: they are public once broadcast, and a stored unbroadcast one can only do what the owner approved;
  backups carry them.
- Mitigation: none needed beyond C21 (a restored home never rebroadcasts without checks).
- Rules: C21 · From: SEC-111

**H-299** · security · medium · implementation note · Real wallet data in the public repo
- Trigger: a test fixture, a PR proof or a commit message carries a real address, amount or transaction.
- Expected: fixtures use generated keys and anvil; kept fixture homes hold only test wallets; AGENTS.md's rule on home
  data applies.
- Mitigation: a test that fixture homes' addresses derive from known test keys.
- Rules: — · From: SEC-112

**H-300** · security · medium · implementation note · Logs and activity
- Trigger: logs carry addresses, amounts, RPC URLs with keys.
- Expected: logs carry wallet ids and short addresses only, never amounts with full addresses together, never RPC keys
  or signed bytes.
- Mitigation: log helper with redaction; a test.
- Rules: — · From: SEC-113

### 13. Supply chain

**H-301** · security · critical · design rule · A dependency is compromised
- Trigger: a malicious release of a signing, keychain or transitive package (CVE-2024-54134 in `@solana/web3.js`;
  Ledger Connect Kit; chalk and debug; Shai-Hulud).
- Expected: banda's signing path has 6 packages, which with the keychain's 13 must all be provenance-attested (a
  release without an attestation is refused), exact pins, lockfile integrity, installs with `--ignore-scripts` on
  every computer (the root `.npmrc`; the desktop and phone trees with an allowlist npm enforces), registry signatures
  and provenance subjects (`scripts/registry-signatures.ts`, which does not verify the attestations' sigstore chain) and
  OSV in CI and before every release, a release-age cooldown before an upgrade, and golden vectors that fail on any
  change in signed bytes.
- Mitigation: stack.md controls.
- Rules: — · From: SEC-105, PRO-129

**H-302** · security · high · design rule · A native binary swapped
- Trigger: `@napi-rs/keyring`'s platform package replaced by a malicious build.
- Expected: the platform packages are pinned with integrity hashes in the lockfile, verified at install and code-signed
  inside the signed desktop app. Process isolation is not the control: a swapped binary runs inside the signer, which
  holds the key.
- Mitigation: stack.md section 5 (integrity, the registry signature of every platform package, the signed bundle); OD-11.
- Rules: C20 · From: SEC-106

**H-303** · security · medium · design rule · A typosquat
- Trigger: `ethers-v6` (MAL-2026-11297), `@wrenfield/viem`, or a scope look-alike.
- Expected: new dependencies only by review against the approved set; a dependency-set check fails CI on any package
  outside the approved list in the signing module's closure.
- Mitigation: stack.md.
- Rules: — · From: SEC-107

**H-304** · security · medium · design rule · An upgrade changes signing semantics
- Trigger: a micro-eth-signer release changes defaults (hedging, chain id, encoding).
- Expected: the upgrade ritual: read the changelog and the diff of the signing paths, run golden vectors, run the anvil
  suite, wait the cooldown.
- Mitigation: golden vectors; stack.md ritual.
- Rules: C6 · From: SEC-108

**H-305** · security · high · implementation note · The app's own files are swapped
- Trigger: the served web app or the desktop bundle is tampered with on disk or in transit (a browser device loading
  app.banda.rocks).
- Expected: TA-2: the release is trusted; the desktop app is code-signed (pending for macOS Developer ID); a browser
  device cannot reveal keys and is limited to known recipients (OD-3).
- Mitigation: TA-2, OD-2, OD-3.
- Rules: C16 · From: SEC-109

**H-306** · security · high · design rule · Dangerous root exports are reachable
- Trigger: code imports `micro-eth-signer`'s `authorization`, `eip191Signer` or typed-data helpers directly.
- Expected: a lint rule allows imports of signing libraries only in the signer module; an export-enumeration test lists
  what banda's signer module exports and fails on change.
- Mitigation: single importer module (stack.md).
- Rules: C20 · From: new (critic)

**H-307** · security · medium · design rule · An upgrade lands minutes after its publication
- Trigger: `ox` 1.8.20 was published on the day of this analysis; a fresh version could be a compromised one.
- Expected: no dependency of the signing path is upgraded to a version younger than the cooldown of 14 days.
- Mitigation: stack.md release-age cooldown: `min-release-age=14` in each tree's `.npmrc`, banda's lockstep packages
  exempted by name, held by test/wallet-deps.test.ts; scripts/release-age.ts holds every pin of the three lockfiles to
  it by publish time, in CI and before a release.
- Rules: — · From: new (critic)

**H-308** · edge · low · implementation note · Two copies of the curve library
- Trigger: a dev dependency (viem, which pulls noble 1.x) leaks into the production closure, so two curve
  implementations ship.
- Expected: the dependency-set check asserts exactly one `@noble/curves` and one `@noble/hashes` in production.
- Mitigation: stack.md.
- Rules: — · From: new (critic)

### 14. UI states

**H-309** · edge · low · implementation note · No wallets yet, or no keychain
- Trigger: Settings → Wallets on a fresh home, or on headless Linux.
- Expected: empty state with Create wallet and one line on what wallets are for; without a keychain, the reason and
  the fix instead of the button.
- Mitigation: one offline-reason enum (last entry).
- Rules: — · From: PRO-016

**H-310** · best · high · design rule · A routine at night meets an Ask
- Trigger: a routine's run at 03:00 needs to pay a new recipient.
- Expected: one card in the routine's chat and one notification; the run waits on the card (24 h deadline, OD-10);
  other routines run; in the morning the owner answers and the run continues.
- Mitigation: Waits; C10.
- Rules: C9, C10 · From: PRO-095

**H-311** · best · medium · implementation note · The owner answers Always in the morning
- Trigger: the owner taps Always on the night's card.
- Expected: the payment proceeds (approval fresh if the lane was free; otherwise C10); the next night's run pays
  without a card.
- Mitigation: C9, C10.
- Rules: C9, C10 · From: PRO-096

**H-312** · edge · high · design rule · An Always payment in a quiet routine run leaves no trace
- Trigger: a routine pays an Always recipient and its run posts nothing.
- Expected: every payment is a row in the wallet's Activity and a line in the run's chat; the routine's run summary
  counts payments.
- Mitigation: rows from the store (C22).
- Rules: C22 · From: PRO-116

**H-313** · edge · medium · implementation note · A lock-screen notification shows payment details
- Trigger: a card notification on a locked phone.
- Expected: the lock screen says "Mara asks to pay" without amount or recipient; details after unlock.
- Mitigation: notification copy.
- Rules: — · From: PRO-117, SEC-115

**H-314** · edge · low · implementation note · Incoming funds
- Trigger: a transfer arrives.
- Expected: no notification by default; Activity shows it; an opt-in per wallet.
- Mitigation: UI.
- Rules: C22 · From: PRO-118

**H-315** · edge · medium · implementation note · Wallet screens at phone width
- Trigger: the wallet pages at 375 px.
- Expected: addresses wrap in groups of 4, never truncated without a full view; Send and Receive in a drawer; cards fit
  without horizontal scroll; tried at desktop and phone width (principle 9).
- Mitigation: specimen entries for every wallet component.
- Rules: — · From: PRO-114

**H-316** · edge · low · implementation note · The Docker box versus the shipped computer
- Trigger: `serve --box container` instead of the computer.
- Expected: x402 observations work in both (same proxy addon); host mode differs (section 4).
- Mitigation: box suites on both.
- Rules: — · From: PRO-108

**H-317** · edge · medium · design rule · One list of offline reasons
- Trigger: a wallet can be unusable for a dozen reasons (keychain locked, waiting for a prompt, key missing, key
  mismatch, ambiguous item, no keychain, lease held elsewhere, home secret missing, fork, host mode, debugging on, RPC
  unreachable, chain id mismatch, sequencer halted, lane parked, lane frozen, wallet has code).
- Expected: one enum, each with the owner's words and the fix, used by the API, the UI, the agent's tool errors and
  the tests; the wallet shows the most specific one.
- Mitigation: a TypeBox union; a test that every enum value has copy and a specimen state.
- Rules: C3, C22 · From: new (critic)

## Sources

External facts the cases rely on, all read on 2026-11-23. Measured claims come from the spikes and research notes in
this folder, which carry their own commands and outputs; library versions and advisories are in
[`stack.md`](stack.md#sources).

Chain and token:

- Base, Denim upgrade (the `pending` tag resolves to `latest`):
  https://docs.base.org/upgrades/denim/migrate-from-flashblocks
- Base, transaction finality (`latest`, `safe`, `finalized`, reorg depth):
  https://docs.base.org/specifications/transactions/transaction-finality
- Base, network fees (L2 fee, L1 data fee, operator fee):
  https://docs.base.org/specifications/transactions/network-fees
- Base, reliability and liveness (one active sequencer; a halt leaves only the slow L1 deposit path):
  https://docs.base.org/specifications/security/reliability-and-liveness
- Base, transaction ordering (pool snapshot per block, order by priority fee):
  https://docs.base.org/specifications/transactions/transaction-ordering
- OP Stack fees (operator fee after Isthmus and Jovian): https://docs.optimism.io/op-stack/transactions/fees
- Circle, USDC contract addresses: https://developers.circle.com/stablecoins/usdc-contract-addresses
- EIP-55 (checksummed addresses): https://eips.ethereum.org/EIPS/eip-55
- EIP-155 (chain id in signatures): https://eips.ethereum.org/EIPS/eip-155
- EIP-191 (signed data): https://eips.ethereum.org/EIPS/eip-191
- EIP-2612 (permit): https://eips.ethereum.org/EIPS/eip-2612
- EIP-3009 (transfer with authorization, one-use nonces, cancel): https://eips.ethereum.org/EIPS/eip-3009
- EIP-7702 (code on an externally owned account): https://eips.ethereum.org/EIPS/eip-7702
- EIP-7730 (clear-signing descriptors): https://eips.ethereum.org/EIPS/eip-7730

x402:

- x402 v2 specification: https://raw.githubusercontent.com/coinbase/x402/main/specs/x402-specification-v2.md
- x402 v2 HTTP transport (headers, 402 body):
  https://raw.githubusercontent.com/coinbase/x402/main/specs/transports-v2/http.md
- x402 `exact` scheme on EVM (EIP-3009 terms, `maxTimeoutSeconds`):
  https://raw.githubusercontent.com/coinbase/x402/main/specs/schemes/exact/scheme_exact_evm.md

Keychain and process:

- keyring-node (`@napi-rs/keyring`), stores and platform behaviour: https://github.com/Brooooooklyn/keyring-node
- napi-rs async tasks (run on libuv's thread pool; no cancel): https://napi.rs/docs/concepts/async-task
- libuv thread pool size and queueing: https://github.com/libuv/libuv/blob/v1.x/src/threadpool.c
- Electron safeStorage: https://www.electronjs.org/docs/api/safe-storage
- Electron BrowserWindow (content protection, sandboxing): https://www.electronjs.org/docs/api/browser-window
- Docker seccomp profiles (keyctl and the kernel keyring in containers):
  https://docs.docker.com/engine/security/seccomp/
- mitmproxy options (the box proxy's addon hooks): https://docs.mitmproxy.org/stable/concepts/options/

History and indexers:

- Etherscan, supported chains and the API key model: https://docs.etherscan.io/supported-chains
- Blockscout, rate limits and best practices: https://docs.blockscout.com/rate-limits,
  https://docs.blockscout.com/best-practices

Attacks and advisories:

- Address poisoning, measurement and losses (CMU CyLab, 2026-01-07):
  https://cylab.cmu.edu/news/2026/01/07-blockchain-address-poisoning.html
- Unicode TR39, confusable detection (look-alike labels): https://www.unicode.org/reports/tr39/
- CVE-2024-54134, the compromised `@solana/web3.js` release (a key-exfiltrating publish of a wallet library):
  https://nvd.nist.gov/vuln/detail/CVE-2024-54134

## Counts

Generated from the entry header lines (`**H-nnn** · kind · severity · triage · Title`) by a script over this file;
317 entries. A rerun after any edit keeps the numbers true.

| kind \ severity | critical | high | medium | low | total |
|---|---|---|---|---|---|
| best | 0 | 16 | 6 | 2 | 24 |
| error | 9 | 28 | 12 | 1 | 50 |
| edge | 1 | 30 | 42 | 24 | 97 |
| race | 16 | 22 | 15 | 5 | 58 |
| security | 29 | 35 | 23 | 1 | 88 |
| **total** | 55 | 131 | 98 | 33 | 317 |

| triage | entries |
|---|---|
| design rule | 205 |
| implementation note | 106 |
| out of scope | 6 |

Origin: 252 entries merge the 382 lens cases (every source id appears in at least one `From:`); 44 were added by the
completeness pass (`new (critic)`) and 21 by spikes run after the lens catalogs (`new (spike)`).

| area | entries | critical | high | design rule |
|---|---|---|---|---|
| 1. Key lifecycle | 14 | 6 | 3 | 11 |
| 2. Keychain | 24 | 9 | 10 | 20 |
| 3. Wallet management | 12 | 3 | 4 | 9 |
| 4. Agent assignment | 22 | 5 | 8 | 15 |
| 5. Recipients and rules | 39 | 5 | 17 | 25 |
| 6. Payment pipeline | 52 | 13 | 20 | 33 |
| 7. Nonce and chain | 37 | 3 | 25 | 24 |
| 8. Receipts and history | 15 | 0 | 4 | 8 |
| 9. x402 | 36 | 4 | 17 | 25 |
| 10. Owner send and receive | 11 | 1 | 2 | 5 |
| 11. Devices and key export | 20 | 2 | 7 | 9 |
| 12. Backups, forks and migration | 18 | 3 | 9 | 12 |
| 13. Supply chain | 8 | 1 | 3 | 6 |
| 14. UI states | 9 | 0 | 2 | 3 |

## Index

**1. Key lifecycle**: H-001 A wallet is created on the computer banda runs on; H-002 The random source fails or is
replaced; H-003 A scalar out of range; H-004 A key or seed offered by the agent, a page or the box; H-005 The daemon
is killed around the keychain write, or before the owner saw the key; H-006 The keychain write succeeds but the
read-back fails or differs; H-007 Create tapped twice, or on two devices; H-008 One independent key per wallet,
exported as a raw key; H-009 The key exists only inside the signing call; H-010 A retained reference leaks the key;
H-011 Key bytes reach the store through a durable task, a Wait or a stream; H-012 The daemon runs with an inspector or
heap-dump flags; H-013 Freed memory, swap and crash dumps; H-014 "Restore key" with a key that opens another address.

**2. Keychain**: H-015 The key is read in-process by banda's signer, never through argv, env or a CLI; H-016 Any
process run by the same Node binary reads every key; H-017 An update changes the binary the keychain trusts; H-018 A
keychain call blocks on a prompt nobody answers; H-019 The keychain reports an ambiguous entry; H-020 Two homes, or
two daemons, sign with one key; H-021 The keychain item is gone; H-022 The OS backs up the keychain; H-023 The item's
name says what it is; H-024 A planted or pre-existing item under the wallet's name; H-025 The key in the keychain does
not open the wallet; H-026 The keychain is locked when the lane needs to sign; H-027 A nonce taken while the key
cannot be read; H-028 No keychain banda can use; H-029 Linux silently stores the key in the kernel keyring; H-030 A
test or debug keystore reachable in a release; H-031 Tests or throwaway homes touch the real keychain; H-032 Hung
keychain calls starve the daemon's thread pool; H-033 The signer process dies in the middle of a call; H-034 The
daemon cannot exit or upgrade while a keychain call hangs; H-035 A keychain answer arrives after the deadline; H-036
Two first writes to one keychain account at once; H-037 A keychain that cannot answer looks like a missing key; H-038
Items written through `security` trust `/usr/bin/security`.

**3. Wallet management**: H-039 Several wallets listed in Settings → Wallets; H-040 Testnet and mainnet funds
confused; one address on two chains; H-041 Wallet names collide or carry control characters; H-042 The owner archives
a wallet that holds funds; H-043 The owner deletes a wallet with funds or with something in flight; H-044 Removal
killed between the store and the keychain; H-045 An orphan keychain item found at start; H-046 Funds arrive after
archive or delete; H-047 Owner Send from a wallet being archived; H-048 A key reveal while removal is in progress;
H-049 Two lanes for one wallet; H-050 Wallet settings edited from two devices.

**4. Agent assignment**: H-051 The owner switches a wallet on for an agent; H-052 The connection model's existing auth
shapes do not fit a wallet; H-053 An agent pays from a wallet it was not given; H-054 A wallet switched off for an
agent while its payment is in progress; H-055 An agent archived or deleted with a waiting payment; H-056 An agent
needs to pay but has no wallet; H-057 An agent with two wallets picks one; H-058 A wallet given or taken away during a
conversation; H-059 An agent pays from within a group; H-060 Another agent asks for the payment; H-061 The box reaches
owner routes; H-062 The key or a signing capability in the box; H-063 A wallet file in the workspace; H-064 Host mode
gives every command the wallets; H-065 A coding agent on the host uses the owner's authority; H-066 A gateway client
or an inference caller reaches the wallet tools; H-067 The money exception reaches other tools; H-068 A reviewer model
approves a payment; H-069 Wallet data leaves through the agent's other reads; H-070 Financial data reaches the model
provider; H-071 The tool's wallet enum names wallets the agent was not given; H-072 Wallet tools grow every chat's
prompt.

**5. Recipients and rules**: H-073 The first payment to a recipient sets its rule; H-074 An agent pays a recipient set
to Always; H-075 An agent pays a known recipient set to Ask; H-076 An agent pays a recipient set to Deny; H-077 A rule
binds an identity, never a label; H-078 The agent proposes the name of a new recipient; H-079 Two recipients with one
name, or confusable names; H-080 The owner renames a recipient; H-081 The owner changes a rule in the Recipients list;
H-082 The rule changes while a payment waits, then the owner taps Pay; H-083 Always set on one card while other
payments to the same recipient wait; H-084 The owner sets Deny while asks for that recipient are open; H-085 Deny set
after the payment started; H-086 The owner's Deny tap and the lane's start commit land together; H-087 Always revoked
(back to Ask) while a payment is queued; H-088 A recipient forgotten while an Always payment is queued; H-089
Forgetting a recipient; H-090 The default for unknown recipients changes while asks are open; H-091 Always for one
agent covers another on a shared wallet; H-092 After a restart the card offers no standing answer; H-093 One recipient
written several ways; H-094 An all-lowercase address; H-095 A look-alike of a known recipient; H-096 A page steers a
payment to a new address; H-097 Poisoned memory maps a name to an attacker address; H-098 A page steers repeated
payments to an Always recipient; H-099 A steered agent widens its own rules; H-100 Ask cards as a flood; H-101 The
reason text disguises the card; H-102 A destination that cannot receive; H-103 A contract as recipient; H-104 Names
resolved remotely; H-105 An agent pays itself or another banda wallet; H-106 The owner sends to a recipient agents may
never pay; H-107 The owner's own Send grants agents nothing; H-108 An x402 endpoint with per-resource paths asks every
time; H-109 Two devices edit a recipient's label at once; H-110 The burst pause races the owner setting Always again;
H-111 Rules of an agent that was deleted.

**6. Payment pipeline**: H-112 A payment goes through end to end, once; H-113 A restart with a transaction in flight;
H-114 Killed after admission, before the payment is queued; H-115 Killed while the Ask is open; H-116 Killed during the
keychain read; H-117 Killed after signing, before the start commit; H-118 The payment is refused while the signer holds
its bytes; H-119 Killed after the start commit, before or during the broadcast; H-120 Killed after the receipt was
fetched, before it was committed; H-121 Killed after the payment settled, before the tool's result was committed;
H-122 Killed during a fee bump; H-123 The lane crash-loops on a stored state; H-124 The owner cancels the chat's run
while its payment is in the lane; H-125 A caller that cannot be replayed is abandoned on restart; H-126 A rerun after
a crash reports "did not run" for bytes that already left; H-127 The checkpoint kept in a task memo vanishes at the
task's outcome; H-128 A doc value returned out of a commit is a dead overlay; H-129 Power loss loses the newest
commits after a broadcast; H-130 The start commit fails (disk full or any commit error); H-131 A commit fails after a
successful broadcast; H-132 Concurrent payments each fit the balance, together they do not; H-133 The balance drops
between approval and signing; H-134 Not enough of the token; H-135 USDC but no ETH for gas; H-136 The fee budget
forgets the L1 and operator fees; H-137 The agent confuses units; H-138 A malformed amount; H-139 Amounts and wei lose
precision in JSON; H-140 The owner says yes in words instead of tapping the card; H-141 The same card approved on two
devices; H-142 An approval expires; H-143 Approved, then the wallet goes offline before the start commit; H-144
Approved, then held behind a stuck transaction for hours; H-145 Fees paid exceed what the card estimated; H-146 "Send
all" of ETH, then a bump is needed; H-147 Mined with status 0; H-148 ETH to a contract needs more than 21000 gas;
H-149 An agent loop enqueues hundreds of Always payments; H-150 EIP-7702 delegation; H-151 Approvals and permits;
H-152 Raw and personal signatures; H-153 A generic signing function creeps in; H-154 No signature reaches money not in
the wallet; H-155 The chain id comes from the RPC; H-156 Non-standard tokens; H-157 The wallet already has code; H-158
The token issuer freezes the wallet's own address; H-159 Agents sharing a wallet share the cap; H-160 Airdropped
tokens with instructions in their names; H-161 Hedged signatures by default; H-162 noble's `sign` hashes its input
again by default; H-163 The fiat estimate comes from a price source.

**7. Nonce and chain**: H-164 Two payers from one wallet at the same instant; H-165 A nonce taken when the draft opens
leaves a gap; H-166 The exported key was used elsewhere while banda was idle; H-167 A foreign transaction takes the
nonce of banda's in-flight one; H-168 A foreign transaction pending where banda cannot see it; H-169 A burnt nonce
whose every version the pool rejects; H-170 The RPC reports a lower count than the ledger; H-171 The ledger is raised
to a foreign nonce that a reorg then removes; H-172 Not included because the base fee rose; H-173 The bump is refused
as underpriced; H-174 The fee ceiling is reached; H-175 The original is mined after its bump was broadcast; H-176 A
reorg returns an earlier payment to Sent after the next one started; H-177 The owner's cancel loses to the original;
H-178 The balance cannot cover a bumped fee; H-179 Evicted from the pool; H-180 The RPC accepted the transaction but
never forwarded it; H-181 An L2 reorg removes an included transaction; H-182 The single sequencer halts; H-183 The RPC
rate-limits or is unreachable; H-184 A timeout on `eth_sendRawTransaction`; H-185 Error codes do not discriminate;
H-186 "nonce too low" answering our own bytes; H-187 The RPC serves another chain; H-188 The RPC invents a receipt for
a transaction never mined; H-189 The RPC hides a mined receipt (a false "failed"); H-190 The RPC inflates the base fee
or the gas estimate; H-191 A stale or false balance; H-192 The owner changes the RPC while transactions are in flight;
H-193 The laptop slept or was off for days; H-194 The wall clock jumps forward or backward; H-195 An RPC URL with a
key in it; H-196 A plain-HTTP or private-address RPC; H-197 The RPC learns the address and the owner's IP; H-198 Many
wallets poll one rate-limited RPC; H-199 The owner's cancel races the lane's automatic bump; H-200 A filler cannot be
sent either.

**8. Receipts and history**: H-201 The transaction list shows every state; H-202 Start-up reconciliation with nothing
in flight; H-203 Incoming USDC cannot be listed without a history API; H-204 ETH received from a contract leaves no
log; H-205 Address-poisoning rows in the history; H-206 An agent reads balance, address, recipients and history; H-207
The chosen RPC cannot serve the history; H-208 A balance unknown is reported as zero; H-209 An agent cannot see
payments it received; H-210 Outgoing rows that did not go through the lane; H-211 Times shown in the list; H-212 The
indexer runs twice over the same range; H-213 A reorg removes an incoming row; H-214 A long history floods a tool
result or a stream push; H-215 The RPC changes while the indexer is mid-range.

**9. x402**: H-216 An agent pays an observed 402; H-217 A forged challenge in the tool's arguments; H-218 Another
chat's observation, or one reused; H-219 The tool is called before the observation reached the store; H-220 A held
write's 402, and the paid retry of a held write; H-221 Another agent's process makes observations as this chat; H-222
Cross-resource substitution; H-223 payTo, asset, network or price differ from what the rule trusted; H-224 Wrong
asset, network, scheme or token domain; H-225 A long-lived authorization; H-226 The signed authorization sits in the
box; H-227 The same observation paid twice; H-228 The paid retry fails after settlement, and the agent asks to pay
again; H-229 A 402 after redirects; H-230 Price steered through the query; H-231 An unauthenticated origin; H-232
Parser confusion between x402 v1 and v2; H-233 A 402 seen by the agent's browser; H-234 Killed after the authorization
was committed, before the box got it; H-235 Power loss after an authorization reached the box; H-236 The facilitator
answers `settlement_pending`; H-237 An authorization expires unused; H-238 Two parallel requests to one Always
endpoint; H-239 An authorization refused for balance settles later, after a top-up; H-240 Authorizations and ERC-20
sends draw on one USDC balance without sharing a nonce; H-241 An Ask answered long after the challenge; H-242 The
owner switches the wallet off while authorizations are outstanding; H-243 No proxy: host mode or computer off; H-244
The x402 SDK signs on the payer's path; H-245 The facilitator or the server lies about settlement; H-246 The payee
runs its handler once per duplicate copy; H-247 The observation is lost; H-248 The proxy restarts while the box
retries with the header; H-249 A settled x402 transfer is reorged out; H-250 USDC's EIP-712 domain changes with a
token upgrade; H-251 cancelAuthorization races the settlement.

**10. Owner send and receive**: H-252 The owner sends from a wallet; H-253 The owner's Send submitted twice; H-254 The
owner's Send waits behind an agent's stuck transaction; H-255 An invalid recipient typed or pasted; H-256 An amount
typed in another locale or with too many decimals; H-257 A Send rejected before reaching the pool; H-258 The owner
receives funds; H-259 The QR payload is misread by the sender's wallet; H-260 Funds sent on another EVM chain to the
same address; H-261 Receive shows a wrong address; H-262 An older phone client sends without a request id.

**11. Devices and key export**: H-263 The owner reveals, copies and confirms the key at creation; H-264 Export asked
from a paired device; H-265 The agent or a page asks for the key; H-266 Export later than creation; H-267 A local
process calls the export route with the owner's token; H-268 A reveal capability is replayed; H-269 Killed during a
reveal; H-270 A screenshot or screen share during the reveal; H-271 Clipboard history and Universal Clipboard; H-272
Browser extensions read the reveal; H-273 The owner never saved the key; H-274 The revealed key lingers in the client;
H-275 The owner confirms saved without saving; H-276 A wallet created from a paired phone, where the key cannot be
shown; H-277 A paired phone or browser device drains a wallet; H-278 A phone's Send to a new address waits for the
host; H-279 A device revoked during its approval; H-280 A paired phone answers a payment card; H-281 A screen reader
reads the key aloud; H-282 The explorer link tells the explorer which address the owner watches.

**12. Backups, forks and migration**: H-283 home:fork resumes in-flight wallet tasks or reaches the live keys; H-284 A
backup restored on the same machine, beside its original; H-285 A backup taken while a transaction was Signed or Sent;
H-286 A backup restored on a new computer; H-287 The home secret is missing or unreadable; H-288 The home's id is
copied by every backup; H-289 A lease move killed halfway; H-290 Restore key while the lane waits for the key; H-291 A
migration step killed midway while payments are non-terminal; H-292 A release changes the lane's checkpoint shape;
H-293 A release changes fee policy or gas ceilings while transactions are in flight; H-294 A release changes a chain's
definition; H-295 The first release with wallets opened by an older build; H-296 Keychain naming changes in a later
release; H-297 Lanes run before migrations finish; H-298 Signed bytes in the store; H-299 Real wallet data in the
public repo; H-300 Logs and activity.

**13. Supply chain**: H-301 A dependency is compromised; H-302 A native binary swapped; H-303 A typosquat; H-304 An
upgrade changes signing semantics; H-305 The app's own files are swapped; H-306 Dangerous root exports are reachable;
H-307 An upgrade lands minutes after its publication; H-308 Two copies of the curve library.

**14. UI states**: H-309 No wallets yet, or no keychain; H-310 A routine at night meets an Ask; H-311 The owner
answers Always in the morning; H-312 An Always payment in a quiet routine run leaves no trace; H-313 A lock-screen
notification shows payment details; H-314 Incoming funds; H-315 Wallet screens at phone width; H-316 The Docker box
versus the shipped computer; H-317 One list of offline reasons.

## What the completeness pass added

The pass crossed every effect boundary with a kill, every actor with every wallet state, and every pair of concurrent
acts on one wallet (conflicts.md, matrix). What it found missing, and where:

- H-014 (critic, security, critical): "Restore key" with a key that opens another address
- H-032 (spike, race, high): Hung keychain calls starve the daemon's thread pool
- H-033 (critic, race, critical): The signer process dies in the middle of a call
- H-034 (spike, error, medium): The daemon cannot exit or upgrade while a keychain call hangs
- H-035 (critic, race, medium): A keychain answer arrives after the deadline
- H-036 (spike, race, critical): Two first writes to one keychain account at once
- H-037 (spike, error, critical): A keychain that cannot answer looks like a missing key
- H-038 (spike, security, high): Items written through `security` trust `/usr/bin/security`
- H-047 (critic, race, medium): Owner Send from a wallet being archived
- H-048 (critic, race, high): A key reveal while removal is in progress
- H-049 (critic, race, critical): Two lanes for one wallet
- H-050 (critic, race, low): Wallet settings edited from two devices
- H-052 (spike, error, high): The connection model's existing auth shapes do not fit a wallet
- H-066 (critic, security, critical): A gateway client or an inference caller reaches the wallet tools
- H-071 (spike, security, high): The tool's wallet enum names wallets the agent was not given
- H-072 (critic, edge, medium): Wallet tools grow every chat's prompt
- H-109 (critic, race, medium): Two devices edit a recipient's label at once
- H-110 (critic, race, low): The burst pause races the owner setting Always again
- H-111 (critic, edge, low): Rules of an agent that was deleted
- H-118 (critic, race, critical): The payment is refused while the signer holds its bytes
- H-126 (spike, race, critical): A rerun after a crash reports "did not run" for bytes that already left
- H-127 (spike, error, critical): The checkpoint kept in a task memo vanishes at the task's outcome
- H-128 (spike, edge, low): A doc value returned out of a commit is a dead overlay
- H-139 (critic, edge, medium): Amounts and wei lose precision in JSON
- H-148 (critic, edge, high): ETH to a contract needs more than 21000 gas
- H-158 (critic, error, high): The token issuer freezes the wallet's own address
- H-161 (spike, edge, high): Hedged signatures by default
- H-162 (spike, edge, high): noble's `sign` hashes its input again by default
- H-163 (critic, edge, medium): The fiat estimate comes from a price source
- H-171 (critic, race, high): The ledger is raised to a foreign nonce that a reorg then removes
- H-176 (critic, race, medium): A reorg returns an earlier payment to Sent after the next one started
- H-199 (critic, race, high): The owner's cancel races the lane's automatic bump
- H-200 (critic, edge, high): A filler cannot be sent either
- H-207 (spike, edge, high): The chosen RPC cannot serve the history
- H-210 (spike, security, medium): Outgoing rows that did not go through the lane
- H-212 (critic, race, medium): The indexer runs twice over the same range
- H-213 (critic, edge, medium): A reorg removes an incoming row
- H-214 (critic, edge, medium): A long history floods a tool result or a stream push
- H-215 (critic, edge, medium): The RPC changes while the indexer is mid-range
- H-219 (spike, race, medium): The tool is called before the observation reached the store
- H-220 (spike, edge, medium): A held write's 402, and the paid retry of a held write
- H-237 (spike, edge, medium): An authorization expires unused
- H-244 (spike, security, critical): The x402 SDK signs on the payer's path
- H-245 (spike, security, high): The facilitator or the server lies about settlement
- H-246 (spike, edge, low): The payee runs its handler once per duplicate copy
- H-247 (critic, error, high): The observation is lost
- H-248 (critic, race, medium): The proxy restarts while the box retries with the header
- H-249 (critic, edge, medium): A settled x402 transfer is reorged out
- H-250 (critic, edge, high): USDC's EIP-712 domain changes with a token upgrade
- H-251 (critic, race, medium): cancelAuthorization races the settlement
- H-262 (critic, race, low): An older phone client sends without a request id
- H-268 (critic, security, high): A reveal capability is replayed
- H-269 (critic, error, low): Killed during a reveal
- H-278 (critic, edge, medium): A phone's Send to a new address waits for the host
- H-281 (critic, edge, medium): A screen reader reads the key aloud
- H-282 (critic, edge, low): The explorer link tells the explorer which address the owner watches
- H-287 (critic, error, high): The home secret is missing or unreadable
- H-288 (spike, security, critical): The home's id is copied by every backup
- H-289 (critic, race, high): A lease move killed halfway
- H-290 (critic, race, medium): Restore key while the lane waits for the key
- H-297 (critic, race, high): Lanes run before migrations finish
- H-306 (critic, security, high): Dangerous root exports are reachable
- H-307 (critic, security, medium): An upgrade lands minutes after its publication
- H-308 (critic, edge, low): Two copies of the curve library
- H-317 (critic, edge, medium): One list of offline reasons

## Source cases to entries

Every case of the three lens catalogs, and the entry that now holds it (several entries cite a case they extend).

**DUR**: DUR-001 H-074/H-112; DUR-002 H-073; DUR-003 H-252; DUR-004 H-216; DUR-005 H-113; DUR-006 H-202; DUR-010
H-114; DUR-011 H-115; DUR-012 H-116; DUR-013 H-027/H-117; DUR-014 H-117; DUR-015 H-119; DUR-016 H-119; DUR-017 H-119;
DUR-018 H-120; DUR-019 H-121; DUR-020 H-122; DUR-021 H-123; DUR-022 H-124; DUR-023 H-125; DUR-030 H-129; DUR-031
H-235; DUR-032 H-130; DUR-033 H-131; DUR-040 H-026; DUR-041 H-018; DUR-042 H-021; DUR-043 H-025; DUR-044 H-006;
DUR-045 H-028; DUR-050 H-132/H-164; DUR-051 H-164; DUR-052 H-164; DUR-053 H-166; DUR-054 H-167; DUR-055 H-168; DUR-056
H-020; DUR-057 H-169; DUR-058 H-170; DUR-059 H-040; DUR-060 H-172; DUR-061 H-173; DUR-062 H-174; DUR-063 H-175;
DUR-064 H-177; DUR-065 H-178; DUR-066 H-136; DUR-067 H-147; DUR-068 H-145; DUR-069 H-146; DUR-070 H-179; DUR-071
H-180; DUR-072 H-181; DUR-073 H-167; DUR-074 H-182; DUR-080 H-183; DUR-081 H-184; DUR-082 H-185; DUR-083 H-186;
DUR-084 H-155/H-187; DUR-085 H-188; DUR-086 H-189; DUR-087 H-190; DUR-088 H-191; DUR-089 H-192; DUR-090 H-170; DUR-095
H-113; DUR-096 H-193; DUR-097 H-055; DUR-100 H-133; DUR-101 H-083; DUR-102 H-084; DUR-103 H-083; DUR-104 H-141;
DUR-105 H-142; DUR-106 H-143; DUR-107 H-144; DUR-108 H-082; DUR-110 H-087; DUR-111 H-085; DUR-112 H-054; DUR-113
H-242; DUR-114 H-043; DUR-115 H-088; DUR-116 H-080; DUR-117 H-090; DUR-118 H-086; DUR-119 H-091; DUR-125 H-005;
DUR-126 H-005; DUR-127 H-007; DUR-128 H-044; DUR-129 H-045; DUR-130 H-043; DUR-140 H-234; DUR-141 H-228; DUR-142
H-236; DUR-143 H-238; DUR-144 H-227; DUR-145 H-241; DUR-146 H-239; DUR-147 H-240; DUR-148 H-194; DUR-149 H-223;
DUR-150 H-283; DUR-151 H-284; DUR-152 H-284; DUR-153 H-020; DUR-154 H-285; DUR-155 H-031; DUR-160 H-291; DUR-161
H-292; DUR-162 H-293; DUR-163 H-250/H-294; DUR-170 H-194; DUR-171 H-194; DUR-172 H-211; DUR-180 H-253; DUR-181 H-254;
DUR-182 H-201; DUR-183 H-205; DUR-184 H-133; DUR-185 H-149; DUR-186 H-198.

**SEC**: SEC-001 H-001; SEC-002 H-002; SEC-003 H-003; SEC-004 H-004; SEC-005 H-005; SEC-006 H-007; SEC-007 H-024;
SEC-008 H-025; SEC-009 H-015; SEC-010 H-016; SEC-011 H-017; SEC-012 H-027; SEC-013 H-019; SEC-014 H-020; SEC-015
H-021; SEC-016 H-022; SEC-017 H-023; SEC-018 H-009; SEC-019 H-010; SEC-020 H-012; SEC-021 H-013; SEC-022 H-263;
SEC-023 H-264; SEC-024 H-265; SEC-025 H-266; SEC-026 H-267; SEC-027 H-270; SEC-028 H-271; SEC-029 H-272; SEC-030
H-273; SEC-031 H-274; SEC-032 H-008; SEC-033 H-026; SEC-034 H-028; SEC-035 H-018; SEC-036 H-030; SEC-037 H-051;
SEC-038 H-277; SEC-039 H-061; SEC-040 H-016/H-065; SEC-041 H-064; SEC-042 H-053; SEC-043 H-054; SEC-044 H-279; SEC-045
H-096; SEC-046 H-078; SEC-047 H-097; SEC-048 H-098; SEC-049 H-099; SEC-050 H-100; SEC-051 H-076; SEC-052 H-060;
SEC-053 H-101; SEC-054 H-073; SEC-055 H-077; SEC-056 H-079; SEC-057 H-082; SEC-058 H-085; SEC-059 H-091; SEC-060
H-083; SEC-061 H-092; SEC-062 H-089; SEC-063 H-070; SEC-064 H-095; SEC-065 H-205; SEC-066 H-094; SEC-067 H-102;
SEC-068 H-103; SEC-069 H-104; SEC-070 H-216; SEC-071 H-217; SEC-072 H-218; SEC-073 H-222; SEC-074 H-223; SEC-075
H-224; SEC-076 H-225; SEC-077 H-226; SEC-078 H-227; SEC-079 H-228; SEC-080 H-229; SEC-081 H-230; SEC-082 H-231;
SEC-083 H-232; SEC-084 H-233; SEC-085 H-150; SEC-086 H-151; SEC-087 H-152; SEC-088 H-153; SEC-089 H-155; SEC-090
H-156; SEC-091 H-157; SEC-092 H-132/H-154; SEC-093 H-136; SEC-094 H-135; SEC-095 H-160; SEC-096 H-159; SEC-097 H-164;
SEC-098 H-188/H-189; SEC-099 H-167; SEC-100 H-195; SEC-101 H-196; SEC-102 H-190; SEC-103 H-197; SEC-104 H-183; SEC-105
H-301; SEC-106 H-302; SEC-107 H-303; SEC-108 H-304; SEC-109 H-305; SEC-110 H-011; SEC-111 H-298; SEC-112 H-299;
SEC-113 H-300; SEC-114 H-070; SEC-115 H-313; SEC-116 H-062; SEC-117 H-069; SEC-118 H-221; SEC-119 H-063; SEC-120
H-283; SEC-121 H-020/H-284/H-288; SEC-122 H-286; SEC-123 H-031; SEC-124 H-252; SEC-125 H-253; SEC-126 H-261; SEC-127
H-067; SEC-128 H-068; SEC-129 H-092.

**PRO**: PRO-001 H-001; PRO-002 H-005; PRO-003 H-028; PRO-004 H-029; PRO-005 H-007; PRO-006 H-276; PRO-007 H-263;
PRO-008 H-011; PRO-009 H-010; PRO-010 H-266/H-273; PRO-011 H-264; PRO-012 H-270/H-271; PRO-013 H-275; PRO-014 H-008;
PRO-015 H-039; PRO-016 H-309; PRO-017 H-041; PRO-018 H-258; PRO-019 H-259; PRO-020 H-260; PRO-021 H-160; PRO-022
H-252; PRO-023 H-106; PRO-024 H-107; PRO-025 H-255; PRO-026 H-102; PRO-027 H-256; PRO-028 H-146; PRO-029 H-253;
PRO-030 H-164; PRO-031 H-257; PRO-032 H-201; PRO-033 H-203; PRO-034 H-204; PRO-035 H-205; PRO-036 H-193; PRO-037
H-166; PRO-038 H-181; PRO-039 H-147; PRO-040 H-080/H-214; PRO-041 H-051; PRO-042 H-054; PRO-043 H-091; PRO-044 H-055;
PRO-045 H-056; PRO-046 H-080; PRO-047 H-078; PRO-048 H-079; PRO-049 H-081; PRO-050 H-083; PRO-051 H-089; PRO-052
H-090; PRO-053 H-093; PRO-054 H-108; PRO-055 H-206; PRO-056 H-191/H-208; PRO-057 H-209; PRO-058 H-074; PRO-059 H-075;
PRO-060 H-073; PRO-061 H-076; PRO-062 H-082; PRO-063 H-141; PRO-064 H-165; PRO-065 H-132; PRO-066 H-119; PRO-067
H-180/H-184; PRO-068 H-172; PRO-069 H-186; PRO-070 H-137; PRO-071 H-138; PRO-072 H-140; PRO-073 H-100; PRO-074 H-105;
PRO-075 H-134; PRO-076 H-135; PRO-077 H-136; PRO-078 H-133; PRO-079 H-156; PRO-080 H-040; PRO-081 H-057; PRO-082
H-057; PRO-083 H-058; PRO-084 H-216; PRO-085 H-217; PRO-086 H-218; PRO-087 H-223; PRO-088 H-223; PRO-089 H-241;
PRO-090 H-228/H-236; PRO-091 H-225/H-226; PRO-092 H-229; PRO-093 H-243; PRO-094 H-240; PRO-095 H-310; PRO-096 H-311;
PRO-097 H-142; PRO-098 H-026; PRO-099 H-042; PRO-100 H-043; PRO-101 H-046; PRO-102 H-014/H-021; PRO-103 H-016; PRO-104
H-016; PRO-105 H-017; PRO-106 H-018; PRO-107 H-028; PRO-108 H-316; PRO-109 H-031; PRO-110 H-183; PRO-111 H-190;
PRO-112 H-197; PRO-113 H-174/H-182; PRO-114 H-315; PRO-115 H-280; PRO-116 H-312; PRO-117 H-313; PRO-118 H-314; PRO-119
H-295; PRO-120 H-296; PRO-121 H-283; PRO-122 H-284; PRO-123 H-059; PRO-124 H-096; PRO-125 H-095; PRO-126 H-097;
PRO-127 H-151/H-154; PRO-128 H-098; PRO-129 H-301.
