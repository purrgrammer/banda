/**
 * banda's desktop app: a window and a tray around the daemon (DESIGN.md "The app"). The shell holds no state of its
 * own. It attaches to the home's running daemon, or starts one with the Node.js and app the release bundles, and shows
 * the web UI the daemon serves. Closing the window leaves the daemon running, so routines still wake; Quit stops it. If
 * the shell crashes, the daemon lives on and the next launch attaches to it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, shell, Tray } from "electron";
import { shellPath } from "./environment.js";
import { failurePage, type Trouble, trouble } from "./trouble.js";

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
			}
		: {
				node: process.env.BANDA_NODE ?? "node",
				cli: join(root, "dist", "cli", "index.js"),
				icon: join(root, "web", "public", "icon-192.png"),
			};
}

/**
 * Where Docker's CLI lives when the app is started from the Finder, a launcher or the Start menu, whose PATH is the
 * system's bare one. Added after the inherited PATH, so a shell's own order still wins.
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
			BANDA_BOX:
				process.env.BANDA_BOX ??
				(app.isPackaged && existsSync(join(process.resourcesPath, "banda/app/computer/manifest.json"))
					? "microvm"
					: "container"),
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

/**
 * The system's folder dialog, for the daemon's own page and nothing else: its top frame, on its origin (never an
 * artifact's frame, a sign-in window gone elsewhere, or the failure page). It hands back only the path the owner
 * picked; the daemon still checks it as any typed path.
 */
function answerFolders(): void {
	ipcMain.handle("banda:choose-folder", async (event, at: unknown) => {
		const frame = event.senderFrame;
		if (
			frame === null ||
			frame !== event.sender.mainFrame ||
			daemonOrigin === undefined ||
			!URL.canParse(frame.url) ||
			new URL(frame.url).origin !== daemonOrigin
		)
			throw new Error("Only banda's own page may open the folder dialog.");
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

function show(): void {
	if (window === undefined || window.isDestroyed()) return;
	if (window.isMinimized()) window.restore();
	window.show();
	window.focus();
}

function makeTray(icon: string): void {
	// macOS: a template image (black and alpha, @2x beside it), which the menu bar paints white or black to suit itself
	const image =
		process.platform === "darwin"
			? nativeImage.createFromPath(join(app.getAppPath(), "assets", "trayTemplate.png"))
			: nativeImage.createFromPath(icon).resize({ width: 18, height: 18 });
	if (process.platform === "darwin") image.setTemplateImage(true);
	tray = new Tray(image);
	tray.setToolTip("banda");
	const loginItem = process.platform !== "linux";
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
		void stopDaemon().finally(() => app.quit());
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
