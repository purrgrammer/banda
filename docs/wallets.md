# Wallets (RFC)

Status: **proposal**. Nothing here is a design rule yet: each mechanism needs its spike (principle 6) before a
sentence of it moves into DESIGN.md. This file explores where an agent's crypto wallet fits in banda's architecture
as it stands, what it changes, and what already exists. The analysis behind it is in [`wallets/`](wallets/): the use
cases, the hazards, the rules that decide every race ([`wallets/conflicts.md`](wallets/conflicts.md), C-ids), the
library choices, the spikes, the models and the scenarios. Where this file and that analysis disagree, the analysis
was checked and this file is wrong.

## Requirements (the owner's)

1. EVM, non-custodial: private keys live in the OS keychain on the owner's machine.
2. Agents operate wallets: what the owner puts in a wallet an agent may use, the agent can spend. The balance is the
   only cap.
3. Approval is per recipient, an address or an x402 endpoint, with three rules: Always, Ask, Deny. The first payment
   to an unknown recipient asks; the owner's answer sets the rule; the agent follows it after. No per-payment amount
   limit.
4. Recipients can be renamed.
5. At a wallet's creation its private key can be exported, so the owner can save it.
6. The app holds several EVM accounts; the owner picks which wallet each agent may use.
7. Settings has a Wallets section; each wallet has Send, Receive and a transaction list, as an ordinary wallet app.

## The model

**The owner keeps EVM wallets in banda, funds them, and switches each on for the agents it should serve. Who a
wallet may pay is decided one recipient at a time.**

- **Non-custodial.** The key is made on the owner's machine and kept in the OS keychain (macOS Keychain, Linux
  Secret Service). No vendor holds it, banda's store never holds it, the box never sees it, and the daemon process
  never holds it either: a short-lived signer child reads it and signs (C20). What the keychain protects against is
  stated plainly in "Keys and the keychain" below: it is not a wall against other code the owner runs.
- **The funding is the bound.** What the owner puts in the wallet is the most the agent can ever spend. Topping up
  gives more; withdrawing or switching the wallet off takes it back.
- **Each recipient has a rule: Always, Ask or Deny.** A recipient is an address or an x402 endpoint. The first
  payment to one the owner has not seen asks; the owner answers and sets the rule in the same tap; from then on the
  agent follows it without asking again. The owner can rename a recipient ("Ana", "Weather API") and change its rule
  at any time.

So an agent paying the same API every night in a routine asks once, the first night; a transfer to a new address
always reaches the owner first; and a recipient the owner refused is refused without bothering them again.

## Words

One word per thing (principle 7). The wallet adds these, and uses banda's own words for everything else.

| Word | Means | Not |
|---|---|---|
| **wallet** | An account of the wallet connection: one key, one address, one network (OD-9) | |
| **payment** | One spend effect from a wallet: an agent's transfer, an owner's Send, or an x402 authorization | "intent", "transaction" (a transaction is one signed version on chain) |
| **lane** | The wallet's ordered line of payments that will take a nonce, one in flight at a time (C2, C5) | "queue", which is a chat's inputs |
| **version** | One signed transaction at a payment's nonce: the first, each fee bump, the owner's cancel | |
| **ledger** | The wallet's nonce count in the store, never lowered (C5) | |
| **reservation** | What a payment not yet final holds back from the available balance (C11) | |
| **observation** | A 402 challenge the proxy recorded over verified TLS for a chat (C18) | |
| **recipient** | Who a payment goes to, by its identity (below), with the owner's label | "payee", "contact" |
| **rule** | The umbrella for a recipient's Always, Ask or Deny | |
| **permission** | An Always: banda's permission with scope `always`, per (wallet, agent, identity) | |
| **deny** | A Deny: the rule stored per (wallet, identity) that refuses every payment to it, for every agent of the wallet | "refusal", which is banda's word for a request refused, as everywhere else |
| **lease** | Which home may sign with the keychain's keys (C16) | |

The payment states are C12's. The model's `Queued` is shown to the owner as **"In line"**, so the screen never says
"queued" for what is not a chat's queue; the stored state keeps its name.

## What this changes in DESIGN.md

Today `money` is a floor class (src/core/floor.ts), and DESIGN.md "Trust", law 2, says no permission ever covers
the floor: every payment asks, every time. An agent wallet is a deliberate exception, and it has to be written as one:

> **An agent's wallet is money the owner already gave it.** A payment from it is an ordinary write, not a floor
> one: the owner's rule for its recipient admits it (Always), asks (Ask) or refuses it (Deny). The owner's loss is
> bounded by what they put in the wallet, a structural boundary (principle 4). Moving the owner's own money stays
> on the floor.

Most of the rest is already there:

- **"Always" is a permission.** A permission already binds one tool, one agent, one account and the values of the
  arguments the tool names (src/core/permissions.ts `covering`, src/core/ask.ts `draftOf`). `covering` checks only
  the keys present in a permission's `match`, so a missing key is a wildcard. A wallet permission therefore holds
  **exactly** the identity keys of its kind, every one non-empty and canonical: `{chain, to}` for a transfer;
  `{endpoint, payTo, asset, network}` for x402. A partial match is refused in the commit that would store it, and
  `covering` refuses one for wallet tools (C9). It never binds the amount.
- **"Ask" is the draft.** An effect with no permission covering it already becomes a draft the owner approves.
- **"Deny" is new.** banda stores no rule that refuses today: an owner's Off is per tool, not per argument. A Deny is a
  rule stored on the recipient, checked in the same commit as the permission and before a draft would open, and
  the tool answers in words ("the owner doesn't pay 0x9f…"), with no ask. It holds for every agent of the wallet
  (OD-1).
- **"Recipient" is the word**, and it is already wanted: docs/connections.md's open item "Approved recipients" (no
  list of recipients the owner approved yet, for the `private` floor). The wallet's recipients are the first
  instance of that list, not a second one: a recipient is generic in its kind (address, x402 endpoint; later an
  email or a channel) and its scope (the wallet; later a connection's account), with a label and a rule. What was
  paid to it and when is computed from the payments at read time, never stored beside them.

Law 4 (foreign content is data) still holds: a page that steers the agent can make it pay recipients the owner set
to Always, within the balance, and can make it ask to pay a new one, which the owner sees. It cannot pay anyone new
unasked.

## Recipients

A recipient is what a payment goes to, identified by what the daemon can verify, never by what the agent claims:

| Kind | Identity (what a rule binds) | Shown as |
|---|---|---|
| Address | network + EIP-55 address | "Ana · 0x12ab…9f04 on Base" |
| x402 endpoint | the resource's origin and path as observed (see "x402"), without its query, + `payTo`, asset and network | "Weather API · api.weather.dev/v1/forecast" |
| Contract call (later) | every address argument that receives value, decoded by a shipped per-function ABI rule; a call whose beneficiary cannot be read structurally is refused (C18) | "Uniswap router · swap to 0x12ab…" |

A contract and a function are not a recipient: a router's swap, a bridge or a token's own `transfer` called through
`wallet__call` pays whoever its arguments name, so a rule on (contract, function) would cover every beneficiary.

- **Who a rule belongs to (OD-1).** A recipient, its label and its Deny belong to the wallet, so they hold for every
  agent the wallet serves. An Always belongs to (wallet, agent): a wallet shared by two agents has one recipient list,
  and each agent's own Always on it.
- **A name is the owner's label, never the identity.** Renaming changes what every card says, never what a rule
  binds: a rule on 0x12ab… stays on 0x12ab… whatever it is called. The agent sees the names in `wallet__recipients`,
  so it can say "paid Ana", but its calls name addresses and endpoints, never labels; a label never resolves to an
  address, so a renamed or look-alike name cannot redirect a payment.
- **Unknown recipients ask (OD-13).** The wallet's default for recipients nobody has set is Ask, which is
  requirement 3. A default of Deny ("this agent only pays the recipients I set up") is the owner's opt-in per wallet:
  under it an unknown recipient is refused in words with no card, and turning it on refuses the open asks of unknown
  recipients in the same commit. Never Always.
- **Where a rule is set.** On the first payment's card, and in the wallet's Recipients list: each recipient with its
  name, its rule (and which agents have Always), what was paid to it and when, rename, change the rule, forget it.

### The first payment's card

The daemon draws it, as every draft. It shows the amount and token (and its value in the owner's currency, as of
then, shown as such), the recipient as identified above, the wallet and its balance after, and why the agent says it
is paying. Its buttons:

- **Pay** (this once; the rule stays Ask),
- **Always pay {name}** (pays, and sets Always for this agent),
- **Don't pay** (this once), and **Never pay {name}** (sets Deny for the wallet),

with a field to name the recipient before answering. Nothing in the payment is editable: amount, recipient and
token are an order for a machine, which runs as stored or not at all (DESIGN.md "Messages", drafts). A paired
device's Pay or Always pay on a recipient new to the host waits for the desktop app (OD-3, UC-26).

### Always binds the recipient, never the amount

A rule has three states and no number. Always pays its recipient whatever it asks, up to what is in the wallet: an
endpoint set to Always could take the whole balance in one payment, and a page could steer the agent into paying
it. That is the model as chosen: the balance is the cap, and the owner sizes it by what they put in. The Always
button's words say so ("Always pay Weather API, up to what's in the wallet"), so the owner grants it knowing what
it covers, as DESIGN.md "Trust" asks of every permission. Nothing counts or paces Always payments, and there is no
burst pause, not even as an opt-in (OD-12): identical open asks are deduplicated, never counted.

## Architecture

```
 owner ──funds──▶  0xA9…  (Base)                              box (agent code)
                    ▲                                          │ wallet__send(to, amount)
                    │ stored bytes                             ▼
        ┌───────────┴───────────────── daemon ─────────────────────────────────────┐
        │ admission (C3): wallet · access · args · identity · can sign · rule ·     │
        │                 balance after reservations · dedup                        │
        │   Deny → refuse │ Ask → draft, wait │ Always / approved → the lane        │
        │ lane (C2): signer child signs in its memory → ONE start commit:           │
        │   re-check, nonce by compare-and-set, append the version, sync (C4, C21)  │
        │   → broadcast the stored bytes → follow to finalized (C12)                │
        │                                                                           │
        │  signer child (C20)        pi-durable                        RPC (named)  │
        │  OS keychain (key)    (rules, payments, versions, ledger)                 │
        └───────────────────────────────────────────────────────────────────────────┘
```

- **A wallet is an account of a connection banda ships.** `shipped/connections/wallet.json` (one definition, one
  schema). It is not a REST adapter: `RestApi.read`/`write` get no transaction and no effect API, so they cannot
  reserve a nonce or store signed bytes before the effect. The install loop (src/server/capabilities.ts) builds the
  wallet's tools as `EffectTool`s through `options.effect`, as egress's `proposeSendTool` already does outside REST,
  and the wallet's `allowed` hook composes `allowedAs`, which is the enforcement here, not a courtesy (the
  banda-integration spike). An account is one wallet, its key its address. No new primitive.
- **A `wallet` auth kind.** Its `Credentials` variant names where the key is and what the key must prove (the
  keychain account, the address and the network; never a secret, H-052). It is bound to no URL (the wallet
  definition names none; the RPC is the network's), so changing the RPC never takes a wallet offline; `fits`,
  `credentialsOf`, `secrets` and `withCredentials` learn it, and a `MIGRATIONS` step makes an older build refuse such
  a home plainly instead of crashing on it.
- **Several wallets per home, switched on per agent.** Wallets are made in Settings → Wallets (or from an agent's
  settings), each an account of the wallet connection; the owner switches each on for the agents it should serve,
  through the connection's existing per-agent account choice. Agents sharing a wallet share its balance, so they
  share the cap.
- **The owner uses a wallet directly too**: Send, Receive (address and QR) and the transaction list in Settings →
  Wallets. The owner's own send is owner authority (DESIGN.md "Trust", law 1), not an agent's effect, but it shares
  the wallet's lane and nonce with the agents' payments.
- **The key's record is the store's Wallet doc** (address, network, state, whether the key was confirmed saved). The
  address and network its credentials name are checked against the record at every read and every signing, and a
  wallet whose two disagree is not read or signed for; the keychain item's name is derived from the home and the
  address. A name is not access: which home may sign is the lease (below).
- **The signer is a child process.** The daemon is a separate Node process (desktop/src/main.ts starts the bundled
  Node), so Electron's `safeStorage` is not available to it. Keychain access and signing run in a short-lived child
  started from `process.execPath`, one call at a time per home, killed at its deadline, offering two signing
  operations and no others, so the key never enters the daemon (C20; the keychain spike found an unanswered prompt
  ignores `AbortSignal` and four hung calls starve libuv's pool). A keychain that is locked or missing (headless
  Linux) leaves the wallet offline and the tools say why; there is no fallback to a file, which would put the key in
  backups.

### Tools the agent gets

| Tool | Kind | Notes |
|---|---|---|
| `wallet__address` | read | Its address and network |
| `wallet__balance` | read | Native and listed tokens (USDC first) |
| `wallet__history` | read | Its own payments, from the store, with their state |
| `wallet__recipients` | read | The recipients, their names and rules, so the agent knows who it may pay before trying |
| `wallet__send` | write | Native or a listed token, to an address |
| `wallet__pay_x402` | write | Pays an observed x402 challenge (below) |
| `wallet__call` | write | A contract call; later, with the identity and guards below |

Every write is admitted by C3's checks in a fixed order, the first that fails answering, and shows as a card in the
chat whether it asked or not.

### Paying exactly once

A payment reaches the lane admitted (Always, or the owner's Pay). Then:

1. **Sign in memory.** The signer child reads and proves the key (the derived address must be the record's) and signs
   at the nonce the ledger says (deterministic, RFC 6979, `extraEntropy: false`). Nothing is committed: a failure
   here costs nothing and the bytes are dropped.
2. **One start commit, the burn point (C4).** It re-checks the payment (still in line, not cancelled, not swept by a
   Deny), the wallet, the agent's access, the rule, the balance after reservations and the approval's freshness;
   takes nonce = ledger by compare-and-set; appends the signed version with its hash; and moves the payment to
   Signed. It is **synced to disk** before anything leaves (C21): the store runs `synchronous=FULL`, where
   pi-durable's `synchronous=NORMAL` keeps commits through a crash but can lose the newest one on power loss.
3. **Broadcast the stored bytes**, every version of the in-flight nonce, newest first. The same bytes again are
   harmless, so a crash resends that transaction, never a second one.
4. **Follow it** to a receipt and to `finalized` (C12): Confirmed, Failed or Cancelled only at `finalized`;
   "Included" before. Any stored version's receipt settles the payment.

Nothing waits forever and nothing is reported before the chain says so. An ask nobody answers, or a payment in line
the lane never started (a locked keychain, a lost lease), ends "Not paid" after 24 h with nothing spent; an approval
older than an hour when the lane reaches it asks again (C10). If the ledger moved between signing and the start commit,
the bytes are dropped and the payment is signed again (C4).

A transaction that does not land is replaced at the same nonce by a fee bump (both fee fields up at least 12.5%,
capped by its reserve), committed and synced before it is broadcast, as an explicit step of the lane, never a new
call by the model. The owner can cancel a Sent payment the same way: a zero-value transfer to the wallet itself at
that nonce; whichever version is mined decides, and a mined cancel is never reported paid. A nonce used by a
transaction banda did not sign (the exported key used elsewhere) moves the payment only once that transaction is
`finalized` and proven from two sources, and the owner approves again (C7).

Fault points for `test/fault/` (thrown faults and SIGKILL at each; power loss where the commit is synced):

- admission's commit; the owner's answer's commit; a rule change's sweep;
- in the signer child before and after signing; the start commit, before and after its sync;
- before and after each broadcast; each bump's and cancel's commit, before and after its sync;
- the follower's receipt, reorg and finality commits; the ledger raise;
- the x402 observation's commit, the authorization's commit and sync, the header handed to the box;
- a backup restored over a home whose payments went on (C16's restore marker).

### x402: the endpoint is what the daemon saw

The case that makes per-endpoint rules useful: the agent's code calls an API, which answers `402 Payment Required`
with what it wants paid (amount, asset, `payTo`, the resource). The payment is an EIP-3009 authorization the daemon
signs; only the signature enters the box.

The rule binds the endpoint, so the endpoint must be one the daemon verified, not one the agent names. If the agent
passed the 402's contents to a tool, a page could hand it a made-up challenge "from" an endpoint set to Always with
its own `payTo`. So:

- the box's request goes through the guarded proxy (src/core/egress.ts), which already sees every request and its
  answer; the proxy records a 402 it sees as an observation: the origin and path it actually reached over TLS, and
  the requirements as received (v2 `PAYMENT-REQUIRED`);
- `wallet__pay_x402(observation)` names that observation; the daemon signs only what was observed, for that
  endpoint's rule, with every term from the observation and none from the agent; the authorization is committed and
  synced before its header leaves (C21);
- validity is anchored to both clocks, chain time c (the latest block) and the wall clock w: `validAfter` =
  min(c, w) − 5 s, `validBefore` = max(c, w) + min(`maxTimeoutSeconds`, 60 s). The token checks the window against
  block time and a facilitator against its own clock (the reference one refuses `validBefore` < now + 6 s and
  `validAfter` > now), so it holds for both; signing pauses while c and w differ by more than 120 s, which keeps a
  window under 185 s (C19);
- the agent retries with the `PAYMENT-SIGNATURE` header (x402 v2; v1's `X-PAYMENT` is not read);
- the authorization is Settled once `AuthorizationUsed` is on chain, and Expired only once the block at `validBefore` is
  finalized without it (C19); a facilitator's `settlement_pending` is shown as reported, never as paid or failed.

An endpoint whose `payTo`, asset or network changes since its rule was set is a different recipient and asks again:
the owner trusted it paying someone. A Deny on an endpoint holds for every agent of the wallet.

### Keeping the bound true

"At most the balance" holds only if no signature reaches money not in the wallet yet. Refused by default, in every
write tool: token approvals and permits (`approve`, `setApprovalForAll`, EIP-2612, Permit2) beyond an exact amount
spent at once; raw `eth_sign` / `personal_sign`; EIP-7702 delegations; typed data outside the shapes the definition
lists (EIP-3009, short validity). An address that gains code (a delegation signed elsewhere with the exported key)
takes the wallet offline for agents and shows a warning in place of Receive (C17).

### Chains, RPC and privacy

**Base** first (low fees, USDC, where x402 settles); one network per wallet, fixed at creation (OD-9). The RPC
endpoint learns the address and the owner's IP, so each network's RPC is a field of the home's configuration
(`config.json`, `wallets.rpc.<network>`) with a public default banda ships, said plainly in Settings → Wallets, where
the owner changes it; an absent field takes the default. The RPC is untrusted for what it reports (TA-4): a balance is a dated reading, and a foreign transaction or
a failed receipt counts only when proven (C7). An EOA needs a little ETH for gas; x402 payments are gasless for the
payer. banda talks to the RPC with a small JSON-RPC client over `fetch`, not viem, which would ship a second curve
library ([`wallets/stack.md`](wallets/stack.md)).

**The transaction list.** Outgoing rows are the store's own payments, so they are true even when the RPC is not.
Incoming rows are derived and rebuildable (C22): USDC from `Transfer` logs to the home's wallets on the pinned token
contracts, ETH from balance checkpoints and a bisection between them, and a nonce that moved with no payment in the
store shown as "sent outside banda". No keyless hosted API serves Base mainnet history (Etherscan wants a paid tier;
Blockscout challenges scripts), so the list is self-indexed through the owner's RPC; on Base Sepolia it matched
Blockscout 118 of 118 transfers and found native changes Blockscout missed. `mainnet.base.org` refuses `eth_getLogs`,
so Base's default is a keyless public endpoint that serves it (`base-rpc.publicnode.com`: 10,000 blocks a call, state
about two months back without a token; its terms for sustained use are still to check), and Base Sepolia's is
`sepolia.base.org`. banda probes any RPC the owner sets for its log range; with one that serves no logs, Settings says
the incoming list cannot be built.

### Keys and the keychain

- **An independent random key per wallet**, never a seed shared by the home: one leak loses one wallet, removing a
  wallet removes its key, and signing for one wallet loads that wallet's key only. No recovery phrase; the export is
  the raw key beside the address it opens, which MetaMask and `cast` import ([`wallets/stack.md`](wallets/stack.md)
  section 6).
- **One item per wallet**, account `<home-id>/wallet/<address>`, never overwritten; a canary item tells a missing key
  from a keychain that cannot answer.
- **What it protects against, stated plainly (TA-1).** On macOS the item trusts an executable, not a script, so any
  script run by the bundled Node reads every wallet's key without a prompt (the keychain spike); on Linux any process
  of the user on the session bus reads an unlocked collection. So any connected coding agent takes wallets offline, as
  host mode does, until the signer helper ships (OD-11): a separately signed executable with its own keychain access
  group, which the bundled Node cannot read through. It is designed and spiked as its own step (Spikes, below). Every package the daemon loads is inside this boundary, so the supply-chain controls
  cover the daemon's whole tree, not the signing libraries alone ([`wallets/stack.md`](wallets/stack.md) section 5).
- **Saving the key at creation (requirement 5).** The ready commit mints a one-time capability bound to the create
  request, spent within 10 minutes with a secret that only that creation's own answer carries (to the desktop app, a
  loopback browser of `banda serve`, the host TTY of `banda wallet create`), before the address is shown; a repeat of
  the creation carries none. A later reveal is not on the
  daemon's HTTP API: the desktop app's main process re-authenticates the owner, starts the signer child itself and
  shows the key in a local window (OD-2, C16). The re-authentication is Touch ID, asked only where macOS says it is
  set up; elsewhere (Linux, Windows, a Mac without Touch ID) a later reveal, Restore key and Move signing are refused,
  never run without it, and the key is shown at creation alone. The saved copy is confirmed by pasting it back. In a
  loopback browser the creation's reveal is readable by the browser's extensions: a residual accepted (H-272, OOS-10),
  so there the create and save screens say so and point to the desktop app or `banda wallet create`.

### Homes, forks and backups

- **The lease.** A home signs only if the keychain's lease item `<home-id>/lease` and a home secret both match its
  own. The home secret is a keychain item bound to the home's realpath and inode, outside the home directory, so a
  backup, a restore, a `home:fork` or a hand copy (`cp -a`, rsync) starts offline, and "move this wallet here" is an
  explicit host act (C16).
- **`home:fork`** signs nothing: it reads balances and history and never signs. A development build run against a
  fork is still code run as the owner (TA-1), so development uses a keychain service of its own, never the released
  app's.
- **Tests** use an in-memory keystore and anvil; they never touch the real keychain. Keychain experiments use only
  throwaway items they delete.
- **Removing a wallet** is refused while a payment is not final, an authorization is live, the balance at `safe` is
  above zero, or the address was shown while the key was never confirmed saved. The step that deletes the key checks
  all of this again, so funds or a payment that arrive meanwhile stop it (C17).
- **Backups** hold the record and the recipients, not the key; losing the machine loses the funds unless the owner
  saved the key. A restored home starts with a restore marker: a payment the backup held before its burn point is
  Restored (closed, told to the chat, never resumed); one past it is tracked from its stored versions.
- **Stored shapes** (the Wallet doc, recipients, permissions, payments and versions, the ledger, `config.json`'s
  `wallets.rpc`) need a `MIGRATIONS` step, its faults and a kept home (AGENTS.md "Changes").

## Slices

1. **A wallet that reads.** Keystore interface (in-memory for tests, macOS keychain through the signer child), the
   lease and home secret, "Give Mara a wallet" with the key saved at creation, Settings → Wallets, Receive (address
   and QR), balance on Base, the transaction list's incoming rows, `wallet__address`, `wallet__balance`. Specimen
   cards.
2. **Send with recipients.** `wallet__send` for ETH and USDC; owner Send; the recipient list with names and Always /
   Ask / Deny; the first-payment card; the lane with the fused start commit, synced versions, bumps and cancel,
   receipts to `finalized`; the off switch, archive and removal; the fault sweep. Walkthrough on Base Sepolia with a
   throwaway home and testnet funds, desktop and phone width.
3. **x402.** Proxy observations of 402 challenges, `wallet__pay_x402`, per-endpoint rules, an agent paying a test
   endpoint from the box in a routine (asks the first time, not the second).
4. **Linux Secret Service**, and the headless "no keychain" state.
5. **`wallet__call`** with the beneficiary identity and the approval guards, once a use needs it.

The use cases per slice, with their scenarios, are in [`wallets/use-cases.md`](wallets/use-cases.md).

## Spikes before any of this is design

Each ran under [`wallets/spikes/`](wallets/spikes/); what is still open is listed in its README.

- [x] Keychain from the daemon's bundled Node: `@napi-rs/keyring` in a signer child (keychain); a Developer
  ID-signed bundle across an update and a locked login keychain still open
- [ ] OD-11, the signer helper: design it, then spike a separately signed executable with its own keychain access
  group on macOS (an item the bundled Node cannot read, the group kept across an update, notarization), before wallets
  run beside a host coding agent; on Linux, what if anything narrows the session bus
- [ ] Linux: Secret Service under a desktop session vs. systemd or SSH; a locked keyring mid-routine (run headless
  on arm64 only)
- [x] Signing library: `@noble/curves` + `@noble/hashes` + `micro-eth-signer`, pinned exactly, byte-identical to
  `ox` and `cast` (keys-and-signing; [`wallets/stack.md`](wallets/stack.md))
- [x] Deny as a rule stored on the recipient beside permissions, checked in the same commit (banda-integration,
  lane-model)
- [x] The proxy observing a 402 over TLS (banda-integration, with banda's pinned mitmproxy), and the facilitator's settlement (x402-settlement)
- [x] Nonce and replacement on anvil: a crash after broadcast, a dropped transaction, two processes (nonce-and-crash);
  Base Sepolia still to run
- [x] Transaction history without a keyed API: self-indexed logs and balance bisection (tx-history)
- [x] The outside-world claims the scenarios lean on: anvil's `safe` and `finalized` tags and reorgs, a USDC fixture
  that works offline, Base's public endpoints, geth and reth pool errors, the L1 fee, the facilitator's
  `settlement_pending` (gaps)
- [ ] Which calls and typed-data shapes reach future deposits, tested as refusals
- [ ] C19's anchored window against the reference facilitator with chain time 60 s behind and 10 s ahead of the wall
  clock, where the chain-time window was refused
- [ ] Where a keyed RPC URL lives (H-195): `config.json`'s `wallets.rpc`, as "Chains, RPC and privacy" says, or a
  secret beside the proxy credentials in `auth/`, as H-195 expects; either way it is shown masked
- [ ] C7 and C12's second, independent RPC per network: which public endpoint banda ships beside the first (another
  operator, serving `finalized`), and the `config.json` field under `wallets` where the owner sets it
- [ ] `base-rpc.publicnode.com` as Base's default: its terms for sustained use, and the list's depth past its two
  months
- [ ] macOS: a locked login keychain, a Deny on its prompt, a session with no GUI; the device password where Touch ID
  is not set up (LocalAuthentication's owner authentication, which Electron does not offer), and how Linux and Windows
  re-authenticate the owner at all (OD-2): until then a later reveal, Restore and Move are refused there
- [ ] H-023's item labels: `@napi-rs/keyring` sets none, so Keychain Access shows an item by its service and account
  alone; a label needs another API or the OD-11 helper
- [ ] Linux: a listing of the Secret Service's items alone (`findCredentialsAsync` takes no store and may read the
  kernel keyring), which the orphan sweep needs; until then the keystore refuses the listing on Linux
- [x] UC-21 A1, "move the lease to this home": a move rewrites the home secret (C16)
- [ ] The binding's stability on Linux (ext4, btrfs, with and without statx), across a remount there and across a
  reboot on either platform: unproven; spikes/home-binding has the macOS run and the Linux script, not yet run
