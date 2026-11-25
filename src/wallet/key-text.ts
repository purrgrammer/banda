/**
 * A wallet's key as the owner writes it back: the copy they saved, pasted or typed by hand. The key is shown as `0x` and
 * groups of four, so a copy may have spaces or line breaks in it, lack the `0x`, or be in either case; each is the same
 * key. This is the one rule every check of such a copy uses (the save step's check, Restore key); the desktop app,
 * which cannot import this module, keeps the same rule in desktop/src/wallets.ts, and test/desktop-wallets.test.ts holds
 * the two equal.
 */

/** The key `pasted` writes, as `0x` and 64 lowercase hex digits; undefined when it is not the text of a key. */
export function normalKey(pasted: string): string | undefined {
	const bare = pasted.replace(/\s+/g, "").toLowerCase();
	const key = bare.startsWith("0x") ? bare : `0x${bare}`;
	return /^0x[0-9a-f]{64}$/.test(key) ? key : undefined;
}
