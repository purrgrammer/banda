/**
 * A service's `Retry-After`, honoured wherever banda reads: Google is not asked again sooner than it said, a remote MCP
 * server's 429 comes back as when to ask again, and a watch whose read was refused for now looks no sooner than that,
 * though it is past the watch's cadence.
 */
import { describe, expect, it } from "vitest";
import { GoogleError, googleRequest } from "../src/core/google-rest.ts";
import { remoteSession } from "../src/core/mcp-remote.ts";
import { MAX_RETRY_AFTER_MS, RetryLater, retryAtOf, retryOf } from "../src/core/retry-after.ts";
import { context } from "../src/core/store.ts";
import { Watches } from "../src/core/watches.ts";
import { Faults } from "./fault/faults.ts";
import { CHANNEL, SLACK, said, slackWorld } from "./fault/slack-world.ts";
import { failure, NOW, watchScenario } from "./fault/watch-scenario.ts";
import { tempHome } from "./helpers.ts";

const MINUTE = 60_000;
const GMAIL = { service: "Gmail", base: "https://gmail.test/v1" };

/** A fetch that answers each request with the next of `answers`, counting them. */
function answering(...answers: (() => Response)[]) {
	const asked: string[] = [];
	const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
		asked.push(String(input));
		const next = answers[Math.min(asked.length - 1, answers.length - 1)];
		return (next as () => Response)();
	}) as typeof fetch;
	return { fetcher, asked };
}
const busy =
	(seconds: string, status = 429) =>
	() =>
		new Response(JSON.stringify({ error: { code: status } }), { status, headers: { "retry-after": seconds } });
const ok = () =>
	new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });

describe("Retry-After", () => {
	it("is a time only on a 429 or a 503, in seconds or as a date, and never more than an hour off", () => {
		const now = 1_000_000;
		expect(retryAtOf(429, "30", now)).toBe(now + 30_000);
		expect(retryAtOf(503, new Date(now + 90_000).toUTCString(), now)).toBeGreaterThanOrEqual(now + 89_000);
		expect(retryAtOf(500, "30", now)).toBeUndefined();
		expect(retryAtOf(429, null, now)).toBeUndefined();
		expect(retryAtOf(429, "86400", now)).toBe(now + MAX_RETRY_AFTER_MS);
		expect(retryOf(new RetryLater("busy", 5))).toEqual({ retryAt: 5 });
		expect(retryOf(new Error("plain"))).toEqual({});
	});

	it("Google: a wait longer than a moment is not waited out and asked again, it is the caller's", async () => {
		const { fetcher, asked } = answering(busy("30"), ok);
		const before = Date.now();
		const refused = await googleRequest(GMAIL, fetcher, "t", "users/me/profile").catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(GoogleError);
		expect((refused as GoogleError).retryAt).toBeGreaterThanOrEqual(before + 30_000);
		expect(retryOf(refused).retryAt).toBe((refused as GoogleError).retryAt);
		expect(asked).toHaveLength(1);
	});

	it("Google: a wait of a second is waited out whole, then asked once more", async () => {
		const { fetcher, asked } = answering(busy("1", 503), ok);
		const before = Date.now();
		expect(await googleRequest(GMAIL, fetcher, "t", "users/me/profile")).toEqual({ ok: true });
		expect(asked).toHaveLength(2);
		expect(Date.now() - before).toBeGreaterThanOrEqual(950);
	});

	it("a remote MCP server's 429 says when to ask again", async () => {
		const { fetcher, asked } = answering(busy("120"));
		const before = Date.now();
		const refused = await remoteSession(
			"https://mcp.test/mcp",
			async () => undefined,
			fetcher,
			undefined,
			(client) => client.listTools(),
		).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(RetryLater);
		expect((refused as RetryLater).retryAt).toBeGreaterThanOrEqual(before + 120_000);
		expect(asked.length).toBeGreaterThanOrEqual(1);
	});

	it("a watch refused for twenty minutes looks again then, not at its five-minute cadence", async () => {
		const at = (step: number) => NOW + step * MINUTE;
		const until = at(1) + 20 * MINUTE;
		const quiet = slackWorld(() => ({ channel: [said(10, "@bob at Acme", "hello")] }));
		let next: number | undefined;
		await watchScenario(await tempHome(), new Faults(), {
			tasks: false,
			connection: SLACK,
			object: `slack/${CHANNEL}`,
			answer: (tool, args, step) => (step === 1 ? failure("Slack is busy", until) : quiet(tool, args, step)),
			clicks: [undefined, undefined],
			at,
			act: async (step, { harness, core }) => {
				await core.lookWatch(harness, "banda-142");
				if (step === 1) next = (await harness.snapshot(Watches, context))?.watches["banda-142"]?.next;
			},
		});
		expect(next).toBe(until);
	}, 60_000);
});
