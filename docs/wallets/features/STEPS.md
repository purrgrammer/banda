# Wallet scenarios: the step vocabulary

Status: analysis for the RFC in [`../../wallets.md`](../../wallets.md), dated 2026-11-23. Nothing here is a DESIGN.md
rule (principle 6).

The feature files in this folder use **only** the phrases below. Each phrase maps to exactly one thing of the model in
[`../model/transitions.json`](../model/transitions.json):

| Kind | What it is | Keyword | What the step does |
|---|---|---|---|
| `state` | a machine's state | `Given` (precondition) or `Then` (assertion) | `Given` puts the machine in that state before its first event; `Then` asserts the state the table gave |
| `atom` | one atom of one machine's guards: a fact about the world the next event reads | `Given` | sets that atom; it holds until a later step of the same atom changes it |
| `event` | one event of one machine | `When` | the machine takes the one row whose guard holds, and moves to its `to` |
| `invariant` | one safety property of a TLA+ module, checked by TLC over every reachable state | `Then` | asserts the property; the runner checks it on the store and the chain after the scenario |

`And` and `But` take the keyword of the step before them. A `"<state>"` or `"<value>"` in quotes is the one place a
phrase takes a parameter; in a Scenario Outline it is filled from Examples.

## The rules a scenario follows

1. **Outcomes come only from the table.** A `Then` state is never chosen by the author: it is the `to` of the row the
   scenario's atoms select. `check_features.py` replays every scenario and fails when a `Then` disagrees.
2. **A scenario is fully determined.** At each event, every value of the atoms the scenario left unset must select
   the same row. If two completions select different rows, the scenario is underspecified and the checker names the
   atoms to set. So no scenario relies on a default nobody wrote down.
3. **Events never change atoms.** An event moves its machine and nothing else; when the world changes (the owner set
   a rule, a block was finalized), the scenario says so with a new `Given`. The cross-machine coherence of those
   contexts (a card's Always also changing the recipient's rule) is what `PaymentLane.tla` checks by composition; the
   step checker checks each step against the table, and the links of `transitions.json` (S10) fail a scenario whose
   contexts contradict each other (a payment's rule Always while its recipient is denied).
4. **One phrase, one mapping.** A phrase names its machine by its subject: "the wallet" (`wallet`), "the signer"
   (`signing`), "the recipient" (`recipient`), "the payment" (`payment`), "the nonce lane" (`nonce`), "the x402
   payment" (`x402`). An event that touches two machines in one commit (a card answer moves the payment and the
   recipient) is written as two steps, one per machine.
5. **Tags follow the replay.** `@t:<machine>:<from>:<event>:<guard>` lists every row the scenario exercised, with the
   guard written as its slug: `and` → `&`, `or` → `|`, `not` → `!`, `==` → `=`, `(` `)` → `[` `]`, `True` → `T`, quotes
   and spaces dropped (`python3 -I check_features.py --slugs` prints every row's tag). An outline carries them per
   Examples block, so every row of one block exercises the same rows of the table.

The last column says how an automated step realises the phrase in a test (see [`ISOLATION.md`](ISOLATION.md)); it is
guidance for the step definitions, not part of the mapping. "gaps §X" there points at the evidence in
[`../spikes/gaps/README.md`](../spikes/gaps/README.md); N is anvil's `--slots-in-an-epoch`.

## wallet (`WalletLifecycle.tla`)

| Phrase | Kind | Maps to | Realised by |
|---|---|---|---|
| `the wallet is "<state>"` | state | `wallet` | the wallet doc's `phase` (`none` = no doc) |
| `the owner creates a wallet` | event | `wallet.create` | `POST` the create route with a client request id |
| `the signer writes the key to the keychain` | event | `wallet.keychain_write` | the signer child's write, fault point `keychain:write` |
| `the signer reads the key back` | event | `wallet.read_back` | the signer child's read-back and derive |
| `the daemon restarts while the wallet is in that state` | event | `wallet.restart` | SIGKILL the daemon, start it on the same home |
| `the owner asks to reveal the key` | event | `wallet.reveal` | at creation, the reveal route with the creation's secret; later, the desktop's own signer after an OS re-authentication, which then tells the daemon (`POST /wallets/<a>/revealed`) |
| `the owner pastes the key back` | event | `wallet.confirm_saved` | the confirm route with the pasted text |
| `the owner skips saving the key` | event | `wallet.skip_save` | the skip route |
| `the owner opens Receive` | event | `wallet.show_receive` | the receive route (address and QR payload) |
| `the owner archives the wallet` | event | `wallet.archive` | the archive route with the version seen |
| `the owner unarchives the wallet` | event | `wallet.unarchive` | the unarchive route with the version seen |
| `the owner removes the wallet` | event | `wallet.begin_remove` | the remove route with the version seen |
| `the signer deletes the keychain item` | event | `wallet.delete_item` | the signer child's delete, fault point `keychain:delete` |
| `the keychain reports the item gone` | event | `wallet.item_gone` | the read after the delete returns `null` with a working canary |
| `the keychain answers` | atom | `wallet.kc_up = True` | in-memory keystore up (tagged keychain scenarios: a real item under a `banda-spike-` service) |
| `the keychain does not answer` | atom | `wallet.kc_up = False` | keystore throws "Couldn't access platform storage", or the signer child is killed at its deadline |
| `the keychain holds no item for the address` | atom | `wallet.item = empty` | no entry under `<home-id>/wallet/<address>` |
| `the keychain item derives the wallet's address` | atom | `wallet.item = ours` | the entry holds the key drawn for this wallet |
| `the keychain item holds another key` | atom | `wallet.item = other` | an entry under the account whose key does not derive the wallet's address (planted, or not a key) |
| `the reveal comes from the host's desktop shell` | atom | `wallet.cap_host = True` | Electron main after an OS re-authentication (Touch ID): its own signer child reads the key at this home's lease and shows it in a bundled page, and the daemon never holds it (C16, C20); for the code acknowledgement and the desktop's word that a key was seen, any request on this computer with the owner's token (see the next rows) |
| `the reveal comes from the client that created the wallet` | atom | `wallet.cap_host = True` | the creation's secret: only the create answer carries it, the ready commit keeps its SHA-256 for the create request id, and it is spent once within 10 min, before the address is shown, with no OS re-authentication (C16; the desktop, `banda serve` with a loopback browser, `banda wallet create` on the host TTY) |
| `the reveal comes from a paired device or the token alone` | atom | `wallet.cap_host = False` | for a reveal: a phone, a browser device, a script in the web UI's origin, or a local process with the owner's token and no creation secret; for the code acknowledgement and the desktop's word that a key was seen: a paired device only, since the owner's token on this computer counts as the host for those two acts (a process holding it can already do every owner act, and a false word adds a reveal to the record, hiding none) |
| `the reveal capability is fresh and unused` | atom | `wallet.cap_fresh = True` | a capability minted within its lifetime, never consumed |
| `the reveal capability is used or expired` | atom | `wallet.cap_fresh = False` | a replayed or stale capability (injected clock) |
| `the pasted key derives the wallet's address` | atom | `wallet.pasted_derives = True` | the key the test drew |
| `the pasted key does not derive the wallet's address` | atom | `wallet.pasted_derives = False` | one character changed |
| `the wallet holds funds at safe` | atom | `wallet.funds = True` | `anvil_setBalance` above zero, then N + 1 blocks mined (the balance belongs to the next block; `safe` is latest − N, gaps §A), read at `safe` |
| `the wallet holds nothing at safe` | atom | `wallet.funds = False` | zero balance and zero USDC at `safe` |
| `the wallet has a payment or authorization in flight` | atom | `wallet.inflight = True` | a non-terminal payment or a live authorization in the store |
| `the wallet has nothing in flight` | atom | `wallet.inflight = False` | every payment terminal, no live authorization |
| `the wallet's address has left banda` | atom | `wallet.address_disclosed = True` | Receive or its QR was shown, `wallet__address` or `wallet__balance` answered, a screen showed the address, or the wallet has a transaction |
| `the wallet's address never left banda` | atom | `wallet.address_disclosed = False` | none of those |
| `the wallet's address has code` | atom | `wallet.has_code = True` | `anvil_setCode` on the address (an EIP-7702 delegation `0xef0100…` made with the exported key) |
| `the wallet's address has no code` | atom | `wallet.has_code = False` | `eth_getCode` returns `0x` |
| `an agent reads the wallet's address` | event | `wallet.agent_reads_address` | `wallet__address` (or `wallet__balance`) from the agent's tool call |
| `the owner acknowledges the address's code` | event | `wallet.acknowledge_code` | the acknowledge route, refused to a paired device |
| `the owner confirmed the key saved` | atom | `wallet.saved = True` | the paste-back check passed before |
| `the owner never confirmed the key saved` | atom | `wallet.saved = False` | no paste-back check passed |
| `the owner's wallet act carries the current version` | atom | `wallet.version_current = True` | the act sends the wallet doc's current version |
| `the owner's wallet act carries a stale version` | atom | `wallet.version_current = False` | another device changed the wallet first |

## signing (`WalletLifecycle.tla`)

| Phrase | Kind | Maps to | Realised by |
|---|---|---|---|
| `the signer is "<state>"` | state | `signing` | the wallet's offline reason (`online` = none) |
| `the keychain locks` | event | `signing.keychain_locks` | keystore switched to "locked" (Linux: collection locked over D-Bus) |
| `the keychain item disappears` | event | `signing.item_lost` | the entry deleted outside banda |
| `the signer checks the key` | event | `signing.unlock_check` | the signer child reads, derives and compares the address, and checks the lease |
| `the owner restores the key` | event | `signing.restore_key` | "Restore key" with a pasted key |
| `the signing lease moves` | event | `signing.lease_moved` | a lease epoch written by this home or another one |
| `the signer's key derives the wallet's address` | atom | `signing.derives = True` | the keychain item (or the pasted key) opens the record's address |
| `the signer's key derives another address` | atom | `signing.derives = False` | another key under the account |
| `this home holds the signing lease` | atom | `signing.lease_mine = True` | the keychain's lease epoch and home-secret hash match this home's |
| `another home holds the signing lease` | atom | `signing.lease_mine = False` | a restored backup, a fork, or a home without the home secret |
| `the home runs commands on the host` | atom | `signing.host_mode = True` | `serve --box host` |
| `the home runs commands in a box` | atom | `signing.host_mode = False` | `serve --box container` or the bundled computer |

## recipient (`RecipientRule.tla`, per wallet and identity)

| Phrase | Kind | Maps to | Realised by |
|---|---|---|---|
| `the recipient is "<state>"` | state | `recipient` | the recipient doc's entry for this identity: `unknown` (no entry), `ask`, `deny` |
| `the recipient takes the card answer Pay` | event | `recipient.card_pay` | the same commit as the card's Pay |
| `the recipient takes the card answer Always pay` | event | `recipient.card_always` | the same commit as the card's Always pay |
| `the recipient takes the card answer Don't pay` | event | `recipient.card_dont_pay` | the same commit as the card's Don't pay |
| `the recipient takes the card answer Never pay` | event | `recipient.card_never` | the same commit as the card's Never pay |
| `the owner sets the recipient to Ask in the list` | event | `recipient.list_set_ask` | Recipients list, rule Ask (lifts a Deny, takes every agent's Always back) |
| `the owner sets the recipient to Always in the list` | event | `recipient.list_set_always` | Recipients list, Always for one agent |
| `the owner sets the recipient to Deny in the list` | event | `recipient.list_set_deny` | Recipients list, Deny |
| `the owner renames the recipient` | event | `recipient.rename` | Recipients list, rename |
| `the owner forgets the recipient` | event | `recipient.forget` | Recipients list, forget |
| `the owner's recipient act carries the current version` | atom | `recipient.version_current = True` | the act sends the recipient doc's current version |
| `the owner's recipient act carries a stale version` | atom | `recipient.version_current = False` | another device changed the recipient first |

## permission (`RecipientRule.tla`, per wallet, agent and identity)

| Phrase | Kind | Maps to | Realised by |
|---|---|---|---|
| `the agent's permission for the recipient is "<state>"` | state | `permission` | the wallet permission of this agent for this identity: `none` or `always` |
| `the agent's permission takes the card answer Always pay` | event | `permission.card_always` | the same commit as the card's Always pay |
| `the agent's permission takes the card answer Never pay` | event | `permission.card_never` | the same commit as the card's Never pay |
| `the agent's permission takes the list's Always` | event | `permission.list_set_always` | the same commit as the list's Always for this agent |
| `the agent's permission takes the list's Ask` | event | `permission.list_set_ask` | the same commit as the list's Ask |
| `the agent's permission takes the list's Deny` | event | `permission.list_set_deny` | the same commit as the list's Deny |
| `the agent's permission takes the forget` | event | `permission.forget` | the same commit as the list's forget |
| `the agent's permission takes the rename` | event | `permission.rename` | the same commit as the list's rename |
| `the recipient is unknown when the act commits` | atom | `permission.rcpt = unknown` | no entry for the identity |
| `the recipient is set to Ask when the act commits` | atom | `permission.rcpt = ask` | the entry's rule is Ask |
| `the recipient is set to Deny when the act commits` | atom | `permission.rcpt = deny` | the entry's rule is Deny |
| `the owner's permission act carries the current version` | atom | `permission.version_current = True` | the act sends the recipient doc's current version |
| `the owner's permission act carries a stale version` | atom | `permission.version_current = False` | another device changed the recipient first |

## payment (`PaymentLane.tla`)

| Phrase | Kind | Maps to | Realised by |
|---|---|---|---|
| `the payment is "<state>"` | state | `payment` | the payment entry's state in the wallet's ledger doc (`Idle` = none) |
| `the payment is requested` | event | `payment.call` | `wallet__send` from the agent's tool call, or the owner's Send |
| `the owner taps Pay on the payment's card` | event | `payment.card_pay` | the card's Pay, with the version seen |
| `the owner taps Always pay on the payment's card` | event | `payment.card_always` | the card's Always pay |
| `the owner taps Don't pay on the payment's card` | event | `payment.card_dont_pay` | the card's Don't pay |
| `the owner taps Never pay on the payment's card` | event | `payment.card_never` | the card's Never pay |
| `a Deny for the payment's recipient commits` | event | `payment.deny_committed` | a list or card Deny for the recipient, from any device |
| `an Always for the payment's agent and recipient commits` | event | `payment.always_committed` | an Always granted on another card or in the list |
| `the run is cancelled or the wallet is switched off for the payer` | event | `payment.cancel_or_switch_off` | cancel the chat's run, switch the wallet off for the agent, archive the wallet or the agent |
| `the payment's deadline passes` | event | `payment.deadline` | the store's timer fires (injected clock, 24 h) |
| `the signer signs the payment` | event | `payment.sign` | the signer child signs in its own memory, fault point `wallet:signed` |
| `the lane runs the start commit` | event | `payment.start_commit` | the fused commit: re-check, nonce, signed bytes |
| `the lane broadcasts the stored bytes` | event | `payment.broadcast` | `eth_sendRawTransaction` of the committed bytes |
| `the lane bumps the fee` | event | `payment.bump` | a new version at the same nonce, both fees +12.5%, committed and synced first |
| `the owner cancels the sent payment` | event | `payment.cancel_replace` | the owner's Cancel on a Sent row: a zero-value self-transfer at the same nonce, fees raised, committed and synced first |
| `the power fails and the daemon restarts with the payment in that state` | event | `payment.power_loss` | the store under a filesystem that drops unsynced writes (LazyFS, or a VFS that discards un-fsynced pages), cut at the fault point named, restart on the same home |
| `the home is restored from a backup taken with the payment in that state` | event | `payment.restore_backup` | `banda restore` of a backup made at that point, after the chain moved on |
| `the lane reads the receipt at the payment's nonce` | event | `payment.receipt` | receipts of every stored version, and the count at the nonce |
| `a reorg removes the payment's block` | event | `payment.reorg` | `anvil_reorg`, never deeper than 2N (anvil rewrites finalized blocks without complaint, gaps §A) |
| `the payment's block reaches finality` | event | `payment.finality` | the block at `safe` and `finalized` (anvil: latest − 32, − 64) |
| `the daemon crashes and restarts with the payment in that state` | event | `payment.crash` | SIGKILL at the fault point named in the scenario, restart on the same home |
| `the payer is the agent` | atom | `payment.payer = agent` | the payment comes from an agent's tool call |
| `the payer is the owner` | atom | `payment.payer = owner` | the payment is the owner's Send |
| `the payment's recipient is set to Deny` | atom | `payment.rule = deny` | Deny for (wallet, recipient) |
| `the payment's recipient is set to Always` | atom | `payment.rule = always` | Always for (wallet, agent, recipient) |
| `the payment's recipient is set to Ask` | atom | `payment.rule = ask` | the recipient is known, rule Ask |
| `the payment's recipient is unknown` | atom | `payment.rule = unknown` | no entry for the recipient |
| `the wallet's default for unknown recipients is Deny` | atom | `payment.default_deny = True` | the wallet's default set to Deny (OD-13) |
| `the wallet's default for unknown recipients is Ask` | atom | `payment.default_deny = False` | the wallet's default left at Ask |
| `the available balance covers the payment` | atom | `payment.fits = True` | balance at the read block − reservations − fee reserve ≥ amount |
| `the available balance does not cover the payment` | atom | `payment.fits = False` | the same < amount, or the balance unknown |
| `the owner's approval of the payment is fresh` | atom | `payment.approved = True` | Pay tapped under an hour before the start commit |
| `the payment has no fresh approval` | atom | `payment.approved = False` | no Pay, or a Pay over an hour old (injected clock) |
| `the answer comes from the host or the recipient is known on the host` | atom | `payment.host_ok = True` | the desktop app on the host, or a recipient whose rule the owner set, or to which a payment was confirmed, on the host |
| `the answer comes from a paired device and the recipient is new to the host` | atom | `payment.host_ok = False` | a phone or browser device answers a card whose recipient only an agent's ask created |
| `the wallet is usable by the payer` | atom | `payment.wallet_usable = True` | C3 steps 1, 2, 3, 6: exists, not archived, switched on for the agent, tool on, can sign |
| `the wallet is not usable by the payer` | atom | `payment.wallet_usable = False` | any of those fails |
| `the nonce ledger moved since signing` | atom | `payment.ledger_moved = True` | another version or payment took the ledger's nonce first |
| `the nonce ledger is as the signer read it` | atom | `payment.ledger_moved = False` | the ledger equals the nonce the bytes carry |
| `the receipt names a stored version of the payment` | atom | `payment.blk = own` | a receipt for one of the stored paying hashes |
| `the receipt names the payment's cancel replacement` | atom | `payment.blk = own_cancel` | a receipt for the stored cancel version's hash |
| `the RPC's claim is proven` | atom | `payment.verified = True` | the foreign transaction fetched, its signer recovered to the wallet at the nonce, its hash none of the stored ones (or the status-0 receipt), and the second RPC agrees on the finalized block |
| `the RPC's claim cannot be verified` | atom | `payment.verified = False` | a lying-RPC double: a fabricated foreign hash or status 0, the second RPC disagreeing or down |
| `a foreign transaction holds the payment's nonce` | atom | `payment.blk = foreign` | a transaction at the nonce whose hash the store does not hold |
| `no transaction holds the payment's nonce yet` | atom | `payment.blk = none` | no receipt and the count is still at the nonce |
| `that block is finalized` | atom | `payment.blk_fin = True` | the block is at or below `finalized`: 2N blocks mined after it (gaps §A) |
| `that block is not finalized` | atom | `payment.blk_fin = False` | the block is above `finalized` |
| `the receipt's status is 1` | atom | `payment.blk_ok = True` | `status: 0x1` |
| `the receipt's status is 0` | atom | `payment.blk_ok = False` | `status: 0x0` (reverted) |

## nonce (`NonceAlloc.tla`)

| Phrase | Kind | Maps to | Realised by |
|---|---|---|---|
| `the nonce lane is "<state>"` | state | `nonce` | the wallet lane's ledger entry: free, signing, in flight or blocked |
| `the nonce lane takes its next turn` | event | `nonce.lane_turn` | the lane task picks the head of its queue |
| `the nonce lane runs its start commit` | event | `nonce.start_commit` | the fused commit with compare-and-set on the ledger |
| `the daemon crashes and restarts with the nonce lane in that state` | event | `nonce.crash` | SIGKILL, restart on the same home |
| `the in-flight nonce is included at latest` | event | `nonce.included_latest` | a receipt for a stored hash at `latest` |
| `a foreign transaction is seen at the in-flight nonce` | event | `nonce.foreign_at_nonce` | a transaction from the exported key at that nonce |
| `the power fails and the daemon restarts with the nonce lane in that state` | event | `nonce.power_loss` | as for the payment, the store on a filesystem that drops unsynced writes |
| `the foreign transaction is proven` | atom | `nonce.verified = True` | signer recovered to the wallet at the nonce, and the second RPC agrees on the finalized block |
| `the foreign transaction cannot be verified` | atom | `nonce.verified = False` | one RPC's word only (a lying-RPC double) |
| `a reorg undoes an inclusion` | event | `nonce.reorg_undoes_inclusion` | `anvil_reorg` of the including block, at most 2N deep; a re-included transaction is listed after every earlier nonce of its sender (gaps §A) |
| `the nonce lane reads the finalized count` | event | `nonce.finality` | `eth_getTransactionCount(address, "finalized")` |
| `a payment is queued in the lane` | atom | `nonce.queued = True` | a Queued payment at the head of the lane |
| `no payment is queued in the lane` | atom | `nonce.queued = False` | an empty queue |
| `the signer can read and prove the key` | atom | `nonce.can_sign = True` | keychain up, key derives the address, lease held |
| `the signer cannot read or prove the key` | atom | `nonce.can_sign = False` | locked, missing, wrong key, other home, or the signer child killed at its deadline |
| `the chain's count is above the ledger without a stored hash to explain it` | atom | `nonce.chain_ahead = True` | the exported key sent while banda was idle |
| `the chain's count is explained by the ledger` | atom | `nonce.chain_ahead = False` | every nonce below the count is a stored hash or the ledger |
| `the lane's ledger moved since signing` | atom | `nonce.ledger_moved = True` | compare-and-set sees another value |
| `the lane's ledger is as the signer read it` | atom | `nonce.ledger_moved = False` | compare-and-set sees the value read |
| `the start commit's re-check passes` | atom | `nonce.recheck_ok = True` | C3 steps 1, 2, 6, 7, 8 and freshness still hold |
| `the start commit's re-check fails` | atom | `nonce.recheck_ok = False` | one of them fails (Deny, switch-off, balance, stale approval) |
| `the nonce is used at finalized` | atom | `nonce.above_final = True` | the finalized count is above the nonce: 2N blocks mined after its inclusion (gaps §A) |
| `the nonce is not yet used at finalized` | atom | `nonce.above_final = False` | the finalized count is at or below the nonce |
| `a later nonce is in flight after a reorg` | atom | `nonce.more_in_flight = True` | a reorg brought an earlier payment back while a later one was in flight |
| `no other nonce is in flight` | atom | `nonce.more_in_flight = False` | one in flight |

## x402 (`X402.tla`)

| Phrase | Kind | Maps to | Realised by |
|---|---|---|---|
| `the x402 payment is "<state>"` | state | `x402` | the observation's and authorization's state in the store (`none` = no observation) |
| `the proxy sees a 402 from the box's request` | event | `x402.proxy_sees_402` | the test 402 server (`@x402/express` 2.30.0) answers the box through the proxy |
| `the agent pays the observation` | event | `x402.call` | `wallet__pay_x402` naming the observation id |
| `the owner taps Pay on the x402 card` | event | `x402.card_pay` | the card's Pay |
| `the owner taps Always pay on the x402 card` | event | `x402.card_always` | the card's Always pay |
| `the owner taps Never pay on the x402 card` | event | `x402.card_never` | the card's Never pay |
| `the owner taps Don't pay on the x402 card` | event | `x402.card_dont_pay` | the card's Don't pay |
| `the x402 payment's deadline passes` | event | `x402.deadline` | the store's timer (injected clock) |
| `the daemon runs the authorization commit` | event | `x402.authorization_commit` | the commit of the derived nonce, the message and the reservation, before any signature |
| `the daemon hands the header to the box` | event | `x402.hand_header` | `PAYMENT-SIGNATURE` reaches the box's retry |
| `the agent pays the same observation again` | event | `x402.agent_pays_again` | a second `wallet__pay_x402` with the same id |
| `the follower reads the authorization's state` | event | `x402.follow` | `authorizationState(wallet, nonce)` and the token's events |
| `the daemon crashes and restarts with the x402 payment in that state` | event | `x402.crash` | SIGKILL, restart on the same home |
| `the call comes from the chat that observed the 402` | atom | `x402.same_chat = True` | the observation's chat is the calling chat |
| `the call comes from another chat` | atom | `x402.same_chat = False` | another chat's or another agent's id |
| `the 402 passes the proxy's checks` | atom | `x402.verified = True` | upstream TLS verified, `https`, v2 `PAYMENT-REQUIRED`, scheme `exact`, EIP-3009, pinned asset and domain, `resource.url` equal to the observed origin and path |
| `the 402 fails the proxy's checks` | atom | `x402.verified = False` | any of those fails |
| `the endpoint is set to Deny` | atom | `x402.rule = deny` | Deny for (origin and path, payTo, asset, network), for every agent of the wallet |
| `the endpoint is set to Always` | atom | `x402.rule = always` | Always for (wallet, agent, origin and path, payTo, asset, network) |
| `the endpoint is set to Ask` | atom | `x402.rule = ask` | Ask, or a changed payTo |
| `the endpoint is unknown` | atom | `x402.rule = unknown` | no entry for (origin and path, payTo, asset, network) |
| `the wallet's default for unknown endpoints is Deny` | atom | `x402.default_deny = True` | the wallet's default set to Deny (OD-13) |
| `the wallet's default for unknown endpoints is Ask` | atom | `x402.default_deny = False` | the wallet's default left at Ask |
| `the power fails and the daemon restarts with the x402 payment in that state` | event | `x402.power_loss` | the store on a filesystem that drops unsynced writes |
| `the owner approved the x402 payment` | atom | `x402.approved = True` | Pay tapped on its card |
| `the x402 payment has no approval` | atom | `x402.approved = False` | no Pay |
| `the x402 answer comes from the host or the endpoint is known on the host` | atom | `x402.host_ok = True` | the desktop app on the host, or an endpoint whose rule the owner set or paid on the host |
| `the x402 answer comes from a paired device and the endpoint is new to the host` | atom | `x402.host_ok = False` | a phone or browser device answers the card of an endpoint new to the host |
| `the available USDC covers the x402 payment` | atom | `x402.fits = True` | balance − reservations (live authorizations and queued transfers) ≥ amount |
| `the available USDC does not cover the x402 payment` | atom | `x402.fits = False` | the same < amount |
| `the observation can still be answered` | atom | `x402.window_left = True` | under 24 h since the observation |
| `the observation can no longer be answered` | atom | `x402.window_left = False` | 24 h or more since the observation (injected clock) |
| `the authorization commit is durable` | atom | `x402.synced = True` | the commit was synced before the header left |
| `the authorization commit is not yet durable` | atom | `x402.synced = False` | the sync has not returned |
| `the chain shows AuthorizationUsed` | atom | `x402.event = used` | the token's `AuthorizationUsed(wallet, nonce)` |
| `the chain shows AuthorizationCanceled` | atom | `x402.event = cancelled` | the token's `AuthorizationCanceled(wallet, nonce)` (the exported key cancelled it) |
| `the chain shows no event for the authorization` | atom | `x402.event = none` | `authorizationState` false |
| `that event is finalized` | atom | `x402.event_fin = True` | the event's block is at or below `finalized` (`authorizationState` true there, gaps §B) |
| `that event is not finalized` | atom | `x402.event_fin = False` | above `finalized` |
| `validBefore has passed at finalized` | atom | `x402.vb_passed_fin = True` | the finalized block's timestamp ≥ `validBefore` |
| `validBefore has not passed at finalized` | atom | `x402.vb_passed_fin = False` | the finalized block's timestamp < `validBefore` |

## Invariants

| Phrase | Kind | Maps to | Realised by |
|---|---|---|---|
| `the payment is on chain at most once` | invariant | `PaymentLane.AtMostOnePaid` | each payment's transfer matched on chain once (anvil logs) |
| `a refused payment is never paid` | invariant | `PaymentLane.RefusedNeverPaid` | no Refused or Not paid entry has a mined version |
| `what the chat is told matches the chain` | invariant | `PaymentLane.ReportedIsTrue` | each reported Confirmed has its paying version's receipt at finalized, each Cancelled its cancel version's, each Failed a status 0 there |
| `a refusal the owner was told is never undone` | invariant | `PaymentLane.AckedNeverStarts` | no payment whose refusal reached the owner's devices is ever signed, across power loss |
| `an Always payment never asks` | invariant | `PaymentLane.AlwaysNeverAsks` | an agent payment admitted under Always and no Deny is never Waiting unless the rule changed |
| `no two payments share a nonce` | invariant | `PaymentLane.UniqueNonce` | ledger entries keyed by nonce are unique per wallet |
| `the wallet's nonces have no gap` | invariant | `PaymentLane.NoGap` | every nonce below the ledger is a stored entry or used on chain |
| `at most one nonce is in flight` | invariant | `PaymentLane.OneInFlight` | at most one entry Signed or Sent, except after a reorg |
| `the wallet never spends more than was funded` | invariant | `PaymentLane.SpentWithinFunded` | the sum of confirmed amounts and fees ≤ funded |
| `every start rests on Always, a fresh approval or the owner as payer` | invariant | `PaymentLane.StartBasis` | each Signed entry's start commit read Always, a fresh approval, or payer owner |
| `a Deny refuses every later call to its recipient` | invariant | `PaymentLane.DenyRefusesCall` | no Waiting or Queued entry for a Denied recipient after the Deny's commit |
| `admission is decided by identity, never by label` | invariant | `PaymentLane.AdmitByIdentity` | the admitted rule's key is the EIP-55 address on the network |
| `the nonce ledger never moves down` | invariant | `PaymentLane.LedgerMonotone` | each ledger write ≥ the previous |
| `the payment moves only along the table's edges` | invariant | `PaymentLane.ForwardOnly` | each stored state change is an edge of `transitions.json` |
| `each lane effect is on chain at most once` | invariant | `NonceAlloc.AtMostOnce` | as `AtMostOnePaid`, over the lane's effects and the external spender |
| `the ledger is raised only at finalized` | invariant | `NonceAlloc.RaiseOnlyFinal` | a raise to the chain's count reads `finalized` |
| `nonces follow the lane's queue order` | invariant | `NonceAlloc.FifoNonces` | nonce order equals queue-commit order |
| `an unknown recipient is never Always` | invariant | `RecipientRule.UnknownNeverAlways` | no Always without a recipient entry |
| `a permission lives only under a known recipient that is not denied` | invariant | `RecipientRule.PermissionUnderRecipient` | every wallet permission's identity has an entry whose rule is Ask |
| `a Deny excludes every Always for that recipient` | invariant | `RecipientRule.DenyExcludesAlways` | Deny and Always never coexist for one identity |
| `a Deny holds for every agent of the wallet` | invariant | `RecipientRule.DenyIsPerWallet` | the Deny key has no agent |
| `a rename keeps the recipient's rule` | invariant | `RecipientRule.RenameKeepsRule` | rule before = rule after a label change |
| `an Always covers only the agent it was granted to` | invariant | `RecipientRule.AlwaysPerAgent` | the Always key names one agent |
| `no act applies on a version it did not see` | invariant | `RecipientRule.NoLostUpdate` | every applied act's version equals the doc's at its commit |
| `the key is never in the store or the box` | invariant | `WalletLifecycle.KeyNeverInStoreOrBox` | a scan of the store, blobs, logs and the box's filesystem for the key's hex finds nothing |
| `the address leaves banda only after the key was saved or the step skipped` | invariant | `WalletLifecycle.AddressOnlyAfterSaveStep` | Receive, `wallet__address` and `wallet__balance` refuse in `ready_unsaved` |
| `banda never destroys the only copy of a funded wallet's key` | invariant | `WalletLifecycle.FundsNeverOrphanedByBanda` | a wallet whose own key is gone while its address holds funds had its key saved, never had its address leave banda, or lost its key to the OS (the item deleted outside banda), as C17's `Removable` gives it; banda deletes the item only while the balance reads empty and nothing is in flight |
| `banda never signs with a key that does not derive the address` | invariant | `WalletLifecycle.NeverSignWithForeignKey` | every signature's recovered address equals the record's |
| `only one home signs for the wallet` | invariant | `WalletLifecycle.OneSigningHome` | signatures come from the lease holder only |
| `banda never deletes a key that does not open its wallet` | invariant | `WalletLifecycle.ForeignKeyKept` | any item under the account that does not derive the wallet's address is the same after the removal; the signer's remove reads and derives before it deletes |
| `no keychain item is left without a record` | invariant | `WalletLifecycle.NoOrphanItem` | every keychain item of the home that derives its wallet's address has a record (an item of another key is kept and listed as an orphan: `WalletLifecycle.ForeignKeyKept`); listed in the signer child by `findCredentials(<the scenario's service>)`, accounts only, and a listing that throws (Linux, locked) fails the check (gaps §H) |
| `the key is revealed only on the host` | invariant | `WalletLifecycle.RevealOnlyOnHost` | no reveal answered to a paired device or a bare token |
| `a ready wallet always has its key` | invariant | `WalletLifecycle.ReadyOnlyWithKey` | a ready record's item reads back and derives |
| `a reveal capability is used once` | invariant | `WalletLifecycle.RevealOnce` | the capability is consumed in the reveal's commit |
| `an observation is settled at most once` | invariant | `X402.AtMostOncePerObs` | one `AuthorizationUsed` per observation |
| `what the chat is told about the x402 payment matches the chain` | invariant | `X402.ReportedIsTrue` | Settled, Cancelled and Expired only at finality |
| `only observed terms are signed` | invariant | `X402.SignedOnlyObserved` | the signed message's payTo, value, asset and network equal the observation's |
| `live authorizations never exceed the balance` | invariant | `X402.WithinBalance` | the sum of live authorizations ≤ the USDC balance |
| `every authorization rests on Always or the owner's approval` | invariant | `X402.AuthorizeBasis` | the authorization commit read Always or an approval |
| `only the observing chat pays its observation` | invariant | `X402.PaidByObservingChat` | the authorization's chat equals the observation's |
