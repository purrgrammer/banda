#!/bin/sh
# Builds the keychain spike's image (../../keychain/Dockerfile) with find.mjs and find-linux.sh added, runs it once in a
# container with a unique name, and removes the container and the image. Run from this folder.
set -eu
K=../../keychain
B=$(mktemp -d)
cp "$K/Dockerfile" "$K/package.json" "$K/kc.mjs" "$K/hang.mjs" "$K/linux.sh" "$K/audit-deps.mjs" find.mjs find-linux.sh "$B/"
echo 'COPY find.mjs find-linux.sh ./' >> "$B/Dockerfile"
SUF=$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')
docker build -q -t "banda-spike-kc-$SUF" "$B" >/dev/null
docker run --rm --name "banda-spike-$SUF" "banda-spike-kc-$SUF" sh find-linux.sh
docker rmi -f "banda-spike-kc-$SUF" >/dev/null
rm -rf "$B"
