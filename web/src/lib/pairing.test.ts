/**
 * Pairing on the phone: a code read, the daemon it names reached, the request made under the phone's name, then the
 * owner's answer waited for; a phone the daemon says was revoked forgets its key, and nothing else makes it forget.
 */
import { describe, expect, it, vi } from "vitest";
import type { PairingState } from "../../../src/server/api.ts";
import { fingerprint, NOTES, type PairingDeps, pairing, readPairingLink } from "./pairing.ts";
import type { BandaPlugin, ShellState } from "./transport.ts";

const LINK = `banda://pair?ticket=${encodeURIComponent("endpointabc+/=")}&invite=${encodeURIComponent("s3cr3t_-")}`;

const rejection = (code: string) => Object.assign(new Error(code), { code });

function rig({
	state = { device: "d".repeat(64), name: "Pixel 9" },
	asked = async () => "pending",
	checks = [],
	scanned = LINK,
}: {
	state?: ShellState;
	asked?: PairingDeps["ask"];
	checks?: (() => Promise<PairingState>)[];
	scanned?: string | Error;
} = {}) {
	const used: string[] = [];
	const asks: [string, string][] = [];
	let forgot = 0;
	let looks = 0;
	// the shell's daemons: the one it keeps, and one a code's ticket is trying
	let kept = state.daemon;
	let trial: string | undefined;
	const shell = {
		state: async () => ({ ...state, ...((trial ?? kept) === undefined ? {} : { daemon: trial ?? kept }) }),
		setDaemon: async ({ ticket }: { ticket: string }) => {
			if (!ticket.startsWith("endpoint")) throw rejection("TICKET");
			used.push(ticket);
			trial = `c${"0".repeat(63)}`;
		},
		keepDaemon: async () => {
			kept = trial ?? kept;
			trial = undefined;
		},
		revertDaemon: async () => {
			trial = undefined;
		},
		forget: async () => {
			forgot++;
			kept = undefined;
			trial = undefined;
		},
	} as unknown as BandaPlugin;
	const flow = pairing({
		shell,
		scanner: {
			scanBarcode: async () => {
				if (scanned instanceof Error) throw scanned;
				return { ScanResult: scanned };
			},
		},
		ask: async (invite, name) => {
			asks.push([invite, name]);
			return asked(invite, name);
		},
		check: async () => {
			const next = checks[Math.min(looks, checks.length - 1)];
			looks++;
			if (next === undefined) throw new Error("no check");
			return next();
		},
		every: 10,
	});
	return { flow, used, asks, forgot: () => forgot, daemon: () => trial ?? kept, kept: () => kept };
}

const settled = async (flow: ReturnType<typeof pairing>, step: string) =>
	vi.waitFor(() => expect(flow.get().step).toBe(step), { timeout: 1000, interval: 5 });

describe("a pairing link", () => {
	it("carries the daemon's ticket and the invite", () => {
		expect(readPairingLink(LINK)).toEqual({ ticket: "endpointabc+/=", invite: "s3cr3t_-" });
	});
	it("is a banda://pair link with both, or nothing", () => {
		for (const text of [
			"https://example.com/pair?ticket=a&invite=b",
			"banda://pair?ticket=a",
			"banda://other?ticket=a&invite=b",
			"banda://pair?ticket=&invite=b",
			"not a url",
		])
			expect(readPairingLink(text)).toBeUndefined();
	});
});

describe("pairing a phone", () => {
	it("does not send a link's invite or accept its daemon before the owner confirms the computer", async () => {
		const phone = rig({ asked: async () => "paired" });
		await phone.flow.start();
		const link = readPairingLink(LINK);
		if (link === undefined) throw new Error("missing test link");
		await phone.flow.pair(link, "P");
		expect(phone.asks).toEqual([]);
		expect(phone.kept()).toBeUndefined();
		expect(phone.flow.get()).toMatchObject({ step: "confirm", computer: `c${"0".repeat(63)}` });
		await phone.flow.confirm();
		expect(phone.asks).toEqual([["s3cr3t_-", "P"]]);
		expect(phone.flow.get().step).toBe("paired");
	});

	it("a trial daemon saying revoked cannot erase the saved computer or the device key", async () => {
		const mine = "a".repeat(64);
		const phone = rig({ state: { daemon: mine, device: "d", name: "P" }, asked: async () => "revoked" });
		await phone.flow.scan("P");
		await phone.flow.confirm();
		expect(phone.forgot()).toBe(0);
		expect(phone.kept()).toBe(mine);
	});

	it("scans, reaches the daemon the code names, asks under the phone's name and waits for approval", async () => {
		const { flow, used, asks } = rig({ checks: [async () => "pending", async () => "paired"] });
		await flow.start();
		expect(flow.get()).toEqual({ step: "scan", name: "Pixel 9" });
		await flow.scan(" Ana's phone ");
		await flow.confirm();
		expect(used).toEqual(["endpointabc+/="]);
		expect(asks).toEqual([["s3cr3t_-", "Ana's phone"]]);
		expect(flow.get()).toEqual({
			step: "waiting",
			name: "Ana's phone",
			device: "d".repeat(64),
			computer: `c${"0".repeat(63)}`,
		});
		await settled(flow, "paired");
	});

	it("shows both fingerprints while it waits, as the owner's computer does", () => {
		expect(fingerprint("a1b2c3d4e5f60718293a4b5c6d7e8f90")).toBe("a1b2 c3d4 e5f6 0718");
	});

	it("keeps a code's daemon only once it approved this phone", async () => {
		const approved = rig({ checks: [async () => "paired"] });
		await approved.flow.start();
		await approved.flow.scan("P");
		await approved.flow.confirm();
		expect(approved.kept()).toBeUndefined();
		await settled(approved.flow, "paired");
		expect(approved.kept()).toBe(`c${"0".repeat(63)}`);
	});

	it("a code never takes a paired phone away from its computer: any answer but approval goes back to it", async () => {
		const mine = "a".repeat(64);
		const answers: [string, PairingDeps["ask"], (() => Promise<PairingState>)[]][] = [
			["refused", () => Promise.reject(Object.assign(new Error("no"), { status: 403 })), []],
			["unreachable", () => Promise.reject(rejection("UNREACHABLE")), []],
			["denied", async () => "pending", [async () => "denied"]],
			["expired", async () => "pending", [async () => "unpaired"]],
		];
		for (const [why, asked, checks] of answers) {
			const phone = rig({ state: { daemon: mine, device: "d", name: "P" }, asked, checks });
			await phone.flow.scan("P");
			await phone.flow.confirm();
			await settled(phone.flow, "scan");
			expect(phone.daemon(), why).toBe(mine);
			expect(phone.kept(), why).toBe(mine);
		}
		// and starting over while it waits goes back too
		const waiting = rig({ state: { daemon: mine, device: "d", name: "P" }, checks: [async () => "pending"] });
		await waiting.flow.scan("P");
		await waiting.flow.confirm();
		await settled(waiting.flow, "waiting");
		waiting.flow.again();
		await vi.waitFor(() => expect(waiting.daemon()).toBe(mine));
	});

	it("ignores a pairing answer that arrives after the owner starts over", async () => {
		let reply!: (state: PairingState) => void;
		const answer = new Promise<PairingState>((resolve) => {
			reply = resolve;
		});
		let checking = false;
		const phone = rig({
			checks: [
				() => {
					checking = true;
					return answer;
				},
			],
		});
		await phone.flow.start();
		await phone.flow.scan("P");
		await phone.flow.confirm();
		await vi.waitFor(() => expect(checking).toBe(true));
		phone.flow.again();
		await settled(phone.flow, "scan");
		reply("paired");
		await answer;
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(phone.flow.get().step).toBe("scan");
		expect(phone.kept()).toBeUndefined();
		phone.flow.stop();
	});

	it("can restart after effect cleanup without accepting the previous start's answer", async () => {
		let reply!: (state: PairingState) => void;
		const old = new Promise<PairingState>((resolve) => {
			reply = resolve;
		});
		let looked = false;
		const phone = rig({
			state: { daemon: "a".repeat(64), device: "d", name: "P" },
			checks: [
				() => {
					looked = true;
					return old;
				},
				async () => "paired",
			],
		});
		const first = phone.flow.start();
		await vi.waitFor(() => expect(looked).toBe(true));
		phone.flow.stop();
		await phone.flow.start();
		expect(phone.flow.get().step).toBe("paired");
		reply("revoked");
		await first;
		expect(phone.forgot()).toBe(0);
		expect(phone.flow.get().step).toBe("paired");
	});

	it("cannot save a new trial with the previous attempt's late approval", async () => {
		let reply!: (state: PairingState) => void;
		const old = new Promise<PairingState>((resolve) => {
			reply = resolve;
		});
		const phone = rig({ asked: () => old });
		await phone.flow.start();
		await phone.flow.scan("P");
		const first = phone.flow.confirm();
		phone.flow.again();
		await settled(phone.flow, "scan");
		await phone.flow.scan("P");
		reply("paired");
		await first;
		expect(phone.flow.get().step).toBe("confirm");
		expect(phone.kept()).toBeUndefined();
		phone.flow.stop();
	});

	it("opens at once on a phone already paired", async () => {
		const { flow } = rig({ state: { daemon: "a".repeat(64), device: "d", name: "P" }, checks: [async () => "paired"] });
		await flow.start();
		expect(flow.get().step).toBe("paired");
	});

	it("says why when the owner denied it, or the code expired while it waited", async () => {
		const denied = rig({ checks: [async () => "denied"] });
		await denied.flow.start();
		await denied.flow.scan("P");
		await denied.flow.confirm();
		await settled(denied.flow, "scan");
		expect(denied.flow.get()).toMatchObject({ note: NOTES.denied });

		const expired = rig({ checks: [async () => "unpaired"] });
		await expired.flow.start();
		await expired.flow.scan("P");
		await expired.flow.confirm();
		await settled(expired.flow, "scan");
		expect(expired.flow.get()).toMatchObject({ note: NOTES.expired });
	});

	it("keeps waiting through a moment the daemon is away", async () => {
		const { flow } = rig({
			checks: [() => Promise.reject(rejection("UNREACHABLE")), async () => "pending", async () => "paired"],
		});
		await flow.start();
		await flow.scan("P");
		await flow.confirm();
		await settled(flow, "paired");
	});

	it("forgets its key when the daemon says it was revoked, so it pairs again as a new device", async () => {
		const answered = rig({
			state: { daemon: "a".repeat(64), device: "d", name: "P" },
			checks: [async () => "revoked"],
		});
		await answered.flow.start();
		expect(answered.forgot()).toBe(1);
		expect(answered.flow.get()).toMatchObject({ step: "scan", note: NOTES.revoked });
	});

	it("keeps its key whatever a rejection says: only the daemon's answer that it was revoked forgets it", async () => {
		// a connection closed under it (the daemon restarting, or letting go of it) is no answer about this device
		for (const code of ["REFUSED", "BROKEN", "UNREACHABLE"]) {
			const started = rig({
				state: { daemon: "a".repeat(64), device: "d", name: "P" },
				checks: [() => Promise.reject(rejection(code))],
			});
			await started.flow.start();
			expect(started.forgot()).toBe(0);
			expect(started.flow.get().step).toBe("unreachable");

			const waiting = rig({ checks: [() => Promise.reject(rejection(code)), async () => "paired"] });
			await waiting.flow.start();
			await waiting.flow.scan("P");
			await waiting.flow.confirm();
			await settled(waiting.flow, "paired");
			expect(waiting.forgot()).toBe(0);

			const asking = rig({ asked: () => Promise.reject(rejection(code)) });
			await asking.flow.start();
			await asking.flow.scan("P");
			await asking.flow.confirm();
			expect(asking.forgot()).toBe(0);
			expect(asking.flow.get()).toMatchObject({ step: "scan", note: NOTES.unreachable });
		}
	});

	it("tells a daemon away from one refusing: a paired phone that cannot reach it offers to try again", async () => {
		const { flow, forgot } = rig({
			state: { daemon: "a".repeat(64), device: "d", name: "P" },
			checks: [() => Promise.reject(rejection("UNREACHABLE"))],
		});
		await flow.start();
		expect(flow.get().step).toBe("unreachable");
		expect(forgot()).toBe(0);
	});

	it("shows the daemon's words when it refuses the invite, and its own when it cannot reach it", async () => {
		const refused = rig({
			asked: () => Promise.reject(Object.assign(new Error("this invite expired"), { status: 403 })),
		});
		await refused.flow.start();
		await refused.flow.scan("P");
		await refused.flow.confirm();
		expect(refused.flow.get()).toMatchObject({ step: "scan", note: "this invite expired" });

		const away = rig({ asked: () => Promise.reject(rejection("UNREACHABLE")) });
		await away.flow.start();
		await away.flow.scan("P");
		await away.flow.confirm();
		expect(away.flow.get()).toMatchObject({ step: "scan", note: NOTES.unreachable });
	});

	it("asks nothing for a code that is not banda's, and stays put when the scan is closed", async () => {
		const other = rig({ scanned: "https://example.com" });
		await other.flow.start();
		await other.flow.scan("P");
		await other.flow.confirm();
		expect(other.asks).toEqual([]);
		expect(other.flow.get()).toMatchObject({ step: "scan", note: NOTES.notACode });

		const closed = rig({ scanned: new Error("cancelled") });
		await closed.flow.start();
		await closed.flow.scan("P");
		await closed.flow.confirm();
		// the screen as it was: the name typed stays in its field
		expect(closed.flow.get()).toEqual({ step: "scan", name: "Pixel 9" });
	});

	it("pairs with a link the phone was opened with, without the camera", async () => {
		const { flow, asks } = rig({ state: { device: "d", name: "Pixel 9", link: LINK } });
		await flow.start();
		const step = flow.get();
		expect(step).toMatchObject({ step: "scan", link: { invite: "s3cr3t_-" } });
		if (step.step !== "scan" || step.link === undefined) throw new Error("no link");
		await flow.pair(step.link, "Pixel 9");
		await flow.confirm();
		expect(asks).toEqual([["s3cr3t_-", "Pixel 9"]]);

		const later = rig();
		await later.flow.start();
		later.flow.opened(LINK);
		expect(later.flow.get()).toMatchObject({ step: "scan", link: { ticket: "endpointabc+/=" } });
	});
});
