/**
 * What the desktop app adds to the page (desktop/src/preload.cts), when the page runs in it: the system's own folder
 * dialog, the tray's dot, and a wallet's key shown in a window of its own. Undefined in a browser.
 */
type Desktop = {
	/** The folder the owner picked, opened at `at`; undefined when they cancelled. */
	readonly chooseFolder: (at?: string) => Promise<string | undefined>;
	/** What waits on the owner now, which the tray shows as a dot: chats with an open ask, and unread messages. */
	readonly attention: (attention: { asks: number; unread: number }) => void;
	/** Show the backup `name` in the system's file manager; false when there is none by that name. */
	readonly revealBackup?: (name: string) => Promise<boolean>;
	/** Quit banda, its daemon too, and start it again: how a restore made ready takes the home's place. */
	readonly restart?: () => Promise<void>;
	/**
	 * Whether this computer asks the owner who they are (Touch ID on a Mac): without it, the app shows a wallet's key only
	 * as it is made, and refuses a later reveal, a Restore and a move of signing (OD-2, H-266).
	 */
	readonly reauthenticates?: boolean;
	/**
	 * Show a wallet's key in a window of its own, after the system asks the owner who they are; the key never comes to
	 * this page. A fixed code when it was not shown.
	 */
	readonly revealKey?: (address: string) => Promise<{ ok: true } | { ok: false; code: string }>;
	/**
	 * Put a key on the clipboard, cleared a minute later and when banda quits, whatever this page does meanwhile; empty
	 * text clears it now, while it still holds the key.
	 */
	readonly copySecret?: (text: string) => Promise<void>;
	/** Keep this window from screen capture, or let it be captured again: on while a new wallet's key is shown (H-270). */
	readonly protectScreen?: (on: boolean) => Promise<void>;
	/**
	 * Keep the key the owner saved for a wallet whose keychain item is gone, after the system asks the owner who they
	 * are, only if it opens the wallet's address; the key never reaches the daemon. A fixed code when it was not kept.
	 */
	readonly restoreKey?: (address: string, key: string) => Promise<{ ok: true } | { ok: false; code: string }>;
	/** Move the home's signing here, once the key of each of its wallets here proved it opens its wallet. */
	readonly moveSigning?: () => Promise<{ ok: true } | { ok: false; code: string }>;
	/**
	 * Show the key of a key without a wallet in a window of its own, after the system asks the owner who they are
	 * (H-045); the key never comes to this page. A fixed code when it was not shown.
	 */
	readonly exportOrphan?: (address: string) => Promise<{ ok: true } | { ok: false; code: string }>;
	/** Delete a key without a wallet from the keychain, after the system asks the owner who they are (H-045). */
	readonly deleteOrphan?: (address: string) => Promise<{ ok: true } | { ok: false; code: string }>;
};

export const desktop = (globalThis as { bandaDesktop?: Desktop }).bandaDesktop;

/** What the system's file manager is called here: Finder on a Mac, else none in particular. */
export const fileManager = /Mac/i.test(globalThis.navigator?.userAgent ?? "") ? "Finder" : undefined;

/**
 * Where a wallet's key is shown after its creation, as this page can tell (OD-2, H-266): `here`, in this desktop app,
 * which asks the owner who they are; `never`, in this desktop app on a computer that cannot ask (no Touch ID), so the
 * key is shown only as its wallet is made; `unknown` elsewhere (a browser), where only a Mac's desktop app with Touch ID
 * shows it later.
 */
export type LaterKey = "here" | "never" | "unknown";

export const laterKey: LaterKey =
	desktop === undefined ? "unknown" : desktop.reauthenticates === true ? "here" : "never";
