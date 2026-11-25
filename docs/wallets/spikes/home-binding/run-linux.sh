#!/bin/sh
# The Linux half of binding.mjs, as root on a Linux runner or VM with Node 26: the folder cases on the runner's own
# file system, then a home on an ext4 and a btrfs image over a loop device, unmounted and mounted again.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
node "$here/binding.mjs"
work=$(mktemp -d)
trap 'umount "$work/mnt" 2>/dev/null || true; rm -rf "$work"' EXIT
mkdir "$work/mnt"
for fs in ext4 btrfs; do
	truncate -s 128M "$work/$fs.img"
	"mkfs.$fs" -q "$work/$fs.img" >/dev/null 2>&1 || "mkfs.$fs" "$work/$fs.img" >/dev/null
	mount -o loop "$work/$fs.img" "$work/mnt"
	mkdir "$work/mnt/home"
	before=$(node -e 'const s=require("fs").statSync(process.argv[1],{bigint:true});console.log([s.dev,s.ino,s.birthtimeNs,s.ctimeNs].join(" "))' "$work/mnt/home")
	umount "$work/mnt"
	mount -o loop "$work/$fs.img" "$work/mnt"
	after=$(node -e 'const s=require("fs").statSync(process.argv[1],{bigint:true});console.log([s.dev,s.ino,s.birthtimeNs,s.ctimeNs].join(" "))' "$work/mnt/home")
	umount "$work/mnt"
	echo "$fs remount: dev ino birthtimeNs ctimeNs before: $before after: $after"
done
