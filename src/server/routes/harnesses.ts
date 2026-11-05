/**
 * Harnesses (DESIGN.md "Connections"): Claude Code on the owner's computer, in a folder they picked, for the agents
 * they turned it on for. The agent asks with `claude_code__work`, a draft the owner approves; the session then runs
 * here, and the owner steers it (`POST /api/harnesses/sessions/:task/steer`), answers its asks (`/answer`) and stops
 * it (`/stop`). Connecting is `POST /api/harnesses/:name/connect` with the folder. Every session is in the shell.
 */
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension } from "@earendil-works/pi-durable";
import { AgentChats } from "../../core/agents.ts";
import {
	answerAsk,
	connectHarness,
	defineHarnesses,
	folderPath,
	type HarnessDefinition,
	Harnesses,
	steer,
	stopSession,
	workToolName,
} from "../../core/harness.ts";
import { context } from "../../core/store.ts";
import type { HarnessesView } from "../api.ts";
import { BadRequest } from "../http.ts";
import type { AreaModule } from "./area.ts";

/** Claude Code through its ACP adapter, pinned in package.json; `BANDA_HARNESS_CLAUDE_CODE` (a JSON array) replaces the command, for a fake in tests. */
function definitions(): ReadonlyMap<string, HarnessDefinition> {
	const override = process.env.BANDA_HARNESS_CLAUDE_CODE;
	let command: string;
	let args: string[];
	if (override !== undefined) {
		const parsed = JSON.parse(override) as string[];
		command = parsed[0] ?? "";
		args = parsed.slice(1);
	} else {
		const root = dirname(createRequire(import.meta.url).resolve("@agentclientprotocol/claude-agent-acp/package.json"));
		command = process.execPath;
		args = [join(root, "dist/index.js")];
	}
	return new Map([
		["claude-code", { name: "claude-code", service: "Claude Code", command, args, mode: "acceptEdits" }],
	]);
}

const DEFINITIONS = definitions();
const PATH = /^\/harnesses\/sessions\/(\d+)\/(steer|stop|answer)$/;
const CONNECT = /^\/harnesses\/([a-z0-9-]+)\/connect$/;

let harnesses: ReturnType<typeof defineHarnesses> | undefined;

export const harnessesArea: AreaModule = {
	install: (boot) => {
		harnesses = defineHarnesses({
			definitions: () => DEFINITIONS,
			followUp: (tx, chat, input) => boot.core.followUp(tx, chat, input),
			log: boot.log,
		});
		const made = harnesses;
		const tools = [...DEFINITIONS.values()].map((definition) =>
			boot.core.effect({
				name: workToolName(definition.name),
				description:
					`Hand coding work to ${definition.service}, running on the owner's computer in the folder they connected. ` +
					"Say what to do in full: what is wrong or wanted, where, how to check it, and what not to touch. It asks the " +
					"owner first: they see exactly what you give, may edit it, and it starts once, as approved. It returns at once; " +
					`what ${definition.service} did comes back to you as a new message when it ends. The owner may steer it or stop it. ` +
					"Do not call it again to retry an approval.",
				parameters: Type.Object({ prompt: Type.String({ description: `What ${definition.service} should do.` }) }),
				effect: "unsafe",
				editable: ["prompt"],
				describe: () => `Ask ${definition.service} to work in your folder`,
				drawn: () => ({ verb: "Run", as: "you, on this computer" }),
				permission: { what: () => `ask ${definition.service} to work in your folder` },
				allowed: async (tx, _draft, chat) => {
					const agent = (await tx.doc(AgentChats)).chats[chat];
					const account = (await tx.doc(Harnesses)).accounts[definition.name];
					if (agent === undefined || account === undefined || !account.agents.includes(agent))
						return `${definition.service} is not connected for this agent`;
					return undefined;
				},
				run: async (args, { api }, ctx) => {
					const chat = Number(api.conversationId);
					const begun = await api.commit(async (tx) => {
						const agent = (await tx.doc(AgentChats)).chats[chat];
						const account = (await tx.doc(Harnesses)).accounts[definition.name];
						if (agent === undefined || account === undefined) return undefined;
						const task = await made.begin(tx, {
							chat,
							agent,
							harness: definition.name,
							folder: account.folder,
							ask: (args as { prompt: string }).prompt,
						});
						return { task, folder: account.folder };
					}, ctx);
					const text =
						begun === undefined
							? `${definition.service} is not connected for you.`
							: `${definition.service} started in ${begun.folder}. Its result comes back to you as a message when it ends; ` +
								"the owner sees it work in the chat. Don't call it again for the same work.";
					return { output: [{ type: "text", text }], isError: begun === undefined };
				},
			}),
		);
		return [defineExtension({ name: "banda.harnesses", tasks: [made.Session], tools })];
	},
	start: (deps) => {
		const { harness } = deps;
		// the doc the shell watches exists from the start
		void harness.commit(async (tx) => {
			await tx.doc(Harnesses);
		}, context);

		async function view(): Promise<HarnessesView> {
			const doc = (await harness.snapshot(Harnesses, context)) ?? { accounts: {}, sessions: {} };
			return {
				harnesses: [...DEFINITIONS.values()].map(({ name, service }) => ({ name, service })),
				accounts: doc.accounts,
				sessions: Object.entries(doc.sessions)
					.map(([task, session]) => ({
						task: Number(task),
						chat: session.chat,
						agent: session.agent,
						harness: session.harness,
						service: DEFINITIONS.get(session.harness)?.service ?? session.harness,
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
				const connect = CONNECT.exec(request.path);
				if (connect !== null) {
					if (request.method !== "POST") return { status: 405, body: { error: "method not allowed" } };
					const name = connect[1] ?? "";
					if (!DEFINITIONS.has(name)) throw new BadRequest("no such harness", 404);
					const body = await request.json();
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
				const match = PATH.exec(request.path);
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
