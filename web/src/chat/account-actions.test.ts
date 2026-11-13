/**
 * Acting on a connection's accounts (#62): each account is one row with its name, the agents that use it and a menu of
 * what acts on it; what adds one is "Add account", below the list; with none, a single "Connect". The same on the
 * connection's page and in the MCP setup's connected step; Settings' providers add theirs with the same words. Signing
 * out says who loses access, as what the daemon's sign-out does.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AccountView, ConnectionView } from "../../../src/server/api.ts";
import { McpSetupView } from "../app/McpSetup.tsx";
import type { ChatAgent } from "../lib/navigation.ts";
import { MARA, OCTO, SANCHO } from "../specimen/fixtures.ts";
import { ConnectionDetailsView } from "./ConnectionDetails.tsx";
import { ModelProviders, type ProviderRow } from "./Settings.tsx";

// the MCP setup reaches the daemon's API, which reads the page's address when it loads; here there is no page
vi.hoisted(() => {
	Object.assign(globalThis, {
		location: { hash: "", pathname: "/", search: "", origin: "http://127.0.0.1" },
		history: { replaceState: () => {} },
		addEventListener: () => {},
	});
});

const AGENTS: readonly ChatAgent[] = [
	{ id: "sancho", ...SANCHO },
	{ id: "mara", ...MARA },
	{ id: "octo", ...OCTO },
];

const account = (account: string, agents: readonly string[], more: Partial<AccountView> = {}): AccountView => ({
	account,
	id: account,
	label: `@${account}`,
	at: Date.UTC(2026, 10, 9),
	agents,
	scopes: [],
	...more,
});

const VIEW: ConnectionView = {
	name: "github",
	state: "connected",
	accepted: {
		version: "v1",
		connection: {
			service: "GitHub",
			url: "https://api.githubcopilot.com/mcp/",
			where: "api.githubcopilot.com",
			auth: "oauth",
			reads: [],
			floors: {},
		},
	},
	tools: [],
	groups: [],
	accounts: [account("bandarra", ["mara", "sancho"]), account("purrgrammer", ["mara"])],
	draws: [],
};

/** The words a person reads, with no markup between them. */
const text = (html: string) =>
	html
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();

/** The markup of the account row for `key`. */
const row = (html: string, key: string) => {
	const at = html.indexOf(`data-account="${key}"`);
	expect(at).toBeGreaterThan(-1);
	const end = html.indexOf("</li>", at);
	return html.slice(at, end);
};

const RETIRED = ["Sign in another", "Another account", "Add another"];

const details = (view: ConnectionView, more: object = {}) =>
	renderToStaticMarkup(
		createElement(ConnectionDetailsView, {
			view,
			service: "GitHub",
			mode: "details",
			agents: AGENTS,
			agentsFor: [],
			onSignOut: () => {},
			onChangeAccess: () => {},
			onAdd: () => {},
			...more,
		} as Parameters<typeof ConnectionDetailsView>[0]),
	);

describe("a connection's accounts on its page", () => {
	it("draws each account as one row: its name, the agents that use it, and a menu, never a flat Sign out", () => {
		const page = details(VIEW);
		const bandarra = row(page, "bandarra");
		expect(text(bandarra)).toContain("@bandarra");
		expect(text(bandarra)).toContain("Mara, Sancho");
		expect(bandarra).toContain('aria-label="More for @bandarra"');
		expect(bandarra).toContain('aria-haspopup="menu"');
		expect(text(bandarra)).not.toContain("Sign out");
		expect(text(bandarra)).not.toContain("Change access");
		expect(text(row(page, "purrgrammer"))).toContain("Mara");
	});

	it("says when no agent uses an account", () => {
		const page = details({ ...VIEW, accounts: [account("bandarra", [])] });
		expect(text(row(page, "bandarra"))).toContain("No agent uses it");
	});

	it("adds an account with one control below the list, in one wording", () => {
		const page = details(VIEW);
		const words = text(page);
		expect(words.match(/Add account/g)).toHaveLength(1);
		// below every account, never inside a row
		expect(page.indexOf("Add account")).toBeGreaterThan(page.lastIndexOf('data-account="'));
		for (const retired of RETIRED) expect(words).not.toContain(retired);
	});

	it("offers a single Connect when no account is signed in", () => {
		const page = details({ ...VIEW, accounts: [] });
		const words = text(page);
		expect(words.match(/\bConnect\b/g)).toHaveLength(1);
		expect(words).not.toContain("Add account");
	});

	it("gives the row menu a 44px target on a phone", () => {
		const trigger = row(details(VIEW), "bandarra").match(/<button[^>]*aria-label="More for @bandarra"[^>]*>/)?.[0];
		expect(trigger).toMatch(/max-sm:size-11/);
	});
});

describe("the MCP setup's connected step", () => {
	const view: ConnectionView = {
		...VIEW,
		name: "ernesto",
		accepted: {
			version: "v1",
			connection: {
				service: "Ernesto",
				url: "https://ernesto.example/mcp",
				where: "ernesto.example",
				auth: "oauth",
				reads: [],
				floors: {},
			},
		},
		accounts: [account("work", ["sancho"]), account("home", [])],
	};
	const done = renderToStaticMarkup(
		createElement(McpSetupView, {
			state: {
				phase: "done",
				view,
				agents: AGENTS,
				busy: false,
				error: "",
				credential: "",
				account: "work",
				label: "",
				selected: ["sancho"],
				chosen: {},
			},
			actions: new Proxy({}, { get: () => () => {} }) as Parameters<typeof McpSetupView>[0]["actions"],
		}),
	);

	it("lists each account as a row with its menu, and adds below, in the same words as the connection's page", () => {
		expect(text(row(done, "work"))).toContain("Sancho");
		expect(row(done, "work")).toContain('aria-label="More for @work"');
		expect(text(row(done, "home"))).toContain("No agent uses it");
		const words = text(done);
		expect(words.match(/Add account/g)).toHaveLength(1);
		for (const retired of [...RETIRED, "Sign in another account"]) expect(words).not.toContain(retired);
		// Sign out acts on one account: it is in that account's menu, not a button beside the list
		expect(words).not.toContain("Sign out");
	});

	it("keeps each account's menu and Add account usable while the server is not connected", () => {
		const problem = renderToStaticMarkup(
			createElement(McpSetupView, {
				state: {
					phase: "done",
					view: { ...view, state: "problem", problem: "The server answered 401." },
					agents: AGENTS,
					busy: false,
					error: "",
					credential: "",
					account: "work",
					label: "",
					selected: ["sancho"],
					chosen: {},
				},
				actions: new Proxy({}, { get: () => () => {} }) as Parameters<typeof McpSetupView>[0]["actions"],
			}),
		);
		// signing a broken account out, or another in, is how the owner gets out of it
		const trigger = row(problem, "work").match(/<button[^>]*aria-label="More for @work"[^>]*>/)?.[0];
		expect(trigger).not.toMatch(/\bdisabled=""/);
		const add = problem.match(/<button[^>]*>(?:(?!<\/button>).)*Add account<\/button>/)?.[0];
		expect(add).toBeDefined();
		expect(add).not.toMatch(/\bdisabled=""/);
		// what it can't change until it is connected again stays off
		const switches = [...problem.matchAll(/<button[^>]*role="switch"[^>]*>/g)].map((each) => each[0]);
		expect(switches.length).toBeGreaterThan(0);
		for (const each of switches) expect(each).toMatch(/\bdisabled=""/);
	});
});

describe("Settings' provider accounts", () => {
	const accounts: readonly ProviderRow[] = [
		{ id: "anthropic", name: "Anthropic", provider: "anthropic", label: "Personal", by: "sign-in", connected: true },
		{ id: "anthropic@work", name: "Anthropic", provider: "anthropic", label: "Work", by: "sign-in", connected: true },
		{ id: "mistral", name: "Mistral", provider: "mistral", label: "Mistral", by: "key", connected: true },
	];
	const page = renderToStaticMarkup(
		createElement(ModelProviders, { current: "anthropic", providers: accounts, onAdd: () => {}, onRename: () => {} }),
	);

	it("adds another account in the same words, whether it signs in or takes a key", () => {
		const words = text(page);
		expect(words.match(/Add account/g)).toHaveLength(2);
		for (const retired of RETIRED) expect(words).not.toContain(retired);
	});

	it("keeps Rename and Sign out in each account's menu at every width", () => {
		expect(page).toContain('aria-label="More for Anthropic · Work"');
		expect(page).toContain('aria-label="More for Mistral"');
		expect(page).not.toContain('aria-label="Sign out of Anthropic · Work"');
		expect(text(page)).not.toContain("Sign out");
	});
});

describe("what signing out says", () => {
	const effect = "Its sign-in is forgotten, and the permissions, watches and waiting drafts that use it end.";

	it("names who loses access, in a sentence for none, one or many", async () => {
		const { signOutWords } = await import("./Accounts.tsx");
		const words = (names: readonly string[]) => signOutWords("@bandarra", names);
		expect(words(["Mara", "Sancho"])).toEqual({
			title: "Sign out of @bandarra?",
			body: `Mara and Sancho lose access to @bandarra. ${effect} You can sign in again.`,
		});
		expect(words(["Mara"]).body).toBe(`Mara loses access to @bandarra. ${effect} You can sign in again.`);
		expect(words(["Mara", "Sancho", "Octo"]).body).toBe(
			`Mara, Sancho and Octo lose access to @bandarra. ${effect} You can sign in again.`,
		);
		expect(words([]).body).toBe(`No agent uses @bandarra. ${effect} You can sign in again.`);
	});
});
