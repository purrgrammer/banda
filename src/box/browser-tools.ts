/**
 * The `browser` toolset (DESIGN.md "The box", The browser): the agent reads a page as an accessibility snapshot whose
 * refs name its elements, and acts on them; a screenshot when the snapshot is not enough.
 *
 * Browsing never asks unless it acts as the owner. Opening an address, clicking, typing and a page's writes run at once
 * while nothing of the owner's goes with them. On a site the owner signed in to in this agent's browser (`SignedIn`),
 * what the agent types and what the page writes go with their session: each is a draft on the floor, asked every time
 * (they see the words and the site, and may edit typed words), as is a write carrying a credential header. A write
 * that carries a secret is never drafted. Signing in is the owner's (`browser_hand_over`); a key a page shows reaches
 * `auth/` only (`propose_key`), never the model. Each write that goes passes the proxy once, by the hash of its bytes.
 *
 * After every action what the proxy saw is taken into the store, as after a command: the hosts read are logged, and
 * anything the proxy held is listed.
 *
 * While the owner holds the browser, a call that drives it waits for them, in a Wait of its own, which outlives a
 * restart: given back, its result is the page as they left it, and what it was to do is not done (its refs are stale,
 * and the page theirs since). Taking the browser cuts a call at work short; Stop ends a call at once. Tools that do not
 * drive the browser go on as they would, so a run that never touches it is not held up.
 */
import type { Context } from "@earendil-works/chord";
import { type Static, type TSchema, Type } from "@earendil-works/pi-ai";
import type { Harness } from "@earendil-works/pi-durable";
import {
	defineDoc,
	defineTool,
	type JsonObject,
	type ToolExecutionApi,
	type ToolExecutionResult,
	type ToolRegistration,
	type Tx,
} from "@earendil-works/pi-durable";
import { log } from "../core/activity.ts";
import { AgentChats } from "../core/agents.ts";
import type { EffectTool } from "../core/ask.ts";
import { type HoldingEgress, intake, ownCredential } from "../core/egress.ts";
import { OWNER } from "../core/gateway.ts";
import { covering } from "../core/permissions.ts";
import { addressWords, bodyFields, bodyWords, headersWords } from "../core/request-words.ts";
import { context } from "../core/store.ts";
import { type Ask, answer, liveWaits, type WaitResult } from "../core/wait.ts";
import { type Action, type Browser, type PageWrite, Refused, Taken } from "./browser.ts";

/** Where a key a page showed is kept: as a connection's key, or as a credential the proxy sets for a host. */
export type KeyPlace =
	| { readonly connection: string }
	| { readonly host: string; readonly header: string; readonly prefix?: string };

export type BrowserToolOptions = {
	/** The browser of the agent chat `chat` runs. */
	readonly browser: (chat: number) => Promise<Browser>;
	readonly egress?: HoldingEgress & { pass(chat: number, hash: string): Promise<void> };
	readonly effect: <P extends TSchema>(tool: EffectTool<P>) => ToolRegistration;
	readonly ask: (
		api: ToolExecutionApi,
		name: string,
		ask: Ask,
		deadline: number,
		ctx: Context,
	) => Promise<WaitResult | undefined>;
	/** Keep `key` where `place` says, in `auth/` alone; throws with why not. */
	readonly keep: (key: string, place: KeyPlace) => Promise<void>;
	/** The owner gave chat `chat`'s browser back (or answered the hand-over): it must be theirs no more. */
	readonly giveBack: (chat: number) => Promise<void>;
	/** A sign-in the owner did, remembered for the page of what the companion can use. */
	readonly signedIn?: (site: string, chat: number, ctx: Context) => Promise<void>;
	readonly fault?: (point: string) => void;
};

/**
 * The sites the owner signed in to in each agent's browser, by host name: from a hand-over, and from every page they
 * loaded and every write they let go while holding it. Their sessions live in that browser's profile alone, credentials the owner chose to hand over to
 * that agent, which Settings lists with a way to sign out; what goes with one is on the floor.
 */
export const SignedIn = defineDoc<{ agents: { [agent: string]: { [site: string]: { at: number; chat: number } } } }>({
	kind: "banda.signed-in",
	version: 1,
	scope: "session",
	initial: () => ({ agents: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 16,
});

/**
 * A browser call's waits for the owner to give the browser back, under its tool task: how many it opened, and whether
 * the last is still its own (`open`), so a rerun after a restart goes on with that one instead of asking again. A call
 * that waited once never acts: a rerun reads the page.
 */
export const BrowserCall = defineDoc<{ pauses: number; open?: boolean }>({
	kind: "banda.browser-call",
	version: 1,
	scope: "task",
	initial: () => ({ pauses: 0 }),
	checkpointWhen: () => false,
});

/**
 * The owner gives the browser back: theirs no more, and every call that waits for it goes on, as does a hand-over in
 * the chat whose page it holds. The app's Give back, and a waiting call's own Done, both come here. A sign-in handed
 * over in that chat is kept as signed in first.
 */
export async function giveBrowserBack(
	harness: Harness,
	browser: Browser,
	fault: (point: string) => void = () => {},
): Promise<void> {
	const holder = browser.view().chat;
	const waits = await harness.commit((tx) => liveWaits(tx), context);
	// a sign-in handed over is kept before the browser is the agent's again: its session is never the agent's unknown
	const page = holder === undefined ? undefined : browser.site(holder);
	await harness.commit(async (tx) => {
		for (const wait of waits) {
			const { ask } = wait.input;
			if (ask.type !== "question" || ask.handOver?.signIn !== true || wait.chat !== holder) continue;
			const agent = (await tx.doc(AgentChats)).chats[wait.chat];
			if (agent === undefined) continue;
			for (const site of [ask.handOver.site, page])
				if (site !== undefined) await keepSignedIn(tx, agent, site, wait.chat, Date.now());
		}
	}, context);
	fault("browser:give-back");
	await browser.hold(false);
	for (const wait of waits) {
		const { ask } = wait.input;
		if (ask.type !== "question" || ask.handOver === undefined) continue;
		if (ask.handOver.taken !== true && wait.chat !== holder) continue;
		await answer(harness, wait.input.key, "Done", { gateway: "web", peer: OWNER }, "bearer");
	}
}

/** A site as `SignedIn` keys it: a host name in lower case, without a scheme, a port, a path or dots at its ends. */
export function siteName(text: string): string | undefined {
	let host = text.trim().toLowerCase();
	try {
		if (host.includes("://")) host = new URL(host).hostname;
	} catch {
		return undefined;
	}
	host = host
		.replace(/[/?#].*$/, "")
		.replace(/:\d+$/, "")
		.replace(/^\.+|\.+$/g, "");
	return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || /^\d+(\.\d+){3}$/.test(host) ? host : undefined;
}

/** In `tx`: keep `site` as one agent `agent`'s browser is signed in to, from chat `chat`; whether it was not yet. */
export async function keepSignedIn(tx: Tx, agent: string, site: string, chat: number, at: number): Promise<boolean> {
	const name = siteName(site);
	if (name === undefined) return false;
	const { agents } = await tx.doc(SignedIn);
	agents[agent] ??= {};
	const sites = agents[agent];
	if (sites === undefined || sites[name] !== undefined) return false;
	sites[name] = { at, chat };
	return true;
}

/** Whether hosts `a` and `b` are one site's, as a sign-out finds them: the same, or one under the other. */
const oneSite = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

/**
 * The site the owner signed in to whose session goes with a request to `host` in the browser of the agent `chat` runs,
 * if any: `host` is that site, under it or above it, or one of `cookies` (the domains of the cookies that go with it)
 * is. Cookies not known (null) go as a session would, once the browser is signed in anywhere. Reads only.
 */
export async function sessionOf(
	tx: Tx,
	chat: number,
	host: string,
	cookies: readonly string[] | null,
): Promise<string | undefined> {
	const agent = (await tx.doc(AgentChats)).chats[chat];
	if (agent === undefined) return undefined;
	const sites = Object.keys((await tx.doc(SignedIn)).agents[agent] ?? {});
	const name = siteName(host) ?? host.toLowerCase();
	const found = sites.find(
		(site) => oneSite(name, site) || (cookies ?? []).some((domain) => oneSite(domain.toLowerCase(), site)),
	);
	if (found !== undefined) return found;
	return cookies === null && sites.length > 0 ? "a site you signed in to" : undefined;
}

/** The draft of opening `site` as the owner, as a permission binds it: the site, never the address. */
const openingDraft = (site: string) => ({ tool: "browser_navigate", args: { site } });

/**
 * The site the owner signed in to whose session a request of `chat` to `host` goes with (`sessionOf`), and whether
 * this chat's task allowed opening it (a permission of the task, from an approval of `browser_navigate`); undefined
 * when it goes with none. Reads only.
 */
export async function openingAt(
	tx: Tx,
	chat: number,
	host: string,
	cookies: readonly string[] | null,
	now: number,
): Promise<{ readonly site: string; readonly allowed: boolean } | undefined> {
	const site = await sessionOf(tx, chat, host, cookies);
	if (site === undefined) return undefined;
	return { site, allowed: (await covering(tx, openingDraft(site), chat, now)) !== undefined };
}

/** How many writes one action lets go on its own, at most; the rest wait for `browser_send`. */
const FREE_WRITES = 10;

export const BROWSER_TOOLS = [
	"browser_snapshot",
	"browser_navigate",
	"browser_click",
	"browser_type",
	"browser_select",
	"browser_scroll",
	"browser_wait",
	"browser_screenshot",
	"browser_send",
	"browser_hand_over",
	"propose_key",
] as const;

const text = (value: string, isError = false): ToolExecutionResult => ({
	output: [{ type: "text", text: value }],
	...(isError ? { isError } : {}),
});

const REF = Type.String({ pattern: "^s[0-9]+e[0-9]+$", description: "A ref from your latest snapshot, like s3e12." });

export function browserTools(options: BrowserToolOptions): ToolRegistration[] {
	const { browser, egress } = options;
	const fault = options.fault ?? (() => {});

	/**
	 * Why a page's write waits for the owner, or undefined when it acts as nobody and goes at once: it carries a secret
	 * (never drafted), a credential header of its own, or the session of a site the owner signed in to; or it was made
	 * by a page or frame of such a site, which may hold the owner's credentials anywhere (its storage, a header, the
	 * body), whatever host it goes to. Reads only.
	 */
	const ownersOf = async (
		api: ToolExecutionApi,
		chat: number,
		write: PageWrite,
		ctx: Context,
	): Promise<{ readonly why: "secret" | "credentials" | "session"; readonly site?: string } | undefined> => {
		if (write.secret) return { why: "secret" };
		let url: URL;
		try {
			url = new URL(write.url);
		} catch {
			return { why: "credentials" };
		}
		// the browser's cookies are weighed by whose they are (`sessionOf`), every other credential header as one
		const headers = write.headers.filter(([key]) => key.trim().toLowerCase() !== "cookie");
		if (ownCredential(headers, `${url.pathname}${url.search}`)) return { why: "credentials" };
		const origins = [write.origin, write.page].flatMap((address) => {
			try {
				return /^https?:$/.test(new URL(address).protocol) ? [new URL(address).hostname] : [];
			} catch {
				return [];
			}
		});
		const site = await api.commit(async (tx) => {
			const to = await sessionOf(tx, chat, url.hostname, write.cookies);
			if (to !== undefined) return to;
			for (const from of origins) {
				const found = await sessionOf(tx, chat, from, []);
				if (found !== undefined) return found;
			}
			return undefined;
		}, ctx);
		return site === undefined ? undefined : { why: "session", site };
	};

	/**
	 * Let write `id` go through the proxy, once, by the hash of its bytes (`expected`: the bytes decided on); the page
	 * after it. It is logged as sent, with its hash, in a commit before the proxy is told, so no kill leaves a send
	 * unlogged; one that then did not go is logged again as not sent. Throws `Refused` when it did not go.
	 */
	const release = async (api: ToolExecutionApi, ctx: Context, id: string, expected: string, what: string) => {
		const chat = Number(api.conversationId);
		const own = await browser(chat);
		let logged = false;
		try {
			return await own.release(
				chat,
				id,
				async (write) => {
					if (write.hash !== expected) throw new Refused("The write is not the one decided on: nothing was sent.");
					if (egress === undefined) throw new Refused("There is no proxy to send it through.");
					await api.commit(async (tx) => {
						await log(tx, {
							at: api.now(),
							what: `Sent ${what} from the browser`,
							chat,
							outside: "sent",
							hash: write.hash,
						});
					}, ctx);
					logged = true;
					fault("browser:send");
					await egress.pass(chat, write.hash);
				},
				ctx.abortSignal,
			);
		} catch (error) {
			if (!(error instanceof Taken) || logged)
				await api.commit(async (tx) => {
					await log(tx, {
						at: api.now(),
						what: logged
							? `Did not finish sending ${what} from the browser: it may not have gone`
							: `Did not send ${what} from the browser`,
						chat,
					});
				}, ctx);
			throw error;
		}
	};

	/**
	 * Let go every write the page holds that acts as nobody (`ownersOf`), up to `FREE_WRITES`: the page after the last,
	 * and a line for each that went, or for one that did not.
	 */
	const releaseFree = async (api: ToolExecutionApi, ctx: Context) => {
		const chat = Number(api.conversationId);
		const own = await browser(chat);
		const lines: string[] = [];
		let page: string | undefined;
		for (let round = 0; round < FREE_WRITES; round++) {
			let free: PageWrite | undefined;
			for (const write of await own.writes(chat))
				if ((await ownersOf(api, chat, write, ctx)) === undefined) {
					free = write;
					break;
				}
			if (free === undefined) break;
			const what = `${free.method} ${addressWords(free.url)}`;
			try {
				page = await release(api, ctx, free.id, free.hash, what);
			} catch (error) {
				if (error instanceof Taken) throw error;
				lines.push(`[banda] The page tried to send ${what}; it did not go: ${(error as Error).message}`);
				break;
			}
			lines.push(`[banda] The page sent ${what} (write ${free.id}): nothing of the owner's went with it.`);
		}
		return { page, lines };
	};

	/**
	 * Run `act`, then let go what the page wrote that acts as nobody, then take what the proxy saw into the store; a
	 * refusal is the model's to read.
	 */
	const acting = async (api: ToolExecutionApi, ctx: Context, act: () => Promise<string>) => {
		let said: string;
		let failed = false;
		try {
			said = await act();
		} catch (error) {
			// the owner holds the browser: the call waits for them (`pausing`)
			if (error instanceof Taken) throw error;
			failed = true;
			said =
				error instanceof Refused
					? error.message
					: `The browser failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (!failed && egress !== undefined) {
			const freed = await releaseFree(api, ctx);
			if (freed.lines.length > 0) said = `${freed.lines.join("\n")}\n\n${freed.page ?? said}`;
		}
		if (egress !== undefined) {
			try {
				said += await intake(egress, api, ctx, fault);
			} catch (error) {
				said += `\n\n[banda] The egress proxy did not answer, so what the page read is not known yet: ${(error as Error).message}`;
			}
		}
		return text(said, failed);
	};

	const plain = <P extends TSchema>(
		name: string,
		description: string,
		parameters: P,
		run: (args: Static<P>, chat: number, signal: AbortSignal | undefined) => Promise<string>,
	): ToolRegistration =>
		pausing(
			defineTool({
				name,
				description,
				parameters,
				// a rerun after a restart finds a browser started again, whose refs are all stale: nothing is acted on twice
				replay: "safe",
				executionMode: "sequential",
				execute: (args, api, ctx) =>
					acting(api, ctx, () => run(args as Static<P>, Number(api.conversationId), ctx.abortSignal)),
			} as ToolRegistration<P>) as ToolRegistration,
		);

	/**
	 * The call waits for the owner to give the browser back (DESIGN.md "The box", The browser): in Wait `taken:<n>` of
	 * its own, shown in its chat as the browser in the owner's hands, which their Give back or its Done answers. Then
	 * its result is the page as they left it.
	 */
	const paused = async (api: ToolExecutionApi, ctx: Context): Promise<ToolExecutionResult> => {
		const chat = Number(api.conversationId);
		for (;;) {
			const pause = await api.commit(async (tx) => {
				const call = await tx.doc(BrowserCall, api.taskId);
				if (call.open !== true) {
					call.pauses += 1;
					call.open = true;
				}
				return call.pauses;
			}, ctx);
			fault("browser:wait");
			const own = await browser(chat);
			const site = own.site(own.view().chat ?? chat) ?? "the browser";
			const ended = await options.ask(
				api,
				`taken:${pause}`,
				{
					type: "question",
					question: "You have the browser. Give it back when you are done, and what waits for it goes on.",
					options: ["Done"],
					handOver: { site, signIn: false, taken: true },
				},
				api.now() + 24 * 60 * 60_000,
				ctx,
			);
			if (ended === undefined) return text("The wait for the browser was cancelled.", true);
			if ("expired" in ended)
				return text("The owner kept the browser all day: it is still theirs. Try again later.", true);
			// their Done in the chat: the browser is given back as it would be from the app
			if ((await browser(chat)).view().control === "owner") await options.giveBack(chat);
			try {
				return await acting(
					api,
					ctx,
					async () =>
						`The owner gave the browser back; what this call was to do was not done, as the page may have changed. ` +
						`The page now:\n${await (await browser(chat)).snapshot(chat, ctx.abortSignal)}`,
				);
			} catch (error) {
				// taken again before the page was read: wait again, in a new Wait
				if (!(error instanceof Taken)) throw error;
				await api.commit(async (tx) => {
					(await tx.doc(BrowserCall, api.taskId)).open = false;
				}, ctx);
			}
		}
	};

	/** `tool`, waiting while the owner holds the browser, or once they take it from the call at work. */
	const pausing = (tool: ToolRegistration): ToolRegistration => ({
		...tool,
		replay: "safe",
		execute: async (args, api, ctx) => {
			const waited = await api.commit(async (tx) => (await tx.doc(BrowserCall, api.taskId)).pauses > 0, ctx);
			if (waited || (await browser(Number(api.conversationId))).view().control === "owner") return paused(api, ctx);
			try {
				return await tool.execute(args, api, ctx);
			} catch (error) {
				if (error instanceof Taken) return paused(api, ctx);
				throw error;
			}
		},
	});

	const act = async (chat: number, action: Action, signal: AbortSignal | undefined) =>
		(await browser(chat)).act(chat, action, signal);

	// opening an address is a read: what a page loads goes to public hosts only, and what it writes waits in the browser;
	// opening a site the owner signed in to acts as them, so it asks, and allowed for the task it asks no more in it
	const navigateParameters = Type.Object({
		url: Type.String({
			description: "The whole address, like https://example.com/page; or `back` for the page before.",
		}),
	});
	/** The site the owner signed in to that opening `url` in `chat` goes as, and whether this task allowed it. */
	const openingOf = async (api: ToolExecutionApi, chat: number, url: string, ctx: Context) => {
		let host: string;
		try {
			host = new URL(url).hostname;
		} catch {
			return undefined;
		}
		const cookies = await (await browser(chat)).cookies(chat, url);
		return api.commit((tx) => openingAt(tx, chat, host, cookies, api.now()), ctx);
	};
	const openingAsOwner: EffectTool<typeof navigateParameters> = {
		name: "browser_navigate",
		description: "",
		parameters: navigateParameters,
		effect: "idempotent",
		describe: (args) => `open ${String((args as JsonObject).site)} as you`,
		permission: {
			args: ["site"],
			what: (args) => `open ${String((args as JsonObject).site)} as you`,
			lasts: ["task"],
		},
		expand: async (args, api, ctx) => {
			const opening = await openingOf(api, Number(api.conversationId), args.url, ctx);
			if (opening === undefined) return `${args.url} is on no site you are signed in to: open it as usual`;
			return { site: opening.site, address: args.url };
		},
		run: async (args, { api }, ctx) => {
			const drafted = args as unknown as JsonObject;
			const chat = Number(api.conversationId);
			return acting(api, ctx, () =>
				act(chat, { type: "navigate", url: String(drafted.address), as: String(drafted.site) }, ctx.abortSignal),
			);
		},
	};
	const openingDraftTool = options.effect(openingAsOwner);
	const navigate = pausing(
		defineTool({
			name: "browser_navigate",
			description:
				"Open an address in your browser, or go `back`; you get the page as a snapshot. A page of a site the owner " +
				"signed in to in your browser opens as them, so it asks them first; allowed for this task, it opens freely " +
				"until the task is done. Typing and sending there still ask every time.",
			parameters: navigateParameters,
			replay: "safe",
			executionMode: "sequential",
			execute: async (args, api, ctx) => {
				const chat = Number(api.conversationId);
				if (args.url.trim() === "back") return acting(api, ctx, () => act(chat, { type: "back" }, ctx.abortSignal));
				// decided once per call: a rerun after a restart goes on the way it started (an open ask stays the ask)
				const opening = await openingOf(api, chat, args.url, ctx);
				const asks = await api.memo("as-owner", opening !== undefined && !opening.allowed, ctx);
				if (asks) return openingDraftTool.execute(args, api, ctx);
				return acting(api, ctx, () => act(chat, { type: "navigate", url: args.url }, ctx.abortSignal));
			},
		}) as ToolRegistration,
	);

	/** The site the owner signed in to whose session the page `chat` holds goes with, if any. */
	const signedInPage = async (api: ToolExecutionApi, chat: number, ctx: Context) => {
		const own = await browser(chat);
		const host = own.site(chat);
		if (host === undefined) return undefined;
		const cookies = await own.cookies(chat);
		return api.commit((tx) => sessionOf(tx, chat, host, cookies), ctx);
	};

	// typing: the agent's own words to a page, which go at once; on a site the owner signed in to they go as the owner,
	// so a draft on the floor, its words theirs to edit
	const typeParameters = Type.Object({
		ref: REF,
		text: Type.String({ maxLength: 4000, description: "What to type; it replaces what the field holds." }),
		submit: Type.Optional(Type.Boolean({ description: "Press Enter after it." })),
	});
	const typingAsOwner: EffectTool<typeof typeParameters> = {
		name: "browser_type",
		description: "",
		parameters: typeParameters,
		effect: "unsafe",
		editable: ["text"],
		floor: "credentials",
		describe: (args) => `type into ${String((args as JsonObject).field)} on ${String((args as JsonObject).site)}`,
		expand: async (args, api, ctx) => {
			const chat = Number(api.conversationId);
			const own = await browser(chat);
			const session = await signedInPage(api, chat, ctx);
			const element = own.element(chat, args.ref);
			if (typeof element === "string") return element;
			if (element.sensitive)
				return "that field is for a secret, which is never yours to type: hand the page to the owner (browser_hand_over)";
			return {
				site: own.site(chat) ?? "the page",
				field: element.name === "" ? `the ${element.role}` : `“${element.name}”`,
				text: args.text,
				...(args.submit === true ? { "then press Enter": true } : {}),
				"with your session at": session ?? own.site(chat) ?? "the page",
				_ref: args.ref,
			};
		},
		run: async (args, { api }, ctx) => {
			const drafted = args as unknown as JsonObject;
			return acting(api, ctx, () =>
				act(
					Number(api.conversationId),
					{
						type: "type",
						ref: String(drafted._ref),
						text: String(drafted.text),
						submit: drafted["then press Enter"] === true,
					},
					ctx.abortSignal,
				),
			);
		},
	};
	const typingDraft = options.effect(typingAsOwner);
	const typing = pausing(
		defineTool({
			name: "browser_type",
			description:
				"Type into a field of the page (by its ref), replacing what it holds; `submit` presses Enter after. It types " +
				"at once, unless the page is on a site the owner signed in to in your browser: then it goes as them, so they " +
				"see it and approve it first, every time, and may change the words. Never type a password, a code or a card " +
				"number: hand the page to the owner for those (browser_hand_over).",
			parameters: typeParameters,
			replay: "safe",
			executionMode: "sequential",
			execute: async (args, api, ctx) => {
				const chat = Number(api.conversationId);
				// decided once per call: a rerun after a restart goes on the way it started (an open ask stays the ask)
				const asOwner = await api.memo("signed-in", (await signedInPage(api, chat, ctx)) ?? "", ctx);
				if (asOwner !== "") return typingDraft.execute(args, api, ctx);
				return acting(api, ctx, () =>
					act(chat, { type: "type", ref: args.ref, text: args.text, submit: args.submit === true }, ctx.abortSignal),
				);
			},
		}) as ToolRegistration,
	);

	// a page's write, waiting in the browser: one that acts as nobody goes at once; one that goes as the owner (their
	// session, or a credential header) is a draft on the floor, sent once, exactly as shown, when they approve it
	const sendParameters = Type.Object({
		write: Type.String({
			pattern: "^w[0-9]+$",
			description: "The write the page tried, as its action's result named it.",
		}),
	});
	const sendingAsOwner: EffectTool<typeof sendParameters> = {
		name: "browser_send",
		description: "",
		parameters: sendParameters,
		effect: "unsafe",
		describe: (args) => {
			const drafted = args as unknown as JsonObject;
			return `send a request from ${String(drafted.page)} to ${destination(String(drafted.address))}`;
		},
		// the request as it goes, under what it says it sends
		details: ["page", "method", "address", "headers", "body"],
		// sent with the owner's session, or a credential header of its own: the owner's credential
		floor: "credentials",
		expand: async (args, api, ctx) => {
			const chat = Number(api.conversationId);
			const write = (await (await browser(chat)).writes(chat)).find((w) => w.id === args.write);
			if (write === undefined) return `there is no write ${args.write} waiting: the page moved on, or it was sent`;
			const owners = await ownersOf(api, chat, write, ctx);
			if (owners?.why === "secret")
				return (
					"it sends a secret the owner typed (or a key the page showed), which never goes into a draft: hand the " +
					"page to the owner to send it themselves (browser_hand_over)"
				);
			return draftOf(write, owners?.site);
		},
		run: async (args, { api }, ctx) => {
			const drafted = args as unknown as JsonObject;
			const what = `${String(drafted.method)} ${String(drafted.address)}`;
			return acting(api, ctx, () => release(api, ctx, String(drafted._write), String(drafted._hash), what));
		},
	};
	const sendingDraft = options.effect(sendingAsOwner);
	const sending = pausing(
		defineTool({
			name: "browser_send",
			description:
				"Let a write the page tried go (a form sent, a button that saves), by the write its action's result named. " +
				"A write that acts as nobody goes at once (an action already lets those go itself); one that goes with the " +
				"session of a site the owner signed in to, or a credential, waits until they approve exactly what it sends, " +
				"every time. Then the page goes on and you get it as a snapshot.",
			parameters: sendParameters,
			replay: "safe",
			executionMode: "sequential",
			execute: async (args, api, ctx) => {
				const chat = Number(api.conversationId);
				const write = (await (await browser(chat)).writes(chat)).find((w) => w.id === args.write);
				// decided once per call: a rerun after a restart goes on the way it started (an open ask stays the ask)
				const free = await api.memo(
					"free",
					write !== undefined && (await ownersOf(api, chat, write, ctx)) === undefined ? write.hash : "",
					ctx,
				);
				if (free === "" || write === undefined) return sendingDraft.execute(args, api, ctx);
				return acting(api, ctx, () => release(api, ctx, write.id, free, `${write.method} ${addressWords(write.url)}`));
			},
		}) as ToolRegistration,
	);

	// a key the page shows: kept in auth/ by the daemon; the model only ever had its handle
	const keepParameters = Type.Object({
		key: Type.String({ pattern: "^k[0-9]+$", description: "The key's handle from your snapshot, like k1." }),
		connection: Type.Optional(
			Type.String({ description: "The connection (an allowed one that takes a key) this key is for." }),
		),
		host: Type.Optional(Type.String({ description: "Or: the API host the key is for, like api.example.com." })),
		header: Type.Optional(Type.String({ description: "With host: the header it goes in (default Authorization)." })),
		prefix: Type.Optional(
			Type.String({ description: "With host: what goes before it in the header, like `Bearer `." }),
		),
	});
	const keeping: EffectTool<typeof keepParameters> = {
		name: "propose_key",
		description:
			"Keep a key the page shows (an API key, a token: your snapshot shows it as [key k1], never its value) for a " +
			"connection, or as the credential your computer's proxy sets for an API host. The owner approves it every " +
			"time; you never see the key, and nothing you run ever holds it.",
		parameters: keepParameters,
		effect: "unsafe",
		floor: "credentials",
		describe: (args) => {
			const drafted = args as unknown as JsonObject;
			return `keep the key ${String(drafted.site)} shows, as ${String(drafted["kept as"])}`;
		},
		expand: async (args, api) => {
			const chat = Number(api.conversationId);
			const own = await browser(chat);
			if (own.key(chat, args.key) === undefined)
				return `there is no key ${args.key} on the page now: take a new snapshot`;
			const place = placeOf(args);
			if (typeof place === "string") return place;
			return {
				site: own.site(chat) ?? "the page",
				"kept as":
					"connection" in place
						? `the key of the connection ${place.connection}`
						: `the credential for ${place.host} (${place.header}: ${place.prefix ?? ""}…)`,
				_key: args.key,
				_place: place as unknown as JsonObject,
			};
		},
		run: async (args, { api }, ctx) => {
			const drafted = args as unknown as JsonObject;
			const chat = Number(api.conversationId);
			const value = (await browser(chat)).key(chat, String(drafted._key));
			if (value === undefined)
				return text("The key is no longer on the page (the browser moved on or closed): show it again.", true);
			fault("browser:capture");
			try {
				await options.keep(value, drafted._place as unknown as KeyPlace);
			} catch (error) {
				return text(`Not kept: ${(error as Error).message}`, true);
			}
			fault("browser:captured");
			await api.commit(async (tx) => {
				await log(tx, { at: api.now(), what: `Kept a key from ${String(drafted.site)}`, chat });
			}, ctx);
			return text(
				`Kept, as ${String(drafted["kept as"])}. You never see it: requests that need it get it on the way out.`,
			);
		},
	};

	const handOverParameters = Type.Object({
		site: Type.String({ minLength: 1, maxLength: 200, description: "The site, as the owner knows it: github.com." }),
		signIn: Type.Optional(
			Type.Boolean({ description: "It is to sign in (default); false for something else only they can do." }),
		),
		why: Type.Optional(Type.String({ maxLength: 300, description: "What they need to do, in a few words." })),
	});
	const handOver = defineTool({
		name: "browser_hand_over",
		description:
			"Hand the browser to the owner for what only they may do: signing in (their password never reaches you; the " +
			"session then stays in your browser), a passkey, a payment. It waits until they give the browser back, then " +
			'you get the page as a snapshot. Open the page first. Never for a bot check ("Just a moment…", "verify you ' +
			'are human", a Cloudflare or similar page): such a site does not serve a browser like yours, and keeps checking ' +
			"whoever clicks; use another source, or tell the owner the site would not open for you.",
		parameters: handOverParameters,
		replay: "safe",
		executionMode: "sequential",
		execute: async (args, api, ctx) => {
			const chat = Number(api.conversationId);
			const site = args.site.trim();
			const signIn = args.signIn !== false;
			if ((await browser(chat)).site(chat) === undefined)
				return text("The browser has no page of yours open: open the page first (browser_navigate).", true);
			const ended = await options.ask(
				api,
				"hand-over",
				{
					type: "question",
					question: signIn
						? `Sign in to ${site} in the browser, then give it back.`
						: `${(args.why?.trim() || `Something on ${site} needs you`).replace(/[.!:;,\s]+$/, "")}. Do it in the browser, then give it back.`,
					options: ["Done"],
					handOver: { site, signIn },
				},
				api.now() + 24 * 60 * 60_000,
				ctx,
			);
			// signed in: the site as the agent named it, and the page's, as the owner left it, whatever the name said;
			// kept before the browser is the agent's again, so its session is never the agent's unknown
			const page = (await browser(chat)).site(chat);
			if (signIn && ended !== undefined)
				for (const one of new Set([siteName(site), page === undefined ? undefined : siteName(page)]))
					if (one !== undefined) await options.signedIn?.(one, chat, ctx);
			fault("browser:signed-in");
			await options.giveBack(chat);
			if (ended === undefined) return text("The hand-over was cancelled.", true);
			if ("expired" in ended) return text("The owner did not take the browser in time.", true);
			try {
				return await acting(
					api,
					ctx,
					async () =>
						`The owner gave the browser back. The page now:\n${await (await browser(chat)).snapshot(chat, ctx.abortSignal)}`,
				);
			} catch (error) {
				// taken again before the page was read
				if (error instanceof Taken) return paused(api, ctx);
				throw error;
			}
		},
	}) as ToolRegistration;

	const screenshot = pausing(
		defineTool({
			name: "browser_screenshot",
			description:
				"See the page as an image, when its snapshot is not enough (a chart, a layout). Secret fields and keys are " +
				"blank in it. Act on the page by the refs of a snapshot, never by where things are in the image.",
			parameters: Type.Object({}),
			replay: "safe",
			execute: async (_args, api, ctx) => {
				let data: string | undefined;
				const said = await acting(api, ctx, async () => {
					const chat = Number(api.conversationId);
					data = await (await browser(chat)).screenshot(chat, ctx.abortSignal);
					return "";
				});
				if (data === undefined) return said;
				const words = said.output
					?.flatMap((part) => (part.type === "text" ? [part.text] : []))
					.join("")
					.trim();
				return {
					output: [
						{ type: "image", data, mimeType: "image/png" },
						...(words === undefined || words === "" ? [] : [{ type: "text" as const, text: words }]),
					],
				};
			},
		}) as ToolRegistration,
	);

	return [
		plain(
			"browser_snapshot",
			"Read the page in your browser as text: its elements, each you can act on with a ref (like s3e12) that holds " +
				"only until your next snapshot or action. Secret fields show without their value, and a key the page shows " +
				"as [key k1].",
			Type.Object({}),
			async (_args, chat, signal) => (await browser(chat)).snapshot(chat, signal),
		),
		navigate,
		plain(
			"browser_click",
			"Click an element of the page, by its ref; you get the page after. What the page then writes goes at once, " +
				"unless it would go with the session of a site the owner signed in to, or a credential: then it waits for " +
				"browser_send.",
			Type.Object({ ref: REF }),
			(args, c, signal) => act(c, { type: "click", ref: args.ref }, signal),
		),
		typing,
		plain(
			"browser_select",
			"Pick options of a list on the page (by its ref), by their labels or values.",
			Type.Object({ ref: REF, values: Type.Array(Type.String(), { minItems: 1, maxItems: 20 }) }),
			(args, c, signal) => act(c, { type: "select", ref: args.ref, values: args.values }, signal),
		),
		plain(
			"browser_scroll",
			"Scroll the page: to an element (by its ref), or up or down by pages.",
			Type.Object({
				ref: Type.Optional(REF),
				direction: Type.Optional(Type.Union([Type.Literal("up"), Type.Literal("down")])),
				pages: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
			}),
			(args, c, signal) => act(c, { type: "scroll", ...args }, signal),
		),
		plain(
			"browser_wait",
			"Wait for text to show on the page, or for some seconds (30 at most); you get the page after.",
			Type.Object({
				text: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
				seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
			}),
			(args, c, signal) => act(c, { type: "wait", ...args }, signal),
		),
		screenshot,
		sending,
		handOver,
		options.effect(keeping),
	];
}

/** Where a key goes, from the call's arguments; or why that is unclear. */
function placeOf(args: {
	connection?: string | undefined;
	host?: string | undefined;
	header?: string | undefined;
	prefix?: string | undefined;
}): KeyPlace | string {
	if (args.connection !== undefined && args.host !== undefined) return "give a connection or a host, not both";
	if (args.connection !== undefined) {
		if (!/^[a-z][a-z0-9-]{0,40}$/.test(args.connection)) return `${args.connection} is not a connection's name`;
		return { connection: args.connection };
	}
	if (args.host === undefined) return "say where the key goes: a connection, or a host";
	const host = args.host.trim().toLowerCase();
	if (!/^[a-z0-9.-]+$/.test(host) || !host.includes(".")) return `${args.host} is not a host`;
	const header = (args.header ?? "Authorization").trim();
	if (!/^[A-Za-z0-9-]{1,64}$/.test(header)) return `${header} is not a header`;
	if (args.prefix !== undefined && (args.prefix.length > 40 || /[\r\n]/.test(args.prefix)))
		return "the prefix is too long";
	return { host, header, ...(args.prefix === undefined ? {} : { prefix: args.prefix }) };
}

/**
 * The draft for a page's write: its method, address, headers and body as a person reads them, the site the owner signed
 * in to whose session goes with it, and its handles.
 */
/** Where a request goes, in words: its host and path, never its query. */
function destination(address: string): string {
	try {
		const url = new URL(address);
		return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
	} catch {
		return address.split(/[?#]/)[0] ?? address;
	}
}

function draftOf(write: PageWrite, signedIn: string | undefined): JsonObject {
	let page = write.page;
	try {
		page = new URL(write.page).host || write.page;
	} catch {
		// the page as it is
	}
	const type = write.headers.find(([key]) => key.trim().toLowerCase() === "content-type")?.[1];
	const sends = bodyFields(write.body, type);
	// what it sends, in words from the request itself; then the request whole, every credential masked: the bytes
	// approved are the ones hashed, so no credential is written into the draft
	return {
		...(sends === undefined ? {} : { sends }),
		...(signedIn === undefined ? {} : { "with your session at": signedIn }),
		page,
		method: write.method,
		address: addressWords(write.url),
		headers: headersWords(write.headers),
		body: bodyWords(write.body),
		_write: write.id,
		_hash: write.hash,
	};
}
