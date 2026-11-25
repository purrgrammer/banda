/**
 * Every reason a wallet can be offline has its copy and a specimen state (H-317): a reason added to `OFFLINE` without a
 * screen here fails, so the specimen shows every notice the app can.
 */
import { describe, expect, it } from "vitest";

// the app's modules read the page they run in as they load: a bare one stands in, so they load here
const storage = () => {
	const kept = new Map<string, string>();
	return {
		getItem: (key: string) => kept.get(key) ?? null,
		setItem: (key: string, value: string) => void kept.set(key, value),
		removeItem: (key: string) => void kept.delete(key),
	};
};
Object.assign(globalThis, {
	location: new URL("http://127.0.0.1/#/specimen"),
	localStorage: storage(),
	sessionStorage: storage(),
	history: { replaceState() {}, pushState() {} },
	addEventListener() {},
	CSS: { escape: (text: string) => text, supports: () => false },
	matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	removeEventListener() {},
});
const { OFFLINE } = await import("../../chat/Wallets.tsx");
const { NOT_HERE_REASONS, NOTICE_REASONS, OFFLINE_ROWS } = await import("./wallet.tsx");

describe("the wallet specimen", () => {
	it("shows every offline reason as a wallet's notice, its body and its fix, not only as a Settings row", () => {
		// a wallet's page draws a notice for every reason it is offline (WalletPages.tsx `Notices`): each has a screen
		// of its own, and the Settings rows, which show the title alone, count for none
		expect([...NOTICE_REASONS].sort()).toEqual(Object.keys(OFFLINE).sort());
		const rows = new Set(OFFLINE_ROWS.flatMap((row) => (row.offline === undefined ? [] : [row.offline])));
		for (const reason of rows) expect(Object.keys(OFFLINE), reason).toContain(reason);
	});

	it("shows every reason whose fix is made elsewhere as a browser sees it", () => {
		const elsewhere = Object.entries(OFFLINE).flatMap(([reason, words]) =>
			words.elsewhere === undefined ? [] : [reason],
		);
		expect([...NOT_HERE_REASONS].sort()).toEqual(elsewhere.sort());
	});

	it("gives every reason its copy", () => {
		for (const [reason, words] of Object.entries(OFFLINE)) {
			expect(words.title.length, reason).toBeGreaterThan(0);
			expect(words.body.length, reason).toBeGreaterThan(0);
		}
	});
});
