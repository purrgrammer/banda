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
	/** Where the connections banda ships are, for this test. */
	shipped?: string;
	/** How the daemon reaches servers, a built-in API's fake among them; the network when not said. */
	fetch?: typeof fetch;
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
		listEnv: () => box.env(),
		redirect: () => "http://127.0.0.1:9/oauth/callback",
		log: (line) => logs.push(line),
		...(fault === undefined ? {} : { fault }),
		...(shipped === undefined ? {} : { shipped }),
		...(fetcher === undefined ? {} : { fetch: fetcher }),
		// the fake servers are on this machine: the tests probe them as they are
		probe: fetch,
		agentChanged: core.agentChanged,
	});
	// as the daemon does on start: what was in effect is installed before anything resumes
	await revive(harness);
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
			box.close();
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
	}: {
		fake?: { typeCode(code: string, consent?: boolean): void | Promise<void> };
		consent?: boolean;
		/** The agent the account is switched on for: the lead unless said; null for none (as from Settings). */
		agent?: string | null;
	} = {},
): Promise<{ readonly ok: boolean; readonly words: string }> {
	const started = await capabilities.signIn(name, context, agent ?? undefined);
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

/** A connection file. */
export function connectionFile({
	url,
	command,
	service = "Calendar",
	auth = "none",
	client,
	scopes,
	reads = [],
	money = [],
	why = "To see your day and put things in it.",
}: {
	url?: string;
	command?: string;
	service?: string;
	auth?: "none" | "key" | "oauth";
	client?: string;
	scopes?: readonly string[];
	reads?: readonly string[];
	money?: readonly string[];
	why?: string;
}): string {
	return [
		"---",
		`service: ${service}`,
		...(url === undefined ? [] : [`url: ${url}`]),
		...(command === undefined ? [] : [`command: ${command}`]),
		...(auth === "none" ? [] : [`auth: ${auth}`]),
		...(client === undefined ? [] : [`client: ${client}`]),
		...(scopes === undefined ? [] : [`scopes: [${scopes.join(", ")}]`]),
		`reads: [${reads.join(", ")}]`,
		...(money.length === 0 ? [] : [`money: [${money.join(", ")}]`]),
		"---",
		why,
		"",
	].join("\n");
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
