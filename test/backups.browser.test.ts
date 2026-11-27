/**
 * Settings → Backups through the app against a throwaway daemon: the owner takes a backup and sees it listed with
 * what it holds; deletes one, asked first; and restores one, which is made ready and waits for banda to start again.
 * In a browser the page says how to start it again and copies a backup's path; in the desktop app (its bridge stood
 * in for here) it shows the backup in the file manager and starts banda again itself. The daemon started again is
 * the restored home, with the home from before listed.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { backupsOf } from "../src/core/backup.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { BackupsView } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { echoModels, tempHome, until, webServer } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

const text = `document.body.innerText`;
const button = (label: string, within = "document") =>
	`[...${within}.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(label)})`;
const item = (label: string) =>
	`[...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent.trim() === ${JSON.stringify(label)})`;
const more = (what: string) => `document.querySelector('[aria-label^=${JSON.stringify(`More for ${what}`)}]')`;
const dialog = `document.querySelector('[role="alertdialog"]')`;

async function click(page: Page, selector: string) {
	await page.until(selector).catch(async (error: Error) => {
		throw new Error(`${error.message}\n${await page.run<string>(`location.hash + ' | ' + ${text}.slice(0, 2500)`)}`);
	});
	await page.run(`(${selector}).scrollIntoView({block:'center'})`);
	// a dialog's buttons are pressed once it has come to rest
	await page.until(
		`(() => {const el=${selector}; const within=el.closest('[role="alertdialog"],[role="menu"]'); return !within || within.getAnimations({subtree:true}).every(animation => animation.playState !== 'running');})()`,
	);
	// a real press and release where the control is: a menu opens on the press, so the release lands on what it opened
	const point = await page.run<{ x: number; y: number }>(
		`(() => {const el=${selector}; const r=el.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; if(!el.contains(document.elementFromPoint(x,y))) throw new Error('Control is not hit-testable'); return {x,y};})()`,
	);
	await page.input("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
	await page.input("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
}

/** The desktop app's bridge, as its preload exposes it: what it was asked is kept on the page for the test to read. */
const BRIDGE = `window.bandaDesktop = {
	chooseFolder: async () => undefined,
	attention: () => {},
	revealBackup: async (name) => { (window.revealed ??= []).push(name); return true; },
	restart: async () => { window.restarted = true; },
};`;

for (const [width, desktop] of [
	[390, false],
	[1280, true],
] as const)
	it.skipIf(!hasChrome())(
		`Settings takes a backup, deletes one and restores one ${desktop ? "in the desktop app" : "in a browser"} at ${width}px`,
		async () => {
			const home = join(await tempHome(), "home");
			await mkdir(home);
			await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
			const start = () =>
				startDaemon({ home, port: 0, models: echoModels().models, log: () => {}, box: hostBox(home) });
			let daemon = await start();
			const token = (await readDaemonFile(home))!.token!;
			const folder = backupsOf(home);
			const view = async () =>
				(await (
					await fetch(`http://127.0.0.1:${daemon.port}/api/backups`, { headers: { authorization: `Bearer ${token}` } })
				).json()) as BackupsView;
			const serve = () =>
				webServer({
					server: {
						proxy: {
							"/api": {
								target: `http://127.0.0.1:${daemon.port}`,
								changeOrigin: true,
								headers: { origin: `http://127.0.0.1:${daemon.port}` },
							},
							// the icons are this daemon's too, never whatever listens on the default port
							"^/(?:icon(?:-maskable)?\\.svg|icon-(?:192|512|maskable-512)\\.png|apple-touch-icon\\.png|manifest\\.webmanifest)$":
								{ target: `http://127.0.0.1:${daemon.port}`, changeOrigin: true },
						},
					},
					plugins: desktop
						? [
								{
									name: "desktop-bridge",
									transformIndexHtml: () => [{ tag: "script", children: BRIDGE, injectTo: "head-prepend" as const }],
								},
							]
						: [],
				});
			const open = async (page: Page) => {
				await page.until(`document.body.textContent.includes('Sancho')`);
				await page.until(
					`(location.hash.startsWith('#/settings') || (location.hash='#/settings', false)) && ${text}.includes('Backups')`,
				);
			};
			// the desktop app's first run offers what the other harnesses on this computer have: skipped, as the owner may
			await fetch(`http://127.0.0.1:${daemon.port}/api/bring`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ skills: [], agents: [] }),
			});
			let server = await serve();
			try {
				writeFileSync(join(home, "workspace/note.md"), "as backed up");
				await withPage(`${server.origin}/#token=${token}`, { width, height: 900 }, async (page) => {
					await open(page);
					await page.until(`${text}.includes('No backups yet')`);
					expect(await page.run<string>(text)).toContain(folder);

					// leave the browser's sites out: the backup says so
					await click(page, `document.querySelectorAll('button[role="checkbox"]')[1]`);
					await click(page, button("Back up now"));
					await page.until(`${more("the backup of")} && ${text}.includes("without the browser's signed-in sites")`);
					const [first] = (await view()).backups;
					expect(first).toMatchObject({ kind: "backup", without: ["browser"] });
					expect(readFileSync(join(folder, first!.name, "workspace/note.md"), "utf8")).toBe("as backed up");

					// a second, whole; the list shows both
					await click(page, `document.querySelectorAll('button[role="checkbox"]')[1]`);
					await until(async () =>
						first!.name <
						new Date()
							.toISOString()
							.replace(/\.\d+Z$/, "Z")
							.replaceAll(":", "-")
							? true
							: undefined,
					);
					await click(page, button("Back up now"));
					await page.until(
						`${text}.includes('everything') && document.querySelectorAll('[aria-label^="More for the backup of"]').length === 2`,
					);

					// its place: shown in the file manager by the desktop app, its path copied in a browser
					await click(page, more("the backup of"));
					if (desktop) {
						await click(page, `(${item("Show in its folder")} ?? ${item("Show in Finder")})`);
						await page.until(`window.revealed?.length === 1`);
						const newest = (await view()).backups[0]!.name;
						expect(await page.run<string[]>(`window.revealed`)).toEqual([newest]);
					} else {
						await page.until(item("Copy its path"));
						expect(await page.run(`${item("Show in Finder")} ?? ${item("Show in its folder")}`)).toBeFalsy();
						await page.input("Input.dispatchKeyEvent", {
							type: "keyDown",
							key: "Escape",
							code: "Escape",
							windowsVirtualKeyCode: 27,
						});
						await page.input("Input.dispatchKeyEvent", {
							type: "keyUp",
							key: "Escape",
							code: "Escape",
							windowsVirtualKeyCode: 27,
						});
					}
					await page.until(`!document.querySelector('[role="menu"]')`);

					// delete the newest, asked first; kept, nothing changes
					await click(page, more("the backup of"));
					await click(page, item("Delete…"));
					await page.until(dialog);
					expect(await page.run<string>(`${dialog}.innerText`)).toContain("It can't be brought back.");
					await click(page, button("Keep it", dialog));
					await page.until(`!${dialog}`);
					expect((await view()).backups).toHaveLength(2);
					await click(page, more("the backup of"));
					await click(page, item("Delete…"));
					await page.until(dialog);
					await click(page, button("Delete", dialog));
					await page.until(`document.querySelectorAll('[aria-label^="More for the backup of"]').length === 1`);
					expect((await view()).backups.map((each) => each.name)).toEqual([first!.name]);
					expect(readdirSync(folder)).toEqual([first!.name]);

					// restore the one left: made ready, the home untouched, and the page says how it finishes
					writeFileSync(join(home, "workspace/note.md"), "since the backup");
					await click(page, more("the backup of"));
					await click(page, item("Restore…"));
					await page.until(dialog);
					expect(await page.run<string>(`${dialog}.innerText`)).toContain("so nothing is lost");
					await click(page, button("Restore", dialog));
					await page.until(`${text}.includes('Ready to restore the backup of')`);
					expect((await view()).ready?.from).toBe(first!.name);
					expect(readFileSync(join(home, "workspace/note.md"), "utf8")).toBe("since the backup");
					const shown = await page.run<string>(text);
					if (desktop) {
						expect(shown).not.toContain("Ctrl+C");
						// let go, and made ready again: then banda starts again from the page
						await click(page, button("Don't restore"));
						await page.until(`!${text}.includes('Ready to restore')`);
						expect((await view()).ready).toBeUndefined();
						expect(readdirSync(folder)).toEqual([first!.name]);
						await click(page, more("the backup of"));
						await click(page, item("Restore…"));
						await click(page, button("Restore", dialog));
						await click(page, button("Restart banda to finish"));
						await page.until(`window.restarted === true`);
					} else {
						expect(shown).toContain("stop banda and start it again");
						expect(shown).toContain("banda serve");
						expect(await page.run(button("Restart banda to finish"))).toBeFalsy();
					}
					expect(await page.run(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
					expect(page.errors()).toEqual([]);
				});

				// banda starts again, as the desktop app's restart or the owner's own does: the home is the backup's
				await server.close();
				await daemon.close();
				daemon = await start();
				server = await serve();
				expect(readFileSync(join(home, "workspace/note.md"), "utf8")).toBe("as backed up");
				await withPage(`${server.origin}/#token=${token}`, { width, height: 900 }, async (page) => {
					await open(page);
					await page.until(`${text}.includes('Your home before a restore')`);
					expect(await page.run<string>(text)).not.toContain("Ready to restore");
					const replaced = (await view()).backups.find((each) => each.kind === "replaced")!;
					expect(readFileSync(join(folder, replaced.name, "workspace/note.md"), "utf8")).toBe("since the backup");
					// the home from before goes when the owner says so, told it is the only copy
					await click(page, more("your home from before the restore"));
					await click(page, item("Delete…"));
					await page.until(dialog);
					expect(await page.run<string>(`${dialog}.innerText`)).toContain("the only copy");
					await click(page, button("Delete", dialog));
					await page.until(`!${text}.includes('Your home before a restore')`);
					expect(existsSync(join(folder, replaced.name))).toBe(false);
					expect(page.errors()).toEqual([]);
				});
			} finally {
				await server.close();
				await daemon.close();
			}
		},
		120000,
	);
