/**
 * The wallet chooser a link two wallets answer, as the specimen shows it at a phone's width: each row as a wallet's
 * row reads, the short address and then the network whole, with the Testnet mark on a test network (H-039, H-040).
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { type WebServer, webServer } from "./helpers.ts";
import { hasChrome, withPage } from "./smoke/chrome.ts";

let server: WebServer;

beforeAll(async () => {
	if (!hasChrome()) return;
	server = await webServer({
		plugins: [
			{
				name: "wallet-specimen:no-daemon",
				configResolved(config) {
					delete config.server.proxy;
				},
			},
		],
	});
});

afterAll(async () => {
	await server?.close();
});

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(
		`keeps every row of the wallet chooser whole, its network and Testnet mark readable, at ${width}px`,
		async () => {
			const phone = width < 768 ? "&width=phone" : "";
			await withPage(
				`${server.origin}/#/specimen?section=wallet-page&only=1${phone}`,
				{ width, height: 900 },
				async (page) => {
					const rows = `[...document.querySelectorAll('[data-which-wallet] button')]`;
					await page.until(`${rows}.length >= 2`, 30_000);
					await page.run(`document.querySelector('[data-which-wallet]').scrollIntoView({block:'start'})`);
					const read = await page.run<{ text: string; cut: string[] }[]>(
						`${rows}.map((row) => ({
						text: row.innerText,
						cut: [...row.querySelectorAll('span')]
							.filter((el) => el.scrollWidth > el.clientWidth + 1 || el.getBoundingClientRect().right > row.getBoundingClientRect().right + 1)
							.map((el) => el.textContent),
					}))`,
					);
					const test = read.find((row) => row.text.includes("Base Sepolia"));
					expect(test?.text).toContain("Testnet");
					expect(test?.text).toContain("0x5AaE0000…0000eAED");
					expect(read.find((row) => row.text.includes("Groceries"))?.text).not.toContain("Testnet");
					for (const row of read) expect(row.cut, row.text).toEqual([]);
					expect(page.errors()).toEqual([]);
				},
			);
		},
		60_000,
	);

for (const section of ["wallet-page", "wallet-notices"])
	it.skipIf(!hasChrome())(
		`draws ${section}'s money in as the app lists it: ETH from another address, a sender only for USDC`,
		async () => {
			await withPage(
				`${server.origin}/#/specimen?section=${section}&only=1&width=phone`,
				{ width: 390, height: 900 },
				async (page) => {
					await page.until(`document.body.innerText.includes("From another address")`, 30_000);
					// each "From 0x…" line's row: the nearest box around it that holds an amount
					const senders = await page.run<string[]>(`[...document.querySelectorAll('span, p, div')]
						.filter((el) => el.children.length === 0 && /^From 0x/.test(el.textContent.trim()))
						.map((el) => {
							let row = el;
							while (row.parentElement && !/[+−-][\\d.,]+ (ETH|USDC)/.test(row.innerText)) row = row.parentElement;
							return row.innerText.match(/[+−-][\\d.,]+ (ETH|USDC)/)?.[1] ?? "none";
						})`);
					expect(senders.length).toBeGreaterThan(0);
					expect(senders.every((token) => token === "USDC")).toBe(true);
					expect(page.errors()).toEqual([]);
				},
			);
		},
		60_000,
	);

it.skipIf(!hasChrome())(
	"words Receive's acknowledged code by what it records, with no Send this build does not have",
	async () => {
		await withPage(
			`${server.origin}/#/specimen?section=wallet-receive&only=1&width=phone`,
			{ width: 390, height: 900 },
			async (page) => {
				const said =
					"You acknowledged this code, and banda keeps that you know why it runs. Its address stays hidden here, and agents can't use the wallet, while the code is there.";
				await page.until(`document.body.innerText.includes(${JSON.stringify(said)})`, 30_000);
				const text = await page.run<string>("document.body.innerText");
				expect(text).not.toContain("Send goes on");
				expect(text).not.toContain("your own Send");
				expect(page.errors()).toEqual([]);
			},
		);
	},
	60_000,
);
