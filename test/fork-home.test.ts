/**
 * A fork of a home (scripts/fork-home.ts): the store and the owner's setup copied, the source only read, routines
 * paused in the fork, and the providers' sign-in shared, so a refresh in either home is the other's too. The box's
 * volumes need Docker and are left out here.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, type TaskId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { forkHome } from "../scripts/fork-home.ts";
import { answerAsk, defineHarnesses, type HarnessDefinition, Harnesses } from "../src/core/harness.ts";
import { MARKER, marked, treeGroups } from "../src/core/processes.ts";
import { FileCredentialStore } from "../src/core/provider-credentials.ts";
import { Control } from "../src/core/routines.ts";
import { context, openStore } from "../src/core/store.ts";
import { echoModels } from "./fixtures/models.ts";
import { until } from "./helpers.ts";

const dirs: string[] = [];
const dir = (prefix: string) => {
	const next = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(next);
	return next;
};
afterEach(() => {
	for (const next of dirs.splice(0)) rmSync(next, { recursive: true, force: true });
});

const control = async (home: string) => {
	const harness = await openStore(home, { models: createModels(), registry: createRegistry() });
	try {
		return await harness.snapshot(Control, context);
	} finally {
		await harness.close(context);
	}
};

it("copies computer files without adopting runtime authority or pending proxy sends", async () => {
	const from = dir("banda-microvm-source-");
	const store = await openStore(from, { models: createModels(), registry: createRegistry() });
	await store.close(context);
	for (const path of ["workspace", "work", "tools", "browser", "proxy/kept", "runtime"]) {
		mkdirSync(join(from, "computer", path), { recursive: true });
		writeFileSync(join(from, "computer", path, "marker"), path);
	}
	const to = dir("banda-microvm-fork-");
	const copied = await forkHome(from, to);
	expect(copied).toEqual(expect.arrayContaining(["computer workspace", "computer work", "computer tools"]));
	for (const path of ["workspace", "work", "tools"])
		expect(readFileSync(join(to, "computer", path, "marker"), "utf8")).toBe(path);
	for (const path of ["browser", "proxy", "runtime"]) expect(() => lstatSync(join(to, "computer", path))).toThrow();
	const withBrowser = dir("banda-microvm-browser-fork-");
	await forkHome(from, withBrowser, { browser: true });
	expect(readFileSync(join(withBrowser, "computer/browser/marker"), "utf8")).toBe("browser");
	expect(readFileSync(join(from, "computer/proxy/kept/marker"), "utf8")).toBe("proxy/kept");
});

it("forks a home's store and setup, pauses its routines, and leaves the source as it was", async () => {
	const from = dir("banda-main-");
	const harness = await openStore(from, { models: createModels(), registry: createRegistry() });
	try {
		// the source's daemon keeps the store open, as a live home's does
		await harness.commit(async (tx) => {
			(await tx.doc(Control)).chat = 7;
		}, context);
		mkdirSync(join(from, "auth"), { recursive: true });
		mkdirSync(join(from, "blobs", "ab"), { recursive: true });
		writeFileSync(join(from, "blobs", "ab", "abcd"), "bytes");
		writeFileSync(join(from, "config.json"), '{"model":{"provider":"openai","id":"x"}}');
		writeFileSync(join(from, "auth", "token"), "owner-token");
		writeFileSync(join(from, "auth", "egress.json"), '{"credentials":[]}');
		writeFileSync(join(from, "auth", "egress.key"), "f".repeat(64));
		await new FileCredentialStore(from).modify("openai", async () => ({ type: "api_key", key: "first" }));

		const to = join(dir("banda-fork-"), "home");
		const done = await forkHome(from, to, { volumes: false });
		expect(done).toEqual([
			"store",
			"blobs",
			"config",
			"auth/token",
			"auth/egress.json",
			"auth/providers.json (linked)",
			"routines paused",
		]);
		expect(await control(to)).toMatchObject({ chat: 7, paused: expect.any(Number) });
		expect(readFileSync(join(to, "blobs", "ab", "abcd"), "utf8")).toBe("bytes");
		expect(readFileSync(join(to, "auth", "token"), "utf8")).toBe("owner-token");
		// the proxy's key is the fork's own, made by its daemon
		expect(() => lstatSync(join(to, "auth", "egress.key"))).toThrow();
		// the source: still running, not paused
		expect((await harness.snapshot(Control, context))?.paused).toBeUndefined();
		await expect(forkHome(from, to, { volumes: false })).rejects.toThrow("is not empty");
		await expect(forkHome(from, from, { volumes: false })).rejects.toThrow("onto itself");

		// a refresh in the fork is written to the source's file, and the fork keeps its link
		await new FileCredentialStore(to).modify("openai", async () => ({ type: "api_key", key: "refreshed" }));
		expect(lstatSync(join(to, "auth", "providers.json")).isSymbolicLink()).toBe(true);
		expect(await new FileCredentialStore(from).read("openai")).toEqual({ type: "api_key", key: "refreshed" });
	} finally {
		await harness.close(context);
	}
});

describe("the processes a forked store remembers", () => {
	const FAKE = join(import.meta.dirname, "fixtures/fake-acp-agent.ts");
	const definitions = () =>
		new Map<string, HarnessDefinition>([
			["fake", { name: "fake", service: "Fake Code", command: process.execPath, args: [FAKE] }],
		]);

	/** A home's store with the harness sessions installed, as its daemon opens it; nothing runs until `resume`. */
	async function open(home: string) {
		const made = defineHarnesses({
			home,
			definitions,
			followUp: async () => 0,
			log: () => {},
			openMs: 20_000,
		});
		const registry = createRegistry();
		registry.install(defineExtension({ name: "test.harness", tasks: [made.Session] }));
		const harness = await openStore(home, { models: echoModels().models, registry });
		const sessions = async () => (await harness.snapshot(Harnesses, context))?.sessions ?? {};
		const chat = () =>
			harness.commit(
				async (tx) => Number((await tx.createConversation({ ownership: { kind: "ownerless" } })).id),
				context,
			);
		return { harness, made, sessions, chat };
	}

	const forkOf = async (from: string) => {
		const to = join(dir("banda-fork-"), "home");
		await forkHome(from, to, { volumes: false });
		return to;
	};

	/** A process of its own group, as a harness's shells are; never the test's group, so killing it touches nothing else. */
	function sleeper(env: NodeJS.ProcessEnv = {}) {
		const child: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			detached: true,
			stdio: "ignore",
			env: { ...process.env, ...env },
		});
		const exit = new Promise<NodeJS.Signals | null>((done) => child.once("exit", (_code, signal) => done(signal)));
		onTestFinished(() => {
			child.kill("SIGKILL");
		});
		return { child, pid: child.pid as number, exit };
	}

	/** Whether it still runs: from the process table, so a kill shows before this process has reaped its child. */
	const running = (pid: number) => {
		try {
			return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })
				.trim()
				.startsWith("Z");
		} catch {
			return false;
		}
	};

	it("leaves the session its source is running alone, so it finishes there", async () => {
		const from = dir("banda-main-");
		const folder = dir("banda-folder-");
		const main = await open(from);
		main.harness.resume();
		try {
			const chat = await main.chat();
			const task = await main.harness.commit(
				(tx) => main.made.begin(tx, { chat, agent: "sancho", harness: "fake", folder, ask: "ask npm test" }),
				context,
			);
			// the harness waits on the owner: a live process, and the store holds its marker, as any running session's does
			const ask = await until(async () => (await main.sessions())[task]?.asks?.[0]);
			expect((await main.sessions())[task]?.marker).toEqual(expect.any(String));

			const fork = await open(await forkOf(from));
			try {
				await fork.made.reconcile(fork.harness, context);
				fork.harness.resume();
				await until(async () => (await fork.sessions())[task]?.ended !== undefined);
			} finally {
				await fork.harness.close(context);
			}

			await main.harness.commit((tx) => answerAsk(tx, task, ask.id, true), context);
			const ended = await until(async () => {
				const session = (await main.sessions())[task];
				return session?.ended === undefined ? undefined : session;
			});
			expect({ state: ended.state, outcome: ended.state === "failed" ? ended.outcome : undefined }).toEqual({
				state: "done",
				outcome: undefined,
			});
		} finally {
			await main.harness.close(context);
		}
	});

	for (const route of ["resumed", "reconciled"] as const) {
		it(`kills nothing of its source when a session is ${route} in the fork, and the source's own daemon still does`, async () => {
			const from = dir("banda-main-");
			const marker = `fork-test-${route}-${process.pid}-${Date.now()}`;
			// one found only by the marker, one only by the group, so each way of killing is held to it apart
			const byMarker = sleeper({ [MARKER]: marker });
			const byGroup = sleeper();
			expect(marked(marker)).toContain(byMarker.pid);
			const groups = treeGroups(byGroup.pid);
			expect(groups.map((group) => group.id)).toEqual([byGroup.pid]);

			const main = await open(from);
			try {
				const chat = await main.chat();
				const task = await main.harness.commit(async (tx) => {
					const id =
						route === "resumed"
							? await main.made.begin(tx, { chat, agent: "sancho", harness: "fake", folder: from, ask: "say hi" })
							: 9999;
					const doc = await tx.doc(Harnesses);
					doc.sessions[id] = {
						...(doc.sessions[id] ?? {
							chat,
							agent: "sancho",
							harness: "fake",
							folder: from,
							prompt: "say hi",
							state: "working" as const,
							at: 1,
							steps: [],
							dropped: 0,
							notes: [],
						}),
						prompted: true,
						home: from,
						marker,
						groups,
					};
					if (route === "reconciled") expect(await tx.task(id as TaskId)).toBeUndefined();
					return id;
				}, context);

				const fork = await open(await forkOf(from));
				try {
					await fork.made.reconcile(fork.harness, context);
					fork.harness.resume();
					await until(async () => (await fork.sessions())[task]?.ended !== undefined);
				} finally {
					await fork.harness.close(context);
				}
				expect({ marker: running(byMarker.pid), group: running(byGroup.pid) }).toEqual({ marker: true, group: true });

				// the same record in the store of the home that made it: what its dead daemon left running goes
				await main.made.reconcile(main.harness, context);
				main.harness.resume();
				expect(await byMarker.exit).toBe("SIGKILL");
				expect(await byGroup.exit).toBe("SIGKILL");
			} finally {
				await main.harness.close(context);
			}
		});
	}

	it("starts a session anew in the fork without taking on the groups its source recorded", async () => {
		const from = dir("banda-main-");
		const folder = dir("banda-folder-");
		const foreign = sleeper();
		const groups = treeGroups(foreign.pid);
		const main = await open(from);
		try {
			const chat = await main.chat();
			// not yet sent to its harness: the fork's daemon starts it, and then records processes of its own
			const task = await main.harness.commit(async (tx) => {
				const id = await main.made.begin(tx, { chat, agent: "sancho", harness: "fake", folder, ask: "ask npm test" });
				Object.assign((await tx.doc(Harnesses)).sessions[id] ?? {}, { home: from, marker: "gone", groups });
				return id;
			}, context);

			const to = await forkOf(from);
			const fork = await open(to);
			try {
				fork.harness.resume();
				await until(async () => (await fork.sessions())[task]?.asks?.[0]);
				const session = (await fork.sessions())[task];
				expect(session?.home).toBe(to);
				expect(session?.groups?.map((group) => group.id) ?? []).not.toContain(foreign.pid);
				expect(running(foreign.pid)).toBe(true);
			} finally {
				await fork.harness.close(context);
			}
		} finally {
			await main.harness.close(context);
		}
	});
});
