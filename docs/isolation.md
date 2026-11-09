# Box isolation

Priority: **High**. Implementation status lives in [Status](status.md).

## Findings

Chats share a Unix identity, writable workspace, toolchains and process namespace. Per-chat proxy logins in command environments do not establish process isolation. Shared-file reads can transfer foreign instructions between chats; the routine-check identity adds timing and authority gaps.

Entry points: ../src/box/container.ts, ../src/box/box.ts, ../src/core/permissions.ts and ../proxy/addon.py.

## Work and exit criteria

- Reproduce cross-chat proxy-login access, shared-file reads carrying foreign instructions and the `c0`
  routine-check exception. Include detached processes and a daemon restart.
- Spike per-agent process/filesystem isolation (a box per agent, DESIGN.md "Open"). Do not choose chat isolation while
  retaining shared writable tools or memory that silently transfer instructions across that boundary.
- Bind connection and proxy admission to the same effective policy. Proxy identity must not allow a more privileged
  principal to be impersonated; routine checks cannot provide an unrestricted alternate login.
- Show consistent pause, activity and offline behavior without exposing internal machinery to the owner.
- Exit: arbitrary box code cannot obtain less restricted access by changing chat identity, path or process timing.

Follow [Delivery](delivery.md) and the relevant gates in [Verification](verification.md).

## Open work

Recheck these items against current code before implementation; an unchecked item is not a freshly verified
defect. Remove it only when its fix and acceptance evidence are recorded in a commit.

- [ ] The box is shared: a process can read another chat's proxy login from `/proc`; host permissions are agent-bound only by login, so any agent in the box can send to a host allowed for another
- [ ] A routine's check reads as one login (`c0`), not as the chat it wakes
