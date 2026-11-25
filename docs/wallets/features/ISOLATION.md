# Scenario isolation contract

This is how the scenarios in this folder are run so that none of them can change another's outcome. Each scenario's
result must depend on its own steps and nothing else. It must give the same result alone, in any order, in parallel
with every other scenario, on any machine, and when run twice. The rules below apply to every step definition and
every runner that executes these `.feature` files: the ordinary suites, `test/fault/`, and the box suites.

Two documents back this one. [`STEPS.md`](STEPS.md) says what each phrase means. `check_features.py` is the gate
that proves it mechanically, using only the Python standard library:

```
cd docs/wallets && python3 -I features/check_features.py              # the gate (exit 1 on any failure)
python3 -I features/check_features.py --fix-tags                      # rewrite @t tags from the replay
python3 -I features/check_features.py --coverage                      # rows, hazards and phrases not covered
```

## 1. Outcomes come only from the transition table

- Every `Then <machine> is "<state>"` asserts the state that [`../model/transitions.json`](../model/transitions.json)
  gives for the steps before it. The checker replays each scenario through the table and fails a scenario if any of
  these hold:
  - a `Then` disagrees with the table;
  - an event has no row in the current state;
  - the atoms set do not fix the row: each completion of the unset atoms must pick the same row, otherwise it reports
    "undetermined; set X".
- A step definition never computes an outcome of its own. The runner loads `transitions.json`. After each `When`, it
  reads the state from the store, through the same read the UI uses, and compares it with the table's state. A
  scenario passes only when the implementation and the table agree.
- The table is checked by `../model/check_transitions.py`: guards are mutually exclusive and exhaustive, every row's
  `tla` names an action of its module, and the payment machine's edges equal `PaymentLane`'s `Edges` (the rewinds
  against `RestoredSt`). So "the table's outcome" is unique and total. TLC checks the TLA+ modules, not the table: a
  row's guard and target are not proven equal to its action's effect valuation by valuation (that would need trace
  validation), only its edge and its action's name. If an implementation disagrees, the implementation is the bug,
  or the table and the model change first, then the scenarios.
- `@t:<machine>:<from>:<event>:<guard>` tags are derived from the replay (`--fix-tags`) and never written by hand.
  When a guard or a row changes, every scenario that exercised it fails until it is re-tagged. The diff then shows
  exactly which scenarios the change reaches.
- `Then` invariant phrases name one TLA+ property each. A scenario runner checks the property's observable form on
  the store and the chain after the scenario, for example:
  - "the payment is on chain at most once": at most one transaction with the payment's derived nonce is on chain;
  - "the key is never in the store or the box": a byte scan of the store, the blobs, the logs and the box's volumes.

## 2. One home per scenario

- Each scenario gets a fresh home from `tempHome()` (`test/helpers.ts`: `mkdtemp` under the run's own temp folder,
  prefix `banda-test-`). That run's daemon sets `BANDA_HOME` to it, and the home is removed after the scenario.
  Nothing is shared between scenarios: no store, blobs, config or token.
- `~/.banda` is never opened, read or written (AGENTS.md "Never touch a live banda"). The runner refuses to start when
  `BANDA_HOME` resolves to it.
- A `Background:` is not used. Each scenario sets every state and atom it relies on, so it can run alone.
- Scenario names are unique across the folder; the checker enforces this. Fault-sweep results and race traces are
  keyed by name.

## 3. One chain per scenario

- anvil 1.9.0 is pinned in `mise.toml` (`foundry = "1.9.0"`, `../stack.md` section 3) and `mise install` provisions
  it. The scenarios that start a chain (every one that drives the `payment`, `nonce` or `x402` machine, or a wallet
  atom read at a block) are an ordinary suite, not a box suite; when `anvil --version` is absent or not 1.9.0 the
  runner skips them with "anvil 1.9.0 not found (mise install)", as Docker suites skip, and CI's ordinary job runs
  `mise install` before them, so CI never skips them.
- Each scenario starts its own `anvil` (Foundry 1.9.0, the version `../stack.md` pins), with `--port 0 --host
  127.0.0.1`, and reads the port from its `Listening on 127.0.0.1:<port>` line, so the system assigns it at bind with no
  race and no retry. The port is never fixed and never a slot.
- The mnemonic is fixed at anvil's public development mnemonic,
  `test test test test test test test test test test test junk`. These keys are public and hold no real funds, and
  they are never used outside anvil.
- The chain id is fixed:
  - 31337 for transfer scenarios, on the network `anvil`, which holds no token: they move ETH;
  - 84532 for x402 scenarios and any that move USDC, on the network `anvil-usdc`. They run a plain anvil (no fork, no
    network) loaded with `--load-state` from a committed state file. The file holds USDC's FiatTokenV2_2 code and
    storage at the pinned address. It is built once from a fork with the prestate tracer, as
    `../spikes/gaps/x402-state/make-state.mjs` does. It holds the code of every account the token's paths touch (the
    proxy, the implementation and the linked SignatureChecker library) and every non-zero slot they read. A fork's
    `anvil_dumpState` is not the fixture: it drops the implementation and the library (`../spikes/gaps/README.md` §B).
    The fixture was built from `https://sepolia.base.org`; tests never fork it.
  - A loaded state keeps the dumped block's timestamp, so chain time starts as old as the fixture. Before the first
    step the runner sets the next block's timestamp to the wall clock (`evm_setNextBlockTimestamp`, then
    `evm_mine`; section 5 says why).
- Plain anvil only: never `-n base` and never a fork for a scenario that asserts on balances. `-n base` and a Base
  fork charge a fee that no receipt field shows, and `--optimism` charges no L1 fee at all
  (`../spikes/gaps/README.md` §E). The L1 term of the reserve is tested against a GasPriceOracle the runner sets.
  anvil's development accounts are fresh EOAs only on a plain anvil: on Base they carry EIP-7702 delegations and
  nonces.
- Blocks are mined on demand, using `--no-mining` with `evm_mine`, so inclusion happens when a step says it does.
  `--slots-in-an-epoch` sets how far `safe` and `finalized` trail `latest`. anvil 1.9.0 reports `safe` = latest − N
  and `finalized` = latest − 2N for N slots per epoch (default 32), so the step mines 2N blocks past a block to make
  it final, or calls `anvil_reorg` to undo a block. "That block is finalized" is a fact the step sets, never a wait.
  anvil does not protect finality (`../spikes/gaps/README.md` §A), so the runner keeps that guarantee itself:
  - it accepts a reorg of any depth, including one that rewrites a finalized block, while the tags still report
    latest − N and latest − 2N. A step never reorgs deeper than 2N.
  - a reorged transaction does not return to the pool; it lands again only from a rebroadcast of its stored bytes.
  - a transaction listed for re-inclusion is dropped silently when an earlier nonce of its sender is not included
    first. A step that re-includes transactions lists every earlier nonce, in nonce order.
- Nothing reaches a shared or public RPC. Each wallet's network is configured to that anvil. A guard in the test
  harness fails the scenario when any socket opens to anything other than loopback. The model provider is pi-ai's
  faux provider, so there is no network, no key and no live service. No mainnet, no real funds, and testnets only
  inside CI box suites that say so.
- The anvil process is killed when the scenario ends, including when it fails, from a `finally`. A crash scenario
  restarts the daemon, never the chain.
- op-geth or base-reth run only in the CI box suites. They cover the pool rules anvil does not model
  (`../spikes/gaps/README.md` §D): anvil accepts a +1% bump where geth and reth need +10% on both fees, and anvil
  refuses a fee cap below the base fee where they accept it and let it wait. They run in Docker containers named
  `banda-test-<run id>-<random hex>`, removed in a `finally`, on ports assigned the same way.

## 4. Keys and the keychain

- Untagged scenarios use an in-memory keystore, injected into the signer child through the keystore interface. Each
  scenario gets a fresh one. The release build's dependency check refuses that keystore (H-030).
- Scenarios tagged `@keychain` use the real OS keychain through `@napi-rs/keyring` 2.1.2, under these rules:
  - **Naming.** Every entry's service name is `banda-test-` followed by the run id and a random 16-hex suffix,
    unique per scenario. The account is `<home-id>/wallet/<address>`, using the scenario's own home id.
  - **Cleanup.** The scenario deletes every entry it wrote in a `finally`, then checks that none is left.
  - **Isolation.** A scenario never lists, reads or deletes an entry it did not write in that run. A keychain
    item the owner has is never touched (H-031).
  - **Linux.** The store is pinned to `secret-service`. The scenario runs inside the keychain spike's image
    (dbus, gnome-keyring), in a container named `banda-test-<run id>-<random hex>` that is removed afterwards.
  - **macOS.** `@keychain` scenarios run only on an ephemeral CI runner. Locally they are skipped unless
    `BANDA_TEST_KEYCHAIN=1` is set, and the owner's login keychain is never the target of a test.
  - **One call at a time.** Keychain calls in a home run one at a time (C20). That is what makes 8 concurrent
    writes safe, where the spike lost 7 keys, so a scenario never asserts on two simultaneous keychain calls.
- Key material comes from a seeded source. Wallet keys in create scenarios come from the injected random source,
  seeded per scenario. One test exercises the real `crypto.getRandomValues` path. Anvil's dev accounts fund wallets
  and act as the foreign sender (the exported key used elsewhere).

## 5. Time and randomness

- Time is injected. The daemon's timers read a test clock that the scenario moves explicitly, never the wall clock:
  - the 24 h answer deadline and the 1 h approval freshness (C10);
  - the 60 s reveal capability;
  - the 1 h burst window;
  - the signer child's deadline;
  - the follower's polling.

  "The payment's deadline passes" is a clock move, not a sleep. Wall-clock jumps (H-194) are clock moves too.
- Chain time is moved on anvil with `evm_setNextBlockTimestamp` and `evm_mine`. C19 anchors the window to both
  chain time and banda's clock (the test clock here), and the 120 s skew pause compares the two; x402 expiry is a
  block timestamp the step sets.
- The reference facilitator (`@x402/evm` 2.32.0) checks the window against its own wall clock (`Date.now()`), not
  the test clock: it refuses `validBefore < now + 6` and `validAfter > now` (`../spikes/gaps/README.md` §F). A
  scenario that runs it keeps the test clock at the real wall clock until the header is handed. It moves block time
  past `validBefore` only after the header is handed.
- Seeds are fixed. Property runs take their counts from `test/pbt.ts` (`pbtRuns`, `pbtFaultRuns`, scaled by
  `BANDA_PBT_RUNS` and `BANDA_PBT_FAULT_RUNS`). Every fast-check run prints its seed and path on failure, and a seed
  can be passed back to replay it. Generated scenarios (`test/fault/`) draw from the same seeded sources: interleavings,
  kill points, amounts.
- No step sleeps. Asynchronous state is awaited with `until` (`test/helpers.ts`), on a state the store or the chain
  reports. Async UI is never read just once.

## 6. Machine-wide resources

- Each feature file's runner calls `hold(FILES)` (`test/slots.ts`) before its clock starts, and releases the slot when
  it ends. A scenario that drives the web UI also holds `BROWSERS`, through `withPage` or `openChrome`. A port a
  dependency fixes gets a slot of its own; anvil's port does not, because it is assigned by the system.
- Vite runs through `webServer` (`test/helpers.ts`), Chrome through `withPage`/`openChrome` (`test/smoke/chrome.ts`).
  Each is owned by its test.
- A box outlives its daemon. Box suites end with the sweep that removes the boxes of homes that are gone.

## 7. Crashes and fault points

- A crash scenario (`@crash`) names one boundary per `Examples:` block. The runner arms that fault point, runs to it,
  kills the daemon with SIGKILL (or throws, in the thrown-fault sweep), restarts it on the same home and the same
  anvil, and continues with the next step. The fault points (spikes/banda-integration/README.md) are:
  - `wallet:reserved` (admission), `wallet:signed` (in the signer child, nothing committed), `wallet:stored` (the
    fused start commit, C4), `wallet:broadcast`, `wallet:receipt`, `wallet:replace` (a bump's or a cancel's version
    commit), `wallet:finality`, `wallet:ledger`;
  - `challenge:observed`, `x402:signed`, `x402:sent`;
  - `rule:set`, `keychain:read`, `home:restore`.

  Each new effect a slice adds is a new point, and it gets a block.
- A power-loss scenario (`power_loss`) cuts at the same points but restarts from what was synced: the store runs on a
  filesystem that drops writes not yet fsynced (LazyFS, or a SQLite VFS that discards un-fsynced pages), so a commit
  C21 requires to be synced survives and any other may be lost. A SIGKILL never loses a WAL commit, so the kill sweep
  alone cannot catch a sync left out; this runner can, and C21's points (`wallet:stored`, `wallet:replace`,
  `x402:signed`, an acknowledged refusal) each get a power-loss block. Which of the two layers ships is spike I12's
  to settle; until it does, C21 rests on the TLA+ bug configurations (`_bug_C21`, `_bug_C21bump`, `_bug_C21acked`).
- Under `test/fault/` the same scenarios run as properties over generated interleavings, plus a sweep of one kill at
  every point. They are checked by the invariants the scenarios name, which are the TLA+ properties of section 1.

## 8. Races are serialized deterministically

A race scenario (`@race`) fixes one interleaving. The opposite order is a separate scenario with its own name.

- Every actor runs until its next fault point and parks there:
  - an owner act, from the API;
  - the lane's start commit;
  - the follower's receipt read;
  - the proxy's intake;
  - a system act such as the burst pause.
- The runner releases parked actors one at a time, in the order the steps list them, and waits with `until` for each
  release's commit before releasing the next.
- pi-durable's single commit line (C1) is the only arbiter. There are no timers, no `Promise.race` and no load-based
  timing. "Concurrent" means two actors parked at the same time, never two actors sharing a millisecond.
- An act from a second device is an act that carries the version it saw (C8). The scenario says
  "the owner's recipient act carries a stale version" for the device that commits second.

## 9. What keeps scenarios from conflicting

| Shared thing | How it is kept apart |
|---|---|
| Store, blobs, config, token | own temp home (section 2) |
| Chain state, nonces, balances | own anvil, fixed mnemonic and chain id (section 3) |
| Keychain | in-memory keystore; `@keychain` entries named `banda-test-<run>-<random>`, deleted after (section 4) |
| Time, randomness | injected clock, seeded sources (section 5) |
| Ports, CPU, browsers | system-assigned ports; `FILES` and `BROWSERS` slots (section 6) |
| Containers | unique names, removed in `finally` (sections 3, 4) |
| Order of acts | step order, enforced by parking at fault points (section 8) |
| Outcomes | the transition table only, gated by `check_features.py` (section 1) |
| Names and tags | unique scenario names; `@t` tags derived, never written by hand (section 1) |

A runner proves that scenarios do not interfere. On every CI run it shuffles scenario order with a printed seed, runs a
seeded subset twice in one process, and fails if any result differs.

## 10. The public repo

Scenarios, fixtures and recorded traces use only invented data: anvil's public dev accounts, generated wallet keys
seeded per scenario, and invented names and amounts. Nothing read from an owner's home or a `home:fork` goes into a
scenario, a fixture, a commit or a comment (AGENTS.md "Changes").

## 11. Before the runner: which test realises each scenario

No runner executes these files yet: until one does, a scenario of a slice that shipped is realised by a named test
that drives the same steps through the code that ships and asserts the same outcome, and `check_features.py` alone
holds the scenarios to the table. Slice 1 ("a wallet that reads"):

| Scenario | Test |
|---|---|
| A wallet is created, its key written to the keychain and read back | `test/wallet-lifecycle.test.ts` "makes a ready wallet, not backed up, with its item read back and an account on for no agent" |
| The keychain does not answer during creation, and the wallet waits in creating | `test/wallet-lifecycle.test.ts` "stays creating while the keychain cannot write…"; `test/wallets-routes.test.ts` "settles a creation the keychain left waiting once it answers again, with no restart" and "…settled by the next start, after the home's format" |
| An item already under the wallet's account drops the record and overwrites nothing | `test/wallet-lifecycle.test.ts` "drops the record when an item is already there, and never overwrites it (E2, H-024)" |
| A read-back that does not return the wallet's key drops the record | `test/wallet-lifecycle.test.ts` "drops the record when the read-back is not the key…" |
| The owner archives a saved wallet…; Archive works from every ready state; An archive sent from a screen that is out of date changes nothing | `test/wallet-lifecycle.test.ts` "archives on the version the owner saw, refuses a stale one, and comes back backed up or not" |
| Unarchiving a wallet whose key was never confirmed saved keeps it marked Not backed up; An unarchive from an out-of-date screen changes nothing | the same, and "brings an archived wallet back backed up when its key was saved" |
| An empty wallet with nothing in flight is removed and its keychain item deleted; A removable wallet starts its removal from any state that allows it | `test/wallet-lifecycle.test.ts` "removes the item, then the wallet and its account", "removes an archived wallet straight from the archive" |
| Removal is refused while the wallet holds funds or work, or its shown key was never saved | `test/wallet-lifecycle.test.ts` "refuses while it holds funds…", "refuses an address that left banda while its key was never saved" |
| Funds that arrive while removing cancel the removal and archive the wallet | `test/wallet-lifecycle.test.ts` "rolls back to archived when funds arrive between the check and the delete" |
| The keychain item holds another key at the delete, and the removal ends with that key kept | `test/wallet-lifecycle.test.ts` "never deletes an item that holds another key…", "an item swapped for another key between the proof and the delete is kept…" |
| A removal stopped after its delete ends once the keychain answers, even with funds at the address | `test/wallet-lifecycle.test.ts` "a removal stopped after its delete ends at recovery even once funds reached the address (H-044)" |
| The keychain does not answer at the delete, and removing holds until it does | `test/wallet-lifecycle.test.ts` "stays removing while the keychain cannot delete, and the next try finishes it" |
| An agent reads its wallet's address only after the owner saved the key or skipped the step | `test/wallet-tools.test.ts` "an agent reads its address only after the key was saved or the step skipped" |
| The keychain locks, the wallet shows one offline reason, and comes back online after the check | `test/wallet-lifecycle.test.ts` "says the key is missing, another key, or the keychain locked…", "says a home-wide reason for every wallet at once…"; `test/wallets.browser.test.ts` |
| A keychain key that does not derive the address takes the wallet offline as wrong key | `test/wallet-lifecycle.test.ts` "keeps the signer's code beside the state, the most specific reason (H-317)" |
| Another home holds the lease, and this one stays offline | `test/wallet-lifecycle.test.ts` "is other_home for a copy of the home…"; `test/wallet-home-id.test.ts` "backups, restores and forks (C16)" |
| Host mode takes the wallet offline | `test/wallet-lifecycle.test.ts` "is online with the key and the lease, offline in host mode"; `test/wallet-tools.test.ts` "a wallet is offline for agents" |
| The owner moves the lease to this home, and it signs again; The lease moves to another home, and this one stops signing | `test/wallet-home-id.test.ts` "is moved to a home whose binding is not the secret's…"; `test/desktop-wallets.test.ts` |
| The signer signs only after it proved the key in this home | `test/wallet-signer.test.ts` "proving and signing" |
| A check that proves the key and the lease, in a box, brings the wallet online | `test/wallet-lifecycle.test.ts` "is online with the key and the lease, offline in host mode" |
| The keychain locks, or the item disappears, while the wallet is offline for another reason, and it shows that | `test/wallet-lifecycle.test.ts` "keeps the signer's code beside the state, the most specific reason (H-317)" |
| The keychain item disappears and the owner restores the exported key; The keychain locks while the key is missing, and the wallet stays key missing until a restore | `test/wallet-lifecycle.test.ts` "tells the lane in a commit of its own when a missing key is back… (C9, H-290)", "leaves key_missing only by a restore… (C9, H-290)"; `test/desktop-wallets.test.ts` "takes a Restore only of a key in its shape…" |
| Restore key with a key that opens another address leaves the wallet offline | `test/desktop-wallets.test.ts` "restores through the channel's act: a key that opens another address leaves it missing, its own brings it back" |
| Funds arrive at an archived wallet, and it cannot be removed while they are there | `test/wallet-lifecycle.test.ts` "refuses while it holds funds…", "rolls back to archived when funds arrive between the check and the delete" |
| The client that created the wallet reveals its key once at creation, with no OS re-authentication; The owner reveals the key on the host, pastes it back, and Receive opens | `test/wallets-routes.test.ts` "makes a wallet, reveals its key once with the creation's secret, and keeps it out of every file", "answers the creation's reveal on whichever connection its client sends it, once"; `test/wallet-lifecycle.test.ts` "skips saving, confirms a key that derives the address, and refuses one that does not" |
| A later reveal on the host goes through the desktop's signer | `test/desktop-wallets.test.ts` "reveals a key only once the owner re-authenticated, at this home's lease, and tells the daemon after", "reveals, restores and moves later behind the OS's re-authentication alone, and fails closed without it (OD-2)", "shows the key in a bundled page…"; `test/wallets-routes.test.ts` "lists the desktop's word that the owner saw a ready wallet's key…" |
| Every place that shows the key says it opens in other wallets as a private key (Import account → Private key), with no seed phrase (H-008) | the web save step in `web/src/chat/Wallets.tsx`; `test/desktop-wallets.test.ts` "shows the key in a bundled page…" (the desktop's reveal window); `test/cli-wallet.test.ts` "sends the same request again until the creation is finished…" (`wallet create`) |
| A reveal asked from a paired device or with the token alone shows nothing; A wallet created from a paired phone stays Not backed up until the host shows its key | `test/wallets-routes.test.ts` "refuses a paired device a reveal, the save step, removal…", "refuses a reveal without the creation's secret, with another request, expired, or once the wallet is archived" |
| A replayed or expired reveal capability shows nothing | `test/wallets-routes.test.ts` "grants a repeat of the creation no reveal…", "says the reveal is gone when it expired while the signer proved the key…", "shows a key to one of two reveals that race on the creation's connection" |
| No reveal when the keychain cannot answer or holds another key | `test/wallets-routes.test.ts` "answers missing for a key gone from the keychain…", "answers wrong_key for an item holding another key…", "answers locked for a keychain that refuses, and timeout for one that does not answer", "answers other_home for a lease another home holds…" |
| A pasted key that does not open the wallet leaves it Not backed up; The owner skips saving the key, and Receive opens with the wallet marked Not backed up; Receive asked while the save step is open shows the save step instead | `test/wallet-lifecycle.test.ts` "skips saving, confirms a key that derives the address, and refuses one that does not"; `test/wallets-routes.test.ts` "opens Receive after the save step…"; `test/wallets.browser.test.ts` |
| A page that steers the agent to ask for the key gets nothing | `test/wallet-tools.test.ts` "answer no key, however an agent asks for one (H-265)" |
| A reveal leaves no key in logs, activity or the store | `test/wallets-routes.test.ts` "makes a wallet, reveals its key once with the creation's secret, and keeps it out of every file" |
| The owner opens Receive on a backed-up wallet; The address has code, so Receive warns instead of showing it, and only the host acknowledges it; An acknowledgement on a wallet whose key is not saved yet changes nothing | `test/wallets-routes.test.ts` "opens Receive after the save step…", "answers code for an address that runs code, and discloses nothing", "acknowledges the code at an address on this computer alone, kept by its hash, and Receive keeps its warning", "has the address marked disclosed in the database itself before Receive shows it…" |

The scenarios of Send, payments, recipients, x402 and the Linux keyring belong to later slices and have no test yet;
Restore key on macOS (UC-19 A2) is slice 1's and is tested above.
