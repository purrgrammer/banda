/**
 * The one module that imports the signing libraries (docs/wallets/stack.md section 1; H-306). It makes a key, names its
 * address, and signs the two shapes banda pays with and no third (H-150 to H-153): an EIP-1559 transfer, of ETH or of
 * a token through `transfer(address,uint256)` built here from its fixed selector, and an EIP-3009
 * `TransferWithAuthorization` under the token's domain from banda's network table. Every signature is deterministic
 * (`extraEntropy` false, H-161) under a chain id the caller always names (H-155), so a re-sign after a crash gives the
 * same bytes and the same hash (C6). A thrown message is fixed text: never a key, and never a value the caller passed.
 */
// biome-ignore lint/style/noRestrictedImports: this module is the one that signs (H-306)
import { secp256k1 } from "@noble/curves/secp256k1.js";
// biome-ignore lint/style/noRestrictedImports: this module is the one that signs (H-306)
import { bytesToHex } from "@noble/hashes/utils.js";
// biome-ignore lint/style/noRestrictedImports: this module is the one that signs (H-306)
import { addr, signTyped, Transaction } from "micro-eth-signer";
import type { Address } from "./address.ts";
import type { Network } from "./networks.ts";

export type Hex = `0x${string}`;
/** A secp256k1 private key: `0x` and 64 hex digits, the form the owner exports and imports. */
export type Key = Hex;

export type Transfer = {
	readonly key: Key;
	readonly chainId: number;
	readonly nonce: bigint;
	/** `maxFeePerGas`, in wei. */
	readonly maxFee: bigint;
	/** `maxPriorityFeePerGas`, in wei. */
	readonly tip: bigint;
	readonly gasLimit: bigint;
	/** Who is paid: the transaction's recipient for ETH, the `transfer` argument for a token. */
	readonly to: Address;
	/** Wei for ETH, the token's base units for a token. */
	readonly value: bigint;
	/** The token's contract; absent for ETH. */
	readonly token?: Address;
};

/** The token a `TransferWithAuthorization` moves, with the EIP-712 domain banda's network table pins for it. */
export type AuthorizedToken = Pick<NonNullable<Network["usdc"]>, "address" | "name" | "version">;

export type TransferAuthorization = {
	readonly key: Key;
	readonly chainId: number;
	readonly token: AuthorizedToken;
	readonly to: Address;
	readonly value: bigint;
	/** Unix seconds. */
	readonly validAfter: bigint;
	/** Unix seconds. */
	readonly validBefore: bigint;
	/** 32 bytes, `0x` and 64 hex digits. */
	readonly nonce: Hex;
};

const TRANSFER_SELECTOR = "a9059cbb";
const MAX_UINT256 = (1n << 256n) - 1n;
/** EIP-2681: a nonce of 2^64 - 1 or more is invalid. */
const MAX_NONCE = (1n << 64n) - 2n;
const BASE_GAS = 21_000n;
const MAX_GAS = 30_000_000n;
/** 10,000 gwei: no fee banda pays comes near it, so one past it is a unit mistake. */
const MAX_FEE = 10n ** 13n;
/** C19: a window is anchored to both clocks, at most 120 s apart, plus 5 s before and 60 s after. */
const MAX_WINDOW = 185n;

function refuse(what: string): never {
	throw new Error(`cannot sign: ${what}`);
}

function checkKey(key: unknown): Key {
	if (typeof key !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(key)) refuse("the key is not 0x and 64 hex digits");
	let valid = false;
	try {
		valid = addr.isValidPrivateKey(key);
	} catch {}
	if (!valid) refuse("the key is not a secp256k1 private key");
	return key.toLowerCase() as Key;
}

function checkChainId(chainId: unknown): bigint {
	if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0)
		refuse("the chain id is missing or not a positive integer");
	return BigInt(chainId);
}

function isAddress(address: unknown): address is Address {
	try {
		return typeof address === "string" && /^0x[0-9a-fA-F]{40}$/.test(address) && addr.isValid(address);
	} catch {
		return false;
	}
}

function checkAddress(address: unknown, what: string): Address {
	if (!isAddress(address)) refuse(`${what} is not an address`);
	return address;
}

function checkUint(value: unknown, max: bigint, what: string): bigint {
	if (typeof value !== "bigint" || value < 0n || value > max) refuse(`${what} is out of range`);
	return value;
}

const word = (hex: string) => hex.padStart(64, "0");

/**
 * The least gas a pool admits a transaction with: the base cost and the calldata's, at EIP-7623's floor price of 10
 * gas per token (a zero byte one token, any other four), which is above EIP-2028's 4 and 16 for any calldata.
 */
function intrinsicGas(data: string): bigint {
	let tokens = 0n;
	for (let i = 2; i < data.length; i += 2) tokens += data.slice(i, i + 2) === "00" ? 1n : 4n;
	return BASE_GAS + 10n * tokens;
}

/**
 * A fresh key: noble's `randomSecretKey`, a scalar drawn from the platform's secure random source (stack.md section 1).
 */
export function generateKey(): Key {
	const secret = secp256k1.utils.randomSecretKey();
	try {
		return checkKey(`0x${bytesToHex(secret)}`);
	} finally {
		secret.fill(0);
	}
}

/** The key's address, with its EIP-55 checksum. */
export function addressOf(key: Key): Address {
	const checked = checkKey(key);
	try {
		return addr.fromPrivateKey(checked) as Address;
	} catch {
		return refuse("the key is not a secp256k1 private key");
	}
}

/** Signs an EIP-1559 transfer; `raw` is the bytes to store and broadcast, `hash` their keccak256, taken once here. */
export function signTransfer(transfer: Transfer): { raw: Hex; hash: Hex } {
	const key = checkKey(transfer.key);
	const chainId = checkChainId(transfer.chainId);
	const nonce = checkUint(transfer.nonce, MAX_NONCE, "the nonce");
	const maxFee = checkUint(transfer.maxFee, MAX_FEE, "the max fee");
	if (maxFee === 0n) refuse("the max fee is out of range");
	const tip = checkUint(transfer.tip, maxFee, "the tip");
	const gasLimit = checkUint(transfer.gasLimit, MAX_GAS, "the gas limit");
	const to = checkAddress(transfer.to, "the recipient");
	const value = checkUint(transfer.value, MAX_UINT256, "the value");
	const fields =
		transfer.token === undefined
			? { to, value, data: "0x" }
			: {
					to: checkAddress(transfer.token, "the token"),
					value: 0n,
					data: `0x${TRANSFER_SELECTOR}${word(to.slice(2).toLowerCase())}${word(value.toString(16))}`,
				};
	if (gasLimit < intrinsicGas(fields.data)) refuse("the gas limit is below a transfer's");
	try {
		const signed = Transaction.prepare(
			{ ...fields, type: "eip1559", nonce, chainId, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip, gasLimit },
			false,
		).signBy(key, false);
		return {
			raw: signed.toHex({ includeSignature: true }).toLowerCase() as Hex,
			hash: signed.hash.toLowerCase() as Hex,
		};
	} catch {
		return refuse("the transaction was refused by the encoder");
	}
}

/** Signs an EIP-3009 `TransferWithAuthorization` from the key's own address. */
export function signTransferWithAuthorization(authorization: TransferAuthorization): { from: Address; signature: Hex } {
	const key = checkKey(authorization.key);
	const chainId = checkChainId(authorization.chainId);
	const { token } = authorization;
	const verifyingContract = checkAddress(token?.address, "the token");
	if (typeof token.name !== "string" || token.name === "") refuse("the token's domain has no name");
	if (typeof token.version !== "string" || token.version === "") refuse("the token's domain has no version");
	const to = checkAddress(authorization.to, "the recipient");
	const value = checkUint(authorization.value, MAX_UINT256, "the value");
	const validAfter = checkUint(authorization.validAfter, MAX_UINT256, "the start of validity");
	const validBefore = checkUint(authorization.validBefore, MAX_UINT256, "the end of validity");
	if (validBefore <= validAfter) refuse("the validity window is empty");
	if (validBefore - validAfter > MAX_WINDOW) refuse("the validity window is longer than 185 s");
	const { nonce } = authorization;
	if (typeof nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) refuse("the nonce is not 32 bytes");
	const from = addressOf(key);
	try {
		const signature = signTyped(
			{
				types: {
					TransferWithAuthorization: [
						{ name: "from", type: "address" },
						{ name: "to", type: "address" },
						{ name: "value", type: "uint256" },
						{ name: "validAfter", type: "uint256" },
						{ name: "validBefore", type: "uint256" },
						{ name: "nonce", type: "bytes32" },
					],
				},
				primaryType: "TransferWithAuthorization",
				domain: { name: token.name, version: token.version, chainId, verifyingContract },
				message: { from, to, value, validAfter, validBefore, nonce },
			},
			key,
			false,
		);
		return { from, signature: signature.toLowerCase() as Hex };
	} catch {
		return refuse("the authorization was refused by the encoder");
	}
}
