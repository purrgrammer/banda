/** Shared skill catalogue: box files are proposals; accepted snapshots alone enter a prompt. */
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import type { Harness } from "@earendil-works/pi-durable";
import { Accepted, shaOf } from "../core/agents.ts";
import { Companion } from "../core/companion.ts";
import { acceptedSkills, MAX_SKILL_BYTES, parseSkill, SKILL_FILE, SKILL_NAME, type Skill } from "../core/skills.ts";
import { context } from "../core/store.ts";
import { readBytes, textOf, type Workspace, write } from "./agents.ts";
import { BadRequest } from "./http.ts";

export type SkillView = {
	name: string;
	accepted?: Skill & { text: string };
	change?: { kind: "added" | "changed" | "removed"; sha?: string; text?: string; errors?: string[] };
};

const directory = (workspace: Workspace) => `${workspace.root}/skills`;
const fileAt = (workspace: Workspace, name: string) => `${workspace.root}/${SKILL_FILE(name)}`;

/** Names in the box are UI data only, not accepted instructions returned by the skill tool. */
async function otherFiles(workspace: Workspace, name: string, ctx: Context): Promise<string[]> {
	const found = await workspace.env().listDir(`${directory(workspace)}/${name}`, ctx);
	if (!found.ok) return [];
	return found.value
		.flatMap(({ kind, name: file }) =>
			kind === "file" && file !== "SKILL.md" && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(file)
				? [`skills/${name}/${file}`]
				: [],
		)
		.sort();
}

async function candidate(workspace: Workspace, name: string, ctx: Context) {
	const result = await readBytes(workspace.env(), fileAt(workspace, name), MAX_SKILL_BYTES, ctx);
	if ("unreadable" in result) return { errors: [result.unreadable] };
	const decoded = textOf(result.bytes);
	if ("unreadable" in decoded) return { errors: [decoded.unreadable] };
	const sha = shaOf(decoded.text);
	try {
		parseSkill(name, decoded.text);
		return { sha, text: decoded.text };
	} catch (error) {
		return { sha, text: decoded.text, errors: [(error as Error).message] };
	}
}

export async function skills(harness: Harness, workspace: Workspace, ctx: Context = context): Promise<SkillView[]> {
	const accepted = (await harness.snapshot(Accepted, ctx))?.files ?? {};
	const catalogue = acceptedSkills(accepted);
	const names = new Set(catalogue.map(({ name }) => name));
	const listed = await workspace.env().listDir(directory(workspace), ctx);
	if (listed.ok) {
		for (const entry of listed.value)
			if (entry.kind === "directory" && SKILL_NAME.test(entry.name)) names.add(entry.name);
	} else if (listed.error.code !== "not_found") throw listed.error;
	const views: SkillView[] = [];
	for (const name of [...names].sort()) {
		const current = catalogue.find((skill) => skill.name === name);
		const acceptedFile = accepted[SKILL_FILE(name)];
		const found = await candidate(workspace, name, ctx);
		const missing = "errors" in found && found.errors?.some((error) => /not found|no such/i.test(error));
		const change = missing
			? current === undefined
				? undefined
				: { kind: "removed" as const }
			: found.sha === acceptedFile?.sha
				? undefined
				: {
						kind: current === undefined ? ("added" as const) : ("changed" as const),
						...found,
					};
		if (current === undefined && change === undefined) continue;
		views.push({
			name,
			...(current === undefined || acceptedFile === undefined
				? {}
				: { accepted: { ...current, files: await otherFiles(workspace, name, ctx), text: acceptedFile.text } }),
			...(change === undefined ? {} : { change }),
		});
	}
	return views;
}

/** The most skills one acceptance takes: a pack the owner reviewed as one list. */
export const MAX_ACCEPTED_AT_ONCE = 200;

/**
 * Accept the proposed files the owner saw, each by the hash shown, in one commit: all of them, or none when any changed
 * since or does not parse, so a list accepted is exactly the list reviewed.
 */
export async function acceptSkills(
	harness: Harness,
	workspace: Workspace,
	wanted: readonly { readonly name: string; readonly sha: string }[],
	ctx: Context = context,
) {
	if (wanted.length === 0 || wanted.length > MAX_ACCEPTED_AT_ONCE)
		throw new BadRequest(`accept between 1 and ${MAX_ACCEPTED_AT_ONCE} skills at once`);
	if (new Set(wanted.map(({ name }) => name)).size !== wanted.length) throw new BadRequest("a skill is listed twice");
	const files: { name: string; sha: string; text: string }[] = [];
	for (const { name, sha } of wanted) {
		if (!SKILL_NAME.test(name)) throw new BadRequest(`invalid skill name: ${name}`);
		const found = await candidate(workspace, name, ctx);
		if (found.sha !== sha || found.text === undefined)
			throw new BadRequest(`/${name} changed since you saw it: look again`, 409);
		if (found.errors !== undefined) throw new BadRequest(`/${name}: ${found.errors.join("\n")}`);
		files.push({ name, sha, text: found.text });
	}
	await harness.commit(async (tx) => {
		const accepted = (await tx.doc(Accepted)).files;
		const at = Date.now();
		for (const { name, sha, text } of files) accepted[SKILL_FILE(name)] = { sha, text, at };
	}, ctx);
	return skills(harness, workspace, ctx);
}

export const acceptSkill = (
	harness: Harness,
	workspace: Workspace,
	name: string,
	sha: string,
	ctx: Context = context,
) => acceptSkills(harness, workspace, [{ name, sha }], ctx);

export async function saveSkill(
	harness: Harness,
	workspace: Workspace,
	name: string,
	text: string,
	base: string | null,
	ctx: Context = context,
) {
	try {
		parseSkill(name, text);
	} catch (error) {
		throw new BadRequest((error as Error).message);
	}
	const accepted = (await harness.snapshot(Accepted, ctx))?.files[SKILL_FILE(name)];
	const found = await candidate(workspace, name, ctx);
	if ((accepted?.sha ?? null) !== base || (base !== null && found.sha !== base))
		throw new BadRequest("skill changed since you opened it: copy your text and look again", 409);
	// The owner's exact bytes are accepted, even if the box edits the file between the write and the store commit.
	await write(workspace.env(), workspace, fileAt(workspace, name), text, ctx);
	await harness.commit(async (tx) => {
		const files = (await tx.doc(Accepted)).files;
		if ((files[SKILL_FILE(name)]?.sha ?? null) !== base) throw new BadRequest("skill changed since you opened it", 409);
		files[SKILL_FILE(name)] = { sha: shaOf(text), text, at: Date.now() };
	}, ctx);
	return skills(harness, workspace, ctx);
}

/** The skills banda ships; the same path from `src/server` and `dist/server`. */
export const SHIPPED_SKILLS = fileURLToPath(new URL("../../shipped/skills/", import.meta.url));

/**
 * The skills banda offers at first run, in the order shown: what each is for in the owner's words (its description is
 * the model's), whether it starts on, and what else the owner should know before taking it.
 */
export const OFFERED_SKILLS: readonly { name: string; about: string; byDefault: boolean; note?: string }[] = [
	{ name: "eggbot", about: "Make an agent for the job you have in mind.", byDefault: true },
	{ name: "bro", about: "Say that again, in plain words.", byDefault: true },
	{ name: "in-your-own-words", about: "Check the agent understood what you're after.", byDefault: true },
	{ name: "unslop", about: "Strip the tells of machine writing from a text.", byDefault: true },
	{ name: "catch-me-up", about: "What happened since your last message, and what waits on you.", byDefault: true },
	{ name: "frontend-design", about: "Pages and screens with a look of their own.", byDefault: true },
	{
		name: "diagram-design",
		about: "Clear diagrams and charts, as pages.",
		byDefault: false,
		note: "Its pages load fonts from Google.",
	},
];

export type ShippedSkillView = {
	readonly name: string;
	readonly about: string;
	readonly byDefault: boolean;
	readonly note?: string;
	/** A skill of that name is in the workspace already (this one, or another): choosing it leaves that one as it is. */
	readonly added: boolean;
};

export type ShippedSkillsView = {
	/** The owner chose from these, or skipped them, at first run. */
	readonly chosen: boolean;
	readonly skills: readonly ShippedSkillView[];
};

/** A shipped skill's files, by path inside its folder, SKILL.md among them; hidden files are left out. */
async function shippedFiles(dir: string, name: string): Promise<Map<string, string>> {
	const folder = join(dir, name);
	const paths = (await readdir(folder, { recursive: true, withFileTypes: true }))
		.filter((entry) => entry.isFile())
		.map((entry) => relative(folder, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.filter((path) => !path.split("/").some((part) => part.startsWith(".")))
		.sort();
	const files = new Map<string, string>();
	for (const path of paths) files.set(path, await readFile(join(folder, path), "utf8"));
	return files;
}

/** The skill names in the workspace: accepted, or a folder in the box. */
async function presentSkills(harness: Harness, workspace: Workspace, ctx: Context): Promise<Set<string>> {
	const names = new Set(acceptedSkills((await harness.snapshot(Accepted, ctx))?.files ?? {}).map(({ name }) => name));
	const listed = await workspace.env().listDir(directory(workspace), ctx);
	if (listed.ok) {
		for (const entry of listed.value) if (entry.kind === "directory") names.add(entry.name);
	} else if (listed.error.code !== "not_found") throw listed.error;
	return names;
}

export async function shippedSkills(
	harness: Harness,
	workspace: Workspace,
	ctx: Context = context,
): Promise<ShippedSkillsView> {
	const present = await presentSkills(harness, workspace, ctx);
	return {
		chosen: (await harness.snapshot(Companion, ctx))?.skillsChosen === true,
		skills: OFFERED_SKILLS.map((offered) => ({ ...offered, added: present.has(offered.name) })),
	};
}

/**
 * The owner's choice at first run: each shipped skill picked is written into the workspace as banda ships it, and its
 * SKILL.md accepted by the hash of the bytes shipped, since banda wrote it and the owner chose it. A skill of that name
 * already there is left as it is. An empty pick skips; either way they are not offered again.
 */
export async function chooseShippedSkills(
	harness: Harness,
	workspace: Workspace,
	names: readonly string[],
	ctx: Context = context,
	dir: string = SHIPPED_SKILLS,
): Promise<ShippedSkillsView> {
	if (new Set(names).size !== names.length) throw new BadRequest("a skill is listed twice");
	for (const name of names)
		if (!OFFERED_SKILLS.some((offered) => offered.name === name))
			throw new BadRequest(`banda ships no skill named ${name}`, 404);
	const present = await presentSkills(harness, workspace, ctx);
	const wanted: { name: string; sha: string }[] = [];
	for (const name of names.filter((each) => !present.has(each))) {
		const files = await shippedFiles(dir, name);
		const text = files.get("SKILL.md");
		if (text === undefined) throw new Error(`shipped/skills/${name} has no SKILL.md`);
		for (const [path, body] of files)
			await write(workspace.env(), workspace, `${directory(workspace)}/${name}/${path}`, body, ctx);
		wanted.push({ name, sha: shaOf(text) });
	}
	// accepted as a reviewed pack is: each by the hash of the bytes banda wrote, all or none
	if (wanted.length > 0) await acceptSkills(harness, workspace, wanted, ctx);
	await harness.commit(async (tx) => {
		(await tx.doc(Companion)).skillsChosen = true;
	}, ctx);
	return shippedSkills(harness, workspace, ctx);
}
