# Hazards: the product lifecycle of agent wallets

Analysis for the RFC in [docs/wallets.md](../../wallets.md), through the product-lifecycle lens: every owner journey in
Settings → Wallets and every agent journey, with their best cases, errors, edge cases and races. Dated 2026-11-23.
Nothing here is a design rule (principle 6); each mechanism named as a mitigation still needs its spike or its test.

129 cases: 13 critical, 56 high, 40 medium, 20 low; by kind 19 best, 12 race, 13 error, 64 edge, 21 security.

## Method

- Inputs: the owner's seven requirements and the RFC (docs/wallets.md); DESIGN.md (Trust, Messages: drafts and
  permissions, Connections: accounts and switches, Routines, Clients, Home); the research reports in
  [../research/](../research/) (signing-libraries, os-keychain, x402, chain-operations, wallet-security) and the anvil spike
  under research/spikes/chain-operations/.
- One extra fact was read for this analysis: the typings and README of `@napi-rs/keyring` 2.1.2 as installed by the
  keychain spike (package README, https://github.com/Brooooooklyn/keyring-node, read 2026-11-23). It shows (a) an
  `AsyncEntry` class whose calls take an `AbortSignal`, (b) `findCredentialsAsync(service)`, and (c) that on Linux the
  binding **silently falls back to the in-memory kernel keyutils keyring** when no Secret Service is present unless an
  entry is built with `{ linux: { store: 'secret-service' } }`. (c) is PRO-004.
- Each case names its trigger, the behaviour the system must show, the mechanism that gives it (an existing banda
  mechanism where one fits: store commits, account switches, drafts and Waits, idempotent effects, proxy observations)
  and a severity.

**Severity.** critical: funds lost beyond what the owner meant to risk, the key disclosed, or funds made unrecoverable.
high: a payment the owner did not expect within the bound, funds stuck, a law of DESIGN.md "Trust" weakened, or the
feature unusable on a supported platform. medium: a confusing or wrong state the owner can recover from. low: polish.

## Rules that keep the cases from conflicting

Several cases touch the same moment (a draft approved while a rule changes, two payments from one wallet). These
rules fix one order, so each case has one outcome whatever the timing. They are proposals for the
scenario and state-machine work that follows.

- **R1. One admission commit, one order of checks.** Every agent payment starts in one commit that checks, in this
  order, and stops at the first failure: (1) the wallet exists and is not archived; (2) the agent is active and the
  wallet is switched on for it; (3) the tool is on; (4) arguments are well formed (token, network, amount, address or
  observation); (5) the recipient's canonical identity; (6) its rule, Deny before anything else, then Always, then
  Ask or the wallet's default; (7) the amount plus fee bound fits the available balance (R4); (8) the open-drafts limit.
  An Ask opens its draft only after (7) and (8) pass; approval re-runs (1) to (7) in the commit that starts it.
  Whether the keychain answers is checked by the lane when it signs (PRO-098), never by holding the key earlier.
- **R2. The owner's taps carry the version they saw.** A rule change, a Pay, an Always or a Deny names the recipient
  doc's version on screen; a stale tap changes nothing and redraws the card (DESIGN.md: a stale view changes nothing).
- **R3. One lane per wallet and chain.** Payments from one wallet on one chain, the owner's and every agent's, are
  signed one after another. A nonce is taken only in the lane, when signing, after approval, and only once the previous
  transaction was accepted by the pool or ended; a waiting or declined draft holds no nonce, so no gap can form (PRO-064). Before each
  signature the lane takes the larger of its ledger and the chain's latest nonce (PRO-037).
- **R4. Available = balance read − reservations.** A reservation is the amount plus the fee bound
  (gasLimit × maxFee + L1 fee bound + operator fee bound) of every admitted payment that is not final, and the amount of
  every x402 authorization not yet settled or expired. Admission compares against available, in the same commit.
- **R5. Rule precedence.** Deny > Always > Ask > wallet default (Ask or Deny, never Always). An owner's own send is not
  an agent's effect and no rule applies to it.
- **R6. Granting answers what it covers, visibly.** An Always (or a Deny) set in a commit answers (or refuses) the open
  drafts to that recipient in the same commit, as permissions do today; the button says so first when others wait
  (PRO-050).
- **R7. Monotone payment states.** Created → Admitted → Signed → Broadcast → Included → Safe, with Failed, Not sent,
  Replaced and Dropped as ends. The only step back is Included → Broadcast on a reorg; nothing leaves Safe or an end.
  A replacement is a step inside one payment, never a second payment.

## Decisions the cases surface

| # | Question | Recommendation | Cases |
|---|---|---|---|
| D1 | Requirement 6 lets agents share a wallet; the RFC assumed one wallet per agent. Whose are the rules? | The wallet's: one recipient list per wallet, the Always button names every agent that uses it | PRO-043, PRO-082 |
| D2 | Should Always answer other waiting payments to the same recipient? | Yes (existing law), but the button lists them first and offers Pay this one | PRO-050 |
| D3 | Export only at creation, or later too; from a phone? | Later too, only on the computer banda runs on, each reveal confirmed and logged as a fact | PRO-006, PRO-010, PRO-011 |
| D4 | How is "saved" confirmed? | Type the key's last 4 characters | PRO-013 |
| D5 | QR payload | Plain checksummed address until a spike shows EIP-681 with chain id reads right in common wallets | PRO-019 |
| D6 | x402 identity granularity | Exact origin and path; the card may offer a prefix, worded as its consequence | PRO-054 |
| D7 | Does wallet__history show what the wallet received? | Yes, from the same activity facts | PRO-057 |
| D8 | An Ask over the balance: draft or refuse? | Refuse at the call with the available amount | PRO-075 |
| D9 | Networks per wallet | One network per wallet, fixed at creation; testnet wallets marked everywhere | PRO-080 |
| D10 | An x402 Ask answered late | Sign at approval with fresh validity if the observation is under a day old | PRO-089 |
| D11 | A routine's payment nobody answers | Deadline of 24 h, then Not paid: no answer | PRO-097 |
| D12 | Same-user code can read keys on Linux and Windows (host mode, harnesses) | No signing in host mode; say it plainly where a harness is enabled on those platforms | PRO-103 |

## Cases

### Creating a wallet

**PRO-001 · Owner creates a wallet in Settings → Wallets** (best, high)

- Trigger: Owner taps Create wallet, gives it a name (Travel) and the network (Base).
- Expected: The daemon draws a random secp256k1 key in memory, writes it to the OS keychain under the wallet's keychain reference, commits the wallet record (name, network, address, reference, never the key) and shows the address and the Save your key step. The wallet is on for no agent.
- Mitigation: Two commits around the keychain write (record creating, then ready; see PRO-002). Nothing is on by default, as for every account (DESIGN.md Connections). Key generation from @noble/curves 2.4.0 (research/signing-libraries.md).

**PRO-002 · Daemon killed in the middle of creating a wallet** (race, high)

- Trigger: SIGKILL after the creating record is committed and before or after the keychain write, or after the write and before the ready commit.
- Expected: At the next start a creating record is reconciled: its keychain item present means ready; absent means the record is dropped. The address is never shown, copied or put in a QR before ready, so no funds can reach a key that was lost with the process.
- Mitigation: Record state creating → ready; address hidden until ready; fault points before and after the keychain set in test/fault/ (principle 10).

**PRO-003 · Keychain refuses the write at creation** (error, high)

- Trigger: Keychain locked, access denied, or no Secret Service on the session.
- Expected: Creation stops with who, what and the fix (This computer's keychain is locked · Unlock it and try again). No record, no file, no retry loop.
- Mitigation: Fail closed: no file fallback (RFC Architecture; research/os-keychain.md, the gh and Electron plaintext fallbacks are the failure to avoid).

**PRO-005 · Create tapped twice, or on two devices** (race, low)

- Trigger: Double tap on Create, or the phone and the desktop both submit.
- Expected: One wallet per deliberate submit: a double tap makes one; two devices make two, both listed.
- Mitigation: Owner command carries a client-generated idempotency key stored with the record.

**PRO-006 · Wallet created from a paired phone, where the key cannot be shown** (edge, medium)

- Trigger: Owner creates a wallet in the app on the phone (an Iroh device).
- Expected: The wallet is made; the Save your key step says it is done on the computer banda runs on, and the wallet carries a Not backed up mark until then.
- Mitigation: Export route answers only loopback callers with the owner's token (PRO-011). Decision D3.

### Exporting the private key

**PRO-007 · Owner reveals, copies and confirms the private key at creation** (best, high)

- Trigger: After creation the owner taps Reveal, copies the 0x-prefixed 64-hex key, then confirms it is saved.
- Expected: The key shows only after Reveal, in Geist Mono, with Copy; the confirmation stores the fact that it was saved, never the key. Skip leaves a Not backed up mark on the wallet and its Receive sheet.
- Mitigation: A plain request handler outside any durable task, response Cache-Control: no-store, never an entry, doc, Wait answer or SSE event (see PRO-008).

**PRO-008 · Key bytes reach the store, a backup or a fork** (security, critical)

- Trigger: Creation or export is implemented as a pi-durable task, a Wait, a memoized step or an SSE event, so the key lands in durable.db, which backups and home:fork copy.
- Expected: The key exists only in the keychain and, for the time of a signature or an export, in daemon memory.
- Mitigation: Creation, export and signing read the key outside tasks; checkpoints hold only the signed transaction. Property test after create, export, sign and restart: durable.db, blobs/, search.db, logs and config contain no form of the key (hex, 0x-hex, base64, raw bytes).

**PRO-009 · Key bytes in a log line or an error** (security, critical)

- Trigger: A keychain or signing exception carries the secret, or a request body is logged on error.
- Expected: Errors say what failed in fixed words; no secret, ever.
- Mitigation: KeyStore wrapper catches and rethrows with fixed messages; the export and creation routes are excluded from body logging; the PRO-008 scan covers the log.

**PRO-010 · Owner skipped the export and later needs the key** (edge, high)

- Trigger: Owner skipped Save your key, or lost the copy, and wants it later (moving machine, importing in another wallet).
- Expected: Decision D3: wallet details on the computer banda runs on offer Show private key behind a confirmation in its own verb; each reveal is said in the wallet's activity.
- Mitigation: Same route and rules as PRO-007; requirement 5 asks at creation, the research suggests once only (research/wallet-security.md 2); a later export keeps the Not backed up mark honest.

**PRO-011 · Key requested from a paired device** (security, high)

- Trigger: The phone app (Iroh) or a browser device calls the export route.
- Expected: Refused: Only on the computer banda runs on. The key never crosses a relay nor lands in a browser device whose own key is unsealed (DESIGN.md Clients).
- Mitigation: Route checks the caller is the loopback client, not an Iroh endpoint, as the backups page is shown only there (DESIGN.md Home).

**PRO-012 · Copied key stays on the clipboard or a screenshot** (edge, medium)

- Trigger: Clipboard managers sync, screen sharing or a screenshot during Reveal.
- Expected: Reveal is hidden by default; Copy says the clipboard is cleared after a minute while the page is open, only if it still holds the key, and that banda cannot promise more.
- Mitigation: Best-effort clear; claim needs a browser spike (research/wallet-security.md open question 2).

**PRO-013 · Owner confirms saved without saving** (edge, medium)

- Trigger: Owner taps I saved it without having stored the key.
- Expected: Decision D4: confirmation asks for the key's last 4 characters; a wrong answer keeps the Not backed up mark.
- Mitigation: Cheap check, no secret stored; the mark is derived from the confirmation fact.

**PRO-014 · Owner expects a recovery phrase** (edge, low)

- Trigger: Owner looks for 12 or 24 words.
- Expected: Export says Private key and how other wallets import it (Import account → Private key). No phrase: one independent key per wallet.
- Mitigation: Independent keys limit blast radius (research/wallet-security.md 1); BIP-39 stays out unless decided otherwise.

### Several wallets, names, empty states

**PRO-015 · Several wallets listed in Settings → Wallets** (best, low)

- Trigger: Owner opens Settings → Wallets with three wallets.
- Expected: One row per wallet: name, short address (full on tap), balance per token with as of when stale, Not backed up mark, agents that use it; Archived wallets apart.
- Mitigation: Rows derived from the wallet records and the latest balance readings; nothing counts or nags.

**PRO-016 · No wallets yet, or no keychain** (edge, low)

- Trigger: First visit, or a host without a usable keychain.
- Expected: One line on what a wallet is for and Create; with no keychain Create is unavailable and the line says why and what makes it work.
- Mitigation: KeyStore probe at start (AsyncEntry with a short AbortSignal timeout).

**PRO-017 · Wallet renamed, names collide or carry control characters** (edge, low)

- Trigger: Two wallets named Travel, or a name with bidi overrides or newlines.
- Expected: A name is one plain line (no control or bidi characters); a duplicate is allowed with a warning; tools and cards always add the short address.
- Mitigation: Same plain-line rule as artifact titles (DESIGN.md The app); the wallet's id is its address, never its name.

### Receive

**PRO-018 · Owner receives funds** (best, medium)

- Trigger: Owner opens Receive.
- Expected: Full checksummed address in groups of four, QR, Copy, the network in words (on Base) and what to send (ETH or USDC on Base only).
- Mitigation: EIP-55 display; network badge on the sheet and the QR caption.

**PRO-019 · QR payload misread by the sender's wallet** (edge, medium)

- Trigger: QR encodes an EIP-681 URI (ethereum:0x…@8453) that some wallets or exchanges misparse, or a plain address that carries no chain.
- Expected: Decision D5: plain checksummed address in the QR, the network said in words, until a spike shows which common wallets read EIP-681 with a chain id correctly.
- Mitigation: Micro-spike scanning with three common wallets on Base Sepolia.

**PRO-020 · Funds sent on another EVM chain to the same address** (edge, medium)

- Trigger: Someone sends USDC on Ethereum or Arbitrum to the wallet's address.
- Expected: banda does not see them; they are reachable only with the key in another wallet. Receive's help says so; the key export is the way back.
- Mitigation: Network in words on Receive and every card; export available (PRO-010).

**PRO-021 · Spam tokens or a fake USDC show in the balance** (security, medium)

- Trigger: Airdropped tokens whose symbol reads USDC, or NFTs.
- Expected: Balance counts only the pinned contracts (Base USDC 0x833589fC…02913, Base Sepolia 0x036CbD53…CF7e); other tokens are not listed, and no symbol is read from a token contract.
- Mitigation: Per-chain token table pinned in code (research/x402.md, on-chain read 2026-11-23).

### The owner's Send

**PRO-022 · Owner sends from a wallet** (best, high)

- Trigger: Owner opens Send, picks token, amount and recipient (a known one or pasted), confirms.
- Expected: Confirm card with full address, network, amount, fee including the L1 fee, balance after; the payment joins the wallet's lane, row goes Pending → Sent → Confirmed. No recipient rule applies: it is the owner's own act.
- Mitigation: Owner authority (DESIGN.md Trust, law 1); one lane per wallet and chain shared with agents (rule R3).

**PRO-023 · Owner sends to a recipient agents may never pay** (edge, low)

- Trigger: Recipient's rule is Deny; the owner sends to it.
- Expected: Allowed, with a line: Agents never pay Ana. The rule stays Deny.
- Mitigation: Rules govern agents' effects only.

**PRO-024 · Owner's own send does not grant agents anything** (edge, medium)

- Trigger: Owner sends to a new address.
- Expected: The address joins the recipients as known with the wallet's default (Ask); never Always.
- Mitigation: Only an explicit Always answer or a change in the Recipients list sets Always.

**PRO-025 · Invalid recipient typed or pasted** (error, medium)

- Trigger: Mixed case with a wrong checksum, wrong length, an ENS name, a non-EVM address.
- Expected: Refused in words before the confirm card; all-lowercase accepted and shown checksummed; names never resolve.
- Mitigation: EIP-55 validation; a label or name never resolves to an address (RFC Recipients).

**PRO-026 · Send to a burn address, the token's own contract or itself** (security, high)

- Trigger: Recipient is 0x0…0, the USDC contract, or the wallet's own address; or a contract address.
- Expected: Zero address, token contract and self are refused in words; a recipient with code (eth_getCode non-empty) is marked This is a contract on the card.
- Mitigation: Static refusal list per chain plus a code read at confirm time.

**PRO-027 · Amount typed in another locale or with too many decimals** (edge, high)

- Trigger: 1,5 versus 1.5, 1,000 meaning one thousand or one, 0.1234567 USDC (6 decimals).
- Expected: One decimal format shown explicitly in the field; extra decimals refused; the confirm card repeats the amount and its value as of then, so a ×1000 slip is visible before Send.
- Mitigation: Parser over decimal strings into atomic units (bigint), never floats.

**PRO-028 · Max sends more than can leave** (edge, medium)

- Trigger: Owner taps Max for ETH, or for USDC with no ETH.
- Expected: ETH Max leaves gasLimit × maxFee + L1 fee bound + operator fee bound and what is reserved by payments on their way; USDC Max needs ETH for gas and says so.
- Mitigation: Fee budget from research/chain-operations.md F2 (totalFee = operatorFee + gasUsed × (baseFee + priorityFee) + l1Fee).

**PRO-029 · Owner's send submitted twice** (race, high)

- Trigger: Double tap, or a retry on a second device after a slow first answer.
- Expected: One transaction per form submit; a deliberate second send is a second payment, and its confirm card lists the sends to the same address in the last hour.
- Mitigation: Idempotency key per Send form stored with the effect.

**PRO-030 · Owner and agent spend from one wallet at the same moment** (race, high)

- Trigger: Owner confirms a send while an agent's Always payment starts on the same wallet and chain.
- Expected: Both are serialized in the wallet's lane with consecutive nonces; the one that no longer fits the available balance is refused in words, not broadcast.
- Mitigation: Rules R3 (one lane) and R4 (reservations) in the admission commit.

**PRO-031 · Send rejected before reaching the pool** (error, medium)

- Trigger: insufficient funds for gas * price + value, max fee per gas less than block base fee, intrinsic gas too low.
- Expected: Row says Not sent and why; no fee spent; the lane releases the nonce because nothing after it was signed.
- Mitigation: Message table matched on text, not code (research/chain-operations.md F3: geth -32000, anvil -32003).

### The transaction list

**PRO-032 · Transaction list with every state** (best, medium)

- Trigger: Owner opens a wallet's Activity.
- Expected: Rows: Waiting on you, Pending, Sent (included), Confirmed (safe, about 2 min), Failed (reverted, fee spent), Not sent, Replaced, Dropped, Received; each says who (you, Mara, Mara's routine), the recipient's name and address, amount, fee, time.
- Mitigation: States derived from one payment state machine in the store (Created → Admitted → Signed → Broadcast → Included → Safe | Failed | Replaced | Dropped); finality figures from docs.base.org transaction-finality via research/chain-operations.md F1.

**PRO-033 · Incoming USDC cannot be listed without a history API** (edge, high)

- Trigger: Base mainnet has no keyless history API; mainnet.base.org answered every eth_getLogs probe with 429; Sepolia caps eth_getLogs at 200 blocks.
- Expected: Received rows come from Transfer logs in 200-block chunks since the wallet's creation block, or from a keyed provider the owner named; until found, a balance change shows as Received (details later).
- Mitigation: research/chain-operations.md F6 and F7; history starts at the creation block (a fresh key has no earlier history).

**PRO-034 · ETH received from a contract leaves no log** (edge, medium)

- Trigger: A refund or router sends ETH through an internal call.
- Expected: A balance-delta row: Received 0.01 ETH (sender unknown); never a silent balance change.
- Mitigation: Balance checkpoints reconciled against known payments (research/chain-operations.md F7).

**PRO-035 · Address-poisoning rows in the history** (security, high)

- Trigger: Zero-value transfers or dust from addresses that share the first and last characters with a recipient the wallet paid.
- Expected: Zero-value and unlisted-token transfers are not listed; a Received row from a never-paid sender offers no Send to this address; Send warns when a pasted address looks like a known recipient but differs.
- Mitigation: USENIX Security 2025 (Tsuchiya et al.): 3 of 53 wallets warned on look-alikes; CMU CyLab 2026-01-07 (both via research/wallet-security.md 3).

**PRO-036 · Daemon off for days, then catch-up** (edge, medium)

- Trigger: Machine asleep for a week: about 432,000 Base blocks per day.
- Expected: Balance is shown at once from a direct read; history catches up in the background with a line saying so; nothing reads as zero while unknown.
- Mitigation: Balance read independent of history; backoff with Retry-After.

**PRO-037 · Spend made outside banda with the exported key** (edge, high)

- Trigger: Owner imports the key into another wallet and sends from there.
- Expected: Before the next signature the lane reads the account's latest nonce and takes the larger of it and its own; the balance drop shows as Sent from outside banda when found in logs, else a balance-delta row.
- Mitigation: Ledger resync before every sign; pending tag is unreliable on Base after Denim (research/chain-operations.md F1, F5).

**PRO-038 · Included transaction reorged out** (edge, low)

- Trigger: Rare L2 reorg after inclusion (under 0.00000002% on Base mainnet).
- Expected: Row returns from Sent to Pending; Confirmed is said only at safe and never goes back.
- Mitigation: State machine allows Included → Broadcast only, never Safe → anything.

**PRO-039 · USDC transfer reverts** (error, medium)

- Trigger: Recipient or wallet blacklisted by the issuer, or token paused.
- Expected: Failed, with the fee spent, said in words; the agent is told; no automatic retry.
- Mitigation: Receipt status 0 maps to Failed; reservation released.

**PRO-040 · Renamed recipient in old rows; long histories** (edge, low)

- Trigger: Recipient renamed after many payments; thousands of rows.
- Expected: Rows draw the current name beside the address that was paid; paged backwards; banda's own payments always readable offline from the store.
- Mitigation: Names drawn live, identity stored on the payment (RFC Recipients).

### Which agent may use which wallet

**PRO-041 · Owner switches a wallet on for an agent** (best, high)

- Trigger: From the wallet's Agents list or the agent's Access tab.
- Expected: The agent gets wallet__address, wallet__balance, wallet__history, wallet__recipients and the write tools; writes go through recipient rules.
- Mitigation: Account switch per agent (DESIGN.md Connections, Accounts); checked in each call's start commit.

**PRO-042 · Wallet switched off while a payment is in progress** (race, high)

- Trigger: Owner turns Mara's wallet off while a draft waits, or after signing.
- Expected: A waiting draft is refused when it would start; a payment already signed or broadcast completes (it cannot be called back) and its card says it was already on its way.
- Mitigation: Access checked in the commit that starts the effect (DESIGN.md Switches and settings); signed bytes are an effect already started.

**PRO-043 · Two agents share one wallet: whose rules?** (edge, high)

- Trigger: Mara and Sancho both have Travel on; Mara's ask set Always for Ana.
- Expected: Decision D1: the recipient list belongs to the wallet, so Sancho pays Ana too; the Always button says it (Always pay Ana from Travel, for every agent that uses it).
- Mitigation: One recipients doc per wallet, checked in the admission commit; RFC's one wallet per agent assumption conflicts with requirement 6.

**PRO-044 · Agent archived with a waiting payment** (edge, low)

- Trigger: Owner archives Mara while her payment draft waits.
- Expected: Draft refused; the wallet and its other agents unaffected.
- Mitigation: Active-agent check in the start commit.

**PRO-045 · Agent needs to pay but has no wallet** (edge, low)

- Trigger: Agent wants to pay and no wallet is on for it.
- Expected: Agent offers the connect card (Give Mara a wallet?) listing existing wallets or Create; no write tool exists until then.
- Mitigation: Existing connect card and on-demand tools (DESIGN.md Messages).

### Recipients: names, rules, forgetting

**PRO-046 · Owner renames a recipient** (best, medium)

- Trigger: Recipients list → Ana → Rename to Ana Silva.
- Expected: Every card, row and wallet__recipients answer says the new name; the rule still binds the same chain and address.
- Mitigation: Label never identity (requirement 4, RFC Recipients).

**PRO-047 · Agent proposes the name of a new recipient** (security, high)

- Trigger: An injected agent asks to pay 0xEvil and suggests it be called Ana (your sister).
- Expected: The name field on the first-payment card is empty (x402: the observed host as placeholder); the agent's reason is shown quoted as its words.
- Mitigation: Daemon draws the card (DESIGN.md drafts); names come only from the owner.

**PRO-048 · Confusable or duplicate recipient names** (edge, medium)

- Trigger: Two recipients named Ana, a Cyrillic а, an RTL override.
- Expected: Names are one plain line without control or bidi characters; a duplicate is warned; the full address is always beside the name.
- Mitigation: Plain-line rule; identity shown, never replaced, by the label.

**PRO-049 · Owner changes a rule in the Recipients list** (best, high)

- Trigger: Ask → Always, Always → Deny, Deny → Ask.
- Expected: The change names the version the owner saw; Deny refuses open drafts to that recipient in the same commit; Always answers them (rule R6).
- Mitigation: Stale views change nothing (DESIGN.md Switches and settings); nothing is asked twice (DESIGN.md Permissions).

**PRO-050 · Always on one card pays other waiting payments to the same recipient** (race, high)

- Trigger: Two drafts wait for Ana, 5 USDC and 500 USDC; owner taps Always pay Ana on the 5 USDC one.
- Expected: Decision D2: the Always button first says it also pays the other waiting payment (500 USDC) and offers Pay this one instead; nothing is paid that the owner did not see.
- Mitigation: Existing law answers covered asks in the granting commit; the wording makes that consequence visible (DESIGN.md Trust, permissions worded as their consequence).

**PRO-051 · Owner forgets a recipient** (edge, low)

- Trigger: Recipients list → Forget, possibly while a payment to it is on its way.
- Expected: Rule and name removed; the next payment asks as for an unknown recipient; rows keep the address; an in-flight payment is unaffected.
- Mitigation: Forget asks first in its own verb (DESIGN.md destructive actions).

**PRO-052 · Wallet default for unknown recipients is Deny** (edge, medium)

- Trigger: Owner set Only pay recipients I set up; the agent tries a new address.
- Expected: Refused in words with no ask; a quiet line in the agent's chat lets the owner add the recipient.
- Mitigation: Default Ask or Deny, never Always (RFC Recipients).

**PRO-053 · One recipient written several ways** (edge, high)

- Trigger: Checksum versus lowercase; the same address on Base and Base Sepolia; https://API.Weather.dev:443/v1/forecast/ versus https://api.weather.dev/v1/forecast?city=x.
- Expected: Addresses compare as lowercase hex per chain (two chains, two recipients); endpoints as scheme, lowercase host, port only if non-default, path normalized (percent-decoding of unreserved, no trailing slash), query dropped.
- Mitigation: One canonical identity function with property tests (same identity for equivalent inputs, different for any differing host, path or chain).

**PRO-054 · x402 endpoint with per-resource paths asks every time** (edge, medium)

- Trigger: /v1/forecast/lisbon then /v1/forecast/paris.
- Expected: Decision D6: exact path is the identity; the card may offer Always pay api.weather.dev/v1/forecast/* when paths share a prefix, worded as its consequence.
- Mitigation: Conservative default; widening is an explicit owner choice.

### Agent reads

**PRO-055 · Agent reads balance, address, recipients and history** (best, medium)

- Trigger: Agent calls wallet__balance and wallet__recipients before paying.
- Expected: Per chain: ETH and USDC, available after reservations, as of block and time; recipients with names and rules; its payments with their state.
- Mitigation: Reads framed as data; balances from one reading cache with its time.

**PRO-056 · Balance unknown is reported as zero** (error, high)

- Trigger: RPC down or 429.
- Expected: wallet__balance says unavailable, last read 10:42: 12.40 USDC; the UI says the same; never 0.
- Mitigation: Reading has a state (fresh, stale, unknown); research/chain-operations.md F6 (public RPC best effort, 429 with -32011).

**PRO-057 · Agent cannot see payments it received** (edge, low)

- Trigger: Agent asks whether a client paid it.
- Expected: Decision D7: wallet__history includes Received rows from the wallet's activity, framed as data.
- Mitigation: Same facts as the owner's list.

### Agent pays: Always, Ask, Deny, unknown

**PRO-058 · Agent pays a recipient set to Always** (best, high)

- Trigger: wallet__send(to, amount, token).
- Expected: Admission commit (rule R1 order) passes; the lane signs, checkpoints the raw transaction, broadcasts, and the tool returns at inclusion with the hash; a card in the chat says what was paid even though nobody was asked.
- Mitigation: RFC Paying exactly once; idempotent effect with stored bytes (DESIGN.md Interrupted effects).

**PRO-059 · Agent pays a known recipient set to Ask** (best, high)

- Trigger: wallet__send to Ana, rule Ask.
- Expected: Draft card: amount, token, value as of then, recipient name and full address, wallet and balance after, the agent's reason quoted; Pay, Always pay Ana (up to what's in the wallet), Don't pay, Never pay Ana; nothing editable. Approved, admission is checked again in the start commit.
- Mitigation: Draft and approval Wait (DESIGN.md Messages); an order for a machine runs as stored or not at all.

**PRO-060 · First payment to an unknown recipient** (best, high)

- Trigger: wallet__send to an address the wallet never saw.
- Expected: Same card marked New recipient · never paid, with a name field; the answer sets the rule in the same commit.
- Mitigation: Requirement 3; unknown defaults to Ask.

**PRO-061 · Agent pays a recipient set to Deny** (best, high)

- Trigger: wallet__send to a Deny recipient.
- Expected: Refused in the call's first commit, before any draft: The owner doesn't pay 0x9f…04. No ask, no notification.
- Mitigation: Deny checked first among rules (rule R5).

**PRO-062 · Rule changed while the draft waits, then the owner taps Pay** (race, high)

- Trigger: Owner set Ana to Never pay in the Recipients list, then taps Pay on an old card.
- Expected: The tap names the rule version the card showed; the newer Deny wins, the card redraws as refused. Deny set after Pay committed does not stop that payment.
- Mitigation: Rule R6: owner actions carry the version seen; RFC: a Deny set meanwhile refuses it.

**PRO-063 · Same draft approved on two devices** (race, medium)

- Trigger: Owner taps Pay on the phone and on the desktop.
- Expected: The Wait is filled once; the other says Already paid.
- Mitigation: Existing Wait semantics.

**PRO-064 · Nonce taken when the draft opens leaves a gap** (race, critical)

- Trigger: If the nonce is allocated in the commit that opens an Ask draft (the RFC's step 1 reads that way), a draft that waits overnight or is declined leaves a hole; every later payment from that wallet and chain waits behind it in the pool (anvil 1.9.0 queued nonce 3 with latest 0).
- Expected: A nonce is assigned only in the lane at signing, after approval; a waiting or declined draft holds no nonce.
- Mitigation: Rule R3; spike evidence research/chain-operations.md F3; fault test: decline a draft, then an Always payment must land.

**PRO-065 · Concurrent payments each fit the balance, together they do not** (race, critical)

- Trigger: Parallel tool calls, two agents on one wallet, or an agent and the owner.
- Expected: The second is refused at admission in words; nothing is signed that cannot be paid.
- Mitigation: Rule R4: available = balance read − reservations (amount + fee bound of every admitted, not final payment and every live x402 authorization), computed in the admission commit.

**PRO-066 · Crash between signing, broadcast and receipt** (race, critical)

- Trigger: SIGKILL after the checkpoint and before broadcast, or after broadcast and before the receipt.
- Expected: At restart the stored bytes are sent again; already known or transaction already imported with the same hash counts as sent; never a second transaction.
- Mitigation: RFC fault points; idempotent effect; messages matched as in research/chain-operations.md F3.

**PRO-067 · Broadcast times out with no answer** (error, high)

- Trigger: RPC timeout after eth_sendRawTransaction.
- Expected: Maybe sent: poll by hash, resend the same bytes; never sign another transaction at a new nonce while the first could still land.
- Mitigation: viem docs: a failed send does not prove the nonce unused (research/chain-operations.md F5).

**PRO-068 · Transaction stuck under a rising base fee** (edge, high)

- Trigger: maxFeePerGas below the base fee for longer than the lane's patience.
- Expected: A replacement is an explicit step of the same payment: same nonce, recipient, value and data, both fees up by at least 12.5%; row Replaced, then Sent; the agent never calls again.
- Mitigation: geth PriceBump 10; anvil accepted +1% so it is no oracle (research/chain-operations.md F4); bump count bounded.

**PRO-069 · nonce too low and our transaction is not mined** (edge, high)

- Trigger: The nonce was consumed by a spend outside banda (PRO-037).
- Expected: The old bytes can never land: row Not sent; a new signature at a fresh nonce only as an explicit step after the admission checks pass again, else the payment fails and the agent is told.
- Mitigation: Lane resync rule; research/chain-operations.md Recommendations 3.

**PRO-070 · Agent confuses units** (edge, high)

- Trigger: Agent passes 1000000 meaning one USDC in atomic units.
- Expected: The tool takes a decimal string in token units and says so in its description; 1000000 USDC is refused as over the available balance; under Always a smaller slip pays as asked and draws its card.
- Mitigation: Balance is the only cap (requirement 2): residual risk accepted and worded on the Always button.

**PRO-071 · Malformed amount** (error, medium)

- Trigger: Negative, zero, NaN, 1e3, more decimals than the token.
- Expected: Refused in words before admission.
- Mitigation: Schema plus decimal parser shared with the owner's Send.

**PRO-072 · Owner says yes in words instead of tapping the card** (edge, medium)

- Trigger: Owner writes yes pay her in the chat.
- Expected: Not an approval; the card still waits and the agent reads the words as data.
- Mitigation: An ask is answered by a control, never by typing (DESIGN.md The app).

**PRO-073 · Agent floods the owner with payment drafts** (edge, medium)

- Trigger: A loop opens dozens of Ask drafts.
- Expected: Past a small limit of open payment drafts per wallet, further calls are refused: 5 payments already wait for you.
- Mitigation: Same idea as the proxy's limit of open asks (DESIGN.md The box).

**PRO-074 · Agent pays itself or another banda wallet** (edge, low)

- Trigger: to is the wallet's own address, or another wallet of the home.
- Expected: Self refused; another wallet is a recipient like any, drawn as your wallet Savings, Ask by default.
- Mitigation: Known-address table of the home's wallets.

### Funds, gas, tokens and networks

**PRO-075 · Not enough of the token** (error, medium)

- Trigger: amount above available USDC.
- Expected: Decision D8: refused at the call with the available amount, no draft; the agent can ask the owner to top up.
- Mitigation: Admission check R1 step 7.

**PRO-076 · USDC but no ETH for gas** (error, medium)

- Trigger: Wallet holds 20 USDC and 0 ETH; wallet__send of USDC.
- Expected: Refused: Travel needs a little ETH on Base for fees; x402 still works (gasless for the payer).
- Mitigation: Fee budget check in admission (research/x402.md: the facilitator pays gas).

**PRO-077 · Fee budget forgets the L1 and operator fees** (edge, high)

- Trigger: Balance check uses eth_estimateGas × maxFee only.
- Expected: Reservation uses gasLimit × maxFee + getL1FeeUpperBound + operator fee bound, so a payment admitted is a payment the pool accepts.
- Mitigation: GasPriceOracle 0x4200…000F (research/chain-operations.md F2).

**PRO-078 · Balance drops between approval and signing** (race, medium)

- Trigger: Owner withdrew, or another payment landed, after the owner tapped Pay.
- Expected: Start commit and the lane re-check; the payment ends Couldn't pay: balance, said on the card.
- Mitigation: Checks at start commit and immediately before signing.

**PRO-079 · Unsupported token or network asked for** (edge, low)

- Trigger: DAI, Ethereum mainnet, a Solana or Bitcoin address.
- Expected: Refused, listing what the wallet supports.
- Mitigation: Token and chain enums in the tool schema.

**PRO-080 · Testnet and mainnet funds confused** (edge, medium)

- Trigger: Owner has a Base Sepolia test wallet and a Base wallet.
- Expected: Decision D9: the network is fixed per wallet at creation; a testnet wallet carries a Testnet mark on every row, card and QR caption; no tool switches a wallet's network.
- Mitigation: Network in the wallet record and in the recipient identity.

### An agent with two wallets

**PRO-081 · Agent with two wallets picks one** (best, medium)

- Trigger: Mara has Travel and Research.
- Expected: Each wallet tool gains a required wallet parameter whose values are the wallets' ids with their names in the description; a call without it is refused.
- Mitigation: Existing rule for several accounts of one connection (DESIGN.md Tools and accounts).

**PRO-082 · Agent names a wallet by its label or picks the wrong one** (edge, medium)

- Trigger: wallet: Travel, or Research where Travel was meant.
- Expected: Labels never resolve; the card names the wallet and its balance after; each wallet's own recipient rules apply, so a recipient Always on Travel still asks on Research.
- Mitigation: Enum of ids; per-wallet recipients (D1).

**PRO-083 · Wallet added or removed during a conversation** (edge, low)

- Trigger: Owner switches a second wallet on while Mara works.
- Expected: The tool schema changes at the next run boundary; a call naming a wallet now off is refused in words.
- Mitigation: Prompt and tool budgets (test/prompt-budget.test.ts) move only with an intended change.

### x402 from the box

**PRO-084 · Agent pays an x402 endpoint from the box** (best, high)

- Trigger: Box code calls an API that answers 402 with PAYMENT-REQUIRED (v2) or a v1 body.
- Expected: The proxy records an observation (origin and path reached over verified TLS, the requirements as received, time, chat); wallet__pay_x402(observation) resolves the endpoint's rule; the daemon signs an EIP-3009 TransferWithAuthorization with a random 32-byte nonce persisted first and validity of minutes; only the signature enters the box, which retries with PAYMENT-SIGNATURE or X-PAYMENT.
- Mitigation: RFC x402; research/x402.md (v2 2.32.0, v1 1.2.0, exact scheme).

**PRO-085 · Box forges a challenge from an Always endpoint** (security, critical)

- Trigger: Injected code hands the tool a 402 body naming api.weather.dev with its own payTo.
- Expected: The tool takes only an observation id the proxy recorded for this chat; no challenge content ever comes from the agent.
- Mitigation: Proxy observations keyed by the chat's login (DESIGN.md The box: the proxy knows each request's chat).

**PRO-086 · Observation reused or taken from another chat** (security, high)

- Trigger: Same observation paid twice, or one from another agent's chat.
- Expected: An observation is single use and belongs to one chat; a second call returns the first result, another chat's is refused.
- Mitigation: Observation state in the store, consumed in the admission commit.

**PRO-087 · Challenge differs from what the rule trusted** (edge, high)

- Trigger: payTo changed since Always was set; asset not the pinned USDC; network not configured; extra.name or version not the pinned EIP-712 domain.
- Expected: payTo change asks again; wrong asset, network or domain is refused (USD Coin on Base mainnet, USDC on Base Sepolia, version 2).
- Mitigation: Per-chain domain table (research/x402.md, on-chain reads 2026-11-23); payTo pinned on the rule.

**PRO-088 · Always endpoint raises its price** (edge, high)

- Trigger: api.weather.dev asks 50 USDC instead of 0.001.
- Expected: Paid: there is no amount limit (requirement 3); bounded by the balance; the payment draws its card; the owner can set Deny at once.
- Mitigation: Accepted by the owner's model; the Always button says up to what's in the wallet (RFC).

**PRO-089 · Ask answered long after the challenge** (edge, medium)

- Trigger: Owner approves at 09:00 an observation from 02:00.
- Expected: Decision D10: the daemon signs at approval with validAfter and validBefore from then, if the observation is younger than a bound (one day), else Expired, ask Mara to try again.
- Mitigation: Validity bounded by the chain's latest block time, not only the daemon's clock.

**PRO-090 · Settlement fails or stays pending** (error, high)

- Trigger: PAYMENT-RESPONSE success:false, settlement_pending, facilitator down.
- Expected: The signed authorization stays recorded; its state is read from USDC (authorizationState for the nonce), never by signing again; a new attempt needs a new observation and nonce.
- Mitigation: research/x402.md Recommendations 6 and 7.

**PRO-091 · Signature in the box is a bearer instrument** (security, medium)

- Trigger: Box code submits the authorization itself or to another server.
- Expected: It can only pay the observed payTo the observed amount once; its reservation holds until used or expired.
- Mitigation: EIP-3009 single-use nonce and validBefore (eips.ethereum.org/EIPS/eip-3009, via research/x402.md).

**PRO-092 · 402 arrives after a redirect** (edge, high)

- Trigger: An Always endpoint redirects to another host, which answers 402.
- Expected: The observation is the URL that answered 402, so the other host is its own, unknown recipient and asks.
- Mitigation: Observation bound to the final request, as the proxy saw it.

**PRO-093 · No proxy: host mode or computer off** (edge, medium)

- Trigger: serve --box host, or the box offline.
- Expected: wallet__pay_x402 refused: paying an API needs Mara's computer; wallet__send still works.
- Mitigation: Observations exist only through the proxy.

**PRO-094 · Many live authorizations exceed the balance** (edge, high)

- Trigger: Agent opens several x402 payments in parallel.
- Expected: Each live, unsettled authorization counts against available, so their sum never exceeds the balance.
- Mitigation: Rule R4 includes x402 reservations until settled or expired.

### A routine at night meets an Ask

**PRO-095 · Routine at night meets an Ask** (best, high)

- Trigger: Mara's 02:00 routine wants to pay a new endpoint.
- Expected: Draft opens in Mara's chat; desktop local notification and the phone's content-free push; the run waits durably; later due times skip while it waits, said once.
- Mitigation: A routine whose last run still goes skips its turn (DESIGN.md Routines); push without content (src/core/push.ts).

**PRO-096 · Owner answers Always in the morning** (best, medium)

- Trigger: Owner taps Always pay Weather API at 08:30.
- Expected: The payment signs then (PRO-089), the rule is set, and the next night's run pays without asking.
- Mitigation: RFC routine story.

**PRO-097 · Nobody answers the routine's payment** (edge, medium)

- Trigger: Owner away for a week.
- Expected: Decision D11: a payment ask from a routine run has a deadline (24 h); then it resolves Not paid: no answer and the run goes on; the card says it expired.
- Mitigation: Wait with deadline (DESIGN.md Core: Wait ask, deadline).

**PRO-098 · Keychain locked when the routine signs** (error, high)

- Trigger: macOS prompt after an update, or a Linux keyring locked after a reboot with nobody logged in.
- Expected: The payment fails in words (Travel is locked · Unlock the keychain), an error line marks the chat unread, no retry loop, the daemon stays responsive.
- Mitigation: AsyncEntry with an AbortSignal timeout (both exist in @napi-rs/keyring 2.1.2 typings); timeout means locked.

### Archive and delete

**PRO-099 · Owner archives a wallet that holds funds** (best, high)

- Trigger: Wallet → Archive.
- Expected: Off for every agent in one commit; waiting drafts refused; payments on their way finish; key kept; listed under Archived with its balance; restorable.
- Mitigation: Archive asks first, in its own verb, with a way to keep things as they are.

**PRO-100 · Owner deletes a wallet that still holds funds** (security, critical)

- Trigger: Wallet → Delete with a balance or a payment on its way.
- Expected: Refused while any balance or payment remains; otherwise the confirmation says it deletes the key and that funds sent later are lost unless the key was saved; steps: tombstone commit, keychain delete, record removal, resumed after a kill.
- Mitigation: Balance read at safe; fault points around the keychain delete.

**PRO-101 · Funds arrive after archive or delete** (edge, high)

- Trigger: A client pays the old address.
- Expected: Archived: shown, spendable after restore. Deleted: invisible to banda, recoverable only with a saved key; the delete confirmation said so.
- Mitigation: Archived wallets keep their balance reading.

### Keychain

**PRO-004 · Linux silently stores the key in the kernel keyring, lost at reboot** (edge, critical)

- Trigger: A Linux host with no Secret Service (headless, SSH, systemd service). @napi-rs/keyring 2.1.2 falls back by default to the kernel keyutils keyring, which is in memory and does not survive a reboot.
- Expected: banda never puts a wallet key in keyutils. With no Secret Service the wallet cannot be created, and an existing one is offline with the reason.
- Mitigation: Every entry is built with the options bag linux: { store: 'secret-service' }, so the constructor throws instead of falling back (package README of @napi-rs/keyring 2.1.2, read 2026-11-23 from the installed package). A unit test asserts the option on every KeyStore call.

**PRO-102 · The key is gone from the keychain** (error, critical)

- Trigger: Owner deleted it in Keychain Access, keychain reset, or a restore on another machine.
- Expected: Wallet shows Key missing; reads still work, writes refused in words; Restore key accepts a pasted key only if it derives this address; a new key is never made into the same record.
- Mitigation: getPassword returns null on a missing entry, not an error (research/os-keychain.md spike 2).

### Platforms: macOS, Linux desktop, headless Linux, Windows, Docker box, host mode

**PRO-103 · Same-user code reads the key on Linux or Windows** (security, critical)

- Trigger: serve --box host, or a coding agent (harness) running as the owner: an unlocked Secret Service collection or Windows Credential Manager answers any process of the user without a prompt.
- Expected: Decision D12: wallets do not sign in host mode; on Linux and Windows the harness's enable card and Settings → Wallets say any program the owner runs can read wallet keys, and the owner chooses.
- Mitigation: Boundaries are structural (principle 4): what is reachable decides trust; the box never sees the key, host mode and harnesses are outside the box.

**PRO-104 · macOS prompt from another program asking for the key** (security, high)

- Trigger: A harness or host-mode command runs security find-generic-password on banda's item.
- Expected: macOS shows its prompt; the item's label says only banda needs it and to deny any other app.
- Mitigation: Keychain ACL tied to the creating binary (research/os-keychain.md 6).

**PRO-105 · Daemon's Node binary changes** (edge, high)

- Trigger: A desktop update replaces the bundled Node, or the owner alternates the desktop app and banda serve from another Node.
- Expected: Wallet offline with the reason and the fix (allow banda in the prompt); the key is never recreated.
- Mitigation: Signed-bundle ACL spike before design (research/os-keychain.md open question 1).

**PRO-106 · A keychain prompt freezes the daemon** (edge, high)

- Trigger: Synchronous Entry.getPassword waits on a system prompt.
- Expected: Only that payment waits; chats, streams and other agents carry on; after the timeout the wallet is locked.
- Mitigation: AsyncEntry with AbortSignal, never the synchronous Entry, in the daemon.

**PRO-107 · Headless Linux server** (edge, high)

- Trigger: banda runs on a home server reached from the phone.
- Expected: Settings → Wallets says this computer has no keychain banda can use, and what makes one available; nothing is created.
- Mitigation: PRO-004 option; no file fallback.

**PRO-108 · Docker box versus the shipped computer** (edge, low)

- Trigger: serve --box container versus the microVM.
- Expected: Identical: wallet tools are the daemon's, the proxy observes x402 the same way, the box never holds the key.
- Mitigation: Box suites run on both (AGENTS.md).

**PRO-109 · Throwaway homes leave keychain items behind** (edge, medium)

- Trigger: A manual run with BANDA_HOME=$(mktemp -d) on macOS creates real items; the folder is deleted.
- Expected: Tests use an in-memory KeyStore; a sweep lists banda's items whose home is gone and offers to delete those with no balance.
- Mitigation: findCredentialsAsync(service) exists in @napi-rs/keyring 2.1.2; service names carry the home's identity.

### RPC, offline and network states

**PRO-110 · RPC unreachable or rate limited** (error, high)

- Trigger: Offline laptop, 429 with -32011, provider outage.
- Expected: Balances unavailable with their last reading; Send unavailable with the reason; payments keep their state; retries back off on Retry-After.
- Mitigation: src/core/retry-after.ts; never zero for unknown.

**PRO-111 · Malicious or misconfigured RPC** (security, medium)

- Trigger: Owner names a custom RPC that lies or serves another chain.
- Expected: eth_chainId checked when connecting and on each start; transactions signed with EIP-155 chain id; receipts read by hash; the RPC can lie or censor, never redirect funds.
- Mitigation: Signing is local; the RPC is a named choice in Settings (RFC Chains).

**PRO-112 · RPC learns the address and the owner's IP** (edge, low)

- Trigger: Any balance read.
- Expected: Settings names the RPC in use and says what it learns.
- Mitigation: RFC Chains, RPC and privacy.

**PRO-113 · Sequencer halted or fees spiking** (edge, medium)

- Trigger: Base stops including transactions.
- Expected: Payments stay Pending with Base isn't taking payments right now; no new nonce; replacements bounded.
- Mitigation: Single sequencer (docs.base.org reliability, via research/chain-operations.md F1).

### Phone width and paired devices

**PRO-114 · Wallet screens at phone width** (edge, medium)

- Trigger: Owner uses Settings → Wallets on a 375 px phone.
- Expected: Rows at 56 px; Send and Receive as drawers; full addresses wrap in groups of four in Geist Mono, never middle-ellipsis on a confirm or first-payment card; QR fits 24 rem; no key export.
- Mitigation: Walkthrough at desktop and phone width (principle 9); specimen entries.

**PRO-115 · Paired phone answers a payment card** (edge, low)

- Trigger: Owner taps Always on the phone.
- Expected: Owner authority; the same facts as on the desktop.
- Mitigation: A paired device acts as the owner (DESIGN.md Clients).

### Notifications

**PRO-116 · An Always payment in a quiet routine run leaves no trace** (edge, high)

- Trigger: A wake draws its line only when the run sent something.
- Expected: Every payment draws a line in the agent's chat and a row in the wallet, whether or not the run spoke.
- Mitigation: Money moved is never silent: the payment card is the daemon's, not the run's.

**PRO-117 · Lock-screen notification shows payment details** (edge, medium)

- Trigger: An ask notifies the desktop or phone.
- Expected: Mara wants to pay someone new; no amount, address or endpoint.
- Mitigation: Same rule as a harness ask (DESIGN.md The app); phone push is content-free.

**PRO-118 · Incoming funds** (edge, low)

- Trigger: Wallet receives USDC.
- Expected: A Received row; no notification (nothing nags).
- Mitigation: Design language: nothing counts or nags.

### Upgrade and migration

**PRO-119 · First release with wallets opened by an older build** (edge, high)

- Trigger: Owner downgrades after a payment started.
- Expected: The release moves the home's format, so the older build refuses the home instead of ignoring payments on their way.
- Mitigation: MIGRATIONS step, its faults and a kept home (AGENTS.md Changes).

**PRO-120 · Keychain naming changes in a later release** (edge, high)

- Trigger: The reference scheme moves.
- Expected: The step copies each item, reads it back equal, records the new reference, then deletes the old; a kill anywhere resumes.
- Mitigation: Step idempotent with fault points.

### Backups, restores and home:fork

**PRO-121 · home:fork reaches the live wallet keys** (security, critical)

- Trigger: npm run home:fork copies the store and config.json; if the keychain reference derives from anything copied, the fork's daemon reads the live keys and can pay real money.
- Expected: The fork's wallets say the key is not in this home; reads work, writes are refused.
- Mitigation: Keychain service name includes a home secret kept in a file that fork-home.ts does not copy (it copies a fixed list of auth files today), plus a test that a fork cannot sign.

**PRO-122 · Restore on the same or another machine** (edge, high)

- Trigger: Owner restores a backup.
- Expected: Same machine: the home secret comes back, keys resolve. Another machine: Key missing, then Restore key with the saved key (PRO-102).
- Mitigation: Backups hold auth/ and the record, never the key (RFC Homes).

### Groups

**PRO-123 · Agent pays from within a group** (edge, low)

- Trigger: A member's turn in a group calls wallet__send.
- Expected: Only the member's own wallets; the card shows where the work was raised.
- Mitigation: A group grants no member another's tools (law 3).

### Abuse and prompt injection

**PRO-124 · Injected page steers the agent to a new address** (security, high)

- Trigger: A page tells the agent to pay 0xEvil.
- Expected: Unknown recipient asks; the card says New recipient, shows the full address and quotes the agent's reason.
- Mitigation: Law 4; requirement 3.

**PRO-125 · Look-alike of a known recipient** (security, high)

- Trigger: Address shares the first and last 4 to 6 hex characters with Ana's.
- Expected: Card warns Looks like Ana's address, but it is a different one; Pay is not the primary button.
- Mitigation: Similarity check against the wallet's recipients (research/wallet-security.md 3).

**PRO-126 · Memory says the owner allowed a recipient** (security, high)

- Trigger: Poisoned memory: the owner said always pay 0xEvil.
- Expected: Nothing changes: rules and names live in the store, written only by owner actions.
- Mitigation: arXiv 2503.16248 (memory injection, via research/wallet-security.md 8).

**PRO-127 · Signer asked to sign something that reaches future funds** (security, critical)

- Trigger: Any path to approve, setApprovalForAll, EIP-2612 permit, Permit2, eth_sign, personal_sign, an EIP-7702 authorization.
- Expected: Impossible: the signer accepts only three shapes (ETH transfer with empty data, ERC-20 transfer(to, amount) to a pinned token, EIP-3009 TransferWithAuthorization on a pinned domain).
- Mitigation: Allowlist of shapes in the signer with property tests (research/wallet-security.md 4, 5).

**PRO-128 · Injection drains to an Always recipient** (security, high)

- Trigger: A page makes the agent pay an Always endpoint again and again.
- Expected: Bounded by the balance; every payment draws its card and row; Deny takes effect at the next start commit.
- Mitigation: Requirement 2 as chosen; RFC Always binds the recipient, never the amount.

**PRO-129 · Compromised dependency exfiltrates keys** (security, critical)

- Trigger: A poisoned release of a signing or keychain package (Solana web3.js 2024, chalk/debug 2025).
- Expected: Nothing installs that was not pinned and attested.
- Mitigation: Exact pins, committed lockfile, npm ci --ignore-scripts, npm audit signatures, minimal tree (research/signing-libraries.md).

## Index by severity

- **critical**: PRO-004, PRO-008, PRO-009, PRO-064, PRO-065, PRO-066, PRO-085, PRO-100, PRO-102, PRO-103, PRO-121, PRO-127, PRO-129
- **high**: PRO-001, PRO-002, PRO-003, PRO-007, PRO-010, PRO-011, PRO-022, PRO-026, PRO-027, PRO-029, PRO-030, PRO-033, PRO-035, PRO-037, PRO-041, PRO-042, PRO-043, PRO-047, PRO-049, PRO-050, PRO-053, PRO-056, PRO-058, PRO-059, PRO-060, PRO-061, PRO-062, PRO-067, PRO-068, PRO-069, PRO-070, PRO-077, PRO-084, PRO-086, PRO-087, PRO-088, PRO-090, PRO-092, PRO-094, PRO-095, PRO-098, PRO-099, PRO-101, PRO-104, PRO-105, PRO-106, PRO-107, PRO-110, PRO-116, PRO-119, PRO-120, PRO-122, PRO-124, PRO-125, PRO-126, PRO-128
- **medium**: PRO-006, PRO-012, PRO-013, PRO-018, PRO-019, PRO-020, PRO-021, PRO-024, PRO-025, PRO-028, PRO-031, PRO-032, PRO-034, PRO-036, PRO-039, PRO-046, PRO-048, PRO-052, PRO-054, PRO-055, PRO-063, PRO-071, PRO-072, PRO-073, PRO-075, PRO-076, PRO-078, PRO-080, PRO-081, PRO-082, PRO-089, PRO-091, PRO-093, PRO-096, PRO-097, PRO-109, PRO-111, PRO-113, PRO-114, PRO-117
- **low**: PRO-005, PRO-014, PRO-015, PRO-016, PRO-017, PRO-023, PRO-038, PRO-040, PRO-044, PRO-045, PRO-051, PRO-057, PRO-074, PRO-079, PRO-083, PRO-108, PRO-112, PRO-115, PRO-118, PRO-123

## Sources

Internal (this repository, 2026-11-23): docs/wallets.md; DESIGN.md; docs/wallets/research/signing-libraries.md,
os-keychain.md, x402.md, chain-operations.md, wallet-security.md, and their sources as cited there; scripts/fork-home.ts
(which files a fork copies).

External, cited through the research reports above (accessed 2026-11-23 by those reports):
- Base finality, Denim 200 ms blocks, pending tag: https://docs.base.org/specifications/transactions/transaction-finality ,
  https://docs.base.org/upgrades/denim/migrate-from-flashblocks
- OP Stack fee formula: https://docs.optimism.io/op-stack/transactions/fees
- geth pool errors and PriceBump: https://github.com/ethereum/go-ethereum (core/error.go, core/txpool/legacypool/legacypool.go)
- viem nonce manager caveats: https://viem.sh/docs/accounts/local/createNonceManager
- x402 v1 and v2 specs and the exact EVM scheme: https://github.com/coinbase/x402/tree/main/specs
- EIP-3009: https://eips.ethereum.org/EIPS/eip-3009
- USDC addresses: https://developers.circle.com/stablecoins/usdc-contract-addresses (EIP-712 names read on-chain)
- Address poisoning: https://www.usenix.org/conference/usenixsecurity25/presentation/tsuchiya ;
  https://cylab.cmu.edu/news/2026/01/07-blockchain-address-poisoning.html
- Memory injection: https://arxiv.org/abs/2503.16248

Read for this analysis (2026-11-23): `@napi-rs/keyring` 2.1.2 README and index.d.ts as installed from npm
(repository https://github.com/Brooooooklyn/keyring-node): Linux fallback to keyutils, `linux.store` option,
`AsyncEntry` with `AbortSignal`, `findCredentialsAsync`.
