import { chmod, mkdir, readFile, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { openBox } from "../src/box/box.ts";
import { Accepted, agentPath, parseAgent } from "../src/core/agents.ts";
import { Companion } from "../src/core/companion.ts";
import { acceptedSkills } from "../src/core/skills.ts";
import { context, openStore } from "../src/core/store.ts";
import type { Workspace } from "../src/server/agents.ts";
import { agentFrom, bringable, chooseBring } from "../src/server/bring.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { echoModels, tempHome } from "./helpers.ts";

const skill = (name: string, description = `What ${name} does.`) =>
	`---\nname: ${name}\ndescription: ${description}\nallowed-tools: Bash\n---\nDo the ${name} thing.\n`;

const REVIEWER = `---
name: code-reviewer
description: Reviews a diff for bugs.
  Use it before a commit.
tools: Read, Grep
model: sonnet
color: blue
---
You review code. Name each bug with its file and line.
`;

/** A computer's home with Claude Code and Codex set up, and pi not. */
async function computer() {
	const home = await tempHome();
	const claude = join(home, ".claude");
	await mkdir(join(claude, "skills", "review", "references"), { recursive: true });
	await writeFile(join(claude, "skills", "review", "SKILL.md"), skill("review"));
	await writeFile(join(claude, "skills", "review", "references", "checklist.md"), "- bugs\n");
	await writeFile(join(claude, "skills", "review", ".secret"), "hidden\n");
	await writeFile(join(claude, "skills", "review", "logo.png"), Buffer.from([0x89, 0x50, 0xff, 0xfe, 0x00]));
	await writeFile(join(home, "outside.txt"), "the owner's other file\n");
	await symlink(join(home, "outside.txt"), join(claude, "skills", "review", "outside.txt"));
	// a skill installed as a link to its folder elsewhere
	await mkdir(join(home, "elsewhere", "linked"), { recursive: true });
	await writeFile(join(home, "elsewhere", "linked", "SKILL.md"), skill("linked"));
	await symlink(join(home, "elsewhere", "linked"), join(claude, "skills", "linked"));
	await mkdir(join(claude, "skills", "My_Notes"), { recursive: true });
	await writeFile(join(claude, "skills", "My_Notes", "SKILL.md"), skill("My_Notes"));
	await mkdir(join(claude, "skills", "wrong"), { recursive: true });
	await writeFile(join(claude, "skills", "wrong", "SKILL.md"), skill("other"));
	await mkdir(join(claude, "agents"), { recursive: true });
	await writeFile(join(claude, "agents", "code-reviewer.md"), REVIEWER);
	await writeFile(join(claude, "agents", "bare.md"), "No frontmatter here.\n");
	await mkdir(join(home, ".codex"), { recursive: true });
	await mkdir(join(home, ".agents", "skills", "shared"), { recursive: true });
	await writeFile(join(home, ".agents", "skills", "shared", "SKILL.md"), skill("shared"));
	return { home };
}

async function setup() {
	const { home } = await computer();
	const daemon = await tempHome();
	const box = openBox(hostBox(daemon), () => {});
	const harness = await openStore(daemon, { models: echoModels().models, registry: createRegistry() });
	const workspace: Workspace = { env: () => box.env(), root: box.workspace, tools: () => [], known: () => true };
	const changed: string[] = [];
	return {
		box,
		harness,
		workspace,
		folders: { home, codex: join(home, ".codex") },
		changed,
		onChanged: async (_tx: unknown, name: string) => {
			changed.push(name);
		},
		close: async () => {
			await harness.close(context);
			await box.close();
		},
	};
}

describe("bringing from the other harnesses at first run", () => {
	it("offers what each harness set up here has, and says why one cannot be brought", async () => {
		const { harness, workspace, folders, close } = await setup();
		try {
			const view = await bringable(harness, workspace, { folders });
			expect(view.chosen).toBe(false);
			expect(view.harnesses.map(({ name, folder }) => [name, folder])).toEqual([
				["claude-code", "~/.claude"],
				["codex", "~/.codex"],
			]);
			const [claude, codex] = view.harnesses;
			expect(claude?.skills.map(({ name, problem }) => [name, problem !== undefined])).toEqual([
				["My_Notes", true],
				["linked", false],
				["review", false],
				["wrong", true],
			]);
			expect(claude?.skills.find(({ name }) => name === "review")?.about).toBe("What review does.");
			expect(claude?.agents.map(({ name, problem }) => [name, problem])).toEqual([
				["bare", "It has no frontmatter."],
				["code-reviewer", undefined],
			]);
			expect(codex?.skills.map(({ name }) => name)).toEqual(["shared"]);
		} finally {
			await close();
		}
	});

	it("copies and accepts what was picked, read again from the computer, and is not offered again", async () => {
		const { box, harness, workspace, folders, changed, onChanged, close } = await setup();
		try {
			const view = await chooseBring(
				harness,
				workspace,
				{
					skills: [
						{ harness: "claude-code", name: "review" },
						{ harness: "claude-code", name: "linked" },
						{ harness: "codex", name: "shared" },
					],
					agents: [{ harness: "claude-code", name: "code-reviewer" }],
				},
				onChanged,
				{ folders },
			);
			expect(view.chosen).toBe(true);
			expect((await harness.snapshot(Companion, context))?.bringChosen).toBe(true);
			// they brought their own: banda's skills are not offered after
			expect((await harness.snapshot(Companion, context))?.skillsChosen).toBe(true);
			const accepted = (await harness.snapshot(Accepted, context))?.files ?? {};
			expect(acceptedSkills(accepted).map(({ name }) => name)).toEqual(["linked", "review", "shared"]);
			const skills = join(box.workspace, "skills");
			expect(await readFile(join(skills, "review", "SKILL.md"), "utf8")).toBe(skill("review"));
			expect(await readFile(join(skills, "review", "references", "checklist.md"), "utf8")).toBe("- bugs\n");
			// hidden files, links inside a skill and files that are not text stay behind
			for (const left of [".secret", "outside.txt", "logo.png"])
				await expect(stat(join(skills, "review", left))).rejects.toThrow();
			const agent = accepted[agentPath("code-reviewer")];
			expect(agent).toBeDefined();
			expect(await readFile(join(box.workspace, "agents", "code-reviewer.md"), "utf8")).toBe(agent?.text);
			expect(changed).toEqual(["code-reviewer"]);
			const after = await bringable(harness, workspace, { folders });
			expect(after.harnesses[0]?.skills.find(({ name }) => name === "review")?.added).toBe(true);
			expect(after.harnesses[0]?.agents.find(({ name }) => name === "code-reviewer")?.added).toBe(true);
		} finally {
			await close();
		}
	});

	it("supersedes a folder of that name the box wrote but nobody accepted", async () => {
		const { box, harness, workspace, folders, onChanged, close } = await setup();
		try {
			await mkdir(join(box.workspace, "skills", "review"), { recursive: true });
			await writeFile(join(box.workspace, "skills", "review", "SKILL.md"), skill("review", "The box's own."));
			const before = await bringable(harness, workspace, { folders });
			expect(before.harnesses[0]?.skills.find(({ name }) => name === "review")?.added).toBe(false);
			await chooseBring(
				harness,
				workspace,
				{ skills: [{ harness: "claude-code", name: "review" }], agents: [] },
				onChanged,
				{ folders },
			);
			expect(await readFile(join(box.workspace, "skills", "review", "SKILL.md"), "utf8")).toBe(skill("review"));
			const accepted = acceptedSkills((await harness.snapshot(Accepted, context))?.files ?? {});
			expect(accepted.map(({ name, body }) => [name, body])).toEqual([["review", "Do the review thing.\n"]]);
		} finally {
			await close();
		}
	});

	it("skips with nothing picked, and refuses a pick it cannot take before writing anything", async () => {
		const { box, harness, workspace, folders, onChanged, close } = await setup();
		try {
			const choose = (skills: { harness: string; name: string }[]) =>
				chooseBring(harness, workspace, { skills, agents: [] }, onChanged, { folders });
			await expect(choose([{ harness: "claude-code", name: "wrong" }])).rejects.toThrow(/name must be wrong/);
			await expect(choose([{ harness: "cursor", name: "review" }])).rejects.toThrow(/no harness named cursor/);
			await expect(choose([{ harness: "claude-code", name: "gone" }])).rejects.toThrow(/no skill named gone/);
			await expect(
				choose([
					{ harness: "claude-code", name: "review" },
					{ harness: "codex", name: "review" },
				]),
			).rejects.toThrow(/same name/);
			await expect(
				choose([
					{ harness: "claude-code", name: "review" },
					{ harness: "claude-code", name: "wrong" },
				]),
			).rejects.toThrow();
			await expect(stat(join(box.workspace, "skills", "review"))).rejects.toThrow();
			expect((await harness.snapshot(Companion, context))?.bringChosen).toBeUndefined();
			expect((await choose([])).chosen).toBe(true);
			// nothing brought: banda's own skills come next
			expect((await harness.snapshot(Companion, context))?.skillsChosen).toBeUndefined();
		} finally {
			await close();
		}
	});
});

describe("what the review found: a folder that can't be read, or read safely, is that skill's problem", () => {
	it("lists the rest when one skill has a folder it cannot read, and never descends into hidden folders", async () => {
		const { harness, workspace, folders, close } = await setup();
		const skills = join(folders.home, ".claude", "skills");
		try {
			await mkdir(join(skills, "review", "locked"), { recursive: true });
			await chmod(join(skills, "review", "locked"), 0o000);
			await mkdir(join(skills, "linked", ".venv", "locked"), { recursive: true });
			await chmod(join(skills, "linked", ".venv", "locked"), 0o000);
			const view = await bringable(harness, workspace, { folders });
			const listed = view.harnesses[0]?.skills ?? [];
			expect(listed.find(({ name }) => name === "review")?.problem).toBe("Part of its folder could not be read.");
			expect(listed.find(({ name }) => name === "linked")?.problem).toBeUndefined();
		} finally {
			await chmod(join(skills, "review", "locked"), 0o755);
			await chmod(join(skills, "linked", ".venv", "locked"), 0o755);
			await close();
		}
	});

	it("knows a folder is too big from its sizes, before reading a byte of it", async () => {
		const { harness, workspace, folders, close } = await setup();
		try {
			const model = join(folders.home, ".claude", "skills", "review", "model.bin");
			await writeFile(model, "");
			await truncate(model, 3 * 1024 * 1024 * 1024); // sparse: 3 GB that no read could hold
			const view = await bringable(harness, workspace, { folders });
			expect(view.harnesses[0]?.skills.find(({ name }) => name === "review")?.problem).toMatch(/too big/);
		} finally {
			await close();
		}
	});

	it("refuses a SKILL.md with characters the owner cannot see, or one that is a link", async () => {
		const { harness, workspace, folders, close } = await setup();
		const skills = join(folders.home, ".claude", "skills");
		try {
			await writeFile(join(skills, "review", "SKILL.md"), `${skill("review")}Also\u{E0041}\u200B do this.\n`);
			await mkdir(join(skills, "plan"), { recursive: true });
			await writeFile(join(folders.home, "plan.md"), skill("plan"));
			await symlink(join(folders.home, "plan.md"), join(skills, "plan", "SKILL.md"));
			const listed = (await bringable(harness, workspace, { folders })).harnesses[0]?.skills ?? [];
			expect(listed.find(({ name }) => name === "review")?.problem).toMatch(/^Its SKILL.md: /);
			expect(listed.find(({ name }) => name === "plan")?.problem).toBe("It has no SKILL.md.");
		} finally {
			await close();
		}
	});

	it("refuses more picks than it can accept at once before writing any", async () => {
		const { box, harness, workspace, folders, onChanged, close } = await setup();
		try {
			const skills = Array.from({ length: 201 }, (_, n) => ({ harness: "claude-code", name: `s${n}` }));
			skills[0] = { harness: "claude-code", name: "review" };
			await expect(chooseBring(harness, workspace, { skills, agents: [] }, onChanged, { folders })).rejects.toThrow(
				/at most 200/,
			);
			await expect(stat(join(box.workspace, "skills", "review"))).rejects.toThrow();
		} finally {
			await close();
		}
	});
});

describe("a Claude Code subagent as a banda agent", () => {
	it("keeps its name, description and instructions, and leaves its tools and model behind", () => {
		const found = agentFrom("code-reviewer.md", REVIEWER);
		if (!("text" in found)) throw new Error(found.problem);
		const parsed = parseAgent("code-reviewer", found.text);
		if (!("agent" in parsed)) throw new Error(parsed.errors.join("\n"));
		expect(parsed.agent.name).toBe("Code reviewer");
		expect(parsed.agent.description).toBe("Reviews a diff for bugs. Use it before a commit.");
		expect(parsed.agent.tools).toEqual([]);
		expect(parsed.agent.model).toBeUndefined();
		expect(parsed.agent.instructions.trim()).toBe("You review code. Name each bug with its file and line.");
	});

	it("says what is missing", () => {
		expect(agentFrom("x.md", "---\nname: x\n---\nbody\n")).toMatchObject({ problem: "It has no description." });
		expect(agentFrom("x.md", "---\nname: Big Agent\ndescription: d\n---\nbody\n")).toMatchObject({
			problem: "Its name is not an agent name banda takes.",
		});
	});
});
