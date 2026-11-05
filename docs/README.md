# Delivery

DESIGN.md is the source of product rules, [Status](status.md) records current work and acceptance, and each section
here owns its open work. Findings in a section name mechanisms to reproduce against current code before changing
them; they are not claims that every attack has been reproduced. Proposed mechanisms need spikes before becoming
design rules.

## Sections and delivery order

Start with [Status](status.md) for current work. Each section's **Open work** list is the task source for that area;
keep completed-work history in commits rather than duplicating these lists in a separate plan or backlog.

The app is rebuilt from the ground up as a chat, specimen first: every screen and card is designed and reviewed as
static UI before the daemon is wired behind it, and subsystems the design no longer names are deleted as each slice
reaches them.

| Order | Section | Main outcome |
|---|---|---|
| 1 | [Chat](chat.md) | The specimen of the whole app; then the shell, the panel, settings and the chat's polish, wired to the daemon |
| 2 | [Agents and groups](agents.md) | Ordinary agents made by the owner; groups of equals in the band |
| 3 | [Routines](routines.md) | Routines in their agent's chat, as events |
| 4 | [Connections](connections.md) | Accounts, one connect flow, GitHub's objects in the chat |
| 5 | [Isolation](isolation.md) | Shared files and identities cannot bypass trust policy |
| 6 | [Egress](egress.md) | Durable intake and explicit write authority |
| 7 | [Workspace](workspace.md) | Concurrent owner and box changes are preserved |
| 8 | [Recovery](recovery.md) | Persistent bytes and complete restoration |
| 9 | [Browser](browser.md) | Verified isolation, secrecy, take-over and signed-in sends |
| 10 | [Performance](performance.md) | Bounded resource use and responsive accumulated history |
| 11 | [Operations](operations.md) | Installation, runtime supervision, updates and support |
| 12 | [Verification](verification.md) | Fault, adversarial, browser and release evidence |

[Architecture](architecture.md) contains the assessment across axes and cross-cutting modularity work. Use
[Delivery](delivery.md) for the procedure shared by every section. Dependencies order implementation; smaller
end-to-end slices may be carved from a section, with their own checks and owner review. Resource bounds may be
pulled forward when required to make an earlier mechanism safe.

[Multimodality](multimodality.md) covers model capability visibility, attachments and browser screenshots.
[Memory](memory.md) and [Substrate](substrate.md) hold memory's provenance work and upstream gaps. [Behavioral
evals](evals.md) proposes longitudinal agent quality experiments alongside, not in place of, the verification gates.
[Scope](scope.md) keeps the support matrix and reproducible checks.

No section is complete merely because its checks exist: it must work through the running app, and the owner reviews
each slice.
