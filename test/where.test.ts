/** The app's places in the hash: read and written back the same; anything else is home. */
import { describe, expect, it } from "vitest";
import { hrefOf, isSourceHref, lastOf, parse, routedTo, routesTo, walletRoute } from "../web/src/app/where.ts";

describe("where", () => {
	it("reads each place and writes it back", () => {
		for (const hash of [
			"#/",
			"#/a/sancho",
			"#/a/mara-2?at=41",
			"#/g/7",
			"#/g/7?at=3",
			"#/settings",
			"#/settings?tab=wallets",
			"#/connections",
			"#/wallets/new",
			"#/wallets/new?agent=mara",
			"#/wallets/0x5aae-eaed",
			"#/wallets/0x5aae-eaed?tab=wallet",
			"#/wallets/0x5aae-eaed/key",
			"#/wallets/0x5aae-eaed/receive",
			"#/wallets/0x5aae-eaed/restore",
			"#/specimen",
		])
			expect(hrefOf(parse(hash))).toBe(hash);
	});

	it("links a wallet by its address's ends alone, never the whole address a location bar would give out (H-005)", () => {
		const address = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
		expect(walletRoute(address)).toBe("0x5aae-eaed");
		expect(hrefOf({ name: "wallet", address, page: "receive" })).toBe("#/wallets/0x5aae-eaed/receive");
		expect(hrefOf({ name: "wallet", address })).not.toContain(address.slice(6, -4));
		expect(hrefOf(parse(`#/wallets/${address}/key`))).toBe("#/wallets/0x5aae-eaed/key");
		expect(routesTo(address, "0x5aae-eaed")).toBe(true);
		expect(routesTo(address, address.toLowerCase())).toBe(true);
		expect(routesTo(address, "0x5aae-eaee")).toBe(false);
		expect(parse("#/wallets/0x5AAE-EAED")).toEqual({ name: "home" });
	});

	it("names every wallet whose address shares a route's ends, so the page asks which, never the first alone", () => {
		const one = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
		const two = "0x5AaE00000000000000000000000000000000eAED";
		const other = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
		expect(walletRoute(one)).toBe(walletRoute(two));
		expect(routedTo([one, other, two], "0x5aae-eaed")).toEqual([one, two]);
		// the whole address still names one, whatever its case
		expect(routedTo([one, other, two], two.toLowerCase())).toEqual([two]);
		expect(routedTo([one, other, two], "0x5aae-eaee")).toEqual([]);
	});

	it("reads a wallet only by its whole address or its route, and drops a tab or an agent it does not know", () => {
		expect(parse("#/wallets/0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe")).toEqual({ name: "home" });
		expect(parse("#/wallets/0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed/send")).toEqual({ name: "home" });
		expect(parse("#/wallets/0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed?tab=keys")).toEqual({
			name: "wallet",
			address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
		});
		expect(parse("#/wallets/new?agent=Bad Name")).toEqual({ name: "wallet" });
		expect(parse("#/settings?tab=secrets")).toEqual({ name: "settings" });
	});

	it("takes anything else as home, and a bad entry as none", () => {
		expect(parse("#/inbox")).toEqual({ name: "home" });
		expect(parse("#/a/Bad Name")).toEqual({ name: "home" });
		expect(parse("#/a/mara?at=-3")).toEqual({ name: "agent", id: "mara" });
		expect(parse("")).toEqual({ name: "home" });
	});

	it("remembers only a chat as the last place", () => {
		expect(lastOf("#/a/mara?at=9")).toEqual({ name: "agent", id: "mara" });
		expect(lastOf("#/g/4")).toEqual({ name: "group", room: 4 });
		expect(lastOf("#/settings")).toBeUndefined();
		expect(lastOf(null)).toBeUndefined();
	});
});

it("only canonical search source links open inside the app", () => {
	for (const href of ["#/a/mara?at=9", "#/g/4?at=17", "#/artifact/abc123"]) expect(isSourceHref(href)).toBe(true);
	for (const href of [
		undefined,
		"https://example.com/#/a/mara",
		"javascript:alert(1)",
		"#/settings",
		"#token=secret",
		"#/a/mara?token=secret",
		"#/g/-1",
		"#/a/mara?at=9007199254740992",
		"#/artifact/abc123?v=0",
		"#/a/mara?at=1&token=secret",
	])
		expect(isSourceHref(href)).toBe(false);
});
