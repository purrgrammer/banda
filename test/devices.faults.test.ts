import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, type Harness, SessionFailed } from "@earendil-works/pi-durable";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Devices, type DevicesValue } from "../src/core/devices.ts";
import { context, openStore } from "../src/core/store.ts";
import type { InviteView } from "../src/server/api.ts";
import { openDevices } from "../src/server/devices.ts";
import type { Remote } from "../src/server/remote.ts";
import { type Fault, Faults, InjectedFault } from "./fault/faults.ts";
import { checkDeviceInvariants } from "./fault/invariants.ts";
import { pool, runWorker } from "./fault/kill.ts";
import { tempHome } from "./helpers.ts";
import { pbtFaultRuns } from "./pbt.ts";

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

	it("property: thrown faults at any commit, owners and endpoints acting in any order, keep pairing whole", async () => {
		const ENDPOINTS = [PHONE, STRANGER, TABLET];
		type Act =
			| { readonly act: "invite" }
			| { readonly act: "pair"; readonly who: number; readonly invite: number }
			| { readonly act: "approve" | "deny" | "revoke"; readonly who: number }
			| { readonly act: "tick"; readonly ms: number };
		const who = fc.integer({ min: 0, max: ENDPOINTS.length - 1 });
		const acts = fc.array(
			fc.oneof(
				fc.constant<Act>({ act: "invite" }),
				fc.record({ act: fc.constant("pair" as const), who, invite: fc.integer({ min: 0, max: 3 }) }),
				fc.record({ act: fc.constantFrom("approve" as const, "deny" as const, "revoke" as const), who }),
				fc.record({ act: fc.constant("tick" as const), ms: fc.integer({ min: 0, max: 11 * 60_000 }) }),
			),
			{ minLength: 1, maxLength: 14 },
		);
		const schedule = fc.array(
			fc.record({
				point: fc.constantFrom("commit:before" as const, "commit:after" as const),
				hit: fc.integer({ min: 1, max: 6 }),
				kind: fc.constant("error" as const),
			}),
			{ maxLength: 4 },
		);
		await fc.assert(
			fc.asyncProperty(acts, schedule, async (steps, schedule) => {
				const home = await tempHome();
				const faults = new Faults(schedule);
				let now = 1_000_000;
				const remote = { id: "d".repeat(64), reach: "loopback", ticket: async () => "t" } as unknown as Remote;
				let harness: Harness | undefined;
				let desk: ReturnType<typeof openDevices> | undefined;
				/** Open the store again after a fault, as the daemon does at its next start; an open can fault too. */
				const reopen = async () => {
					await harness?.close(context).catch(() => undefined);
					for (;;) {
						try {
							harness = await openStore(home, {
								models: createModels(),
								registry: createRegistry(),
								wrapStorage: (storage) => faults.storage(storage),
							});
							desk = openDevices({ harness, remote: () => remote, changed: () => {}, now: () => now });
							return;
						} catch (error) {
							if (!(error instanceof InjectedFault)) throw error;
						}
					}
				};
				const faulted = (error: unknown) => error instanceof InjectedFault || error instanceof SessionFailed;
				/** Run `step` once; a fault reopens the store, and the person sees an error, as a refusal shows one. */
				const once = async (step: () => Promise<unknown>) => {
					try {
						await step();
					} catch (error) {
						if (faulted(error)) await reopen();
					}
				};
				/** Read until the read gets through. */
				const read = async <T>(step: () => Promise<T>): Promise<T> => {
					for (;;) {
						try {
							return await step();
						} catch (error) {
							if (!faulted(error)) throw error;
							await reopen();
						}
					}
				};
				const call = (method: string, path: string, body: Record<string, unknown> = {}) =>
					({ method, path, url: new URL(`http://local/api${path}`), json: async () => body }) as never;
				const route = (method: string, path: string) => {
					const routes = desk?.area.route;
					if (routes === undefined) throw new Error("the devices area has no routes");
					return routes(call(method, path));
				};
				const secrets: string[] = [];
				/** Who the owner ever asked to approve, and who they revoked and saw it answered. */
				const approvedAsked = new Set<string>();
				const revoked = new Set<string>();
				await reopen();
				try {
					for (const step of steps) {
						if (step.act === "tick") now += step.ms;
						else if (step.act === "invite")
							await once(async () =>
								secrets.push(((await route("POST", "/devices/invites")) as { body: InviteView }).body.secret),
							);
						else if (step.act === "pair") {
							const secret = secrets[step.invite] ?? "never-made";
							await once(() =>
								(desk as NonNullable<typeof desk>).gate.pair(
									ENDPOINTS[step.who] as string,
									call("POST", "/devices/pair", { invite: secret }),
								),
							);
						} else {
							const id = ENDPOINTS[step.who] as string;
							if (step.act === "approve") approvedAsked.add(id);
							const path = step.act === "revoke" ? `/devices/${id}/revoke` : `/devices/requests/${id}/${step.act}`;
							await once(async () => {
								await route("POST", path);
								if (step.act === "revoke") revoked.add(id);
							});
						}
						const doc = await read(() => (harness as Harness).snapshot(Devices, context));
						checkDeviceInvariants(doc as DevicesValue | undefined, now);
						for (const id of ENDPOINTS) {
							const paired = await read(() => (desk as NonNullable<typeof desk>).gate.paired(id));
							// only the owner's approval pairs, and a revoke the owner saw answered holds for good
							if (paired) expect(approvedAsked.has(id), `${id} paired unasked`).toBe(true);
							if (revoked.has(id)) expect(paired, `${id} paired after its revoke`).toBe(false);
						}
					}
				} finally {
					await harness?.close(context).catch(() => undefined);
				}
			}),
			{ numRuns: pbtFaultRuns(30) },
		);
	}, 300_000);
});
