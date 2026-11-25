/**
 * The preload of the local window a wallet's key is shown in (wallets.ts `KEY_PAGE`): the key comes from the main
 * process once, and the page may ask for it to be copied. Sandboxed, so CommonJS and nothing but electron's renderer
 * side.
 */
const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

contextBridge.exposeInMainWorld("bandaKey", {
	/** Hears the key, beside the address it opens, once. */
	shown: (then: (shown: { address: string; key: string }) => void): void => {
		ipcRenderer.once("banda:key", (_event, shown: { address: string; key: string }) => then(shown));
	},
	/** Puts the key on the clipboard, which the main process clears after a minute if it still holds it. */
	copy: (): void => ipcRenderer.send("banda:key-copy"),
});
