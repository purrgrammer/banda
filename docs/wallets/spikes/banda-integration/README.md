# Spike: wallets on banda's own primitives (banda integration)

Date: 2026-11-23. This spike is a code reading backed by four micro-spikes. They import banda's real modules read-only
from the checkout at `1b15d71` and run on temp homes with pi-ai's faux model. One spike runs banda's pinned mitmproxy
image in Docker against an invented HTTPS server. Nothing in `src/`, `web/`, `test/` or `package.json` was changed. No
chain, key, keychain entry or real funds were used: the "signed bytes" are strings, and the addresses are invented.

## Goal

Find out how agent-operable EVM wallets (`docs/wallets.md`) map onto what banda already has: connections, accounts,
permissions, effects, Waits, the egress proxy and the home format. Each answer below gives the file and line, and says
what was run to check it.

1. Where does a built-in wallet adapter plug in?
2. Can `auth: "key"` hold a credential reference that the daemon generated?
3. How does an **Always** rule map to a permission with scope `always` that binds only the recipient?
4. Where must a **Deny** rule be checked so that it sits in the same commit that admits a permission or a draft?
5. How is the exception to the money floor expressed?
6. How does a payment effect checkpoint its signed bytes and resume after a crash?
7. How can proxy observations carry a verified 402 challenge?
8. Which stored shapes and which `MIGRATIONS` step are needed?
9. Which fault points does `test/fault/` need?

## Setup

| Thing | Version |
|---|---|
| banda checkout | `1b15d71` (read-only: modules imported by `file://` URL) |
| Node | v24.22.1 with `--experimental-strip-types` (the version this machine has; `mise.toml` asks for 26) |
| pi-durable / pi-ai | 1.4.0 / 1.4.0, from the checkout's `node_modules` |
| mitmproxy | `mitmproxy/mitmproxy:12.2.3@sha256:00b77b5d…962f`, the digest `proxy/Dockerfile:3` pins |
| Docker | 29.8.2; the upstream server and client run on `python:3.13-slim` |

## Files

| File | What it checks |
|---|---|
| `binds/check.ts` | What `draftOf`, `matches`, `offeredScopes`, `refusal`, `connectionOf`, `fits`, `secrets` and `scrub` do with a wallet send (21 checks, no store) |
| `rules/check.ts` | Ask, Always and Deny on the real `effect`/`effectRun`, Wait and Permissions doc, with one checkpoint ledger doc (6 scenarios) |
| `resume/check.ts` | SIGKILL inside a payment effect's `run`, then resume on the same home (3 scenarios) |
| `x402-observe/` | `upstream.py` (an HTTPS server that answers 402 with a v2 `PAYMENT-REQUIRED`), `observe.py` (a minimal addon that pins tunnels as `proxy/addon.py` does), `client.py` (trusts only the proxy's CA), `run.sh` (two runs: upstream trusted and untrusted; it removes its containers and network on exit) |
| `*/out.txt` | The raw output of the final runs quoted below |

## Commands

```sh
REPO=/path/to/banda            # a checkout with node_modules installed (npm ci)
node --experimental-strip-types --no-warnings binds/check.ts  "$REPO"
node --experimental-strip-types --no-warnings rules/check.ts  "$REPO"
node --experimental-strip-types --no-warnings resume/check.ts "$REPO"   # forks itself: first, then resume
sh x402-observe/run.sh                                                  # needs Docker
```

## Observed (trimmed)

`binds/check.ts`:

```
PASS draftOf binds account+chain+to, not amount/token: {"chain":"eip155:84532","to":"0x12aB…Ef12","account":{"key":"0xwallet-a","generation":"g1"}}
PASS Always covers the same recipient, any amount and token
PASS Always does not cover another agent on the same wallet: not covered: a permission binds one agent
PASS Always does not cover the wallet re-created (new generation)
PASS same address in lowercase is NOT covered (canonical JSON compare): expand must canonicalize
PASS lasts:[always] offers only Always: [{"scope":"always","words":"Pay 0x12aB…Ef12, up to what is in the wallet without asking until you take it back in Permissions"}]
PASS a draft on the money floor offers no scope: []
PASS a task scope not offered is refused: that was not offered
PASS money floor refuses Always: this is never allowed ahead: it asks every time, as it moves money
PASS a built-in `api: wallet` with auth key is refused by connectionOf: ["a built-in API is one of \"gmail\" … \"slack\" …"]
PASS a key reference stops fitting when the RPC URL changes: does not fit: wallet offline
PASS a reference that only contains the address leaves the bare address visible (scrub matches the whole key)
PASS a reference that IS the address hides the address in every output: paid from [a credential, hidden] to Ana
PASS a new credentials shape (neither key nor oauth) crashes secrets() as the code stands: Cannot read properties of undefined (reading 'tokens')
ALL PASS
```

`rules/check.ts`:

```
PASS first payment to an unknown recipient asks: asks=1
PASS Always stored as a permission binding `to` only: [{"match":{"to":"ana"},"scope":"always","agent":"sancho"}]
PASS Always pays the same recipient another amount unasked: asks=0
PASS Deny refuses without asking (no Wait): {"text":"…wallet__send did not run: the owner doesn't pay bob.…","waits":0}
PASS Deny set while a draft waits refuses the approved run at start: …did not run: the owner doesn't pay carol.
PASS Deny overrides an open Always permission: …did not run: the owner doesn't pay ana.
PASS one signing per run, distinct sequential nonces: {"signings":2,"nonces":[0,1]}
ALL PASS
```

`resume/check.ts`:

```
PASS killed after-checkpoint: first exit signal=SIGKILL; after resume {"asksAfterKill":0,"nonceNext":1,"signings":1,"broadcasts":["0x02f8…(ana,1,nonce=0,ad24a0)"]}
PASS killed after-broadcast: first exit signal=SIGKILL; after resume {"asksAfterKill":0,"nonceNext":1,"signings":1,"broadcasts":["0x02f8…(…f272c3)","0x02f8…(…f272c3)"]}
PASS killed after-broadcast-deny: … "broadcasts":["0x02f8…(…9903fd)"],"result":"…wallet__send did not run: the owner doesn't pay ana."
ALL PASS
```

`x402-observe/run.sh`:

```
== upstream CA trusted by the proxy
{"status": 402, "x-banda-challenge": "c0ae729226c3de765af4cdfe", "payment-required": "eyJ4NDAyVmVyc2lvbiI6IDIs…"}
-- observations:
{"id":"c0ae…","scheme":"https","host":"pay.test","port":8443,"sni":"pay.test","server_sni":"pay.test",
 "path":"/v1/forecast?city=lisbon&units=c","method":"GET","payment_required":"eyJ4NDAy…"}
== upstream CA not trusted (mitmproxy defaults: certifi)
{"status": 502, "x-banda-challenge": null, "body": "…502 Bad Gateway… Certificate verify failed: unable to get local issuer certif…"}
-- observations:
(none)
```

## Answers

### 1. Where a built-in wallet adapter plugs in

- **Today, a built-in is a REST adapter signed in with OAuth.** `api` must name an entry of `REST_APIS`
  (`src/core/rest.ts:115-215`: gmail, calendar, contacts, drive, slack). `connectionOf` refuses a built-in whose `auth`
  is not `oauth` with the registry client and its scopes (`src/core/connections.ts:184-197`). The run confirmed it:
  `api: wallet, auth: key` is refused.
- **The REST shape cannot pay exactly once.** `RestApi.read`/`write` get `(token, tool, args, signal, fetcher, files,
  key)` (`src/core/rest.ts:52-113`). They get no `Tx` and no `EffectApi`, so an adapter cannot reserve a nonce or store
  signed bytes in the store. `writeTool`'s `run` calls the adapter only after the effect has started
  (`src/server/capabilities.ts:1019-1062`).
- **The plug-in point is the install loop.** It picks `readTool`, `writeTool` or `partlyReadTool` for each connection
  tool (`src/server/capabilities.ts:1155-1168`). A wallet branch there builds the wallet's tools as `EffectTool`s
  through `options.effect` (`src/server/capabilities.ts:162-185`; the type is `src/core/ask.ts:601-642`). The same
  pattern already builds tools outside REST: egress's `proposeSendTool` (`src/core/egress.ts:668`).
- **The wallet stays a connection** for its account model, and inherits it unchanged:
  - accounts (`Connected.accounts`, `src/core/connections.ts:387`);
  - the owner's choice of which accounts each agent may use (`Connected.on: {agent: {connection: accountKeys[]}}`,
    `:388`; `accountsOn`, `:504-508`), on top of the agent file naming the connection (`mayUse`, `:493-494`). This is
    the requirement that a person picks which EVM account each agent may use;
  - the `account` argument when an agent has several (`multiAccount`, `:515-527`; `schemaOf`,
    `src/server/capabilities.ts:748-761`) and its resolution (`accountFor`, `:595-650`);
  - a per-agent account switch (`src/server/capabilities.ts:1871-1928`);
  - `toolAuthority`, so a changed definition voids open asks (`src/core/connections.ts:688-718`);
  - permissions revoked when an account is removed (`src/server/capabilities.ts:1495-1513`).
- **The wallet's `allowed` hook must compose `allowedAs`** (`src/server/capabilities.ts:671-683`). It re-checks, in
  each admitting commit, that the tool is still in effect, that the definition version is unchanged, and that the
  account is still on for this agent at the same generation. For a REST tool the service's token is the real boundary
  (comment at `:642`). For a wallet the daemon's signer is the boundary, so this check is the enforcement, not a
  courtesy (principle 4).

### 2. `auth: "key"` as a credential reference

Mechanically it works. `fits` accepts `{url, key}` when `auth` is `key` (`src/core/connections.ts:844-858`), and
`withServer` passes the key as a Bearer value (`src/server/capabilities.ts:504-515`, `:546-550`). **It should not be
reused**, for four reasons, all observed:

- (a) `connectionOf` refuses it for a built-in (answer 1).
- (b) The credential is bound to the connection URL. For a wallet that is the RPC endpoint, so changing RPC provider
  takes every wallet offline ("does not fit: wallet offline").
- (c) `secrets()` collects the `key` and `scrub` replaces exactly that string in every output
  (`src/core/connections.ts:945-959`, `:985-989`). A reference that *contains* the address leaves the address visible.
  A reference that *is* the address hides the wallet's public address everywhere, including the receive screen's words.
- (d) The `key` flow is the owner typing a key, which is not how a wallet is created.

**Recommendation:** add a new auth kind (for example `"wallet"`) with a `Credentials` variant
`{keychain: {service, account}, address, chains}` that is **not** bound to `url`. `fits`, `credentialsOf`, `secrets`
and `withCredentials` (`src/core/connections.ts:798-925`) each learn the variant. As the code stands, `secrets()`
**crashes** on any third shape (`Cannot read properties of undefined (reading 'tokens')`). An older build that opens a
home holding a wallet credential would therefore fail on every scrub. A `MIGRATIONS` step is required so that an older
build refuses the home cleanly instead (answer 8).

### 3. Always: a permission with scope `always` that binds only the recipient

- **Declare it on the effect:**
  `permission: { bind: [accountArg], args: ["chain", "to"], lasts: ["always"], what }`. `draftOf` builds the match from
  `permission.args ∪ bind` (`src/core/ask.ts:706-744`). The match is `{account, chain, to}`, never the amount or the
  token (observed).
- **Only Always is offered.** `offeredScopes` filters the scopes by `lasts` (`src/core/permissions.ts:349-363`). A
  `task` scope is refused as "that was not offered". An interrupted run offers nothing, and so does a draft on the
  money floor (observed).
- **The match is canonical JSON** (`src/core/permissions.ts:154-162`, `:195-225`). A checksummed address and the same
  address in lowercase do **not** match (observed). The tool's `expand` must canonicalize `to`, with EIP-55 or
  lowercase, before the draft is made.
- **A permission binds one agent** (`Permission.agent`, `src/core/permissions.ts:94`; compared at `:211`; observed).
  With a wallet that several agents may use, Always is per (agent, wallet, recipient). That is least privilege and
  needs no change to the law. A per-wallet rule shared across agents would need a store of its own and a second
  admission path, and copying permissions between agents would break principle 1. The Permissions screen must show
  which agent each rule is for.
- **A wallet re-created with a new generation is not covered** (observed). Re-sign-in carries permissions over to the
  new generation for OAuth accounts (`src/server/capabilities.ts:2118-2134`). A wallet must decide on purpose whether
  a re-import is "the same account". Recommendation: no carry-over. A new key starts with no rules.
- **`writeTool` never passes `lasts`** (no `lasts` in `src/server/capabilities.ts`). The dedicated wallet builder sets
  it.
- **Precedent:** `test/fault/permission-worker.ts:42-55` already declares an effect whose permission binds `to` alone.

### 4. Deny: where it is checked

- **It goes in the effect's `allowed` hook.** `effectRun` calls it:
  - in the `withinPermission` commit, before `covering` looks for a permission and before any draft opens
    (`src/core/ask.ts:809-818`);
  - again in the `start` commit after an approval (`src/core/ask.ts:795-804`).

  So Deny is decided in the same serializable commit as permission admission and as the start of an approved draft
  (pi-durable: "All changes go through one line of atomic commits", README:94).
- **Observed:**
  - Deny set ahead refuses in words and opens no Wait.
  - Deny set while a draft waits refuses the approved run at start.
  - Deny beats an open Always.
- **Store refusals in a doc of their own, not as a fourth "never" scope in `Permissions`.** Code that iterates
  `Permissions` would read a refusal as a grant unless every reader learned the new scope: `permittedHosts`
  (`src/core/egress.ts:199-221`), the open-permissions list, archive retirement (`retireInvalidPermissions`,
  `src/core/permissions.ts:453-460`). A separate doc fails closed.
- **Answering "Never pay this address" from the draft needs a new `Approving` field.** Today `deny` is an answer, and
  a permission rides only on an approval (`src/core/wait.ts:358-360`). `fill` would apply the refusal in its own commit
  (`src/core/wait.ts:325-420`). It also needs a twin of `coveredAsks`/`answerCovered` (`src/core/wait.ts:451-514`), so
  that other open drafts to the same recipient are refused in that same commit rather than left waiting. A label for
  the address (the recipients book) rides on the same field.
- **The race is closed by `start`.** Between the `withinPermission` commit and the commit that opens the Wait
  (`src/core/ask.ts:857-874`), a Deny can still let a draft open. `start` refuses it.

### 5. The money floor exception

The floor is declared only by a definition: `floors.money` lists tools (`src/core/connections.ts:234-242`). It is
spoken as "it moves money" (`src/core/floor.ts:6`, `:14-20`). No other code special-cases money (grep). The exception
is therefore expressed by **the wallet definition not listing its send tools under `floors.money`**. Nothing in the
code changes. DESIGN.md law 2 and the Messages wording must state the exception: a wallet payment may be allowed ahead
per recipient. Otherwise the shipped definition silently contradicts the law.

Two interactions to keep:

- The owner's per-tool "Always ask" setting still puts the tool on the `owner` floor
  (`src/core/connections.ts:735-744`), and any floor makes `covering` find nothing (`src/core/permissions.ts:296`).
  That gives a wallet-wide "ask every time" switch for free.
- `pay_x402` can keep its per-call amount out of the match in the same way.

### 6. Checkpoint and resume

- **Pattern** (`resume/check.ts`, `rules/check.ts`):
  1. The effect is `idempotent`, so an interrupted run reruns under the same key without asking again
     (`src/core/ask.ts:875-887`).
  2. In `run`, commit A reserves the nonce under the effect key, in a ledger doc (`key = api.memo("key", randomUUID)`,
     `src/core/ask.ts:751-762`).
  3. The transaction is signed outside the commit.
  4. Commit B stores the raw bytes, first write wins.
  5. The stored bytes are broadcast.
- **Observed under SIGKILL:**
  - no second ask;
  - one signing;
  - one nonce;
  - the bytes broadcast after resume are the stored ones;
  - a kill after the broadcast leads to a second, identical broadcast, which the chain treats as the same transaction.
- **Do not keep the checkpoint in `api.memo` alone.** Memos are dropped when the task reaches an outcome (pi-durable
  `dist/harness/scheduler.js:2262-2268`). The ledger doc outlives the task, and it doubles as the transaction list the
  Settings wallet screen shows.
- **Hazard (observed):** a Deny set after a crash but before the resume makes the idempotent rerun answer
  "wallet__send did not run" (`allowed` is re-checked, `src/core/ask.ts:881-887`), although the bytes had already
  left. The same holds for an account switched off or a definition changed in that window. So once raw bytes are
  stored, a refusal must not be reported as "did not run". The wallet needs:
  - "may have sent" wording, as egress already has (`src/core/egress.ts:724`);
  - a daemon-level receipt follower that drives every stored-but-unconfirmed entry to an outcome, independent of the
    tool task.

  The fix belongs in the wallet's `run`/`allowed`: once a ledger entry for the key holds raw bytes, `allowed` lets the
  rerun reach `run`, and `run` only rebroadcasts and reports. The general `effectRun` stays as it is.
- **Ledger states:** `reserved` → `signed` (may have been sent) → `broadcast` → `included` | `failed` | `replaced`. A
  reservation with no stored bytes can be released. A key exported and used elsewhere means the follower must
  reconcile against the chain's `eth_getTransactionCount`.
- **Pitfall (observed):** a value read from a doc inside `api.commit` is a live overlay. Returning it out of the commit
  later fails with `Cannot use a settled overlay`. Copy it out, as `src/core/ask.ts:849` does.

### 7. Proxy observations that carry a verified 402 challenge

- **Every admitted flow is tagged with its chat.** `flow.metadata["banda"]` is set from the box's own proxy
  credentials (`proxy/addon.py:218` for the box, `:278` for the browser). `responseheaders` sees the status and headers
  of every admitted response (`proxy/addon.py:301-341`). It already records a per-chat outcome there (`state.outcome`,
  `proxy/state.py:121`). The v2 challenge is a header (`PAYMENT-REQUIRED`), so it is visible at that point. v1 puts the
  challenge in the body and would need a body capture.
- **Upstream TLS is verified.** `proxy/start.py:33-46` sets neither `ssl_insecure` nor a trusted-CA override, and
  mitmproxy's defaults verify upstream certificates (`ssl_insecure` defaults to False). Observed with the pinned image:
  - against a server whose CA the proxy trusts, one observation carries the tunnel's host, the SNI on both sides, the
    path with its query, and the header;
  - against the same server untrusted, the client gets `502 … Certificate verify failed` and no observation is
    recorded.
- **Shape:** the addon records `{id, chat, host, port, path, method, payment_required}` and hands the box only
  `x-banda-challenge: <id>`. `intake` (`src/core/egress.ts:558`) commits it into a `Challenges` doc next to `Tickets`
  (`:135`); `Taken` gains `challenges` (`:71`). `pay_x402`'s `expand` checks that the challenge belongs to the calling
  chat, as `proposeSendTool` checks a ticket (`src/core/egress.ts:708`). It also binds the paid request's host and
  path to the observation's, not to anything the box says.
- **A held write never reaches the server**, so its 402 appears only in the replay result (`Replayed`,
  `src/core/egress.ts:80`; `ctl.py:137` replays over certifi-verified TLS). That is a second capture point.
- **The paid retry of a POST is itself a write, so it is held again.** Whether paying implies one pass for that retry
  (a one-time pass exists for the browser, `proxy/state.py:139-146`) is open.
- **Only `https` observations count.**
- **An observation reaches the store at intake**, after the command ends. `pay_x402`'s `expand` must run an intake
  first, or it will not find a challenge that has only just been observed.

### 8. Stored shapes and the `MIGRATIONS` step

New or changed shapes:

| Shape | Where | Note |
|---|---|---|
| `Credentials` wallet variant `{keychain, address, chains}` | `auth/connections/wallet/<address>/credentials.json` | `secrets()` crashes on it today (answer 2) |
| Wallet ledger: nonce per (wallet, chain), entries keyed by effect key `{nonce, raw, state, hash, to, amount, token}` | new doc | The checkpoint and the transaction list |
| Recipient rules: refusals and labels per (wallet, address) | new doc | Deny, and the recipients book |
| Challenges `{id, chat, host, path, method, payment_required, at}` | new doc, beside `Tickets` | Committed by `intake` |
| `Ask` approval gains the recipient words and a "never pay" offer; `Approving` gains `refuse`/`label` | `src/core/wait.ts:72-122` | Stored in Wait entries |
| Maybe: an outcome doc for "may have sent", like `SendOutcome` | `src/core/egress.ts:648` | |
| Agent file: `connections` names `wallet` | workspace file | Already a list of names, so no shape change |

Append **one** step to `MIGRATIONS` (`src/core/format.ts:26-33`). It moves `HOME_FORMAT` from 4 to 5 (`:36`;
`FORMAT_FLOOR` stays 3, `:11`). The step converts nothing, because no home holds these yet. The format moves so that
a build from before wallets refuses the home at start, instead of crashing in `secrets()` or misreading a doc. Like
every step, it needs its kills and thrown faults under `test/fault/` and a kept home under `test/fixtures/homes/`
(AGENTS.md).

Home lifecycle notes:

- `auth/` is backed up (`src/core/backup.ts:55`), so a backup carries the keychain reference but not the key. Restore
  on another machine finds no key: the wallet is offline until the owner imports the exported key.
- `home:fork` copies only `token` and `egress.json` (`scripts/fork-home.ts:71`), so a fork has no wallets. That is
  right for a fork that must never spend.
- A backup restored beside the original on the same machine shares the keychain entry. Two daemons would then hold
  one key and race the nonce. The keychain service name must include the per-home installation id (`auth/device-id`,
  `src/home.ts:144-157`).

### 9. Fault points for `test/fault/`

Existing ones these flows cross: `effect`, `commit:before`/`commit:after`, `connection:call`, `connection:answered`,
`replay`, `replay:sent`, `intake`, `intake:stored`, `account:*`, `credential:*`. New ones, one at each new effect
boundary:

| Point | Where |
|---|---|
| `wallet:reserved` | after the nonce commit, before signing |
| `wallet:signed` | after signing, before the raw-bytes commit |
| `wallet:stored` | after the checkpoint, before the broadcast |
| `wallet:broadcast` | after the RPC accepted the bytes, before recording it |
| `wallet:receipt` | after a receipt was read, before its commit |
| `wallet:replace` | inside a fee-bump replacement (sign, store, broadcast) |
| `challenge:observed` | in the addon, after recording, before the box gets the id; and `intake:challenges` |
| `x402:signed` / `x402:sent` | after the EIP-3009 authorization is signed, and after the paid retry is sent |
| `rule:set` | inside `fill`'s commit that stores a refusal or a label |
| `keychain:read` | around the key read, for a missing or locked keychain |

Shared invariants to check after every kill:

- at most one signed transaction per (wallet, chain, nonce) that banda chose;
- no stored raw bytes without a ledger entry;
- no ledger entry left `signed` without the follower picking it up;
- no payment reported as "did not run" while its bytes are stored;
- no Wait open for a recipient under a Deny.

## Verdict

Wallets fit banda's existing primitives with no new admission path:

- The **account model** of connections already gives several wallets, labels, and the owner's per-agent choice.
- **Always** is a permission with scope `always` that binds `{account, chain, to}`, offered alone via `lasts`.
- **Deny** is the effect's `allowed` hook, which runs in the same commit as permission admission and again at start.
- **Exactly-once** is an `idempotent` effect with a ledger doc: the nonce is reserved, then the signed bytes are
  checkpointed, then broadcast.
- **x402** challenges can be observed by the egress proxy over verified TLS.

All of these were run on banda's real code.

What does *not* carry over:

- The REST adapter shape: the wallet needs its own tool builder.
- `auth: "key"`: it is bound to the RPC URL and its value is scrubbed.
- `secrets()`: it crashes on a new credential shape, so a `MIGRATIONS` step is needed.
- The idempotent rerun after a crash: it reports "did not run" for bytes that already left if a rule changed in the
  meantime.

## What it means for the design

- `docs/wallets.md` should say the wallet is a connection with a dedicated tool builder (not a `REST_APIS` entry), and
  a new auth kind whose credentials are not bound to `url`.
- Always is per agent. The RFC and the Permissions screen say "Mara may pay 0x… always", not "the wallet pays 0x…".
- `expand` canonicalizes addresses (EIP-55) before drafting, or Always silently stops matching.
- Deny lives in a recipient-rules doc read by `allowed`, never as a scope in `Permissions`. "Never pay" from a draft
  needs an `Approving` field plus a `coveredAsks` twin.
- The money floor exception is a definition fact (send tools are not under `floors.money`), and DESIGN.md law 2 must
  say it.
- After raw bytes are stored, the outcome is "may have sent" until a receipt decides it. A daemon-level follower owns
  that, not the tool task.
- One `MIGRATIONS` step (format 4 to 5) arrives with the first stored wallet shape, together with its faults and a
  kept home.
- The keychain service name includes the home's device id.

## Surprises

- A permission binds one agent, so a wallet shared by two agents gets two independent sets of Always rules.
- Address case defeats matching: canonical JSON compares a checksummed and a lowercase address as different.
- `secrets()` assumes every credential is `key` or `oauth` and throws on anything else, which would break scrubbing
  home-wide.
- A `key` credential is bound to the connection URL, which for a wallet is the RPC endpoint.
- The idempotent rerun reports "did not run" for a payment whose bytes were already broadcast, if a Deny (or an
  account switch) landed between the crash and the resume.
- `api.memo` values vanish when the task ends, so they cannot be the payment record.
- A doc value returned out of `api.commit` is a dead overlay and must be copied.
- A held POST's 402 is visible only in the replay result, not at `responseheaders`.
- `writeTool` never passes `lasts`.
- `multiAccount` lists **every** account's label in the `account` argument of every agent's schema
  (`src/core/connections.ts:515-527`, `src/server/capabilities.ts:748-761`). An unlabeled wallet's label is its
  address (`accountLabel`, `src/core/connections.ts:455-456`), so agents see addresses of wallets they may not use.
  `accountFor` still refuses them. Labels should be required for wallets, or the schema narrowed per agent.

## Open

- Whether a paid x402 retry of a held write gets a one-time pass (answer 7).
- Body capture for v1 (`X-PAYMENT`) challenges, or v2 only.
- Whether a re-imported key (same address, new generation) keeps its rules. Recommended: no.

## Sources

- mitmproxy options: `ssl_insecure` "Do not verify upstream server SSL/TLS certificates … Default: False";
  `ssl_verify_upstream_trusted_ca` default None; `connection_strategy` default eager; `upstream_cert` default True.
  https://docs.mitmproxy.org/stable/concepts/options/ (fetched 2026-11-23).
- x402 v2 HTTP transport: `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE` and `PAYMENT-RESPONSE`, all base64 JSON.
  https://raw.githubusercontent.com/coinbase/x402/main/specs/transports-v2/http.md (fetched 2026-11-23; see
  `../../research/x402.md`).
- Base Sepolia USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` is the asset in the invented challenge, as listed in
  `../../research/x402.md` (2026-11-23). It is only a string here; nothing was sent.
- pi-durable 1.4.0, from the checkout's `node_modules/@earendil-works/pi-durable`: README:94 (one line of atomic
  commits), README:277 (`replay: "safe"`), `dist/harness/scheduler.js:2005-2016` (memo, first write wins) and
  `:2262-2268` (memos dropped at the outcome).
