/** Accepted skill prompt files. The box may write drafts; only the owner's accepted bytes enter a model request. */

import type { AssistantMessage, Message, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	GenerationTask,
	hook,
	type JsonObject,
	section,
} from "@earendil-works/pi-durable";
import { Accepted, type AcceptedFile, shaOf } from "./agents.ts";

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
	if (Buffer.byteLength(text) > MAX_SKILL_BYTES) throw new Error("a skill file may be at most 64 KB");
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

/** Only accepted files, never the workspace's unreviewed version, can supply a skill prompt. */
export function acceptedSkills(files: Readonly<Record<string, AcceptedFile>>): Skill[] {
	return Object.entries(files)
		.flatMap(([path, file]) => {
			const name = /^skills\/([a-z0-9-]+)\/SKILL\.md$/.exec(path)?.[1];
			if (name === undefined) return [];
			try {
				return [{ ...parseSkill(name, file.text), sha: file.sha, files: [] }];
			} catch {
				return [];
			}
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Both the agent's tool and an owner's pre-request load return these exact accepted bytes. */
export const skillOutput = (skill: Skill) => skill.body;

/** One complete synthetic tool round in one write: no request can see a call without its result. */
export function ownerSkillEntry(
	skill: Skill,
	call: string,
	now: number,
	inputText: string,
	group?: { room: number; key: string },
	invocation?: { gateway: string; message: string },
) {
	const id = `${call}:for:${shaOf(inputText)}`;
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "skill", arguments: { name: skill.name } }],
		api: "pi-messages",
		provider: "banda",
		model: "owner",
		usage,
		stopReason: "toolUse",
		timestamp: now,
	};
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: id,
		toolName: "skill",
		content: [{ type: "text", text: skillOutput(skill) }],
		details: {
			receipt: {
				kind: "skill",
				name: skill.name,
				sha: skill.sha,
				by: "owner",
				description: skill.description,
				files: skill.files,
				...(invocation === undefined ? {} : { invocation }),
			},
		},
		isError: false,
		timestamp: now,
	};
	return {
		kind: "banda.skill-load",
		data: {
			name: skill.name,
			sha: skill.sha,
			by: "owner",
			at: now,
			...(group === undefined ? {} : { group }),
		} as JsonObject,
		model: [assistant, result],
	};
}

/** An in-flight earlier run cannot see a load before its owner input reaches that run's model boundary. */
export function visibleSkillMessages(messages: readonly Message[]): readonly Message[] {
	const hidden = new Set<string>();
	for (const [index, message] of messages.entries()) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || block.name !== "skill") continue;
			const hash = /:for:([0-9a-f]{64})$/.exec(block.id)?.[1];
			if (hash === undefined) continue;
			const matched = messages.slice(index + 1).some((next) => {
				if (next.role !== "user") return false;
				const text =
					typeof next.content === "string"
						? next.content
						: next.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
				return shaOf(text) === hash;
			});
			if (!matched) hidden.add(block.id);
		}
	}
	return hidden.size === 0
		? messages
		: messages.flatMap((message) => {
				if (
					message.role === "assistant" &&
					message.content.some((part) => part.type === "toolCall" && hidden.has(part.id))
				)
					return [];
				if (message.role === "toolResult" && hidden.has(message.toolCallId)) return [];
				return [message];
			});
}

export const skillsExtension = defineExtension({
	name: "banda.skills",
	// A busy run can reach a model boundary after the write but before its owner input is submitted.
	// This round is visible only with its matching input. Both records remain durable and inspectable.
	hooks: [
		hook(GenerationTask, {
			beforeRequest: ({ messages }) => {
				const visible = visibleSkillMessages(messages);
				return visible === messages ? undefined : { messages: visible };
			},
		}),
	],
	sections: [
		section("skills", async (input, ctx) => {
			// a skill only the owner invokes is not offered: the owner's /name loads it before the model acts
			const names = acceptedSkills((await input.read.snapshot(Accepted, ctx))?.files ?? {}).filter(
				({ ownerOnly }) => ownerOnly !== true,
			);
			return names.length === 0
				? undefined
				: `Skills available on demand. Load one with the skill tool when the task fits its description. The owner can invoke /name; those skills are loaded before you act.\n${names.map(({ name, description }) => `${name}: ${description}`).join("\n")}`;
		}),
	],
	tools: [
		defineTool({
			name: "skill",
			description:
				"Load the accepted instructions of one shared skill by name. Returns its exact SKILL.md body. Other files remain data in the box, not accepted instructions. Read-only.",
			parameters: Type.Object({ name: Type.String({ pattern: SKILL_NAME.source }) }, { additionalProperties: false }),
			replay: "safe",
			execute: async ({ name }, api, ctx) => {
				const skill = acceptedSkills((await api.snapshot(Accepted, ctx))?.files ?? {}).find(
					(item) => item.name === name,
				);
				if (skill === undefined)
					return { output: [{ type: "text", text: `No accepted skill named ${name}.` }], isError: true };
				if (skill.ownerOnly === true)
					return {
						output: [{ type: "text", text: `${name} is loaded only when the owner invokes /${name}.` }],
						isError: true,
					};
				return {
					output: [{ type: "text", text: skillOutput(skill) }],
					details: {
						receipt: {
							kind: "skill",
							name: skill.name,
							sha: skill.sha,
							by: "agent",
							description: skill.description,
							files: skill.files,
						},
					},
				};
			},
		}),
	],
});
