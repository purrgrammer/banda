/**
 * What the desktop app adds to the page (desktop/src/preload.cts), when the page runs in it: the system's own folder
 * dialog. Undefined in a browser.
 */
type Desktop = {
	/** The folder the owner picked, opened at `at`; undefined when they cancelled. */
	readonly chooseFolder: (at?: string) => Promise<string | undefined>;
};

export const desktop = (globalThis as { bandaDesktop?: Desktop }).bandaDesktop;

/** What the system's file manager is called here: Finder on a Mac, else none in particular. */
export const fileManager = /Mac/i.test(globalThis.navigator?.userAgent ?? "") ? "Finder" : undefined;
