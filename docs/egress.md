# Egress authority and durable intake

Priority: **High**. Implementation status lives in [Status](status.md).

## Findings

Tickets initially live in proxy tmpfs before daemon intake. A daemon commit/ack protocol does not by itself survive independent proxy loss before intake. A ticket committed before a lost command result may remain undiscoverable. GET/HEAD/OPTIONS classification cannot establish absence of side effects or private-data disclosure.

Entry points: ../proxy/state.py, ../proxy/addon.py, ../proxy/policy.py, ../proxy/ctl.py and ../src/core/egress.ts.

## Work and exit criteria

- Cover tickets and read observations before intake, after durable receipt and before
  acknowledgement. Test proxy/container deletion independently from daemon death.
- Spike an intake protocol in which durable ownership precedes acknowledgement. A new persistent proxy queue would
  create another authoritative store; use the substrate first and resolve ownership before implementing it.
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
- [ ] The proxy holds tickets in memory-backed state: a proxy made again forgets tickets not yet taken (the box was told 403 with the ticket)
- [ ] A replayed response is cut at 1 MB; a held WebSocket is never sent from its ticket: only an allowed host opens one
- [ ] An approved `git push` lands once, but git itself was answered 403 and reported failure: the agent hears the send
  only when woken with how it ended
- [ ] Rethink how a held request is shown to the owner (issue #49): the card is still its method, address, headers and
  body; one command can hold several requests, one card each; the `ask_hosts` card does not say that approving it also
  sends the held requests waiting for those hosts
- [ ] A daemon killed while a command runs leaves what the proxy held untaken, and unasked, until the chat's next
  command; the bring-up sweep (`sweepSent`) could take held tickets too
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
