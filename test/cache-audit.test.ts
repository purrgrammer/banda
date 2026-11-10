import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { auditHome } from "../scripts/cache-audit.ts";
import { type AuditRow, type AuditUsage, auditCache, CACHE_WINDOW } from "../src/core/cache-audit.ts";
import { context } from "../src/core/store.ts";
import type { SystemUsageValue } from "../src/core/system-usage.ts";
import { fauxChat } from "./fixtures/cache-prefix.ts";

const MODEL = "anthropic/claude";
const usage = (input: number, cacheRead: number, cacheWrite: number): AuditUsage => ({
	input,
	output: 1,
	cacheRead,
	cacheWrite,
	cost: 0.5,
});
const input = (chat = 1): AuditRow => ({ type: "input", chat });
const request = (at: number, numbers: AuditUsage | undefined, chat = 1): AuditRow => ({
	type: "request",
	chat,
	at,
	model: MODEL,
	usage: numbers,
});
const stored = (input: number, cacheRead: number, cacheWrite: number, cost = 1) => ({
	input,
	output: 1,
	cacheRead,
	cacheWrite,
	totalTokens: input + cacheRead + cacheWrite + 1,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

describe("auditing the prompt cache", () => {
	it("classes each request by its turn and the gap, and leaves out what reported nothing", () => {
		const audit = auditCache({
			rows: [
				input(),
				request(0, usage(10, 0, 90)),
				request(1000, usage(5, 90, 5)),
				input(),
				request(60_000, usage(5, 95, 0)),
				input(),
				request(60_000 + CACHE_WINDOW, usage(100, 0, 0)),
				input(),
				// a failure before the provider answered: it is not the turn's first request
				request(60_000 + CACHE_WINDOW + 10, undefined),
				request(60_000 + CACHE_WINDOW + 20, usage(1, 99, 0)),
			],
			usage: undefined,
			ledger: {},
		});
		expect(audit.classes).toEqual([
			{ class: "first", model: MODEL, requests: 2, read: 194, written: 0, uncached: 6, hitRate: 0.97 },
			{ class: "first-cold", model: MODEL, requests: 2, read: 0, written: 90, uncached: 110, hitRate: 0 },
			{ class: "later", model: MODEL, requests: 1, read: 90, written: 5, uncached: 5, hitRate: 0.9 },
		]);
		expect(audit.unreported).toBe(1);
		expect(audit.starts).toEqual({ cold: 2, turns: 4 });
	});

	it("counts only the range asked for, while the gaps still see the requests before it", () => {
		const audit = auditCache({
			rows: [input(), request(1000, usage(0, 5, 5)), input(), request(2000, usage(0, 9, 1))],
			usage: undefined,
			ledger: {},
			between: { from: 1500 },
		});
		expect(audit.classes).toEqual([
			expect.objectContaining({ class: "first", requests: 1, read: 9, written: 1, hitRate: 0.9 }),
		]);
		expect(audit.starts).toEqual({ cold: 0, turns: 1 });
	});

	it("lists what each system spent, by model", () => {
		const doc: SystemUsageValue = {
			systems: { "inference.face": { [MODEL]: { requests: 3, unreported: 1, usage: stored(10, 30, 60) } } },
		};
		const audit = auditCache({ rows: [], usage: doc, ledger: {} });
		expect(audit.systems).toEqual([
			{
				system: "inference.face",
				model: MODEL,
				unreported: 1,
				requests: 3,
				read: 30,
				written: 60,
				uncached: 10,
				hitRate: 0.3,
			},
		]);
	});

	it("takes the cache's window from the caller, for the cold split", () => {
		const window = 60 * 60_000;
		const gap = 30 * 60_000;
		const rows = [input(), request(1000, usage(10, 0, 90)), input(), request(1000 + gap, usage(1, 99, 0))];
		const short = auditCache({ rows, usage: undefined, ledger: {} });
		expect(short.starts).toEqual({ cold: 2, turns: 2 });
		const long = auditCache({ rows, usage: undefined, ledger: {}, window });
		expect(long.starts).toEqual({ cold: 1, turns: 2 });
	});

	it("says what the ledgers spent beyond the entries, per provider", () => {
		const audit = auditCache({
			rows: [input(), request(0, usage(10, 0, 90))],
			usage: undefined,
			ledger: { [MODEL]: stored(30, 5, 90, 2), "openai/gpt": stored(7, 0, 0, 1) },
		});
		expect(audit.unaccounted).toEqual([
			{ provider: "anthropic", input: 20, output: 0, read: 5, written: 0, cost: 1.5 },
			{ provider: "openai", input: 7, output: 1, read: 0, written: 0, cost: 1 },
		]);
	});
});

describe("the audit of a home", () => {
	it("reads a real store and reports aggregates, never message text", async () => {
		const s = fauxChat();
		const home = await mkdtemp(join(tmpdir(), "banda-cache-audit-"));
		const harness = await s.open(home);
		await s.say(harness, "a secret phrase");
		await harness.close(context);
		const audit = await auditHome(home);
		expect(audit.classes.map((line) => line.class)).toEqual(["first-cold", "later"]);
		expect(audit.starts).toEqual({ cold: 1, turns: 1 });
		expect(JSON.stringify(audit)).not.toContain("secret phrase");
	});

	it("refuses the live home without opening it, and a folder with no store", async () => {
		const live = await mkdtemp(join(tmpdir(), "banda-cache-live-"));
		vi.stubEnv("BANDA_HOME", live);
		try {
			await expect(auditHome(live)).rejects.toThrow("npm run home:fork -- --no-volumes");
		} finally {
			vi.unstubAllEnvs();
		}
		await expect(auditHome(live)).rejects.toThrow("holds no store");
	});
});
