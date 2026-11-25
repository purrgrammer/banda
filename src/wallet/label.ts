/**
 * How a wallet is named where the owner or an agent reads it: free of Node's modules, so the web app names it the way
 * the daemon does.
 */
import { plainLine } from "../core/plain-line.ts";
import { foldKey } from "../core/visible.ts";

/** The most characters a wallet's name keeps (UC-01). */
export const NAME_MAX = 64;

/**
 * A name as the daemon keeps it (`plainLine`), folded as banda folds every title the owner reads as the same
 * (`foldKey`: its case fully folded, so "Straße" and "STRASSE" are one): what two wallets may share (H-041), and
 * how a name an agent or the owner types finds the wallet it names, however it was typed (full-width, spaced, ligated).
 */
export const nameKey = (name: string) => foldKey(plainLine(name, NAME_MAX));

/** An address as a row, a card or an agent's label reads it: its start and its end. */
export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/**
 * `value` base units of a token with `decimals` places, in plain digits, at most `shown` places: 1500000 at 6 is "1.5".
 */
export function units(value: bigint, decimals: number, shown = decimals): string {
	const negative = value < 0n;
	const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
	const whole = digits.slice(0, digits.length - decimals);
	const fraction = digits
		.slice(digits.length - decimals)
		.slice(0, shown)
		.replace(/0+$/, "");
	return `${negative ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}

/** A wallet as the owner or an agent is told of it: the owner's name for it and its short address. */
export const walletLabel = (address: string, record: { readonly name: string } | undefined): string =>
	record === undefined ? shortAddress(address) : `${record.name} (${shortAddress(address)})`;
