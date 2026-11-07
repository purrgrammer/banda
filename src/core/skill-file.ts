/**
 * The SKILL.md file format: one set of rules, used by the daemon to admit a file and by the app to tell the owner,
 * as they type, what the daemon will say. Browser-safe: no Node imports, so the web bundle carries the same rules.
 */

export const SKILL_NAME = /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/;
export const SKILL_FILE = (name: string) => `skills/${name}/SKILL.md`;
export const MAX_SKILL_BYTES = 65_536;

export type Skill = {
	name: string;
	description: string;
	path: string;
	body: string;
	sha: string;
	files: string[];
	/** `disable-model-invocation: true`: only the owner's /name loads it; agents neither see it offered nor load it. */
	ownerOnly?: true;
};

/** The size rule measures bytes as written, not characters. */
export const skillBytes = (text: string) => new TextEncoder().encode(text).length;

/** A YAML scalar as written: unquoted, "double" (with \" and \\) or 'single' (with ''). */
function scalar(value: string): string {
	const text = value.trim();
	if (text.length >= 2 && text.startsWith('"') && text.endsWith('"'))
		return text.slice(1, -1).replace(/\\(["\\])/g, "$1");
	if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
	return text;
}

/**
 * The Agent Skills frontmatter as banda reads it: its top-level keys, each a scalar (plain, quoted, or a folded `>` or
 * literal `|` block); the indented lines under a key with no value (a map such as `metadata:`) are kept as that key's
 * data. Keys banda does not use never refuse a skill: the format is open, and a skill made for another harness keeps
 * its own fields.
 */
export function skillHeader(block: string): Map<string, string> {
	const fields = new Map<string, string>();
	const lines = block.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
		const match = /^([A-Za-z][\w-]*):(?:\s+(.*))?$/.exec(line.trimEnd());
		if (match === null) throw new Error(`frontmatter line ${i + 2}: write "key: value"`);
		const [, key = "", value = ""] = match;
		if (fields.has(key)) throw new Error(`frontmatter "${key}" is given twice`);
		// what is indented under this key belongs to it
		const under: string[] = [];
		while (i + 1 < lines.length && (/^\s/.test(lines[i + 1] ?? "") || (lines[i + 1] ?? "").trim() === "")) {
			under.push(lines[i + 1] ?? "");
			i++;
		}
		while (under.length > 0 && (under.at(-1) ?? "").trim() === "") under.pop();
		const block = /^([>|])[+-]?$/.exec(value.trim());
		if (block !== null) {
			const indent = Math.min(
				...under.filter((each) => each.trim() !== "").map((each) => /^\s*/.exec(each)?.[0].length ?? 0),
			);
			const body = under.map((each) => each.slice(Number.isFinite(indent) ? indent : 0));
			fields.set(
				key,
				block[1] === "|"
					? body.join("\n")
					: body
							.join("\n")
							.split(/\n\s*\n/)
							.map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").trim())
							.join("\n"),
			);
		} else if (value.trim() === "") fields.set(key, under.join("\n"));
		else if (under.some((each) => each.trim() !== ""))
			fields.set(key, scalar([value, ...under].join(" ").replace(/\s+/g, " ")));
		else fields.set(key, scalar(value));
	}
	return fields;
}

/** A prompt file in the Agent Skills format. Invalid drafts never enter the catalogue. */
export function parseSkill(name: string, text: string): Omit<Skill, "sha" | "files"> {
	if (!SKILL_NAME.test(name)) throw new Error("a skill name is 1–64 lowercase letters, digits or single hyphens");
	if (skillBytes(text) > MAX_SKILL_BYTES) throw new Error("a skill file may be at most 64 KB");
	const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	if (header === null) throw new Error("SKILL.md needs name and description in --- frontmatter");
	const fields = skillHeader(header[1] ?? "");
	if (fields.get("name") !== name) throw new Error(`the skill's name must be ${name}`);
	const description = fields.get("description") ?? "";
	if (description.length === 0 || description.length > 1024) throw new Error("description must have 1–1024 characters");
	const invocation = fields.get("disable-model-invocation");
	if (invocation !== undefined && invocation !== "true" && invocation !== "false")
		throw new Error("disable-model-invocation is true or false");
	return {
		name,
		description,
		path: SKILL_FILE(name),
		body: text.slice(header[0].length),
		...(invocation === "true" ? { ownerOnly: true as const } : {}),
	};
}
