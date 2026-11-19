/**
 * A routine's identity is the folder it is in and its name (DESIGN.md "Routines"): an agent's own are in
 * `agents/<agent>/routines/`, shared ones in `routines/`. Two agents' routines of one name, and a shared one of it, are
 * separate routines: each its own file, card, approval, runs, history and pause, each running as its own agent. The
 * same agent writing the same name again changes its own. A home made before agents had folders keeps its routines
 * where they were, as shared ones, with their records, owner, history, pause and next due time.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Context as ModelContext,
} from "@earendil-works/pi-ai";
import { createRegistry, type Harness, type SetTimer } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { openBox } from "../src/box/box.ts";
import { Accepted, shaOf } from "../src/core/agents.ts";
import { retire } from "../src/core/archive.ts";
import { pauseRoutine } from "../src/core/control.ts";
import { OWNER } from "../src/core/gateway.ts";
import {
	RoutineRuns,
	Routines,
	routineAgent,
	routineOfPath,
	routinePath,
	routineRef,
	WAKE,
} from "../src/core/routines.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore } from "../src/core/turn.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { Workspace } from "../src/server/agents.ts";
import type { ControlView, RoutineRunsPage, RoutineView } from "../src/server/api.ts";
import { accept, finishEdits, routines } from "../src/server/routines.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { blobStore, echoModels, FAUX_MODEL, FakeGateway, tempHome, until } from "./helpers.ts";

const NAME = "weekly-summary-draft";
const CURRO = "---\nname: Curro\ndescription: Drafts summaries\ntools: [read]\n---\nCURRO INSTRUCTIONS: be brief.\n";

describe("a routine's id", () => {
	it("is its agent's folder and its name; a shared one's is its name alone", () => {
		expect(routinePath("curro/tea")).toBe("agents/curro/routines/tea.md");
		expect(routinePath("tea")).toBe("routines/tea.md");
		expect(routineOfPath("agents/curro/routines/tea.md")).toBe("curro/tea");
		expect(routineOfPath("routines/tea.md")).toBe("tea");
		// what is no routine names none, and an agent's own file is never read as a routine
		for (const path of ["agents/curro.md", "agents/curro/tea.md", "routines/a/b.md", "agents/../routines/x.md"])
			expect(routineOfPath(path), path).toBeUndefined();
		for (const id of ["../x", "a/b/c", "Curro/tea", "/tea", "tea/"]) expect(routineRef(id), id).toBeUndefined();
		// its folder says whose it is, whatever a record says; a shared one is its record's, else the lead's
		expect(routineAgent("curro/tea", { agent: "sancho" })).toBe("curro");
		expect(routineAgent("tea", { agent: "curro" })).toBe("curro");
		expect(routineAgent("tea", {})).toBe("sancho");
	});
});

const textOf = (content: unknown) =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((part: { text?: string }) => part.text ?? "").join("")
			: "";
const promptOf = (ctx: ModelContext) => JSON.stringify(ctx.messages.filter((m) => m.role === "system"));
function toolsOf(ctx: ModelContext): string[] {
	const tools = new Set<string>();
	for (const message of ctx.messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
	}
	return [...tools];
}

/** A daemon on a throwaway home whose model calls `schedule` as each message's words say. */
async function daemon(plans: { [said: string]: object }) {
	const home = await tempHome();
	await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
	const web = join(home, "web");
	await mkdir(web, { recursive: true });
	await writeFile(join(web, "index.html"), "<!doctype html><title>banda</title>");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const requests: { prompt: string; text: string }[] = [];
	const results: string[] = [];
	const respond = (ctx: ModelContext) => {
		const last = ctx.messages.filter((m) => m.role !== "system").at(-1);
		requests.push({ prompt: promptOf(ctx), text: textOf(last?.content) });
		if (last?.role === "toolResult" && last.toolName !== "tool_search") {
			if (last.toolName === "schedule") results.push(textOf(last.content));
			return fauxAssistantMessage("done");
		}
		const input = [...ctx.messages].reverse().find((message) => message.role === "user");
		const plan = plans[textOf(input?.content)];
		if (plan === undefined) return fauxAssistantMessage("nothing to say");
		if (!toolsOf(ctx).includes("schedule"))
			return fauxAssistantMessage([fauxToolCall("tool_search", { query: "schedule", limit: 1 })], {
				stopReason: "toolUse",
			});
		return fauxAssistantMessage([fauxToolCall("schedule", plan as never)], { stopReason: "toolUse" });
	};
	faux.setResponses(Array.from({ length: 300 }, () => respond as never));
	const started = await startDaemon({ home, port: 0, models, log: () => {}, box: hostBox(home), web });
	const token = (await readDaemonFile(home))!.token!;
	const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
		const response = await fetch(`http://127.0.0.1:${started.port}/api${path}`, {
			...init,
			headers: { authorization: `Bearer ${token}`, ...init.headers },
		});
		if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
		return (await response.json()) as T;
	};
	const post = <T>(path: string, body: object = {}) => api<T>(path, { method: "POST", body: JSON.stringify(body) });
	const say = (text: string, thread: string) => post("/messages", { id: randomUUID(), thread, text });
	const routines = async () => (await api<ControlView>("/control")).routines;
	await until(async () => existsSync(join(home, "workspace", "agents", "sancho.md")));
	await api("/agents/curro", { method: "PUT", body: JSON.stringify({ text: CURRO, base: null }) });
	return { home, daemon: started, api, post, say, routines, requests, results };
}

const plan = (who: string, cron: string) => ({
	name: NAME,
	description: `${who} weekly summary`,
	cron,
	zone: "Europe/Madrid",
	ask: `${who.toUpperCase()} ASK: draft the weekly summary.`,
});
const pendingSha = (routine: RoutineView | undefined) =>
	routine?.change !== undefined && "sha" in routine.change ? (routine.change.sha ?? null) : null;

describe("two agents' routines of one name", () => {
	it("are two routines: each its own file, card, approval, run as its own agent, history and pause", async () => {
		const {
			home,
			daemon: started,
			post,
			api,
			say,
			routines,
			requests,
			results,
		} = await daemon({
			"sancho schedules": plan("Sancho", "30 8 * * 2"),
			"curro schedules": plan("Curro", "30 9 * * *"),
		});
		try {
			// both write the same name at once, each in its own chat
			await Promise.all([say("sancho schedules", "agent:sancho"), say("curro schedules", "agent:curro")]);
			const both = await until(async () => {
				const all = (await routines()).filter((each) => each.name === NAME && each.change !== undefined);
				return all.length === 2 ? all : undefined;
			});
			// before: one file, routines/weekly-summary-draft.md, the last writer's words under the first's agent
			expect(
				both.map((each) => [each.agent, each.change && "routine" in each.change ? each.change.routine?.ask : ""]),
			).toEqual([
				["curro", "CURRO ASK: draft the weekly summary."],
				["sancho", "SANCHO ASK: draft the weekly summary."],
			]);
			expect(both.map((each) => each.id)).toEqual([`curro/${NAME}`, `sancho/${NAME}`]);
			const workspace = join(home, "workspace");
			expect(await readFile(join(workspace, "agents", "curro", "routines", `${NAME}.md`), "utf8")).toContain(
				"CURRO ASK",
			);
			expect(await readFile(join(workspace, "agents", "sancho", "routines", `${NAME}.md`), "utf8")).toContain(
				"SANCHO ASK",
			);
			expect(existsSync(join(workspace, "routines", `${NAME}.md`))).toBe(false);
			// the tool told each where it wrote, never another's file
			await until(async () => results.length === 2);
			expect(results.some((text) => text.includes(`Wrote agents/curro/routines/${NAME}.md`))).toBe(true);
			expect(results.some((text) => text.includes(`Wrote agents/sancho/routines/${NAME}.md`))).toBe(true);
			// the agents' own files stay what they were: a routine folder is no agent
			const agents = await api<{ accepted?: { agent?: { id: string } } }[]>("/agents");
			expect(agents.map((each) => each.accepted?.agent?.id).sort()).toEqual(["curro", "sancho"]);

			// allowing Curro's allows only Curro's: Sancho's card still waits
			const curro = both.find((each) => each.agent === "curro");
			const afterCurro = await post<ControlView>(`/routines/curro/${NAME}/accept`, { sha: pendingSha(curro) });
			const mine = (control: ControlView, agent: string) =>
				control.routines.find((each) => each.id === `${agent}/${NAME}`);
			expect(mine(afterCurro, "curro")).toMatchObject({ state: "active", agent: "curro" });
			expect(mine(afterCurro, "curro")?.change).toBeUndefined();
			expect(mine(afterCurro, "sancho")).toMatchObject({ state: "allow", change: { kind: "added" } });
			expect(mine(afterCurro, "sancho")?.accepted).toBeUndefined();
			// declining Sancho's removes Sancho's file alone
			await post(`/routines/sancho/${NAME}/decline`);
			expect(existsSync(join(workspace, "agents", "sancho", "routines", `${NAME}.md`))).toBe(false);
			expect(existsSync(join(workspace, "agents", "curro", "routines", `${NAME}.md`))).toBe(true);
			// Sancho writes it again, and it is allowed on its own
			await say("sancho schedules", "agent:sancho");
			const sancho = await until(async () =>
				(await routines()).find((each) => each.id === `sancho/${NAME}` && each.change),
			);
			await post(`/routines/sancho/${NAME}/accept`, { sha: pendingSha(sancho) });

			// each runs as its own agent, with its own ask
			await post(`/routines/curro/${NAME}/run`, { key: "run-curro" });
			const curroRun = await until(async () => requests.find((each) => each.text.includes("CURRO ASK")));
			expect(curroRun.prompt).toContain("CURRO INSTRUCTIONS");
			await until(async () => (await routines()).find((each) => each.id === `curro/${NAME}`)?.running !== true);
			await post(`/routines/sancho/${NAME}/run`, { key: "run-sancho" });
			const sanchoRun = await until(async () => requests.find((each) => each.text.includes("SANCHO ASK")));
			expect(sanchoRun.prompt).not.toContain("CURRO INSTRUCTIONS");
			// each one's history holds its own run alone
			const history = (agent: string) =>
				until(async () => {
					const page = await api<RoutineRunsPage>(`/routines/${agent}/${NAME}/runs`);
					return page.runs.length > 0 && page.runs.every((run) => run.state !== "waiting") ? page : undefined;
				});
			expect((await history("curro")).runs).toHaveLength(1);
			expect((await history("sancho")).runs).toHaveLength(1);
			expect(requests.filter((each) => each.text.includes("CURRO ASK"))).toHaveLength(1);
			// pausing Curro's leaves Sancho's on
			const paused = await post<ControlView>(`/routines/curro/${NAME}/pause`);
			expect(mine(paused, "curro")).toMatchObject({ state: "paused" });
			expect(mine(paused, "sancho")).toMatchObject({ state: "active" });
			expect(mine(paused, "sancho")?.next).toBeDefined();
			// the bare name alone is an older app's, which may mean either: refused, told to update, never guessed
			await expect(post(`/routines/${NAME}/run`, { key: "bare" })).rejects.toThrow(/400.*update the app/);
			// named again in the body, it names only a shared routine, and there is none
			await expect(post(`/routines/${NAME}/run`, { key: "bare", id: NAME })).rejects.toThrow(/404/);
		} finally {
			await started.close();
		}
	}, 90_000);

	it("the same agent writing the same name changes its own; a shared one of that name is another, left as it is", async () => {
		const {
			home,
			daemon: started,
			post,
			say,
			routines,
			results,
		} = await daemon({
			"curro schedules": plan("Curro", "30 9 * * *"),
			"curro changes it": plan("Curro again", "30 13 * * 2"),
		});
		try {
			// a shared routine of the same name, as a home made before agents had folders holds one
			const shared = join(home, "workspace", "routines", `${NAME}.md`);
			await mkdir(join(home, "workspace", "routines"), { recursive: true });
			const sharedText = "---\ndescription: Shared summary\nevery: 1d\n---\nSHARED ASK.\n";
			await writeFile(shared, sharedText);
			const waiting = await until(async () => (await routines()).find((each) => each.id === NAME && each.change));
			expect(waiting).toMatchObject({ shared: true, agent: "sancho", name: NAME });
			await post(`/routines/${NAME}/accept`, { sha: pendingSha(waiting), id: NAME });

			await say("curro schedules", "agent:curro");
			const first = await until(async () =>
				(await routines()).find((each) => each.id === `curro/${NAME}` && each.change),
			);
			await post(`/routines/curro/${NAME}/accept`, { sha: pendingSha(first) });
			await until(async () => results.length === 1);
			// the shared one runs as Sancho: no twin of Curro's, so nothing to warn of
			expect(results[0]).not.toContain("also runs as you");
			expect((await routines()).find((each) => each.id === `curro/${NAME}`)?.twins).toBeUndefined();

			await say("curro changes it", "agent:curro");
			const changed = await until(async () =>
				(await routines()).find((each) => each.id === `curro/${NAME}` && each.change?.kind === "changed"),
			);
			expect(changed.change && "routine" in changed.change ? changed.change.routine?.ask : "").toBe(
				"CURRO AGAIN ASK: draft the weekly summary.",
			);
			// one routine of Curro's, still; the shared one as it was, in effect
			const all = (await routines()).filter((each) => each.name === NAME);
			expect(all.map((each) => each.id).sort()).toEqual([`curro/${NAME}`, NAME]);
			expect(await readFile(shared, "utf8")).toBe(sharedText);
			expect(all.find((each) => each.id === NAME)).toMatchObject({ state: "active", shared: true });
			// removing Curro's leaves the shared one
			const removed = await post<ControlView>(`/routines/curro/${NAME}/remove`);
			expect(removed.routines.filter((each) => each.name === NAME).map((each) => each.id)).toEqual([NAME]);
			expect(existsSync(shared)).toBe(true);
		} finally {
			await started.close();
		}
	}, 90_000);
});

describe("an agent's own routine beside a shared one that wakes it too", () => {
	it("both run, and the tool, the card and the panel say so: a reschedule never runs twice unseen", async () => {
		const {
			home,
			daemon: started,
			post,
			say,
			routines,
			results,
		} = await daemon({
			"sancho schedules": plan("Sancho", "30 8 * * 2"),
		});
		try {
			// a shared routine of the name that runs as the lead, Sancho
			await mkdir(join(home, "workspace", "routines"), { recursive: true });
			await writeFile(
				join(home, "workspace", "routines", `${NAME}.md`),
				"---\ndescription: Old\nevery: 1d\n---\nOLD.\n",
			);
			const shared = await until(async () => (await routines()).find((each) => each.id === NAME && each.change));
			await post(`/routines/${NAME}/accept`, { sha: pendingSha(shared), id: NAME });
			await say("sancho schedules", "agent:sancho");
			const own = await until(async () =>
				(await routines()).find((each) => each.id === `sancho/${NAME}` && each.change),
			);
			await until(async () => results.length === 1);
			expect(results[0]).toContain(
				`The shared routines/${NAME}.md also runs as you and is unchanged: once this is allowed, both run.`,
			);
			// each says the other, the card warns from it; the shared one is never changed for it
			expect(own.twins).toEqual([NAME]);
			expect((await routines()).find((each) => each.id === NAME)).toMatchObject({
				twins: [`sancho/${NAME}`],
				state: "active",
			});
		} finally {
			await started.close();
		}
	}, 90_000);
});

describe("what a routine file's path and text may claim", () => {
	it("a folder naming no agent, a forged owner, and a folder linked to another agent's run as no one", async () => {
		const {
			home,
			daemon: started,
			post,
			say,
			routines,
			results,
		} = await daemon({
			"curro schedules": plan("Curro", "30 9 * * *"),
		});
		const agents = join(home, "workspace", "agents");
		const routine = "---\ndescription: Probe\nevery: 1d\n---\nPROBE.\n";
		try {
			// a folder for an agent there is none of: shown, never allowed to run as anyone
			await mkdir(join(agents, "ghost", "routines"), { recursive: true });
			await writeFile(join(agents, "ghost", "routines", "probe.md"), routine);
			const ghost = await until(async () =>
				(await routines()).find((each) => each.id === "ghost/probe" && each.change),
			);
			await expect(post("/routines/ghost/probe/accept", { sha: pendingSha(ghost) })).rejects.toThrow(/409.*no agent/);
			// the file's own words cannot say whose it is: an owner field is no field
			await mkdir(join(agents, "sancho", "routines"), { recursive: true });
			const forged = "---\ndescription: Forged\nagent: curro\nevery: 1d\n---\nFORGED.\n";
			await writeFile(join(agents, "sancho", "routines", "forged.md"), forged);
			const claimed = await until(async () => (await routines()).find((each) => each.id === "sancho/forged"));
			expect(claimed.agent).toBe("sancho");
			expect(claimed.change && "errors" in claimed.change ? claimed.change.errors?.join() : "").toMatch(
				/"agent" is not a field/,
			);
			await expect(post("/routines/sancho/forged/accept", { sha: pendingSha(claimed) })).rejects.toThrow(/400/);
			// Curro's folder linked to Sancho's: none of it is read as Curro's, and Curro's tool writes nothing through it
			await mkdir(join(agents, "curro"), { recursive: true });
			await symlink(join(agents, "sancho", "routines"), join(agents, "curro", "routines"));
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect((await routines()).filter((each) => each.id.startsWith("curro/"))).toEqual([]);
			await say("curro schedules", "agent:curro");
			await until(async () => results.length === 1);
			expect(results[0]).toContain("Not written: agents/curro/routines is not a folder");
			expect(existsSync(join(agents, "sancho", "routines", `${NAME}.md`))).toBe(false);
		} finally {
			await started.close();
		}
	}, 90_000);
});

describe("a routine's folders are folders", () => {
	it("an agent's folder, or the agents folder itself, reached through a link holds no routine of anyone's", async () => {
		const home = await tempHome();
		const box = openBox(hostBox(home), () => {});
		const harness = await openStore(home, { models: echoModels().models, registry: createRegistry() });
		const workspace: Workspace = { env: () => box.env(), root: box.workspace, tools: () => [], known: () => true };
		const text = "---\ndescription: Probe\nevery: 1d\n---\nPROBE.\n";
		const ids = async () => (await routines(harness, workspace, Date.now())).map((each) => each.id).sort();
		try {
			const agents = join(box.workspace, "agents");
			await mkdir(join(agents, "curro", "routines"), { recursive: true });
			await writeFile(join(agents, "curro", "routines", "probe.md"), text);
			// an agent's folder that is a link to another's: its routines are that other's alone
			await symlink(join(agents, "curro"), join(agents, "sancho"));
			expect(await ids()).toEqual(["curro/probe"]);
			const reconcile = async () => {};
			// a file reached through a link is nowhere: there is no such routine to allow
			await expect(accept(harness, workspace, reconcile, "sancho/probe", shaOf(text), Date.now())).rejects.toThrow(
				/there is no routine sancho\/probe/,
			);
			// the agents folder itself a link: no agent's routine is read through it
			const elsewhere = join(home, "elsewhere");
			await rename(agents, elsewhere);
			await symlink(elsewhere, agents);
			expect(await ids()).toEqual([]);
			await expect(accept(harness, workspace, reconcile, "curro/probe", shaOf(text), Date.now())).rejects.toThrow(
				/there is no routine curro\/probe/,
			);
			expect(
				Object.keys((await harness.snapshot(Accepted, context))?.files ?? {}).filter((path) =>
					path.includes("routines"),
				),
			).toEqual([]);
		} finally {
			await harness.close(context);
		}
	});
});

describe("the owner's own routine for an agent, cut short between the store and the box", () => {
	it("is finished into that agent's folder on start, once, under its own name", async () => {
		const home = await tempHome();
		const box = openBox(hostBox(home), () => {});
		const harness = await openStore(home, { models: echoModels().models, registry: createRegistry() });
		const workspace: Workspace = { env: () => box.env(), root: box.workspace, tools: () => [], known: () => true };
		const text = "---\ndescription: Brief\ncron: 0 7 * * *\n---\nTell the owner what is on today.\n";
		try {
			// what createRoutine commits before it writes the box: accepted, and the box still owed it (base null)
			await harness.commit(async (tx) => {
				(await tx.doc(Accepted)).files[routinePath("sancho/brief")] = { sha: shaOf(text), text, at: 0 };
				(await tx.doc(Routines)).routines["sancho/brief"] = { agent: "sancho", edit: { sha: shaOf(text), base: null } };
			}, context);
			expect(existsSync(join(box.workspace, "agents", "sancho", "routines"))).toBe(false);
			await finishEdits(harness, workspace);
			expect(await readFile(join(box.workspace, "agents", "sancho", "routines", "brief.md"), "utf8")).toBe(text);
			expect(existsSync(join(box.workspace, "routines", "brief.md"))).toBe(false);
			expect((await harness.snapshot(Routines, context))?.routines["sancho/brief"]?.edit).toBeUndefined();
			// in effect, nothing waiting: the box holds what the store accepted
			expect(await routines(harness, workspace, Date.now())).toEqual([
				expect.objectContaining({ id: "sancho/brief", agent: "sancho" }),
			]);
			expect((await routines(harness, workspace, Date.now()))[0]?.change).toBeUndefined();
		} finally {
			await harness.close(context);
		}
	});
});

const MINUTE = 60_000;
const START = new Date(2026, 10, 2, 8, 0).getTime();

/** A store on a throwaway home with a clock the test moves, routines reconciled as the daemon does. */
function store(home: string) {
	const gateway = new FakeGateway();
	const clock = { now: START };
	const setTimer: SetTimer = (callback, delay, { background }) => {
		const timer = setTimeout(callback, Math.max(0, Math.min(delay, 5)));
		if (background) timer.unref();
		return () => clearTimeout(timer);
	};
	const core = defineCore({
		blobs: blobStore(),
		gateway: () => gateway,
		model: () => FAUX_MODEL,
		retryDelay: () => 5,
		now: () => clock.now,
		agentOrigin: (agent) => ({ gateway: "fake", peer: OWNER, thread: `agent:${agent}` }),
	});
	const open = async () => {
		const registry = createRegistry();
		registry.install(core.extension);
		const harness = await openStore(home, {
			models: echoModels().models,
			registry,
			now: () => clock.now,
			setTimer,
			settings: { retry: { maxRetries: 0 } },
		});
		harness.resume();
		await core.reconcile(harness);
		return harness;
	};
	const files = async (harness: Harness, written: { [path: string]: string }) => {
		await harness.commit(async (tx) => {
			const accepted = (await tx.doc(Accepted)).files;
			for (const [path, text] of Object.entries(written)) accepted[path] = { sha: shaOf(text), text, at: clock.now };
		}, context);
		await core.reconcile(harness);
	};
	return { gateway, core, open, files, clock };
}

/** Every wake its runs read, by routine id, and the agent each ran as. */
const wakes = async (harness: Harness) => {
	const runs = (await harness.snapshot(RoutineRuns, context))?.runs ?? {};
	const found: { routine: string; agent: string; due: number }[] = [];
	for (const [chat, run] of Object.entries(runs).sort(([a], [b]) => Number(a) - Number(b))) {
		const page = await (await harness.conversation(Number(chat) as never, context))!.entries(
			{ order: "ascending" },
			100,
			undefined,
			context,
		);
		for (const entry of page.items)
			if (entry.kind === WAKE)
				found.push({ routine: run.routine, agent: run.agent, due: (entry.data as { due: number }).due });
	}
	return found;
};
const record = async (harness: Harness, id: string) => (await harness.snapshot(Routines, context))?.routines[id];

const CURRO_FILE = "---\nname: Curro\ndescription: Drafts summaries\n---\nCurro.\n";
const tea = (ask: string) => `---\ndescription: Tea\nevery: 10m\n---\n${ask}\n`;

describe("a home made before agents had folders", () => {
	it("keeps its routines shared, where they were: owner, history, next due and task as they were; each due time fires once", async () => {
		const home = await tempHome();
		const s = store(home);
		let harness = await s.open();
		await s.files(harness, { "agents/curro.md": CURRO_FILE, [routinePath("legacy")]: tea("LEGACY ASK.") });
		// as the earlier build's `schedule` left it: the record by name, its writer's agent named in it
		await harness.commit(async (tx) => {
			const routines = (await tx.doc(Routines)).routines;
			(routines.legacy as { agent?: string }).agent = "curro";
		}, context);
		s.clock.now += 10 * MINUTE;
		await until(async () => (await wakes(harness)).length === 1);
		const before = await record(harness, "legacy");
		expect(before).toMatchObject({ agent: "curro", fired: START + 10 * MINUTE });
		expect(before?.runs).toHaveLength(1);
		// a restart: the same task goes on, nothing moves, nothing new is made
		await until(async () => (await record(harness, "legacy"))?.runs?.[0]?.ended !== undefined);
		await harness.close(context);
		harness = await s.open();
		const after = await record(harness, "legacy");
		expect(after?.task).toBe(before?.task);
		expect(after?.runs).toEqual((await record(harness, "legacy"))?.runs);
		expect(Object.keys((await harness.snapshot(Routines, context))?.routines ?? {})).toEqual(["legacy"]);
		const accepted = Object.keys((await harness.snapshot(Accepted, context))?.files ?? {});
		expect(accepted.filter((path) => path.includes("routines"))).toEqual(["routines/legacy.md"]);
		// its next due time fires once, as Curro, whatever restarted between
		s.clock.now += 10 * MINUTE;
		await until(async () => (await wakes(harness)).length === 2);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(await wakes(harness)).toEqual([
			{ routine: "legacy", agent: "curro", due: START + 10 * MINUTE },
			{ routine: "legacy", agent: "curro", due: START + 20 * MINUTE },
		]);
		expect((await record(harness, "legacy"))?.runs).toHaveLength(2);
		await harness.close(context);
	});

	it("a shared routine no record says the owner of stays the lead's: nothing guesses whose it is", async () => {
		const home = await tempHome();
		const s = store(home);
		const harness = await s.open();
		await s.files(harness, { "agents/curro.md": CURRO_FILE, [routinePath("unowned")]: tea("Curro: UNOWNED ASK.") });
		s.clock.now += 10 * MINUTE;
		await until(async () => (await wakes(harness)).length === 1);
		// its words name Curro, and it is still the lead's: a prompt's words are no owner
		expect(await wakes(harness)).toEqual([{ routine: "unowned", agent: "sancho", due: START + 10 * MINUTE }]);
		expect((await record(harness, "unowned"))?.agent).toBeUndefined();
		await harness.close(context);
	});

	it("beside an agent's own routine of the same name: two tasks, two records, each fires once as its own agent", async () => {
		const home = await tempHome();
		const s = store(home);
		const harness = await s.open();
		await s.files(harness, {
			"agents/curro.md": CURRO_FILE,
			[routinePath("tea")]: tea("SHARED."),
			[routinePath("curro/tea")]: tea("CURRO'S OWN."),
			[routinePath("sancho/tea")]: tea("SANCHO'S OWN."),
		});
		// a record naming another agent does not move a routine out of its agent's folder
		await harness.commit(async (tx) => {
			((await tx.doc(Routines)).routines["curro/tea"] as { agent?: string }).agent = "sancho";
		}, context);
		const { routines } = (await harness.snapshot(Routines, context))!;
		expect(Object.keys(routines).sort()).toEqual(["curro/tea", "sancho/tea", "tea"]);
		expect(new Set(Object.values(routines).map((each) => each.task)).size).toBe(3);
		s.clock.now += 10 * MINUTE;
		await until(async () => (await wakes(harness)).length === 3);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const woke = (await wakes(harness)).map(({ routine, agent }) => [routine, agent]);
		expect(woke.sort()).toEqual([
			["curro/tea", "curro"],
			["sancho/tea", "sancho"],
			["tea", "sancho"],
		]);
		// pausing one pauses it alone; archiving Curro pauses Curro's alone
		await pauseRoutine(harness, s.core.reconcile, "sancho/tea", true, s.clock.now);
		await harness.commit((tx) => retire(tx, "curro", s.clock.now), context);
		const after = (await harness.snapshot(Routines, context))!.routines;
		expect([after["curro/tea"]?.paused, after["sancho/tea"]?.paused, after.tea?.paused]).toEqual([
			"owner",
			"owner",
			undefined,
		]);
		await harness.close(context);
	});
});

describe("an app built when a routine's id was its name alone", () => {
	it("is refused on a bare name, told to update, and nothing moves; an app of this build names the routine twice", async () => {
		const {
			home,
			daemon: started,
			post,
			say,
			routines,
		} = await daemon({
			"curro schedules": plan("Curro", "30 9 * * *"),
		});
		try {
			const workspace = join(home, "workspace");
			// a shared routine of the name, and Curro's own: two routines, both waiting for the owner
			await mkdir(join(workspace, "routines"), { recursive: true });
			const sharedText = "---\ndescription: Shared summary\nevery: 1d\n---\nSHARED ASK.\n";
			await writeFile(join(workspace, "routines", `${NAME}.md`), sharedText);
			await say("curro schedules", "agent:curro");
			const both = await until(async () => {
				const all = (await routines()).filter((each) => each.name === NAME && each.change !== undefined);
				return all.length === 2 ? all : undefined;
			});
			const own = both.find((each) => each.id === `curro/${NAME}`);
			const ownPath = join(workspace, "agents", "curro", "routines", `${NAME}.md`);
			const ownText = await readFile(ownPath, "utf8");
			const sharedPath = join(workspace, "routines", `${NAME}.md`);
			const unchanged = async () => {
				expect(await readFile(ownPath, "utf8")).toBe(ownText);
				expect(await readFile(sharedPath, "utf8")).toBe(sharedText);
				const views = (await routines()).filter((each) => each.name === NAME);
				expect(views.map((each) => [each.id, each.state, each.accepted === undefined])).toEqual([
					[`curro/${NAME}`, "allow", true],
					[NAME, "allow", true],
				]);
			};
			// the older app means Curro's card, but says only the name, which is also the shared one's id: every action
			// is refused with what to do, and neither routine is touched, declined or removed
			const legacy = [
				["accept", { sha: pendingSha(own) }],
				["decline", {}],
				["remove", {}],
				["pause", {}],
				["resume", {}],
				["run", { key: "legacy-click" }],
				["when", { when: "every 3h", sha: pendingSha(own) }],
				["edit", { ask: "Other.", sha: pendingSha(own) }],
			] as const;
			for (const [action, body] of legacy) {
				await expect(post(`/routines/${NAME}/${action}`, body), action).rejects.toThrow(
					/400.*names a routine by its name alone.*update the app/,
				);
			}
			await unchanged();
			// a body that names another routine than the path, or no routine, is refused too
			await expect(post(`/routines/${NAME}/decline`, { id: `curro/${NAME}` })).rejects.toThrow(/400.*as the path does/);
			await expect(post(`/routines/curro/${NAME}/decline`, { id: NAME })).rejects.toThrow(/400.*as the path does/);
			await expect(post(`/routines/${NAME}/decline`, { id: 7 })).rejects.toThrow(/400.*id is the routine's id/);
			await expect(post(`/routines/${NAME}/accept`, { sha: pendingSha(own), id: NAME, name: NAME })).rejects.toThrow(
				/400.*name cannot be edited/,
			);
			await unchanged();

			// this build names the shared one twice: declined, its file alone goes; Curro's is byte for byte as it was
			await post(`/routines/${NAME}/decline`, { id: NAME });
			expect(existsSync(sharedPath)).toBe(false);
			expect(await readFile(ownPath, "utf8")).toBe(ownText);
			expect((await routines()).filter((each) => each.name === NAME).map((each) => each.id)).toEqual([`curro/${NAME}`]);
			// declined again, there is nothing to decline: an error, never a quiet success
			await expect(post(`/routines/${NAME}/decline`, { id: NAME })).rejects.toThrow(/404.*there is no routine/);
			await expect(post(`/routines/${NAME}/remove`, { id: NAME })).rejects.toThrow(/404.*there is no routine/);
			await expect(post(`/routines/${NAME}/accept`, { sha: pendingSha(own), id: NAME })).rejects.toThrow(
				/404.*there is no routine/,
			);
			// Curro's, in the form only this build sends, with the body naming it or not: allowed, and in effect
			const allowed = await post<ControlView>(`/routines/curro/${NAME}/accept`, {
				sha: pendingSha(own),
				id: `curro/${NAME}`,
			});
			expect(allowed.routines.find((each) => each.id === `curro/${NAME}`)).toMatchObject({ state: "active" });
			const paused = await post<ControlView>(`/routines/curro/${NAME}/pause`);
			expect(paused.routines.find((each) => each.id === `curro/${NAME}`)).toMatchObject({ state: "paused" });
			// a well-formed id naming nothing: 404, never "changed since you saw it"
			await expect(post("/routines/curro/nope/accept", { sha: "0".repeat(64) })).rejects.toThrow(
				/404.*there is no routine curro\/nope/,
			);
			await expect(post("/routines/curro/nope/decline")).rejects.toThrow(/404/);
			await expect(post("/routines/curro/nope/remove")).rejects.toThrow(/404/);
			expect(existsSync(join(workspace, "agents", "curro", "routines", "nope.md"))).toBe(false);
		} finally {
			await started.close();
		}
	}, 90_000);
});
