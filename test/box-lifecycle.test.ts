import { describe, expect, it } from "vitest";
import { openBox } from "../src/box/box.ts";

describe("owned box resources", () => {
	it("forwards runtime browser state through the existing box watcher", async () => {
		let changed = () => {};
		let watches = 0;
		let unwatched = false;
		const box = openBox(
			{
				kind: "microvm",
				workspace: "/workspace",
				attachments: "/work/attachments",
				command: ["unused"],
				ensure: async () => {},
				browser: {
					forAgent: () => ({ command: async () => ["unused"], login: { username: "u", password: "p" } }),
					prepare: async () => {},
					state: () => ({ state: "idle" }),
					watch: (listener) => {
						changed = listener;
						return () => {
							unwatched = true;
						};
					},
				},
			},
			() => {},
		);
		const unwatch = box.watch(() => watches++);
		changed();
		expect(watches).toBe(1);
		expect(box.browser?.state()).toEqual({ state: "idle" });
		unwatch();
		await box.close();
		expect(watches).toBe(1);
		expect(unwatched).toBe(true);
	});
	it("keeps the base computer up when optional browser preparation fails", async () => {
		const box = openBox(
			{
				kind: "microvm",
				workspace: "/workspace",
				attachments: "/work/attachments",
				command: ["unused"],
				ensure: async () => {},
				browser: {
					state: () => ({ state: "idle" }),
					watch: () => () => {},
					prepare: async () => {
						throw new Error("browser download failed");
					},
					forAgent: () => ({
						command: async () => {
							throw new Error("browser download failed");
						},
						login: { username: "u", password: "p" },
					}),
				},
			},
			() => {},
		);
		try {
			await expect(box.browser?.forAgent("mara").command()).rejects.toThrow("browser download failed");
			await expect(box.browser?.prepare()).rejects.toThrow("browser download failed");
			expect(box.state()).toEqual({ state: "up" });
			await expect(box.ensure()).resolves.toBeUndefined();
		} finally {
			await box.close();
		}
	});
	it("awaits in-flight acquisition and releases it once when closed", async () => {
		const events: string[] = [];
		let ready = () => {};
		const acquired = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const setup = {
			kind: "container" as const,
			workspace: "/workspace",
			attachments: "/work/attachments",
			command: ["unused"],
			ensure: async () => {
				events.push("acquiring");
				await acquired;
				events.push("acquired");
			},
			close: async () => {
				events.push("released");
			},
		};
		const box = openBox(setup, () => {});
		const starting = box.ensure().then(
			() => "ready",
			() => "closed",
		);
		const closing = box.close();
		ready();
		expect(await starting).toBe("closed");
		await closing;
		await box.close();
		expect(events).toEqual(["acquiring", "acquired", "released"]);
		await expect(box.ensure()).rejects.toThrow("closed");
	});
	it("releases partial resources after failed startup without retrying after close", async () => {
		let attempts = 0;
		let released = 0;
		const setup = {
			kind: "microvm" as const,
			workspace: "/workspace",
			attachments: "/work/attachments",
			command: ["unused"],
			ensure: async () => {
				attempts++;
				throw new Error("missing firmware");
			},
			close: async () => {
				released++;
			},
		};
		const box = openBox(setup, () => {});
		await expect(box.ensure()).rejects.toThrow("missing firmware");
		await box.close();
		await box.close();
		expect(released).toBe(1);
		await expect(box.ensure()).rejects.toThrow("closed");
		expect(attempts).toBe(1);
	});
});
