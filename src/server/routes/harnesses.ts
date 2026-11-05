/**
 * Harnesses (DESIGN.md "Connections"): any coding agent that speaks ACP, on the owner's computer, in a folder they
 * picked, for the agents they turned it on for. Those banda ships are files (`shipped/harnesses/`), offered when
 * installed here; the owner may add another by its command line. An agent hands work to one with `harness__work`; it
 * starts at once, and what reaches the owner is the harness's own asks. The owner steers a session
 * (`POST /api/harnesses/sessions/:task/steer`), answers its asks (`/answer`) and stops it (`/stop`).
 */
import { stat } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { AgentChats } from "../../core/agents.ts";
import {
	addHarness,
	answerAsk,
	connectHarness,
	defineHarnesses,
	disconnectHarness,
	folderPath,
	HARNESS_TOOL,
	type HarnessDefinition,
	Harnesses,
	harnessesOf,
	removeHarness,
	steer,
	stopSession,
	switchHarness,
} from "../../core/harness.ts";
import { onPath, resolveHarness, SHIPPED_HARNESSES, shippedHarnesses, words } from "../../core/harness-files.ts";
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

let harnesses: ReturnType<typeof defineHarnesses> | undefined;
let shipped: HarnessDefinition[] = [];
let custom: { [name: string]: { service: string; command: string } } = {};
const definitions = () => definitionsOf(shipped, custom);

export const harnessesArea: AreaModule = {
	install: (boot) => {
		shipped = shippedHarnesses(SHIPPED_HARNESSES, boot.log).flatMap((file) => resolveHarness(file) ?? []);
		harnesses = defineHarnesses({
			definitions,
			followUp: (tx, chat, input) => boot.core.followUp(tx, chat, input),
			log: boot.log,
		});
		const made = harnesses;
		const tool = defineTool({
			name: HARNESS_TOOL,
			description:
				"Hand coding work to a coding agent (a harness: Claude Code, Codex, Gemini CLI…) running on the owner's computer " +
				"in the folder they connected it in. `harness` names one the owner turned on for you; name another and the " +
				"answer lists yours. Say what to do in full: what is wrong or wanted, where, how to check it, what not to touch. " +
				"It starts at once and returns; what the harness did comes back to you as a new message when it ends. The " +
				"owner sees it work, answers what it asks, and may steer or stop it. Don't call it again for the same work.",
			parameters: Type.Object({
				harness: Type.String({ description: "The harness, by name: claude-code, codex, gemini…" }),
				prompt: Type.String({ description: "What it should do." }),
			}),
			// a rerun finds the session its call began: the work starts once
			replay: "safe",
			execute: async (args, api, ctx) => {
				const chat = Number(api.conversationId);
				const { harness: name, prompt } = args as { harness: string; prompt: string };
				const said = await api.commit(async (tx) => {
					const doc = await tx.doc(Harnesses);
					const begun = Object.values(doc.sessions).find((one) => one.chat === chat && one.call === api.callId);
					if (begun !== undefined) return { folder: begun.folder, service: definitions().get(begun.harness)?.service };
					const agent = (await tx.doc(AgentChats)).chats[chat];
					if (agent === undefined) return { refused: "this chat has no agent" };
					const mine = await harnessesOf(tx, agent);
					const definition = definitions().get(name);
					const account = doc.accounts[name];
					if (definition === undefined || account === undefined || !mine.includes(name))
						return {
							refused:
								mine.length === 0
									? "the owner has turned no harness on for you"
									: `"${name}" is not one of yours; you have: ${mine.join(", ")}`,
						};
					await made.begin(tx, { chat, call: api.callId, agent, harness: name, folder: account.folder, ask: prompt });
					return { folder: account.folder, service: definition.service };
				}, ctx);
				const text =
					"refused" in said
						? `It did not start: ${said.refused}.`
						: `${said.service ?? name} started in ${said.folder}. What it did comes back to you as a message when it ends.`;
				return { output: [{ type: "text", text }], isError: "refused" in said };
			},
		});
		return [defineExtension({ name: "banda.harnesses", tasks: [made.Session], tools: [tool] })];
	},
	start: (deps) => {
		const { harness } = deps;
		const refresh = async () => {
			custom = { ...((await harness.snapshot(Harnesses, context))?.custom ?? {}) };
		};
		// the doc the shell watches exists from the start; the owner's harnesses are known; sessions a dead daemon left
		// end as failed
		void harness
			.commit(async (tx) => {
				await tx.doc(Harnesses);
			}, context)
			.then(refresh)
			.then(() => harnesses?.reconcile(harness, context))
			.catch((error: unknown) => deps.log(`harnesses: ${(error as Error).message}`));

		async function view(): Promise<HarnessesView> {
			const doc = (await harness.snapshot(Harnesses, context)) ?? { accounts: {}, sessions: {} };
			const known = definitions();
			return {
				harnesses: [...known.values()].map(({ name, service, about, asks, custom: owned }) => ({
					name,
					service,
					...(about === undefined || about === "" ? {} : { about }),
					...(asks === undefined ? {} : { asks }),
					...(owned === true ? { custom: true } : {}),
				})),
				accounts: doc.accounts,
				sessions: Object.entries(doc.sessions)
					.map(([task, session]) => ({
						task: Number(task),
						chat: session.chat,
						...(session.call === undefined ? {} : { call: session.call }),
						agent: session.agent,
						harness: session.harness,
						service: known.get(session.harness)?.service ?? session.harness,
						folder: session.folder,
						state: session.state,
						at: session.at,
						...(session.ended === undefined ? {} : { ended: session.ended }),
						...(session.outcome === undefined ? {} : { outcome: session.outcome }),
						steps: session.steps,
						dropped: session.dropped,
						...(session.asking === undefined ? {} : { asking: session.asking }),
					}))
					.sort((a, b) => b.at - a.at),
			};
		}

		return {
			watch: [Harnesses],
			shell: async () => [{ type: "harnesses", harnesses: await view() }],
			route: async (request) => {
				if (request.path === "/harnesses" && request.method === "GET") return { body: await view() };
				if (request.path === "/harnesses" && request.method === "POST") {
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
					const added = await harness.commit(
						(tx) => addHarness(tx, name, service.trim(), command.trim(), new Set(definitions().keys())),
						context,
					);
					if (!added) throw new BadRequest(`there is a harness called ${name} already`, 409);
					await refresh();
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
						deps.changed();
						return { body: await view() };
					}
					if (!definitions().has(name)) throw new BadRequest("no such harness on this computer", 404);
					if (action === "disconnect") {
						await harness.commit(async (tx) => {
							for (const agent of await disconnectHarness(tx, name)) await deps.core.agentChanged(tx, agent);
						}, context);
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
					if (full === undefined)
						throw new BadRequest("give a folder inside your home, like ~/code/project: not your whole home or /");
					const found = await stat(full).catch(() => undefined);
					if (found?.isDirectory() !== true) throw new BadRequest(`${folder} is not a folder on this computer`);
					await harness.commit(async (tx) => {
						await connectHarness(tx, name, folder.trim(), agent);
						if (agent !== undefined) await deps.core.agentChanged(tx, agent);
					}, context);
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
