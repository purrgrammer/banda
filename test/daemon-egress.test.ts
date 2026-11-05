/**
 * The daemon's side of the egress proxy without Docker: every config it pushes carries its own port, even one a
 * watcher pushes before the daemon listens (DESIGN.md "The box", Network: the daemon's port is never reached).
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BoxEgress, EgressConfig } from "../src/box/box.ts";
import { startDaemon } from "../src/daemon.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { echoModels, tempHome, until } from "./helpers.ts";

describe("the daemon's config pushes", () => {
	it("never push a config without the daemon's port: the first waits for it to listen", async () => {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const pushed: Omit<EgressConfig, "key">[] = [];
		let source: (() => Promise<Omit<EgressConfig, "key">>) | undefined;
		let calls = 0;
		const egress: BoxEgress = {
			env: () => ({}),
			source: (from) => {
				source = from;
			},
			configure: async () => {
				calls += 1;
				if (source === undefined) return "not running";
				pushed.push(await source());
				return "told";
			},
			sentChats: async () => [],
			pass: async () => {},
			take: async () => ({ held: [], reads: [], readBytes: 0 }),
			ack: async () => {},
			replay: async () => ({ refused: "not in this test" }),
		};
		const box = hostBox(home);
		const daemon = await startDaemon({
			home,
			port: 0,
			models: echoModels().models,
			log: () => {},
			// as the container box does: its bring-up (which the daemon starts before it listens) pushes the config
			box: {
				...box,
				egress,
				ensure: async () => {
					await box.ensure();
					await egress.configure();
				},
			},
		});
		try {
			// the bring-up's push and the one at listen, at least
			await until(() => pushed.length >= 2);
			expect(calls).toBeGreaterThanOrEqual(2);
			expect(pushed.map((config) => config.daemonPort)).toEqual(pushed.map(() => daemon.port));
		} finally {
			await daemon.close();
		}
	});
});
