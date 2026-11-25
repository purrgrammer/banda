/**
 * The desktop's key acts under kills and thrown faults (principle 10, C15, UC-19, UC-21): Move signing here and
 * Restore key, as the signer runs them, then the daemon's check that brings the store's lease up to the keychain's,
 * with one kill at every keychain read, write and delete and at every commit, and kills and thrown keychain faults
 * generated, each act and check asked again until done. Whatever was killed and when: the wallet's item is never lost
 * to a move and never holds a key that is not the wallet's, a mistyped key is never kept, no two homes read the lease
 * as their own, the store's lease is never past the keychain's, and the act ends done: the lease this home's alone at
 * a later epoch that the store took and the other home reads as not its own, or the restored item deriving the
 * wallet's address.
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { homeSecretAccount, leaseAccount, type SignerHome, walletAccount } from "../src/wallet/home-id.ts";
import { addressOf } from "../src/wallet/sign.ts";
import type { Fault, FaultPoint } from "./fault/faults.ts";
import { PAST, pool, runWorker, unlanded } from "./fault/kill.ts";
import { HERE, ID, KEY, THERE } from "./fault/wallet-keys-worker.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

type Act = "move" | "restore";
type Summary = {
	address: string;
	lease: { epoch: number; mine: boolean } | null;
	there: boolean;
	thereEpoch: number | null;
	stored: number | null;
	signing: string | null;
	derives: boolean;
	wallets: string[];
	codes: string[];
	violations: unknown[];
	points: { [point: string]: number };
};

const KEYCHAIN: FaultPoint[] = ["keychain:read", "keychain:write", "keychain:delete"];
/** Kills only: a thrown storage fault fails the store, which closes itself. */
const COMMIT: FaultPoint[] = ["commit:before", "commit:after"];
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The keychain before the act: the lease another copy holds (a move), or this home's with the key's item gone. */
function before(act: Act): { [account: string]: string } {
	const holder: SignerHome = act === "move" ? THERE : HERE;
	const secret = sha256(`banda fault ${act} secret`);
	return {
		[homeSecretAccount(ID)]: JSON.stringify({ secret, binding: holder.binding }),
		[leaseAccount(ID)]: JSON.stringify({ epoch: 1, holder: sha256(secret) }),
		...(act === "move" ? { [walletAccount(ID, addressOf(KEY))]: KEY } : {}),
	};
}

const run = async (act: Act, schedules: readonly (readonly Fault[])[]) => {
	const home = await tempHome();
	await writeFile(join(home, "keychain.json"), JSON.stringify({ items: before(act), faults: [], calls: [] }));
	const { last, kills } = await runWorker("test/fault/wallet-keys-worker.ts", [home, act], schedules);
	return { ...(last as Summary), kills };
};

function check(act: Act, summary: Awaited<ReturnType<typeof run>>) {
	expect(summary.violations).toEqual([]);
	expect(summary.derives).toBe(true);
	expect(summary.wallets).toEqual([walletAccount(ID, addressOf(KEY))]);
	expect(summary.lease?.mine).toBe(true);
	expect(summary.signing).toBe("online");
	// both homes agree on the epoch: the store took the keychain's, and the other home reads it as not its own
	expect(summary.stored).toBe(summary.lease?.epoch);
	expect(summary.thereEpoch).toBe(summary.lease?.epoch);
	expect(summary.there).toBe(false);
	expect(summary.lease?.epoch).toBe(act === "move" ? 2 : 1);
}

describe.each(["move", "restore"] as const)("the desktop's %s under faults", (act) => {
	it("sweep: one kill at every keychain read, write and delete, and at every commit", async () => {
		const clean = await run(act, []);
		check(act, clean);
		expect(clean.codes).toEqual([]);
		// the act writes the keychain and the check commits the store's lease: both are boundaries the sweep kills at
		expect(clean.points["keychain:write"]).toBeGreaterThan(0);
		expect(clean.points["commit:after"]).toBeGreaterThan(0);
		const faults: Fault[] = [];
		for (const point of [...KEYCHAIN, ...COMMIT])
			for (let hit = 1; hit <= (clean.points[point] ?? 0) + PAST; hit++) faults.push({ point, hit, kind: "kill" });
		expect(faults.length).toBeGreaterThan(0);
		await pool(
			2,
			faults.map((fault) => async () => {
				const killed = await run(act, [[fault]]);
				try {
					const missed = unlanded(fault, { kills: killed.kills, reached: killed.points });
					if (missed !== undefined) throw new Error(missed);
					check(act, killed);
				} catch (error) {
					throw new Error(`killed at ${fault.point} #${fault.hit}: ${(error as Error).message}`);
				}
			}),
		);
	}, 600_000);

	it("holds under thrown keychain faults and kills mixed across processes, generated", async () => {
		const fault = fc.oneof(
			fc.record({
				point: fc.constantFrom<FaultPoint>(...KEYCHAIN),
				hit: fc.integer({ min: 1, max: 16 }),
				kind: fc.constantFrom("kill" as const, "error" as const),
			}),
			fc.record({
				point: fc.constantFrom<FaultPoint>(...COMMIT),
				hit: fc.integer({ min: 1, max: 8 }),
				kind: fc.constant("kill" as const),
			}),
		);
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.array(fault, { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 3 }),
				async (schedules) => {
					check(act, await run(act, schedules));
				},
			),
			{ numRuns: pbtFaultRuns(6) },
		);
	}, 600_000);
});
