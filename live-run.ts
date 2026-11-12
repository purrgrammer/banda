/**
 * Live verification of PR #102 (conditional watch reads) against a real banda daemon from the worktree: a throwaway
 * home, an OS-assigned port, host box, the faux model, and a fake GitHub MCP server on loopback (OAuth that consents
 * at once). No real GitHub, no external writes. Real clock: the watch looks on its own cadence (5m quiet, 2m busy).
 *
 * Usage: node /tmp/ghsem/live/run.ts <worktree> <outdir>
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [WT, OUT] = process.argv.slice(2) as [string, string];
mkdirSync(OUT, { recursive: true });
const imp = (p: string) => import(pathToFileURL(join(WT, p)).href);
const { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } = await imp(
	"node_modules/@earendil-works/pi-ai/dist/index.js",
);
const { startDaemon } = await imp("src/daemon.ts");
const { readDaemonFile } = await imp("src/home.ts");
const { githubObjectDefinition, startGithubObjects } = await imp("test/fixtures/github-objects.ts");
const { hostBox } = await imp("test/fixtures/host-box.ts");
const { withPage } = await imp("test/smoke/chrome.ts");

const LOG = join(OUT, "evidence.jsonl");
writeFileSync(LOG, "");
const t0 = Date.now();
const log = (what: string, data: object = {}) => {
	const line = { t: Math.round((Date.now() - t0) / 1000), what, ...data };
	appendFileSync(LOG, `${JSON.stringify(line)}\n`);
	console.log(JSON.stringify(line));
};

// ---- the fake GitHub's world, which the run moves on
const LINK = "https://github.com/acme/banda/pull/142";
const world = {
	pr: {
		number: 142,
		title: "Keep objects as data",
		state: "open",
		draft: false,
		merged: false,
		user: { login: "ana" },
		head: { ref: "objects", sha: "a1" },
		labels: [] as string[],
		comments: 0,
		updated_at: "2026-11-12T09:00:00Z",
		html_url: LINK,
	} as Record<string, unknown>,
	checks: [
		{ id: 10, name: "unit", status: "completed", conclusion: "success" },
		{ id: 11, name: "lint", status: "completed", conclusion: "success" },
	] as Record<string, unknown>[],
	reviews: [{ id: 1, user: { login: "ana" }, state: "APPROVED" }] as Record<string, unknown>[],
	comments: [] as Record<string, unknown>[],
	failReviews: false,
};
const reads: { at: number; method: string; failed?: boolean }[] = [];
const github = await startGithubObjects({ auth: "oauth" });
github.user = "bandarra";
github.onCall = async (tool: string, args: Record<string, unknown>) => {
	if (tool !== "pull_request_read") return { text: "not in this world", isError: true };
	const method = String(args.method);
	const at = Date.now();
	if (method === "get_reviews" && world.failReviews) {
		reads.push({ at, method, failed: true });
		return { text: "GitHub is having a moment", isError: true };
	}
	reads.push({ at, method });
	const answer =
		method === "get"
			? world.pr
			: method === "get_check_runs"
				? { total_count: world.checks.length, check_runs: world.checks }
				: method === "get_reviews"
					? world.reviews
					: method === "get_comments"
						? world.comments
						: undefined;
	return answer === undefined ? { text: `no ${method}`, isError: true } : { text: JSON.stringify(answer) };
};

// ---- the daemon, on a throwaway home
const home = await mkdtemp(join(tmpdir(), "banda-live33-"));
const shipped = join(home, "shipped");
await mkdir(shipped, { recursive: true });
// the definition banda ships, its pull request looked at every 2 minutes instead of 5 so the run fits a session; the
// reads, their `unless`, the rules and the busy cadence (2 minutes) are as shipped
const definition = JSON.parse(githubObjectDefinition(github.url));
definition.objects.pull_request.follow.every = "2m";
await writeFile(join(shipped, "github.json"), `${JSON.stringify(definition, null, "\t")}\n`);
log("definition", { pull_request_every: definition.objects.pull_request.follow.every, checks_unless: definition.objects.pull_request.reads.checks.unless, reviews_unless: definition.objects.pull_request.reads.reviews.unless });
await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);
const REPLY = "Seen it; I will look.";
faux.setResponses(
	Array.from({ length: 20 }, () => [
		() => fauxAssistantMessage([fauxToolCall("message_user", { text: REPLY })], { stopReason: "toolUse" }),
		() => fauxAssistantMessage(""),
	]).flat(),
);
const daemon = await startDaemon({
	home,
	port: 0,
	models,
	box: hostBox(home),
	shipped,
	web: join(WT, "web/dist"),
	log: () => {},
});
const base = `http://127.0.0.1:${daemon.port}`;
const token = (await readDaemonFile(home))!.token!;
log("daemon", { home, port: daemon.port, github: github.url });
const api = async <T>(path: string, method = "GET", body?: object): Promise<T> => {
	const response = await fetch(`${base}/api${path}`, {
		method,
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
	return response.json() as Promise<T>;
};

// ---- the watches as the app's stream says them
type View = { name: string; looked?: number; next?: number; saw?: string[]; failed?: unknown; state?: unknown };
let views: View[] = [];
const stream = new AbortController();
(async () => {
	const response = await fetch(`${base}/api/events`, {
		headers: { authorization: `Bearer ${token}` },
		signal: stream.signal,
	});
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) return;
		buffer += decoder.decode(value, { stream: true });
		for (let i = buffer.indexOf("\n\n"); i >= 0; i = buffer.indexOf("\n\n")) {
			const chunk = buffer.slice(0, i);
			buffer = buffer.slice(i + 2);
			const data = chunk
				.split("\n")
				.filter((l) => l.startsWith("data:"))
				.map((l) => l.slice(5))
				.join("");
			if (!data) continue;
			try {
				const event = JSON.parse(data) as { type: string; watches?: View[] };
				if (event.type === "watches" && event.watches) views = event.watches;
			} catch {}
		}
	}
})().catch(() => {});

const visible = "el.getClientRects().length > 0";
const button = (text: string) =>
	`[...document.querySelectorAll('button')].find(el => ${visible} && el.textContent.trim() === ${JSON.stringify(text)})`;
const named = (label: string) =>
	`[...document.querySelectorAll('[aria-label]')].find(el => ${visible} && el.getAttribute('aria-label') === ${JSON.stringify(label)})`;
const row = `[...document.querySelectorAll('button[aria-label$=": open"]')].find(el => ${visible} && el.innerText.includes('Keep objects as data'))`;
const shows = (text: string) => `document.body.innerText.includes(${JSON.stringify(text)})`;
type Page = {
	run: <T>(e: string) => Promise<T>;
	until: (e: string, ms?: number) => Promise<void>;
	shoot: (f: string) => Promise<void>;
	input: (m: string, p: object) => Promise<unknown>;
	errors: () => readonly string[];
};
async function click(page: Page, expression: string) {
	await page.until(expression);
	await page.run(`(${expression}).scrollIntoView({block:'center'})`);
	await new Promise((r) => setTimeout(r, 400));
	const point = await page.run<{ x: number; y: number }>(
		`(() => {const el=${expression}; const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
	);
	await page.input("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
	await page.input("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
}
async function paste(page: Page, label: string, value: string) {
	await page.until(named(label));
	await page.run(
		`(() => {const el=${named(label)}; el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
	);
}

const watch = () => views.find((v) => v.name !== undefined);
/** Wait until the watch's `looked` moves past `after`, then a few seconds for a held wake's run; the look's reads. */
async function nextLook(after: number | undefined, label: string, maxMs = 12 * 60_000) {
	const start = Date.now();
	while ((watch()?.looked ?? 0) <= (after ?? 0)) {
		if (Date.now() - start > maxMs) throw new Error(`no look for ${label}`);
		await new Promise((r) => setTimeout(r, 1000));
	}
	const looked = watch()!.looked!;
	await new Promise((r) => setTimeout(r, 3000));
	const its = reads.filter((r) => r.at >= looked - 2000 && r.at <= looked + 60_000);
	const view = watch()!;
	log("look", {
		label,
		looked: Math.round((looked - t0) / 1000),
		next: view.next === undefined ? undefined : Math.round((view.next - looked) / 1000),
		reads: its.map((r) => (r.failed ? `${r.method}(failed)` : r.method)),
		saw: view.saw,
		failed: view.failed ?? null,
	});
	return { looked, reads: its };
}

let ok = true;
const expect = (what: string, cond: boolean, data: object = {}) => {
	if (!cond) ok = false;
	log(cond ? "PASS" : "FAIL", { check: what, ...data });
};

try {
	const skills = await fetch(`${base}/api/skills/shipped`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ add: [] }),
	});
	if (!skills.ok) throw new Error(`skills: ${skills.status}`);
	await api("/agents/mara", "PUT", {
		base: null,
		text: "---\nname: Mara\ndescription: Follows things\nconnections: [github]\n---\nFollow things for the owner.\n",
	});
	await api("/capabilities/connections/github/add", "POST", {});
	const started = await api<{ url: string }>("/capabilities/connections/github/signin", "POST", { agent: "mara" });
	const consent = await fetch(started.url, { redirect: "manual" });
	await fetch(consent.headers.get("location") as string, { redirect: "manual" });
	for (;;) {
		const view = await api<{ connections: { name: string; state: string }[] }>("/capabilities");
		if (view.connections.find((c) => c.name === "github")?.state === "connected") break;
		await new Promise((r) => setTimeout(r, 200));
	}
	log("connected");

	await withPage(`${base}/#token=${token}`, { width: 1440, height: 900 }, async (page: Page) => {
		const shot = async (name: string) => {
			await new Promise((r) => setTimeout(r, 800));
			await page.shoot(join(OUT, `1440-${name}.png`));
			log("screenshot", { file: join(OUT, `1440-${name}.png`), errors: page.errors() });
		};
		await page.until(shows("Mara"), 30_000);
		await page.run(`location.hash='#/a/mara'`);
		await click(page, named("Mara: open its panel"));
		await click(page, button("Routines"));
		await page.until(shows("Watching"));
		await click(page, button("Add"));
		await paste(page, "Link to follow", LINK);
		await page.until(`!${button("Follow")}.disabled`);
		await click(page, button("Follow"));
		await page.until(row, 30_000);
		log("followed through the app");

		// 1. baseline: every read
		const a = await nextLook(0, "baseline");
		expect("baseline makes every read", a.reads.length === 4, { reads: a.reads.length });
		await click(page, row);
		await shot("1-baseline-detail");

		// 2. confirm look: every read again (the baseline's answers were made at the look that first saw the values)
		const b = await nextLook(a.looked, "confirm");
		expect("confirm look makes every read", b.reads.length === 4, { reads: b.reads.length });

		// 3. quiet look: one read, the rest carried
		const c = await nextLook(b.looked, "quiet");
		expect("quiet look is one request (pr only)", c.reads.length === 1 && c.reads[0]?.method === "get", {
			reads: c.reads.map((r) => r.method),
		});
		await shot("2-quiet-carried");

		// 4. a label starts a deploy check on the same head: updated_at moves, the head does not
		world.pr = { ...world.pr, updated_at: "2026-11-12T09:20:00Z", labels: ["deploy"] };
		world.checks = [...world.checks, { id: 20, name: "deploy", status: "in_progress", conclusion: null }];
		log("world: label 'deploy' starts a check on the same head; updated_at moves");
		const d = await nextLook(c.looked, "label");
		expect(
			"the label's look reads the checks (updated_at moved)",
			d.reads.some((r) => r.method === "get_check_runs"),
			{ reads: d.reads.map((r) => r.method) },
		);
		// (quiet and busy are both 2 minutes in this run's copy of the definition: the busy cadence is not shown here)
		log("next look after the label", { next: ((watch()?.next ?? 0) - d.looked) / 1000 });

		// 5. the deploy check finishes, failed, and nothing on the pull request moves
		world.checks = world.checks.map((each) =>
			each.name === "deploy" ? { ...each, status: "completed", conclusion: "failure" } : each,
		);
		log("world: deploy completes (failure); updated_at and head unchanged");
		const e = await nextLook(d.looked, "completion");
		expect(
			"the completion is read though updated_at did not move (a check was running)",
			e.reads.some((r) => r.method === "get_check_runs"),
			{ reads: e.reads.map((r) => r.method) },
		);
		// the change is held for the kind's settling minute: the wake comes at the next look
		let f = e;
		const after: { reads: { method: string }[] }[] = [];
		for (let i = 0; i < 3 && !(watch()?.saw ?? []).some((s) => s.includes("deploy failed")); i++) {
			f = await nextLook(f.looked, "wake");
			after.push(f);
		}
		expect(
			"the look after the completion reads the checks once more (done had only just come true)",
			after[0]?.reads.some((r) => r.method === "get_check_runs") === true,
			{ reads: after[0]?.reads.map((r) => r.method) },
		);
		expect("the deploy failure woke the agent", (watch()?.saw ?? []).some((s) => s.includes("deploy failed")), {
			saw: watch()?.saw,
		});
		await page.until(shows("deploy failed"), 60_000).catch(() => {});
		await shot("3-deploy-failed-woken");

		// 5b. quiet again: the checks, done on a value already kept, are carried
		// (the wake's look comes a settling minute after the completion's, which may be short of the sure minute: then
		// one more look reads the checks; a quiet look of one request must follow within two)
		let q = await nextLook(f.looked, "quiet-after-wake");
		const quietReads = [q.reads.map((r) => r.method)];
		if (q.reads.length !== 1) {
			q = await nextLook(q.looked, "quiet-after-wake-2");
			quietReads.push(q.reads.map((r) => r.method));
		}
		expect("within two quiet looks after the wake, one is a single request (pr only)", q.reads.length === 1 && q.reads[0]?.method === "get", {
			reads: quietReads,
		});
		f = q;

		// 6. a failed guarded read: carol approves (updated_at moves), and GitHub refuses the reviews read once
		world.reviews = [...world.reviews, { id: 2, user: { login: "carol" }, state: "APPROVED" }];
		world.pr = { ...world.pr, updated_at: "2026-11-12T09:40:00Z" };
		world.failReviews = true;
		log("world: carol approves (updated_at moves); get_reviews fails for the next look");
		const g = await nextLook(f.looked, "reviews-fail");
		expect(
			"the reviews read was asked and failed",
			g.reads.some((r) => r.method === "get_reviews" && r.failed === true),
			{ reads: g.reads.map((r) => (r.failed ? `${r.method}(failed)` : r.method)) },
		);
		expect("a failed optional read is no change: carol not yet seen", !(watch()?.saw ?? []).some((s) => s.includes("carol")));
		world.failReviews = false;
		log("world: GitHub answers get_reviews again");
		const h = await nextLook(g.looked, "recover");
		expect(
			"the next look reads the reviews again (a failed read is never 'made'), though updated_at is as kept",
			h.reads.some((r) => r.method === "get_reviews" && r.failed !== true),
			{ reads: h.reads.map((r) => r.method) },
		);
		let k = h;
		for (let i = 0; i < 3 && !(watch()?.saw ?? []).some((s) => s.includes("carol")); i++)
			k = await nextLook(k.looked, "wake-carol");
		expect("carol's approval woke the agent after the recovery", (watch()?.saw ?? []).some((s) => s.includes("carol")), {
			saw: watch()?.saw,
		});
		await page.until(shows("carol approved"), 60_000).catch(() => {});
		await shot("4-recovered-carol");
		log("page errors", { errors: page.errors() });
	});

	await withPage(`${base}/#token=${token}`, { width: 390, height: 844 }, async (page: Page) => {
		await page.until(shows("Mara"), 30_000);
		await page.run(`location.hash='#/a/mara'`);
		await page.until(shows("carol approved"), 30_000).catch(() => {});
		await new Promise((r) => setTimeout(r, 1000));
		await page.shoot(join(OUT, "390-1-chat.png"));
		await click(page, named("Mara: open its panel"));
		await click(page, button("Routines"));
		await page.until(row, 30_000);
		await click(page, row);
		await new Promise((r) => setTimeout(r, 1000));
		await page.shoot(join(OUT, "390-2-watch-detail.png"));
		log("screenshot", { file: join(OUT, "390-*.png"), errors: page.errors() });
	});
} catch (error) {
	ok = false;
	log("ERROR", { error: String((error as Error).stack ?? error) });
} finally {
	log("all reads", { count: reads.length, byMethod: reads.reduce((m, r) => ({ ...m, [r.method]: ((m as Record<string, number>)[r.method] ?? 0) + 1 }), {}) });
	log(ok ? "RESULT PASS" : "RESULT FAIL");
	stream.abort();
	await daemon.close().catch(() => {});
	await github.close?.().catch?.(() => {});
	process.exit(ok ? 0 : 1);
}
