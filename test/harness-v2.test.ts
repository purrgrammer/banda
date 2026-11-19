/**
 * Harness sessions over ACP v2, against the fake agent in its v2 mode (test/fixtures/fake-acp-agent.ts, FAKE_ACP_V2):
 * the orders claude-agent-acp 0.100.0 and codex-acp 2.5.0 send, read in their source, not a model's real run. Its
 * background work is timers inside the fake, so nothing here starts a process that could outlive it.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { answerAsk, defineHarnesses, Harnesses, steer, stopSession } from "../src/core/harness.ts";
import { context, openStore } from "../src/core/store.ts";
import { echoModels } from "./fixtures/models.ts";
import { tempHome, until } from "./helpers.ts";

const FAKE = join(import.meta.dirname, "fixtures/fake-acp-agent.ts");

type Logged = { [field: string]: unknown };

async function setup(env: { [name: string]: string }, { stopMs }: { stopMs?: number } = {}) {
	const home = await tempHome();
	const folder = await mkdtemp(join(homedir(), ".banda-test-folder-"));
	onTestFinished(() => rm(folder, { recursive: true, force: true }));
	const log = join(folder, "requests.jsonl");
	vi.stubEnv("FAKE_ACP_LOG", log);
	for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
	onTestFinished(() => {
		vi.unstubAllEnvs();
	});
	const woke: { text: string; state: unknown }[] = [];
	const made = defineHarnesses({
		home,
		definitions: () =>
			new Map([
				["fake", { name: "fake", service: "Fake Code", command: process.execPath, args: [FAKE], mode: "acceptEdits" }],
			]),
		followUp: async (_tx, _chat, input) => {
			woke.push({ text: input.text, state: input.entry.data.state });
			return 0;
		},
		log: () => {},
		openMs: 20_000,
		...(stopMs === undefined ? {} : { stopMs }),
	});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "test.harness-v2", tasks: [made.Session] }));
	const harness = await openStore(home, { models: echoModels().models, registry });
	harness.resume();
	onTestFinished(() => harness.close(context));
	const chat = await harness.commit(
		async (tx) => Number((await tx.createConversation({ ownership: { kind: "ownerless" } })).id),
		context,
	);
	const sessions = async () => (await harness.snapshot(Harnesses, context))?.sessions ?? {};
	const logged = async (): Promise<Logged[]> =>
		(await readFile(log, "utf8").catch(() => ""))
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as Logged);
	const begin = (ask: string) =>
		harness.commit((tx) => made.begin(tx, { chat, agent: "sancho", harness: "fake", folder, ask }), context);
	const result = (text: string | undefined) =>
		JSON.parse(/<harness-result[^>]*>\n(.*)\n<\/harness-result>/s.exec(text ?? "")?.[1] ?? "{}");
	return { harness, sessions, logged, begin, woke, result };
}

describe("a harness session over ACP v2", () => {
	it("outlives a turn that ended while its background command runs, then ends done once the list is empty", async () => {
		const s = await setup({ FAKE_ACP_V2: "1" });
		const task = await s.begin("bg 1500\nsay started it");
		// its turn ended, its command runs on: still live, recorded as working in the background
		const during = await until(async () => {
			const one = (await s.sessions())[task];
			return one?.background?.foreground === "idle" && one.background.items.length === 1 ? one : undefined;
		});
		expect(during.state).toBe("working");
		expect(during.ended).toBeUndefined();
		expect((await s.logged()).some((entry) => entry.ended === "end_turn")).toBe(true);
		expect(s.woke).toEqual([]);
		await until(() => s.woke.length === 1);
		const ended = (await s.sessions())[task];
		expect(ended?.state).toBe("done");
		// the command was never cancelled: it ran to its own end
		const log = await s.logged();
		expect(log.find((entry) => entry.backgroundEnded !== undefined)).toMatchObject({ status: "completed" });
		expect(log.some((entry) => entry.cancelItem !== undefined)).toBe(false);
		expect(log.find((entry) => entry.mode !== undefined)).toEqual(expect.objectContaining({ mode: "acceptEdits" }));
		expect(s.result(s.woke[0]?.text).background).toEqual({
			reported: true,
			stopped: [],
			ended: [{ type: "terminal", status: "exited" }],
		});
	});

	it("Stop cancels the background work too, not only the turn, and ends without waiting out its clock", async () => {
		const s = await setup({ FAKE_ACP_V2: "1" }, { stopMs: 20_000 });
		const task = await s.begin("bg 600000\nmonitor 600000\nsay watching");
		await until(async () => {
			const one = (await s.sessions())[task];
			return one?.background?.foreground === "idle" && one.background.items.length === 2;
		});
		const asked = Date.now();
		await s.harness.commit((tx) => stopSession(tx, task), context);
		await until(() => s.woke.length === 1);
		expect(Date.now() - asked).toBeLessThan(15_000);
		expect((await s.sessions())[task]?.state).toBe("stopped");
		const cancelled = (await s.logged()).filter((entry) => entry.cancelItem !== undefined);
		expect(cancelled.map((entry) => entry.listed)).toEqual([true, true]);
	});

	it("a note sent mid-turn is taken in after it, and the session ends only after its turn too", async () => {
		const s = await setup({ FAKE_ACP_V2: "1" });
		const task = await s.begin("sleep 400\nsay first");
		await until(async () => (await s.sessions())[task]?.state === "working");
		await s.harness.commit((tx) => steer(tx, task, "say second", Date.now()), context);
		await until(() => s.woke.length === 1);
		const log = await s.logged();
		expect(log.filter((entry) => entry.ended === "end_turn")).toHaveLength(2);
		expect((await s.sessions())[task]?.state).toBe("done");
		// both turns' words: the note's turn ran before the end
		expect(log.filter((entry) => entry.prompt !== undefined).map((entry) => entry.prompt)).toEqual([
			"sleep 400\nsay first",
			"say second",
		]);
		expect(s.result(s.woke[0]?.text).said).toMatch(/second$/);
	});

	it("an ask from background work while its turn is idle holds the session open until the owner answers", async () => {
		const s = await setup({ FAKE_ACP_V2: "1" });
		const task = await s.begin("bgask 300 npm run deploy\nsay waiting on it");
		const ask = await until(async () => (await s.sessions())[task]?.asks?.[0]);
		expect(ask.command).toBe("npm run deploy");
		expect((await s.logged()).some((entry) => entry.ended === "end_turn")).toBe(true);
		expect(s.woke).toEqual([]);
		await s.harness.commit((tx) => answerAsk(tx, task, ask.id, false), context);
		await until(() => s.woke.length === 1);
		expect((await s.sessions())[task]?.state).toBe("done");
		expect((await s.logged()).find((entry) => entry.background === true)).toMatchObject({
			answer: { outcome: "selected", optionId: "reject" },
		});
	});

	it("an ask the harness withdraws is gone from the owner, and the session ends without an answer", async () => {
		const s = await setup({ FAKE_ACP_V2: "1" });
		const task = await s.begin("withdraw 600 git push\nsay gave up");
		await until(async () => (await s.sessions())[task]?.asks?.[0]);
		await until(() => s.woke.length === 1);
		const ended = (await s.sessions())[task];
		expect(ended?.state).toBe("done");
		expect(ended?.asks ?? []).toEqual([]);
		expect((await s.logged()).some((entry) => entry.withdrew === "git push")).toBe(true);
	});

	it("Stop with work that has no cancel of its own closes the session at once, not at its clock", async () => {
		const s = await setup({ FAKE_ACP_V2: "1" }, { stopMs: 20_000 });
		const task = await s.begin("task 600000\nsay waiting");
		await until(async () => {
			const one = (await s.sessions())[task];
			return one?.background?.foreground === "idle" && one.background.running === 1;
		});
		const asked = Date.now();
		await s.harness.commit((tx) => stopSession(tx, task), context);
		await until(() => s.woke.length === 1);
		expect(Date.now() - asked).toBeLessThan(15_000);
		expect((await s.sessions())[task]?.state).toBe("stopped");
		expect((await s.logged()).some((entry) => entry.closed !== undefined)).toBe(true);
	});

	/**
	 * Claude Code's own follow-up on a finished background command (the run its task notification starts) must reach
	 * the session before it ends done. In claude-agent-acp 0.100.0's order the list empties under `idle` first and the
	 * follow-up's `running` comes only with the model's first output, so the session ends before it: this fails today
	 * (`it.fails`), and passes once the order is fixed. The proposed adapter order (next test) passes with banda as is.
	 */
	it.fails("keeps a done session open for Claude Code's follow-up on its background command (0.100.0's order)", async () => {
		const s = await setup({ FAKE_ACP_V2: "1", FAKE_ACP_FOLLOW_MS: "1500" });
		const task = await s.begin("bgfollow 300 the tests passed, committing\nsay started the tests");
		await until(() => s.woke.length === 1);
		expect((await s.sessions())[task]?.state).toBe("done");
		expect(s.result(s.woke[0]?.text).said).toContain("the tests passed, committing");
	});

	it("today ends done before that follow-up, its words never reaching the wake: the defect, pinned", async () => {
		const s = await setup({ FAKE_ACP_V2: "1", FAKE_ACP_FOLLOW_MS: "1500" });
		const task = await s.begin("bgfollow 300 the tests passed, committing\nsay started the tests");
		await until(() => s.woke.length === 1);
		expect((await s.sessions())[task]?.state).toBe("done");
		expect(s.result(s.woke[0]?.text).said).toBe("started the tests");
		expect((await s.logged()).some((entry) => entry.backgroundEnded !== undefined)).toBe(true);
		expect((await s.logged()).some((entry) => entry.followedUp !== undefined)).toBe(false);
	});

	it("keeps it open when the adapter opens the follow-up's run before the list drops the command", async () => {
		const s = await setup({ FAKE_ACP_V2: "1", FAKE_ACP_FOLLOWUP: "atomic", FAKE_ACP_FOLLOW_MS: "1500" });
		const task = await s.begin("bgfollow 300 the tests passed, committing\nsay started the tests");
		await until(() => s.woke.length === 1);
		expect((await s.sessions())[task]?.state).toBe("done");
		expect(s.result(s.woke[0]?.text).said).toContain("the tests passed, committing");
		expect((await s.logged()).some((entry) => entry.followedUp !== undefined)).toBe(true);
	});

	it("an agent that never reports background work ends closed with its turn, never done, and says so", async () => {
		const s = await setup({ FAKE_ACP_V2: "unreported" });
		const task = await s.begin("say all done");
		await until(() => s.woke.length === 1);
		const ended = (await s.sessions())[task];
		expect(ended?.state).toBe("closed");
		expect(ended?.background?.reported).toBe(false);
		expect(s.woke[0]?.state).toBe("closed");
		expect(s.woke[0]?.text).toContain("whether everything it started had finished is not known");
	});

	it("a v2 agent that does not offer the mode banda sets is stopped before anything is sent", async () => {
		const s = await setup({ FAKE_ACP_V2: "1", FAKE_ACP_NO_MODE: "1" });
		const task = await s.begin("say hi");
		await until(() => s.woke.length === 1);
		expect((await s.sessions())[task]?.state).toBe("failed");
		expect((await s.logged()).some((entry) => entry.prompt !== undefined)).toBe(false);
	});
});
