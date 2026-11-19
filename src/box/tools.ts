/**
 * The box's tools: pi-durable's `bash`, `read`, `write` and `edit`, run freely in the box. A call a crash interrupted is reported
 * interrupted, never run again (their replay is unsafe).
 *
 * `bash` runs its commands with colour off, and what they print in colour anyway reaches the model and the transcript
 * without its escape sequences: they are terminal drawing, not text.
 */

import { createHash } from "node:crypto";
import { dirname, posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
	defineExtension,
	type Extension,
	type HarnessOptions,
	type PromptSection,
	type ToolExecutionApi,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type ImageProcessor,
} from "@earendil-works/pi-durable/tools";
import { Accepted, AGENT_NAME } from "../core/agents.ts";
import { type HoldingEgress, intake, withIntake } from "../core/egress.ts";

import { MAX_SKILL_BYTES, SKILL_FILE, SKILL_NAME } from "../core/skill-file.ts";
import { putSkill } from "../core/skills.ts";
import { context } from "../core/store.ts";
import type { CoreOptions } from "../core/turn.ts";
import { ansiStripper } from "./ansi.ts";
import type { Box } from "./box.ts";

export const BOX_TOOLS = ["bash", "read", "write", "edit"] as const;

/**
 * The box's tools; `workspace` is where the files that wait to be accepted are. With `egress`, after each command the
 * daemon takes what the proxy held for the chat into the store, and the command's result lists it.
 */
export function boxTools({
	images,
	box,
	egress,
	ready,
	fault,
	changed,
}: {
	images?: ImageProcessor;
	box?: Pick<Box, "kind" | "workspace" | "attachments">;
	egress?: HoldingEgress;
	/**
	 * Before a command of `chat` runs: the proxy knows what the store says this chat may send straight through (a chat
	 * just started is in the proxy's config before its first command).
	 */
	ready?: (chat: number) => Promise<void>;
	fault?: (point: string) => void;
	/** A mutation finished, including failures whose partial writes must be reconciled. */
	changed?: () => void;
} = {}): Extension {
	const workspace = box?.workspace;
	const shell = telling(bash(), workspace);
	const tools = [
		egress === undefined ? shell : taking(shell, egress, fault, ready),
		accepting(createWriteTool() as ToolRegistration, workspace),
		accepting(createEditTool() as ToolRegistration, workspace),
	].map((tool) => notifying(tool, changed));
	tools.push(createReadTool(images === undefined ? {} : { images }) as ToolRegistration);
	const sections: PromptSection[] =
		box === undefined
			? []
			: [
					{
						key: "computer",
						render: () =>
							box.kind === "host"
								? `Commands run directly on the owner's computer. Shared workspace: ${JSON.stringify(box.workspace)}. Incoming files: ${JSON.stringify(box.attachments)}.`
								: `Your Linux computer is shared by the band. ${JSON.stringify(box.workspace)} holds shared work and definitions; /work is your home (incoming files: ${JSON.stringify(box.attachments)}); /tools holds installed software. These folders persist; /tmp is temporary. Check existing tools, install missing software under /tools without root, and reuse it. /tools/bin is on PATH.`,
					},
				];
	return defineExtension({ name: "banda.box", sections, tools: tools as ToolRegistration[] });
}

function notifying(tool: ToolRegistration, changed: (() => void) | undefined): ToolRegistration {
	return {
		...tool,
		execute: async (args, api, ctx) => {
			try {
				return await tool.execute(args, api, ctx);
			} finally {
				changed?.();
			}
		},
	};
}

/**
 * Colour off, both ways: FORCE_COLOR=0 for the libraries that read its value (it also overrides a FORCE_COLOR the box
 * inherited), and NO_COLOR for those that take any FORCE_COLOR as forcing but let NO_COLOR win (picocolors, vitest's).
 */
const NO_COLOR = { NO_COLOR: "1", FORCE_COLOR: "0" } as const;

/** pi-durable's `bash`, its commands' colour off and its output's escape sequences stripped. */
function bash(): ToolRegistration {
	const tool = createBashTool({
		prepare: (execution) => {
			Object.assign(execution.env, NO_COLOR);
		},
	}) as ToolRegistration;
	return {
		...tool,
		execute: (args, api, ctx) => {
			const strip = ansiStripper();
			const decoder = new TextDecoder();
			// no output window: the box would skip what it judges outside the tail by its length before stripping, and
			// pi-durable asks a wrapper that changes output text to give none
			// the call's api, read through (its getters stay live), with these two of its own
			const stripped: ToolExecutionApi = Object.create(api, {
				outputWindow: { value: undefined },
				output: {
					value: (chunk: string | Uint8Array) =>
						api.output(strip(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }))),
				},
			});
			return tool.execute(args, stripped, ctx);
		},
	};
}

/**
 * `tool`, then what the egress proxy held for the chat while it ran, taken into the store and listed in its
 * result (DESIGN.md "The box", Network). A proxy that does not answer is said, never taken as nothing held.
 */
function taking(
	tool: ToolRegistration,
	egress: HoldingEgress,
	fault?: (point: string) => void,
	ready?: (chat: number) => Promise<void>,
): ToolRegistration {
	return {
		...tool,
		execute: (args, api, ctx) =>
			withIntake(egress, Number(api.conversationId), async () => {
				// a proxy not yet told holds this chat's writes, which then ask: never a send the store does not allow
				await ready?.(Number(api.conversationId)).catch(() => undefined);
				try {
					return await tool.execute(args, api, ctx);
				} finally {
					// after the command's own output, also when it failed or timed out: the result is the output retained
					let said: string;
					try {
						said = await intake(egress, api, ctx, fault);
					} catch (error) {
						said =
							"\n\n[banda] The egress proxy did not answer, so what this command sent out is not known yet: " +
							`${error instanceof Error ? error.message : String(error)}`;
					}
					if (said !== "") api.output(said);
				}
			}),
	};
}

/** The folders of the workspace whose files take effect only once the owner accepts them ("before" files). */
const BEFORE = ["agents", "routines", "watches"];

/**
 * The "before" file at `at` (absolute), relative to the workspace; undefined for any other file. An agent's own
 * routines and watches (`agents/<agent>/routines/<name>.md`, `agents/<agent>/watches/<name>.md`) are before files as
 * the shared ones are.
 */
function beforeFile(workspace: string, at: string): string | undefined {
	const relative = posix.relative(workspace, at);
	const folder = posix.dirname(relative);
	return (BEFORE.includes(folder) || ownFolder(folder)) &&
		posix.extname(relative) === ".md" &&
		AGENT_NAME.test(posix.basename(relative, ".md"))
		? relative
		: undefined;
}

/** The folders in an agent's own folder whose files take effect only once the owner accepts them. */
const OWN = ["routines", "watches"];

/** Whether `folder` (relative to the workspace) is an agent's own routines or watches folder. */
const ownFolder = (folder: string) => {
	const [top, agent = "", own = "", ...rest] = folder.split("/");
	return top === "agents" && AGENT_NAME.test(agent) && OWN.includes(own) && rest.length === 0;
};

/** What the model is told of a "before" file a call changed (by its path in the workspace), as a diagnostic. */
export const awaiting = (path: string) => ({
	severity: "info" as const,
	code: "awaits-acceptance",
	message:
		`${path} takes effect only once the owner accepts it in the app; until then the accepted version stays in ` +
		"effect. Tell them it waits for them, not that it is done.",
});

/** The most bytes of one "before" file hashed to see whether a command changed it; past that, its size and time. */
const HASHED = 1024 * 1024;

/**
 * Every "before" file in the box's workspace now, by path relative to it: a hash of its bytes (a link is named as
 * one, never followed). Undefined when the box cannot be read: then nothing is told rather than a guess.
 */
async function beforeFiles(
	env: ExecutionEnv,
	workspace: string,
	ctx: Context,
): Promise<Map<string, string> | undefined> {
	const found = new Map<string, string>();
	const look = async (
		path: string,
		info: { kind: string; size: number; mtimeMs: number },
		relative = beforeFile(workspace, path),
	) => {
		if (relative === undefined) return;
		if (info.kind !== "file") return found.set(relative, info.kind);
		if (info.size > HASHED) return found.set(relative, `${info.size}:${info.mtimeMs}`);
		const opened = await env.openBinaryReader(path, { noFollow: true }, ctx);
		if (!opened.ok) return found.set(relative, `unreadable:${opened.error.code}`);
		try {
			const bytes = await opened.value.read(0, info.size, ctx);
			found.set(relative, bytes.ok ? createHash("sha256").update(bytes.value).digest("hex") : "unreadable");
		} finally {
			await opened.value.close(ctx);
		}
	};
	const folders = [...BEFORE];
	for (let at = 0; at < folders.length; at++) {
		const folder = folders[at] as string;
		const listed = await env.listDir(`${workspace}/${folder}`, ctx);
		if (!listed.ok) {
			if (listed.error.code === "not_found") continue;
			return undefined;
		}
		for (const entry of listed.value) {
			// an agent's folder holds its own routines and watches: each a real folder, never one reached through a link
			if (folder === "agents" && entry.kind === "directory" && AGENT_NAME.test(entry.name))
				for (const kind of OWN) {
					const own = await env.fileInfo(`${workspace}/agents/${entry.name}/${kind}`, ctx);
					if (own.ok && own.value.kind === "directory") folders.push(`agents/${entry.name}/${kind}`);
				}
			await look(`${workspace}/${folder}/${entry.name}`, entry);
		}
	}
	// each skill's instructions: a command that changed one puts the new file in effect, and the model is told
	const skills = await env.listDir(`${workspace}/skills`, ctx);
	if (!skills.ok) return skills.error.code === "not_found" ? found : undefined;
	for (const entry of skills.value) {
		if (entry.kind !== "directory" || !SKILL_NAME.test(entry.name)) continue;
		const file = await env.fileInfo(`${workspace}/${SKILL_FILE(entry.name)}`, ctx);
		if (file.ok) await look(`${workspace}/${SKILL_FILE(entry.name)}`, file.value, SKILL_FILE(entry.name));
	}
	return found;
}

/**
 * `bash`, telling the model of each "before" file its command changed (made, rewritten or removed), as `write` and
 * `edit` tell of theirs: the workspace's "before" files are read before the command and after it, and each that
 * differs, and is not now the version in effect, is told awaiting the owner, so the app shows its change where it was
 * made. A file left as it was, or as the owner accepted it, is not told, nor is any file while the box cannot be read.
 */
function telling(tool: ToolRegistration, workspace: string | undefined): ToolRegistration {
	if (workspace === undefined) return tool;
	return {
		...tool,
		execute: async (args, api, ctx) => {
			const env = api.env;
			const before = env === undefined ? undefined : await beforeFiles(env, workspace, ctx).catch(() => undefined);
			const result = await tool.execute(args, api, ctx);
			if (env === undefined || before === undefined) return result;
			const after = await beforeFiles(env, workspace, ctx).catch(() => undefined);
			if (after === undefined) return result;
			// what is in effect: a file the command left as the accepted version (or the daemon wrote back meanwhile, as
			// it seeds the lead's file) waits for nothing
			const accepted = (await api.snapshot(Accepted, ctx))?.files ?? {};
			const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
				(path) => before.get(path) !== after.get(path) && after.get(path) !== accepted[path]?.sha,
			);
			for (const path of changed.sort()) {
				const skill = skillNamed(path);
				if (skill === undefined) api.diagnostic(awaiting(path));
				else {
					const note = await putSkillAt(api, ctx, env, `${workspace}/${path}`, skill);
					if (note !== undefined) api.diagnostic(note);
				}
			}
			return result;
		},
	};
}

/** The skill whose instructions `path` (relative to the workspace) is: `skills/<name>/SKILL.md`. */
function skillNamed(path: string): string | undefined {
	const name = /^skills\/([^/]+)\/SKILL\.md$/.exec(path)?.[1];
	return name !== undefined && SKILL_NAME.test(name) ? name : undefined;
}

/** What the model is told of a SKILL.md in the workspace that cannot be in effect, and why. */
export const skillWaits = (path: string, why: string) => ({
	severity: "warn" as const,
	code: "skill-waits",
	message:
		`${path} is not in effect: ${why}. A SKILL.md in the workspace is in effect as soon as it parses (--- frontmatter ` +
		"with name and description, then the body) and hides no character; until then the version in effect, if any, " +
		"is what loads, and the Skills page shows the owner what is wrong.",
});

/** What the model is told of a skill now in effect, with nothing for the owner to accept. */
export const skillInEffect = (path: string, name: string, change: "added" | "changed") => ({
	severity: "info" as const,
	code: "skill-in-effect",
	message:
		`${path} is in effect: the skill /${name} was ${change}, and the owner sees it on the Skills page. ` +
		"It gives no tool, connection or permission.",
});

/** The text of `path` in the box as it is now, read without following a link; undefined when it is not plain text. */
async function textAt(env: ExecutionEnv, path: string, ctx: Context): Promise<string | undefined> {
	const opened = await env.openBinaryReader(path, { noFollow: true }, ctx);
	if (!opened.ok) return undefined;
	try {
		const info = await opened.value.info(ctx);
		if (!info.ok || info.value.size > MAX_SKILL_BYTES) return undefined;
		const bytes = await opened.value.read(0, info.value.size, ctx);
		if (!bytes.ok) return undefined;
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes.value);
	} catch {
		return undefined;
	} finally {
		await opened.value.close(ctx);
	}
}

/**
 * Skill `name`'s SKILL.md at `at` (absolute, in the box) as it is now, in effect (`putSkill`), whichever tool left it
 * there: the workspace's skills are the agents' own (DESIGN.md "The workspace"). The note for the model says what
 * happened; none when the file already was the version in effect.
 */
async function putSkillAt(
	api: ToolExecutionApi,
	ctx: Context,
	env: ExecutionEnv,
	at: string,
	name: string,
): Promise<ReturnType<typeof skillWaits> | ReturnType<typeof skillInEffect> | undefined> {
	const path = SKILL_FILE(name);
	const text = await textAt(env, at, ctx);
	if (text === undefined) return skillWaits(path, "it could not be read back as text of at most 64 KB");
	const put = await api.commit((tx) => putSkill(tx, name, text, api.now()), ctx);
	if ("refused" in put) return skillWaits(path, put.refused);
	return put.change === "same" ? undefined : skillInEffect(path, name, put.change);
}

/**
 * `tool` (write or edit), telling the model when what it changed takes effect. An agent, routine or watch file waits
 * for the owner: until then the accepted version stays in effect, so the change is not done when the call is. A
 * skill's SKILL.md is in effect at once, as the file now stands (DESIGN.md "The workspace").
 */
export function accepting(tool: ToolRegistration, workspace: string | undefined): ToolRegistration {
	if (workspace === undefined) return tool;
	return {
		...tool,
		execute: async (args, api, ctx) => {
			const result = await tool.execute(args, api, ctx);
			const path = (args as { path?: unknown }).path;
			const cwd = api.env?.cwd ?? workspace;
			if (typeof path !== "string" || result.isError === true) return result;
			const at = posix.resolve(cwd, path);
			const file = beforeFile(workspace, at);
			if (file !== undefined) api.diagnostic(awaiting(file));
			const skill = skillNamed(posix.relative(workspace, at));
			if (skill === undefined || api.env === undefined) return result;
			const note = await putSkillAt(api, ctx, api.env, at, skill);
			if (note !== undefined) api.diagnostic(note);
			return result;
		},
	};
}

/** The Harness's `env`: the box, at the chat's working directory (relative to the workspace), else its root. */
export function boxEnv(box: Box): NonNullable<HarnessOptions["env"]> {
	return async (target) => {
		// its commands reach the proxy as this chat, so what they read and send is its own
		const env = box.egress?.env(Number(target.conversationId));
		return box.env(target.cwd === undefined ? undefined : `${box.workspace}/${target.cwd}`, env);
	};
}

/** Where attachments that came in go in `box`, and how one is written there (its folder made first). */
export function attachmentsIn(box: Box): NonNullable<CoreOptions["box"]> {
	return {
		attachments: box.attachments,
		write: async (path, bytes) => {
			const env = box.env();
			const made = await env.createDir(dirname(path), { recursive: true }, context);
			if (!made.ok) throw made.error;
			const written = await env.writeFile(path, bytes, context);
			if (!written.ok) throw written.error;
		},
	};
}
