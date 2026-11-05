import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readDaemonFile } from "../src/home.ts";
import { journey } from "./journeys.ts";

export type Target = { url: string; token: string; home?: string };
export type Verdict = "pass" | "fail" | "blocked";
export type Run = {
	version: 1;
	id: string;
	journey: string;
	definitionSha: string;
	created: string;
	target: { url: string; home?: string };
	thread: string;
	steps: {
		id: string;
		messageId: string;
		prompt?: string;
		submitted?: string;
		chat?: number;
		evidence: Partial<Record<"desktop" | "phone", { verdict: Verdict; note: string; at: string }>>;
	}[];
};
export function loopbackOrigin(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Target must be a loopback HTTP origin.");
	}
	if (
		url.protocol !== "http:" ||
		!["127.0.0.1", "localhost"].includes(url.hostname) ||
		!url.port ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	)
		throw new Error(
			"Target must be a loopback HTTP origin with an explicit port, without credentials, path, query or fragment.",
		);
	return `http://127.0.0.1:${url.port}`;
}
export async function target(
	options: { home?: string; url?: string },
	token = process.env.BANDA_EVAL_TOKEN,
): Promise<Target> {
	if (!!options.home === !!options.url) throw new Error("Choose exactly one explicit --home or --url test target.");
	const liveHome = await realpath(join(homedir(), ".banda")).catch(() => resolve(homedir(), ".banda"));
	let selected: Target;
	if (options.home) {
		const home = await realpath(options.home);
		if (home === liveHome) throw new Error("Journey evals never target ~/.banda.");
		const daemon = await readDaemonFile(home);
		if (!daemon?.port || !daemon.token) throw new Error("No running test daemon at this home.");
		selected = { home, url: loopbackOrigin(`http://127.0.0.1:${daemon.port}`), token: daemon.token };
	} else {
		const url = loopbackOrigin(options.url ?? "");
		if (!token) throw new Error("Set BANDA_EVAL_TOKEN for an explicit URL target.");
		selected = { url, token };
	}
	const live = await readDaemonFile(liveHome);
	if (live?.port && new URL(selected.url).port === String(live.port))
		throw new Error("Journey evals never target the live ~/.banda daemon.");
	return selected;
}
export function newRun(id: string, destination: Target): Run {
	const selected = journey(id);
	return {
		version: 1,
		id: randomUUID(),
		journey: id,
		definitionSha: createHash("sha256").update(JSON.stringify(selected)).digest("hex"),
		created: new Date().toISOString(),
		target: { url: destination.url, ...(destination.home ? { home: destination.home } : {}) },
		thread: randomUUID(),
		steps: selected.steps.map((step) => ({
			id: step.id,
			messageId: randomUUID(),
			...(step.prompt ? { prompt: step.prompt } : {}),
			evidence: {},
		})),
	};
}
export async function createRun(path: string, run: Run) {
	await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
	await writeFile(path, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}
export async function saveRun(path: string, run: Run) {
	await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	await rename(temporary, path);
}
export async function loadRun(path: string): Promise<Run> {
	const run = JSON.parse(await readFile(path, "utf8")) as Run;
	if (run.version !== 1 || typeof run.id !== "string" || !Array.isArray(run.steps) || typeof run.thread !== "string")
		throw new Error("Invalid journey run file.");
	const definition = journey(run.journey);
	if (run.definitionSha !== createHash("sha256").update(JSON.stringify(definition)).digest("hex"))
		throw new Error("Journey definition changed; start a new run against the current checkpoints.");
	if (
		run.steps.length !== definition.steps.length ||
		run.steps.some(
			(step, index) =>
				step.id !== definition.steps[index].id ||
				step.prompt !== definition.steps[index].prompt ||
				!step.evidence ||
				!/^[0-9a-f-]{36}$/.test(step.messageId),
		)
	)
		throw new Error("Invalid journey steps.");
	for (const step of run.steps)
		for (const [width, evidence] of Object.entries(step.evidence)) {
			if (
				!["desktop", "phone"].includes(width) ||
				!evidence ||
				!["pass", "fail", "blocked"].includes(evidence.verdict) ||
				!evidence.note?.trim()
			)
				throw new Error("Invalid journey evidence.");
		}
	loopbackOrigin(run.target.url);
	return run;
}
export async function submit(
	run: Run,
	stepId: string,
	destination: Target,
	request: typeof fetch = fetch,
): Promise<void> {
	if (destination.url !== run.target.url)
		throw new Error("Target changed since this run was created; start a new run.");
	const step = run.steps.find((item) => item.id === stepId);
	if (!step?.prompt) throw new Error("This step has no prompt: perform its action through the app.");
	if (step.submitted) throw new Error("This step was already submitted. Continue in the app or start a new run.");
	// A retry after an uncertain network response uses the same stored message ID and thread.
	let response: Response;
	try {
		response = await request(`${destination.url}/api/messages`, {
			method: "POST",
			redirect: "error",
			signal: AbortSignal.timeout(15_000),
			headers: { authorization: `Bearer ${destination.token}`, "content-type": "application/json" },
			body: JSON.stringify({ id: step.messageId, thread: run.thread, text: step.prompt }),
		});
	} catch {
		throw new Error(
			"Submission response unavailable. Inspect the app before retrying; the stored message ID is reused.",
		);
	}
	if (!response.ok)
		throw new Error(
			`Submission refused (HTTP ${response.status}). Inspect the app; response content is not copied into reports.`,
		);
	let body: { chat?: number; turn?: number; answered?: number; refused?: unknown };
	try {
		body = (await response.json()) as typeof body;
	} catch {
		throw new Error("Invalid submission acknowledgement. Inspect the app before retrying with the stored message ID.");
	}
	if (!body || body.refused !== undefined)
		throw new Error(
			"The daemon refused this message. Inspect the app for the reason; no successful submission was recorded.",
		);
	if (!Number.isSafeInteger(body.chat) || (body.chat ?? 0) < 1 || !Number.isSafeInteger(body.turn ?? body.answered))
		throw new Error("Invalid submission acknowledgement. Inspect the app before retrying with the stored message ID.");
	step.chat = body.chat;
	step.submitted = new Date().toISOString();
}
export function record(run: Run, stepId: string, width: string, verdict: string, note: string): void {
	if (width !== "desktop" && width !== "phone") throw new Error("Width must be desktop or phone.");
	if (!["pass", "fail", "blocked"].includes(verdict)) throw new Error("Verdict must be pass, fail or blocked.");
	if (!note.trim()) throw new Error("Evidence must describe the observation, not just a verdict.");
	if (/Bearer\s+\S+|#token=|(?:api[_-]?key|access[_-]?token)\s*[:=]/i.test(note))
		throw new Error("Remove credentials from evidence before recording it.");
	const step = run.steps.find((item) => item.id === stepId);
	if (!step) throw new Error("Unknown step.");
	step.evidence[width] = { verdict: verdict as Verdict, note, at: new Date().toISOString() };
}
export function summary(run: Run) {
	const counts = { pass: 0, fail: 0, blocked: 0, pending: 0 };
	for (const step of run.steps)
		for (const width of ["desktop", "phone"] as const) counts[step.evidence[width]?.verdict ?? "pending"]++;
	return {
		...counts,
		total: run.steps.length * 2,
		outcome: counts.fail ? "fail" : counts.blocked ? "blocked" : counts.pending ? "incomplete" : "pass",
	};
}
