/**
 * Bringing skills and agents from the other harnesses, cut at each of its effects: the skills written, accepted, each
 * agent saved, and every store commit. After a cut the owner sees the step again (it is not marked done) and brings
 * the same picks; a step marked done is not shown again. Prints what banda ended with as its last line.
 *
 * argv: home, fault schedule JSON (Fault[])
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, type Storage } from "@earendil-works/pi-durable";
import { openBox } from "../../src/box/box.ts";
import { Accepted, shaOf } from "../../src/core/agents.ts";
import { Companion } from "../../src/core/companion.ts";
import { acceptedSkills } from "../../src/core/skills.ts";
import { context, openStore } from "../../src/core/store.ts";
import { AGENT_PUBLICATION_POINTS, recoverAgentPublications } from "../../src/server/agent-publication.ts";
import type { Workspace } from "../../src/server/agents.ts";
import { bringable, chooseBring } from "../../src/server/bring.ts";
import { hostBox } from "../fixtures/host-box.ts";
import { type Fault, Faults, InjectedFault } from "./faults.ts";

const [home, schedule] = process.argv.slice(2) as [string, string];
const faults = new Faults(JSON.parse(schedule) as Fault[]);
const computer = join(home, "computer");

const skill = (name: string) => `---\nname: ${name}\ndescription: What ${name} does.\n---\nDo the ${name} thing.\n`;
const REVIEWER = "---\nname: code-reviewer\ndescription: Reviews a diff.\n---\nYou review code.\n";

/** The owner's computer, made once: Claude Code with two skills (one with a file beside it) and an agent. */
async function made() {
	const claude = join(computer, ".claude");
	await mkdir(join(claude, "skills", "review", "references"), { recursive: true });
	await mkdir(join(claude, "skills", "plan"), { recursive: true });
	await mkdir(join(claude, "agents"), { recursive: true });
	await writeFile(join(claude, "skills", "review", "SKILL.md"), skill("review"));
	await writeFile(join(claude, "skills", "review", "references", "checklist.md"), "- bugs\n");
	await writeFile(join(claude, "skills", "plan", "SKILL.md"), skill("plan"));
	await writeFile(join(claude, "agents", "code-reviewer.md"), REVIEWER);
}
await made();

let armed = false;
const wrapStorage = (storage: Storage): Storage => {
	const faulted = faults.storage(storage);
	return new Proxy(storage, {
		get(target, key) {
			if (key === "commit")
				return (...args: Parameters<Storage["commit"]>) => (armed ? faulted : target).commit(...args);
			const value = Reflect.get(target, key, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
};
const injected = (error: unknown): boolean => {
	for (let current = error; current instanceof Error; current = current.cause)
		if (current instanceof InjectedFault) return true;
	return false;
};

async function open() {
	const box = openBox(hostBox(home), () => {});
	const models = createModels();
	models.setProvider(fauxProvider().provider);
	const harness = await openStore(home, { models, registry: createRegistry(), wrapStorage });
	const workspace: Workspace = {
		env: () => box.env(),
		root: box.workspace,
		tools: () => [],
		known: () => true,
		publicationPoint: (point) => {
			if (armed) faults.hit(point);
		},
	};
	await recoverAgentPublications(harness, workspace);
	return { box, harness, workspace };
}

const options = { folders: { home: computer }, fault: (point: Parameters<Faults["hit"]>[0]) => faults.hit(point) };
const picks = {
	skills: [
		{ harness: "claude-code", name: "review" },
		{ harness: "claude-code", name: "plan" },
	],
	agents: [{ harness: "claude-code", name: "code-reviewer" }],
};

/** What the owner does: while the step shows, bring the same picks. */
async function bring(run: Awaited<ReturnType<typeof open>>) {
	if ((await bringable(run.harness, run.workspace, options, context)).chosen) return;
	await chooseBring(run.harness, run.workspace, picks, async () => {}, options, context);
}

let run = await open();
armed = true;
try {
	await bring(run);
} catch (error) {
	// a thrown fault: the owner is told, and tries again on a daemon opened anew
	if (!injected(error)) throw error;
	armed = false;
	await run.harness.close(context).catch(() => {});
	await Promise.resolve(run.box.close()).catch(() => {});
	run = await open();
	await bring(run);
}
armed = false;

const files = (await run.harness.snapshot(Accepted, context))?.files ?? {};
const companion = await run.harness.snapshot(Companion, context);
const inBox = async (path: string) => readFile(join(run.workspace.root, path), "utf8").catch(() => undefined);
console.log(
	JSON.stringify({
		accepted: acceptedSkills(files).map(({ name, sha }) => ({ name, sha })),
		agent: files["agents/code-reviewer.md"]?.sha,
		box: {
			review: await inBox("skills/review/SKILL.md"),
			plan: await inBox("skills/plan/SKILL.md"),
			checklist: await inBox("skills/review/references/checklist.md"),
			agent: await inBox("agents/code-reviewer.md"),
		},
		expected: { review: shaOf(skill("review")), plan: shaOf(skill("plan")) },
		chosen: { bring: companion?.bringChosen === true, skills: companion?.skillsChosen === true },
		commits: faults.hits("commit:after"),
		points: Object.fromEntries(AGENT_PUBLICATION_POINTS.map((point) => [point, faults.hits(point)])),
	}),
);
await run.harness.close(context);
await run.box.close();
