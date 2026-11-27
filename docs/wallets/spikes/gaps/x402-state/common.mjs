// USDC on Base Sepolia and the EIP-3009 helpers the x402 state spikes share. Keys: anvil's public dev
// accounts and keys generated per run; nothing is sent to any public network.
import { gunzipSync } from "node:zlib";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { signTyped, addr } from "micro-eth-signer";
import { encodeFunctionData, decodeFunctionResult, parseAbi, encodeAbiParameters, keccak256 } from "viem";

export const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const CHAIN_ID = 84532;
export const IMPL_SLOT = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3"; // keccak256("org.zeppelinos.proxy.implementation"), FiatTokenProxy
export const abi = parseAbi([
	"function name() view returns (string)",
	"function version() view returns (string)",
	"function symbol() view returns (string)",
	"function decimals() view returns (uint8)",
	"function paused() view returns (bool)",
	"function DOMAIN_SEPARATOR() view returns (bytes32)",
	"function balanceOf(address) view returns (uint256)",
	"function isBlacklisted(address) view returns (bool)",
	"function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
	"function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
	"function cancelAuthorization(address authorizer, bytes32 nonce, bytes signature)",
	"event Transfer(address indexed from, address indexed to, uint256 value)",
	"event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
	"event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)",
]);
export const TOPIC_USED = keccak256(new TextEncoder().encode("AuthorizationUsed(address,bytes32)"));

export const call = async (rpc, fn, args = [], tag = "latest") => {
	const r = await rpc("eth_call", [{ to: USDC, data: encodeFunctionData({ abi, functionName: fn, args }) }, tag]);
	if (r.error) return { error: r.error.message ?? JSON.stringify(r.error) };
	return decodeFunctionResult({ abi, functionName: fn, data: r.result });
};
export const data = (fn, args) => encodeFunctionData({ abi, functionName: fn, args });
export const decodeDump = (hexGz) => JSON.parse(gunzipSync(Buffer.from(hexGz.slice(2), "hex")).toString());

// FiatToken v2.2 keeps balances in mapping slot 9 (found by probing in the x402 spike).
export const balanceSlot = (who) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [who, 9n]));
export const setUsdc = (rpc, who, amount) => rpc("anvil_setStorageAt", [USDC, balanceSlot(who), `0x${amount.toString(16).padStart(64, "0")}`]);

const types = {
	TransferWithAuthorization: [
		{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
		{ name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
	],
};
export const domain = { name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: USDC };
// micro-eth-signer, deterministic: what banda's signer would do (stack.md), not the x402 SDK client.
export function authorize(key, msg) {
	const message = { ...msg, value: BigInt(msg.value), validAfter: BigInt(msg.validAfter), validBefore: BigInt(msg.validBefore) };
	const sig = signTyped({ types, primaryType: "TransferWithAuthorization", domain, message }, key, false);
	return sig;
}
export const randomNonce = () => `0x${bytesToHex(crypto.getRandomValues(new Uint8Array(32)))}`;
export const keccakHex = (s) => `0x${bytesToHex(keccak_256(new TextEncoder().encode(s)))}`;
