/**
 * The daemon: the one process that opens the store. It holds an exclusive lock on `<home>/daemon.lock` for its
 * lifetime, which the OS releases when the process dies, and publishes its port and token in `<home>/daemon.json`.
 */
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
	type ConversationId,
	defineExtension,
	type Harness,
	type HarnessSettings,
	type ModelRef,
	type TaskId,
} from "@earendil-works/pi-durable";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
import { type Box, type BoxKind, type BoxSetup, chooseBox, HOST_WARNING, openBox } from "./box/box.ts";
import { Refused } from "./box/browser.ts";
import {
	browserTools,
	giveBrowserBack,
	type KeyPlace,
	keepSignedIn,
	openingAt,
	SignedIn,
} from "./box/browser-tools.ts";
import { type Browsers, openBrowsers } from "./box/browsers.ts";
import { attachmentsIn, boxEnv, boxTools } from "./box/tools.ts";
import { webFetchTool } from "./box/web-fetch.ts";
import { registerAccount } from "./core/account-provider.ts";
import { ActivityLog } from "./core/activity.ts";
import { Accepted, AgentChats, agentPath } from "./core/agents.ts";
import { stopArchived } from "./core/archive.ts";
import type { EffectTool } from "./core/ask.ts";
import { askHostsTool } from "./core/ask-hosts.ts";
import { avatarInstructionsExtension } from "./core/avatar-instructions.ts";
import { BlobStore, Blobs, safeName } from "./core/blobs.ts";
import { ChatReads, readChat } from "./core/chat-reads.ts";
import { compactionExtension, compactionSettings } from "./core/compaction.ts";
import { Companion } from "./core/companion.ts";
import { Connected } from "./core/connections.ts";
import { pause, pauseRoutine, resume } from "./core/control.ts";
import { GIT_HOSTS, proposeSendTool, proxyKnows, sweepSent } from "./core/egress.ts";
import { dropEmptyReplies } from "./core/empty-replies.ts";
import { type Gateway, INLINE_IMAGES, mimeOf, OWNER, routeKey } from "./core/gateway.ts";
import { guardImages } from "./core/images.ts";
import { MemoryLock, memoryExtension } from "./core/memory.ts";
import { nowExtension } from "./core/now.ts";
import { allowHost, onPermissions, Permissions, revoke } from "./core/permissions.ts";
import { FileCredentialStore } from "./core/provider-credentials.ts";
import { Control, RoutineRefused, Routines } from "./core/routines.ts";
import { Search } from "./core/search.ts";
import { searchService } from "./core/search-service.ts";
import { searchExtension } from "./core/search-tools.ts";
import { skillsExtension } from "./core/skills.ts";
import { status } from "./core/status.ts";
import { context, openStore } from "./core/store.ts";
import { timeThinking } from "./core/timing.ts";
import { toolDiscoveryExtension, toolRegistry, toolSearchExtension } from "./core/tool-discovery.ts";
import { isMessageTool } from "./core/toolsets.ts";
import { defineCore, Routes, stop as stopChat, type TurnResult } from "./core/turn.ts";
import { answer, dismissQuestion, revive } from "./core/wait.ts";
import { CliGateway } from "./gateways/cli.ts";
import { WebGateway } from "./gateways/web.ts";
import { daemonFile, egressCredentials, keepEgressCredential, maxFileBytes, ownerToken, readConfig } from "./home.ts";

import { accept, agents, decline, save, seed, seedUntilDone, type Workspace, watchAgents } from "./server/agents.ts";
import type { ComputerView, OwnerInput, Posted, PostMessage, ViewEvent } from "./server/api.ts";
import { acceptedIconFace } from "./server/avatar-icon-face.ts";
import { bringable, chooseBring } from "./server/bring.ts";
import { type Capabilities, openCapabilities } from "./server/capabilities.ts";
import { change, companion, validPicks } from "./server/companion.ts";
import { openDevices } from "./server/devices.ts";
import { BadRequest, handler } from "./server/http.ts";
import { add as addFact, boxMemory, edit as editFact, memory, remove as removeFact } from "./server/memory.ts";
import { openObjects } from "./server/objects.ts";
import { openRemote, type Remote, type RemoteSettings, type RemoteState, remoteSettings } from "./server/remote.ts";
import type { Area, Boot } from "./server/routes/area.ts";
import { AREAS } from "./server/routes/index.ts";
import {
	accept as acceptRoutine,
	control,
	decline as declineRoutine,
	remove as removeRoutine,
} from "./server/routines.ts";
import { seenBy } from "./server/seen.ts";
import { acceptSkill, acceptSkills, chooseShippedSkills, saveSkill, shippedSkills, skills } from "./server/skills.ts";
import { chatContext, chatPrompt, chats, image, item, items, live, messageFile, shell } from "./server/transcript.ts";

/** How often blobs no chat holds are swept. */
const SWEEP_EVERY_MS = 6 * 60 * 60_000;
/** How often every chat's writes sent under a host permission are taken into the store. */
const SENT_SWEEP_MS = 60_000;
/** How soon a proxy that could be neither told nor stopped is tried again. */
const PROXY_RETRY_MS = 5_000;

export type DaemonOptions = {
	readonly home: string;
	/** Loopback port; 0 picks a free one. */
	readonly port?: number;
	/** pi-ai models; default every built-in provider, keys from the environment. */
	readonly models?: MutableModels;
	readonly settings?: HarnessSettings;
	readonly log?: (line: string) => void;
	/** The built web UI it serves; default `web/dist`. */
	readonly web?: string;
	/** The box the agents work in; default the one `boxKind` names. */
	readonly box?: BoxSetup;
	/** Which box, when `box` is not given: the container (the default), or host mode, asked for by name. */
	readonly boxKind?: BoxKind;
	/**
	 * Tools whose effect leaves the box, each run only as an approved draft or within a permission. None ships yet: a
	 * connection (slice 6) brings the first; tests and the smoke run pass their own.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: an effect tool of any parameters
	readonly effects?: readonly EffectTool<any>[];
	/** Where devices reach it over Iroh; default the config's `remote`, and `BANDA_REMOTE`. */
	readonly remote?: RemoteSettings;
	/** Where the connections banda ships are; default `shipped/connections/` of its install. */
	readonly shipped?: string;
};

export type Daemon = {
	readonly port: number;
	/** Settles once the daemon has stopped: `failed` when the store failed under it. */
	readonly stopped: Promise<{ readonly failed: boolean }>;
	close(): Promise<void>;
};

/** How long a close waits for sends in flight: a send still going after it goes again after the restart. */
const SEND_DRAIN_MS = 10_000;

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
	const { home } = options;
	const log = options.log ?? ((line) => console.error(line));
	await mkdir(home, { recursive: true, mode: 0o700 });
	const lock = acquireLock(home);
	let harness: Harness | undefined;
	let search: Search | undefined;
	let box: Box | undefined;
	let browsers: Browsers | undefined;
	let server: Server | undefined;
	let remote: Remote | undefined;
	/** The endpoint binding, or bound: at most one at a time. */
	let binding: Promise<Remote> | undefined;
	/** Where remote reach stands (`DevicesView.remote`). */
	let remoteState: RemoteState = "off";
	let stopping = false;
	let sweeping: NodeJS.Timeout | undefined;
	let sweepingSent: NodeJS.Timeout | undefined;
	let sweepSentNow: (() => Promise<void>) | undefined;
	// the daemon's own port, which every config the proxy is told carries: a push waits for it, so no config ever
	// leaves the daemon's port reachable from the box; it fails if the daemon stops before it listens
	let listening!: (port: number) => void;
	let notListening!: (error: Error) => void;
	const portKnown = new Promise<number>((resolve, reject) => {
		listening = resolve;
		notListening = reject;
	});
	portKnown.catch(() => undefined);
	// the box tools' hook before a command: the proxy knows what its chat may send straight through
	let egressReady: (chat: number) => Promise<void> = async () => {};
	let unwatch: (() => Promise<void>) | undefined;
	let unwatchPermissions: (() => Promise<void>) | undefined;
	let unwatchBox: (() => void) | undefined;
	let drain: ((ms: number) => Promise<void>) | undefined;
	let stop: Promise<void> | undefined;
	let failed = false;
	let stopped!: (end: { failed: boolean }) => void;
	const ended = new Promise<{ failed: boolean }>((resolve) => (stopped = resolve));
	const gateways = new Map<string, Gateway>();
	let areas: readonly Area[] = [];
	const close = () =>
		(stop ??= (async () => {
			const step = async (what: string, run: () => unknown) => {
				try {
					await run();
				} catch (error) {
					log(`close: ${what}: ${error instanceof Error ? error.message : String(error)}`);
				}
			};
			clearInterval(sweeping);
			notListening(new Error("the daemon stopped before it listened"));
			clearInterval(sweepingSent);
			if (unwatch !== undefined) await step("agents watch", unwatch);
			if (unwatchPermissions !== undefined) await step("permissions watch", unwatchPermissions);
			unwatchBox?.();
			// sends the gateways have taken are recorded before the gateways and the store go, so none goes twice
			const sends = drain;
			if (sends !== undefined) await step("sends", () => sends(SEND_DRAIN_MS));
			for (const gateway of gateways.values()) await step(gateway.name, () => gateway.stop?.());
			// an area's work in flight, a provider's sign-in and its callback server among them, ends before the process
			// may exit: a listener left open keeps it alive
			for (const area of areas) await step("area", () => area.stop?.());
			stopping = true;
			const reach = binding;
			if (reach !== undefined) await step("remote", async () => (await reach.catch(() => undefined))?.close());
			if (server !== undefined) {
				const listening = server;
				await step(
					"http",
					() =>
						new Promise<void>((resolve) => {
							listening.close(() => resolve());
							listening.closeAllConnections();
						}),
				);
			}
			// the writes the proxy sent under a host permission are logged before the store goes
			const sweepingLast = sweepSentNow;
			if (sweepingLast !== undefined) await step("sent", sweepingLast);
			const store = harness;
			if (store !== undefined) await step("store", () => store.close(context));
			const index = search;
			if (index !== undefined) await step("search", () => index.close());
			const browsing = browsers;
			if (browsing !== undefined) await step("browser", () => browsing.close());
			const opened = box;
			if (opened !== undefined) await step("box", () => opened.close());
			await step("daemon.json", () => rm(daemonFile(home), { force: true }));
			lock.close();
			stopped({ failed });
		})());
	try {
		const config = await readConfig(home);
		const fileLimit = maxFileBytes(config);
		const turnEnded = async (turn: number) => {
			if (harness === undefined) throw new Error("the store is not open");
			return (await harness.waitForTask(turn as TaskId<TurnResult>, context)).state.outcome;
		};
		const cli = new CliGateway({
			ended: async (turn) => {
				const outcome = await turnEnded(turn);
				if (outcome.status !== "completed") return `(the turn ended: ${outcome.status})`;
				const { result } = outcome;
				return "failed" in result
					? `(the run failed: ${result.failed})`
					: result.ended === "stopped"
						? "(stopped)"
						: "";
			},
		});
		const web = new WebGateway();
		for (const gateway of [cli, web]) gateways.set(gateway.name, gateway);
		const blobs = new BlobStore(join(home, "blobs"));
		const agentBox = openBox(options.box ?? (await chooseBox(home, log, options.boxKind)), log);
		box = agentBox;
		if (agentBox.host) {
			log(`box: ${HOST_WARNING}`);
			// they are set at the proxy, and host mode has none: a connection that needs one fails as it would without it
			const unset = await egressCredentials(home, log);
			if (unset.length > 0)
				log(
					`box: no box, so the credentials auth/egress.json sets for ${unset.map((c) => c.host).join(", ")} are not set`,
				);
		}
		const registry = toolRegistry();
		registry.install(toolSearchExtension);
		// what a watch looks with: the connections' reads, once they are open below
		let reader: Pick<Capabilities, "readFor"> | undefined;
		const core = defineCore({
			blobs,
			registry,
			read: (connection, account, tool, args, authority, ctx) =>
				reader === undefined
					? Promise.resolve({ failed: "banda is still starting" })
					: reader.readFor(connection, account, tool, args, authority, ctx),
			writeSkill: async (chat, requestId, entry, ctx) => {
				const conversation = await harness?.conversation(chat as ConversationId, ctx);
				if (conversation === undefined) throw new Error(`chat ${chat} is gone`);
				await conversation.submit({ type: "write", requestId, entry }, ctx);
			},
			maxFileBytes: fileLimit,
			box: attachmentsIn(agentBox),

			workspace: () => agentBox.workspace,
			gateway: (name) => gateways.get(name),
			model: () => config.model,
			// every tool installed, which the lead's new chats get
			tools: () =>
				registry
					.snapshot()
					.tools()
					.map(({ tool }) => tool.name),
			log,
			// the owner's origin on a gateway that reaches them unprompted
			ownerOrigin: (except) =>
				[...gateways.values()]
					.map((gateway) => gateway.ownerOrigin?.())
					.find((origin) => origin !== undefined && (except === undefined || routeKey(origin) !== routeKey(except))),
		});
		// every image the daemon decodes is measured from its header first
		const images = guardImages(await createNodePhotonImages());
		drain = core.drain;
		registry.install(core.extension);
		registry.install(core.groupExtension);
		registry.install(compactionExtension);
		registry.install(avatarInstructionsExtension);
		registry.install(skillsExtension);
		registry.install(
			boxTools({
				images,
				workspace: agentBox.workspace,
				...(agentBox.egress === undefined ? {} : { egress: agentBox.egress }),
				ready: (chat) => egressReady(chat),
			}),
		);
		// reading the web: a GET from the box, through the proxy as the chat, acting as nobody; it asks no one
		registry.install(
			defineExtension({
				name: "banda.web",
				tools: [webFetchTool(agentBox.egress === undefined ? {} : { egress: agentBox.egress })],
			}),
		);
		// the browsers, in the box, one per agent: whose each one's requests are is what the proxy is told, with the rest
		// of its config
		let keepKey: (key: string, place: KeyPlace) => Promise<void> = async () => {
			throw new Error("the daemon is not up yet");
		};
		let signedIn: (site: string, chat: number) => Promise<void> = async () => {};
		let browserChanged = () => {};
		const egressOf = agentBox.egress;
		const setupOf = agentBox.browser;
		const agentBrowsers =
			setupOf === undefined
				? undefined
				: openBrowsers({
						setup: setupOf,
						ensure: () => agentBox.ensure(),
						// a chat drives the browser of the agent it runs, never another's
						agentOf: async (chat) => {
							if (harness === undefined) throw new Error("the store is not open");
							const agent = (await harness.snapshot(AgentChats, context))?.chats[chat];
							if (agent === undefined) throw new Refused("This chat runs no agent, so it has no browser.");
							return agent;
						},
						tell: async () => {
							await egressOf?.configure();
						},
						// a request to a site the owner signed in to: whose session, and whether this task may open it
						sessionAt: async (agent, chat, url, cookies) => {
							if (harness === undefined) throw new Error("the store is not open");
							const store = harness;
							if (Object.keys((await store.snapshot(SignedIn, context))?.agents[agent] ?? {}).length === 0)
								return undefined;
							let host: string;
							try {
								host = new URL(url).hostname;
							} catch {
								return undefined;
							}
							return store.commit((tx) => openingAt(tx, chat, host, cookies, Date.now()), context);
						},
						log,
						changed: () => browserChanged(),
					});
		browsers = agentBrowsers;
		if (agentBrowsers !== undefined)
			registry.install(
				defineExtension({
					name: "banda.browser",
					tools: browserTools({
						browser: (chat) => agentBrowsers.for(chat),
						...(egressOf === undefined ? {} : { egress: egressOf }),
						effect: core.effect,
						ask: core.ask,
						keep: (key, place) => keepKey(key, place),
						giveBack: async (chat) => {
							if (harness === undefined) throw new Error("the store is not open");
							await giveBrowserBack(harness, await agentBrowsers.for(chat));
						},
						signedIn: (site, chat) => signedIn(site, chat),
					}),
				}),
			);
		// a request the egress proxy held is sent only as an approved draft, or within a permission over its route
		const effects = [
			...(agentBox.egress === undefined ? [] : [proposeSendTool(agentBox.egress), askHostsTool()]),
			...(options.effects ?? []),
		];
		if (effects.length > 0)
			registry.install(defineExtension({ name: "banda.effects", tools: effects.map((tool) => core.effect(tool)) }));
		// memory: files in the box, found through the one derived store
		const memoryFiles = boxMemory({ env: () => agentBox.env(), root: agentBox.workspace });
		const memoryLock = new MemoryLock();
		const index = new Search(join(home, "search.db"));
		search = index;
		const retrieval = searchService({
			index,
			groups: core.groups,
			blobs,
			harness: () => {
				if (harness === undefined) throw new Error("the store is not open");
				return harness;
			},
		});
		registry.install(searchExtension(retrieval));
		let memoryChanged = () => {};
		registry.install(
			memoryExtension({ files: memoryFiles, search: index, lock: memoryLock, changed: () => memoryChanged() }),
		);
		// the date, the hour and how full memory is, for every agent, as a status line beside the prompt's fixed start
		registry.install(nowExtension(Date.now, memoryFiles));
		registry.install(toolDiscoveryExtension);
		// each area's extensions, before the store opens: what it installs is there when anything resumes
		const boot: Boot = { core, blobs, config, home, retrieval, root: agentBox.workspace, log };
		for (const area of AREAS) for (const extension of area.install?.(boot) ?? []) registry.install(extension);
		const credentials = new FileCredentialStore(home);
		const models = timeThinking(dropEmptyReplies(options.models ?? builtinModels({ credentials })));
		// each account beyond a backend's first, cloned from the wrapped backend so it is wrapped the same
		const stored = await credentials.list().catch((error: unknown) => {
			log(`provider accounts: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		});
		for (const { providerId } of stored) registerAccount(models, providerId);
		const seen = (model: ModelRef) => seenBy(model, models.getModel(model.provider, model.modelId)?.baseUrl);
		harness = await openStore(home, {
			models,
			registry,
			env: boxEnv(agentBox),
			settings: { compaction: compactionSettings(models), ...options.settings },
			onReport: (error, info) => log(`${info.type}: ${error instanceof Error ? error.message : String(error)}`),
		});
		const open = harness;
		void open.closed.then((end) => {
			if (end.reason !== "failed") return;
			failed = true;
			log(`the store failed: ${end.error instanceof Error ? end.error.message : String(end.error)}`);
			void close();
		});
		// The docs the web watches exist from the start: a watch acquires only a doc that does.
		await open.commit(async (tx) => {
			await tx.doc(Routes);
			await tx.doc(ChatReads);
			await tx.doc(Accepted);
			await tx.doc(Companion);
			await tx.doc(Routines);
			await tx.doc(Control);
			await tx.doc(ActivityLog);
			await tx.doc(Permissions);
			await tx.doc(Connected);
			await tx.doc(SignedIn);
		}, context);
		// the proxy learns what the store holds at every bring-up of the box, and whenever the permissions change (a
		// host the owner allowed takes writes at the proxy; one taken back, no more)
		let port = 0;
		const git = config.egress?.git ?? GIT_HOSTS;
		const knows = proxyKnows(open, () => tellProxy());
		agentBox.egress?.source(async () => ({
			git,
			daemonPort: await portKnown,
			credentials: await egressCredentials(home, log),
			permitted: await knows.permitted(),
			browsers: agentBrowsers?.holders() ?? {},
		}));
		/**
		 * Tell the proxy what the store says now, whether or not the box is up (a proxy that runs from before is told
		 * too); one stopped because it could not be told is brought up again, holding everything until it is. Thrown
		 * only when it could be neither told nor stopped: then it is tried again until it is.
		 */
		let retrying: NodeJS.Timeout | undefined;
		const tellProxy = async (): Promise<void> => {
			const egress = agentBox.egress;
			if (egress === undefined) return;
			try {
				const pushed = await egress.configure();
				if (pushed === "told") knows.told();
				clearTimeout(retrying);
				retrying = undefined;
				if (pushed === "stopped")
					void agentBox.ensure().catch((error: unknown) => log(`egress: ${(error as Error).message}`));
			} catch (error) {
				log(`egress: ${error instanceof Error ? error.message : String(error)}`);
				if (retrying === undefined && stop === undefined) {
					retrying = setTimeout(() => {
						retrying = undefined;
						if (stop === undefined) void tellProxy().catch(() => undefined);
					}, PROXY_RETRY_MS);
					retrying.unref();
				}
				throw error;
			}
		};
		const tellProxyQuietly = () => tellProxy().catch(() => undefined);
		// a chat the proxy was not told of yet is told before its command runs, so its first push goes through
		egressReady = (chat) => knows.ready(chat);
		unwatchPermissions = await onPermissions(open, tellProxyQuietly);
		// every chat's writes the proxy sent under a host permission are logged, whether or not the chat runs a command
		// again (a process the box left running pushes too): at bring-up, every minute, and before the daemon stops
		let sweepingNow: Promise<void> | undefined;
		const sweepSentOnce = () =>
			(sweepingNow ??= (async () => {
				const egress = agentBox.egress;
				if (egress === undefined || agentBox.state().state !== "up") return;
				await sweepSent(egress, open, Date.now).catch((error: unknown) =>
					log(`egress: the sent writes were not taken: ${error instanceof Error ? error.message : String(error)}`),
				);
			})().finally(() => {
				sweepingNow = undefined;
			}));
		sweepSentNow = sweepSentOnce;
		sweepingSent = setInterval(() => void sweepSentOnce(), SENT_SWEEP_MS);
		sweepingSent.unref();
		const sweepAtBringUp = agentBox.watch(() => {
			if (agentBox.state().state === "up") void sweepSentOnce();
		});
		const workspace: Workspace = {
			env: () => agentBox.env(),
			root: agentBox.workspace,
			// the speaking tools come with every chat, so a file need not name them; message_group with every group, so none may
			tools: () =>
				registry
					.snapshot()
					.tools()
					.flatMap(({ tool }) => (isMessageTool(tool.name) ? [] : [tool.name])),
			known: (model) => models.getModel(model.provider, model.modelId) !== undefined,
		};
		let capabilitiesChanged = () => {};
		// connections and the tools the agent built: what is in effect is installed before anything resumes
		const capabilities = openCapabilities({
			home,
			blobs,
			harness: open,
			workspace,
			registry,
			effect: core.effect,
			// a server the agent built is listed in its box, reading as nobody's chat (0)
			listEnv: () => agentBox.env(undefined, agentBox.egress?.env(0)),
			...(agentBox.egress === undefined ? {} : { egress: agentBox.egress }),
			redirect: () => `http://127.0.0.1:${port}/oauth/callback`,
			log,
			changed: () => capabilitiesChanged(),
			agentChanged: core.agentChanged,
			...(options.shipped === undefined ? {} : { shipped: options.shipped }),
		});
		await capabilities.install();
		reader = capabilities;
		const objects = openObjects({ harness: open, capabilities, blobs });
		// the lead proposes a new agent by writing its before-file into the box; the owner reviews and accepts it in Agents

		// a key a page showed is kept in auth/ alone: as a connection's key, or a credential the proxy sets for a host
		keepKey = async (key, place) => {
			if ("connection" in place) {
				try {
					await capabilities.setKey(place.connection, key);
				} finally {
					capabilitiesChanged();
				}
				return;
			}
			await keepEgressCredential(home, {
				host: place.host,
				header: place.header,
				value: `${place.prefix ?? ""}${key}`,
			});
			await agentBox.egress?.configure();
		};
		// a sign-in is the browser's of the agent the chat runs: that agent's alone
		signedIn = async (site, chat) => {
			await open.commit(async (tx) => {
				const agent = (await tx.doc(AgentChats)).chats[chat];
				if (agent !== undefined) await keepSignedIn(tx, agent, site, chat, Date.now());
			}, context);
			// told either way: giving the browser back may have kept it already
			capabilitiesChanged();
		};
		const capabilitiesView = async () => {
			const agents = (await open.snapshot(SignedIn, context))?.agents ?? {};
			return {
				...(await capabilities.view()),
				signedIn: Object.entries(agents)
					.flatMap(([agent, sites]) => Object.entries(sites).map(([site, { at }]) => ({ agent, site, at })))
					.sort((a, b) => b.at - a.at),
			};
		};
		// a tool that waited on an ask through restarts is not stuck, whatever the restart limit counted
		await revive(open);
		// what this daemon installed is what every chat is sent, however old the chat
		await core.reconcileTools(open);
		open.resume();
		// every accepted routine has its task, whatever a crash left between a change and its task
		await core.reconcile(open);
		// an archived agent runs nothing, whatever a crash left between its archive and the stop that followed
		await stopArchived(open);
		// and an archived group, whatever a crash left between its archive and its stop
		await core.groups.stopArchived(open);
		/** After an agent file is accepted: an archived agent's runs stop, and its paused routines lose their tasks. */
		const settleAgents = async () => {
			await stopArchived(open);
			await core.reconcile(open);
		};
		agentBox.warm();
		// a connection whose credentials came in before a crash kept its tools from being listed is listed now
		void capabilities.reconcile().catch((error: unknown) => log(`capabilities: ${(error as Error).message}`));
		// a new box starts with the accepted agents, the lead among them; the agents are read once the first try is over,
		// and a box that was not up for it is seeded when it comes up (until then no missing file is offered as removed)
		const seeded = seed(open, workspace).then(
			() => true,
			(error: unknown) => {
				log(`agents: ${(error as Error).message}`);
				return false;
			},
		);
		void seeded.then((done) => (done ? undefined : seedUntilDone(open, workspace, log, () => stop !== undefined)));
		const listAgents = () => seeded.then(() => agents(open, workspace));
		// the owner reaches a chat's tab, in the browser of the agent it runs; or signs an agent the store knows out of a site
		const tabOf = async (all: Browsers, chat: number) => {
			try {
				return await all.for(chat);
			} catch (error) {
				if (error instanceof Refused) throw new BadRequest(error.message, 404);
				throw error;
			}
		};
		const knownAgent = async (agent: string) => {
			if ((await open.snapshot(Accepted, context))?.files[agentPath(agent)] === undefined)
				throw new BadRequest("there is no such agent", 404);
		};
		const desk = { harness: open, files: memoryFiles, search: index, lock: memoryLock };
		// blobs no chat holds, and what a crash left, go at start and every few hours
		// past their day, and search catches up
		const sweep = () => {
			void blobs.sweep(open).catch((error: unknown) => log(`blobs: sweep failed: ${(error as Error).message}`));
			void seeded
				.then(async () => {
					await index.memory(memoryFiles, context);
					await index.messages(open, context);
				})
				.catch((error: unknown) => log(`memory: ${(error as Error).message}`));
		};
		sweep();
		sweeping = setInterval(sweep, SWEEP_EVERY_MS);
		sweeping.unref();
		const receive = (inbound: Parameters<typeof core.receive>[1]) => core.receive(open, inbound);
		for (const gateway of gateways.values()) await gateway.start(receive);

		const listeners = new Set<() => void>();
		const changed = () => {
			for (const listener of listeners) listener();
		};
		// the app hears at once when the companion's computer comes up or goes offline
		const unwatchState = agentBox.watch(changed);
		unwatchBox = () => {
			unwatchState();
			sweepAtBringUp();
		};
		const computer = (): ComputerView => {
			const now = agentBox.state();
			return {
				state: now.state,
				...(now.state === "offline" ? { why: now.why } : {}),
				box: agentBox.host ? "host" : "container",
				network: agentBox.egress === undefined ? "none" : "guarded",
			};
		};
		memoryChanged = changed;
		capabilitiesChanged = changed;
		browserChanged = changed;
		// what an agent writes in the agents folder reaches the app as it happens
		void seeded.then(() => {
			if (stop === undefined) unwatch = watchAgents(workspace, changed, log);
		});

		// a message as the owner: the blobs are checked and the message that holds them received under one lock, so no
		// sweep comes between
		const post = async ({ id, text, files = [], ...to }: PostMessage): Promise<Posted> =>
			blobs.exclusive(async () => {
				const attachments = [];
				const seen = [];
				for (const { sha, name } of files) {
					const bytes = await blobs.read(sha).catch(() => undefined);
					if (bytes === undefined) throw new BadRequest(`${name} is no longer uploaded: attach it again`);
					const attachment = { sha, name: safeName(name), mimeType: mimeOf(name), size: bytes.length };
					attachments.push(attachment);
					// images the model can see go to it as images too
					if (INLINE_IMAGES.has(attachment.mimeType)) {
						const image = await images.prepare(bytes, attachment.mimeType, DEFAULT_IMAGE_LIMITS);
						if (image !== undefined) seen.push({ data: image.data, mimeType: image.mimeType });
					}
				}
				return web.post(id, to, text, { files: attachments, images: seen });
			});
		/** Bind the endpoint, once: at a start with a device paired, or when the owner makes an invite. */
		let bindRemote: (() => Promise<Remote>) | undefined;
		const devices = openDevices({
			harness: open,
			remote: () => remote,
			state: () => remoteState,
			bind: () => bindRemote?.() ?? Promise.reject(new Error("remote reach is not available on this computer")),
			changed,
			log,
		});
		areas = AREAS.flatMap((area) =>
			area.start === undefined
				? []
				: [
						area.start({
							...boot,
							harness: open,
							registry,
							workspace,
							desk,
							models,
							seen,
							changed,
							chats: () => chats(open),
							companion: async () => companion(open),
							control: async () => control(open, workspace, Date.now()),
							agents: listAgents,
							memory: () => memory(desk, Date.now()),
							capabilities: () => seeded.then(() => capabilitiesView()),
							post,
						}),
					],
		).concat(devices.area);
		const token = await ownerToken(home);
		server = createServer(
			handler(
				{
					status: () => status(open),
					iconFace: () => acceptedIconFace(open),
					companion: async () => companion(open),
					change: async (body) => {
						// every pick checked before any is stored; a personality waits for a new box to have the lead's file
						const picks = validPicks(body);
						if (picks.personality !== undefined || picks.face !== undefined) await seeded;
						await change(open, workspace, picks, core.agentChanged);
						return companion(open);
					},
					say: async ({ text, thread }, signal, heard) => ({ ended: await cli.say(text, thread, signal, heard) }),
					answer: async (key, value, via, type, approving) => {
						const filled = await answer(open, key, value, { gateway: via, peer: OWNER }, "bearer", {
							...(type === undefined ? {} : { type }),
							...(approving === undefined ? {} : { approving }),
						});
						if ("refused" in filled) throw new BadRequest(filled.refused);
						return { chat: filled.chat };
					},
					dismissQuestion: async (key) => {
						const dismissed = await dismissQuestion(open, key, { gateway: "web", peer: OWNER }, "bearer");
						if ("refused" in dismissed) throw new BadRequest(dismissed.refused);
						return { chat: dismissed.chat };
					},
					allowHost: async (agent, host) => {
						const now = Date.now();
						const allowed = await allowHost(open, agent, host, now);
						if ("refused" in allowed) throw new BadRequest(allowed.refused);
						// the proxy is told before the owner hears it is allowed; if it cannot be, it is tried again
						// with every change, and a write there is held meanwhile, never sent unrecorded
						await tellProxy().catch(() => undefined);
						return control(open, workspace, now);
					},
					revoke: async (id) => {
						const now = Date.now();
						if (!(await revoke(open, id, now))) return undefined;
						// a host taken back stops taking writes at the proxy before the owner hears it was: the proxy is
						// told, or stopped; if neither, the owner hears that, and it is tried again until one is done
						try {
							await tellProxy();
						} catch {
							throw new Error(
								"Taken back in banda, but your computer's proxy could not be reached, so it may still send " +
									"there: banda keeps trying until it has told or stopped it",
							);
						}
						return control(open, workspace, now);
					},
					chats: () => chats(open),
					read: (chat, through) => readChat(open, chat, through),
					items: (chat, query) => items(open, chat, query),
					context: (chat) => chatContext(open, chat, models),
					prompt: (chat, at) => chatPrompt(open, chat, context, at),
					live: (chat, write, signal) => live(open, chat, write, signal),
					post,
					limits: () => ({ fileBytes: fileLimit }),
					upload: (name, bytes) =>
						blobs.exclusive(async () => ({
							sha: await blobs.put(bytes),
							name: safeName(name),
							mimeType: mimeOf(safeName(name)),
							size: bytes.length,
						})),
					blob: async (sha) => {
						const known = (await open.snapshot(Blobs, context))?.blobs[sha];
						if (known === undefined || Object.keys(known.holders).length === 0) return undefined;
						return { mimeType: known.mimeType, bytes: await blobs.read(sha) };
					},
					image: (chat, item, n) => image(open, chat, item, n),
					file: async (chat, call, n) => {
						const attachment = await messageFile(open, chat, call, n);
						return attachment === undefined ? undefined : { attachment, bytes: await blobs.read(attachment.sha) };
					},
					shell: (write, signal) =>
						shell(
							open,
							{
								agents: listAgents,
								memory: () => memory(desk, Date.now()),
								control: () => control(open, workspace, Date.now()),
								capabilities: () => seeded.then(() => capabilitiesView()),
								...(agentBrowsers === undefined ? {} : { browsers: () => agentBrowsers.views() }),
								computer,
								areas,
							},
							(listener) => {
								listeners.add(listener);
								return () => listeners.delete(listener);
							},
							write,
							signal,
						),
					stop: (chat) => stopChat(open, chat),
					agents: listAgents,
					skills: () => skills(open, workspace),
					acceptSkill: (name, sha) => acceptSkill(open, workspace, name, sha),
					acceptSkills: (wanted) => acceptSkills(open, workspace, wanted),
					saveSkill: (name, text, base) => saveSkill(open, workspace, name, text, base),
					shippedSkills: () => shippedSkills(open, workspace),
					chooseShippedSkills: (names) => chooseShippedSkills(open, workspace, names),
					bringable: () => bringable(open, workspace),
					chooseBring: async (picks) => {
						const view = await chooseBring(open, workspace, picks, core.agentChanged);
						await settleAgents();
						return view;
					},
					accept: async (name, sha) => {
						const views = await accept(open, workspace, name, sha, core.agentChanged);
						await settleAgents();
						return views;
					},
					decline: (name) => decline(open, workspace, name),
					saveAgent: async (name, text, base) => {
						const views = await save(open, workspace, name, text, base, core.agentChanged);
						await settleAgents();
						return views;
					},
					control: async () => control(open, workspace, Date.now()),
					pause: async (paused) => {
						if (paused) await pause(open, core.reconcile, Date.now());
						else await resume(open, core.reconcile, Date.now());
						return control(open, workspace, Date.now());
					},
					routine: async (name, act) => {
						const now = Date.now();
						if (act.action === "accept") await acceptRoutine(open, workspace, core.reconcile, name, act.sha, now);
						else if (act.action === "decline") await declineRoutine(open, workspace, name);
						else if (act.action === "remove") await removeRoutine(open, workspace, core.reconcile, name, now);
						else {
							const found = await pauseRoutine(open, core.reconcile, name, act.action === "pause", now).catch(
								(error: unknown) => {
									if (error instanceof RoutineRefused) throw new BadRequest(error.message, error.status);
									throw error;
								},
							);
							if (!found) throw new BadRequest(`there is no routine named ${name}`, 404);
						}
						changed();
						return control(open, workspace, now);
					},
					memory: () => memory(desk, Date.now()),
					fact: async (act) => {
						const now = Date.now();
						if (act.action === "add") await addFact(desk, act.body, now);
						else if (act.action === "edit") await editFact(desk, act.id, act.text, now);
						else await removeFact(desk, act.id);
						changed();
						return memory(desk, now);
					},
					item: (chat, entry) => item(open, chat, entry),
					capabilities: () => capabilitiesView(),
					addMcp: async (config) => ({
						name: await capabilities.addMcp(config),
						capabilities: await capabilitiesView(),
					}),
					capability: async (act) => {
						if (act.action === "accept")
							await (act.folder === "connections"
								? capabilities.acceptConnection(act.name, act.sha)
								: capabilities.acceptTool(act.name, act.sha));
						else if (act.action === "decline") await capabilities.decline(act.folder, act.name);
						else if (act.action === "remove") await capabilities.remove(act.folder, act.name);
						else if (act.action === "disconnect") await capabilities.disconnect(act.name);
						else if (act.action === "key") await capabilities.setKey(act.name, act.key, context, act.agent);
						else if (act.action === "account")
							await capabilities.switchAccount(act.agent, act.name, act.account, act.on, context, act.sha);
						else if (act.action === "signout") await capabilities.signOut(act.name, act.account);
						else if (act.action === "add") await capabilities.addShipped(act.name);
						else if (act.action === "update") await capabilities.updateShipped(act.name, act.sha);
						else if (act.action === "address") await capabilities.addByAddress(act.url);
						else if (act.action === "trust" || act.action === "reads")
							await capabilities.trustReads(act.name, act.tools, context, act.sha, act.action === "reads");
						else if (act.action === "public")
							await capabilities.switchAccount(act.agent, act.name, undefined, act.on, context, act.sha);
						else if (act.action === "refresh") await capabilities.refresh(act.name);
						else if (act.action === "switch") await capabilities.toggle(act.tool, act.on);
						changed();
						return capabilitiesView();
					},
					signIn: (name, { agent, ...choice }) => capabilities.signIn(name, context, agent, choice),
					objects: (chat, asks, refresh) => objects.show(chat, asks, refresh),
					objectAttachment: (chat, ref, attachmentId, agent, account) =>
						objects.attachment(chat, ref, attachmentId, agent, account),
					callback: async (query) => {
						const done = await capabilities.callback(query);
						changed();
						return done;
					},
					...(agentBrowsers === undefined
						? {}
						: {
								browser: async (chat: number, write: (event: ViewEvent) => void, signal: AbortSignal) => {
									const stop = (await tabOf(agentBrowsers, chat)).watch(write);
									await new Promise<void>((resolve) => {
										if (signal.aborted) resolve();
										signal.addEventListener("abort", () => resolve(), { once: true });
									});
									stop();
								},
								browserControl: async (chat: number, hold: boolean) => {
									const browser = await tabOf(agentBrowsers, chat);
									try {
										// given back, what waited for the browser goes on: a call, and a hand-over
										if (hold) return await browser.hold(true);
										await giveBrowserBack(open, browser);
										return browser.view();
									} catch (error) {
										if (error instanceof Refused) throw new BadRequest(error.message, 409);
										throw error;
									}
								},
								browserInput: async (chat: number, input: OwnerInput) => {
									try {
										await (await tabOf(agentBrowsers, chat)).input(input);
									} catch (error) {
										if (error instanceof Refused) throw new BadRequest(error.message, 409);
										throw error;
									}
								},
								signOut: async (agent: string, site: string) => {
									await knownAgent(agent);
									await agentBrowsers.forget(agent, site);
									await open.commit(async (tx) => {
										delete (await tx.doc(SignedIn)).agents[agent]?.[site];
									}, context);
									changed();
									return capabilitiesView();
								},
							}),
					retry: async (task) => {
						if (!(await status(open)).parked.some((parked) => parked.task === task)) return false;
						await open.retryTask(task as TaskId, context);
						return true;
					},
				},
				() => port,
				token,
				options.web,
				areas,
				devices.gate,
			),
		);
		await listen(server, options.port ?? 7787);
		port = (server.address() as AddressInfo).port;
		listening(port);
		const reach = options.remote ?? remoteSettings(config.remote);
		if (reach.reach !== "off") {
			const settings = { ...reach, reach: reach.reach };
			const serving = server;
			bindRemote = () => {
				if (stopping) return Promise.reject(new Error("the daemon is stopping"));
				binding ??= openRemote({
					home,
					settings,
					server: serving,
					paired: devices.gate.paired,
					admits: devices.admits,
					changed,
					log,
				}).then(
					(bound) => {
						remote = bound;
						remoteState = "on";
						changed();
						log(
							`remote: endpoint ${bound.id}, reached ${settings.reach === "n0" ? "through n0's relays" : "on loopback"}`,
						);
						return bound;
					},
					(error: unknown) => {
						// the daemon serves this computer whatever Iroh does; the next invite, or start, tries again
						binding = undefined;
						log(`remote: ${error instanceof Error ? error.message : String(error)}`);
						throw error;
					},
				);
				return binding;
			};
			try {
				// the native addon, loaded without binding: a platform without its prebuilt says so in Settings
				await import("@number0/iroh");
				remoteState = "idle";
			} catch (error) {
				remoteState = "unavailable";
				bindRemote = undefined;
				log(`remote: not available on this computer: ${error instanceof Error ? error.message : String(error)}`);
			}
			// an endpoint reachable from anywhere is bound only once there is a device to reach it, or one is being paired
			if (bindRemote !== undefined && (settings.reach === "loopback" || (await devices.anyPaired())))
				await bindRemote().catch(() => undefined);
		}
		// a proxy that runs from before this daemon is told the store's config now, its own port in it, whether or not
		// the box has come up yet
		void tellProxyQuietly();
		const published = `${daemonFile(home)}.${process.pid}`;
		await writeFile(published, JSON.stringify({ pid: process.pid, port, token }), { mode: 0o600 });
		await rename(published, daemonFile(home));
		return { port, close, stopped: ended };
	} catch (error) {
		await close();
		throw error;
	}
}

/** An exclusive SQLite lock, held while the process lives and released by the OS when it dies. */
function acquireLock(home: string): DatabaseSync {
	const db = new DatabaseSync(join(home, "daemon.lock"));
	try {
		db.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;");
		return db;
	} catch {
		db.close();
		throw new Error(`a banda daemon already runs on ${home}`);
	}
}

function listen(server: Server, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
}
