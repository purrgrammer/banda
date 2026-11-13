/**
 * The size of what every fresh chat sends before its first word (AGENTS.md principle 14): the system prompt and the tools
 * offered from the first step, both written to the provider's cache on each cold start and read on every request. A
 * real daemon, on pi-ai's faux provider and the host box, takes three fresh chats (the lead's, another agent's, and a
 * member's in a group); each one's first request, as the provider receives it, is measured in UTF-8 bytes and compared
 * by equality with `prompt-budget.json`. A number that grows or shrinks fails here until the new file is committed, so
 * every change to it is a line in the diff a reviewer sees, with the section or the tool it came from.
 *
 * To change it on purpose: `npm run prompt:budget`, which runs this file with `BANDA_PROMPT_BUDGET=update`, rewrites the
 * file and still fails, so no run that writes it ever passes; read `git diff test/prompt-budget.json`, rerun the test,
 * and commit the file with the change that moved it. It refuses to write under CI.
 *
 * What is fixed so the numbers are the same on every machine: the clock (Wednesday 7 January 2026, 09:30 UTC) and the
 * time zone (UTC), which the status line spells out; the agents, their files and the group; and a fresh home, so memory
 * is empty and no connection is installed. The computer section's two actual paths are checked, then canonicalized
 * to /workspace and /work/attachments before counting; the run's temporary home must occur nowhere else.
 * Tools are measured in pi-ai's provider-neutral declaration (`name`,
 * `description`, `parameters`), not one provider's wire shape. The host box has no browser and no egress proxy, so the
 * tools those install, all of them loaded on demand, are not named in the prompt's on-demand groups here.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type Context,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	getSystemMessageText,
	type SystemMessage,
	type Tool,
} from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MAIN_THREAD } from "../src/core/gateway.ts";
import { MESSAGE_GROUP, MESSAGE_USER } from "../src/core/toolsets.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { tempHome, until } from "./helpers.ts";

const BASELINE = new URL("./prompt-budget.json", import.meta.url);
const UPDATE = process.env.BANDA_PROMPT_BUDGET === "update";

/** Wednesday 7 January 2026, 09:30 UTC: within an hour, so the status line holds still for the run. */
const AT = Date.UTC(2026, 0, 7, 9, 30);
const ZONE = "UTC";

const HELPER = "---\nname: Helper\ndescription: Looks things up for the owner.\n---\nHELPER INSTRUCTIONS.\n";
const REVIEWER = "---\nname: Reviewer\ndescription: Reviews drafts.\n---\nREVIEWER INSTRUCTIONS.\n";

type Size = { readonly total: number; readonly sections: Record<string, number> };
type Tools = { readonly total: number; readonly tools: Record<string, number> };
type Budget = { readonly system: Size; readonly tools: Tools };
type Variant = "lead" | "helper" | "group";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** A first request's system prompt and tools, in bytes, section by section and tool by tool. */
function measure(context: Context, home: string): Budget {
	const system = context.messages.filter((message): message is SystemMessage => message.role === "system");
	// a fresh chat's first request: one leading system message, nothing the model said before
	expect(system).toHaveLength(1);
	expect(context.messages.some((message) => message.role === "assistant" || message.role === "toolResult")).toBe(false);
	const [captured] = system as [SystemMessage];
	const computer = captured.sections?.computer;
	assert.ok(typeof computer === "string");
	const workspace = JSON.stringify(join(home, "workspace"));
	const attachments = JSON.stringify(join(home, "work", "attachments"));
	expect(computer).toContain(workspace);
	expect(computer).toContain(attachments);
	const head: SystemMessage = {
		...captured,
		sections: {
			...captured.sections,
			computer: computer.replace(workspace, '"/workspace"').replace(attachments, '"/work/attachments"'),
		},
	};
	const messages = context.messages.map((message) => (message === captured ? head : message));
	expect(JSON.stringify({ ...context, messages })).not.toContain(home);
	const prompt = getCurrentSystemPrompt(messages);
	expect(getSystemMessageText(head)).toBe(prompt);
	const tools: Tool[] = getCurrentTools(context.messages).map(({ name, description, parameters }) => ({
		name,
		description,
		parameters,
	}));
	return {
		system: {
			total: bytes(prompt),
			sections: {
				...(typeof head.content === "string" && head.content.length > 0 ? { "(content)": bytes(head.content) } : {}),
				...Object.fromEntries(
					Object.entries(head.sections ?? {}).flatMap(([key, text]) => (text === null ? [] : [[key, bytes(text)]])),
				),
			},
		},
		tools: {
			total: bytes(JSON.stringify(tools)),
			tools: Object.fromEntries(tools.map((tool) => [tool.name, bytes(JSON.stringify(tool))])),
		},
	};
}

describe("what a fresh chat sends before its first word", () => {
	const zone = process.env.TZ;
	let now: { mockRestore(): void } | undefined;
	beforeAll(() => {
		process.env.TZ = ZONE;
		// the real clock, moved to AT: time still passes for the daemon's timers, and the hour stays the same
		const shift = AT - Date.now();
		const real = Date.now.bind(Date);
		now = vi.spyOn(Date, "now").mockImplementation(() => real() + shift);
	});
	afterAll(() => {
		now?.mockRestore();
		if (zone === undefined) delete process.env.TZ;
		else process.env.TZ = zone;
	});

	it("is the size prompt-budget.json says, byte for byte", async () => {
		expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(ZONE);
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const web = join(home, "web");
		await mkdir(web, { recursive: true });
		await writeFile(join(web, "index.html"), "<!doctype html><title>banda</title>");
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		// every request, as the provider receives it; each run speaks once with its chat's tool, then ends
		const sent: Context[] = [];
		faux.setResponses(
			Array.from({ length: 100 }, () => (context: Context) => {
				sent.push(structuredClone(context));
				if (context.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("done");
				const speak = getCurrentTools(context.messages).some((tool) => tool.name === MESSAGE_GROUP)
					? MESSAGE_GROUP
					: MESSAGE_USER;
				return fauxAssistantMessage([fauxToolCall(speak, { text: "ok" })], { stopReason: "toolUse" });
			}),
		);
		const firstOf = (marker: string, from: number) =>
			until(async () =>
				sent
					.slice(from)
					.find(
						(context) =>
							getCurrentSystemPrompt(context.messages).includes(marker) &&
							!context.messages.some((message) => message.role === "assistant"),
					),
			);
		const daemon = await startDaemon({ home, port: 0, models, log: () => {}, box: hostBox(home), web });
		try {
			const token = (await readDaemonFile(home))!.token!;
			const api = async <T>(path: string, body: object, method = "POST"): Promise<T> => {
				const response = await fetch(`http://127.0.0.1:${daemon.port}/api${path}`, {
					method,
					headers: { authorization: `Bearer ${token}` },
					body: JSON.stringify(body),
				});
				if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
				return (await response.json()) as T;
			};
			await until(async () => existsSync(join(home, "workspace", "agents", "sancho.md")));
			const measured = {} as Record<Variant, Budget>;

			// the lead's first chat, alone in the band
			let from = sent.length;
			await api("/messages", { id: randomUUID(), text: "hello", thread: MAIN_THREAD });
			const lead = await firstOf("You are the owner's lead agent.", from);
			expect(getCurrentSystemPrompt(lead.messages)).toContain(
				"It is Wednesday, 7 January 2026, between 09:00 and 10:00 UTC (UTC).",
			);
			measured.lead = measure(lead, home);

			// another agent's first direct chat: its file names no tools, so it gets what every agent gets
			for (const [id, text] of [
				["helper", HELPER],
				["reviewer", REVIEWER],
			] as const)
				await api(`/agents/${id}`, { text, base: null }, "PUT");
			from = sent.length;
			await api("/messages", { id: randomUUID(), text: "hello", thread: randomUUID(), agent: "helper" });
			const helper = await firstOf("HELPER INSTRUCTIONS.", from);
			measured.helper = measure(helper, home);

			// a member's first run in a group, mentioned in its room
			const { room } = await api<{ room: number }>("/groups", { members: ["helper", "reviewer"] });
			from = sent.length;
			await api(`/groups/${room}/messages`, { key: randomUUID(), text: "Look it up", mentions: ["reviewer"] });
			const group = await firstOf("REVIEWER INSTRUCTIONS.", from);
			expect(getCurrentTools(group.messages).map((tool) => tool.name)).toContain(MESSAGE_GROUP);
			measured.group = measure(group, home);

			if (UPDATE) {
				if (process.env.CI !== undefined)
					throw new Error("BANDA_PROMPT_BUDGET=update rewrites the baseline: not under CI");
				await writeFile(BASELINE, `${JSON.stringify(measured, null, "\t")}\n`);
				throw new Error(
					"prompt-budget.json rewritten: read its git diff, rerun without BANDA_PROMPT_BUDGET, commit it",
				);
			}
			const baseline = JSON.parse(await readFile(BASELINE, "utf8")) as Record<Variant, Budget>;
			expect(
				measured,
				"a fresh chat's prompt or tools changed size: if on purpose, `npm run prompt:budget` and commit the new file",
			).toEqual(baseline);
		} finally {
			await daemon.close();
		}
	});
});
