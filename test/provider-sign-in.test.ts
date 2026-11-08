/**
 * A provider's sign-in, against pi-ai's own Anthropic flow (its loopback callback server and its copy-code method, no
 * network until a code is exchanged): one attempt per provider, the latest wins; the owner cancels it; it times out; a
 * daemon stopping ends it, callback server and all, so the process exits.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { FileCredentialStore } from "../src/core/provider-credentials.ts";
import type { Area, Deps } from "../src/server/routes/area.ts";
import { providersArea } from "../src/server/routes/providers.ts";
import { tempHome, until } from "./helpers.ts";

type Row = {
	id: string;
	connecting: boolean;
	error?: string;
	question?: string;
	method?: string;
	methods?: { id: string; label: string }[];
};

async function start(timeoutMs?: number) {
	const home = await tempHome();
	const models = builtinModels({ credentials: new FileCredentialStore(home) });
	const area = providersArea(timeoutMs === undefined ? {} : { timeoutMs }).start!({
		home,
		models,
		changed: () => {},
		log: () => {},
	} as unknown as Deps);
	const call = async <T>(method: string, path: string, body: Record<string, unknown> = {}): Promise<T> => {
		const reply = await area.route!({
			method,
			path,
			url: new URL(`http://127.0.0.1/api${path}`),
			json: async () => body,
			signal: new AbortController().signal,
		});
		if (reply === undefined || !("body" in reply)) throw new Error(`no answer for ${method} ${path}`);
		return reply.body as T;
	};
	const anthropic = async () =>
		(await call<{ id: string; accounts: Row[] }[]>("GET", "/providers"))
			.find((row) => row.id === "anthropic")!
			.accounts.find((row) => row.id === "anthropic")!;
	const signIn = async (method?: string) =>
		new URL(
			(
				await call<{ url: string }>("POST", "/providers/anthropic", {
					type: "oauth",
					...(method === undefined ? {} : { method }),
				})
			).url,
		);
	return { area, call, anthropic, signIn };
}

/** The loopback port a browser sign-in's link sends the browser back to. */
const callbackPort = (link: URL) => Number(new URL(link.searchParams.get("redirect_uri")!).port);
const listening = (port: number) =>
	new Promise<boolean>((resolve) => {
		const socket = connect(port, "127.0.0.1");
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});

describe("a provider's sign-in", () => {
	it("is cancelled by the owner: its callback server closes and nothing failed", async () => {
		const { call, anthropic, signIn, area } = await start();
		try {
			const port = callbackPort(await signIn());
			expect(await listening(port)).toBe(true);
			const row = await anthropic();
			expect(row.connecting).toBe(true);
			// the browser flow also takes the code or the redirect address pasted, for a redirect that never arrives
			expect(row.question).toBeDefined();
			expect(row.methods?.map((each) => each.id)).toEqual(["browser", "copy_code"]);
			await call("DELETE", "/providers/anthropic/sign-in");
			await until(async () => !(await listening(port)));
			const after = await anthropic();
			expect(after.connecting).toBe(false);
			expect(after.error).toBeUndefined();
		} finally {
			await area.stop?.();
		}
	});

	it("started again replaces the earlier attempt: one per provider, the latest wins", async () => {
		const { anthropic, signIn, area } = await start();
		try {
			const first = await signIn();
			const second = await signIn();
			expect(second.searchParams.get("state")).not.toBe(first.searchParams.get("state"));
			const [was, now] = [callbackPort(first), callbackPort(second)];
			expect(await listening(now)).toBe(true);
			if (was !== now) await until(async () => !(await listening(was)));
			else {
				// the second bound the port the first let go: the first's link no longer finishes anything
				const stale = await fetch(`http://127.0.0.1:${was}/callback?code=x&state=${first.searchParams.get("state")}`);
				expect(stale.status).toBe(400);
			}
			const row = await anthropic();
			expect(row.connecting).toBe(true);
			expect(row.error).toBeUndefined();
		} finally {
			await area.stop?.();
		}
	});

	it("can switch to the code the provider shows, replacing the browser attempt", async () => {
		const { call, anthropic, signIn, area } = await start();
		try {
			const browser = callbackPort(await signIn());
			const code = await signIn("copy_code");
			expect(code.searchParams.get("redirect_uri")).not.toContain("localhost");
			await until(async () => !(await listening(browser)));
			const row = await anthropic();
			expect(row).toMatchObject({ connecting: true, method: "copy_code" });
			expect(row.question).toBeDefined();
			// a code from another attempt is refused, and says so
			await call("POST", "/providers/anthropic/answer", { value: "code#not-this-attempt" });
			await until(async () => (await anthropic()).error !== undefined);
			expect((await anthropic()).error).toMatch(/state mismatch/);
		} finally {
			await area.stop?.();
		}
	});

	it("times out, closing its callback server and saying why", async () => {
		const { anthropic, signIn, area } = await start(300);
		try {
			const port = callbackPort(await signIn());
			await until(async () => (await anthropic()).error !== undefined);
			expect((await anthropic()).error).toMatch(/timed out/);
			expect((await anthropic()).connecting).toBe(false);
			await until(async () => !(await listening(port)));
		} finally {
			await area.stop?.();
		}
	});

	it("ends when the area stops, its callback server closed", async () => {
		const { signIn, area } = await start();
		const port = callbackPort(await signIn());
		expect(await listening(port)).toBe(true);
		await (area as Area).stop?.();
		expect(await listening(port)).toBe(false);
	});
});

it("a daemon stopping with a sign-in pending exits, its callback port free", async () => {
	const home = await tempHome();
	const child = spawn(process.execPath, ["src/cli/index.ts", "serve", "--port", "0", "--box", "host"], {
		env: { ...process.env, BANDA_HOME: home },
		stdio: ["ignore", "ignore", "pipe"],
	});
	const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
	try {
		let err = "";
		child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
		await until(() => /web: (http:\/\/\S+)/.test(err), 30_000);
		const web = new URL(/web: (http:\/\/\S+)/.exec(err)![1]!);
		const token = new URLSearchParams(web.hash.slice(1)).get("token")!;
		const started = await fetch(`${web.origin}/api/providers/anthropic`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ type: "oauth" }),
		});
		expect(started.ok).toBe(true);
		const port = callbackPort(new URL(((await started.json()) as { url: string }).url));
		expect(await listening(port)).toBe(true);
		child.kill("SIGTERM");
		const code = await Promise.race([
			exited,
			new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 20_000)),
		]);
		expect(code).toBe(0);
		expect(await listening(port)).toBe(false);
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await exited;
	}
}, 60_000);
