/**
 * What a pool's refusal of `eth_sendRawTransaction` means for the lane (H-185, C12). Codes do not tell the cases
 * apart (geth and reth answer `-32000`, reth `-32003` for funds, anvil `-32003` for all), so the message decides,
 * case-insensitively, by the wording measured on geth 1.17.10, reth 2.10.1 and anvil 1.9.0
 * (docs/wallets/spikes/gaps/README.md section D, docs/wallets/spikes/nonce-and-crash). Anything else, and any answer
 * that is not a pool's (a timeout, a lost connection, an HTTP error, a rate limit), is `other`: maybe sent, never
 * failed (H-184).
 */
export type PoolClass = "known" | "nonce_low" | "underpriced" | "funds" | "fee_low" | "other";

/**
 * Checked in order, so a replacement's "replacement transaction underpriced" is `underpriced` before reth's bare
 * "transaction underpriced", a floor refusal, reaches `fee_low`.
 */
const TABLE: readonly (readonly [PoolClass, RegExp])[] = [
	// geth and reth "already known"; anvil "transaction already imported"; older geth "known transaction: <hash>".
	// Whole words, so "unknown transaction type" is not taken for bytes the pool holds.
	["known", /\balready known\b|\balready imported\b|\bknown transaction\b/],
	// geth and reth "nonce too low: next nonce 1, tx nonce 0"; anvil "nonce too low"
	["nonce_low", /nonce too low/],
	// geth, reth and anvil: a new payload at a held nonce without enough of a bump
	["underpriced", /replacement transaction underpriced/],
	// geth "insufficient funds for gas * price + value: balance …"; reth "… have 0 want …"; anvil "Insufficient funds …"
	["funds", /insufficient funds/],
	// anvil "max fee per gas less than block base fee"; reth "transaction underpriced"; geth "transaction gas price
	// below minimum: gas tip cap 0, minimum needed 1"
	["fee_low", /max fee per gas less than block base fee|transaction underpriced|gas price below minimum/],
];

/** The class of a pool's message, as the node wrote it. */
export function classifyMessage(message: string): PoolClass {
	const lower = message.toLowerCase();
	for (const [kind, pattern] of TABLE) if (pattern.test(lower)) return kind;
	return "other";
}
