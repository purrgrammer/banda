import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { describe, expect, it, onTestFinished } from "vitest";
import {
	answerAsk,
	applyUpdate,
	compacted,
	connectHarness,
	defineHarnesses,
	diffOf,
	disconnectHarness,
	folderPath,
	Harnesses,
	type HarnessStep,
	projectOf,
	shownPath,
	steer,
	stopSession,
	switchHarness,
} from "../src/core/harness.ts";
import { OWN_ASKS, parseHarness, resolveHarness, shippedHarnesses, words } from "../src/core/harness-files.ts";
import { context, openStore } from "../src/core/store.ts";
import { echoModels } from "./fixtures/models.ts";
import { tempHome, until } from "./helpers.ts";

describe("diffOf", () => {
	it("counts the lines between the common start and end", () => {
		const before = "a\nif (x < Date.now()) {\n  go();\n}";
		const after = "a\nconst now = Math.floor(Date.now() / 1000);\nif (x < now) {\n  go();\n}";
		expect(diffOf(before, after)).toEqual({
			added: 2,
			removed: 1,
			diff: "-if (x < Date.now()) {\n+const now = Math.floor(Date.now() / 1000);\n+if (x < now) {",
		});
		expect(diffOf("", "one\ntwo")).toMatchObject({ added: 2, removed: 0 });
	});
});

describe("folderPath", () => {
	it("takes an absolute folder or one under the home, never / or a relative path", () => {
		expect(folderPath("~/sancho")).toBe(join(homedir(), "sancho"));
		expect(folderPath("~")).toBe(homedir());
		expect(folderPath(dirname(homedir()))).toBeUndefined();
		expect(folderPath("/")).toBeUndefined();
		expect(folderPath("code/x")).toBeUndefined();
	});
});

describe("applyUpdate", () => {
	it("follows a call from pending to done, and gathers words", () => {
		const steps: HarnessStep[] = [];
		// as claude-agent-acp sends them (spike, 2026-11-05)
		applyUpdate(steps, {
			sessionUpdate: "tool_call",
			toolCallId: "t1",
			title: "Terminal",
			kind: "execute",
			status: "pending",
			rawInput: {},
		});
		applyUpdate(steps, { sessionUpdate: "tool_call_update", toolCallId: "t1", rawInput: { command: "npm test" } });
		applyUpdate(steps, {
			sessionUpdate: "tool_call_update",
			toolCallId: "t1",
			status: "completed",
			content: [{ type: "content", content: { type: "text", text: "6 passed" } }],
		});
		applyUpdate(steps, {
			sessionUpdate: "tool_call",
			toolCallId: "t2",
			title: "Write",
			kind: "edit",
			status: "pending",
			rawInput: { file_path: "/w/hello.txt" },
			content: [{ type: "diff", path: "/w/hello.txt", oldText: null, newText: "banda" }],
		});
		// as codex-acp sends one: the file only in its diff
		applyUpdate(steps, {
			sessionUpdate: "tool_call",
			toolCallId: "t3",
			title: "Editing files",
			kind: "edit",
			status: "completed",
			content: [{ type: "diff", path: "/w/auth.js", oldText: "a", newText: "b" }],
		});
		applyUpdate(steps, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "do" } });
		applyUpdate(steps, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ne" } });
		expect(steps).toEqual([
			{ kind: "run", command: "npm test", output: "6 passed", running: false, call: "t1" },
			{ kind: "edit", path: "/w/hello.txt", added: 1, removed: 0, diff: "+banda", call: "t2" },
			{ kind: "edit", path: "/w/auth.js", added: 1, removed: 1, diff: "-a\n+b", call: "t3" },
			{ kind: "said", text: "done" },
		]);
	});
});

describe("a harness session", () => {
	const FAKE = join(import.meta.dirname, "fixtures/fake-acp-agent.ts");

	async function setup(definition: { args?: string[]; env?: string } = {}) {
		const home = await tempHome();
		const folder = await mkdtemp(join(homedir(), ".banda-test-folder-"));
		onTestFinished(() => rm(folder, { recursive: true, force: true }));
		const woke: { chat: number; key: string; text: string; state: unknown }[] = [];
		const made = defineHarnesses({
			definitions: () =>
				new Map([
					[
						"fake",
						{
							name: "fake",
							service: "Fake Code",
							command: process.execPath,
							args: definition.args ?? [FAKE],
							mode: "acceptEdits",
						},
					],
				]),
			followUp: async (_tx, chat, input) => {
				woke.push({ chat, key: input.key, text: input.text, state: input.entry.data.state });
				return 0;
			},
			log: () => {},
			openMs: 500,
		});
		const registry = createRegistry();
		registry.install(defineExtension({ name: "test.harness", tasks: [made.Session] }));
		const { models } = echoModels();
		const harness = await openStore(home, { models, registry });
		harness.resume();
		const chat = await harness.commit(
			async (tx) => Number((await tx.createConversation({ ownership: { kind: "ownerless" } })).id),
			context,
		);
		const session = async () => (await harness.snapshot(Harnesses, context))?.sessions ?? {};
		return { harness, made, chat, folder, woke, session };
	}

	it("runs the ask once, answers its ask from the owner, takes a note, and wakes the agent at the end", async () => {
		const s = await setup();
		const task = await s.harness.commit(
			(tx) =>
				s.made.begin(tx, {
					chat: s.chat,
					call: "c1",
					agent: "sancho",
					harness: "fake",
					folder: s.folder,
					ask: "edit src/a.ts +2 -1\nask npm test\nsay fixed",
				}),
			context,
		);
		await until(async () => (await s.session())[task]?.asks?.[0]);
		const asking = (await s.session())[task]?.asks?.[0];
		expect(asking?.command).toBe("npm test");
		await s.harness.commit(async (tx) => {
			await steer(tx, task, "say also the changelog", Date.now());
			await answerAsk(tx, task, asking?.id ?? "", true);
		}, context);
		await until(() => s.woke.length > 0);
		const ended = (await s.session())[task];
		expect(ended?.state).toBe("done");
		expect(ended?.call).toBe("c1");
		expect(ended?.steps.map((step) => step.kind)).toEqual(["asked", "edit", "run", "steered", "said"]);
		expect(s.woke).toEqual([expect.objectContaining({ chat: s.chat, key: `harness:${task}`, state: "done" })]);
		await s.harness.close(context);
	});

	it("says why it failed: a harness that dies at once, one that never opens a session", async () => {
		const dies = await setup({ args: ["-e", "console.error('not signed in: run claude login'); process.exit(3)"] });
		const one = await dies.harness.commit(
			(tx) => dies.made.begin(tx, { chat: dies.chat, agent: "sancho", harness: "fake", folder: dies.folder, ask: "x" }),
			context,
		);
		await until(() => dies.woke.length > 0);
		expect((await dies.session())[one]).toMatchObject({
			state: "failed",
			outcome: expect.stringMatching(/exited|not signed in/),
		});
		await dies.harness.close(context);
		process.env.FAKE_ACP_HANG = "1";
		try {
			const hangs = await setup();
			const two = await hangs.harness.commit(
				(tx) =>
					hangs.made.begin(tx, { chat: hangs.chat, agent: "sancho", harness: "fake", folder: hangs.folder, ask: "x" }),
				context,
			);
			await until(() => hangs.woke.length > 0);
			expect((await hangs.session())[two]).toMatchObject({
				state: "failed",
				outcome: "it did not start a session in time",
			});
			expect(hangs.woke[0]?.text).toContain("could not start (it did not start a session in time)");
			await hangs.harness.close(context);
		} finally {
			delete process.env.FAKE_ACP_HANG;
		}
	});

	it("shows two asks at once and takes an answer to each", async () => {
		const s = await setup();
		const task = await s.harness.commit(
			(tx) =>
				s.made.begin(tx, { chat: s.chat, agent: "sancho", harness: "fake", folder: s.folder, ask: "asks2 lint test" }),
			context,
		);
		await until(async () => ((await s.session())[task]?.asks?.length ?? 0) === 2);
		const asks = (await s.session())[task]?.asks ?? [];
		expect(asks.map((ask) => ask.command)).toEqual(["lint", "test"]);
		await s.harness.commit(async (tx) => {
			await answerAsk(tx, task, asks[1]?.id ?? "", false);
			await answerAsk(tx, task, asks[0]?.id ?? "", true);
		}, context);
		await until(() => s.woke.length > 0);
		expect((await s.session())[task]?.state).toBe("done");
		await s.harness.close(context);
	});

	it("stops before its session opens: the ask is never sent", async () => {
		process.env.FAKE_ACP_HANG = "1";
		try {
			const s = await setup();
			const task = await s.harness.commit(
				(tx) => s.made.begin(tx, { chat: s.chat, agent: "sancho", harness: "fake", folder: s.folder, ask: "say hi" }),
				context,
			);
			await new Promise((resolve) => setTimeout(resolve, 100));
			await s.harness.commit((tx) => stopSession(tx, task), context);
			await until(() => s.woke.length > 0);
			expect((await s.session())[task]).toMatchObject({ state: "stopped" });
			expect((await s.session())[task]?.prompted).toBeUndefined();
			await s.harness.close(context);
		} finally {
			delete process.env.FAKE_ACP_HANG;
		}
	});

	it("never sends the ask again after a restart past it: the session is interrupted", async () => {
		const s = await setup();
		const task = await s.harness.commit(async (tx) => {
			const id = await s.made.begin(tx, {
				chat: s.chat,
				agent: "sancho",
				harness: "fake",
				folder: s.folder,
				ask: "say hi",
			});
			(await tx.doc(Harnesses)).sessions[id]!.prompted = true;
			return id;
		}, context);
		await until(() => s.woke.length > 0);
		expect((await s.session())[task]?.state).toBe("interrupted");
		await s.harness.close(context);
	});
});

describe("a harness's account", () => {
	it("keeps its agents across a new folder, switches one off, and a disconnect stops what runs", async () => {
		const home = await tempHome();
		const registry = createRegistry();
		const { models } = echoModels();
		const harness = await openStore(home, { models, registry });
		const doc = () => harness.commit((tx) => tx.doc(Harnesses).then((d) => JSON.parse(JSON.stringify(d))), context);
		await harness.commit(async (tx) => {
			await connectHarness(tx, "fake", "~/a", "sancho");
			await connectHarness(tx, "fake", "~/b", "mara");
		}, context);
		expect((await doc()).accounts.fake).toEqual({ folder: "~/b", agents: ["sancho", "mara"] });
		await harness.commit((tx) => switchHarness(tx, "fake", "sancho", false), context);
		expect((await doc()).accounts.fake.agents).toEqual(["mara"]);
		await harness.commit(async (tx) => {
			(await tx.doc(Harnesses)).sessions[7] = {
				chat: 1,
				agent: "mara",
				harness: "fake",
				folder: "~/b",
				prompt: "x",
				state: "working",
				at: 0,
				steps: [],
				dropped: 0,
				notes: [],
			};
		}, context);
		expect(await harness.commit((tx) => disconnectHarness(tx, "fake"), context)).toEqual(["mara"]);
		expect((await doc()).accounts.fake).toBeUndefined();
		expect((await doc()).sessions[7].stop).toBe(true);
		await harness.close(context);
	});
});

describe("harness files", () => {
	it("parse a bundled package or a command, with its mode and what it asks", () => {
		const claude = parseHarness(
			"claude-code",
			"---\nservice: Claude Code\npackage: @agentclientprotocol/claude-agent-acp\nbin: dist/index.js\nmode: acceptEdits\nasks: Edits run.\n---\nAnthropic's.",
		);
		expect(claude).toEqual({
			harness: {
				name: "claude-code",
				service: "Claude Code",
				about: "Anthropic's.",
				asks: "Edits run.",
				mode: "acceptEdits",
				start: { package: "@agentclientprotocol/claude-agent-acp", bin: "dist/index.js" },
			},
		});
		const goose = parseHarness("goose", "---\nservice: Goose\ncommand: goose\nargs: acp\n---\n");
		expect(goose).toMatchObject({ harness: { start: { command: "goose", args: ["acp"] }, asks: OWN_ASKS } });
		expect(parseHarness("nobin", "---\nservice: X\npackage: y\n---\n")).toHaveProperty("errors");
		expect(parseHarness("neither", "---\nservice: X\n---\n")).toHaveProperty("errors");
	});

	it("offer only what is installed: the bundled Claude Code is, a made-up command is not", () => {
		const shipped = shippedHarnesses(join(import.meta.dirname, "../shipped/harnesses"), () => {});
		expect(shipped.map((file) => file.name)).toContain("claude-code");
		const claude = shipped.find((file) => file.name === "claude-code");
		expect(claude && resolveHarness(claude)?.command).toBe(process.execPath);
		expect(
			resolveHarness({
				name: "x",
				service: "X",
				about: "",
				asks: OWN_ASKS,
				start: { command: "no-such-harness-cmd", args: [] },
			}),
		).toBeUndefined();
		expect(words(`"my agent" --acp 'two words'`)).toEqual(["my agent", "--acp", "two words"]);
	});
});

describe("a session's project", () => {
	it("is the root, or a git repository inside it; never outside, hidden, or not a repository", async () => {
		const root = await mkdtemp(join(homedir(), ".banda-test-root-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const { mkdir, symlink } = await import("node:fs/promises");
		await mkdir(join(root, "app/.git"), { recursive: true });
		await mkdir(join(root, "work/api/.git"), { recursive: true });
		await mkdir(join(root, "notes"), { recursive: true });
		await mkdir(join(root, ".secret/.git"), { recursive: true });
		await symlink(homedir(), join(root, "escape"));
		const shown = shownPath(root);
		// a folder of projects is never one to work across
		expect(projectOf(shown, undefined)).toMatchObject({ projects: ["app", "work/api"] });
		expect(projectOf(`${shown}/app`, undefined)).toEqual({ folder: `${shown}/app` });
		expect(projectOf(shown, "app")).toEqual({ folder: `${shown}/app` });
		expect(projectOf(shown, "work/api/")).toEqual({ folder: `${shown}/work/api` });
		for (const bad of ["../x", "/etc", "~/x", ".secret", "escape", "notes", "missing"])
			expect(projectOf(shown, bad), bad).toMatchObject({ projects: ["app", "work/api"] });
	});
});

describe("an ended session's steps", () => {
	it("keep the ask, every edit, the notes and the last words first, within the bound, the rest counted", () => {
		const steps: HarnessStep[] = [
			{ kind: "asked", text: "fix it" },
			...Array.from({ length: 60 }, (_, i): HarnessStep => ({ kind: "read", path: `f${i}` })),
			{ kind: "edit", path: "a.ts", added: 1, removed: 0, diff: "x".repeat(5000) },
			{ kind: "steered", text: "only a.ts", taken: true },
			...Array.from({ length: 30 }, (_, i): HarnessStep => ({ kind: "run", command: `c${i}`, running: false })),
			{ kind: "said", text: "done" },
		];
		const { steps: kept, dropped } = compacted(steps);
		expect(kept).toHaveLength(40);
		expect(dropped).toBe(steps.length - 40);
		expect(kept[0]).toEqual({ kind: "asked", text: "fix it" });
		expect(kept.some((step) => step.kind === "steered")).toBe(true);
		expect(kept.at(-1)).toEqual({ kind: "said", text: "done" });
		const edit = kept.find((step) => step.kind === "edit");
		expect(edit?.kind === "edit" && edit.diff?.length).toBeLessThan(1100);
		expect(compacted(steps.slice(0, 5)).dropped).toBe(0);
	});
});
