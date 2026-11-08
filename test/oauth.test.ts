/**
 * The shipped OAuth clients (`CLIENTS`): Google's flow as it was, and Slack's PKCE flow on loopback as stage 0 measured
 * it (docs/slack.md "What the spikes found"): user scopes in `user_scope`, comma-separated, no secret, the user's token.
 */
import { afterEach, expect, it } from "vitest";
import {
	begin,
	CLIENTS,
	DEFAULT_GOOGLE_CLIENT_ID,
	DEFAULT_GOOGLE_CLIENT_SECRET,
	DEFAULT_SLACK_CLIENT_ID,
	discover,
	exchange,
	refresh,
} from "../src/core/oauth.ts";
import { fakeSlack } from "./fixtures/slack.ts";

const SLACK_API = "https://slack.com/api";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

afterEach(() => {
	delete process.env.BANDA_SLACK_CLIENT_ID;
	delete process.env.BANDA_GOOGLE_CLIENT_ID;
});

it("names each built-in API's server by its client's row, without asking the network", async () => {
	const fetcher: typeof fetch = () => Promise.reject(new Error("no network"));
	expect(await discover(SLACK_API, fetcher)).toEqual(CLIENTS.slack.server);
	expect(await discover(GMAIL_API, fetcher)).toEqual(CLIENTS.google.server);
	expect(CLIENTS.slack.server).toMatchObject({
		authorize: "https://slack.com/oauth/v2/authorize",
		token: "https://slack.com/api/oauth.v2.access",
	});
});

it("takes each client's public id from the environment first, else the shipped one", () => {
	expect(CLIENTS.slack.client()).toEqual({ id: DEFAULT_SLACK_CLIENT_ID });
	expect(CLIENTS.slack.shipped()).toBe(true);
	process.env.BANDA_SLACK_CLIENT_ID = "dev.slack";
	expect(CLIENTS.slack.client()).toEqual({ id: "dev.slack" });
	expect(CLIENTS.slack.shipped()).toBe(false);
	expect(CLIENTS.google.client()).toEqual({ id: DEFAULT_GOOGLE_CLIENT_ID, secret: DEFAULT_GOOGLE_CLIENT_SECRET });
	process.env.BANDA_GOOGLE_CLIENT_ID = "dev.google";
	expect(CLIENTS.google.client().id).toBe("dev.google");
});

it("sends Slack's user scopes in user_scope, comma-separated, with PKCE and no scope, resource or response type", () => {
	const scopes = ["channels:read", "groups:read", "users:read"];
	const started = begin(
		"slack",
		SLACK_API,
		{ ...CLIENTS.slack.server, scopes },
		CLIENTS.slack.client(),
		"http://127.0.0.1:7788/oauth/callback",
		1,
		"mara",
		{ account: "@ana at Acme", id: "@ana at Acme" },
	);
	const url = new URL(started.url);
	expect(`${url.origin}${url.pathname}`).toBe("https://slack.com/oauth/v2/authorize");
	expect(url.searchParams.get("user_scope")).toBe("channels:read,groups:read,users:read");
	expect(url.searchParams.get("client_id")).toBe(DEFAULT_SLACK_CLIENT_ID);
	expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:7788/oauth/callback");
	expect(url.searchParams.get("code_challenge_method")).toBe("S256");
	expect(url.searchParams.get("state")).toBe(started.pending.state);
	for (const absent of ["scope", "resource", "response_type", "access_type", "prompt", "login_hint"])
		expect(url.searchParams.has(absent)).toBe(false);
});

it("keeps Google's authorize parameters as they were: offline, consent, a hint for an account signed in again", () => {
	const started = begin(
		"gmail",
		GMAIL_API,
		{ ...CLIENTS.google.server, scopes: ["a", "b"] },
		{ id: "client-id" },
		"http://127.0.0.1:4567",
		1,
		undefined,
		{ account: "me@example.test", id: "me@example.test" },
	);
	const url = new URL(started.url);
	expect([...url.searchParams.keys()]).toEqual([
		"response_type",
		"client_id",
		"redirect_uri",
		"code_challenge",
		"code_challenge_method",
		"state",
		"access_type",
		"prompt",
		"login_hint",
		"scope",
	]);
	expect(url.searchParams.get("scope")).toBe("a b");
	expect(url.searchParams.get("login_hint")).toBe("me@example.test");
});

it("trades Slack's code without a secret and takes the user's token from authed_user, then refreshes it", async () => {
	const slack = fakeSlack();
	const started = begin(
		"slack",
		SLACK_API,
		{ ...CLIENTS.slack.server, scopes: ["channels:read"] },
		CLIENTS.slack.client(),
		"http://127.0.0.1:7788/oauth/callback",
		1_000,
	);
	const tokens = await exchange(started.pending, "one-use-code", 1_000, slack.fetch);
	expect(tokens).toEqual({
		access: "xoxp-2",
		refresh: "xoxe-2",
		expires: 1_000 + 43_200_000,
		scopes: slack.granted.split(","),
	});
	const sent = slack.tokenBodies[0];
	expect(sent?.get("client_id")).toBe(DEFAULT_SLACK_CLIENT_ID);
	expect(sent?.get("code")).toBe("one-use-code");
	expect(sent?.get("code_verifier")).toBe(started.pending.verifier);
	expect(sent?.get("redirect_uri")).toBe("http://127.0.0.1:7788/oauth/callback");
	expect(sent?.has("client_secret")).toBe(false);
	expect(sent?.has("resource")).toBe(false);

	const fresh = await refresh(started.pending.server, started.pending.client, tokens, SLACK_API, 5_000, slack.fetch);
	expect(fresh).toMatchObject({ access: "xoxp-3", refresh: "xoxe-3", expires: 5_000 + 43_200_000 });
	const again = slack.tokenBodies[1];
	expect(Object.fromEntries(again?.entries() ?? [])).toEqual({
		grant_type: "refresh_token",
		refresh_token: "xoxe-2",
		client_id: DEFAULT_SLACK_CLIENT_ID,
	});
});

it("says Slack's refusal, which comes as 200 with ok false, in words with its code", async () => {
	const slack = fakeSlack();
	const started = begin(
		"slack",
		SLACK_API,
		CLIENTS.slack.server,
		CLIENTS.slack.client(),
		"http://127.0.0.1:7788/oauth/callback",
		1,
	);
	await expect(exchange(started.pending, "wrong-code", 1, slack.fetch)).rejects.toThrow(
		"slack.com refused the sign-in (invalid_code)",
	);
	await expect(
		refresh(CLIENTS.slack.server, CLIENTS.slack.client(), { access: "x", refresh: "stale" }, SLACK_API, 1, slack.fetch),
	).rejects.toThrow("(invalid_refresh_token)");
});
