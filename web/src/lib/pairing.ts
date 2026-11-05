/**
 * Pairing, as the phone sees it (the native shell; the owner's side is Settings → Devices). The phone scans the code
 * the owner's computer shows, a `banda://pair` link: its ticket says which daemon to reach, its invite lets this
 * device ask once. The phone asks under a name, then waits for the owner to approve it there; once approved it is a
 * device, and the app opens. A device the daemon says was revoked (`GET /api/devices/pair`) forgets its key and pairs
 * again as a new one; nothing else makes it forget, since a connection closed under it says nothing about this device.
 *
 * A code's daemon is only tried until it answers: the shell keeps it once it approved this phone, and goes back to the
 * daemon it had for any other answer, so a code (or a `banda://pair` link) never takes a paired phone away from its
 * computer. Before sending the invite, the owner compares the ticket's computer with the desktop. While it waits, both screens show the same fingerprints, this phone's and the computer's: the owner
 * approves the phone whose fingerprint they read on it, not the name it asked under.
 */
import type { PairingState } from "../../../src/server/api.ts";
import type { BandaPlugin, ScannerPlugin } from "./transport.ts";

/** An endpoint id as people compare it: its first 16 hex digits, in fours. */
export const fingerprint = (id: string) => (id.slice(0, 16).match(/.{1,4}/g) ?? []).join(" ");

/** What a pairing code carries. */
export type PairingLink = { readonly ticket: string; readonly invite: string };

/** The ticket and invite a `banda://pair` link carries; undefined when the text is not one. */
export function readPairingLink(text: string): PairingLink | undefined {
	let url: URL;
	try {
		url = new URL(text.trim());
	} catch {
		return undefined;
	}
	if (url.protocol !== "banda:" || url.host !== "pair") return undefined;
	const ticket = url.searchParams.get("ticket");
	const invite = url.searchParams.get("invite");
	return ticket === null || invite === null || ticket === "" || invite === "" ? undefined : { ticket, invite };
}

/** Where pairing stands, as the phone's screen shows it. */
export type PairingStep =
	| { readonly step: "checking" }
	/** Not a device yet: scan the code (or pair with the link the shell was opened with). `note` says why, if it is new. */
	| { readonly step: "scan"; readonly name: string; readonly link?: PairingLink; readonly note?: string }
	/** `device` is this phone's endpoint id, `computer` the daemon's, once the code's ticket was read. */
	| {
			readonly step: "confirm";
			readonly name: string;
			readonly device: string;
			readonly computer: string;
			readonly link: PairingLink;
	  }
	| { readonly step: "asking"; readonly name: string; readonly device: string; readonly computer?: string }
	| { readonly step: "waiting"; readonly name: string; readonly device: string; readonly computer?: string }
	/** Paired before, and the daemon cannot be reached now. */
	| { readonly step: "unreachable" }
	| { readonly step: "paired" };

export type PairingDeps = {
	readonly shell: BandaPlugin;
	readonly scanner?: ScannerPlugin | undefined;
	/** `POST /api/devices/pair`: ask under `name` with `invite`. */
	readonly ask: (invite: string, name: string) => Promise<PairingState>;
	/** `GET /api/devices/pair`: where this device stands. */
	readonly check: () => Promise<PairingState>;
	/** How long between looks while waiting for the owner. */
	readonly every?: number;
};

export const NOTES = {
	revoked: "This phone was removed from banda. Scan a new code to pair it again.",
	denied: "Your computer did not approve this phone. Scan a new code to ask again.",
	expired: "The code expired before it was approved. Make a new one on your computer and scan it.",
	unreachable: "Could not reach your computer. Check that it is on and banda is running, then scan again.",
	notACode: "That is not a banda pairing code. Scan the one Settings → Devices shows on your computer.",
	noCamera: "This phone cannot scan codes. Open the code's link on this phone instead.",
} as const;

/** The daemon's own words for a refusal it answered (`Refused` in `api.ts`), if it answered one. */
const refusalOf = (error: unknown) =>
	error instanceof Error && "status" in error && typeof error.status === "number" && error.status < 500
		? error.message
		: undefined;

/** Pairing's steps, driven by the screen: `start`, then `scan` or `pair`, and `retry` when the daemon was away. */
export function pairing({ shell, scanner, ask, check, every = 2000 }: PairingDeps) {
	let current: PairingStep = { step: "checking" };
	let name = "";
	let device = "";
	let computer: string | undefined;
	/** A code's daemon is being tried: the shell has not kept it. */
	let trying = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	let attempt = 0;
	const listeners = new Set<() => void>();
	const active = (at: number) => !stopped && at === attempt;
	// The native shell owns one trial: never let another attempt replace it during keep/revert/state.
	let shellWork: Promise<unknown> = Promise.resolve();
	const withShell = (at: number, run: () => Promise<void>) => {
		const work = shellWork.then(async () => {
			if (active(at)) await run();
		});
		shellWork = work.catch(() => undefined);
		return work;
	};
	const go = (next: PairingStep) => {
		if (stopped) return;
		current = next;
		for (const listener of listeners) listener();
	};
	const toScan = (note?: string, link?: PairingLink) =>
		go({ step: "scan", name, ...(link === undefined ? {} : { link }), ...(note === undefined ? {} : { note }) });

	const asking = (step: "asking" | "waiting") =>
		go({ step, name, device, ...(computer === undefined ? {} : { computer }) });

	/** Back to the daemon the shell had before the code: the one tried did not take this phone. */
	const untry = async () => {
		if (!trying) return;
		await shell.revertDaemon();
		trying = false;
	};

	/** Apply an answer only to the attempt that asked, while its native trial is held exclusively. */
	const settle = (state: PairingState, waited: boolean, at: number) =>
		withShell(at, async () => {
			if (state === "paired") {
				if (trying) {
					await shell.keepDaemon();
					trying = false;
				}
				if (active(at)) go({ step: "paired" });
			} else if (state === "pending") wait();
			else if (state === "revoked") {
				if (trying) await untry();
				else await shell.forget();
				if (active(at)) toScan(NOTES.revoked);
			} else {
				await untry();
				if (active(at)) toScan(waited ? (state === "denied" ? NOTES.denied : NOTES.expired) : undefined);
			}
		});

	const wait = () => {
		if (stopped) return;
		const at = attempt;
		asking("waiting");
		clearTimeout(timer);
		timer = setTimeout(async () => {
			try {
				const state = await check();
				if (!stopped && at === attempt) await settle(state, true, at);
			} catch {
				// the daemon away for a moment: look again, unless the owner cancelled this attempt
				if (!stopped && at === attempt) wait();
			}
		}, every);
	};

	const pair = async (link: PairingLink, as: string) => {
		const at = ++attempt;
		clearTimeout(timer);
		name = as.trim();
		computer = undefined;
		asking("asking");
		await withShell(at, async () => {
			await untry();
			if (!active(at)) return;
			try {
				await shell.setDaemon({ ticket: link.ticket });
			} catch {
				if (active(at)) toScan(NOTES.notACode);
				return;
			}
			trying = true;
			if (!active(at)) return;
			try {
				const state = await shell.state();
				if (!active(at)) return;
				device = state.device;
				computer = state.daemon;
				if (computer === undefined) throw new Error("the ticket has no computer");
				go({ step: "confirm", name, device, computer, link });
			} catch (error) {
				await untry();
				if (active(at)) toScan(refusalOf(error) ?? NOTES.unreachable);
			}
		});
	};

	return {
		get: () => current,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** Read where the shell stands, and if it has a daemon, where this device stands there. */
		async start() {
			stopped = false;
			const at = ++attempt;
			clearTimeout(timer);
			go({ step: "checking" });
			let linked: PairingLink | undefined;
			let known = false;
			await withShell(at, async () => {
				await untry();
				const state = await shell.state();
				if (!active(at)) return;
				name = name === "" ? state.name : name;
				device = state.device;
				computer = state.daemon;
				linked = state.link === undefined ? undefined : readPairingLink(state.link);
				known = state.daemon !== undefined;
				if (!known) toScan(undefined, linked);
			});
			if (!active(at) || !known) return;
			try {
				await settle(await check(), false, at);
				if (active(at) && linked !== undefined && current.step === "scan") toScan(undefined, linked);
			} catch {
				if (active(at)) go({ step: "unreachable" });
			}
		},
		/** A link opened the shell while it was waiting to be scanned. */
		opened(url: string) {
			const link = readPairingLink(url);
			if (link !== undefined && current.step === "scan") toScan(undefined, link);
		},
		/** Scan the code with the camera, then ask under `as`. */
		async scan(as: string) {
			const at = ++attempt;
			name = as.trim();
			if (scanner === undefined) return toScan(NOTES.noCamera);
			let text: string;
			try {
				text = (
					await scanner.scanBarcode({
						hint: 0,
						scanInstructions: "Point at the code on your computer",
						scanButton: false,
						scanText: " ",
						cameraDirection: 1,
						scanOrientation: 3,
					})
				).ScanResult;
			} catch {
				// closed without a code
				return;
			}
			if (!active(at)) return;
			const link = readPairingLink(text);
			if (link === undefined) return toScan(NOTES.notACode);
			await pair(link, name);
		},
		pair,
		/** Only the owner comparing the ticket's computer with the desktop sends the invite. */
		async confirm() {
			if (stopped || current.step !== "confirm") return;
			const at = attempt;
			const { link } = current;
			asking("asking");
			try {
				await settle(await ask(link.invite, name), false, at);
			} catch (error) {
				await withShell(at, async () => {
					await untry();
					if (active(at)) toScan(refusalOf(error) ?? NOTES.unreachable);
				});
			}
		},
		/** Back to scanning, from waiting or from an unreachable daemon. */
		again: () => {
			const at = ++attempt;
			clearTimeout(timer);
			go({ step: "checking" });
			void withShell(at, async () => {
				await untry();
				if (active(at)) toScan();
			});
		},
		stop() {
			stopped = true;
			attempt++;
			clearTimeout(timer);
			listeners.clear();
		},
	};
}

export type Pairing = ReturnType<typeof pairing>;
