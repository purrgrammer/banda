/**
 * Signing in to a connection by code, as the client a connection file names (split from connections.test.ts).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConnection } from "../src/core/connections.ts";
import { context } from "../src/core/store.ts";
import { connectionFile, signInAsOwner } from "./fixtures/connected.ts";
import { changeOf, closeAll, fakes, open } from "./fixtures/connections-world.ts";
import { type FakeMcp, startFakeMcp } from "./fixtures/mcp-server.ts";
import { until } from "./helpers.ts";

afterEach(closeAll);

describe("signing in by code, as a file's named client", () => {
	const fileOf = (fake: FakeMcp, extra: { scopes?: string[]; account?: string } = {}) =>
		connectionFile({ url: fake.url, auth: "oauth", client: "banda-app", reads: ["whoami"], ...extra });
	const shown = async (s: Awaited<ReturnType<typeof open>>) =>
		(await s.capabilities.view()).connections.find((c) => c.name === "cal");

	it("a file names its client and scopes only for a server the owner signs in to", () => {
		expect(
			parseConnection("cal", fileOf({ url: "https://a.example/mcp" } as FakeMcp, { scopes: ["repo", "read:org"] })),
		).toMatchObject({ connection: { client: "banda-app", scopes: ["repo", "read:org"] } });
		expect(
			parseConnection("cal", "---\nservice: Cal\nurl: https://a.example/mcp\nauth: key\nclient: x\n---\n"),
		).toEqual({
			errors: ['"client" and "scopes" are for a server the owner signs in to: add "auth: oauth" or drop them'],
		});
		expect(
			parseConnection("cal", "---\nservice: Cal\nurl: https://a.example/mcp\nauth: oauth\nclient: a b\n---\n"),
		).toEqual({ errors: ['"client: a b" is not a client id: letters, digits, dots, dashes and underscores'] });
	});

	it("registers nothing, asks for the file's scopes, shows the code until typed, then connects and reads", async () => {
		const fake = await startFakeMcp({ auth: "oauth", registeredClient: "banda-app", device: true, scopes: ["all"] });
		fakes.push(fake);
		const s = await open(fake);
		s.writeBox("connections/cal.md", fileOf(fake, { scopes: ["read:user"] }));
		await s.capabilities.acceptConnection("cal", ((await changeOf(s, "cal")) as { sha: string }).sha);
		expect((await shown(s))?.accepted?.connection?.scopes).toEqual(["read:user"]);
		const started = await s.capabilities.signIn("cal", context, "sancho");
		expect(started).toMatchObject({ code: expect.any(String), page: `${fake.origin}/device` });
		expect(fake.scopesAsked).toEqual(["read:user"]);
		const code = (started as { code: string }).code;
		expect(await shown(s)).toMatchObject({ state: "signing-in", code: { code, page: `${fake.origin}/device` } });
		expect(s.offered()).toEqual([]);
		fake.typeCode(code);
		await until(async () => ((await shown(s))?.state === "connected" ? true : undefined));
		expect((await shown(s))?.code).toBeUndefined();
		s.model.plan([{ tool: "cal__whoami" }]);
		const { turn, chat } = await s.say("who am I?");
		await s.done(turn);
		expect((await s.results(chat)).at(-1)?.text).toContain("you sent Bearer [a credential, hidden]");
		// an expired token is refreshed as the same client, with no secret
		fake.tokens.clear();
		s.model.plan([{ tool: "cal__whoami" }]);
		const again = await s.say("and now?");
		await s.done(again.turn);
		expect((await s.results(again.chat)).at(-1)?.error).toBe(false);
		expect(fake.refreshed).toEqual([{ client: "banda-app", secret: false }]);
	});

	it("a file's default scopes are each new account's: changing them keeps the accounts, narrowing what may be asked does not", async () => {
		const fake = await startFakeMcp({ auth: "oauth", registeredClient: "banda-app", device: true });
		fakes.push(fake);
		const s = await open(fake);
		s.writeBox("connections/cal.md", fileOf(fake, { scopes: ["read:user"] }));
		await s.capabilities.acceptConnection("cal", ((await changeOf(s, "cal")) as { sha: string }).sha);
		expect(await signInAsOwner(s.capabilities, "cal", { fake })).toEqual({ ok: true, words: "connected" });
		// a wider default is for accounts signed in from now on: this one keeps what it asked for
		s.writeBox("connections/cal.md", fileOf(fake, { scopes: ["read:user", "repo"] }));
		await s.capabilities.acceptConnection("cal", ((await changeOf(s, "cal")) as { sha: string }).sha);
		await until(async () => ((await shown(s))?.state === "connected" ? true : undefined));
		expect((await shown(s))?.accounts?.[0]).toMatchObject({ scopes: ["read:user"] });
		expect((await shown(s))?.accounts?.[0]?.stale).toBeUndefined();
		// a file that no longer lets an account ask for what this one asked: the old token is not kept for it
		s.writeBox("connections/cal.md", fileOf(fake, { scopes: ["repo"] }));
		await s.capabilities.acceptConnection("cal", ((await changeOf(s, "cal")) as { sha: string }).sha);
		expect((await shown(s))?.state).toBe("sign-in");
		expect((await shown(s))?.accounts?.[0]?.stale).toBe(true);
		expect(s.offered()).toEqual([]);
		expect(await signInAsOwner(s.capabilities, "cal", { fake })).toEqual({ ok: true, words: "connected" });
		expect(fake.scopesAsked).toEqual(["read:user", "repo"]);
	});

	it("a scope a tool needs shows on it, from the server's challenge; adding it means signing in again", async () => {
		const fake = await startFakeMcp({
			auth: "oauth",
			registeredClient: "banda-app",
			device: true,
			scopes: ["read:user", "repo", "gist"],
		});
		fake.needs = { whoami: "repo" };
		fakes.push(fake);
		const s = await open(fake);
		s.writeBox("connections/cal.md", fileOf(fake, { scopes: ["read:user"], account: "get_me.login" }));
		await s.capabilities.acceptConnection("cal", ((await changeOf(s, "cal")) as { sha: string }).sha);
		// what the server can grant is learnt in the background, for the owner to pick from
		await until(async () => ((await shown(s))?.offered !== undefined ? true : undefined));
		expect((await shown(s))?.offered).toEqual(["read:user", "repo", "gist"]);
		expect(await signInAsOwner(s.capabilities, "cal", { fake })).toEqual({ ok: true, words: "connected" });
		s.model.plan([{ tool: "cal__whoami" }]);
		const ran = await s.say("who am I?");
		await s.done(ran.turn);
		const refused = (await s.results(ran.chat)).at(-1);
		expect(refused?.error).toBe(true);
		expect(refused?.text).toContain("it needs repo, which the owner has not given banda");
		expect(fake.calls).toEqual([]);
		const before = await shown(s);
		expect(before?.accounts?.[0]?.missing).toEqual(["repo"]);
		expect(before?.tools.find((t) => t.title === "whoami")?.needs).toEqual(["repo"]);
		// beyond what the file allows, an account cannot ask: the owner widens the file, then signs that account in again
		const choice = { scopes: ["read:user", "repo"], account: before?.accounts?.[0]?.account as string };
		await expect(signInAsOwner(s.capabilities, "cal", { fake, choice })).rejects.toThrow(/may not ask for repo/);
		s.writeBox("connections/cal.md", fileOf(fake, { scopes: ["read:user", "repo"], account: "get_me.login" }));
		await s.capabilities.acceptConnection("cal", ((await changeOf(s, "cal")) as { sha: string }).sha);
		expect(await signInAsOwner(s.capabilities, "cal", { fake, choice })).toEqual({ ok: true, words: "connected" });
		const after = await shown(s);
		expect(after?.accounts).toHaveLength(1);
		expect(after?.accounts?.[0]?.missing).toBeUndefined();
		expect(after?.tools.find((t) => t.title === "whoami")?.needs).toBeUndefined();
		s.model.plan([{ tool: "cal__whoami" }]);
		const again = await s.say("and now?");
		await s.done(again.turn);
		expect((await s.results(again.chat)).at(-1)?.error).toBe(false);
	});

	it("a scope the owner left out at the consent screen is not the account's; it connects with what was given", async () => {
		const fake = await startFakeMcp({ auth: "oauth", registeredClient: "banda-app", device: true });
		fake.withheld = ["repo"];
		fakes.push(fake);
		const s = await open(fake);
		s.writeBox("connections/cal.md", fileOf(fake, { scopes: ["read:user", "repo"] }));
		await s.capabilities.acceptConnection("cal", ((await changeOf(s, "cal")) as { sha: string }).sha);
		expect(await signInAsOwner(s.capabilities, "cal", { fake })).toEqual({ ok: true, words: "connected" });
		// the tokens came without repo: connected with what was given, which the account says
		expect((await shown(s))?.accounts?.[0]?.scopes).toEqual(["read:user"]);
		expect((await shown(s))?.state).toBe("connected");
	});

	it("a declined code says so; signing in again starts a new code and connects", async () => {
		const fake = await startFakeMcp({ auth: "oauth", registeredClient: "banda-app", device: true });
		fakes.push(fake);
		const s = await open(fake);
		s.writeBox("connections/cal.md", fileOf(fake));
		await s.capabilities.acceptConnection("cal", ((await changeOf(s, "cal")) as { sha: string }).sha);
		expect(await signInAsOwner(s.capabilities, "cal", { fake, consent: false })).toEqual({
			ok: false,
			words: "signing in did not finish: the sign-in was declined",
		});
		expect(await signInAsOwner(s.capabilities, "cal", { fake })).toEqual({ ok: true, words: "connected" });
	});

	it("disconnecting while the code waits stops it: typed later, nothing is kept", async () => {
		const fake = await startFakeMcp({ auth: "oauth", registeredClient: "banda-app", device: true });
		fakes.push(fake);
		const s = await open(fake);
		s.writeBox("connections/cal.md", fileOf(fake));
		await s.capabilities.acceptConnection("cal", ((await changeOf(s, "cal")) as { sha: string }).sha);
		const { code } = (await s.capabilities.signIn("cal", context, "sancho")) as { code: string };
		await s.capabilities.disconnect("cal");
		expect((await shown(s))?.state).toBe("sign-in");
		fake.typeCode(code);
		await new Promise((resolve) => setTimeout(resolve, 1500));
		expect(fake.codes.size).toBe(1); // never asked for again, so never handed tokens
		expect((await shown(s))?.state).toBe("sign-in");
		expect(existsSync(join(s.home, "auth", "connections", "cal.json"))).toBe(false);
	});

	it("a named client at a server without sign-in by code goes through the callback, registering nothing", async () => {
		const fake = await startFakeMcp({ auth: "oauth", registeredClient: "banda-app" });
		fakes.push(fake);
		const s = await open(fake);
		s.writeBox("connections/cal.md", fileOf(fake, { scopes: ["read:user"] }));
		await s.capabilities.acceptConnection("cal", ((await changeOf(s, "cal")) as { sha: string }).sha);
		await expect(s.capabilities.signIn("cal", context, "sancho", { onDevice: true })).rejects.toThrow(
			/computer Banda runs on/,
		);
		expect(await signInAsOwner(s.capabilities, "cal")).toEqual({
			ok: true,
			words: "Signed in to Calendar as 127.0.0.1.",
		});
		expect(fake.scopesAsked).toEqual(["read:user"]);
	});
});
