# Browser isolation secrecy and take over

Priority: **High**. Implementation status lives in [Status](status.md).

## Findings

Sensitive fields and owner-typed values receive protection, but displayed-key detection depends on token shapes and DOM attributes. Unknown formats or alternative rendering defeat a universal secrecy claim. Chromium runs without its sandbox and with site isolation disabled. Browser reads, shared sessions and owner-control transitions require an explicit verified contract.

Entry points: ../src/box/browser.ts, ../src/box/browser-tools.ts, ../src/box/snapshot.ts, ../src/box/container.ts and ../proxy/addon.py.

## Work and exit criteria

- Resolve the sandbox/site-isolation constraints before relying on a shared browser profile. Independently test
  renderer compromise assumptions, cross-chat reuse, stale refs, take-over and in-flight writes.
- Specify which secrets the boundary actually protects. Unknown token formats, canvas/text rendering and encoded
  copies defeat universal heuristic claims; use explicit owner secret handling and test that path.
- Bind approved sends to exact bytes and session authority; sensitive sends remain owner-only. Test redirects,
  subresources, clicked links, multipart refusals, cookie lifetime and unsupported upgrades.
- Provide signed-in site/key inventory, removal, owner-send activity and accurate approval scopes. Prove masking
  for snapshots and screenshots and use the app at both widths.
- Exit: browser acceptance passes under the supported contract. A failed isolation or secrecy spike blocks release
  until resolved; browser removal is not authorized by the current scope decision.

Follow [Delivery](delivery.md) and the relevant gates in [Verification](verification.md).

## Open work

Recheck these items against current code before implementation; an unchecked item is not a freshly verified
defect. Remove it only when its fix and acceptance evidence are recorded in a commit.

- [x] One browser for the box: chats take it in turns, and each taking it blanks the page another left (now one browser per agent, a tab per chat)
- [ ] An address opened or a link clicked reaches any public host, and what the agent types or a page writes there with no session of the owner's goes unasked: what a URL or a form carries out is bounded only by public-host reads
- [ ] Site isolation is off in the box's browser (one tree to read and mask), and Chromium runs without its sandbox: the container and its uid are the boundary
- [ ] Uploads (a file chooser) and downloads are refused; a multipart body Chromium does not report whole never matches its hash, and is held at the proxy as a ticket
- [ ] Keys a page shows are recognised by their shape (prefixes, JWTs, long mixed-case tokens): a key of another shape reaches the model, and an id of that shape is hidden from it
- [ ] Keys kept for a host land in `auth/egress.json`: the app cannot list or remove them yet
- [ ] The owner's own sends from the browser (while they hold it) are not in the activity
- [ ] Signed-in sites are known from a sign-in hand-over only: a sign-in the owner makes after taking over on their own is kept by the browser but not known as theirs, so what goes with it goes unasked (left so by the owner for now)
- [ ] A session set at a site other than the one handed over (a cookie a frame or a script's read set for another host) is not known as theirs: what goes with it goes unasked
- [ ] A sign-out clears the storage of the site, the hosts its cookies were for and the frames the tab opened there; a subdomain's storage the tab never opened since the browser started stays
- [ ] A request's page is its frame's address as last navigated: from a frame the page wrote into without navigating (about:blank, srcdoc), a request to an allowed signed-in site is stopped
- [ ] Session cookies (not persisted by the site) go when the browser closes after five idle minutes
- [ ] The live view is JPEG frames over SSE, dropped for a slow screen; no clipboard out of the page, no audio
