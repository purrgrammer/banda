# Spike: what binds a home to where it is

Status: evidence for C16 and R-12's binding (`bindingOf` in `src/wallet/home-id.ts`), run on 2026-11-24. Nothing
here is a DESIGN.md rule (principle 6).

## Claim

A home's binding is its realpath, its folder's inode and, where the platform keeps one, its folder's birth time. It
stays while the home lives where it is (entries made in the home, the home renamed away and back, the volume
remounted), and a copy (`cp -Rp`, a restore to another folder) has another one. The device number is left out: a
remount can renumber a volume. On Linux the birth time is left out: where statx is missing Node reports the change
time in its place, which moves with every entry made in the folder.

## Run

`node binding.mjs` on macOS; [`run-linux.sh`](run-linux.sh) as root on Linux (the folder cases, then an ext4 and a
btrfs image over a loop device, unmounted and mounted again).

## Results

macOS 27.2.1 (APFS), arm64, Node 24.22.1: [`out-macos.txt`](out-macos.txt).

| Case | dev | ino | birth time | ctime |
|---|---|---|---|---|
| entries made, renamed and removed in the home | same | same | same | moved |
| the home renamed away and back | same | same | same | moved |
| `cp -Rp` of the home | same | moved | moved | moved |
| a disk image's volume detached, another attached, the image attached again | **moved** | same | same | same |

The remount moved the device number and kept the inode and birth time, so a binding holding `dev` would take an
external disk's home offline after a remount; one without it does not.

## What Linux leaves open, and what closes it

Without the birth time, a Linux binding is the realpath and the inode. ext4 hands a freed inode number out again, so a
home deleted and restored at its own path can come back with the binding of the home it replaced, and read the lease
as its own with an older store. A restore therefore leaves a mark of its own (`restored.json`, a random value,
`src/core/restored.ts`) that the binding takes in: a restored home never holds the original's lease, wherever and
however it lands, and signs again only after the owner's Move signing here. A hand copy (`cp -a`, rsync) put back at
the path of a deleted home carries no such mark and keeps that gap on Linux; `run-linux.sh` is the run that would
measure how often the inode comes back.

## Not run

- Linux (ext4, btrfs; with and without statx), and a loop-device remount there: `run-linux.sh` is written, not run.
- A reboot, on either platform.
- A Time Machine restore to the same path (a copy at the same realpath: its inode is expected to differ).
