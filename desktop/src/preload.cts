/**
 * What the desktop app adds to the daemon's page, and only that: the system's own folder dialog, for the code folder a
 * harness works in (a browser cannot hand an app a folder's path; the desktop app can), and the tray's dot, which the
 * page's own count of asks and unread messages draws; for the home's backups, showing one in the file manager and
 * starting banda again, which finishes a restore; and for the wallets, the acts only this computer's owner does with a
 * key (desktop/src/wallets.ts). Sandboxed, so CommonJS and
 * nothing but electron's renderer side; the main process answers only the daemon's own page (see main.ts).
 */
const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

contextBridge.exposeInMainWorld("bandaDesktop", {
	/** The folder the owner picked in the system's dialog, opened at `at`; undefined when they cancelled. */
	chooseFolder: (at?: string): Promise<string | undefined> => ipcRenderer.invoke("banda:choose-folder", at),
	/** What waits on the owner now, for the tray's dot: chats with an open ask, and unread messages. */
	attention: (attention: { asks: number; unread: number }): void => ipcRenderer.send("banda:attention", attention),
	/** Show the backup `name` in the system's file manager; false when there is none by that name. */
	revealBackup: (name: string): Promise<boolean> => ipcRenderer.invoke("banda:reveal-backup", name),
	/** Quit banda, its daemon too, and start it again. */
	restart: (): Promise<void> => ipcRenderer.invoke("banda:restart"),
	/**
	 * Whether this computer asks the owner who they are (Touch ID on a Mac): without it, a wallet's key shows only as it is
	 * made, and no later reveal, Restore or move of signing is done here (OD-2, H-266).
	 */
	reauthenticates: ipcRenderer.sendSync("banda:reauthenticates") === true,
	/**
	 * Show a wallet's private key in a window of its own, after the system asks the owner who they are; the key never
	 * comes to this page. A fixed code when it was not shown.
	 */
	revealKey: (address: string): Promise<{ ok: true } | { ok: false; code: string }> =>
		ipcRenderer.invoke("banda:reveal-key", address),
	/** Keep this window from screen capture, or let it be captured again: on while a new wallet's key is shown. */
	protectScreen: (on: boolean): Promise<void> => ipcRenderer.invoke("banda:protect-screen", on),
	/**
	 * Put a new wallet's key on the clipboard, cleared a minute later and when banda quits, whatever the page does
	 * meanwhile; empty text clears it now, while it still holds the key.
	 */
	copySecret: (text: string): Promise<void> => ipcRenderer.invoke("banda:copy-secret", text),
	/**
	 * Keep the key the owner saved for a wallet whose keychain item is gone, after the system asks the owner who they
	 * are, only if it opens the wallet's address; the key goes to banda's signer on this computer, never to the daemon.
	 */
	restoreKey: (address: string, key: string): Promise<{ ok: true } | { ok: false; code: string }> =>
		ipcRenderer.invoke("banda:restore-key", address, key),
	/** Move the home's signing here, once the key of each of its wallets here proved it opens its wallet. */
	moveSigning: (): Promise<{ ok: true } | { ok: false; code: string }> => ipcRenderer.invoke("banda:move-signing"),
	/**
	 * Show the key of a key without a wallet in a window of its own, after the system asks the owner who they are; the
	 * key never comes to this page.
	 */
	exportOrphan: (address: string): Promise<{ ok: true } | { ok: false; code: string }> =>
		ipcRenderer.invoke("banda:export-orphan", address),
	/** Delete a key without a wallet from the keychain, after the system asks the owner who they are. */
	deleteOrphan: (address: string): Promise<{ ok: true } | { ok: false; code: string }> =>
		ipcRenderer.invoke("banda:delete-orphan", address),
});
