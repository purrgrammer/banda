/**
 * The Skills page's model: filtering the list, the form's live verdicts and the "From banda" rows. The verdicts come
 * from the same rules the daemon enforces (src/core/skill-file.ts), said in the owner's words before a save is tried.
 */
import { MAX_SKILL_BYTES, parseSkill, SKILL_NAME, skillBytes, skillHeader } from "../../../src/core/skill-file.ts";

/** The name rule, as the hint under the field says it. */
export const NAME_RULE = "Names use lowercase letters, digits and hyphens.";

/** Case- and accent-insensitive: "Déploy" matches "deploy". */
const fold = (text: string) =>
	text
		.normalize("NFD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase();

/** The rows whose name or description contains the query, any case, accents aside. */
export function filterSkills<T extends { readonly name: string; readonly description: string }>(
	skills: readonly T[],
	query: string,
): readonly T[] {
	const wanted = fold(query.trim());
	if (wanted === "") return skills;
	return skills.filter(({ name, description }) => fold(name).includes(wanted) || fold(description).includes(wanted));
}

/** The list grows a filter field only once scanning it takes work. */
export const FILTER_FROM = 9;

export type SkillFormState = {
	/** The typed name breaks the rule; an empty name is merely unfinished. */
	readonly badName: boolean;
	/** A skill of this name is in the workspace already. */
	readonly taken: boolean;
	/** What keeps the file from saving, in words; empty when it would save. */
	readonly problems: readonly string[];
	/** The description in the frontmatter as typed so far, "" while there is none. */
	readonly description: string;
	readonly bytes: number;
	/** "52 KB of 64 KB", shown only near the limit (above 48 KB). */
	readonly size?: string;
	/** Above 64 KB: the daemon would refuse it. */
	readonly overSize: boolean;
	readonly valid: boolean;
};

/** The daemon's refusals, said to the owner before they happen. */
function said(message: string, name: string): string {
	if (message.includes("1–64 lowercase")) return NAME_RULE;
	if (message.includes("at most 64 KB")) return "The file is over 64 KB. Shorten it to save.";
	if (message.includes("--- frontmatter"))
		return "Start the file with --- lines giving the skill's name and description.";
	if (message.includes("name must be")) return `The file's name line must say ${name}.`;
	if (message.includes("1–1024 characters")) return "The description needs 1 to 1,024 characters.";
	if (message.includes("frontmatter")) return "Each line between the --- marks reads as key: value, each key once.";
	return message;
}

/** The description as typed, even while the rest of the file does not parse yet. */
function typedDescription(text: string): string {
	const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	if (header === null) return "";
	try {
		return skillHeader(header[1] ?? "").get("description") ?? "";
	} catch {
		return "";
	}
}

/**
 * The form's live verdict on a name and file: what the daemon would refuse, before it is asked. `existing` is the
 * names already in the workspace; on an edit the name is its own, so it is never "taken".
 */
export function skillFormState({
	name,
	text,
	existing = [],
}: {
	readonly name: string;
	readonly text: string;
	readonly existing?: readonly string[];
}): SkillFormState {
	const badName = name !== "" && !SKILL_NAME.test(name);
	const taken = existing.includes(name);
	const bytes = skillBytes(text);
	const overSize = bytes > MAX_SKILL_BYTES;
	const problems: string[] = [];
	if (name === "" || badName) problems.push(NAME_RULE);
	else if (taken) problems.push(`A skill called /${name} already exists.`);
	if (!badName && name !== "") {
		try {
			parseSkill(name, text);
		} catch (error) {
			problems.push(said((error as Error).message, name));
		}
	}
	return {
		badName,
		taken,
		problems,
		description: typedDescription(text),
		bytes,
		...(bytes > (MAX_SKILL_BYTES * 3) / 4 ? { size: `${Math.ceil(bytes / 1024)} KB of 64 KB` } : {}),
		overSize,
		valid: name !== "" && problems.length === 0,
	};
}

/** The shipped skills still worth a row: the ones not in the workspace. The section hides when none are left. */
export const offersLeft = <T extends { readonly added: boolean }>(skills: readonly T[]): readonly T[] =>
	skills.filter(({ added }) => !added);
