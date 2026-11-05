/**
 * Pairing on the phone: a code read, the daemon it names reached, the request made under the phone's name, then the
 * owner's answer waited for; a revoked phone forgets its key, and a daemon away is told apart from one refusing.
 */
import { describe, expect, it, vi } from "vitest";
import type { PairingState } from "../../../src/server/api.ts";
import { NOTES, type PairingDeps, pairing, readPairingLink } from "./pairing.ts";
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
	const shell = {
		state: async () => state,
		setDaemon: async ({ ticket }: { ticket: string }) => {
			if (!ticket.startsWith("endpoint")) throw rejection("TICKET");
			used.push(ticket);
		},
		forget: async () => {
			forgot++;
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
	return { flow, used, asks, forgot: () => forgot };
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
	it("scans, reaches the daemon the code names, asks under the phone's name and waits for approval", async () => {
		const { flow, used, asks } = rig({ checks: [async () => "pending", async () => "paired"] });
		await flow.start();
		expect(flow.get()).toEqual({ step: "scan", name: "Pixel 9" });
		await flow.scan(" Ana's phone ");
		expect(used).toEqual(["endpointabc+/="]);
		expect(asks).toEqual([["s3cr3t_-", "Ana's phone"]]);
		expect(flow.get()).toEqual({ step: "waiting", name: "Ana's phone" });
		await settled(flow, "paired");
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
		await settled(denied.flow, "scan");
		expect(denied.flow.get()).toMatchObject({ note: NOTES.denied });

		const expired = rig({ checks: [async () => "unpaired"] });
		await expired.flow.start();
		await expired.flow.scan("P");
		await settled(expired.flow, "scan");
		expect(expired.flow.get()).toMatchObject({ note: NOTES.expired });
	});

	it("keeps waiting through a moment the daemon is away", async () => {
		const { flow } = rig({
			checks: [() => Promise.reject(rejection("UNREACHABLE")), async () => "pending", async () => "paired"],
		});
		await flow.start();
		await flow.scan("P");
		await settled(flow, "paired");
	});

	it("forgets its key when it was revoked, so it pairs again as a new device", async () => {
		const answered = rig({
			state: { daemon: "a".repeat(64), device: "d", name: "P" },
			checks: [async () => "revoked"],
		});
		await answered.flow.start();
		expect(answered.forgot()).toBe(1);
		expect(answered.flow.get()).toMatchObject({ step: "scan", note: NOTES.revoked });

		// the daemon closes a revoked device's connection at accept: the shell says REFUSED
		const closed = rig({
			state: { daemon: "a".repeat(64), device: "d", name: "P" },
			checks: [() => Promise.reject(rejection("REFUSED"))],
		});
		await closed.flow.start();
		expect(closed.forgot()).toBe(1);
		expect(closed.flow.get()).toMatchObject({ step: "scan", note: NOTES.revoked });
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
		expect(refused.flow.get()).toMatchObject({ step: "scan", note: "this invite expired" });

		const away = rig({ asked: () => Promise.reject(rejection("UNREACHABLE")) });
		await away.flow.start();
		await away.flow.scan("P");
		expect(away.flow.get()).toMatchObject({ step: "scan", note: NOTES.unreachable });
	});

	it("asks nothing for a code that is not banda's, and stays put when the scan is closed", async () => {
		const other = rig({ scanned: "https://example.com" });
		await other.flow.start();
		await other.flow.scan("P");
		expect(other.asks).toEqual([]);
		expect(other.flow.get()).toMatchObject({ step: "scan", note: NOTES.notACode });

		const closed = rig({ scanned: new Error("cancelled") });
		await closed.flow.start();
		await closed.flow.scan("P");
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
		expect(asks).toEqual([["s3cr3t_-", "Pixel 9"]]);

		const later = rig();
		await later.flow.start();
		later.flow.opened(LINK);
		expect(later.flow.get()).toMatchObject({ step: "scan", link: { ticket: "endpointabc+/=" } });
	});
});
