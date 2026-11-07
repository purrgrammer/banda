/**
 * At first run on the desktop, in place of banda's own skills, what the owner's other harnesses on this computer have: Claude Code's, Codex's
 * and pi's skills, and Claude Code's subagents. The daemon reads them on the owner's computer, where it runs; nothing
 * is brought until the owner picks it, and what is picked is read again then, never taken from the request. A skill
 * is written into the workspace as it was found and accepted, as a shipped one is; an agent becomes a banda agent
 * file (its name, description and instructions; its own tools and model are another harness's words) and is saved as
 * the owner's. Either way the step is not offered again.
 */
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Harness } from "@earendil-works/pi-durable";
import {
	Accepted,
	AGENT_NAME,
	agentPath,
	agentText,
	LEAD,
	MAX_AGENT_BYTES,
	parseAgent,
	shaOf,
} from "../core/agents.ts";
import { DEFAULT_FACE } from "../core/choices.ts";
import { Companion } from "../core/companion.ts";
import { acceptedSkills, MAX_SKILL_BYTES, parseSkill, SKILL_NAME, skillHeader } from "../core/skills.ts";
import { context } from "../core/store.ts";
import { hiddenError } from "../core/visible.ts";
import { type AgentChanged, save, type Workspace, write } from "./agents.ts";
import { BadRequest } from "./http.ts";
import { acceptSkills, MAX_ACCEPTED_AT_ONCE } from "./skills.ts";

/** What one skill brings beside its SKILL.md, at most. */
const MAX_FILES = 200;
const MAX_SKILL_FOLDER_BYTES = 4 * 1024 * 1024;
/** What the first-run list shows of a description. */
const ABOUT = 160;
/** A brought agent's description: what other agents read to choose it. */
const MAX_DESCRIPTION = 500;

/** Where each harness keeps its own skills and agents, from the owner's home. */
export type HostFolders = {
	readonly home: string;
	/** Codex's home; `~/.codex` unless CODEX_HOME says. */
	readonly codex?: string;
};

type Source = {
	readonly name: string;
	readonly service: string;
	/** The folder whose being there means the harness is set up here. */
	readonly root: string;
	readonly skills: readonly string[];
	readonly agents?: string;
};

function sourcesOf({ home, codex = process.env.CODEX_HOME ?? join(home, ".codex") }: HostFolders): Source[] {
	return [
		{
			name: "claude-code",
			service: "Claude Code",
			root: join(home, ".claude"),
			skills: [join(home, ".claude", "skills")],
			agents: join(home, ".claude", "agents"),
		},
		// Codex reads the shared ~/.agents/skills as well as its own
		{ name: "codex", service: "Codex", root: codex, skills: [join(codex, "skills"), join(home, ".agents", "skills")] },
		{ name: "pi", service: "pi", root: join(home, ".pi", "agent"), skills: [join(home, ".pi", "agent", "skills")] },
	];
}

export type BringOffer = {
	readonly name: string;
	/** Its description, shortened. */
	readonly about: string;
	/** A skill or agent of that name is in the workspace already: it is left as it is. */
	readonly added: boolean;
	/** Why it cannot be brought as it is, in the owner's words. */
	readonly problem?: string;
};

export type HostHarnessView = {
	/** As the harness files name it: claude-code, codex, pi. */
	readonly name: string;
	readonly service: string;
	/** Its folder, from ~. */
	readonly folder: string;
	readonly skills: readonly BringOffer[];
	readonly agents: readonly BringOffer[];
};

export type BringView = {
	/** The owner brought from these, or started fresh, at first run. */
	readonly chosen: boolean;
	/** Each harness set up on this computer, with what it has. */
	readonly harnesses: readonly HostHarnessView[];
};

export type BringPick = { readonly harness: string; readonly name: string };

/** Where to look (the owner's home unless said), and the fault points tests cut a bring at. */
export type BringOptions = {
	readonly folders?: HostFolders;
	readonly fault?: (point: "bring:written" | "bring:accepted" | "bring:agent") => void;
};

const short = (text: string, max: number) => {
	const one = text.replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
	return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
};

const isDir = async (path: string) => (await stat(path).catch(() => undefined))?.isDirectory() === true;

/** A skill as found: its files by path inside its folder, SKILL.md among them; or why it cannot be brought. */
type FoundSkill = { readonly name: string; readonly about: string } & (
	| { readonly files: ReadonlyMap<string, string>; readonly text: string; readonly left: number }
	| { readonly problem: string }
);

/** The files of a skill's folder by path, with their sizes: hidden names and links inside it never followed. */
async function walk(folder: string, inside = ""): Promise<{ path: string; size: number }[] | "too big"> {
	const found: { path: string; size: number }[] = [];
	let bytes = 0;
	const visit = async (dir: string): Promise<boolean> => {
		for (const entry of await readdir(join(folder, dir), { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue; // a link could lead anywhere
			const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
			if (entry.isDirectory()) {
				if (!(await visit(path))) return false;
			} else if (entry.isFile()) {
				const { size } = await lstat(join(folder, path));
				bytes += size;
				found.push({ path, size });
				if (found.length > MAX_FILES || bytes > MAX_SKILL_FOLDER_BYTES) return false;
			}
		}
		return true;
	};
	return (await visit(inside)) ? found : "too big";
}

/**
 * A skill folder: its SKILL.md checked, and its other files' sizes; with `read`, their text, hidden ones and links
 * inside it left out (the folder itself may be a link: harnesses install skills that way). A file that is not UTF-8
 * text is left out and counted. Sizes are known before anything is read, and anything unreadable is the skill's
 * problem, never the listing's.
 */
async function readSkill(folder: string, name: string, read: boolean): Promise<FoundSkill> {
	const skillFile = join(folder, "SKILL.md");
	const info = await lstat(skillFile).catch(() => undefined);
	if (info === undefined || !info.isFile()) return { name, about: "", problem: "It has no SKILL.md." };
	if (info.size > MAX_SKILL_BYTES) return { name, about: "", problem: "Its SKILL.md is over 64 KB." };
	let text: string;
	try {
		text = await readFile(skillFile, "utf8");
	} catch {
		return { name, about: "", problem: "Its SKILL.md could not be read." };
	}
	const about = (() => {
		const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
		try {
			return short(skillHeader(header?.[1] ?? "").get("description") ?? "", ABOUT);
		} catch {
			return "";
		}
	})();
	try {
		parseSkill(name, text);
	} catch (error) {
		return { name, about, problem: `Its SKILL.md: ${error instanceof Error ? error.message : String(error)}.` };
	}
	// the owner sees its name and description, not every character of what will enter a prompt
	const hidden = hiddenError(text, { lines: true });
	if (hidden !== undefined) return { name, about, problem: `Its SKILL.md: ${hidden}.` };
	try {
		const listed = await walk(folder);
		if (listed === "too big")
			return { name, about, problem: `It is too big to bring: over ${MAX_FILES} files or 4 MB.` };
		const files = new Map<string, string>();
		let left = 0;
		if (read)
			for (const { path } of listed) {
				if (path === "SKILL.md") continue;
				try {
					files.set(path, new TextDecoder("utf-8", { fatal: true }).decode(await readFile(join(folder, path))));
				} catch {
					left++;
				}
			}
		files.set("SKILL.md", text);
		return { name, about, files, text, left };
	} catch {
		return { name, about, problem: "Part of its folder could not be read." };
	}
}

/** The skill `name` as `source` has it, read whole: from the first of its folders that has it, as listed. */
async function skillAt(source: Source, name: string): Promise<FoundSkill | undefined> {
	if (!SKILL_NAME.test(name)) return undefined;
	for (const dir of source.skills) if (await isDir(join(dir, name))) return readSkill(join(dir, name), name, true);
	return undefined;
}

async function skillsIn(source: Source): Promise<FoundSkill[]> {
	const found = new Map<string, FoundSkill>();
	for (const dir of source.skills) {
		const names = await readdir(dir).catch(() => [] as string[]);
		for (const name of names.sort()) {
			if (found.has(name) || name.startsWith(".") || !(await isDir(join(dir, name)))) continue;
			if (!SKILL_NAME.test(name)) {
				found.set(name, { name, about: "", problem: "Its folder's name is not a skill name banda takes." });
				continue;
			}
			found.set(name, await readSkill(join(dir, name), name, false));
		}
	}
	return [...found.values()];
}

/** An agent as found, already as banda's file; or why it cannot be one. */
type FoundAgent = { readonly name: string; readonly about: string } & (
	| { readonly text: string }
	| { readonly problem: string }
);

/** A Claude Code subagent (`agents/<name>.md`: name, description, tools, model; its prompt below) as a banda agent. */
export function agentFrom(file: string, raw: string): FoundAgent {
	const fallback = basename(file, ".md").toLowerCase();
	const header = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
	let fields: Map<string, string>;
	try {
		fields = skillHeader(header?.[1] ?? "");
	} catch {
		return { name: fallback, about: "", problem: "Its frontmatter could not be read." };
	}
	const name = (fields.get("name") ?? fallback).trim().toLowerCase();
	const description = short(fields.get("description") ?? "", MAX_DESCRIPTION);
	const about = short(description, ABOUT);
	if (header === null) return { name, about, problem: "It has no frontmatter." };
	if (!AGENT_NAME.test(name)) return { name, about, problem: "Its name is not an agent name banda takes." };
	if (description === "") return { name, about, problem: "It has no description." };
	const instructions = raw.slice(header[0].length).trim();
	if (instructions === "") return { name, about, problem: "It has no instructions." };
	const text = agentText({
		id: name,
		name: (name.charAt(0).toUpperCase() + name.slice(1)).replace(/-/g, " "),
		face: structuredClone(DEFAULT_FACE),
		state: "active",
		description,
		tools: [],
		instructions,
	});
	if (Buffer.byteLength(text) > MAX_AGENT_BYTES) return { name, about, problem: "It is over 64 KB." };
	const parsed = parseAgent(name, text);
	if ("errors" in parsed) return { name, about, problem: parsed.errors.join(" ") };
	return { name, about, text };
}

async function agentsIn(source: Source): Promise<FoundAgent[]> {
	if (source.agents === undefined) return [];
	const files = (await readdir(source.agents, { withFileTypes: true }).catch(() => []))
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => entry.name)
		.sort();
	const found = new Map<string, FoundAgent>();
	for (const file of files) {
		const path = join(source.agents, file);
		const size = (await lstat(path).catch(() => undefined))?.size ?? 0;
		const raw = size > MAX_AGENT_BYTES ? undefined : await readFile(path, "utf8").catch(() => undefined);
		const agent =
			raw === undefined
				? {
						name: basename(file, ".md"),
						about: "",
						problem: size > MAX_AGENT_BYTES ? "It is over 64 KB." : "It could not be read.",
					}
				: agentFrom(file, raw);
		if (!found.has(agent.name)) found.set(agent.name, agent);
	}
	return [...found.values()];
}

/**
 * What banda has already, by name: accepted skills and agents (and the lead). A skill folder or agent file in the box
 * that was never accepted is not banda's yet: bringing one of that name supersedes it, as the owner's saved agent
 * does, so a bring cut between its write and its accept is finished by bringing it again.
 */
async function present(harness: Harness, ctx: Context) {
	const files = (await harness.snapshot(Accepted, ctx))?.files ?? {};
	const skills = new Set(acceptedSkills(files).map(({ name }) => name));
	const agents = new Set(Object.keys(files).flatMap((path) => /^agents\/([a-z0-9-]+)\.md$/.exec(path)?.[1] ?? []));
	agents.add(LEAD);
	return { skills, agents };
}

const offer = (found: FoundSkill | FoundAgent, added: boolean): BringOffer => ({
	name: found.name,
	about: found.about,
	added,
	...("problem" in found ? { problem: found.problem } : {}),
});

const fromHome = (home: string, path: string) => {
	const inside = relative(home, path);
	return inside.startsWith("..") ? path : `~/${inside.split(sep).join("/")}`;
};

export async function bringable(
	harness: Harness,
	_workspace: Workspace,
	{ folders = { home: homedir() } }: BringOptions = {},
	ctx: Context = context,
): Promise<BringView> {
	const there = await present(harness, ctx);
	const harnesses: HostHarnessView[] = [];
	for (const source of sourcesOf(folders)) {
		if (!(await isDir(source.root))) continue;
		harnesses.push({
			name: source.name,
			service: source.service,
			folder: fromHome(folders.home, source.root),
			skills: (await skillsIn(source)).map((skill) => offer(skill, there.skills.has(skill.name))),
			agents: (await agentsIn(source)).map((agent) => offer(agent, there.agents.has(agent.name))),
		});
	}
	return { chosen: (await harness.snapshot(Companion, ctx))?.bringChosen === true, harnesses };
}

/**
 * The owner's picks at first run, each read again from its harness's folder now: the skills written into the
 * workspace and accepted together, then each agent saved as the owner's. One already in the workspace by that name is
 * left as it is. Empty picks skip, and banda's own skills are offered next; anything brought, and they are not. Either
 * way the step is not offered again.
 */
export async function chooseBring(
	harness: Harness,
	workspace: Workspace,
	picks: { readonly skills: readonly BringPick[]; readonly agents: readonly BringPick[] },
	changed: AgentChanged,
	options: BringOptions = {},
	ctx: Context = context,
): Promise<BringView> {
	const { folders = { home: homedir() }, fault = () => {} } = options;
	for (const kind of ["skills", "agents"] as const) {
		// refused before anything is written: accepting is all or none, and at most this many at once
		if (picks[kind].length > MAX_ACCEPTED_AT_ONCE)
			throw new BadRequest(`bring at most ${MAX_ACCEPTED_AT_ONCE} ${kind} at once`);
		if (new Set(picks[kind].map(({ name }) => name)).size !== picks[kind].length)
			throw new BadRequest(`two ${kind} of the same name are picked: pick one`);
	}
	const sources = new Map(sourcesOf(folders).map((source) => [source.name, source]));
	const sourceOf = (name: string) => {
		const source = sources.get(name);
		if (source === undefined) throw new BadRequest(`banda brings from no harness named ${name}`, 404);
		return source;
	};
	const there = await present(harness, ctx);
	const skills: Extract<FoundSkill, { text: string }>[] = [];
	for (const pick of picks.skills) {
		if (there.skills.has(pick.name)) continue;
		const found = await skillAt(sourceOf(pick.harness), pick.name);
		if (found === undefined)
			throw new BadRequest(`${pick.harness} has no skill named ${pick.name} now: look again`, 409);
		if ("problem" in found) throw new BadRequest(`/${pick.name}: ${found.problem}`);
		skills.push(found);
	}
	// each harness's agents listed once, however many are picked
	const listed = new Map<string, FoundAgent[]>();
	const agents: Extract<FoundAgent, { text: string }>[] = [];
	for (const pick of picks.agents) {
		if (there.agents.has(pick.name)) continue;
		const source = sourceOf(pick.harness);
		if (!listed.has(source.name)) listed.set(source.name, await agentsIn(source));
		const found = listed.get(source.name)?.find(({ name }) => name === pick.name);
		if (found === undefined)
			throw new BadRequest(`${pick.harness} has no agent named ${pick.name} now: look again`, 409);
		if ("problem" in found) throw new BadRequest(`${pick.name}: ${found.problem}`);
		agents.push(found);
	}
	for (const skill of skills)
		for (const [path, body] of skill.files)
			await write(workspace.env(), workspace, `${workspace.root}/skills/${skill.name}/${path}`, body, ctx);
	fault("bring:written");
	// accepted by the hash of the bytes written, as the owner picked them, all or none
	if (skills.length > 0)
		await acceptSkills(
			harness,
			workspace,
			skills.map(({ name, text }) => ({ name, sha: shaOf(text) })),
			ctx,
		);
	fault("bring:accepted");
	for (const agent of agents)
		if ((await harness.snapshot(Accepted, ctx))?.files[agentPath(agent.name)] === undefined) {
			await save(harness, workspace, agent.name, agent.text, null, changed, ctx);
			fault("bring:agent");
		}
	await harness.commit(async (tx) => {
		const doc = await tx.doc(Companion);
		doc.bringChosen = true;
		// the owner brought their own (picked, though a cut attempt may already have written them all): banda's skills are
		// not offered after
		if (picks.skills.length + picks.agents.length > 0) doc.skillsChosen = true;
	}, ctx);
	return bringable(harness, workspace, { folders }, ctx);
}
