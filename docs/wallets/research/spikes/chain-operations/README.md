# Chain-operations spikes

Micro-spikes behind `docs/wallets/research/chain-operations.md`. They run against a local `anvil` 1.9.0 (no-mining,
public dev key, no funds, no network writes) and read-only public RPC for the probes quoted in the report.

Run in a throwaway directory, never inside the repo:

    mkdir spike && cd spike && npm init -y && npm install viem@2.58.4
    cp <repo>/docs/wallets/research/spikes/chain-operations/*.mjs .
    node errors-spike.mjs   # error strings for nonce, underpriced, already known, funds, intrinsic gas, drop
    node spike3.mjs         # fee-bump sweep, intrinsic gas control, nonce gap, --optimism receipt fields

`spike2.mjs` (not kept) had a loop bug that reused nonces after mining; `spike3.mjs` replaces it with a fresh anvil per case.
Results are in the report; rerun on the anvil version you ship before relying on them (latest release v1.10.0 at the time).
