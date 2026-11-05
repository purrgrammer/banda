/**
 * The box (DESIGN.md "The box"): the agents' computer, a container. The daemon reaches it through pi-env's daemon over
 * one connection, so the box is only its setup (`ensure`) and the command that starts pi-env in it. Its network is the
 * egress proxy's, when it has one; inside, tools run freely.
 */

import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import type { EgressControl } from "../core/egress.ts";
import type { BrowserSetup } from "./browser.ts";
import { containerBox, dockerAvailable, sweepBoxes } from "./container.ts";
import type { Pushed } from "./egress-config.ts";
import { hostBox } from "./host.ts";

/** What the daemon tells the egress proxy: whose logins it trusts, credentials, and what goes straight through. */
export type EgressConfig = {
	/** The key proxy logins are marked with (hex). */
	readonly key: string;
	/** Forges whose git fetches (a POST to upload-pack) the proxy reads; elsewhere such a POST is a write. */
	readonly git?: readonly string[];
	/** The daemon's own port, never reached. */
	readonly daemonPort?: number;
	/** Credentials set at the proxy for a host, never in the box. */
	readonly credentials: readonly {
		readonly host: string;
		readonly header: string;
		readonly value: string;
		readonly scheme?: "http";
	}[];
	/**
	 * The hosts the owner allowed, by chat, for the agent each chat runs (`permittedHosts`): a chat's writes there go
	 * straight through; none carrying a credential of its own, and never the browser's.
	 */
	readonly permitted?: { readonly [chat: string]: readonly string[] };
	/** The generation of this config, which the proxy never goes back from (set by the push). */
	readonly generation?: number;
	/** Each agent's browser's tabs, by chat: whether the owner holds each. A stamped request is its tab's chat's. */
	readonly browsers?: {
		readonly [agent: string]: { readonly tabs: { readonly [chat: string]: { readonly owner: boolean } } };
	};
};

/** The box's egress proxy, as the daemon drives it. */
export type BoxEgress = EgressControl & {
	/** The environment that sends a command of `chat` (0: nobody's, the daemon's own listing, which only reads) through the proxy as itself. */
	env(chat: number): Record<string, string>;
	/** Where the config comes from; it is pushed at every bring-up of the box and by `configure`. */
	source(from: () => Promise<Omit<EgressConfig, "key">>): void;
	/**
	 * Push the config now, after any push before it, read from the store at its turn: resolved once the proxy has it, or
	 * was stopped because it could not be told; thrown only when it could be neither.
	 */
	configure(): Promise<Pushed>;
	/** The chats with writes sent under a host permission the daemon has not taken yet (`sweepSent`). */
	sentChats(ctx: Context): Promise<readonly number[]>;
	/** Let one browser write of `chat` with this hash through the proxy, once. */
	pass(chat: number, hash: string): Promise<void>;
};

/** How a box is made. */
export type BoxSetup = {
	/** The workspace, in the box's own paths. */
	readonly workspace: string;
	/** Where attachments that came in are written, outside the workspace. */
	readonly attachments: string;
	/** Bring the box up (build, create, start) if it is not; called before every start of pi-env in it. */
	ensure(): Promise<void>;
	/** The command that starts pi-env in the box, before its own `serve` arguments. */
	readonly command: readonly string[];
	/** Its egress proxy, when its network is closed but for one; a box without one is a test's. */
	readonly egress?: BoxEgress;
	/** How it starts agent `agent`'s browser (each its own profile and proxy login), when it has browsers. */
	readonly browser?: (agent: string) => BrowserSetup;
	/** Host mode: no box, its commands run on the daemon's own machine (`hostBox`). */
	readonly host?: true;
};

/** Whether the box is up, as its last bring-up went: `offline` with why, rather than any fallback. */
export type BoxState = { readonly state: "starting" | "up" } | { readonly state: "offline"; readonly why: string };

export type Box = {
	readonly workspace: string;
	/** Host mode: no box, its commands run on the daemon's own machine. */
	readonly host: boolean;
	readonly attachments: string;
	readonly egress?: BoxEgress;
	/** How it starts agent `agent`'s browser (each its own profile and proxy login), when it has browsers. */
	readonly browser?: (agent: string) => BrowserSetup;
	/** Bring it up, if it is not; what failed, thrown. */
	ensure(): Promise<void>;
	/** The box as an `ExecutionEnv`, at `cwd` (default the workspace), with `env` added to every command's environment. */
	env(cwd?: string, env?: Record<string, string>): ExecutionEnv;
	/** Bring it up now rather than at the first tool call; its failure is logged, and the next use tries again. */
	warm(): void;
	/** How its last bring-up went. */
	state(): BoxState;
	/** Told whenever its state changes. */
	watch(listener: () => void): () => void;
	/** Stop pi-env, which kills every command it started; the box itself stays. */
	close(): void;
};

export function openBox(setup: BoxSetup, log: (line: string) => void): Box {
	let running: Promise<void> | undefined;
	let state: BoxState = { state: "starting" };
	const listeners = new Set<() => void>();
	// while offline, it tries again now and then, so the app says when it is back without waiting for a tool call
	let retry: NodeJS.Timeout | undefined;
	let closed = false;
	const set = (next: BoxState) => {
		clearTimeout(retry);
		if (next.state === "offline" && !closed) {
			retry = setTimeout(() => void ensure().catch(() => undefined), RETRY_OFFLINE_MS);
			retry.unref();
		}
		if (JSON.stringify(next) === JSON.stringify(state)) return;
		state = next;
		for (const listener of listeners) listener();
	};
	// one bring-up at a time, and a fresh one at every start of pi-env: a lost connection may mean the box went away
	const ensure = () =>
		(running ??= setup
			.ensure()
			.then(
				() => set({ state: "up" }),
				(error: unknown) => {
					set({ state: "offline", why: error instanceof Error ? error.message : String(error) });
					throw error;
				},
			)
			.finally(() => (running = undefined)));
	const connection = new Connection({
		command: async () => {
			await ensure();
			return setup.command;
		},
		onLog: (text) => log(`box: ${text.trimEnd()}`),
	});
	return {
		workspace: setup.workspace,
		attachments: setup.attachments,
		host: setup.host === true,
		...(setup.egress === undefined ? {} : { egress: setup.egress }),
		...(setup.browser === undefined ? {} : { browser: setup.browser }),
		ensure,
		env: (cwd, env) =>
			new RemoteExecutionEnv({
				connection,
				id: "banda:box",
				cwd: cwd ?? setup.workspace,
				...(env === undefined || Object.keys(env).length === 0 ? {} : { shellEnv: env }),
			}),
		warm: () => {
			ensure().then(
				() => log("box: up"),
				(error: unknown) => log(`box: ${error instanceof Error ? error.message : String(error)}`),
			);
		},
		state: () => state,
		watch: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		close: () => {
			closed = true;
			clearTimeout(retry);
			connection.close();
		},
	};
}

/** How long an offline box waits before trying to come up again. */
const RETRY_OFFLINE_MS = 15_000;

/** Which box: the container (the default), or host mode, which the owner asks for by name and nothing falls back to. */
export type BoxKind = "container" | "host";

/** The box kind `value` names (`--box`, `BANDA_BOX`); unset is the container. */
export function boxKind(value: string | undefined): BoxKind {
	if (value === undefined || value === "" || value === "container") return "container";
	if (value === "host") return "host";
	throw new Error(`--box is container or host, not ${value}`);
}

/** What host mode drops, in one line: said at start. */
export const HOST_WARNING =
	"no box: commands run on this computer, in the home's workspace, without banda's network guard, the credentials it sets or a browser";

/**
 * The container box; banda needs Docker (or Podman's docker). Without one the box is offline, and says so, until a
 * Docker server answers: there is no box without its closed network. Host mode only when `kind` names it.
 */
export async function chooseBox(
	home: string,
	log: (line: string) => void = () => {},
	kind: BoxKind = "container",
): Promise<BoxSetup> {
	if (kind === "host") return hostBox(home);
	if (!(await dockerAvailable())) log("box: banda needs Docker: no Docker server answers");
	// what boxes of homes since deleted left behind goes, in the background: it holds the networks a new box needs
	else
		void sweepBoxes().then(
			(swept) => {
				if (swept.length > 0) log(`box: removed ${swept.length} left behind by homes that are gone`);
			},
			() => {},
		);
	return containerBox(home);
}
