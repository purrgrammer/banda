/**
 * A wallet's life under kills and thrown faults (principle 10, C15, C21): making a wallet that stays, its saved copy
 * confirmed, and one that is skipped, archived, brought back, archived again and removed, with one kill at every commit, at every keychain read, write and delete and around
 * every sync of the store, thrown faults at the keychain's points and the syncs generated, and kills and throws mixed
 * across several processes in turn, generated. Whatever was killed and when: never two items, never a wallet ready
 * without its item read back, no item that no wallet names, no reveal claimed by an answer a kill lost; the store ends with Groceries alone, ready and backed up, its one item deriving its address, its account the only one, and no key in the store. The sweep runs again with
 * funds reaching Travel during its removal: then Travel ends removed or archived, and an archived Travel has its item.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { accountKey } from "../src/core/connections.ts";
import type { Fault, FaultPoint } from "./fault/faults.ts";
import { PAST, pool, runWorker, unlanded } from "./fault/kill.ts";
import { storeText } from "./helpers/home-files.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

type Summary = {
	groceries: string;
	wallets: { [address: string]: { name: string; state: string; backup: string } };
	items: { address: string; derives: boolean }[];
	keys: string[];
	accounts: string[];
	credentials: string[];
	reveals: { [address: string]: { digest: string | null } };
	heard: string[];
	orphans: string[] | undefined;
	removed: boolean;
	violations: unknown[];
	commits: number;
	points: { [point: string]: number };
};

const KEYCHAIN: FaultPoint[] = ["keychain:read", "keychain:write", "keychain:delete"];
/** The syncs of what was committed (C21): before the checkpoint, and once it is on disk. */
const SYNC: FaultPoint[] = ["store:sync:before", "store:sync:after"];

/** The balance read at which funds reach Travel; 0: never. */
const run = async (schedules: readonly (readonly Fault[])[], funds = 0) => {
	const home = await tempHome();
	const { last, kills } = await runWorker("test/fault/wallet-lifecycle-worker.ts", [home, String(funds)], schedules);
	return { ...(last as Summary), kills, home, funds };
};

function check(summary: Awaited<ReturnType<typeof run>>) {
	expect(summary.violations).toEqual([]);
	const travel = Object.keys(summary.wallets).filter((address) => address !== summary.groceries);
	const kept = summary.funds === 0 || summary.removed ? [summary.groceries] : [summary.groceries, ...travel];
	if (!summary.removed) expect(travel).toHaveLength(summary.funds === 0 ? 0 : 1);
	expect(summary.wallets).toEqual({
		[summary.groceries]: { name: "Groceries", state: "ready", backup: "saved" },
		...Object.fromEntries(
			kept
				.filter((address) => address !== summary.groceries)
				.map((address) => [address, { name: "Travel", state: "archived", backup: "skipped" }]),
		),
	});
	const sorted = [...kept].sort();
	expect([...summary.items].sort((a, b) => (a.address < b.address ? -1 : 1))).toEqual(
		sorted.map((address) => ({ address, derives: true })),
	);
	expect(summary.accounts).toEqual(sorted.map(accountKey).sort());
	expect(summary.credentials).toEqual(sorted.map(accountKey).sort());
	expect(summary.orphans).toEqual([]);
	// a reveal in its window is unclaimed, so the next repeat carries it, or was claimed with a secret an answer carried:
	// never claimed by an answer a kill lost, which no later repeat could carry (C16, H-268)
	for (const [address, reveal] of Object.entries(summary.reveals))
		if (reveal.digest !== null) expect(summary.heard, `the reveal of ${address}`).toContain(reveal.digest);
	if (summary.funds === 0) expect(summary.removed).toBe(true);
	const text = storeText(summary.home);
	for (const key of summary.keys) expect(text.includes(key.slice(2))).toBe(false);
}

describe("a wallet's life under faults", () => {
	it("sweep: one kill at every commit, keychain read, write and delete, and sync", async () => {
		const clean = await run([]);
		check(clean);
		for (const point of [...KEYCHAIN, ...SYNC]) expect(clean.points[point]).toBeGreaterThan(0);
		const faults: Fault[] = [];
		for (const point of [...KEYCHAIN, ...SYNC])
			for (let hit = 1; hit <= (clean.points[point] ?? 0) + PAST; hit++) faults.push({ point, hit, kind: "kill" });
		for (let hit = 1; hit <= clean.commits + PAST; hit++)
			faults.push({ point: "commit:before", hit, kind: "kill" }, { point: "commit:after", hit, kind: "kill" });
		await pool(
			2,
			faults.map((fault) => async () => {
				const killed = await run([[fault]]);
				try {
					const missed = unlanded(fault, { kills: killed.kills, reached: killed.points });
					if (missed !== undefined) throw new Error(missed);
					check(killed);
				} catch (error) {
					throw new Error(`killed at ${fault.point} #${fault.hit}: ${(error as Error).message}`);
				}
			}),
		);
	}, 1_800_000);

	it("sweep with funds reaching Travel at its re-check, and after its delete", async () => {
		// 2: the removal's re-check reads funds and rolls back; 3: only a removal resumed after a kill reads them
		for (const funds of [2, 3]) {
			const clean = await run([], funds);
			check(clean);
			const faults: Fault[] = [];
			for (const point of [...KEYCHAIN, ...SYNC])
				for (let hit = 1; hit <= (clean.points[point] ?? 0) + PAST; hit++) faults.push({ point, hit, kind: "kill" });
			for (let hit = 1; hit <= clean.commits + PAST; hit++)
				faults.push({ point: "commit:before", hit, kind: "kill" }, { point: "commit:after", hit, kind: "kill" });
			await pool(
				2,
				faults.map((fault) => async () => {
					const killed = await run([[fault]], funds);
					try {
						const missed = unlanded(fault, { kills: killed.kills, reached: killed.points });
						if (missed !== undefined) throw new Error(missed);
						check(killed);
					} catch (error) {
						throw new Error(`funds at ${funds}, killed at ${fault.point} #${fault.hit}: ${(error as Error).message}`);
					}
				}),
			);
		}
	}, 1_800_000);

	it("holds under thrown keychain and sync faults and restarts, generated", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.tuple(fc.constantFrom(...KEYCHAIN, "store:sync:before"), fc.integer({ min: 1, max: 12 })), {
					maxLength: 4,
				}),
				async (cuts) => {
					check(await run([cuts.map(([point, hit]) => ({ point, hit, kind: "error" as const }))]));
				},
			),
			{ numRuns: pbtFaultRuns(6) },
		);
	}, 600_000);

	it("holds under kills and thrown faults mixed, in each of several processes one after another, generated", async () => {
		// a kill anywhere; a throw where a failing keychain throws (a thrown commit fails the store, which a kill covers)
		const fault = fc.oneof(
			fc.record({
				point: fc.constantFrom<FaultPoint>(...KEYCHAIN, ...SYNC, "commit:before", "commit:after"),
				hit: fc.integer({ min: 1, max: 16 }),
				kind: fc.constant("kill" as const),
			}),
			fc.record({
				point: fc.constantFrom<FaultPoint>(...KEYCHAIN, "store:sync:before"),
				hit: fc.integer({ min: 1, max: 12 }),
				kind: fc.constant("error" as const),
			}),
		);
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.array(fault, { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 3 }),
				fc.constantFrom(0, 2, 3),
				async (schedules, funds) => {
					check(await run(schedules, funds));
				},
			),
			{ numRuns: pbtFaultRuns(6) },
		);
	}, 900_000);
});
