/**
 * Pairing, as the phone sees it (the native shell; the owner's side is Settings → Devices). The phone scans the code
 * the owner's computer shows, a `banda://pair` link: its ticket says which daemon to reach, its invite lets this
 * device ask once. The phone asks under a name, then waits for the owner to approve it there; once approved it is a
 * device, and the app opens. A device the daemon says was revoked (`GET /api/devices/pair`) forgets its key and pairs
 * again as a new one; nothing else makes it forget, since a connection closed under it says nothing about this device.
 */
import type { PairingState } from "../../../src/server/api.ts";
import type { BandaPlugin, ScannerPlugin } from "./transport.ts";

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
	| { readonly step: "asking"; readonly name: string }
	| { readonly step: "waiting"; readonly name: string }
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
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	const listeners = new Set<() => void>();
	const go = (next: PairingStep) => {
		if (stopped) return;
		current = next;
		for (const listener of listeners) listener();
	};
	const toScan = (note?: string, link?: PairingLink) =>
		go({ step: "scan", name, ...(link === undefined ? {} : { link }), ...(note === undefined ? {} : { note }) });

	const forgotten = async () => {
		await shell.forget().catch(() => undefined);
		toScan(NOTES.revoked);
	};

	/** Where this device stands now, as the daemon answered. */
	const settle = async (state: PairingState, waited: boolean) => {
		if (state === "paired") go({ step: "paired" });
		else if (state === "pending") wait();
		else if (state === "revoked") await forgotten();
		else if (state === "denied") toScan(waited ? NOTES.denied : undefined);
		else toScan(waited ? NOTES.expired : undefined);
	};

	const wait = () => {
		go({ step: "waiting", name });
		clearTimeout(timer);
		timer = setTimeout(async () => {
			try {
				await settle(await check(), true);
			} catch {
				// the daemon away for a moment: look again
				wait();
			}
		}, every);
	};

	const pair = async (link: PairingLink, as: string) => {
		name = as.trim();
		go({ step: "asking", name });
		try {
			await shell.setDaemon({ ticket: link.ticket });
		} catch {
			return toScan(NOTES.notACode);
		}
		try {
			await settle(await ask(link.invite, name), false);
		} catch (error) {
			toScan(refusalOf(error) ?? NOTES.unreachable);
		}
	};

	return {
		get: () => current,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** Read where the shell stands, and if it has a daemon, where this device stands there. */
		async start() {
			go({ step: "checking" });
			const state = await shell.state();
			name = name === "" ? state.name : name;
			const link = state.link === undefined ? undefined : readPairingLink(state.link);
			if (state.daemon === undefined) return toScan(undefined, link);
			try {
				await settle(await check(), false);
				if (link !== undefined && current.step === "scan") toScan(undefined, link);
			} catch {
				go({ step: "unreachable" });
			}
		},
		/** A link opened the shell while it was waiting to be scanned. */
		opened(url: string) {
			const link = readPairingLink(url);
			if (link !== undefined && current.step === "scan") toScan(undefined, link);
		},
		/** Scan the code with the camera, then ask under `as`. */
		async scan(as: string) {
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
			const link = readPairingLink(text);
			if (link === undefined) return toScan(NOTES.notACode);
			await pair(link, name);
		},
		pair,
		/** Back to scanning, from waiting or from an unreachable daemon. */
		again: () => {
			clearTimeout(timer);
			toScan();
		},
		stop() {
			stopped = true;
			clearTimeout(timer);
			listeners.clear();
		},
	};
}

export type Pairing = ReturnType<typeof pairing>;
