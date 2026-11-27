// Q: can the daemon tell whether its own x402 (EIP-3009) payment settled without reading Transfer(from=me) logs?
// USDC's authorizationState(authorizer, nonce) for a nonce seen in AuthorizationUsed, and for a fresh one.
import { randomBytes } from "node:crypto";
import { AUTH_USED, SEPOLIA_RPC, USDC, call, hex } from "./lib.mjs";
const SEL = "0xe94a0102"; // authorizationState(address,bytes32)
const head = Number(await call(SEPOLIA_RPC, "eth_blockNumber"));
const [used] = await call(SEPOLIA_RPC, "eth_getLogs", [{ address: USDC, fromBlock: hex(head - 300), toBlock: hex(head - 100), topics: [AUTH_USED] }]);
const state = (authorizerTopic, nonce) => call(SEPOLIA_RPC, "eth_call", [{ to: USDC, data: `${SEL}${authorizerTopic.slice(2)}${nonce.slice(2)}` }, "latest"]);
const fresh = `0x${randomBytes(32).toString("hex")}`;
console.log(`used nonce (from AuthorizationUsed in block ${Number(used.blockNumber)}): authorizationState = ${BigInt(await state(used.topics[1], used.topics[2]))}`);
console.log(`fresh random nonce, same authorizer:            authorizationState = ${BigInt(await state(used.topics[1], fresh))}`);
const before = await call(SEPOLIA_RPC, "eth_call", [{ to: USDC, data: `${SEL}${used.topics[1].slice(2)}${used.topics[2].slice(2)}` }, hex(Number(used.blockNumber) - 1)]);
console.log(`used nonce, one block before it was used:       authorizationState = ${BigInt(before)}`);
