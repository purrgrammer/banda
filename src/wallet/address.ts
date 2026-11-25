/**
 * An address in its EIP-55 form, the one form every stored key names an address in (C18). The checksum's keccak-256 is
 * Node's own (OpenSSL), so building a store key never loads the signing module (C20, H-306).
 */
import { createHash } from "node:crypto";

/**
 * An address: `0x` and 40 hex digits in a form EIP-55 accepts (all lowercase, all uppercase, or a valid checksum). The
 * signing module takes any of the three; `checksummed` returns the EIP-55 form, the one a stored key names.
 */
export type Address = `0x${string}`;

const HEX = /^0x[0-9a-fA-F]{40}$/;

function checksum(digits: string): Address {
	const hash = createHash("keccak-256").update(digits).digest();
	let out = "0x";
	for (let i = 0; i < digits.length; i++) {
		const nibble = ((hash[i >> 1] ?? 0) >> (i % 2 === 0 ? 4 : 0)) & 15;
		out += nibble >= 8 ? (digits[i] ?? "").toUpperCase() : digits[i];
	}
	return out as Address;
}

/**
 * All lowercase, all uppercase, or a mixed case whose checksum holds, as EIP-55 accepts; a mixed case that fails it is
 * a mistyped address and is refused, as is anything else, with the fixed text "not an address".
 */
export function checksummed(address: unknown): Address {
	if (typeof address !== "string" || !HEX.test(address)) throw new Error("not an address");
	const digits = address.slice(2);
	const result = checksum(digits.toLowerCase());
	const lower = digits === digits.toLowerCase();
	const upper = digits === digits.toUpperCase();
	if (!lower && !upper && result !== address) throw new Error("not an address");
	return result;
}
