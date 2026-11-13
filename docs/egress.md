# Egress authority and durable intake

Priority: **High**. Implementation status lives in [Status](status.md).

## Findings

The proxy retains held requests, read observations and direct-send receipts on persistent storage until the daemon
takes ownership. Ticket bytes and their approval or explicit not-sent resolution must be stored before acknowledgement;
recovery must not depend on another command. GET/HEAD/OPTIONS classification cannot establish absence of side effects
or private-data disclosure.

Entry points: ../proxy/state.py, ../proxy/addon.py, ../proxy/policy.py, ../proxy/ctl.py and ../src/core/egress.ts.

## Work and exit criteria

- Cover tickets and read observations before intake, after durable receipt and before
  acknowledgement. Test proxy/container deletion independently from daemon death.
- Qualify the existing transfer protocol under faults: durable ownership precedes acknowledgement, and a repeated
  take finds the same disposition. Use the existing store and proxy receipts rather than a second queue.
- Recover every stored ticket into a discoverable app action even when the command result was lost. Bind replay to
  the stored bytes; an uncertain send enters the existing owner retry/skip flow.
- Explicitly address GET/query disclosure, redirects, allowed hosts, credentials and browser subresources.
  HTTP method classification cannot prove consequence; special-case detectors cannot be the security boundary.
- Exit: a reported ticket is either actionable or explicitly resolved, and no uncertain send
  is automatically repeated. Loss of the durable authority closes egress.

Follow [Delivery](delivery.md) and the relevant gates in [Verification](verification.md).

## Open work

Recheck these items against current code before implementation; an unchecked item is not a freshly verified
defect. Remove it only when its fix and acceptance evidence are recorded in a commit.

- [ ] Credential swap for signing schemes (SigV4, HMAC bodies, OAuth refresh)
- [ ] Credentials for the proxy's hosts are written by hand into `auth/egress.json`: the app adds connections' credentials, not these
- [ ] A replayed response is cut at 1 MB; a held WebSocket is never sent from its ticket: only an allowed host opens one
- [ ] An approved `git push` lands once, but git itself was answered 403 and reported failure: the agent hears the send
  only when woken with how it ended
- [ ] Rethink how a held request is shown to the owner (issue #49): the card is still its method, address, headers and
  body; one command can hold several requests, one card each; the `ask_hosts` card does not say that approving it also
  sends the held requests waiting for those hosts
- [ ] Qualify no-command held-request recovery under CI faults at transfer, store commit, acknowledgement and send
  boundaries, including a daemon killed before tool intake
- [ ] A model that re-runs a held command opens a second card for the same request (a retried `git push`, a POST):
  intake could find a live release of the same request hash and open none
- [ ] A group member's hidden chat is woken with how its held requests ended straight in that chat, outside its group
  turn, so its reply never reaches the room
- [ ] A release parked by the restart limit while it waits its turn holds up the younger ones of its chat; `revive()`
  retries only tasks that own a Wait
- [ ] A send that fails after its attempt was recorded but before the proxy was called is told as "may have been
  sent"; and `proxyDown` reads Docker not running as nothing sent, though Docker may have died after the proxy sent
- [ ] Git over SSH (the box reaches only the proxy) and Nostr (NIP-34: relays over WebSocket, events signed with a key
  that stays outside the box) are not carried
- [ ] Enforce explicit read/disclosure authority for queries, redirects and browser subresources (egress.md)
