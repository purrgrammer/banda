/**
 * Harnesses (DESIGN.md "Connections"): any coding agent that speaks ACP, on the owner's computer, in a folder they
 * picked, for the agents they turned it on for. Those banda ships are files (`shipped/harnesses/`), offered when
 * installed here; the owner may add another by its command line. An agent has a tool per harness it may use
 * (`harness__claude_code`), saying where it works: a call starts a session at once, sends a running one a follow-up, or
 * continues an ended one; `harness__sessions` shows its sessions and `harness__stop` stops one. Each session's end
 * wakes it with what was done. What reaches the owner is the harness's own asks. The owner steers a session
 * (`POST /api/harnesses/sessions/:task/steer`), answers its asks (`/answer`) and stops it (`/stop`).
 */
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { AgentChats } from "../../core/agents.ts";
import {
	addHarness,
	answerAsk,
	connectHarness,
	continuedProject,
	defineHarnesses,
	disconnectHarness,
	folderPath,
	foldersIn,
	HARNESS_UNAVAILABLE,
	type HarnessAccount,
	type HarnessDefinition,
	Harnesses,
	type HarnessStep,
	harnessPlatform,
	harnessTool,
	isRepo,
	projectOf,
	projectsIn,
	RESERVED_HARNESSES,
	removeHarness,
	SESSIONS_TOOL,
	STOP_TOOL,
	sessionOf,
	sessionsOf,
	steer,
	stopOwnSession,
	stopSession,
	switchHarness,
} from "../../core/harness.ts";
import {
	type HarnessFile,
	onPath,
	resolveHarness,
	SHIPPED_HARNESSES,
	shippedHarnesses,
	words,
} from "../../core/harness-files.ts";
import { context } from "../../core/store.ts";
import type { HarnessesView } from "../api.ts";
import { BadRequest } from "../http.ts";
import type { AreaModule } from "./area.ts";

const SESSION = /^\/harnesses\/sessions\/(\d+)\/(steer|stop|answer)$/;
const ACCOUNT = /^\/harnesses\/([a-z0-9-]+)\/(connect|switch|disconnect|remove)$/;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Every harness banda can run here: the shipped ones installed on this computer, then the owner's. `BANDA_HARNESSES`
 * (a JSON object of name to command line) adds harnesses for tests.
 */
function definitionsOf(
	shipped: readonly HarnessDefinition[],
	custom: { readonly [name: string]: { readonly service: string; readonly command: string } },
): Map<string, HarnessDefinition> {
	const found = new Map(shipped.map((one) => [one.name, one]));
	const extra = JSON.parse(process.env.BANDA_HARNESSES ?? "{}") as { [name: string]: string };
	const owned = {
		...Object.fromEntries(Object.entries(extra).map(([name, command]) => [name, { service: name, command }])),
		...custom,
	};
	for (const [name, { service, command }] of Object.entries(owned)) {
		if (found.has(name)) continue;
		const [first = "", ...args] = words(command);
		const path = onPath(first);
		if (path === undefined) continue;
		found.set(name, { name, service, command: path, args, custom: true });
	}
	return found;
}

/** A session's steps with the files under its folder named from there: auth.js, not /Users/…/auth-demo/auth.js. */
function relative(steps: readonly HarnessStep[], folder: string): HarnessStep[] {
	const full = folderPath(folder);
	if (full === undefined) return [...steps];
	const strip = (path: string) => (path.startsWith(`${full}/`) ? path.slice(full.length + 1) : path);
	return steps.map((step) =>
		step.kind === "read" || step.kind === "edit" ? { ...step, path: strip(step.path) } : step,
	);
}

let harnesses: ReturnType<typeof defineHarnesses> | undefined;
/** Where code usually lives on this computer, to start the folder field with. */
const SUGGESTED =
	["~/code", "~/Developer", "~/src", "~/projects"].find((one) => existsSync(folderPath(one) ?? "")) ?? "~";
let shipped: HarnessDefinition[] = [];
let missing: HarnessFile[] = [];
let custom: { [name: string]: { service: string; command: string } } = {};
const definitions = () => (harnessPlatform() ? definitionsOf(shipped, custom) : new Map<string, HarnessDefinition>());

let made: ReturnType<typeof defineHarnesses> | undefined;
const serviceOf = (harness: string) => definitions().get(harness)?.service ?? harness;
const answer = (text: string, isError = false) => ({ output: [{ type: "text" as const, text }], isError });
/** The longest prompt or note a harness is handed. */
const MAX_PROMPT = 20_000;

/** What the tool of `service` says it does, and where: the folder it works in and the projects there. */
function workDescription(service: string, folder: string | undefined): string {
	const full = folder === undefined ? undefined : folderPath(folder);
	let where = "in the folder the owner connects it in.";
	if (folder !== undefined && full !== undefined) {
		if (isRepo(full)) where = `in ${folder}, itself a project: leave \`project\` out.`;
		else {
			const projects = projectsIn(full);
			where =
				projects.length === 0
					? `in ${folder}, which holds no projects yet.`
					: `in ${folder}. Its projects (\`project\`): ${projects.slice(0, 30).join(", ")}` +
						`${projects.length > 30 ? `, and ${projects.length - 30} more` : ""}.`;
		}
	}
	return (
		`Hand coding work to ${service}, a coding agent running on the owner's computer ${where} ` +
		"Say what to do in full: what is wrong or wanted, where, how to check it, what not to touch. It starts at once " +
		"and answers with a session number; what it did comes back to you as a message when it ends, so don't wait on it " +
		"or call it again for the same work. The owner watches it work, answers what it asks, and may steer or stop it. " +
		"To follow up on earlier work, give its `session`: while it runs, your prompt reaches it as a note after its " +
		"current step; once it ended, it reopens natively if supported, otherwise starts fresh with a summary; the session reports which happened."
	);
}

/** What a work call found, before it starts anything: refused, begun already, a note sent, or where to start. */
type Found =
	| { readonly refused: string }
	| { readonly begun: number; readonly folder: string; readonly continues?: number }
	| { readonly noted: number };

/** The tool an agent hands `name` work with: a new session, a follow-up note, or a session continued. */
function workTool(name: string, folder: string | undefined): ToolRegistration {
	const service = serviceOf(name);
	return defineTool({
		name: harnessTool(name),
		description: workDescription(service, folder),
		parameters: Type.Object({
			prompt: Type.String({ description: "What it should do, in full." }),
			project: Type.Optional(
				Type.String({
					description:
						'A project in its folder, by its path from there ("auth-demo", "work/api"); left out, it works in the ' +
						"folder itself when that is a project. A follow-up works where its session did.",
				}),
			),
			session: Type.Optional(
				Type.Integer({ description: "An earlier session of yours with it, to follow up on, by its number." }),
			),
		}),
		// a rerun finds the session, or the note, its call made: the work starts once
		replay: "safe",
		execute: async (args, api, ctx) => {
			const chat = Number(api.conversationId);
			const { prompt, project, session: earlier } = args as { prompt: string; project?: string; session?: number };
			if (prompt.trim() === "" || prompt.length > MAX_PROMPT)
				return answer(`It did not start: say what to do, in at most ${MAX_PROMPT} characters.`, true);
			const found = await api.commit(async (tx): Promise<Found> => {
				const doc = await tx.doc(Harnesses);
				const begun = Object.entries(doc.sessions).find(([, one]) => one.chat === chat && one.call === api.callId);
				if (begun !== undefined) return { begun: Number(begun[0]), folder: begun[1].folder };
				const agent = (await tx.doc(AgentChats)).chats[chat];
				if (agent === undefined) return { refused: "this chat has no agent" };
				const account = doc.accounts[name];
				if (!definitions().has(name)) return { refused: `${service} is not on this computer any more` };
				if (account === undefined || !account.agents.includes(agent))
					return { refused: `the owner has not turned ${service} on for you` };
				const before = earlier === undefined ? undefined : doc.sessions[earlier];
				if (earlier !== undefined && (before === undefined || before.agent !== agent || before.harness !== name))
					return {
						refused: `session ${earlier} is not one of your ${service} sessions, or is no longer kept (${SESSIONS_TOOL} lists yours)`,
					};
				const where =
					before === undefined ? projectOf(account.folder, project) : continuedProject(account.folder, before.folder);
				if ("refused" in where)
					return {
						refused:
							where.refused +
							(where.projects.length === 0 ? "" : `. Projects in ${account.folder}: ${where.projects.join(", ")}`),
					};
				if (earlier !== undefined && before !== undefined && before.ended === undefined)
					return (await steer(tx, earlier, prompt.trim(), Date.now(), { call: api.callId }))
						? { noted: earlier }
						: { refused: `session ${earlier} takes no more notes` };
				// Admission and creation share one commit: a disconnect/root change cannot fall between them.
				const task = await (made as ReturnType<typeof defineHarnesses>).begin(tx, {
					chat,
					call: api.callId,
					agent,
					harness: name,
					folder: where.folder,
					ask: prompt.trim(),
					...(earlier === undefined ? {} : { continues: earlier }),
				});
				return { begun: task, folder: where.folder, ...(earlier === undefined ? {} : { continues: earlier }) };
			}, ctx);
			if ("refused" in found) return answer(`It did not start: ${found.refused}.`, true);
			if ("noted" in found)
				return answer(
					`Sent to session ${found.noted} as a note: it takes it after its current step. What it did comes back to ` +
						"you as a message when the session ends.",
				);
			return answer(
				`Started session ${found.begun}: ${service} in ${found.folder}` +
					(found.continues === undefined
						? ""
						: `, following session ${found.continues}; it will resume natively if supported, otherwise start fresh with a summary`) +
					`. What it did comes back to you as a message when it ends; ${SESSIONS_TOOL} shows how it goes meanwhile.`,
			);
		},
	});
}

/** The agent's sessions: all of them in a line each, or one in full. */
function sessionsTool(): ToolRegistration {
	return defineTool({
		name: SESSIONS_TOOL,
		description:
			"Your harness sessions. Without `session`, a line for each of yours, newest first; with one, how it is now: " +
			"what waits on the owner, the files it changed so far and its latest steps. For when the owner asks how the " +
			"work goes; you need not watch it, since each session's end comes to you as a message.",
		parameters: Type.Object({
			session: Type.Optional(Type.Integer({ description: "One of your sessions, by its number." })),
		}),
		replay: "safe",
		execute: async (args, api, ctx) => {
			const chat = Number(api.conversationId);
			const { session } = args as { session?: number };
			const text = await api.commit(async (tx) => {
				const agent = (await tx.doc(AgentChats)).chats[chat];
				if (agent === undefined) return undefined;
				return session === undefined
					? sessionsOf(tx, agent, serviceOf, Date.now())
					: sessionOf(tx, agent, session, serviceOf, Date.now());
			}, ctx);
			return text === undefined
				? answer(`Session ${session} is not one of yours, or is no longer kept.`, true)
				: answer(text);
		},
	});
}

/** The agent's Stop, for one of its sessions while it runs. */
function stopTool(): ToolRegistration {
	return defineTool({
		name: STOP_TOOL,
		description:
			"Stop one of your harness sessions while it runs, as the owner's Stop does: when the owner asks you to, or the " +
			"work is no longer wanted. Its end comes to you as a message, as any session's does.",
		parameters: Type.Object({ session: Type.Integer({ description: "The session, by its number." }) }),
		replay: "safe",
		execute: async (args, api, ctx) => {
			const chat = Number(api.conversationId);
			const { session } = args as { session: number };
			const stopped = await api.commit(async (tx) => {
				const agent = (await tx.doc(AgentChats)).chats[chat];
				return agent !== undefined && stopOwnSession(tx, agent, session);
			}, ctx);
			return stopped
				? answer(`Session ${session} is stopping. Its end comes to you as a message.`)
				: answer(`Session ${session} is not one of yours running now.`, true);
		},
	});
}

/** A tool per harness banda can run or the owner connected, each saying where it works. */
function harnessToolsExtension(accounts: { readonly [harness: string]: HarnessAccount }) {
	const names = new Set(harnessPlatform() ? [...definitions().keys(), ...Object.keys(accounts)] : []);
	return defineExtension({
		name: "banda.harness-tools",
		tools: [...names]
			.filter((name) => !RESERVED_HARNESSES.has(name))
			.map((name) => workTool(name, accounts[name]?.folder)),
	});
}

export const harnessesArea: AreaModule = {
	install: (boot) => {
		const files = shippedHarnesses(SHIPPED_HARNESSES, boot.log);
		shipped = files.flatMap((file) => resolveHarness(file) ?? []);
		// what banda knows how to run but this computer has not installed: offered with how to install it
		missing = harnessPlatform() ? files.filter((file) => !shipped.some((one) => one.name === file.name)) : [];
		harnesses = defineHarnesses({
			definitions,
			followUp: (tx, chat, input) => boot.core.followUp(tx, chat, input),
			log: boot.log,
		});
		made = harnesses;
		return [
			defineExtension({ name: "banda.harnesses", tasks: [harnesses.Session], tools: [sessionsTool(), stopTool()] }),
			// a tool per harness, said in general until the store says where each works (`start` re-installs them)
			harnessToolsExtension({}),
		];
	},
	start: (deps) => {
		const { harness } = deps;
		const refresh = async () => {
			custom = { ...((await harness.snapshot(Harnesses, context))?.custom ?? {}) };
		};
		// each harness's tool says where it works: offered anew whenever a harness comes, goes or moves
		const reinstall = async () => {
			deps.registry.install(harnessToolsExtension((await harness.snapshot(Harnesses, context))?.accounts ?? {}));
		};
		// the doc the shell watches exists from the start; the owner's harnesses are known; sessions a dead daemon left
		// end as failed
		void harness
			.commit(async (tx) => {
				await tx.doc(Harnesses);
			}, context)
			.then(refresh)
			.then(reinstall)
			.then(() => harnesses?.reconcile(harness, context))
			.catch((error: unknown) => deps.log(`harnesses: ${(error as Error).message}`));

		async function view(): Promise<HarnessesView> {
			const doc = (await harness.snapshot(Harnesses, context)) ?? { accounts: {}, sessions: {} };
			const known = definitions();
			return {
				...(!harnessPlatform() ? { unavailable: HARNESS_UNAVAILABLE } : {}),
				harnesses: [...known.values()].map(({ name, service, about, asks, custom: owned, provider, logo }) => ({
					name,
					service,
					...(provider === undefined ? {} : { provider }),
					...(logo === undefined ? {} : { logo }),
					...(about === undefined || about === "" ? {} : { about }),
					...(asks === undefined ? {} : { asks }),
					...(owned === true ? { custom: true } : {}),
				})),
				missing: missing.map(({ name, service, about, install, provider, logo, start }) => ({
					name,
					service,
					...("package" in start ? { adapterRequired: true } : {}),
					...(provider === undefined ? {} : { provider }),
					...(logo === undefined ? {} : { logo }),
					...(about === "" ? {} : { about }),
					...(install === undefined ? {} : { install }),
				})),
				accounts: doc.accounts,
				suggested: SUGGESTED,
				sessions: Object.entries(doc.sessions)
					.map(([task, session]) => ({
						task: Number(task),
						// the folder's real path: the web cuts only paths under it, never paths that merely share its name
						...(folderPath(session.folder) === undefined ? {} : { root: folderPath(session.folder) }),
						chat: session.chat,
						...(session.call === undefined ? {} : { call: session.call }),
						agent: session.agent,
						harness: session.harness,
						service: known.get(session.harness)?.service ?? session.harness,
						...(known.get(session.harness)?.provider === undefined
							? {}
							: { provider: known.get(session.harness)?.provider }),
						...(known.get(session.harness)?.logo === undefined ? {} : { logo: known.get(session.harness)?.logo }),
						folder: session.folder,
						...(session.continues === undefined ? {} : { continues: session.continues }),
						...(session.continuation === undefined ? {} : { continuation: session.continuation }),
						...(session.stoppedBy === undefined ? {} : { stoppedBy: session.stoppedBy }),
						state: session.state,
						at: session.at,
						...(session.ended === undefined ? {} : { ended: session.ended }),
						...(session.outcome === undefined ? {} : { outcome: session.outcome }),
						steps: relative(session.steps, session.folder),
						dropped: session.dropped,
						...(session.asks === undefined || session.asks.length === 0 ? {} : { asks: session.asks }),
					}))
					.sort((a, b) => b.at - a.at),
			};
		}

		return {
			watch: [Harnesses],
			shell: async () => [{ type: "harnesses", harnesses: await view() }],
			route: async (request) => {
				if (request.path === "/harnesses" && request.method === "GET") return { body: await view() };
				// the code folder picker: the folders at a path, each with the projects in it; read only, the owner's alone
				if (request.path === "/harnesses/folders" && request.method === "GET") {
					const at = request.url.searchParams.get("path") ?? undefined;
					if (at !== undefined && at.length > 1000) throw new BadRequest("path is a folder");
					const listing = foldersIn(at);
					if (listing === undefined) throw new BadRequest(`${at ?? "~"} is not a folder you can pick`, 404);
					return { body: listing };
				}
				if (request.path === "/harnesses" && request.method === "POST") {
					if (!harnessPlatform()) throw new BadRequest(HARNESS_UNAVAILABLE);
					const { service, command } = await request.json();
					if (typeof service !== "string" || service.trim() === "" || service.length > 60)
						throw new BadRequest("service is what you call it, such as My agent");
					if (typeof command !== "string" || command.trim() === "" || command.length > 500)
						throw new BadRequest("command is the line that starts it speaking ACP, such as goose acp");
					const [first = ""] = words(command);
					if (onPath(first) === undefined) throw new BadRequest(`${first} is not a command on this computer`);
					const name = service
						.trim()
						.toLowerCase()
						.replace(/[^a-z0-9]+/g, "-")
						.replace(/^-|-$/g, "");
					if (!NAME.test(name)) throw new BadRequest("give it a name with letters or digits");
					if (RESERVED_HARNESSES.has(name))
						throw new BadRequest(`${name} is a word banda keeps; call it something else`);
					const added = await harness.commit(
						(tx) => addHarness(tx, name, service.trim(), command.trim(), new Set(definitions().keys())),
						context,
					);
					if (!added) throw new BadRequest(`there is a harness called ${name} already`, 409);
					await refresh();
					await reinstall();
					deps.changed();
					return { body: await view() };
				}
				const account = ACCOUNT.exec(request.path);
				if (account !== null) {
					if (request.method !== "POST") return { status: 405, body: { error: "method not allowed" } };
					const name = account[1] ?? "";
					const action = account[2];
					const body = await request.json();
					if (action === "remove") {
						await harness.commit(async (tx) => {
							for (const agent of await removeHarness(tx, name)) await deps.core.agentChanged(tx, agent);
						}, context);
						await refresh();
						await reinstall();
						deps.changed();
						return { body: await view() };
					}
					if (!harnessPlatform() && action !== "disconnect") throw new BadRequest(HARNESS_UNAVAILABLE);
					if (!definitions().has(name) && action !== "disconnect")
						throw new BadRequest("no such harness on this computer", 404);
					if (action === "disconnect") {
						await harness.commit(async (tx) => {
							for (const agent of await disconnectHarness(tx, name)) await deps.core.agentChanged(tx, agent);
						}, context);
						await reinstall();
						deps.changed();
						return { body: await view() };
					}
					if (action === "switch") {
						const { agent, on } = body;
						if (typeof agent !== "string" || agent.length > 64 || typeof on !== "boolean")
							throw new BadRequest("agent names one, on says whether it may use it");
						const switched = await harness.commit(async (tx) => {
							if (!(await switchHarness(tx, name, agent, on))) return false;
							await deps.core.agentChanged(tx, agent);
							return true;
						}, context);
						if (!switched) throw new BadRequest("connect it first", 409);
						deps.changed();
						return { body: await view() };
					}
					const { folder, agent } = body;
					if (typeof folder !== "string" || folder.length > 1000) throw new BadRequest("folder is a path");
					if (agent !== undefined && (typeof agent !== "string" || agent.length > 64))
						throw new BadRequest("agent is an agent's name");
					const full = folderPath(folder);
					if (full === undefined) throw new BadRequest("give a folder on this computer, like ~/code");
					const found = await stat(full).catch(() => undefined);
					if (found?.isDirectory() !== true) throw new BadRequest(`${folder} is not a folder on this computer`);
					await harness.commit(async (tx) => {
						await connectHarness(tx, name, folder.trim(), agent);
						if (agent !== undefined) await deps.core.agentChanged(tx, agent);
					}, context);
					await reinstall();
					deps.changed();
					return { body: await view() };
				}
				const match = SESSION.exec(request.path);
				if (match === null) return undefined;
				if (request.method !== "POST") return { status: 405, body: { error: "method not allowed" } };
				const task = Number(match[1]);
				const action = match[2];
				const body = await request.json();
				const done = await harness.commit(async (tx) => {
					if (action === "stop") return stopSession(tx, task);
					if (action === "steer") {
						const { text } = body;
						if (typeof text !== "string" || text.trim() === "" || text.length > 8000)
							throw new BadRequest("text is your note, at most 8000 long");
						return steer(tx, task, text.trim(), Date.now());
					}
					const { ask, allow } = body;
					if (typeof ask !== "string" || typeof allow !== "boolean")
						throw new BadRequest("ask names it, allow says yes or no");
					return answerAsk(tx, task, ask, allow);
				}, context);
				if (!done) throw new BadRequest("that session is not running, or that ask is not open", 409);
				return { body: await view() };
			},
		};
	},
};
