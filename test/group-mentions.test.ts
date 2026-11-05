/**
 * Agents asking each other in a group (DESIGN.md "Groups"): a member's `message_group` names others in `ask`, and each
 * starts a turn of its own. The chain is bounded in structure, whatever the agents choose: never deeper than
 * `MAX_DEPTH` from the owner's message, never more than `MAX_CHAIN` turns of agents' asks from it, never oneself, never
 * anyone outside the group (its schema offers only the other members' names). Generated graphs of who asks whom always
 * settle within those bounds.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Context as ModelContext,
} from "@earendil-works/pi-ai";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_CHAIN, MAX_DEPTH } from "../src/core/groups.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { GroupView } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { tempHome, until } from "./helpers.ts";
import { pbtRuns } from "./pbt.ts";

const AGENTS = ["ana", "bo", "cy", "di"] as const;

const textOf = (content: unknown) =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((part: { text?: string }) => part.text ?? "").join("")
			: "";

/** A daemon with `members` as agents, each asking `asks[agent]` whenever it is asked; what it saw. */
async function openRoom(
	members: readonly string[],
	asks: { readonly [agent: string]: readonly string[] },
	/** How an agent asks: in `ask` (the default), or with an @ in its words alone. */
	style: "field" | "words" = "field",
) {
	const home = await tempHome();
	await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
	const web = join(home, "web");
	await mkdir(web, { recursive: true });
	await writeFile(join(web, "index.html"), "<!doctype html><title>banda</title>");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const turns: string[] = [];
	const refusals: string[] = [];
	const respond = (ctx: ModelContext) => {
		const prompt = JSON.stringify(ctx.messages.filter((m) => m.role === "system"));
		const agent = members.find((each) => prompt.includes(`${each.toUpperCase()} INSTRUCTIONS`)) ?? "lead";
		const last = ctx.messages.filter((m) => m.role !== "system").at(-1);
		if (last?.role === "toolResult") {
			const said = textOf(last.content);
			// a call outside its schema never runs; one within it always posts, and the result says who was not asked
			if (last.isError || said.startsWith("Posted to the group;")) refusals.push(`${agent}: ${said}`);
			return fauxAssistantMessage("done");
		}
		turns.push(agent);
		const asked = asks[agent] ?? [];
		const text =
			style === "words" && asked.length > 0
				? `${asked.map((one) => `@${one[0]?.toUpperCase()}${one.slice(1)}`).join(" ")} over to you`
				: `${agent} here`;
		return fauxAssistantMessage(
			[
				fauxToolCall("message_group", {
					text,
					...(asked.length === 0 || style === "words" ? {} : { ask: asked }),
				}),
			],
			{ stopReason: "toolUse" },
		);
	};
	faux.setResponses(Array.from({ length: 400 }, () => respond as never));
	const daemon = await startDaemon({ home, port: 0, models, log: () => {}, box: hostBox(home), web });
	const token = (await readDaemonFile(home))!.token!;
	const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
		const response = await fetch(`http://127.0.0.1:${daemon.port}/api${path}`, {
			...init,
			headers: { authorization: `Bearer ${token}`, ...init.headers },
		});
		if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
		return (await response.json()) as T;
	};
	await until(async () => existsSync(join(home, "workspace", "agents", "sancho.md")));
	for (const id of members) {
		const text = `---\nname: ${id}\ndescription: ${id}\ntools: [read]\n---\n${id.toUpperCase()} INSTRUCTIONS.\n`;
		await api(`/agents/${id}`, { method: "PUT", body: JSON.stringify({ text, base: null }) });
	}
	const { room } = await api<{ room: number }>("/groups", { method: "POST", body: JSON.stringify({ members }) });
	return { daemon, api, room, turns, refusals };
}

/** Wait until the room is quiet: nobody works, and it stays so a while. */
async function quiet(api: <T>(path: string) => Promise<T>, room: number) {
	let still = 0;
	await until(async () => {
		const view = await api<GroupView>(`/groups/${room}`);
		still = view.working.length === 0 ? still + 1 : 0;
		return still >= 5 ? view : undefined;
	}, 100);
}

describe("agents asking each other in a group", () => {
	it("a ring of agents asking the next stops at its depth, and the refusal says why", async () => {
		const members = ["ana", "bo", "cy", "di"];
		const ring = { ana: ["bo"], bo: ["cy"], cy: ["di"], di: ["ana"] };
		const { daemon, api, room, turns, refusals } = await openRoom(members, ring);
		try {
			await api(`/groups/${room}/messages`, {
				method: "POST",
				body: JSON.stringify({ key: randomUUID(), text: "go", mentions: ["ana"] }),
			});
			await quiet(api, room);
			// the owner's message asks ana (1); ana's reply asks bo, bo's asks cy; cy's would be deeper than allowed
			expect(turns).toEqual(["ana", "bo", "cy"]);
			expect(refusals).toEqual([
				expect.stringMatching(
					new RegExp(`^cy: Posted to the group; nobody was asked: agents have asked each other ${MAX_DEPTH} deep`),
				),
			]);
		} finally {
			await daemon.close();
		}
	}, 60_000);

	it("an agent naming another with an @ in its words asks it, though it filled no ask", async () => {
		const { daemon, api, room, turns } = await openRoom(["ana", "bo"], { ana: ["bo"] }, "words");
		try {
			await api(`/groups/${room}/messages`, {
				method: "POST",
				body: JSON.stringify({ key: randomUUID(), text: "go", mentions: ["ana"] }),
			});
			await quiet(api, room);
			expect(turns).toEqual(["ana", "bo"]);
			const said = (await api<GroupView>(`/groups/${room}`)).messages.find((m) => m.text.startsWith("@Bo"));
			expect(said?.mentions).toEqual(["bo"]);
		} finally {
			await daemon.close();
		}
	}, 30_000);

	it("a name outside the group, or a spelling of one its schema does not offer, never runs: nothing is posted", async () => {
		for (const named of [["Zed"], ["@bo"], ["bo", "Zed"]]) {
			const { daemon, api, room, turns, refusals } = await openRoom(["ana", "bo"], { ana: named });
			try {
				await api(`/groups/${room}/messages`, {
					method: "POST",
					body: JSON.stringify({ key: randomUUID(), text: "go", mentions: ["ana"] }),
				});
				await quiet(api, room);
				// the owner asked ana and nothing posted, so it is nudged once, and refused again: the room says so
				expect(turns).toEqual(["ana", "ana"]);
				expect(refusals).toEqual([
					expect.stringMatching(/^ana: [\s\S]*Validation failed[\s\S]*ask/),
					expect.stringMatching(/^ana: [\s\S]*Validation failed[\s\S]*ask/),
				]);
				const view = await api<GroupView>(`/groups/${room}`);
				expect(view.messages.map((m) => m.text)).toEqual(["go"]);
				expect(view.notices).toMatchObject([{ agent: "ana", unanswered: true }]);
			} finally {
				await daemon.close();
			}
		}
	}, 60_000);

	it("an agent cannot ask itself: its own name is not offered", async () => {
		const { daemon, api, room, turns, refusals } = await openRoom(["ana", "bo"], { ana: ["ana"] });
		try {
			await api(`/groups/${room}/messages`, {
				method: "POST",
				body: JSON.stringify({ key: randomUUID(), text: "go", mentions: ["ana"] }),
			});
			await quiet(api, room);
			// nothing posted for the owner's message: nudged once, refused again
			expect(turns).toEqual(["ana", "ana"]);
			expect(refusals).toEqual([
				expect.stringMatching(/^ana: [\s\S]*Validation failed[\s\S]*ask/),
				expect.stringMatching(/^ana: [\s\S]*Validation failed[\s\S]*ask/),
			]);
		} finally {
			await daemon.close();
		}
	}, 30_000);

	it("whoever asks whom, a chain settles within its depth and its turns", async () => {
		const graph = fc.integer({ min: 2, max: 4 }).chain((size) => {
			const members = AGENTS.slice(0, size);
			return fc.record({
				members: fc.constant(members),
				asks: fc.record(
					Object.fromEntries(
						members.map((agent) => [agent, fc.subarray(members.filter((other) => other !== agent))]),
					) as { [agent: string]: fc.Arbitrary<string[]> },
				),
				first: fc.subarray([...members], { minLength: 1 }),
			});
		});
		await fc.assert(
			fc.asyncProperty(graph, async ({ members, asks, first }) => {
				const { daemon, api, room: id, turns } = await openRoom(members, asks);
				try {
					await api(`/groups/${id}/messages`, {
						method: "POST",
						body: JSON.stringify({ key: randomUUID(), text: "go", mentions: first }),
					});
					await quiet(api, id);
					// the owner's mentions, then at most MAX_CHAIN started by agents' asks
					expect(turns.length).toBeLessThanOrEqual(first.length + MAX_CHAIN);
					// each agent asked at least once ran
					for (const agent of first) expect(turns).toContain(agent);
				} finally {
					await daemon.close();
				}
			}),
			{ numRuns: pbtRuns(4) },
		);
	}, 300_000);
});
