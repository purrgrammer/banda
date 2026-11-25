/**
 * banda's desktop app: a window and a tray around the daemon (DESIGN.md "The app"). The shell holds no state of its
 * own. It attaches to the home's running daemon, or starts one with the Node.js and app the release bundles, and shows
 * the web UI the daemon serves. Closing the window leaves the daemon running, so routines still wake; Quit stops it. If
 * the shell crashes, the daemon lives on and the next launch attaches to it.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	app,
	BrowserWindow,
	clipboard,
	dialog,
	ipcMain,
	Menu,
	nativeImage,
	session,
	shell,
	systemPreferences,
	Tray,
} from "electron";
import { attentionFrom, NOTHING, tooltipOf, wantsOwner, withDot } from "./attention.js";
import { backupFolder, profileHeld, restoreWaits } from "./backups.js";
import { shellPath } from "./environment.js";
import { failurePage, type Trouble, trouble } from "./trouble.js";
import { KEY_PAGE, secretClipboard, stopSigners, WALLET_ACTS, type WalletDeps, walletDeps } from "./wallets.js";

const windows = process.platform === "win32";
const home = resolve(process.env.BANDA_HOME ?? join(homedir(), ".banda"));
const port = Number(process.env.BANDA_PORT ?? 7787);
const log = join(home, "daemon.log");

type Published = { readonly pid: number; readonly port: number; readonly token: string };
let attachedDaemon: Published | undefined;
let startingDaemon: ChildProcess | undefined;
const profile =
	!app.isPackaged && process.env.BANDA_HOME === undefined
		? mkdtempSync(join(tmpdir(), "banda-desktop-refused-"))
		: join(home, "desktop");
// A restore the app made ready takes the home's place now, before this process opens anything in the home: its own
// profile is a folder of it. The release does it (two renames, the home as it was kept beside its backups) and
// declines while a daemon runs on the home; a second launch leaves it to the app that is already open.
if (profile.startsWith(home) && restoreWaits(home) && !profileHeld(profile)) {
	const { node, cli } = release();
	spawnSync(node, [cli, "restore", "--finish"], {
		env: { ...process.env, BANDA_HOME: home },
		stdio: "ignore",
		timeout: 60_000,
		windowsHide: true,
	});
}
mkdirSync(profile, { recursive: true, mode: 0o700 });
app.setPath("userData", profile);

/** The bundled release, or in development the checkout's build run by the Node.js on PATH. */
function release() {
	const root = app.isPackaged ? join(process.resourcesPath, "banda") : join(app.getAppPath(), "..");
	return app.isPackaged
		? {
				node: join(root, "node", windows ? "node.exe" : "node"),
				cli: join(root, "app", "dist", "cli", "index.js"),
				icon: join(root, "app", "web", "dist", "icon-192.png"),
				notices: join(root, "app", "licenses", "README.txt"),
			}
		: {
				node: process.env.BANDA_NODE ?? "node",
				cli: join(root, "dist", "cli", "index.js"),
				icon: join(root, "web", "public", "icon-192.png"),
				// staging writes it (scripts/notices.ts): a checkout has none
				notices: join(root, "licenses", "README.txt"),
			};
}

/**
 * Where Docker's CLI lives when the app is started from the Finder, a launcher or the Start menu, whose PATH is the
 * system's bare one: Windows' box is Docker's, and elsewhere a home from an earlier version brings its files from
 * Docker once. Added after the inherited PATH, so a shell's own order still wins.
 */
function dockerPath(inherited: string | undefined): string {
	const user = homedir();
	const extra = windows
		? ["C:\\Program Files\\Docker\\Docker\\resources\\bin", join(user, ".rd", "bin")]
		: process.platform === "darwin"
			? [
					"/usr/local/bin",
					"/opt/homebrew/bin",
					join(user, ".docker", "bin"),
					join(user, ".orbstack", "bin"),
					join(user, ".rd", "bin"),
					"/Applications/Docker.app/Contents/Resources/bin",
				]
			: ["/usr/local/bin", "/usr/bin", "/snap/bin", join(user, ".local", "bin")];
	const parts = (inherited ?? "").split(delimiter).filter((part) => part !== "");
	return [...parts, ...extra.filter((part) => !parts.includes(part))].join(delimiter);
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function readPublished(): Promise<{ pid: number; port?: number; token?: string } | undefined> {
	const text = await readFile(join(home, "daemon.json"), "utf8").catch(() => undefined);
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text) as { pid: number; port?: number; token?: string };
	} catch {
		return undefined; // a file being replaced; the next read sees it whole
	}
}

async function answers(daemon: Published): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${daemon.port}/api/status`, {
			headers: { authorization: `Bearer ${daemon.token}` },
			signal: AbortSignal.timeout(3_000),
		});
		return response.ok;
	} catch {
		return false;
	}
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The daemon `daemon.json` names, once it answers; `pid` narrows it to one process. */
async function published(within: number, pid?: number, exited?: () => boolean): Promise<Published | undefined> {
	const deadline = Date.now() + within;
	while (Date.now() < deadline && !(exited?.() ?? false)) {
		const file = await readPublished();
		if (
			file?.port !== undefined &&
			file.token !== undefined &&
			(pid === undefined || file.pid === pid) &&
			(await answers(file as Published))
		)
			return file as Published;
		await pause(250);
	}
	return undefined;
}

class DaemonFailed extends Error {
	readonly trouble: Trouble;
	constructor(trouble: Trouble) {
		super(trouble.title);
		this.trouble = trouble;
	}
}

/** Attach to the home's daemon, or start one. */
async function ensureDaemon(): Promise<Published> {
	const file = await readPublished();
	if (file !== undefined && alive(file.pid)) {
		// running, or still starting: it publishes its port once it listens
		const running = await published(60_000, file.pid, () => !alive(file.pid));
		if (running !== undefined) return running;
	}
	const { node, cli } = release();
	const path = (await shellPath(node)) ?? process.env.PATH;
	await mkdir(home, { recursive: true, mode: 0o700 });
	// the daemon writes to a file, not to a pipe of ours: it must outlive this process without writing into a closed pipe
	const output = openSync(log, "w", 0o600);
	const child = spawn(node, [cli, "serve", "--port", String(port)], {
		env: {
			...process.env,
			BANDA_HOME: home,
			PATH: dockerPath(path),
		},
		stdio: ["ignore", output, output],
		detached: true,
		windowsHide: true,
	});
	startingDaemon = child;
	closeSync(output);
	let ended = false;
	let failedToStart: Error | undefined;
	child.once("exit", () => {
		ended = true;
	});
	child.once("error", (error) => {
		ended = true;
		failedToStart = error;
	});
	child.unref();
	const running = child.pid === undefined ? undefined : await published(120_000, child.pid, () => ended);
	if (running !== undefined) {
		startingDaemon = undefined;
		return running;
	}
	if (!ended) child.kill();
	const said = failedToStart?.message ?? (await readFile(log, "utf8").catch(() => ""));
	throw new DaemonFailed(trouble(said, { home, port, log }));
}

/** Stop the daemon the window shows, and wait for it to go; the store survives a kill by design, so this is a courtesy. */
async function stopDaemon(): Promise<void> {
	const selected = attachedDaemon;
	if (selected === undefined) {
		startingDaemon?.kill();
		return;
	}
	if (!alive(selected.pid) || !(await answers(selected))) return;
	try {
		process.kill(selected.pid, "SIGTERM");
	} catch {
		return;
	}
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline && alive(selected.pid)) await pause(200);
}

let window: BrowserWindow | undefined;
/** The daemon's origin, once a window shows it: the only page the folder dialog answers. */
let daemonOrigin: string | undefined;
let tray: Tray | undefined;
let quitting = false;

/** What the window may ask for, from the daemon's own origin only: never an artifact's frame. */
const PERMITTED = new Set(["notifications", "media", "clipboard-sanitized-write", "fullscreen"]);

function openWindow(url: string | undefined, page?: string): BrowserWindow {
	const origin = url === undefined ? undefined : new URL(url).origin;
	daemonOrigin = origin;
	const fromDaemon = (target: string) =>
		origin !== undefined && URL.canParse(target) && new URL(target).origin === origin;
	session.defaultSession.setPermissionRequestHandler((_contents, permission, grant, details) =>
		grant(PERMITTED.has(permission) && fromDaemon(details.requestingUrl)),
	);
	session.defaultSession.setPermissionCheckHandler(
		(_contents, permission, requestingOrigin) => PERMITTED.has(permission) && requestingOrigin === origin,
	);
	const created = new BrowserWindow({
		width: 1280,
		height: 840,
		minWidth: 320,
		minHeight: 480,
		title: "banda",
		show: false,
		autoHideMenuBar: true,
		webPreferences: {
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			webviewTag: false,
			preload: join(import.meta.dirname, "preload.cjs"),
		},
	});
	const outside = (target: string) => {
		if (/^(https?|mailto):/i.test(target)) void shell.openExternal(target);
	};
	created.webContents.setWindowOpenHandler(({ url: target }) => {
		if (fromDaemon(target)) return { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true } };
		// a sign-in opens a blank tab at once (so no pop-up blocker eats it) and sends it to the provider when the link
		// comes: a hidden window here, whose first address outside the daemon goes to the system browser
		if (target === "about:blank") return { action: "allow", overrideBrowserWindowOptions: { show: false } };
		outside(target);
		return { action: "deny" };
	});
	created.webContents.on("did-create-window", (child) => {
		child.webContents.setWindowOpenHandler(({ url: target }) => {
			outside(target);
			return { action: "deny" };
		});
		child.webContents.on("will-navigate", (event, target) => {
			if (fromDaemon(target)) {
				if (!child.isVisible()) child.show();
				return;
			}
			event.preventDefault();
			outside(target);
			if (!child.isVisible()) child.close();
		});
	});
	created.webContents.on("will-navigate", (event, target) => {
		if (fromDaemon(target)) return;
		event.preventDefault();
		outside(target);
	});
	created.webContents.on("will-attach-webview", (event) => event.preventDefault());
	// a page that loads anew has said nothing yet: the dot is what the page showing now last counted
	created.webContents.on("did-navigate", () => markTray(NOTHING));
	created.once("ready-to-show", () => created.show());
	created.on("close", (event) => {
		if (quitting) return;
		event.preventDefault();
		created.hide();
	});
	if (page !== undefined) void created.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
	else if (url !== undefined) void created.loadURL(url);
	return created;
}

/** Whether a message came from the daemon's own page: its top frame, on its origin, in the main window. */
function fromOwnPage(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
	const frame = event.senderFrame;
	return (
		frame !== null &&
		frame === event.sender.mainFrame &&
		daemonOrigin !== undefined &&
		URL.canParse(frame.url) &&
		new URL(frame.url).origin === daemonOrigin
	);
}

/**
 * The system's folder dialog, for the daemon's own page and nothing else: its top frame, on its origin (never an
 * artifact's frame, a sign-in window gone elsewhere, or the failure page). It hands back only the path the owner
 * picked; the daemon still checks it as any typed path.
 */
function answerFolders(): void {
	ipcMain.handle("banda:choose-folder", async (event, at: unknown) => {
		if (!fromOwnPage(event)) throw new Error("Only banda's own page may open the folder dialog.");
		const start = typeof at === "string" && at.length < 4096 ? at.replace(/^~(?=$|[/\\])/, homedir()) : homedir();
		const options: Electron.OpenDialogOptions = {
			title: "Your code folder",
			message: "The folder your projects are in",
			buttonLabel: "Use this folder",
			defaultPath: start,
			properties: ["openDirectory", "createDirectory"],
		};
		const owner = BrowserWindow.fromWebContents(event.sender);
		const picked = owner === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(owner, options);
		return picked.canceled ? undefined : picked.filePaths[0];
	});
}

/**
 * For the home's backups in Settings, from the daemon's own page alone: show one in the system's file manager, by its
 * name among the home's backups and never by a path; and start banda again, which is how a restore made ready takes
 * the home's place (Quit stops the daemon first, and the app that starts next finishes the restore before its window).
 */
function answerBackups(): void {
	ipcMain.handle("banda:reveal-backup", (event, name: unknown) => {
		if (!fromOwnPage(event)) throw new Error("Only banda's own page may show a backup.");
		const folder = backupFolder(home, name);
		if (folder === undefined) return false;
		shell.showItemInFolder(folder);
		return true;
	});
	ipcMain.handle("banda:restart", (event) => {
		if (!fromOwnPage(event)) throw new Error("Only banda's own page may start banda again.");
		app.relaunch();
		app.quit();
	});
}

/**
 * A wallet's key, in a local window of its own: the page bundled with the app (wallets.ts `KEY_PAGE`), in a session
 * that keeps nothing and loads nothing but that page, hidden from screen capture where the platform allows, the key
 * handed to it over its preload. It closes when it loses focus, and the key goes with it.
 */
function keyWindow(address: string, key: string): Promise<void> {
	const page = join(app.getAppPath(), ...KEY_PAGE);
	const pageUrl = pathToFileURL(page).href;
	const partition = "banda-key";
	const keySession = session.fromPartition(partition, { cache: false });
	keySession.webRequest.onBeforeRequest((details, answer) => answer({ cancel: details.url !== pageUrl }));
	keySession.setPermissionRequestHandler((_contents, _permission, grant) => grant(false));
	const shown = new BrowserWindow({
		width: 560,
		height: 360,
		title: "Your wallet's private key",
		autoHideMenuBar: true,
		...(window === undefined || window.isDestroyed() ? {} : { parent: window }),
		webPreferences: {
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			webviewTag: false,
			partition,
			preload: join(import.meta.dirname, "key-preload.cjs"),
		},
	});
	shown.setContentProtection(true);
	shown.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	shown.webContents.on("will-navigate", (event) => event.preventDefault());
	// the key is held here until the window loses focus or closes, then dropped (H-274): switching away closes the
	// window, and opening it again asks for the owner again
	const held: { key?: string } = { key };
	const copy = (event: Electron.IpcMainEvent) => {
		if (event.sender !== shown.webContents || held.key === undefined) return;
		void secret.copy(held.key);
	};
	ipcMain.on("banda:key-copy", copy);
	shown.on("blur", () => {
		delete held.key;
		if (!shown.isDestroyed()) shown.close();
	});
	shown.on("closed", () => {
		delete held.key;
		ipcMain.removeListener("banda:key-copy", copy);
	});
	shown.webContents.once("did-finish-load", () => {
		if (held.key !== undefined) shown.webContents.send("banda:key", { address, key: held.key });
	});
	return shown.loadFile(page);
}

/** The key last put on the clipboard: cleared after `CLIPBOARD_CLEAR`, and when banda quits, while it still holds it. */
const secret = secretClipboard(clipboard);

/** What the wallets' acts use (wallets.ts `walletDeps`), with this app's release, daemon and window. */
function wallets(): WalletDeps {
	return walletDeps({
		release,
		home,
		daemon: () => attachedDaemon,
		// Touch ID alone: a Mac without it, or with it off, re-authenticates no one, so it shows no key after creation
		...(reauthenticates() ? { authenticate: (why: string) => systemPreferences.promptTouchID(why) } : {}),
		show: keyWindow,
	});
}

/**
 * Whether this computer asks the owner who they are (Touch ID on a Mac): without it no key is shown after its wallet is
 * made, nor restored, nor signing moved (OD-2, H-266), and the page words its key steps by this.
 */
const reauthenticates = () => process.platform === "darwin" && systemPreferences.canPromptTouchID();

/**
 * For the home's wallets, from the daemon's own page alone (wallets.ts `WALLET_ACTS`): show a key on this computer
 * behind the OS's re-authentication, restore a missing one, move signing here, export or delete a key without a
 * wallet, and keep the page's own window from
 * screen capture while a new key is on it. A key never reaches the daemon.
 */
function answerWallets(): void {
	// asked once, as a page's preload starts (before its own frame says where it is): a fact of this computer, no key
	ipcMain.on("banda:reauthenticates", (event) => {
		event.returnValue = reauthenticates();
	});
	for (const [channel, act] of Object.entries(WALLET_ACTS))
		ipcMain.handle(channel, (event, ...args: unknown[]) => {
			if (!fromOwnPage(event)) throw new Error("Only banda's own page may act on a wallet's key.");
			return act(wallets(), ...args);
		});
	ipcMain.handle("banda:protect-screen", (event, on: unknown) => {
		if (!fromOwnPage(event)) throw new Error("Only banda's own page may protect its window.");
		if (typeof on !== "boolean") throw new Error("Protection is on or off.");
		BrowserWindow.fromWebContents(event.sender)?.setContentProtection(on);
	});
	ipcMain.handle("banda:copy-secret", (event, text: unknown) => {
		if (!fromOwnPage(event)) throw new Error("Only banda's own page may copy a wallet's key.");
		if (typeof text !== "string") throw new Error("A copy is text.");
		return text === "" ? secret.clear() : secret.copy(text);
	});
}

function show(): void {
	if (window === undefined || window.isDestroyed()) return;
	if (window.isMinimized()) window.restore();
	window.show();
	window.focus();
}

/** The tray's icon as it is, and with the dot that says something waits on the owner or is unread. */
let trayImages: { readonly plain: Electron.NativeImage; readonly dotted: Electron.NativeImage } | undefined;

/**
 * The icon with the dot drawn on each of its sizes. A macOS template image is one colour, which the menu bar paints
 * to suit itself: there the dot is a hole in the icon, so it shows as the icon's opposite whatever the menu bar is.
 * Elsewhere the icon has colours of its own, and the dot is dark in a white ring.
 */
function dotted(image: Electron.NativeImage, template: boolean): Electron.NativeImage {
	const { width, height } = image.getSize();
	const out = nativeImage.createEmpty();
	for (const scaleFactor of image.getScaleFactors()) {
		const pixels = image.toBitmap({ scaleFactor });
		// the bitmap's own width, whatever this size's scale turned out to be
		const wide = Math.round(Math.sqrt((pixels.length / 4) * (width / height)));
		const drawn = template ? withDot(pixels, wide, [0, 0, 0]) : withDot(pixels, wide, [255, 255, 255], [28, 28, 28]);
		out.addRepresentation({ scaleFactor, width: wide, height: pixels.length / 4 / wide, buffer: Buffer.from(drawn) });
	}
	if (template) out.setTemplateImage(true);
	return out;
}

/** Show on the tray what the page counted: a dot while anything waits or is unread, and the counts in its tooltip. */
function markTray(said: unknown): void {
	if (tray === undefined || tray.isDestroyed() || trayImages === undefined) return;
	const attention = attentionFrom(said);
	tray.setImage(wantsOwner(attention) ? trayImages.dotted : trayImages.plain);
	tray.setToolTip(tooltipOf(attention));
}

/** The page's count of what waits on the owner, from the daemon's own page and nothing else. */
function answerAttention(): void {
	ipcMain.on("banda:attention", (event, said: unknown) => {
		if (fromOwnPage(event) && event.sender === window?.webContents) markTray(said);
	});
}

function makeTray(icon: string): void {
	// macOS: a template image (black and alpha, @2x beside it), which the menu bar paints white or black to suit itself
	const image =
		process.platform === "darwin"
			? nativeImage.createFromPath(join(app.getAppPath(), "assets", "trayTemplate.png"))
			: nativeImage.createFromPath(icon).resize({ width: 18, height: 18 });
	if (process.platform === "darwin") image.setTemplateImage(true);
	trayImages = { plain: image, dotted: dotted(image, process.platform === "darwin") };
	tray = new Tray(image);
	tray.setToolTip(tooltipOf(NOTHING));
	const loginItem = process.platform !== "linux";
	// the index of the third-party notices the release carries, shown in its folder beside the files it names
	const notices = release().notices;
	const menu = () =>
		Menu.buildFromTemplate([
			{ label: "Open banda", click: show },
			...(loginItem
				? [
						{
							label: "Start at login",
							type: "checkbox" as const,
							checked: app.getLoginItemSettings().openAtLogin,
							click: (item: Electron.MenuItem) => {
								app.setLoginItemSettings({ openAtLogin: item.checked });
							},
						},
					]
				: []),
			...(existsSync(notices) ? [{ label: "Third-party licenses", click: () => shell.showItemInFolder(notices) }] : []),
			{ type: "separator" },
			{ label: "Quit banda", click: () => app.quit() },
		]);
	tray.setContextMenu(menu());
	tray.on("click", show);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
	app.setAppUserModelId("app.banda.desktop");
	app.on("second-instance", show);
	app.on("activate", show);
	// Quit means banda stops: the daemon first, then the shell
	app.on("before-quit", (event) => {
		if (quitting) return;
		quitting = true;
		event.preventDefault();
		// the wallet acts' signer children first: their deadlines are timers here, gone once the app exits (H-034, C20)
		stopSigners();
		void Promise.all([stopDaemon(), secret.clear().catch(() => {})]).finally(() => app.quit());
	});
	app.on("window-all-closed", () => {
		// the tray keeps the app; nothing to do
	});
	// a development shell is Electron's own app, which macOS names and draws as Electron; packaged, the bundle says
	// banda (electron-builder.yml). The name in the Dock comes from the bundle; the icon and the app menu's can be set.
	app.setName("banda");
	void app.whenReady().then(async () => {
		if (!app.isPackaged) app.dock?.setIcon(release().icon.replace("icon-192", "icon-512"));
		makeTray(release().icon);
		answerFolders();
		answerAttention();
		answerBackups();
		answerWallets();
		if (!app.isPackaged && process.env.BANDA_HOME === undefined) {
			// a development shell never touches the owner's home (AGENTS.md "Never touch a live banda")
			window = openWindow(
				undefined,
				failurePage({
					title: "No throwaway home",
					said: "A development build of the desktop app runs only against a throwaway home.",
					fix: "Start it with `npm run desktop:dev`, which makes one, or set BANDA_HOME to an empty folder.",
				}),
			);
			return;
		}
		try {
			const daemon = await ensureDaemon();
			attachedDaemon = daemon;
			if (quitting) return void stopDaemon();
			window = openWindow(`http://127.0.0.1:${daemon.port}/#token=${daemon.token}`);
		} catch (error) {
			if (quitting) return;
			const shown =
				error instanceof DaemonFailed ? error.trouble : trouble((error as Error).message, { home, port, log });
			window = openWindow(undefined, failurePage(shown));
		}
	});
}
