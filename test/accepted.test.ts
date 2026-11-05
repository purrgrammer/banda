/**
 * The workspace's "before" files (DESIGN.md "The workspace"): an agent file the box writes is data until the owner
 * accepts the bytes they saw. Whatever the box writes, removes, and the owner accepts, declines or saves, in any order,
 * a chat starts from the accepted version alone: its instructions in the prompt, its tools offered. The core
 * of memory is one too, fact by fact: a fact the box wrote reaches no prompt until the owner accepted it.
 */
import { rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, type Context as ModelContext } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { type Box, openBox } from "../src/box/box.ts";
import { BOX_TOOLS, boxEnv, boxTools } from "../src/box/tools.ts";
import { parseAgent, shaOf } from "../src/core/agents.ts";
import { OWNER } from "../src/core/gateway.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore } from "../src/core/turn.ts";
import { accept, decline, save, type Workspace } from "../src/server/agents.ts";
import { BadRequest } from "../src/server/http.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { heedNudge, newestSaid } from "./fixtures/models.ts";
import { blobStore, FAUX_MODEL, FakeGateway, tempHome } from "./helpers.ts";
import { pbtRuns } from "./pbt.ts";

const boxes: Box[] = [];
afterAll(() => {
	for (const box of boxes) box.close();
});

/** An agent file: a marker only it holds as instructions, the tools it names; or one that does not parse. */
const fileOf = (marker: string, tools: readonly string[], malformed: boolean) =>
	malformed
		? `no frontmatter ${marker}\n`
		: `---\ndescription: a test agent\ntools: [${tools.join(", ")}]\n---\n${marker}\n`;

// mostly files that parse, so most runs reach a chat
const text = fc.record({
	tools: fc.subarray([...BOX_TOOLS]),
	malformed: fc.integer({ min: 0, max: 3 }).map((n) => n === 0),
});

type Op =
	| { op: "write"; tools: string[]; malformed: boolean }
	| { op: "remove" }
	| { op: "accept"; stale: boolean }
	| { op: "decline" }
	| { op: "save"; tools: string[]; malformed: boolean; stale: boolean }
	| { op: "start" };

const ops: fc.Arbitrary<Op[]> = fc.array(
	// the box writes and the owner accepts most, and chats start often, so the prompt is checked often
	fc.oneof(
		{ weight: 3, arbitrary: text.map((t) => ({ op: "write" as const, ...t })) },
		{ weight: 1, arbitrary: fc.constant({ op: "remove" as const }) },
		{ weight: 3, arbitrary: fc.boolean().map((stale) => ({ op: "accept" as const, stale })) },
		{ weight: 1, arbitrary: fc.constant({ op: "decline" as const }) },
		{
			weight: 2,
			arbitrary: fc
				.record({ t: text, stale: fc.boolean() })
				.map(({ t, stale }) => ({ op: "save" as const, ...t, stale })),
		},
		{ weight: 3, arbitrary: fc.constant({ op: "start" as const }) },
	),
	{ minLength: 1, maxLength: 12 },
);

async function open() {
	const home = await tempHome();
	const box = openBox(hostBox(home), () => {});
	boxes.push(box);
	await mkdir(join(box.workspace, "agents"), { recursive: true });
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const seen: { prompt: string; tools: string[] }[] = [];
	const respond = (request: ModelContext) => {
		seen.push({
			prompt: JSON.stringify([request.systemPrompt, request.messages.filter((m) => m.role === "system")]),
			tools: [
				...(request.tools ?? []).map((tool) => tool.name),
				...request.messages.flatMap((m) => (m.role === "system" ? (m.toolsAdded ?? []).map((tool) => tool.name) : [])),
			],
		});
		// it answers the owner with a reaction, so no run of it is left unanswered
		if (newestSaid(request.messages)?.role === "user") return heedNudge();
		return fauxAssistantMessage("noted");
	};
	faux.setResponses(Array.from({ length: 2000 }, () => respond as never));
	const core = defineCore({ blobs: blobStore(), gateway: () => new FakeGateway(), model: () => FAUX_MODEL });
	const registry = createRegistry();
	registry.install(core.extension);
	registry.install(boxTools({ workspace: box.workspace }));
	const harness = await openStore(home, { models, registry, env: boxEnv(box) });
	harness.resume();
	const workspace: Workspace = {
		env: () => box.env(),
		root: box.workspace,
		tools: () => [...BOX_TOOLS],
		known: () => true,
	};
	return { box, harness, core, workspace, seen };
}

/** Whether a call succeeded: a refusal is a thrown BadRequest, which the oracle predicts. */
async function succeeds(run: () => Promise<unknown>): Promise<boolean> {
	try {
		await run();
		return true;
	} catch (error) {
		if (!(error instanceof BadRequest)) throw error;
		return false;
	}
}

describe("before files", () => {
	it("a chat starts from the accepted agent file alone, whatever the box writes and the owner does", async () => {
		const s = await open();
		let run = 0;
		await fc.assert(
			fc.asyncProperty(ops, async (steps) => {
				// an agent of its own per run, so the runs share one box and store
				const name = `agent${++run}`;
				const path = join(s.box.workspace, "agents", `${name}.md`);
				let box: string | undefined;
				let accepted: string | undefined;
				const markers: string[] = [];
				const fresh = (tools: readonly string[], malformed: boolean) => {
					const marker = `mark-${name}-${markers.length}-x`;
					markers.push(marker);
					return fileOf(marker, tools, malformed);
				};
				const parses = (t: string) => "agent" in parseAgent(name, t, { tools: [...BOX_TOOLS] });
				for (const step of steps) {
					switch (step.op) {
						case "write":
							box = fresh(step.tools, step.malformed);
							writeFileSync(path, box);
							break;
						case "remove":
							box = undefined;
							rmSync(path, { force: true });
							break;
						case "accept": {
							// the owner accepts what they saw: the box's bytes now, or a version the box has since replaced
							const sha = box === undefined ? null : step.stale ? shaOf(`${box}stale`) : shaOf(box);
							const ok = await succeeds(() => accept(s.harness, s.workspace, name, sha, s.core.agentChanged));
							const expected = sha === null ? true : !step.stale && box !== undefined && parses(box);
							expect(ok).toBe(expected);
							if (ok) accepted = sha === null ? undefined : box;
							break;
						}
						case "decline":
							await decline(s.harness, s.workspace, name);
							box = accepted;
							break;
						case "save": {
							const written = fresh(step.tools, step.malformed);
							const base = step.stale ? shaOf("stale") : accepted === undefined ? null : shaOf(accepted);
							const ok = await succeeds(() => save(s.harness, s.workspace, name, written, base, s.core.agentChanged));
							const boxSha = box === undefined ? null : shaOf(box);
							const acceptedSha = accepted === undefined ? null : shaOf(accepted);
							// base null is a new agent: refused only when one is already accepted, and otherwise supersedes an
							// unaccepted proposal the box wrote; base set must still match both the accepted and the box bytes
							const allowed = base === null ? accepted === undefined : acceptedSha === base && boxSha === base;
							expect(ok).toBe(parses(written) && allowed);
							if (ok) box = accepted = written;
							break;
						}
						case "start": {
							const before = s.seen.length;
							const got = await s.core.receive(s.harness, {
								id: crypto.randomUUID(),
								origin: { gateway: "fake", peer: OWNER, thread: crypto.randomUUID() },
								text: "hello",
								agent: name,
							});
							if (accepted === undefined || !parses(accepted)) {
								expect(got).toEqual({ refused: `there is no agent named ${name}` });
								break;
							}
							if (!("turn" in got)) throw new Error(JSON.stringify(got));
							await s.harness.waitForTask(got.turn as never, context);
							const request = s.seen[before];
							if (request === undefined) throw new Error("the model was never asked");
							const agent = parseAgent(name, accepted);
							if (!("agent" in agent)) throw new Error("unreachable");
							for (const marker of markers)
								expect(request.prompt.includes(marker), marker).toBe(accepted.includes(marker));
							const offered = request.tools.filter((tool) => (BOX_TOOLS as readonly string[]).includes(tool));
							expect(new Set(offered)).toEqual(new Set(agent.agent.tools));
							break;
						}
					}
				}
			}),
			{ numRuns: pbtRuns(25) },
		);
	}, 600_000);
});
