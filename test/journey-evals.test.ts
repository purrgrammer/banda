import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { journeys } from "../evals/journeys.ts";
import { loadRun, loopbackOrigin, newRun, record, saveRun, submit, summary, target } from "../evals/runner.ts";

const homes: string[] = [];
afterEach(async () => {
	await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
const destination = { url: "http://127.0.0.1:19387", token: "secret-test-token" };
test("journeys have unique steps, observable checkpoints and prerequisites", () => {
	expect(new Set(journeys.map((item) => item.id)).size).toBe(journeys.length);
	for (const item of journeys) {
		expect(item.requires.length).toBeGreaterThan(0);
		expect(new Set(item.steps.map((step) => step.id)).size).toBe(item.steps.length);
		for (const step of item.steps) expect(step.checkpoints.length).toBeGreaterThan(0);
	}
});
test("requires explicit target and rejects remote or credential-bearing URLs", async () => {
	await expect(target({})).rejects.toThrow("exactly one");
	for (const url of [
		"https://example.com",
		"http://127.0.0.1",
		"http://127.0.0.1:8000/#token=secret",
		"http://user:secret@localhost:8080",
		"http://localhost:8080/api",
		"http://localhost:8080?token=secret",
	])
		expect(() => loopbackOrigin(url)).toThrow();
	expect(loopbackOrigin("http://localhost:19387/")).toBe(destination.url);
	await expect(target({ url: destination.url }, "")).rejects.toThrow("BANDA_EVAL_TOKEN");
});
test("private run files contain no credentials and start pending", async () => {
	const run = newRun("first-use", destination);
	const home = await mkdtemp(join(tmpdir(), "banda-eval-test-"));
	homes.push(home);
	const path = join(home, "run.json");
	await saveRun(path, run);
	expect(await readFile(path, "utf8")).not.toContain(destination.token);
	expect((await stat(path)).mode & 0o777).toBe(0o600);
	expect(await loadRun(path)).toEqual(run);
	expect(summary(run)).toMatchObject({ outcome: "incomplete", pass: 0, pending: run.steps.length * 2 });
});
test("sends just the chosen prompt through ordinary message API, not evaluator checkpoints", async () => {
	const run = newRun("first-use", destination);
	const request: typeof fetch = async (url, init) => {
		expect(url).toBe(`${destination.url}/api/messages`);
		expect(init?.redirect).toBe("error");
		expect(JSON.parse(String(init?.body))).toEqual({
			id: run.steps[1].messageId,
			thread: run.thread,
			text: run.steps[1].prompt,
		});
		expect(run.thread).toMatch(/^[0-9a-f-]{36}$/);
		return Response.json({ chat: 17, turn: 23 });
	};
	await submit(run, "answer", destination, request);
	expect(summary(run).pass).toBe(0);
	expect(run.steps[1].chat).toBe(17);
	await expect(submit(run, "answer", destination, request)).rejects.toThrow("already submitted");
	await expect(submit(run, "setup", destination, request)).rejects.toThrow("no prompt");
});
test("uncertain submission retains its idempotency key and does not leak server errors", async () => {
	const run = newRun("first-use", destination);
	const ids: string[] = [];
	const request: typeof fetch = async (_url, init) => {
		ids.push(JSON.parse(String(init?.body)).id);
		throw new Error(destination.token);
	};
	for (let n = 0; n < 2; n++)
		await expect(submit(run, "answer", destination, request)).rejects.toThrow("stored message ID is reused");
	expect(ids[0]).toBe(ids[1]);
	expect(run.steps[1].submitted).toBeUndefined();
	await expect(
		submit(run, "answer", destination, async () => Response.json({ error: destination.token }, { status: 500 })),
	).rejects.toThrow("HTTP 500");
	await expect(submit(run, "answer", { ...destination, url: "http://127.0.0.1:19388" }, request)).rejects.toThrow(
		"Target changed",
	);
});
test("both widths require evidence; missing or blocked checks cannot pass", () => {
	const run = newRun("first-use", destination);
	expect(() => record(run, "setup", "desktop", "pass", "")).toThrow("Evidence");
	expect(() => record(run, "setup", "desktop", "pass", "Bearer secret")).toThrow("credentials");
	for (const step of run.steps)
		record(run, step.id, "desktop", "pass", "Observed app at 1440×900; controls match checkpoints.");
	expect(summary(run).outcome).toBe("incomplete");
	for (const step of run.steps)
		record(run, step.id, "phone", "pass", "Observed app at 390×844; controls match checkpoints.");
	expect(summary(run).outcome).toBe("pass");
	record(run, "setup", "phone", "blocked", "Test provider unavailable.");
	expect(summary(run).outcome).toBe("blocked");
	record(run, "setup", "phone", "fail", "Recovery control absent.");
	expect(summary(run).outcome).toBe("fail");
});

test("HTTP success cannot disguise a refused or malformed acknowledgement", async () => {
	for (const body of [{ refused: destination.token }, {}, { chat: 17 }, null]) {
		const run = newRun("first-use", destination);
		await expect(submit(run, "answer", destination, async () => Response.json(body))).rejects.toThrow();
		expect(run.steps[1].submitted).toBeUndefined();
	}
});

test("live home, aliases and its daemon port are refused without network calls", async () => {
	const root = await mkdtemp(join(tmpdir(), "banda-target-test-"));
	homes.push(root);
	const live = join(root, ".banda");
	await mkdir(live);
	await writeFile(join(live, "daemon.json"), JSON.stringify({ pid: 1, port: 19387, token: destination.token }));
	await symlink(live, join(root, "alias"));
	vi.stubEnv("HOME", root);
	try {
		await expect(target({ home: live })).rejects.toThrow("never target ~/.banda");
		await expect(target({ home: join(root, "alias") })).rejects.toThrow("never target ~/.banda");
		await expect(target({ url: destination.url }, destination.token)).rejects.toThrow("live ~/.banda daemon");
	} finally {
		vi.unstubAllEnvs();
	}
});
test("reports reject changed definitions or missing checkpoints", async () => {
	const home = await mkdtemp(join(tmpdir(), "banda-eval-shape-"));
	homes.push(home);
	const path = join(home, "run.json");
	const run = newRun("first-use", destination);
	await saveRun(path, { ...run, definitionSha: "changed" });
	await expect(loadRun(path)).rejects.toThrow("definition changed");
	await saveRun(path, { ...run, steps: [] });
	await expect(loadRun(path)).rejects.toThrow("Invalid journey steps");
});
