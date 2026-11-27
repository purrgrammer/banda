/** Shared skill catalogue: box files are proposals; accepted snapshots alone enter a prompt. */
import type { Context } from "@earendil-works/chord";
import type { Harness } from "@earendil-works/pi-durable";
import { Accepted, shaOf } from "../core/agents.ts";
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
