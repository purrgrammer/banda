/**
 * The browser under kills (principle 10): a page's write held, sent once the owner approved it, and the key the page
 * then shows kept, with one kill at every commit and at each new effect boundary (the browser's start, each action, the
 * send through the proxy, the key kept and once it is). Whatever was killed and when, the Turn ends with nothing parked
 * or open, the page's write reaches the site at most once and only as approved, and the key is in auth/ at most and
 * never in the store.
 *
 * And a call that waits while the owner holds the browser, with one kill at every commit, as it starts to wait, as the
 * owner gives the browser back and as they answer: the call keeps waiting through every restart, never acts while the
 * owner holds the browser, and goes on with the page once they give it back.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Fault, FaultPoint } from "./fault/faults.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { SHOP_KEY } from "./fixtures/fake-browser.ts";
import { tempHome } from "./helpers.ts";

type Summary = {
	outcome: { status: string };
	parked: unknown[];
	answers: string[];
	sent: number;
	open: number;
	commits: number;
	activity: string[];
};

const run = async (schedules: readonly (readonly Fault[])[], mode: "signed-in" | "anonymous" = "signed-in") => {
	const home = await tempHome();
	const { last, kills } = await runWorker("test/fault/browser-worker.ts", [home, mode], schedules);
	return { ...(last as Summary), kills, home };
};

const read = (path: string) => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
};

function check(summary: Awaited<ReturnType<typeof run>>, mode: "signed-in" | "anonymous" = "signed-in") {
	expect(summary.outcome.status).toBe("completed");
	expect(summary.parked).toEqual([]);
	expect(summary.open).toBe(0);
	// sent once at most: with the owner's session only as approved; anonymous, never asked
	expect(summary.sent).toBeLessThanOrEqual(1);
	const asked = summary.answers.filter((a) => a === "approve browser_send").length;
	if (mode === "signed-in") expect(asked).toBeGreaterThanOrEqual(summary.sent);
	else expect(asked).toBe(0);
	// every send is logged, in a commit before the proxy is told: no kill leaves one that went unlogged
	const logged = summary.activity.filter((what) => what === "Sent POST https://shop.example/keys from the browser");
	expect(logged.length).toBeGreaterThanOrEqual(summary.sent);
	// the key: in auth/ only once its keeping was approved, and never in the store
	const kept = read(join(summary.home, "auth", "egress.json")).includes(SHOP_KEY);
	if (kept) expect(summary.answers).toContain("approve propose_key");
	const stored = readdirSync(summary.home)
		.filter((name) => name.startsWith("durable.db"))
		.map((name) => join(summary.home, name))
		.filter((path) => statSync(path).isFile())
		.map((path) => readFileSync(path).toString("latin1"))
		.join("\n");
	expect(stored.includes(SHOP_KEY)).toBe(false);
	return kept;
}

describe("the browser under faults", () => {
	it("sweep: one kill at every commit, at the browser's start, each action, the send and the key kept", async () => {
		const clean = await run([]);
		expect(check(clean)).toBe(true);
		expect(clean.sent).toBe(1);
		// opening the shop, where the owner is signed in, asks first: approved once
		expect(clean.answers).toEqual(["approve browser_navigate", "approve browser_send", "approve propose_key"]);
		const points: [FaultPoint, number][] = [
			["browser:start", 1],
			["browser:action", 1],
			["browser:action", 2],
			["browser:send", 1],
			["browser:capture", 1],
			["browser:captured", 1],
			["answer", 1],
			["answer", 2],
			["model", 1],
			["model", 3],
			["model", 5],
		];
		const faults: Fault[] = points.map(([point, hit]) => ({ point, hit, kind: "kill" }));
		for (let hit = 1; hit <= clean.commits; hit++)
			faults.push({ point: "commit:before", hit, kind: "kill" }, { point: "commit:after", hit, kind: "kill" });
		await pool(
			6,
			faults.map((fault) => async () => {
				const killed = await run([[fault]]);
				try {
					expect(killed.kills).toBe(1);
					check(killed);
					// killed before the proxy was told: nothing went, and the page that held it died with the browser
					if (fault.point === "browser:send") expect(killed.sent).toBe(0);
				} catch (error) {
					throw new Error(`killed at ${fault.point} #${fault.hit}: ${(error as Error).message}`);
				}
			}),
		);
	}, 600_000);

	it("anonymous: the page's write goes at once, unasked, at most once, with one kill at every commit and boundary", async () => {
		const clean = await run([], "anonymous");
		expect(check(clean, "anonymous")).toBe(true);
		expect(clean.sent).toBe(1);
		expect(clean.answers).toEqual(["approve propose_key"]);
		const points: [FaultPoint, number][] = [
			["browser:start", 1],
			["browser:action", 1],
			["browser:action", 2],
			["browser:send", 1],
			["browser:capture", 1],
			["browser:captured", 1],
			["answer", 1],
			["model", 1],
			["model", 3],
		];
		const faults: Fault[] = points.map(([point, hit]) => ({ point, hit, kind: "kill" }));
		for (let hit = 1; hit <= clean.commits; hit++)
			faults.push({ point: "commit:before", hit, kind: "kill" }, { point: "commit:after", hit, kind: "kill" });
		await pool(
			6,
			faults.map((fault) => async () => {
				const killed = await run([[fault]], "anonymous");
				try {
					expect(killed.kills).toBe(1);
					check(killed, "anonymous");
					// killed before the proxy was told: nothing went, and the page that held it died with the browser
					if (fault.point === "browser:send") expect(killed.sent).toBe(0);
				} catch (error) {
					throw new Error(`killed at ${fault.point} #${fault.hit}: ${(error as Error).message}`);
				}
			}),
		);
	}, 600_000);

	type Paused = {
		outcome: { status: string };
		parked: unknown[];
		log: ({ act: string } | { gaveBack: true } | { step: number; result: string })[];
		open: number;
		commits: number;
	};
	const runPaused = async (schedules: readonly (readonly Fault[])[]) => {
		const home = await tempHome();
		const { last, kills } = await runWorker("test/fault/browser-pause-worker.ts", [home], schedules);
		return { ...(last as Paused), kills };
	};
	function checkPaused(summary: Paused) {
		expect(summary.outcome.status).toBe("completed");
		expect(summary.parked).toEqual([]);
		expect(summary.open).toBe(0);
		// nothing acted on the page before the owner gave it back
		const back = summary.log.findIndex((event) => "gaveBack" in event);
		expect(back).toBeGreaterThanOrEqual(0);
		expect(summary.log.slice(0, back).some((event) => "act" in event)).toBe(false);
		// the call that waited went on with the page, its own action not done; the run read the page after it
		const results = summary.log.flatMap((event) => ("step" in event ? [event] : []));
		const opened = results.find((event) => event.step === 0)?.result ?? "";
		expect(opened).toContain("The owner gave the browser back");
		expect(opened).toContain('Page "" at about:blank');
		expect(results.some((event) => event.step === 1)).toBe(true);
		expect(summary.log.some((event) => "act" in event && event.act === "navigate")).toBe(false);
	}

	it("sweep: a call waits while the owner holds the browser, through a kill at every commit, the wait and the give-back", async () => {
		const clean = await runPaused([]);
		checkPaused(clean);
		const points: [FaultPoint, number][] = [
			["browser:wait", 1],
			["browser:give-back", 1],
			["answer", 1],
			["model", 1],
			["model", 2],
		];
		const faults: Fault[] = points.map(([point, hit]) => ({ point, hit, kind: "kill" }));
		for (let hit = 1; hit <= clean.commits; hit++)
			faults.push({ point: "commit:before", hit, kind: "kill" }, { point: "commit:after", hit, kind: "kill" });
		await pool(
			6,
			faults.map((fault) => async () => {
				const killed = await runPaused([[fault]]);
				try {
					expect(killed.kills).toBe(1);
					checkPaused(killed);
				} catch (error) {
					throw new Error(
						`killed at ${fault.point} #${fault.hit}: ${(error as Error).message}; log: ${JSON.stringify(killed.log)}`,
					);
				}
			}),
		);
	}, 600_000);
});
