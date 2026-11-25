/**
 * The proof C7 asks of a fetched transaction, made the way the lane makes it: the fields the RPC answered are
 * serialised again, their hash must be the transaction's, and the signer is recovered from them, never read from the
 * RPC's `from`.
 */
import {
	type Hex,
	keccak256,
	numberToHex,
	recoverTransactionAddress,
	type Signature,
	serializeTransaction,
	type TransactionSerializable,
} from "viem";
import type { Transaction } from "../../src/wallet/rpc.ts";

const hex = (value: string) => value as Hex;
const word = (value: bigint) => numberToHex(value, { size: 32 });

/** What `tx` was signed as, with its signature; throws when the RPC left out what the proof needs. */
function signed(tx: Transaction): { unsigned: TransactionSerializable; signature: Signature } {
	if (tx.r === undefined || tx.s === undefined) throw new Error("no signature");
	const common = {
		nonce: Number(tx.nonce),
		gas: tx.gas,
		to: tx.to === null ? null : hex(tx.to),
		value: tx.value,
		data: hex(tx.input),
	};
	const accessList = (tx.accessList ?? []).map((entry) => ({
		address: hex(entry.address),
		storageKeys: entry.storageKeys.map(hex),
	}));
	const yParity = Number(tx.yParity ?? tx.v ?? 0n);
	const signature = { r: word(tx.r), s: word(tx.s), yParity };
	const chainId = tx.chainId === undefined ? undefined : Number(tx.chainId);
	if (tx.type === 0n) {
		if (tx.v === undefined) throw new Error("no v");
		return {
			unsigned: { ...common, type: "legacy", gasPrice: tx.gasPrice, ...(chainId === undefined ? {} : { chainId }) },
			signature: { r: word(tx.r), s: word(tx.s), v: tx.v },
		};
	}
	if (chainId === undefined) throw new Error("no chain id");
	if (tx.type === 1n)
		return { unsigned: { ...common, type: "eip2930", chainId, gasPrice: tx.gasPrice, accessList }, signature };
	const fees = { maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas };
	if (tx.type === 2n) return { unsigned: { ...common, type: "eip1559", chainId, ...fees, accessList }, signature };
	if (tx.type === 4n)
		return {
			unsigned: {
				...common,
				type: "eip7702",
				chainId,
				...fees,
				accessList,
				authorizationList: (tx.authorizationList ?? []).map((entry) => ({
					address: hex(entry.address),
					chainId: Number(entry.chainId),
					nonce: Number(entry.nonce),
					r: word(entry.r),
					s: word(entry.s),
					yParity: Number(entry.yParity),
				})),
			},
			signature,
		};
	throw new Error(`type ${tx.type} is not one banda proves`);
}

/** The address that signed `tx`; throws when the fields do not hash to `tx.hash`. */
export async function signerOf(tx: Transaction): Promise<string> {
	const { unsigned, signature } = signed(tx);
	const serialized = serializeTransaction(unsigned, signature);
	if (keccak256(serialized) !== tx.hash.toLowerCase()) throw new Error("the fields are not the transaction's");
	return recoverTransactionAddress({ serializedTransaction: serialized as never });
}
