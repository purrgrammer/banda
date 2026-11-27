# Spikes: security and trust lens (2026-11-23)

Micro-spikes behind `../../hazards-security-trust.md`. Run on darwin-arm64, macOS 27.2, Node v24.22.1, with
`@napi-rs/keyring@2.1.2`, `@noble/curves@2.4.0`, `@noble/hashes@2.4.0` installed outside the repo
(`npm i --ignore-scripts --save-exact ...` in a scratch folder). Every keychain entry was named
`banda-spike-<12 random hex>`, held a random dummy value that was never a funded key, and was deleted by the
script that made it (K1 by `k1-read.mjs <service> delete`, checked absent afterwards). No other keychain item was read.

Run any of them with `DEPS=<scratch folder with node_modules>`; `m1-heap.mjs` also needs `OUT=<writable folder>` and
`--expose-gc`.

| Spike | Question | Result |
|---|---|---|
| K1 `k1-write.mjs` + `k1-read.mjs` | Can a second script, in another folder and another process, read an item the first stored, using the same `node` binary? | Yes, silently, no prompt, 24 ms. The macOS keychain authorises the binary, not the script: anything run by the daemon's Node can read every wallet key. |
| K2 `k2-plant.mjs` | An item planted under the daemon's name by another binary (`/usr/bin/security add-generic-password -A`): does the module adopt it? Does `setPassword` overwrite an existing item? | Adopted silently (`getPassword` returned the planted value). `setPassword` overwrote it silently. So creation must be create-only and every unlock must re-derive the address and compare it to the record. |
| M1 `m1-heap.mjs` | Does the key stay in the V8 heap after signing, references dropped? | Not in the live heap graph in either mode (`getPassword` string or `getSecret` bytes zeroed after use), 3 runs each; the positive control that keeps one reference finds it every time (2 runs). A heap snapshot only shows reachable objects: freed memory is not proven scrubbed. What leaks is a retained reference (an error message, a memo, a log line, a cache). |
| P1 `p1-lookalike.mjs` | Does EIP-55 catch a typo in an all-lowercase address? How fast is a look-alike found on one CPU thread in JS? | Lowercase: no checksum, typo undetectable; mixed-case typo and a single case flip: rejected. Look-alike matching the first and last hex digit: 167 tries, 40 ms; first and last two: 310,420 tries, 65.6 s (about 4,700 keys/s). Four and four (what a `0x12ab…9f04` display shows) needs about 16^8 = 4.3e9 tries on average: days for this script, far less for GPU vanity generators. The prefix and suffix gate flagged every look-alike found. |
