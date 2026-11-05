import { describe, expect, it } from "vitest";
import type { DevicesValue } from "../src/core/devices.ts";
import type { Fault } from "./fault/faults.ts";
import { checkDeviceInvariants } from "./fault/invariants.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";

const PHONE = "a".repeat(64);
const STRANGER = "b".repeat(64);
const TABLET = "c".repeat(64);

type Summary = {
	answers: { [step: string]: { status: number; body: unknown } };
	doc: DevicesValue;
	states: { [id: string]: string };
	paired: { phone: boolean; tablet: boolean };
	now: number;
	commits: number;
};

const run = async (schedules: readonly (readonly Fault[])[]) => {
	const { last, kills } = await runWorker("test/fault/devices-worker.ts", [await tempHome()], schedules);
	return { summary: last as Summary, kills };
};

const check = ({ summary }: Awaited<ReturnType<typeof run>>) => {
	checkDeviceInvariants(summary.doc, summary.now);
	const { answers, doc } = summary;
	// the phone waited, then was paired by the owner's approval, then revoked; never refused before that
	expect([200, 202]).toContain(answers.phone?.status);
	expect(answers.approvedPhone).toEqual({ status: 200, body: { state: "paired" } });
	expect(answers.revokedPhone?.status).toBe(403);
	expect(doc.devices[PHONE]).toMatchObject({ name: "Pixel", revoked: expect.any(Number) });
	// single use: the stranger never claimed either secret; the tablet's was spent by the denial
	expect(answers.stranger?.status).toBe(403);
	expect(answers.strangerSecond?.status).toBe(403);
	expect(answers.deniedTablet?.status).toBe(403);
	expect(Object.keys(doc.devices)).toEqual([PHONE]);
	expect(doc.requests).toEqual({});
	expect(summary.states).toEqual({ [PHONE]: "revoked", [STRANGER]: "unpaired", [TABLET]: "denied" });
	expect(summary.paired).toEqual({ phone: false, tablet: false });
};

describe("pairing devices under faults", () => {
	it("sweep: a kill before or after every commit, the pairing and the approval among them, keeps pairing whole", async () => {
		const clean = await run([]);
		check(clean);
		expect(clean.kills).toBe(0);
		const faults: Fault[] = [];
		for (let hit = 1; hit <= clean.summary.commits; hit++)
			faults.push({ point: "commit:before", hit, kind: "kill" }, { point: "commit:after", hit, kind: "kill" });
		await pool(
			2,
			faults.map((fault) => async () => {
				const ran = await run([[fault]]);
				check(ran);
				expect(ran.kills).toBe(1);
			}),
		);
	}, 300_000);
});
