/**
 * The recorded run behind docs/slack.md (AGENTS.md principle 6): Slack's PKCE sign-in on a loopback port with user
 * scopes alone, then the limits and shapes the connection design rests on. Two commands:
 *
 *   node scripts/spike-slack.ts auth [--port 7788]        sign in; tokens go to BANDA_SLACK_SPIKE (a file, mode 600)
 *   node scripts/spike-slack.ts probe --channel C0123     the probes, against the channel named (it gets one test
 *                                                         message and its replies)
 *   node scripts/spike-slack.ts cleanup --channel C0123 --ts <root ts>   deletes that test message and its replies
 *
 * Every observation is printed as one JSON line with tokens and codes redacted, and appended to the same file's
 * `.log`. Nothing here touches a banda home.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, chmod, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const CLIENT_ID = process.env.BANDA_SLACK_CLIENT_ID ?? "3393283510.12540783162114";
const USER_SCOPES = [
	"channels:read",
	"groups:read",
	"channels:history",
	"groups:history",
	"users:read",
	"im:read",
	"mpim:read",
	"im:history",
	"mpim:history",
	"search:read",
	"chat:write",
	"reactions:write",
];
const TOKENS = process.env.BANDA_SLACK_SPIKE ?? join(tmpdir(), "banda-slack-spike.json");

const args = process.argv.slice(2);
const command = args[0];
const option = (name: string) => {
	const at = args.indexOf(`--${name}`);
	return at === -1 ? undefined : args[at + 1];
};
const base64url = (bytes: Buffer) => bytes.toString("base64url");

/** Tokens, codes and anything that looks like one never reach the output. */
function redact(value: Json): Json {
	if (typeof value === "string") {
		if (/^xox[a-z]-|^xoxe\.|^xoxe-/.test(value)) return `<token ${value.slice(0, 5)}… ${value.length} chars>`;
		return value.length > 300 ? `${value.slice(0, 300)}… (${value.length} chars)` : value;
	}
	if (Array.isArray(value)) return value.map(redact);
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([k, v]) => [
				k,
				/token|code|secret/i.test(k) && typeof v === "string" ? `<${k} ${v.length} chars>` : redact(v),
			]),
		);
	return value;
}

async function record(probe: string, observation: { [key: string]: Json }) {
	const line = JSON.stringify({ at: new Date().toISOString(), probe, ...(redact(observation) as object) });
	console.log(line);
	await appendFile(`${TOKENS}.log`, `${line}\n`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One Web API call; the status, the few headers that matter and the body, as they came. */
async function slack(method: string, token: string, params: Record<string, string | number> = {}, post = false) {
	const url = new URL(`https://slack.com/api/${method}`);
	const init: RequestInit = { headers: { authorization: `Bearer ${token}` } };
	if (post) {
		init.method = "POST";
		(init.headers as Record<string, string>)["content-type"] = "application/json; charset=utf-8";
		init.body = JSON.stringify(params);
	} else for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
	const started = Date.now();
	const response = await fetch(url, init);
	const headers = Object.fromEntries(
		[...response.headers.entries()].filter(([k]) => /retry-after|ratelimit|x-slack|content-type/i.test(k)),
	);
	let body: Json;
	try {
		body = (await response.json()) as Json;
	} catch {
		body = await response.text();
	}
	return { status: response.status, ms: Date.now() - started, headers, body };
}

const shape = (body: Json): Json =>
	body !== null && typeof body === "object" && !Array.isArray(body)
		? Object.fromEntries(
				Object.entries(body).map(([k, v]) => [
					k,
					Array.isArray(v) ? `array(${v.length})` : v !== null && typeof v === "object" ? shape(v) : v,
				]),
			)
		: body;

async function auth() {
	const port = Number(option("port") ?? 7788);
	const redirect = `http://127.0.0.1:${port}/oauth/callback`;
	const verifier = base64url(randomBytes(48));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	const state = base64url(randomBytes(24));
	const url = new URL("https://slack.com/oauth/v2/authorize");
	url.searchParams.set("client_id", CLIENT_ID);
	url.searchParams.set("user_scope", USER_SCOPES.join(","));
	url.searchParams.set("redirect_uri", redirect);
	url.searchParams.set("state", state);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");

	const grant = new Promise<{ code?: string; error?: string; query: Record<string, string> }>((resolve) => {
		const server = createServer((request, response) => {
			const came = new URL(request.url ?? "/", redirect);
			if (came.pathname !== "/oauth/callback") {
				response.writeHead(404).end();
				return;
			}
			const query = Object.fromEntries(came.searchParams.entries());
			response.writeHead(200, { "content-type": "text/plain" }).end("banda spike: you can close this tab");
			server.close();
			resolve({ code: query.code, error: query.error, query });
		});
		server.listen(port, "127.0.0.1");
	});

	await record("auth.url", {
		port,
		redirect,
		scopes: USER_SCOPES,
		url: url.toString().replace(/code_challenge=[^&]+/, "code_challenge=<…>"),
	});
	console.error(`\nOpen this in your browser and click Allow:\n${url}\n`);
	if (process.platform === "darwin") spawn("open", [url.toString()], { stdio: "ignore", detached: true }).unref();

	const came = await grant;
	if (came.query.state !== state) await record("auth.callback", { note: "state mismatch", query: came.query });
	if (came.code === undefined) {
		await record("auth.callback", { ok: false, query: came.query });
		return;
	}
	await record("auth.callback", { ok: true, keys: Object.keys(came.query) });

	const exchange = await fetch("https://slack.com/api/oauth.v2.access", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			code: came.code,
			redirect_uri: redirect,
			code_verifier: verifier,
		}),
	});
	const body = (await exchange.json()) as { [key: string]: Json };
	await record("auth.exchange", { status: exchange.status, shape: shape(body), body });
	const user = body.authed_user as { [key: string]: Json } | undefined;
	if (body.ok === true && user !== undefined && typeof user.access_token === "string") {
		await writeFile(
			TOKENS,
			JSON.stringify({
				at: Date.now(),
				port,
				access: user.access_token,
				refresh: user.refresh_token ?? null,
				expires_in: user.expires_in ?? null,
				user: user.id,
				team: (body.team as { [key: string]: Json } | undefined)?.id ?? null,
				scope: user.scope ?? null,
			}),
		);
		await chmod(TOKENS, 0o600);
		console.error(`tokens saved to ${TOKENS} (mode 600); delete it when the spike is over`);
	}
}

async function probe() {
	const channel = option("channel");
	const saved = JSON.parse(await readFile(TOKENS, "utf8")) as {
		access: string;
		refresh: string | null;
		expires_in: number | null;
		user: string;
		team: string;
	};
	const token = saved.access;
	if (channel === undefined) {
		const list = await slack("conversations.list", token, {
			types: "public_channel,private_channel",
			exclude_archived: "true",
			limit: 200,
		});
		const channels = (
			(
				list.body as {
					channels?: { id: string; name: string; is_member?: boolean; is_private?: boolean; num_members?: number }[];
				}
			).channels ?? []
		)
			.filter((c) => c.is_member)
			.map((c) => ({ id: c.id, name: c.name, private: c.is_private ?? false, members: c.num_members ?? null }));
		await record("conversations.list.member", {
			status: list.status,
			headers: list.headers,
			count: channels.length,
			channels,
		});
		return;
	}

	const identity = await slack("auth.test", token);
	await record("auth.test", { status: identity.status, body: identity.body });
	const team = await slack("team.info", token);
	await record("team.info", {
		status: team.status,
		shape: shape(team.body),
		name: (team.body as { team?: { name?: string; domain?: string } }).team?.name ?? null,
	});
	const me = await slack("users.info", token, { user: saved.user });
	await record("users.info.self", { status: me.status, shape: shape(me.body) });

	const info = await slack("conversations.info", token, { channel });
	await record("conversations.info", {
		status: info.status,
		shape: shape(info.body),
		shared: (() => {
			const c = (info.body as { channel?: Record<string, Json> }).channel ?? {};
			return {
				is_shared: c.is_shared ?? null,
				is_ext_shared: c.is_ext_shared ?? null,
				is_org_shared: c.is_org_shared ?? null,
				context_team_id: c.context_team_id ?? null,
				shared_team_ids: c.shared_team_ids ?? null,
			};
		})(),
	});

	const summary = (h: Awaited<ReturnType<typeof slack>>) => {
		const b = h.body as {
			ok?: boolean;
			error?: string;
			messages?: { ts: string }[];
			has_more?: boolean;
			response_metadata?: { next_cursor?: string };
		};
		const ts = (b.messages ?? []).map((m) => m.ts);
		return {
			status: h.status,
			ms: h.ms,
			headers: h.headers,
			ok: b.ok ?? null,
			error: b.error ?? null,
			count: ts.length,
			has_more: b.has_more ?? null,
			next_cursor: b.response_metadata?.next_cursor ? "present" : "absent",
			order: ts.length > 1 ? (Number(ts[0]) > Number(ts[ts.length - 1]) ? "newest first" : "oldest first") : "n/a",
			first_ts: ts[0] ?? null,
			last_ts: ts[ts.length - 1] ?? null,
		};
	};

	const h1 = await slack("conversations.history", token, { channel, limit: 100 });
	await record("history.limit100.first", summary(h1));
	const h2 = await slack("conversations.history", token, { channel, limit: 100 });
	await record("history.limit100.second.at.once", summary(h2));
	const h1ts = ((h1.body as { messages?: { ts: string }[] }).messages ?? []).map((m) => m.ts);
	if (h1ts.length > 5) {
		const h3 = await slack("conversations.history", token, { channel, limit: 100, oldest: h1ts[4] });
		await record("history.oldest.fifth", { oldest: h1ts[4], ...summary(h3) });
	}

	const stamp = `banda-spike-${base64url(randomBytes(6))}`;
	const posted = await slack(
		"chat.postMessage",
		token,
		{ channel, text: `${stamp} (a test message from banda's Slack spike; it will get a few replies)` },
		true,
	);
	await record("chat.postMessage", {
		status: posted.status,
		shape: shape(posted.body),
		error: (posted.body as { error?: string }).error ?? null,
	});
	const root = (posted.body as { ts?: string }).ts;
	const postedAt = Date.now();

	if (root !== undefined) {
		const replies = Number(option("replies") ?? 20);
		for (let i = 1; i <= replies; i++) {
			const r = await slack("chat.postMessage", token, { channel, thread_ts: root, text: `${stamp} reply ${i}` }, true);
			if ((r.body as { ok?: boolean }).ok !== true) {
				await record("thread.reply.failed", {
					i,
					status: r.status,
					error: (r.body as { error?: string }).error ?? null,
					headers: r.headers,
				});
				break;
			}
		}
		const r1 = await slack("conversations.replies", token, { channel, ts: root, limit: 15 });
		await record("replies.limit15.first", summary(r1));
		const cursor = (r1.body as { response_metadata?: { next_cursor?: string } }).response_metadata?.next_cursor;
		if (cursor) {
			const r2 = await slack("conversations.replies", token, { channel, ts: root, limit: 15, cursor });
			await record("replies.limit15.second.by.cursor", summary(r2));
		}
		const r3 = await slack("conversations.replies", token, { channel, ts: root, limit: 15, oldest: root });
		await record("replies.oldest.root", summary(r3));
	}

	for (const after of [10_000, 60_000, 300_000]) {
		const wait = postedAt + after - Date.now();
		if (wait > 0) await sleep(wait);
		const s = await slack("search.messages", token, { query: stamp, sort: "timestamp", sort_dir: "desc", count: 50 });
		const m = (
			s.body as {
				messages?: { total?: number; matches?: { ts: string; permalink: string; channel?: { name?: string } }[] };
			}
		).messages;
		await record(`search.after.${after / 1000}s`, {
			status: s.status,
			headers: s.headers,
			ok: (s.body as { ok?: boolean }).ok ?? null,
			error: (s.body as { error?: string }).error ?? null,
			total: m?.total ?? null,
			matches: m?.matches?.length ?? null,
			first_match_keys: m?.matches?.[0] ? Object.keys(m.matches[0]) : null,
		});
		if ((m?.total ?? 0) > 0) break;
	}

	const sinceH2 = Date.now() - postedAt;
	if (sinceH2 < 61_000) await sleep(61_000 - sinceH2);
	const h4 = await slack("conversations.history", token, { channel, limit: 100 });
	await record("history.limit100.after.a.minute", summary(h4));

	if (saved.refresh) {
		const refreshed = await fetch("https://slack.com/api/oauth.v2.access", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: saved.refresh }),
		});
		const body = (await refreshed.json()) as Json;
		await record("refresh.without.secret", { status: refreshed.status, shape: shape(body), body });
	} else
		await record("refresh", {
			note: "no refresh token was issued; token rotation is off for this grant",
			expires_in: saved.expires_in,
		});
}

/** Delete the probe's test message and its replies, the replies first so no tombstone keeps them. */
async function cleanup() {
	const channel = option("channel");
	const root = option("ts");
	if (channel === undefined || root === undefined) throw new Error("--channel C0123 --ts <root ts> are required");
	const saved = JSON.parse(await readFile(TOKENS, "utf8")) as { access: string };
	const token = saved.access;
	const thread = await slack("conversations.replies", token, { channel, ts: root, limit: 200 });
	const messages = ((thread.body as { messages?: { ts: string }[] }).messages ?? []).map((m) => m.ts);
	const replies = messages.filter((ts) => ts !== root);
	let deleted = 0;
	for (const ts of [...replies, root]) {
		const r = await slack("chat.delete", token, { channel, ts }, true);
		if ((r.body as { ok?: boolean }).ok === true) deleted++;
		else
			await record("chat.delete.failed", {
				ts,
				status: r.status,
				error: (r.body as { error?: string }).error ?? null,
				headers: r.headers,
			});
	}
	await record("cleanup", { channel, root, replies: replies.length, deleted });
}

if (command === "auth") await auth();
else if (command === "probe") await probe();
else if (command === "cleanup") await cleanup();
else {
	console.error(
		"usage: spike-slack.ts auth [--port 7788] | probe --channel C0123 [--replies 20] | cleanup --channel C0123 --ts <root ts>",
	);
	process.exit(2);
}
