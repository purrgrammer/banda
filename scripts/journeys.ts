#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { journey, journeys } from "../evals/journeys.ts";
import { createRun, loadRun, newRun, record, saveRun, submit, summary, target } from "../evals/runner.ts";
import { readDaemonFile, webLink } from "../src/home.ts";

const usage = `Journey evals (Node 26)
  npm run eval:journeys -- list
  npm run eval:journeys -- show <journey>
  npm run eval:journeys -- fresh
  npm run eval:journeys -- start <journey> --home <test-home> [--out <run.json>]
  npm run eval:journeys -- start <journey> --url http://127.0.0.1:<port> [--out <run.json>]
  npm run eval:journeys -- send <run.json> <step>
  npm run eval:journeys -- record <run.json> <step> --width desktop|phone --verdict pass|fail|blocked --note <observation>
  npm run eval:journeys -- report <run.json>
URL targets use BANDA_EVAL_TOKEN. No target defaults to the live home.
Fresh runs a throwaway daemon until Ctrl-C; build first with npm run build.
Sending submits one prompt, never approvals or a passing grade. Review each step in the app.`;
async function main() {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			home: { type: "string" },
			url: { type: "string" },
			out: { type: "string" },
			width: { type: "string" },
			verdict: { type: "string" },
			note: { type: "string" },
			help: { type: "boolean" },
		},
	});
	const [command, id, step] = positionals;
	if (!command || values.help) return console.log(usage);
	if (command === "list") return console.log(journeys.map((item) => `${item.id}\t${item.title}`).join("\n"));
	if (command === "show") {
		const item = journey(id);
		console.log(`${item.title}\nRequires: ${item.requires.join("; ")}\n`);
		for (const action of item.steps)
			console.log(
				`${action.id}: ${action.action}\n${action.prompt ? `Prompt: ${action.prompt}\n` : ""}${action.checkpoints.map((check) => `  □ ${check}`).join("\n")}\n`,
			);
		return;
	}
	if (command === "fresh") {
		if (values.home || values.url)
			throw new Error("fresh always creates a unique throwaway home; no target option is accepted.");
		const home = await mkdtemp(join(tmpdir(), "banda-journey-"));
		const logPath = join(home, "daemon.log");
		const log = await open(logPath, "wx", 0o600);
		const child = spawn(
			process.execPath,
			[fileURLToPath(new URL("../dist/cli/index.js", import.meta.url)), "serve", "--home", home, "--port", "0"],
			{
				stdio: ["ignore", log.fd, log.fd],
				env: {
					PATH: process.env.PATH,
					HOME: process.env.HOME,
					DOCKER_HOST: process.env.DOCKER_HOST,
					DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
				},
			},
		);
		await log.close();
		let exited = false;
		child.on("exit", () => {
			exited = true;
		});
		child.on("error", () => {
			exited = true;
		});
		const stop = () => child.kill("SIGTERM");
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		try {
			for (let count = 0; count < 300; count++) {
				if (exited)
					throw new Error(
						`Test daemon exited before readiness. Run npm run build; inspect private diagnostics at ${logPath}.`,
					);
				const daemon = await readDaemonFile(home);
				if (daemon?.port && daemon.token) {
					const link = join(home, "open-app.txt");
					await writeFile(link, `${webLink(daemon.port, daemon.token)}\n`, { mode: 0o600 });
					console.log(
						`Test home: ${home}\nOpen the private app link in ${link}\nConnect a test provider in the app. Ctrl-C stops this daemon; the home is retained.\nStart a checklist: npm run eval:journeys -- start first-use --home ${home}`,
					);
					await new Promise<void>((done) => {
						if (exited) done();
						else child.once("exit", () => done());
					});
					return;
				}
				await new Promise((done) => setTimeout(done, 100));
			}
			throw new Error("Test daemon did not become ready within 30 seconds.");
		} finally {
			stop();
		}
	}
	if (command === "start") {
		const destination = await target(values);
		const run = newRun(id, destination);
		const path = values.out ?? join(await mkdtemp(join(tmpdir(), "banda-journey-run-")), "run.json");
		await createRun(path, run);
		console.log(
			`Run: ${path}\nTarget: ${destination.url}\nNo prompts sent. Use show ${id}, then send <run.json> <step> or perform the action through the app.`,
		);
		return;
	}
	if (!id) throw new Error("A run file is required.");
	const run = await loadRun(id);
	if (command === "send") {
		const destination = await target(run.target.home ? { home: run.target.home } : { url: run.target.url });
		await submit(run, step, destination);
		await saveRun(id, run);
		const sent = run.steps.find((item) => item.id === step);
		console.log(
			`Submitted ${step}. Inspect ${destination.url}/${sent?.chat ? `#/c/${sent.chat}` : ""} and record desktop and phone evidence. Submission is not a pass.`,
		);
	} else if (command === "record") {
		record(run, step, values.width ?? "", values.verdict ?? "", values.note ?? "");
		await saveRun(id, run);
		console.log(JSON.stringify(summary(run), null, 2));
	} else if (command === "report") {
		console.log(
			JSON.stringify(
				{
					journey: run.journey,
					created: run.created,
					target: run.target.url,
					...summary(run),
					steps: run.steps.map(({ id, submitted, evidence }) => ({ id, submitted, evidence })),
				},
				null,
				2,
			),
		);
	} else throw new Error("Unknown command. Run with --help.");
}
main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "Journey eval failed.");
	process.exitCode = 1;
});
