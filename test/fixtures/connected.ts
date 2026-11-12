/**
 * A daemon's wiring of connections for tests and the fault workers, without its HTTP server: a store, the core, the
 * box's tools on a host box, and the capabilities, against a model the test scripts. And the owner's side of signing
 * in: what their browser does between the daemon's link and its callback, against the fake server, which consents at
 * once.
 */
import { join } from "node:path";
import { createModels, type FauxResponseFactory, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, type Storage } from "@earendil-works/pi-durable";
import { openBox } from "../../src/box/box.ts";
import { boxEnv, boxTools } from "../../src/box/tools.ts";
import { LEAD } from "../../src/core/agents.ts";
import { BlobStore } from "../../src/core/blobs.ts";
import { Connected as ConnectedDoc } from "../../src/core/connections.ts";
import { readDefinition, type Shipped, shippedDefinitions } from "../../src/core/definitions.ts";
import type { Gateway } from "../../src/core/gateway.ts";
import { context, openStore } from "../../src/core/store.ts";
import { defineCore } from "../../src/core/turn.ts";
import { revive } from "../../src/core/wait.ts";
import type { Workspace } from "../../src/server/agents.ts";
import { type Capabilities, openCapabilities } from "../../src/server/capabilities.ts";
import { hostBox } from "./host-box.ts";
import { FAUX_MODEL } from "./models.ts";

export type Connected = Awaited<ReturnType<typeof openConnected>>;

/** A gateway that takes every message. */
const gateway: Gateway = {
	name: "fake",
	strength: "bearer",
	can: { buttons: false, files: false, threads: true },
	start() {},
	async send() {
		return `out-${process.pid}-${Math.random()}`;
	},
};

export async function openConnected({
	home,
	respond,
	wrapStorage,
	fault,
	install,
	shipped,
	fetch: fetcher,
	retryDelays,
	port = 9,
	registry = createRegistry(),
}: {
	home: string;
	/** The full daemon exposure policy when a test exercises discovery as well as connection admission. */
	registry?: ReturnType<typeof createRegistry>;
	/** Installs more tools, given the core, before the store opens (the browser's, for its fault suite). */
	install?: (core: ReturnType<typeof defineCore>, registry: ReturnType<typeof createRegistry>) => void;
	/** The model: each request answered by this. */
	respond: FauxResponseFactory;
	wrapStorage?: (storage: Storage) => Storage;
	fault?: (point: string) => void;
	/** The port the daemon's sign-in callback is on, when a test cares which. */
	port?: number;
	/** Where the connections banda ships are, for this test. */
	shipped?: string;
	/** How the daemon reaches services, when a test fakes one that is not on this machine (Google's). */
	fetch?: typeof fetch;
	/** How long before a failed listing is tried again, when a test does not want to wait. */
	retryDelays?: readonly number[];
}) {
	const box = openBox(hostBox(home), () => {});
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(Array.from({ length: 2000 }, () => respond));
	const names = () =>
		registry
			.snapshot()
			.tools()
			.map(({ tool }) => tool.name);
	const core = defineCore({
		blobs: new BlobStore(join(home, "blobs")),
		gateway: () => gateway,
		model: () => FAUX_MODEL,
		retryDelay: () => 5,
		tools: names,
		workspace: () => box.workspace,
	});
	registry.install(core.extension);
	registry.install(boxTools({ workspace: box.workspace }));
	install?.(core, registry);
	const harness = await openStore(home, {
		models,
		registry,
		env: boxEnv(box),
		...(wrapStorage === undefined ? {} : { wrapStorage }),
	});
	const logs: string[] = [];
	const workspace: Workspace = {
		env: () => box.env(),
		root: box.workspace,
		tools: () => names().filter((name) => name !== "message_user"),
		known: () => true,
	};
	const capabilities = openCapabilities({
		home,
		harness,
		workspace,
		registry,
		effect: core.effect,
		redirect: () => `http://127.0.0.1:${port}/oauth/callback`,
		log: (line) => logs.push(line),
		...(fault === undefined ? {} : { fault }),
		...(shipped === undefined ? {} : { shipped }),
		...(fetcher === undefined ? {} : { fetch: fetcher }),
		...(retryDelays === undefined ? {} : { retryDelays }),
		agentChanged: core.agentChanged,
	});
	// as the daemon does on start: what was in effect is installed before anything resumes
	await revive(harness);
	await capabilities.carryListings();
	await capabilities.install();
	harness.resume();
	await capabilities.reconcile();
	return {
		home,
		box,
		harness,
		core,
		registry,
		capabilities,
		workspace,
		logs,
		/** The tools the capabilities offer now. */
		offered: () =>
			registry
				.snapshot()
				.tools()
				.filter(({ extension }) => extension.name === "banda.capabilities")
				.map(({ tool }) => tool.name)
				.sort(),
		close: async () => {
			capabilities.close();
			await box.close();
			await harness.close(context);
		},
	};
}

/**
 * The owner signs in, as their browser would: open the link the daemon gave, sign in (the fake server consents at
 * once), and come back to the daemon's callback with the code and state. A sign-in by code: the owner types it on
 * `fake`'s page (consenting, unless `consent` is false), and the daemon finds out when it next asks.
 */
export async function signInAsOwner(
	capabilities: Capabilities,
	name: string,
	{
		fake,
		consent = true,
		agent = LEAD,
		choice = {},
	}: {
		/** What the account asks for, and the account signed in again. */
		choice?: { readonly scopes?: readonly string[]; readonly account?: string };
		fake?: { typeCode(code: string, consent?: boolean): void | Promise<void> };
		consent?: boolean;
		/** The agent the account is switched on for: the lead unless said; null for none (as from Settings). */
		agent?: string | null;
	} = {},
): Promise<{ readonly ok: boolean; readonly words: string }> {
	const started = await capabilities.signIn(name, context, agent ?? undefined, choice);
	if ("code" in started) {
		if (fake === undefined) throw new Error("a sign-in by code needs the fake server to type it on");
		await fake.typeCode(started.code, consent);
		// until it settles: the daemon asks at the server's pace, however loaded the machine is; the test's own timeout
		// is what gives up
		while (true) {
			const shown = (await capabilities.view()).connections.find((c) => c.name === name);
			if (shown?.state === "connected") return { ok: true, words: "connected" };
			if (shown?.state === "problem") return { ok: false, words: shown.problem ?? "a problem" };
			if (shown?.state !== "signing-in" && shown?.state !== "connecting")
				return { ok: false, words: `the sign-in by code stopped (${shown?.state})` };
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	// it needed no sign-in after all: connected at once
	if ("connected" in started) return { ok: true, words: "connected" };
	const response = await fetch(started.url, { redirect: "manual" });
	const back = new URL(response.headers.get("location") ?? "");
	return capabilities.callback({
		...(back.searchParams.get("state") === null ? {} : { state: back.searchParams.get("state") as string }),
		...(back.searchParams.get("code") === null ? {} : { code: back.searchParams.get("code") as string }),
		...(back.searchParams.get("iss") === null ? {} : { iss: back.searchParams.get("iss") as string }),
	});
}

/** The definition of a connection, as banda ships one: the bytes a test takes into effect with `define`. */
export function connectionDefinition({
	url,
	service = "Calendar",
	about = "To see your day and put things in it.",
	auth = "none",
	client,
	scopes,
	account,
	reads = [],
	money = [],
	needs,
	objects,
	groups,
	ask,
}: {
	url: string;
	service?: string;
	about?: string;
	auth?: "none" | "key" | "oauth";
	client?: string;
	scopes?: readonly string[];
	/** The read and field that name the account, `get_me.login`. */
	account?: string;
	reads?: readonly string[];
	money?: readonly string[];
	needs?: { readonly [tool: string]: readonly string[] };
	objects?: unknown;
	groups?: { readonly [group: string]: readonly string[] };
	ask?: "always";
}): string {
	return JSON.stringify({
		service,
		about,
		url,
		auth,
		...(client === undefined ? {} : { client }),
		...(scopes === undefined ? {} : { scopes }),
		...(account === undefined ? {} : { account }),
		reads,
		...(money.length === 0 ? {} : { floors: { money } }),
		...(needs === undefined ? {} : { needs }),
		...(objects === undefined ? {} : { objects }),
		...(groups === undefined ? {} : { groups }),
		...(ask === undefined ? {} : { ask }),
	});
}

/**
 * Take the definition `text` of connection `name` into effect, as a daemon starting on a build that ships it would: on
 * in this home for the first time (`addShipped`), or a changed version picked up (`install`, then what a start does).
 * Returns its version.
 */
export async function define(
	s: Pick<Connected, "capabilities" | "harness">,
	name: string,
	text: string,
): Promise<string> {
	const read = readDefinition(name, text);
	if ("errors" in read) throw new Error(`${name}: ${read.errors.join("; ")}`);
	const known = await s.harness.commit(async (tx) => (await tx.doc(ConnectedDoc)).added[name] !== undefined, context);
	(shippedDefinitions() as Map<string, Shipped>).set(name, read.connection);
	if (known) {
		await s.capabilities.install();
		await s.capabilities.reconcile();
	} else await s.capabilities.addShipped(name);
	// a tool the server lists that the definition does not name waits off: on, as a test of what it does expects
	await turnOnWaiting(s, name);
	return read.connection.version;
}

/** The owner switching tool `tool` (the model's name for it) on or off, in its connection's details. */
export async function switchTool(s: Pick<Connected, "capabilities">, tool: string, on: boolean): Promise<void> {
	const name = tool.slice(0, tool.indexOf("__"));
	const shown = (await s.capabilities.view()).connections.find((connection) => connection.name === name);
	const found = shown?.tools.find((each) => each.name === tool);
	if (shown === undefined || found === undefined) throw new Error(`there is no tool named ${tool}`);
	const setting = !on ? "off" : found.classed?.kind === "read" && found.classed.from !== "server" ? "allow" : "ask";
	await s.capabilities.setTools(name, { [found.title]: setting }, shown.accepted?.version);
}

/** Every tool of connection `name` waiting for the owner, switched on. */
export async function turnOnWaiting(s: Pick<Connected, "capabilities">, name: string): Promise<void> {
	const shown = (await s.capabilities.view()).connections.find((connection) => connection.name === name);
	for (const tool of shown?.tools ?? []) if (tool.waiting === true) await switchTool(s, tool.name, true);
}

/** The owner's side of a sign-in by code at a fake server in another process: they type it on its page. */
export const typingAt = (origin: string) => ({
	async typeCode(code: string, consent = true) {
		const typed = await fetch(`${origin}/device`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ user_code: code, consent: consent ? "yes" : "no" }).toString(),
		});
		if (!typed.ok) throw new Error(`typing the code: ${typed.status}`);
	},
});
