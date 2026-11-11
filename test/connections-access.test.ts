/**
 * Each account's own access to a connection: its scopes, what a tool needs, staleness (split from connections.test.ts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { context } from "../src/core/store.ts";
import { connectionFile, signInAsOwner } from "./fixtures/connected.ts";
import { changeOf, closeAll, fakes, open } from "./fixtures/connections-world.ts";
import { type FakeMcp, startFakeMcp } from "./fixtures/mcp-server.ts";

/** Held at the next read of the box, so a test can finish a sign-in inside a view that has already read the store. */
const boxRead = vi.hoisted(() => ({ hold: undefined as Promise<void> | undefined }));
vi.mock("../src/server/agents.ts", async (actual) => {
	const agents = await actual<typeof import("../src/server/agents.ts")>();
	return {
		...agents,
		boxFiles: async (...args: Parameters<typeof agents.boxFiles>) => {
			const hold = boxRead.hold;
			boxRead.hold = undefined;
			await hold;
			return agents.boxFiles(...args);
		},
	};
});

afterEach(closeAll);

describe("each account's own access", () => {
	const fileWith = (fake: FakeMcp, scopes: string[], needs: Record<string, string[]> = { whoami: ["repo"] }) =>
		`${connectionFile({ url: fake.url, auth: "oauth", client: "banda-app", scopes, account: "get_me.login", reads: ["whoami", "list_events"] })}\n\`\`\`json\n${JSON.stringify({ needs })}\n\`\`\`\n`;
	const shown = async (s: Awaited<ReturnType<typeof open>>) =>
		(await s.capabilities.view()).connections.find((c) => c.name === "cal");
	const as = async (
		s: Awaited<ReturnType<typeof open>>,
		fake: FakeMcp,
		user: string,
		choice: { scopes?: string[]; account?: string } = {},
	) => {
		fake.user = user;
		expect(await signInAsOwner(s.capabilities, "cal", { fake, choice })).toEqual({ ok: true, words: "connected" });
	};
	const twoAccounts = async () => {
		const fake = await startFakeMcp({ auth: "oauth", registeredClient: "banda-app", device: true });
		fake.needs = { whoami: "repo" };
		fakes.push(fake);
		const s = await open(fake);
		s.writeBox("connections/cal.md", fileWith(fake, ["read:user"]));
		await s.capabilities.acceptConnection("cal", ((await changeOf(s, "cal")) as { sha: string }).sha);
		await as(s, fake, "alice", { scopes: ["read:user"] });
		await as(s, fake, "bob", { scopes: ["read:user", "repo"] });
		return { fake, s };
	};

	it("two accounts of one connection ask for their own scopes; each fits and says what it was given", async () => {
		const { fake, s } = await twoAccounts();
		expect(fake.scopesAsked).toEqual(["read:user", "read:user repo"]);
		const view = await shown(s);
		expect(view?.state).toBe("connected");
		expect(view?.accepted?.connection).toMatchObject({ scopes: ["read:user"], ceiling: ["read:user", "repo"] });
		expect(view?.accounts).toEqual([
			expect.objectContaining({ account: "alice", scopes: ["read:user"], missing: ["repo"], agents: ["sancho"] }),
			expect.objectContaining({ account: "bob", scopes: ["read:user", "repo"], agents: ["sancho"] }),
		]);
		expect(view?.accounts?.some((account) => account.stale === true)).toBe(false);
		expect(view?.accounts?.[1]?.missing).toBeUndefined();
	});

	it("a tool an account was not given access for is refused in words, before any request", async () => {
		const { fake, s } = await twoAccounts();
		s.model.plan([{ tool: "cal__whoami", args: { account: "alice" } }]);
		const refused = await s.say("who am I as alice?");
		await s.done(refused.turn);
		const result = (await s.results(refused.chat)).at(-1);
		expect(result?.error).toBe(true);
		expect(result?.text).toContain(
			"@alice was not given access for this on Calendar: the owner can change its access in Connections",
		);
		expect(fake.calls).toEqual([]);
		// a tool that needs nothing runs as the same account, and the other account may call the first
		s.model.plan([{ tool: "cal__list_events", args: { account: "alice", day: "mon" } }]);
		s.model.plan([{ tool: "cal__whoami", args: { account: "bob" } }]);
		const listed = await s.say("monday as alice?");
		await s.done(listed.turn);
		const asBob = await s.say("who am I as bob?");
		await s.done(asBob.turn);
		expect((await s.results(asBob.chat)).at(-1)).toMatchObject({ error: false });
		expect(fake.calls.map((call) => call.tool)).toEqual(["list_events", "whoami"]);
	});

	it("signing one account in again with more leaves the other as it was, its switches kept", async () => {
		const { fake, s } = await twoAccounts();
		const bobCredentials = () => readFileSync(join(s.home, "auth", "connections", "cal", "bob", "credentials.json"));
		const bobBefore = bobCredentials();
		await s.capabilities.switchAccount("sancho", "cal", "bob", false);
		await as(s, fake, "alice", { account: "alice", scopes: ["read:user", "repo"] });
		const view = await shown(s);
		expect(view?.finished).toMatchObject({ account: "alice", known: true });
		expect(view?.finished?.expected).toBeUndefined();
		expect(view?.accounts).toEqual([
			expect.objectContaining({ account: "alice", scopes: ["read:user", "repo"], agents: ["sancho"] }),
			expect.objectContaining({ account: "bob", scopes: ["read:user", "repo"], agents: [] }),
		]);
		expect(view?.accounts?.[0]?.missing).toBeUndefined();
		expect(bobCredentials()).toEqual(bobBefore);
		// signed in again with no choice, an account asks for what it asked for last, not the file's default
		await as(s, fake, "alice", { account: "alice" });
		expect(fake.scopesAsked.at(-1)).toBe("read:user repo");
	});

	it("refuses scopes the file does not let an account ask for, and an account it does not know", async () => {
		const { s } = await twoAccounts();
		await expect(s.capabilities.signIn("cal", context, undefined, { scopes: ["read:user", "gist"] })).rejects.toThrow(
			"Calendar may not ask for gist: an account asks for some of read:user, repo",
		);
		await expect(s.capabilities.signIn("cal", context, undefined, { scopes: "repo" })).rejects.toThrow(
			/a list of names/,
		);
		await expect(s.capabilities.signIn("cal", context, undefined, { scopes: [] })).rejects.toThrow(/a list of names/);
		await expect(s.capabilities.signIn("cal", context, undefined, { account: "carol" })).rejects.toThrow(
			"Calendar has no account carol to sign in again",
		);
		expect((await shown(s))?.state).toBe("connected");
	});

	it("a sign-in again that comes back as another account keeps it as that one, and says so", async () => {
		const { fake, s } = await twoAccounts();
		await as(s, fake, "carol", { account: "alice" });
		const view = await shown(s);
		expect(view?.finished).toMatchObject({ account: "carol", expected: "alice", known: false });
		expect(view?.accounts?.map((account) => account.account)).toEqual(["alice", "bob", "carol"]);
		expect(view?.accounts?.[0]).toMatchObject({ scopes: ["read:user"] });
	});

	it("a sign-in that asked for nothing does not fit once the file names scopes", async () => {
		// a server that advertises no scopes: its sign-in asks for none, and is given its default
		const fake = await startFakeMcp({ auth: "oauth", registeredClient: "banda-app", device: true, scopes: [] });
		fakes.push(fake);
		const s = await open(fake);
		s.writeBox(
			"connections/cal.md",
			connectionFile({ url: fake.url, auth: "oauth", client: "banda-app", account: "get_me.login", reads: ["whoami"] }),
		);
		await s.capabilities.acceptConnection("cal", ((await changeOf(s, "cal")) as { sha: string }).sha);
		await as(s, fake, "alice");
		expect((await shown(s))?.accounts?.[0]?.stale).toBeUndefined();
		s.writeBox("connections/cal.md", fileWith(fake, ["read:user"], {}));
		await s.capabilities.acceptConnection("cal", ((await changeOf(s, "cal")) as { sha: string }).sha);
		expect((await shown(s))?.accounts?.[0]?.stale).toBe(true);
	});

	it("a view begun during a sign-in by code never says to sign in, though the sign-in ends before the view does", async () => {
		const fake = await startFakeMcp({ auth: "oauth", registeredClient: "banda-app", device: true, scopes: [] });
		fakes.push(fake);
		const s = await open(fake);
		s.writeBox(
			"connections/cal.md",
			connectionFile({ url: fake.url, auth: "oauth", client: "banda-app", account: "get_me.login", reads: ["whoami"] }),
		);
		await s.capabilities.acceptConnection("cal", ((await changeOf(s, "cal")) as { sha: string }).sha);
		fake.user = "alice";
		const started = await s.capabilities.signIn("cal", context, undefined, {});
		if (!("code" in started)) throw new Error("expected a sign-in by code");
		let release = () => {};
		boxRead.hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		// this view reads the store, with no account yet, and stays at the box while the sign-in finishes
		const reading = shown(s);
		while (boxRead.hold !== undefined) await new Promise((resolve) => setTimeout(resolve, 5));
		await fake.typeCode(started.code, true);
		while ((await shown(s))?.state !== "connected") await new Promise((resolve) => setTimeout(resolve, 25));
		release();
		expect((await reading)?.state).toBe("signing-in");
	});

	it("narrowing what an account may ask for makes the accounts beyond it stale; changing the default does not", async () => {
		const { s } = await twoAccounts();
		s.writeBox("connections/cal.md", fileWith(s.fake as FakeMcp, ["read:user", "repo"]));
		await s.capabilities.acceptConnection("cal", ((await changeOf(s, "cal")) as { sha: string }).sha);
		expect((await shown(s))?.accounts?.some((account) => account.stale === true)).toBe(false);
		// no tool needs repo any more, and the default does not ask for it: bob asked for more than may be asked
		s.writeBox("connections/cal.md", fileWith(s.fake as FakeMcp, ["read:user"], {}));
		await s.capabilities.acceptConnection("cal", ((await changeOf(s, "cal")) as { sha: string }).sha);
		const view = await shown(s);
		expect(view?.accounts?.find((account) => account.account === "alice")?.stale).toBeUndefined();
		expect(view?.accounts?.find((account) => account.account === "bob")?.stale).toBe(true);
	});
});
