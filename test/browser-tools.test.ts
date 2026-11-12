/**
 * Browsing never asks unless it acts as the owner (DESIGN.md "The box", The browser), without Docker: the browser tools
 * against a scripted browser and a fake proxy. Opening an address never asks, whatever the chat read before; typing and
 * a page's writes run at once on a page no session of the owner's goes with, each write through the proxy once by its
 * hash; on a site the owner signed in to (`SignedIn`), or with a credential header, each is a draft on the floor; a
 * write carrying a secret is never drafted. And how a host and its cookies are matched to a signed-in site.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, type Harness, type TaskId } from "@earendil-works/pi-durable";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Action, type Browser, type PageWrite, Refused, writeHash } from "../src/box/browser.ts";
import { browserTools, keepSignedIn, SignedIn, sessionOf, siteName } from "../src/box/browser-tools.ts";
import { ActivityLog } from "../src/core/activity.ts";
import { AgentChats, LEAD } from "../src/core/agents.ts";
import type { Taken } from "../src/core/egress.ts";
import { OWNER } from "../src/core/gateway.ts";
import { openWaits } from "../src/core/status.ts";
import { context, openStore } from "../src/core/store.ts";
import type { TurnResult } from "../src/core/turn.ts";
import { type Ask, answer } from "../src/core/wait.ts";
import { argList, draftParts } from "../web/src/lib/chat.ts";
import { openConnected } from "./fixtures/connected.ts";
import { answerNudge } from "./fixtures/models.ts";
import { tempHome, until } from "./helpers.ts";
import { pbtRuns } from "./pbt.ts";

/** What the page writes when its button is clicked: its address, headers and body, and whether it carries a secret. */
type Form = {
	readonly url: string;
	readonly headers?: readonly (readonly [string, string])[];
	readonly body?: string;
	readonly secret?: boolean;
};

/**
 * A browser with one page: a text field (s1e1), a password field (s1e2) and a button (s1e3) that makes the page write
 * `form`. The cookies it holds are those of `cookies`, by host. What it typed, and what it let go, are kept.
 */
function scriptedBrowser(cookies: { [host: string]: readonly string[] }) {
	let url = "about:blank";
	let held: PageWrite | undefined;
	let next = 0;
	let form: Form | undefined;
	const typed: string[] = [];
	const released: PageWrite[] = [];
	/** Each address opened, and the signed-in site it was let open as the owner allowed once. */
	const opened: { readonly url: string; readonly as?: string }[] = [];
	const host = () => {
		try {
			return new URL(url).host || undefined;
		} catch {
			return undefined;
		}
	};
	const page = () =>
		`Page "Form" at ${url}\n- textbox "Comment" [ref=s1e1]\n- textbox "Password" [ref=s1e2]\n- button "Save" [ref=s1e3]` +
		(held === undefined ? "" : `\n\n[banda] The page tried to send ${held.method} ${held.url} (write ${held.id}).`);
	const browser: Browser = {
		snapshot: async () => page(),
		act: async (_chat: number, action: Action) => {
			if (action.type === "navigate") {
				url = action.url;
				opened.push({ url: action.url, ...(action.as === undefined ? {} : { as: action.as }) });
			} else if (action.type === "type") {
				if (action.ref === "s1e2") throw new Refused("That field is for a secret, which is never yours to type.");
				typed.push(action.text);
			} else if (action.type === "click" && form !== undefined) {
				const body = Buffer.from(form.body ?? "comment=hi");
				held = {
					id: `w${++next}`,
					chat: 1,
					method: "POST",
					url: form.url,
					headers: form.headers ?? [["Content-Type", "application/x-www-form-urlencoded"]],
					body: body.toString("base64"),
					hash: writeHash("POST", form.url, body),
					page: url,
					origin: url,
					secret: form.secret === true,
					cookies: cookies[new URL(form.url).hostname] ?? [],
				};
			}
			return page();
		},
		screenshot: async () => "",
		element: (_chat, ref) =>
			ref === "s1e1"
				? { node: 1, role: "textbox", name: "Comment", sensitive: false }
				: ref === "s1e2"
					? { node: 2, role: "textbox", name: "Password", sensitive: true }
					: "not on the page",
		site: () => host(),
		cookies: async (_chat, at) => {
			let name: string;
			try {
				name = new URL(at ?? url).hostname;
			} catch {
				return null;
			}
			return name === "" ? null : (cookies[name] ?? []);
		},
		writes: async (chat) => (held === undefined ? [] : [{ ...held, chat }]),
		release: async (_chat, id, pass) => {
			if (held === undefined || held.id !== id) throw new Refused("That write is gone: nothing was sent.");
			const write = held;
			await pass(write);
			released.push(write);
			held = undefined;
			return page();
		},
		drop: async () => {
			held = undefined;
		},
		key: () => undefined,
		view: () => ({ running: true, chat: 1, control: "agent" }),
		watch: () => () => {},
		hold: async () => ({ running: true, chat: 1, control: "agent" }),
		input: async () => {},
		forget: async () => {},
		close: () => {},
	};
	return {
		browser,
		typed,
		released,
		opened,
		/** What the button makes the page write from now on. */
		form: (next: Form) => {
			form = next;
		},
	};
}

type Step = readonly [string, Record<string, unknown>];

async function setup(
	cookies: { [host: string]: readonly string[] } = {},
	giveBack: () => Promise<void> = async () => {},
) {
	const home = await tempHome();
	const page = scriptedBrowser(cookies);
	/** The hashes the proxy was told to let pass, by chat. */
	const passes: [number, string][] = [];
	/** What the proxy saw each chat read since its last take. */
	const reads = new Map<number, string[]>();
	let plan: readonly Step[] = [];
	let store: Harness | undefined;
	const respond = (ctx: { messages: readonly { role: string; content: unknown }[] }) => {
		const heed = answerNudge(ctx.messages);
		if (heed !== undefined) return heed;
		const after = ctx.messages.length - [...ctx.messages].reverse().findIndex((m) => m.role === "user");
		const done = ctx.messages.slice(after).filter((m) => m.role === "toolResult").length;
		const step = plan[done];
		if (step === undefined) return fauxAssistantMessage("Done.");
		return fauxAssistantMessage([fauxToolCall(step[0], step[1] as never, { id: `c${Math.random()}` })], {
			stopReason: "toolUse",
		});
	};
	const s = await openConnected({
		home,
		respond: respond as never,
		install: (core, registry) =>
			registry.install(
				defineExtension({
					name: "banda.browser",
					tools: browserTools({
						browser: async () => page.browser,
						egress: {
							release: async () => [],
							take: async (chat): Promise<Taken> => {
								const read = reads.get(chat) ?? [];
								reads.delete(chat);
								return { held: [], reads: read, readBytes: read.length };
							},
							ack: async () => {},
							replay: async () => ({ refused: "not here" }),
							pass: async (chat, hash) => {
								passes.push([chat, hash]);
							},
						},
						effect: core.effect,
						ask: core.ask,
						keep: async () => {
							throw new Error("no keys here");
						},
						giveBack: () => giveBack(),
						// as the daemon keeps a sign-in: for the agent the chat runs
						signedIn: async (site, chat) => {
							await store?.commit(async (tx) => {
								const agent = (await tx.doc(AgentChats)).chats[chat];
								if (agent !== undefined) await keepSignedIn(tx, agent, site, chat, 1);
							}, context);
						},
					}),
				}),
			),
	});
	store = s.harness;
	let n = 0;
	/** The owner says something whose run follows `steps`; its chat and Turn. */
	const say = async (steps: readonly Step[], thread = "t") => {
		plan = steps;
		const received = await s.core.receive(s.harness, {
			id: `m${++n}`,
			origin: { gateway: "fake", peer: OWNER },
			text: `go ${n}`,
			thread,
		} as never);
		if (!("turn" in received)) throw new Error(`no Turn: ${JSON.stringify(received)}`);
		return { chat: received.chat, turn: received.turn };
	};
	const done = async (turn: number) =>
		(await s.harness.getTask(turn as TaskId<TurnResult>, context))?.state.status === "terminal";
	/** The next open ask, or none once the Turn ended. */
	const nextAsk = (turn: number) =>
		until(async () => {
			const [wait] = await openWaits(s.harness);
			if (wait !== undefined) return { wait };
			return (await done(turn)) ? { wait: undefined } : undefined;
		});
	const results = async (chat: number) => {
		const entries = await (await s.harness.conversation(String(chat) as never, context))!.entries(
			{ order: "ascending" },
			1000,
			undefined,
			context,
		);
		return entries.items
			.filter((e) => e.kind === "pi.tool-result")
			.map((e) =>
				((e.model?.[0] as { content?: { text?: string }[] } | undefined)?.content ?? []).map((p) => p.text).join(""),
			);
	};
	const activity = async () => (await s.harness.snapshot(ActivityLog, context))?.events ?? [];
	/** The owner signed in to `site` in the lead's browser. */
	const signIn = (site: string) => s.harness.commit((tx) => keepSignedIn(tx, LEAD, site, 0, 1), context);
	return { ...s, page, passes, reads, say, done, nextAsk, results, activity, signIn };
}

const SITE = "https://shop.example";
const web = { gateway: "web", peer: OWNER };

describe("the browser, as nobody", () => {
	it("opens any address unasked, in a chat that read the web before", async () => {
		const s = await setup();
		try {
			const first = await s.say([["browser_navigate", { url: `${SITE}/` }]]);
			s.reads.set(first.chat, ["shop.example"]);
			expect((await s.nextAsk(first.turn)).wait).toBeUndefined();
			const second = await s.say([
				["browser_navigate", { url: "https://elsewhere.example/?q=what+the+page+said" }],
				["browser_navigate", { url: "back" }],
			]);
			expect((await s.nextAsk(second.turn)).wait).toBeUndefined();
			const pages = (await s.results(first.chat)).filter((said) => said.startsWith('Page "Form"'));
			expect(pages).toHaveLength(3);
			expect(pages[1]).toContain('Page "Form" at https://elsewhere.example/?q=what+the+page+said');
			expect((await s.activity()).some((e) => e.outside === "read")).toBe(true);
		} finally {
			await s.close();
		}
	});

	it("types at once on a page no session of the owner's goes with; a secret field is still refused", async () => {
		const s = await setup({ "shop.example": ["analytics.example"] });
		try {
			// a site the owner signed in to elsewhere: not this one
			await s.signIn("bank.example");
			const run = await s.say([
				["browser_navigate", { url: `${SITE}/` }],
				["browser_type", { ref: "s1e1", text: "a kind word" }],
				["browser_type", { ref: "s1e2", text: "hunter2" }],
			]);
			expect((await s.nextAsk(run.turn)).wait).toBeUndefined();
			expect(s.page.typed).toEqual(["a kind word"]);
			const said = await s.results(run.chat);
			expect(said[2]).toContain("never yours to type");
		} finally {
			await s.close();
		}
	});

	it("lets a page's write go at once, through the proxy once by its hash, unasked, and logs it as sent", async () => {
		const s = await setup({ "shop.example": ["shop.example"] });
		try {
			// its cookies go with it, as a browser's do: the shop's own, of a site the owner never signed in to
			s.page.form({
				url: `${SITE}/comments`,
				headers: [
					["Content-Type", "application/x-www-form-urlencoded"],
					["Cookie", "visitor=v1"],
				],
			});
			const run = await s.say([
				["browser_navigate", { url: `${SITE}/` }],
				["browser_click", { ref: "s1e3" }],
			]);
			expect((await s.nextAsk(run.turn)).wait).toBeUndefined();
			expect(s.page.released).toHaveLength(1);
			const write = s.page.released[0]!;
			expect(s.passes).toEqual([[run.chat, writeHash("POST", `${SITE}/comments`, Buffer.from("comment=hi"))]]);
			expect(write.hash).toBe(s.passes[0]![1]);
			const said = await s.results(run.chat);
			expect(said[1]).toContain(`[banda] The page sent POST ${SITE}/comments (write w1)`);
			expect(said[1]).not.toContain("(write w1). It");
			const sent = (await s.activity()).filter((e) => e.outside === "sent");
			expect(sent.map((e) => e.what)).toEqual([`Sent POST ${SITE}/comments from the browser`]);
			// asked to send it again: it is gone, nothing goes twice
			const again = await s.say([["browser_send", { write: "w1" }]]);
			await s.nextAsk(again.turn);
			await until(() => s.done(again.turn));
			expect(s.passes).toHaveLength(1);
		} finally {
			await s.close();
		}
	});
});

describe("the browser, as the owner", () => {
	it("opening a signed-in site asks, binding the site, for once or the task; allowed, it opens freely in that task", async () => {
		const s = await setup();
		try {
			await s.signIn("shop.example");
			const run = await s.say([
				["browser_navigate", { url: `${SITE}/orders?id=1` }],
				["browser_navigate", { url: "https://www.shop.example/account" }],
			]);
			const { wait } = await s.nextAsk(run.turn);
			expect(s.page.opened).toEqual([]);
			expect(wait?.ask).toMatchObject({
				type: "approval",
				tool: "browser_navigate",
				label: "open shop.example as you",
				args: { site: "shop.example", address: `${SITE}/orders?id=1` },
				permission: { match: { site: "shop.example" }, lasts: ["task"] },
			});
			expect(wait?.ask).not.toHaveProperty("floor");
			expect(wait?.ask.type === "approval" && wait.ask.scopes?.map((one) => one.scope)).toEqual(["task"]);
			// any other scope is refused: allowing the visit lasts the task at most
			expect(
				await answer(s.harness, wait!.key, "approve", web, "bearer", {
					approving: { permission: { scope: "always" } },
				}),
			).toMatchObject({ refused: expect.any(String) });
			await answer(s.harness, wait!.key, "approve", web, "bearer", { approving: { permission: { scope: "task" } } });
			await until(() => s.done(run.turn));
			// the first opened as allowed once; the second, another page of the site, unasked within the task
			expect(s.page.opened).toEqual([
				{ url: `${SITE}/orders?id=1`, as: "shop.example" },
				{ url: "https://www.shop.example/account" },
			]);
			// the owner's next message is another task: the site asks again
			const next = await s.say([["browser_navigate", { url: `${SITE}/` }]]);
			expect((await s.nextAsk(next.turn)).wait?.ask).toMatchObject({ tool: "browser_navigate" });
		} finally {
			await s.close();
		}
	});

	it("approved once, the site opens for that navigation alone", async () => {
		const s = await setup();
		try {
			await s.signIn("shop.example");
			const run = await s.say([
				["browser_navigate", { url: `${SITE}/` }],
				["browser_navigate", { url: `${SITE}/again` }],
			]);
			const first = (await s.nextAsk(run.turn)).wait!;
			await answer(s.harness, first.key, "approve", web, "bearer");
			const second = await until(async () => (await openWaits(s.harness)).find((w) => w.key !== first.key));
			expect(second.ask).toMatchObject({ tool: "browser_navigate", args: { address: `${SITE}/again` } });
			await answer(s.harness, second.key, "deny", web, "bearer");
			await until(() => s.done(run.turn));
			expect(s.page.opened).toEqual([{ url: `${SITE}/`, as: "shop.example" }]);
		} finally {
			await s.close();
		}
	});

	it("typing on a site the owner signed in to is a draft on the floor, asked every time, even with the visit allowed", async () => {
		const s = await setup();
		try {
			await s.signIn("shop.example");
			const run = await s.say([
				["browser_navigate", { url: `${SITE}/` }],
				["browser_type", { ref: "s1e1", text: "a kind word" }],
			]);
			const visit = (await s.nextAsk(run.turn)).wait!;
			await answer(s.harness, visit.key, "approve", web, "bearer", { approving: { permission: { scope: "task" } } });
			const wait = await until(async () => (await openWaits(s.harness)).find((w) => w.key !== visit.key));
			expect(s.page.typed).toEqual([]);
			expect(wait?.ask).toMatchObject({
				type: "approval",
				tool: "browser_type",
				floor: "credentials",
				editable: ["text"],
				args: {
					site: "shop.example",
					field: "“Comment”",
					text: "a kind word",
					"with your session at": "shop.example",
				},
			});
			expect(wait?.ask.type === "approval" && wait.ask.scopes).toEqual([]);
			await answer(s.harness, wait!.key, "approve", web, "bearer", { approving: { edits: { text: "kinder" } } });
			await until(() => s.done(run.turn));
			expect(s.page.typed).toEqual(["kinder"]);
		} finally {
			await s.close();
		}
	});

	it("a page's write with the session of a site the owner signed in to is a floor draft; approved, it goes once", async () => {
		// signed in on the shop's accounts host: its session cookie is the shop's whole domain's
		const s = await setup({ "api.shop.example": ["shop.example"] });
		try {
			await s.signIn("accounts.shop.example");
			s.page.form({ url: "https://api.shop.example/keys", body: "label=banda" });
			const run = await s.say([
				["browser_navigate", { url: "https://blog.example/" }],
				["browser_click", { ref: "s1e3" }],
				["browser_send", { write: "w1" }],
			]);
			const { wait } = await s.nextAsk(run.turn);
			expect(s.passes).toEqual([]);
			expect(wait?.ask).toMatchObject({
				tool: "browser_send",
				floor: "credentials",
				args: {
					method: "POST",
					address: "https://api.shop.example/keys",
					"with your session at": "accounts.shop.example",
				},
			});
			expect((await s.results(run.chat))[1]).toContain("(write w1)");
			await answer(s.harness, wait!.key, "approve", web, "bearer");
			await until(() => s.done(run.turn));
			expect(s.passes.map(([, hash]) => hash)).toEqual([s.page.released[0]!.hash]);
			expect((await s.activity()).filter((e) => e.outside === "sent").map((e) => e.what)).toEqual([
				"Sent POST https://api.shop.example/keys from the browser",
			]);
		} finally {
			await s.close();
		}
	});

	it("a page of a signed-in site writing to another host acts as the owner: a floor draft", async () => {
		// the page holds the owner's token in its own storage and sends it, in its body, to an api host with no cookies
		const s = await setup();
		try {
			await s.signIn("shop.example");
			s.page.form({ url: "https://collect.example/api", body: "token=from-local-storage" });
			const run = await s.say([
				["browser_navigate", { url: `${SITE}/` }],
				["browser_click", { ref: "s1e3" }],
				["browser_send", { write: "w1" }],
			]);
			const visit = (await s.nextAsk(run.turn)).wait!;
			await answer(s.harness, visit.key, "approve", web, "bearer", { approving: { permission: { scope: "task" } } });
			const wait = await until(async () => (await openWaits(s.harness)).find((w) => w.key !== visit.key));
			expect(s.passes).toEqual([]);
			expect(wait.ask).toMatchObject({
				tool: "browser_send",
				floor: "credentials",
				args: { address: "https://collect.example/api", "with your session at": "shop.example" },
			});
			await answer(s.harness, wait.key, "deny", web, "bearer");
			await until(() => s.done(run.turn));
			expect(s.passes).toEqual([]);
		} finally {
			await s.close();
		}
	});

	it("a sign-in handed over is kept before the browser is given back", async () => {
		let kept: string[] | undefined;
		const s = await setup({}, async () => {
			kept ??= Object.keys((await s.harness.snapshot(SignedIn, context))?.agents[LEAD] ?? {});
		});
		try {
			const run = await s.say([
				["browser_navigate", { url: "https://login.example/" }],
				["browser_hand_over", { site: "Login.example" }],
			]);
			const { wait } = await s.nextAsk(run.turn);
			expect(wait?.ask).toMatchObject({ type: "question", handOver: { site: "Login.example", signIn: true } });
			await answer(s.harness, wait!.key, "Done", web, "bearer");
			await until(() => s.done(run.turn));
			expect(kept).toEqual(["login.example"]);
		} finally {
			await s.close();
		}
	});

	it("a write carrying a credential header is a floor draft; one carrying a secret is never drafted nor sent", async () => {
		const s = await setup();
		try {
			s.page.form({ url: `${SITE}/api`, headers: [["Authorization", "Bearer what-the-page-had"]] });
			const run = await s.say([
				["browser_navigate", { url: `${SITE}/` }],
				["browser_click", { ref: "s1e3" }],
				["browser_send", { write: "w1" }],
			]);
			const { wait } = await s.nextAsk(run.turn);
			expect(wait?.ask).toMatchObject({ tool: "browser_send", floor: "credentials" });
			await answer(s.harness, wait!.key, "deny", web, "bearer");
			await until(() => s.done(run.turn));
			expect(s.passes).toEqual([]);

			s.page.form({ url: `${SITE}/login`, secret: true });
			const secret = await s.say([
				["browser_click", { ref: "s1e3" }],
				["browser_send", { write: "w2" }],
			]);
			expect((await s.nextAsk(secret.turn)).wait).toBeUndefined();
			expect(s.passes).toEqual([]);
			expect((await s.results(secret.chat)).some((said) => said.includes("never goes into a draft"))).toBe(true);
		} finally {
			await s.close();
		}
	});

	it("a held request leads with what it sends; its credentials are masked in the draft, the store and the card", async () => {
		const KEY = "ca3923e41d3c424fa3d09ce0ef8fd5c6";
		const ID = "5f0e7c1a-9b2d-4e3f-8a6b-1c2d3e4f5a6b";
		const SECRET = "Zm9vYmFy-s3cr3t";
		const s = await setup();
		try {
			s.page.form({
				url: "https://api-gateway.cp.pt/cp/services/travel-api/journeys",
				headers: [
					["Origin", "https://www.cp.pt"],
					["Referer", "https://www.cp.pt/passageiros/pt/consultar-horarios"],
					["User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"],
					["sec-ch-ua", '"Chromium";v="139", "Not;A=Brand";v="99"'],
					["Content-Type", "application/json"],
					["x-api-key", KEY],
					["x-cp-connect-id", ID],
					["x-cp-connect-secret", SECRET],
				],
				body: JSON.stringify({
					departureStationCode: "94-31039",
					arrivalStationCode: "94-2006",
					travelDate: "2026-12-12",
					filters: { class: 2, adults: 1 },
				}),
			});
			const run = await s.say([
				["browser_navigate", { url: "https://www.cp.pt/passageiros/pt/consultar-horarios" }],
				["browser_click", { ref: "s1e3" }],
				["browser_send", { write: "w1" }],
			]);
			const { wait } = await s.nextAsk(run.turn);
			const ask = wait!.ask as Extract<Ask, { type: "approval" }>;
			expect(ask).toMatchObject({
				tool: "browser_send",
				floor: "credentials",
				label: "send a request from www.cp.pt to api-gateway.cp.pt/cp/services/travel-api/journeys",
				details: ["page", "method", "address", "headers", "body"],
				args: {
					sends: {
						departureStationCode: "94-31039",
						arrivalStationCode: "94-2006",
						travelDate: "2026-12-12",
						filters: "(2 fields)",
					},
					page: "www.cp.pt",
					method: "POST",
					address: "https://api-gateway.cp.pt/cp/services/travel-api/journeys",
				},
			});
			expect(String(ask.args.headers).split("\n")).toEqual([
				"Origin: https://www.cp.pt",
				"Referer: https://www.cp.pt/passageiros/pt/consultar-horarios",
				"User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
				'sec-ch-ua: "Chromium";v="139", "Not;A=Brand";v="99"',
				"Content-Type: application/json",
				"x-api-key: ca39… (32 characters)",
				"x-cp-connect-id: 5f0e… (36 characters)",
				"x-cp-connect-secret: hidden (15 characters)",
			]);

			// the card leads with what it is and what it sends; the request whole waits behind "Details"
			const parts = draftParts(ask);
			expect(argList(parts.rest)).toEqual([
				["sends › departureStationCode", "94-31039"],
				["sends › arrivalStationCode", "94-2006"],
				["sends › travelDate", "2026-12-12"],
				["sends › filters", "(2 fields)"],
			]);
			expect(parts.details.map(([term]) => term)).toEqual(["page", "method", "address", "headers", "body"]);
			expect(JSON.stringify(parts.details)).not.toMatch(new RegExp(`${KEY}|${ID}|${SECRET}`));

			// approved, the exact bytes the page wrote go: the hash binds them, not the words shown
			await answer(s.harness, wait!.key, "approve", web, "bearer");
			await until(() => s.done(run.turn));
			expect(s.passes.map(([, hash]) => hash)).toEqual([s.page.released[0]!.hash]);
			expect(s.page.released[0]!.headers).toContainEqual(["x-api-key", KEY]);
			// no credential was written anywhere in the home: not the draft, the activity, nor the transcript
			const files = (await readdir(s.home, { recursive: true, withFileTypes: true })).filter((f) => f.isFile());
			expect(files.length).toBeGreaterThan(0);
			for (const file of files) {
				const bytes = await readFile(join(file.parentPath, file.name));
				for (const secret of [KEY, ID, SECRET]) expect(bytes.includes(secret), `${secret} in ${file.name}`).toBe(false);
			}
		} finally {
			await s.close();
		}
	});
});

describe("a site the owner signed in to", () => {
	it("is named as a host, whatever the agent wrote", () => {
		expect(siteName("GitHub.com")).toBe("github.com");
		expect(siteName("https://accounts.google.com/signin?x=1")).toBe("accounts.google.com");
		expect(siteName("shop.example:8080")).toBe("shop.example");
		expect(siteName(".github.com.")).toBe("github.com");
		expect(siteName("GitHub")).toBeUndefined();
		expect(siteName("")).toBeUndefined();
	});

	it("matches its host, the hosts under and above it, and a cookie scoped to any of those; only its agent's", async () => {
		const harness = await openStore(await tempHome(), { models: createModels(), registry: createRegistry() });
		try {
			await harness.commit(async (tx) => {
				const { chats } = await tx.doc(AgentChats);
				chats[1] = LEAD;
				chats[2] = "ledger";
				await keepSignedIn(tx, LEAD, "accounts.google.com", 1, 1);
				await keepSignedIn(tx, LEAD, "GitHub.com", 1, 1);
			}, context);
			expect(Object.keys((await harness.snapshot(SignedIn, context))!.agents[LEAD]!).sort()).toEqual([
				"accounts.google.com",
				"github.com",
			]);
			const of = (chat: number, host: string, cookies: readonly string[] | null = []) =>
				harness.commit((tx) => sessionOf(tx, chat, host, cookies), context);
			expect(await of(1, "github.com")).toBe("github.com");
			expect(await of(1, "api.github.com")).toBe("github.com");
			expect(await of(1, "google.com")).toBe("accounts.google.com");
			// mail.google.com is not under the accounts host, but the session's cookie is the whole domain's
			expect(await of(1, "mail.google.com")).toBeUndefined();
			expect(await of(1, "mail.google.com", ["google.com"])).toBe("accounts.google.com");
			expect(await of(1, "notgithub.com")).toBeUndefined();
			expect(await of(1, "github.com.evil.example")).toBeUndefined();
			// an analytics cookie of an unrelated site is no session of the owner's
			expect(await of(1, "shop.example", ["shop.example", "analytics.example"])).toBeUndefined();
			// cookies not known go as a session would, once signed in anywhere
			expect(await of(1, "shop.example", null)).toBeDefined();
			// another agent's browser was never signed in: nothing goes as the owner there
			expect(await of(2, "github.com", null)).toBeUndefined();
		} finally {
			await harness.close(context);
		}
	});

	it("as a property: a host under a signed-in site always goes as the owner, any cookie of it too", () => {
		const label = fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/);
		fc.assert(
			fc.asyncProperty(
				fc.array(label, { minLength: 2, maxLength: 3 }),
				fc.array(label, { maxLength: 2 }),
				async (site, under) => {
					const harness = await openStore(await tempHome(), { models: createModels(), registry: createRegistry() });
					try {
						const name = site.join(".");
						const host = [...under, name].join(".");
						await harness.commit(async (tx) => {
							(await tx.doc(AgentChats)).chats[1] = LEAD;
							await keepSignedIn(tx, LEAD, name, 1, 1);
						}, context);
						expect(await harness.commit((tx) => sessionOf(tx, 1, host, []), context)).toBe(name);
						expect(await harness.commit((tx) => sessionOf(tx, 1, "unrelated.test", [host]), context)).toBe(name);
					} finally {
						await harness.close(context);
					}
				},
			),
			{ numRuns: pbtRuns(10) },
		);
	});
});
