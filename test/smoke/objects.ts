/**
 * Real-daemon, fake-GitHub manual acceptance harness. Build web first, then:
 *   node test/smoke/objects.ts
 * Only a unique temp home, OS-assigned loopback ports, hostBox and pi-ai's faux provider are used.
 * Commands in the actual composer: show objects, object-only, notification, comment, failure, partial,
 * restore, change title. Owner links work too. Approvals mutate only the in-process fake.
 * SIGINT/SIGTERM closes both services. The printed home is retained for screenshots/inspection.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createModels,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { startDaemon } from "../../src/daemon.ts";
import { readDaemonFile, webLink } from "../../src/home.ts";
import { WEB } from "../../src/server/http.ts";
import { githubObjectFile, startGithubObjects } from "../fixtures/github-objects.ts";
import { hostBox } from "../fixtures/host-box.ts";

const FAKE_KEY = "fake-key-0123456789";
const GITHUB_REFS = {
	pr: "https://github.com/acme/banda/pull/34",
	issue: "https://github.com/acme/banda/issues/12",
	job: "https://github.com/acme/banda/actions/runs/20/job/201",
	notification: "notification/1",
};

// Wrap the canonical fixture, retaining its upstream schema validation and normal responses.
async function smokeGithub() {
	const fake = await startGithubObjects({ auth: "key" });
	const original = fake.onCall;
	if (original === undefined) throw new Error("GitHub fixture has no handler");
	const state = { title: "Keep objects as data", partial: false };
	const writes: { tool: string; args: Record<string, unknown> }[] = [];
	const failures: { tool: string; method?: string; message: string }[] = [];
	const failNext = (tool: string, method?: string, message = "Fake GitHub temporarily unavailable") => {
		failures.push({ tool, ...(method === undefined ? {} : { method }), message });
	};
	fake.onCall = async (tool, args, authorization) => {
		const answer = await original(tool, args, authorization);
		if (answer.isError) return answer;
		const failed = failures.findIndex(
			(failure) => failure.tool === tool && (failure.method === undefined || failure.method === args.method),
		);
		if (failed !== -1) return { text: failures.splice(failed, 1)[0]?.message ?? "Unavailable", isError: true };
		if (fake.tools.find((known) => known.name === tool)?.readOnlyHint !== true)
			writes.push({ tool, args: structuredClone(args) });
		if (tool === "pull_request_read") {
			const payload = JSON.parse(answer.text) as Record<string, unknown>;
			if (args.method === "get") {
				payload.title = state.title;
				if (state.partial) delete payload.additions;
			}
			if (args.method === "get_check_runs" && state.partial) payload.total_count = 9;
			return { text: JSON.stringify(payload) };
		}
		return answer;
	};
	return Object.assign(fake, { key: FAKE_KEY, state, writes, failNext });
}

function scripted(fake: Awaited<ReturnType<typeof smokeGithub>>) {
	const faux = fauxProvider({ tokensPerSecond: 400 });
	const models = createModels();
	models.setProvider(faux.provider);
	const respond: FauxResponseFactory = (context) => {
		const last = context.messages.filter((message) => message.role !== "system").at(-1);
		const offered = context.messages.flatMap((message) =>
			message.role === "system"
				? ((message as { toolsAdded?: readonly { name: string }[] }).toolsAdded ?? []).map((tool) => tool.name)
				: [],
		);
		const speak = offered.includes("message_group") ? "message_group" : "message_user";
		const call = (name: string, args: object) =>
			fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });
		const say = (args: object) => call(speak, args);
		if (last?.role === "toolResult") {
			if (last.toolName === "github__add_issue_comment") {
				const result = JSON.stringify(last.content);
				return say({
					text: /declined|denied|did not run|not allowed|not approved/i.test(result)
						? "Declined. I did not send the comment."
						: last.isError
							? "The comment was not sent."
							: "Sent the comment as @owner.",
				});
			}
			return fauxAssistantMessage("Done.");
		}
		if (last?.role !== "user") return fauxAssistantMessage("Done.");
		const text = (typeof last.content === "string" ? last.content : JSON.stringify(last.content)).toLowerCase();
		if (/\bcomment\b/.test(text))
			return call("github__add_issue_comment", {
				owner: "acme",
				repo: "banda",
				issue_number: 34,
				body: "Thanks for the careful review. Ready when you are.",
			});
		if (text.includes("object-only")) return say({ objects: [GITHUB_REFS.pr] });
		if (text.includes("notification")) return say({ objects: [GITHUB_REFS.notification] });
		if (text.includes("failure")) {
			fake.failNext("pull_request_read", "get");
			return say({ text: "The next PR read will fail once. Refresh its card, then retry.", objects: [GITHUB_REFS.pr] });
		}
		if (text.includes("partial")) {
			fake.state.partial = true;
			fake.failNext("pull_request_read", "get_reviews");
			return say({
				text: "Refresh the card to see incomplete checks and unavailable reviews.",
				objects: [GITHUB_REFS.pr],
			});
		}
		if (text.includes("restore")) {
			Object.assign(fake.state, { title: "Keep objects as data", partial: false });
			return say({
				text: "Fake GitHub has its original values again. Refresh to read them.",
				objects: [GITHUB_REFS.pr],
			});
		}
		if (text.includes("change title")) {
			fake.state.title = "Updated title from fake GitHub";
			return say({ text: "The title changed at the service. Refresh the card to see it.", objects: [GITHUB_REFS.pr] });
		}
		return say({
			text: `Here are the changes to review: ${GITHUB_REFS.pr}\n\nThe same PR again: ${GITHUB_REFS.pr}`,
			objects: [GITHUB_REFS.pr, GITHUB_REFS.issue, GITHUB_REFS.job],
		});
	};
	faux.setResponses(Array.from({ length: 10_000 }, () => respond));
	return models;
}

if (!existsSync(join(WEB, "index.html"))) throw new Error("Build the app first: npm run build:web");
const home = await mkdtemp(join(tmpdir(), "banda-objects-smoke-"));
const fake = await smokeGithub();
let controls: Server | undefined;
let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
let stopping = false;
async function stop() {
	if (stopping) return;
	stopping = true;
	try {
		await daemon?.close();
	} finally {
		await fake.close();
		if (controls !== undefined) {
			await new Promise<void>((resolve) => {
				controls?.close(() => resolve());
				controls?.closeAllConnections();
			});
		}
	}
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
try {
	await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
	await mkdir(join(home, "workspace", "connections"), { recursive: true });
	await writeFile(join(home, "workspace", "connections", "github.md"), githubObjectFile(fake.url, "key"));
	daemon = await startDaemon({
		home,
		port: 0,
		models: scripted(fake),
		box: hostBox(home),
		log: (line) => console.error(line),
	});
	const { token } = (await readDaemonFile(home)) ?? {};
	if (token === undefined) throw new Error("daemon did not write its token");
	const origin = `http://127.0.0.1:${daemon.port}`;
	const api = async (path: string, data?: unknown) => {
		const response = await fetch(`${origin}/api${path}`, {
			method: data === undefined ? "GET" : "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			...(data === undefined ? {} : { body: JSON.stringify(data) }),
		});
		if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
		return response.json();
	};
	// The file is proposed from the host workspace, then explicitly reviewed through the owner API.
	let sha: string | undefined;
	for (let attempt = 0; attempt < 200 && sha === undefined; attempt++) {
		const view = (await api("/capabilities")) as { connections: { name: string; change?: { sha: string } }[] };
		sha = view.connections.find((connection) => connection.name === "github")?.change?.sha;
		if (sha === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
	}
	if (sha === undefined) throw new Error("GitHub file never appeared for owner acceptance");
	await api("/capabilities/connections/github/accept", { sha });
	await api("/capabilities/connections/github/key", { key: fake.key, agent: "sancho" });
	controls = createServer((req, res) => {
		void (async () => {
			const answer = (status: number, value: unknown) =>
				res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
			if (req.headers.authorization !== `Bearer ${FAKE_KEY}`) return answer(401, { error: "fake bearer required" });
			if (req.url !== "/control") return answer(404, { error: "not found" });
			if (req.method === "GET") return answer(200, { state: fake.state, calls: fake.calls, writes: fake.writes });
			if (req.method !== "POST") return answer(405, { error: "GET or POST" });
			let text = "";
			for await (const chunk of req) {
				text += chunk;
				if (text.length > 16_384) return answer(413, { error: "too large" });
			}
			const data = JSON.parse(text) as {
				title?: string;
				partial?: boolean;
				failNext?: { tool: string; method?: string; message?: string };
			};
			if (typeof data.title === "string") fake.state.title = data.title;
			if (typeof data.partial === "boolean") fake.state.partial = data.partial;
			if (data.failNext !== undefined) fake.failNext(data.failNext.tool, data.failNext.method, data.failNext.message);
			return answer(200, { ok: true });
		})().catch((error: unknown) => {
			if (!res.headersSent) res.writeHead(400).end(String(error));
		});
	});
	await new Promise<void>((resolve) => controls?.listen(0, "127.0.0.1", resolve));
	const control = `http://127.0.0.1:${(controls.address() as AddressInfo).port}/control`;
	console.log(`home:    ${home}`);
	console.log(`app:     ${webLink(daemon.port, token)}`);
	console.log(`control: ${control}`);
	console.log(`fake key: ${fake.key}`);
	console.log(
		"composer: show objects | object-only | notification | comment | failure | partial | restore | change title",
	);
	console.log(`control: curl -H 'Authorization: Bearer ${fake.key}' ${control}`);
	console.log(
		`fail: curl -H 'Authorization: Bearer ${fake.key}' -H 'Content-Type: application/json' -d '{"failNext":{"tool":"pull_request_read","method":"get"}}' ${control}`,
	);
	console.log("Ready. All writes are fake. Stop with SIGTERM or Ctrl-C.");
} catch (error) {
	await stop();
	throw error;
}
