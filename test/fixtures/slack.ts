/**
 * A fake Slack, as a `fetch`: the PKCE sign-in's token endpoint (a code traded without a secret, a refresh), and the Web
 * API's reads and `chat.postMessage` as a user token sees them, every answer 200 with `ok`, as Slack's are. `busy`
 * answers every API call 429 with that many seconds of `Retry-After`. With `file`, posts are kept there, written whole
 * before it answers, so a process killed after Slack took a post and before banda recorded it leaves the post made.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type FakeSlackMessage = { [key: string]: unknown };
export type FakeSlackPost = { channel: string; text: string; thread_ts?: string; ts: string };

export type FakeSlack = {
	readonly fetch: typeof fetch;
	/** Each request: its method, its parameters (query or body) and the bearer it carried. */
	readonly calls: { method: string; params: Record<string, unknown>; token?: string }[];
	/** The token endpoint's form bodies, in order. */
	readonly tokenBodies: URLSearchParams[];
	posts(): FakeSlackPost[];
	/** The access token the API takes now; a refresh replaces it. */
	access: string;
	refreshToken: string;
	/** Seconds of `Retry-After` to answer every API call with 429; undefined to answer. */
	busy: number | undefined;
	/** The scopes a sign-in or a refresh says it granted, comma-separated as Slack writes them. */
	granted: string;
	/** Messages by channel, newest first, as `conversations.history` answers them. */
	readonly history: { [channel: string]: FakeSlackMessage[] };
	/** A thread's replies by `<channel>/<root ts>`, oldest first, the root not among them. */
	readonly replies: { [thread: string]: FakeSlackMessage[] };
	readonly users: { [id: string]: { [key: string]: unknown } };
	readonly channels: { [id: string]: { [key: string]: unknown } };
};

export const SLACK_TEAM = { id: "T0ACME", name: "Acme", domain: "acme" };
export const SLACK_ME = { id: "U0ANA", name: "ana" };
export const ROOT_TS = "1700000000.000100";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A world with a team, the owner, a colleague, someone from another team, two channels, a thread and a bot. */
function world() {
	const users: FakeSlack["users"] = {
		U0ANA: {
			id: "U0ANA",
			name: "ana",
			real_name: "Ana García",
			team_id: "T0ACME",
			tz: "Europe/Madrid",
			profile: { title: "Founder", status_text: "", email: "ana@acme.test" },
		},
		U0BOB: {
			id: "U0BOB",
			name: "bob",
			real_name: "Bob Stone",
			team_id: "T0ACME",
			tz: "America/New_York",
			profile: { title: "Engineer", status_text: "On call", email: "bob@acme.test" },
		},
		U0OLGA: {
			id: "U0OLGA",
			name: "olga",
			real_name: "Olga Ivanova",
			team_id: "T0OTHER",
			tz: "Europe/Berlin",
			profile: { title: "Partner", status_text: "" },
		},
	};
	const channels: FakeSlack["channels"] = {
		C0GENERAL: {
			id: "C0GENERAL",
			name: "general",
			is_private: false,
			is_member: true,
			num_members: 12,
			topic: { value: "Company-wide" },
		},
		G0DEPLOYS: {
			id: "G0DEPLOYS",
			name: "deploys",
			is_private: true,
			is_group: true,
			is_member: true,
			num_members: 4,
			topic: { value: "" },
		},
		D0BOB: { id: "D0BOB", is_im: true, user: "U0BOB", is_member: true },
	};
	const history: FakeSlack["history"] = {
		C0GENERAL: [
			{
				type: "message",
				ts: "1700000400.000500",
				user: "U0ANA",
				text: "Shipping today",
				bot_id: "B0BANDA",
				app_id: "A0BANDA",
				bot_profile: { name: "banda" },
				team: "T0ACME",
			},
			{
				type: "message",
				subtype: "bot_message",
				ts: "1700000300.000400",
				bot_id: "B0DEPLOY",
				username: "deploybot",
				bot_profile: { name: "deploybot" },
				text: "Deploy *finished* &amp; healthy",
			},
			{
				type: "message",
				ts: "1700000200.000300",
				user: "U0OLGA",
				user_team: "T0OTHER",
				text: "Hello from the partner side",
			},
			{
				type: "message",
				ts: "1700000100.000200",
				user: "U0BOB",
				team: "T0ACME",
				text: "<@U0ANA> can you check <#G0DEPLOYS>? See <https://example.test/log|the log>",
			},
			{
				type: "message",
				ts: ROOT_TS,
				user: "U0BOB",
				team: "T0ACME",
				text: "Release notes draft",
				thread_ts: ROOT_TS,
				reply_count: 2,
			},
		],
		G0DEPLOYS: [{ type: "message", ts: "1700000050.000050", user: "U0BOB", team: "T0ACME", text: "deploy 41 green" }],
		D0BOB: [],
	};
	const replies: FakeSlack["replies"] = {
		[`C0GENERAL/${ROOT_TS}`]: [
			{
				type: "message",
				ts: "1700000150.000150",
				user: "U0ANA",
				team: "T0ACME",
				text: "Looks good",
				thread_ts: ROOT_TS,
			},
			{
				type: "message",
				ts: "1700000160.000160",
				user: "U0BOB",
				team: "T0ACME",
				text: "Thanks <@U0ANA>",
				thread_ts: ROOT_TS,
			},
		],
	};
	return { users, channels, history, replies };
}

export function fakeSlack({ file, code = "one-use-code" }: { file?: string; code?: string } = {}): FakeSlack {
	const { users, channels, history, replies } = world();
	let memory: FakeSlackPost[] = [];
	const load = (): FakeSlackPost[] =>
		file === undefined ? memory : existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as FakeSlackPost[]) : [];
	const save = (posts: FakeSlackPost[]) => {
		if (file === undefined) memory = posts;
		else {
			writeFileSync(`${file}.tmp`, JSON.stringify(posts));
			renameSync(`${file}.tmp`, file);
		}
	};
	let issued = 0;
	let clock = 1700001000;
	const fake: FakeSlack = {
		calls: [],
		tokenBodies: [],
		posts: load,
		access: "xoxp-1",
		refreshToken: "xoxe-1",
		busy: undefined,
		granted:
			"channels:read,groups:read,channels:history,groups:history,users:read,im:read,mpim:read,im:history,mpim:history,search:read,chat:write",
		history,
		replies,
		users,
		channels,
		fetch: async (input, init) => {
			const url = new URL(String(input));
			if (url.origin !== "https://slack.com") return json({ ok: false, error: "not_slack" }, 404);
			const method = url.pathname.replace(/^\/api\//, "");
			if (method === "oauth.v2.access") {
				const form = new URLSearchParams(String(init?.body ?? ""));
				fake.tokenBodies.push(form);
				if (form.has("client_secret")) return json({ ok: false, error: "bad_client_secret" });
				const prior = fake.refreshToken;
				const refreshing = form.get("grant_type") === "refresh_token";
				if (refreshing && form.get("refresh_token") !== prior)
					return json({ ok: false, error: "invalid_refresh_token" });
				if (!refreshing && (form.get("code") !== code || !form.get("code_verifier")))
					return json({ ok: false, error: "invalid_code" });
				issued++;
				fake.access = `xoxp-${issued + 1}`;
				fake.refreshToken = `xoxe-${issued + 1}`;
				if (refreshing)
					return json({
						ok: true,
						app_id: "A0BANDA",
						access_token: fake.access,
						refresh_token: fake.refreshToken,
						token_type: "user",
						expires_in: 43200,
						scope: fake.granted,
						user_id: SLACK_ME.id,
						team: { id: SLACK_TEAM.id, name: SLACK_TEAM.name },
					});
				return json({
					ok: true,
					app_id: "A0BANDA",
					authed_user: {
						id: SLACK_ME.id,
						scope: fake.granted,
						access_token: fake.access,
						token_type: "user",
						refresh_token: fake.refreshToken,
						expires_in: 43200,
					},
					team: { id: SLACK_TEAM.id, name: SLACK_TEAM.name },
					enterprise: null,
					is_enterprise_install: false,
				});
			}
			const headers = new Headers(init?.headers);
			const token = headers.get("authorization")?.replace(/^Bearer /, "");
			const params: Record<string, unknown> =
				init?.method === "POST"
					? (JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>)
					: Object.fromEntries(url.searchParams.entries());
			fake.calls.push({ method, params, ...(token === undefined ? {} : { token }) });
			if (fake.busy !== undefined)
				return json({ ok: false, error: "ratelimited" }, 429, { "retry-after": String(fake.busy) });
			if (token !== fake.access) return json({ ok: false, error: "invalid_auth" });
			switch (method) {
				case "auth.test":
					return json({
						ok: true,
						url: `https://${SLACK_TEAM.domain}.slack.com/`,
						team: SLACK_TEAM.name,
						user: SLACK_ME.name,
						team_id: SLACK_TEAM.id,
						user_id: SLACK_ME.id,
					});
				case "users.info": {
					const user = users[String(params.user)];
					return user === undefined ? json({ ok: false, error: "user_not_found" }) : json({ ok: true, user });
				}
				case "conversations.info": {
					const found = channels[String(params.channel)];
					return found === undefined
						? json({ ok: false, error: "channel_not_found" })
						: json({ ok: true, channel: found });
				}
				case "users.conversations": {
					const types = String(params.types ?? "public_channel").split(",");
					const listed = Object.values(channels).filter((each) =>
						each.is_im === true
							? types.includes("im")
							: each.is_private === true
								? types.includes("private_channel")
								: types.includes("public_channel"),
					);
					return json({ ok: true, channels: listed, response_metadata: { next_cursor: "" } });
				}
				case "conversations.history": {
					const messages = history[String(params.channel)];
					if (messages === undefined) return json({ ok: false, error: "channel_not_found" });
					const limit = Number(params.limit ?? 100);
					return json({
						ok: true,
						messages: messages.slice(0, limit),
						has_more: messages.length > limit,
						response_metadata: { next_cursor: "" },
					});
				}
				case "conversations.replies": {
					const channel = String(params.channel);
					const root = (history[channel] ?? []).find((each) => each.ts === params.ts);
					if (root === undefined) return json({ ok: false, error: "thread_not_found" });
					const under = replies[`${channel}/${String(params.ts)}`] ?? [];
					return json({ ok: true, messages: [root, ...under], has_more: false });
				}
				case "search.messages": {
					const query = String(params.query ?? "").toLowerCase();
					const matches = Object.entries(history)
						.flatMap(([channel, messages]) => messages.map((message) => ({ channel, message })))
						.filter(({ message }) =>
							String(message.text ?? "")
								.toLowerCase()
								.includes(query),
						)
						.map(({ channel, message }) => ({
							...message,
							channel: { id: channel, name: String(channels[channel]?.name ?? channel) },
							permalink: `https://${SLACK_TEAM.domain}.slack.com/archives/${channel}/p${String(message.ts).replace(".", "")}`,
							team: SLACK_TEAM.id,
						}));
					return json({
						ok: true,
						query: params.query,
						messages: { total: matches.length, matches: matches.slice(0, Number(params.count ?? 20)) },
					});
				}
				case "chat.postMessage": {
					const channel = String(params.channel);
					if (channels[channel] === undefined) return json({ ok: false, error: "channel_not_found" });
					const ts = `${clock++}.000000`;
					const post: FakeSlackPost = {
						channel,
						text: String(params.text),
						...(typeof params.thread_ts === "string" ? { thread_ts: params.thread_ts } : {}),
						ts,
					};
					save([...load(), post]);
					return json({
						ok: true,
						channel,
						ts,
						message: { user: SLACK_ME.id, text: post.text, bot_id: "B0BANDA", app_id: "A0BANDA" },
					});
				}
				default:
					return json({ ok: false, error: "unknown_method" });
			}
		},
	};
	return fake;
}
