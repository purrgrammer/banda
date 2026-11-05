/**
 * A provider configured from outside banda. pi-ai reports a credential it finds, never one it has tried, so an
 * ambient key (ANTHROPIC_API_KEY and its kind) reads exactly like a working sign-in. Shown as plain "Connected" a
 * stale one looks right, cannot be signed out of, and hides the sign-in that would replace it, so the view tells the
 * two apart and names where an ambient one came from.
 */
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileCredentialStore } from "../src/core/provider-credentials.ts";
import type { Area, Deps } from "../src/server/routes/area.ts";
import { providersArea } from "../src/server/routes/providers.ts";
import { tempHome } from "./helpers.ts";

type Row = { id: string; connected: boolean; ambient?: boolean; source?: string };

/** The env pi-ai reads for the providers in play, saved and put back so no test leaks a key into another. */
const AMBIENT = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
	saved = Object.fromEntries(AMBIENT.map((name) => [name, process.env[name]]));
	for (const name of AMBIENT) delete process.env[name];
});
afterEach(() => {
	for (const [name, value] of Object.entries(saved))
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
});

async function start() {
	const home = await tempHome();
	const credentials = new FileCredentialStore(home);
	const models = builtinModels({ credentials });
	const area: Area = providersArea().start!({
		home,
		models,
		changed: () => {},
		log: () => {},
	} as unknown as Deps);
	const anthropic = async (): Promise<Row> => {
		const reply = await area.route!({
			method: "GET",
			path: "/providers",
			url: new URL("http://127.0.0.1/api/providers"),
			json: async () => ({}),
			signal: new AbortController().signal,
		});
		if (reply === undefined || !("body" in reply)) throw new Error("no answer for GET /providers");
		return (reply.body as Row[]).find((row) => row.id === "anthropic")!;
	};
	return { area, credentials, anthropic };
}

describe("a provider configured from outside banda", () => {
	it("with nothing anywhere is not connected, and nothing is ambient", async () => {
		const { area, anthropic } = await start();
		try {
			const row = await anthropic();
			expect(row.connected).toBe(false);
			expect(row.ambient).toBeUndefined();
			expect(row.source).toBeUndefined();
		} finally {
			await area.stop?.();
		}
	});

	it("is connected but ambient, named by what set it, so a stale key cannot pass for a sign-in", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-from-the-environment";
		const { area, anthropic } = await start();
		try {
			const row = await anthropic();
			// the band can think with it, so it counts as connected; it is nobody's doing here, so it is marked
			expect(row.connected).toBe(true);
			expect(row.ambient).toBe(true);
			expect(row.source).toBe("ANTHROPIC_API_KEY");
		} finally {
			await area.stop?.();
		}
	});

	it("connected here is the owner's: not ambient, and its source is not told", async () => {
		const { area, credentials, anthropic } = await start();
		try {
			await credentials.modify("anthropic", async () => ({ type: "api_key", key: "sk-ant-connected-here" }));
			const row = await anthropic();
			expect(row.connected).toBe(true);
			expect(row.ambient).toBeUndefined();
			expect(row.source).toBeUndefined();
		} finally {
			await area.stop?.();
		}
	});

	it("connected here wins over one in the environment: the owner's replaces it", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-from-the-environment";
		const { area, credentials, anthropic } = await start();
		try {
			expect((await anthropic()).ambient).toBe(true);
			await credentials.modify("anthropic", async () => ({ type: "api_key", key: "sk-ant-connected-here" }));
			const row = await anthropic();
			expect(row.connected).toBe(true);
			expect(row.ambient).toBeUndefined();
		} finally {
			await area.stop?.();
		}
	});

	it("signed in is never ambient, even beside a key in the environment: a sign-in is the owner's", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-from-the-environment";
		const { area, credentials, anthropic } = await start();
		try {
			await credentials.modify("anthropic", async () => ({
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 3_600_000,
			}));
			const row = await anthropic();
			expect(row.connected).toBe(true);
			expect(row.ambient).toBeUndefined();
		} finally {
			await area.stop?.();
		}
	});
});
