/** The connect card in every state, from the daemon's view of a connection and the card's own sign-in. */
import { describe, expect, it } from "vitest";
import type { AccountView, ConnectionView } from "../../../src/server/api.ts";
import { connectState } from "./connect.ts";

const account = (key: string, agents: string[] = [], stale = false): AccountView => ({
	account: key,
	id: key,
	label: `@${key}`,
	at: 1,
	agents,
	...(stale ? { stale: true } : {}),
});
const view = (extra: Partial<ConnectionView> = {}): ConnectionView => ({
	name: "github",
	state: "sign-in",
	tools: [],
	accounts: [],
	...extra,
});
const idle = { kind: "idle" } as const;

describe("the connect card", () => {
	it("offers Connect with nothing signed in, and the code once its sign-in started", () => {
		expect(connectState(view(), idle, "mara", "why")).toEqual({ kind: "connect", why: "why" });
		const started = { kind: "started", before: undefined } as const;
		const signing = view({ state: "signing-in", code: { code: "AB-CD", page: "https://g/device", expires: 9 } });
		expect(connectState(signing, started, "mara", "why")).toEqual({
			kind: "code",
			code: "AB-CD",
			url: "https://g/device",
		});
		// by redirect: the service's page, no code
		expect(connectState(view(), { kind: "started", url: "https://g/authorize" }, "mara", "why")).toEqual({
			kind: "code",
			url: "https://g/authorize",
		});
	});

	it("says done once the daemon saw the grant for this agent, and says so of an account it knew", () => {
		const done = view({
			state: "connected",
			accounts: [account("bandarra", ["mara"])],
			finished: { account: "bandarra", id: "bandarra", agent: "mara", known: false, at: 5 },
		});
		expect(connectState(done, { kind: "started", before: 2 }, "mara", "why")).toEqual({
			kind: "done",
			login: "@bandarra",
		});
		const again = view({
			...done,
			finished: { ...(done.finished as NonNullable<ConnectionView["finished"]>), known: true, at: 6 },
		});
		expect(connectState(again, { kind: "started", before: 5 }, "mara", "why")).toEqual({
			kind: "already",
			login: "@bandarra",
		});
		// a sign-in another card finished before this one started is not this one's
		expect(connectState(done, { kind: "started", before: 5 }, "mara", "why")).toMatchObject({ kind: "done" });
	});

	it("does not claim the agent was enabled when the sign-in access switch was refused", () => {
		const connected = view({
			state: "connected",
			accounts: [account("bandarra")],
			finished: {
				account: "bandarra",
				id: "bandarra",
				agent: "mara",
				enabled: false,
				problem: "review the agent's pending file first",
				known: false,
				at: 5,
			},
		});
		expect(connectState(connected, { kind: "started", before: 2 }, "mara", "why")).toEqual({
			kind: "share",
			login: "@bandarra",
			why: "review the agent's pending file first",
		});
	});

	it("fails with why, and Try again; a code that expired is a failure", () => {
		expect(connectState(view(), { kind: "failed", why: "no" }, "mara", "why")).toEqual({ kind: "failed", why: "no" });
		const expired = view({ state: "problem", problem: "the code expired before it was typed: sign in again" });
		expect(connectState(expired, { kind: "started" }, "mara", "why")).toMatchObject({ kind: "failed" });
	});

	it("is one tap for an agent when an account exists: share one, pick among several", () => {
		expect(connectState(view({ accounts: [account("bandarra", ["sancho"])] }), idle, "mara", "why")).toEqual({
			kind: "share",
			login: "@bandarra",
		});
		expect(
			connectState(view({ accounts: [account("a"), account("b"), account("c", [], true)] }), idle, "mara", "why"),
		).toEqual({ kind: "known", logins: ["@a", "@b"] });
		// unnamed accounts read the same, so only a named one can be picked
		const numbered = (name: string, ownerLabel?: string): AccountView => ({
			...account(name),
			label: ownerLabel ?? "Unnamed account",
			numbered: true,
			...(ownerLabel === undefined ? {} : { ownerLabel }),
		});
		expect(connectState(view({ accounts: [numbered("x", "Work"), numbered("y")] }), idle, "mara", "why")).toEqual({
			kind: "known",
			logins: ["Work"],
		});
		expect(connectState(view({ accounts: [numbered("x"), numbered("y")] }), idle, "mara", "why")).toMatchObject({
			kind: "connect",
		});
		// from Settings, for no agent: Connect another
		expect(connectState(view({ accounts: [account("a")] }), idle, undefined, "why")).toMatchObject({
			kind: "connect",
		});
	});
});
