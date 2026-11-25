/**
 * A key on the clipboard (H-271, UC-02 step 3): cleared a minute after it was copied, wherever the app went in the
 * meantime, and tried at once when the page goes away; cleared only while it still holds the key, where the page may
 * read it without asking; a clear the browser refuses (the page not in front) is tried again when the page comes back.
 * Its time runs here, outside any page, so leaving the page that copied it leaves the clear due. A browser refuses a
 * page that is closing, so there the clear holds only while banda stays open (`clearsWithPage`); in the desktop app
 * its main process keeps the clear. It keeps only the SHA-256 of what it copied, never the key itself (H-274): what the
 * clipboard holds is compared by its digest.
 */
import { desktop } from "../lib/desktop.ts";

/** How long a copied key stays on the clipboard: the same as the desktop app's main process holds (`CLIPBOARD_CLEAR`). */
const CLIPBOARD_CLEAR = 60_000;

/** The clipboard, as this module uses it. */
type Clip = {
	readonly write: (text: string) => Promise<void>;
	/** What it holds; undefined where the page may not read it without a prompt, which is never asked for. */
	readonly read: () => Promise<string | undefined>;
};

export type ClipboardDeps = {
	readonly clip: Clip;
	readonly now: () => number;
	/** Calls `run` every `ms` until the answer is called; `run` answers the clear it started, if any. */
	readonly repeat: (run: () => Promise<void> | undefined, ms: number) => () => void;
	/**
	 * Calls `run` when the page comes back to the front (`back`) or goes away (`gone`), until the answer is called;
	 * `run` answers the clear it started, if any.
	 */
	readonly on: (event: "back" | "gone", run: () => Promise<void> | undefined) => () => void;
	readonly ms?: number;
};

type SecretClipboard = {
	/** Puts `text` on the clipboard, to be cleared; throws when the clipboard refused it. */
	readonly copy: (text: string) => Promise<void>;
	/** The seconds until the clear, while one is due. */
	readonly left: () => number | undefined;
	readonly subscribe: (listener: () => void) => () => void;
	/** Clears it now, while it still holds what was copied. */
	readonly clear: () => Promise<void>;
};

/** The SHA-256 of `text`, in hex. */
async function digestOf(text: string): Promise<string> {
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function secretClipboard(deps: ClipboardDeps): SecretClipboard {
	const ms = deps.ms ?? CLIPBOARD_CLEAR;
	let held: { readonly digest: string; readonly until: number } | undefined;
	let left: number | undefined;
	let refused = false;
	let clearing: Promise<void> | undefined;
	let stops: (() => void)[] = [];
	const listeners = new Set<() => void>();
	const show = () => {
		const next = held === undefined ? undefined : Math.max(0, Math.ceil((held.until - deps.now()) / 1000));
		if (next === left) return;
		left = next;
		for (const listener of listeners) listener();
	};
	const end = () => {
		held = undefined;
		refused = false;
		for (const stop of stops) stop();
		stops = [];
		show();
	};
	const clear = (): Promise<void> => {
		const digest = held?.digest;
		if (digest === undefined) return Promise.resolve();
		clearing ??= (async () => {
			try {
				const holds = await deps.clip.read().catch(() => undefined);
				// the owner copied something else since: it is theirs, and stays
				if (holds === undefined || (await digestOf(holds)) === digest) await deps.clip.write("");
				if (held?.digest === digest) end();
			} catch {
				refused = true;
			} finally {
				clearing = undefined;
			}
		})();
		return clearing;
	};
	const due = () => held !== undefined && (refused || deps.now() >= held.until);
	return {
		async copy(text) {
			const digest = await digestOf(text);
			await deps.clip.write(text);
			for (const stop of stops) stop();
			held = { digest, until: deps.now() + ms };
			refused = false;
			stops = [
				deps.repeat(() => {
					const cleared = due() ? clear() : undefined;
					show();
					return cleared;
				}, 1000),
				deps.on("back", () => (due() ? clear() : undefined)),
				deps.on("gone", () => clear()),
			];
			show();
		},
		left: () => left,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		clear,
	};
}

/** Whether the page may read the clipboard without a prompt. */
async function readable(): Promise<boolean> {
	try {
		return (await navigator.permissions.query({ name: "clipboard-read" as PermissionName })).state === "granted";
	} catch {
		return false;
	}
}

/**
 * Whether the clear needs this page open: in a browser it does, since a page going away cannot write the clipboard any
 * more; banda's desktop app keeps the clear in its own process, past the page and until it quits.
 */
export const clearsWithPage = desktop?.copySecret === undefined;

/** The clipboard, for a key copied in this page: through the desktop app where the page runs in it. */
export const clipboard: SecretClipboard = secretClipboard({
	clip: {
		write: (text) =>
			desktop?.copySecret === undefined ? navigator.clipboard.writeText(text) : desktop.copySecret(text),
		read: async () => ((await readable()) ? navigator.clipboard.readText() : undefined),
	},
	now: () => Date.now(),
	repeat: (run, ms) => {
		const timer = setInterval(run, ms);
		return () => clearInterval(timer);
	},
	on: (event, run) => {
		if (event === "gone") {
			addEventListener("pagehide", run);
			return () => removeEventListener("pagehide", run);
		}
		const visible = () => {
			if (document.visibilityState === "visible") run();
		};
		addEventListener("focus", run);
		document.addEventListener("visibilitychange", visible);
		return () => {
			removeEventListener("focus", run);
			document.removeEventListener("visibilitychange", visible);
		};
	},
});
