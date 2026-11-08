/** Owner memory controls. Files hold facts; their canonical paths bind global or agent scope. */
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Harness } from "@earendil-works/pi-durable";
import { AGENT_NAME, acceptedAgent } from "../core/agents.ts";
import {
	addFact,
	agentMemoryPath,
	allFacts,
	audienceOf,
	changeFact,
	FACT_ID,
	type Fact,
	factId,
	factLine,
	GLOBAL_MEMORY,
	MAX_MEMORY_BYTES,
	MAX_MEMORY_CHARS,
	type MemoryFiles,
	type MemoryLock,
	memoryWords,
	type NewFact,
} from "../core/memory.ts";
import type { Search } from "../core/search.ts";
import { context } from "../core/store.ts";
import type { Workspace } from "./agents.ts";
import { write } from "./agents.ts";
import type { FactView, MemoryView } from "./api.ts";
import { BadRequest } from "./http.ts";

/** Regular files only, never through a link. This is not isolation between agents sharing one box. */
export function boxMemory(workspace: Pick<Workspace, "env" | "root">): MemoryFiles {
	const at = (path: string) => {
		if (audienceOf(path) === undefined) throw new Error("Not a memory path");
		return `${workspace.root}/${path}`;
	};
	return {
		read: async (path, ctx) => {
			const opened = await workspace.env().openBinaryReader(at(path), { noFollow: true }, ctx);
			if (!opened.ok) {
				if (opened.error.code === "not_found") return undefined;
				throw new Error(
					`${path}: ${opened.error.code === "invalid" ? "it is a link, not a file" : opened.error.message}`,
				);
			}
			const reader = opened.value;
			try {
				const info = await reader.info(ctx);
				if (!info.ok) throw info.error;
				if (info.value.size > MAX_MEMORY_BYTES) throw new Error(`${path} is too big to read`);
				const bytes = await reader.read(0, info.value.size, ctx);
				if (!bytes.ok) throw bytes.error;
				return new TextDecoder().decode(bytes.value);
			} finally {
				await reader.close(ctx);
			}
		},
		write: (path, text, ctx) => write(workspace.env(), workspace as Workspace, at(path), text, ctx),
		list: async (ctx) => {
			const paths: string[] = [];
			for (const folder of ["memory", "memory/agents"]) {
				const listed = await workspace.env().listDir(`${workspace.root}/${folder}`, ctx);
				if (!listed.ok) {
					if (listed.error.code === "not_found") continue;
					throw listed.error;
				}
				for (const entry of listed.value) {
					const path = posix.join(folder, entry.name);
					if (entry.kind === "file" && audienceOf(path) !== undefined) paths.push(path);
				}
			}
			return paths;
		},
	};
}

export function factView(fact: Fact): FactView {
	const { path, ...rest } = fact;
	const audience = audienceOf(path);
	if (audience === undefined) throw new Error("Not a memory path");
	return { ...rest, ...audience, size: [...factLine(fact)].length };
}

export type MemoryDesk = {
	readonly harness: Harness;
	readonly files: MemoryFiles;
	readonly search: Search;
	readonly lock: MemoryLock;
};

/** The authenticated owner may see every scope. Models receive only their own audience. */
export async function memory({ files }: MemoryDesk, _now: number, ctx: Context = context): Promise<MemoryView> {
	try {
		return { facts: (await allFacts(files, ctx)).map(factView), budget: MAX_MEMORY_CHARS };
	} catch {
		return { facts: [], budget: MAX_MEMORY_CHARS, unavailable: true };
	}
}

const words = (value: unknown) => {
	try {
		return memoryWords(value);
	} catch (error) {
		throw new BadRequest((error as Error).message);
	}
};
const named = (id: string) => {
	if (!FACT_ID.test(id)) throw new BadRequest("that is not a fact's id");
	return id;
};

/** All owner writes report capacity failures as refusals rather than server errors. */
async function changing<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Memory is full")) throw new BadRequest(error.message, 409);
		throw error;
	}
}

export async function add(
	desk: MemoryDesk,
	body: { text?: unknown; scope?: unknown; agent?: unknown; about?: unknown; task?: unknown },
	now: number,
	ctx: Context = context,
): Promise<FactView> {
	const text = words(body.text);
	if (body.scope !== "global" && body.scope !== "agent") throw new BadRequest("Choose global or agent memory");
	// Whom a fact is about is declared by the owner here, never detected from the words.
	const about = body.about === undefined ? undefined : words(body.about);
	const task = body.task === undefined ? undefined : words(body.task);
	const others = about !== undefined && !/^(the )?owner$/i.test(about);
	if (others) {
		if (body.scope === "global")
			throw new BadRequest(
				"A fact about someone else stays with an agent, never in the band's shared memory. Add it under that agent instead.",
			);
		if (task === undefined) throw new BadRequest("A fact about someone else names the task of yours it serves");
	}
	let path = GLOBAL_MEMORY;
	if (body.scope === "agent") {
		const agent = body.agent;
		if (typeof agent !== "string" || !AGENT_NAME.test(agent)) throw new BadRequest("Choose an agent");
		if (!(await desk.harness.commit((tx) => acceptedAgent(tx, agent), ctx)))
			throw new BadRequest("That agent is unavailable", 404);
		path = agentMemoryPath(agent);
	} else if (body.agent !== undefined) throw new BadRequest("Global memory has no agent");
	const fact: NewFact = {
		text,
		from: { owner: true },
		at: now,
		...(others && about !== undefined && task !== undefined ? { about, for: task } : {}),
	};
	const written = await changing(() => desk.lock.exclusive(() => addFact(desk.files, path, fact, ctx)));
	await desk.search.memory(desk.files, ctx);
	return factView(written.fact);
}

/** IDs bind scope and the exact words seen: a stale edit never overwrites another edit. */
export async function edit(desk: MemoryDesk, id: string, text: unknown, now: number, ctx: Context = context) {
	const clean = words(text);
	const edited = await changing(() =>
		desk.lock.exclusive(async () => {
			const found = (await allFacts(desk.files, ctx)).find((fact) => fact.id === named(id));
			if (found === undefined) throw new BadRequest("That fact changed or was removed. Look again.", 409);
			const { id: _id, path, ...rest } = found;
			const next: NewFact = { ...rest, text: clean, edited: now };
			await changeFact(desk.files, id, ctx, { path, replacement: next });
			return { ...next, id: factId(path, clean), path };
		}),
	);
	await desk.search.memory(desk.files, ctx);
	return factView(edited);
}

export async function remove(desk: MemoryDesk, id: string, ctx: Context = context): Promise<void> {
	await desk.lock.exclusive(async () => {
		const gone = await changeFact(desk.files, named(id), ctx);
		if (gone === undefined) throw new BadRequest("That fact changed or was removed. Look again.", 409);
	});
	await desk.search.memory(desk.files, ctx);
}
