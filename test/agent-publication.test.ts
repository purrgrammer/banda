import { mkdir, open, readdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ExecutionEnv, FileError } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import { agentPath, shaOf } from "../src/core/agents.ts";
import { context } from "../src/core/store.ts";
import { type AgentPublicationPoint, AgentPublications, publicationHistory } from "../src/server/agent-publication.ts";
import { agents, decline, retryPublication, save } from "../src/server/agents.ts";
import { agentSaveScenario } from "./fault/agent-save-scenario.ts";
import { tempHome } from "./helpers.ts";

const changed = async () => {};

describe("owner agent file publication", () => {
	it.each(["directory", "previous"] as const)(
		"returns saved and pending for a returned %s metadata error",
		async (where) => {
			const { harness, workspace, accepted, env } = await agentSaveScenario(await tempHome());
			const before = await accepted();
			const owner = `${before.text}\nOwner version.\n`;
			const failing = new Proxy(env, {
				get(target, key) {
					if (key === "fileInfo") {
						const info: ExecutionEnv["fileInfo"] = async (path, ctx) =>
							path.endsWith(where === "directory" ? "/agents" : "/previous")
								? { ok: false, error: new FileError("unknown", "disk disconnected", path) }
								: target.fileInfo(path, ctx);
						return info;
					}
					const value: unknown = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			try {
				const rows = await save(harness, { ...workspace, env: () => failing }, "sancho", owner, before.sha, changed);
				expect((await accepted()).text).toBe(owner);
				expect(rows[0]?.publication?.state).toBe("pending");
			} finally {
				await harness.close(context);
			}
		},
	);

	it("does not mistake a returned deletion-check error for an absent destination", async () => {
		const { harness, workspace, env } = await agentSaveScenario(await tempHome());
		const text = "---\ndescription: Draft\n---\nKeep these bytes.\n";
		const target = join(workspace.root, agentPath("draft"));
		await writeFile(target, text);
		let retained = false;
		const failing = new Proxy(env, {
			get(target, key) {
				if (key === "fileInfo") {
					const info: ExecutionEnv["fileInfo"] = async (path, ctx) =>
						retained && path.endsWith("/draft.md")
							? { ok: false, error: new FileError("unknown", "disk disconnected", path) }
							: target.fileInfo(path, ctx);
					return info;
				}
				const value: unknown = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		try {
			await decline(
				harness,
				{
					...workspace,
					env: () => failing,
					publicationPoint: (point) => {
						if (point === "agent:retain:after") retained = true;
					},
				},
				"draft",
				context,
				shaOf(text),
			);
			const doc = await harness.snapshot(AgentPublications, context);
			expect(doc?.operations[String(doc.current.draft)]?.state.kind).toBe("pending");
			expect(
				(await publicationHistory(harness, workspace, "draft")).items.flatMap((item) => item.retained),
			).toContainEqual(expect.objectContaining({ kind: "text", text }));
		} finally {
			await harness.close(context);
		}
	});

	it("returns saved and pending after publication transport loss also makes workspace listing unavailable", async () => {
		const { harness, workspace, accepted, env } = await agentSaveScenario(await tempHome());
		const before = await accepted();
		const owner = `${before.text}\nOwner version.\n`;
		let offline = false;
		const remote = new Proxy(env, {
			get(target, key) {
				if (key === "id") return "test:remote";
				if (key === "exec") {
					const exec: ExecutionEnv["exec"] = async (...args) => {
						if (offline) throw new Error("The transport is offline.");
						return target.exec(...args);
					};
					return exec;
				}
				const value = Reflect.get(target, key, target) as unknown;
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		try {
			const rows = await save(
				harness,
				{
					...workspace,
					env: () => {
						if (offline) throw new Error("The transport is offline.");
						return remote;
					},
					publicationPoint: (point) => {
						if (point === "agent:retain:before") offline = true;
					},
				},
				"sancho",
				owner,
				before.sha,
				changed,
			);
			expect(rows[0]?.accepted?.text).toBe(owner);
			expect(rows[0]?.publication?.state).toBe("pending");
			expect(rows[0]?.change).toBeUndefined();
		} finally {
			await harness.close(context);
		}
	});
	it("keeps a file created at the final insertion boundary, and resolves only the reviewed conflict", async () => {
		const scenario = await agentSaveScenario(await tempHome());
		const { harness, workspace, accepted } = scenario;
		const before = await accepted();
		const owner = `${before.text}\nOwner version.\n`;
		const rival = `${before.text}\nConcurrent box version.\n`;
		const target = join(workspace.root, agentPath("sancho"));
		try {
			await save(
				harness,
				{
					...workspace,
					publicationPoint: async (point) => {
						if (point === "agent:insert:before") await writeFile(target, rival);
					},
				},
				"sancho",
				owner,
				before.sha,
				changed,
			);
			expect((await accepted()).text).toBe(owner);
			expect(await readFile(target, "utf8")).toBe(rival);
			const publication = (await agents(harness, workspace))[0]?.publication;
			expect(publication?.state).toBe("conflict");
			if (publication === undefined) throw new Error("missing conflict");
			expect(publication.retained).toContainEqual(expect.objectContaining({ kind: "text", text: before.text }));
			await expect(retryPublication(harness, workspace, "sancho", publication.id, before.sha)).rejects.toMatchObject({
				status: 409,
			});
			await retryPublication(harness, workspace, "sancho", publication.id, shaOf(rival));
			expect(await readFile(target, "utf8")).toBe(owner);
			const history = await publicationHistory(harness, workspace, "sancho");
			expect(history.items.flatMap((item) => item.retained)).toContainEqual(
				expect.objectContaining({ kind: "text", text: rival }),
			);
		} finally {
			await harness.close(context);
		}
	});

	it("keeps late writes through an already-open descriptor reachable after successful publication", async () => {
		const { harness, workspace, accepted } = await agentSaveScenario(await tempHome());
		const before = await accepted();
		const target = join(workspace.root, agentPath("sancho"));
		const descriptor = await open(target, "r+");
		const owner = `${before.text}\nOwner version.\n`;
		const late = "A late edit through the old descriptor.";
		try {
			await save(harness, workspace, "sancho", owner, before.sha, changed);
			await descriptor.truncate(0);
			await descriptor.writeFile(late);
			expect(await readFile(target, "utf8")).toBe(owner);
			const row = (await agents(harness, workspace))[0];
			expect(row?.publication?.state).toBe("conflict");
			expect(row?.publication?.retained).toContainEqual(expect.objectContaining({ kind: "text", text: late }));
		} finally {
			await descriptor.close();
			await harness.close(context);
		}
	});

	const boundaries: AgentPublicationPoint[] = [
		"agent:stage:before",
		"agent:stage:after",
		"agent:retain:before",
		"agent:retain:after",
		"agent:insert:before",
		"agent:insert:after",
	];
	it.each(boundaries)("recovers an identified owner edit after an interruption at %s", async (boundary) => {
		const home = await tempHome();
		let scenario = await agentSaveScenario(home);
		const before = await scenario.accepted();
		const owner = `${before.text}\nOwner version.\n`;
		try {
			await expect(
				save(
					scenario.harness,
					{
						...scenario.workspace,
						publicationPoint: (point) => {
							if (point === boundary) throw new Error("interrupted publication");
						},
					},
					"sancho",
					owner,
					before.sha,
					changed,
				),
			).rejects.toThrow("interrupted publication");
			await scenario.harness.close(context);
			scenario = await agentSaveScenario(home);
			expect((await scenario.accepted()).text).toBe(owner);
			expect(await readFile(join(scenario.workspace.root, agentPath("sancho")), "utf8")).toBe(owner);
			expect((await agents(scenario.harness, scenario.workspace))[0]?.change).toBeUndefined();
		} finally {
			await scenario.harness.close(context);
		}
	});

	it.each(["file", "symlink"] as const)("never truncates an unexpected %s at its stage path", async (kind) => {
		const { harness, workspace, accepted } = await agentSaveScenario(await tempHome());
		const before = await accepted();
		const owner = `${before.text}\nOwner version.\n`;
		const other = join(workspace.root, "other.txt");
		await writeFile(other, "unrelated work");
		let collided = "";
		try {
			const rows = await save(
				harness,
				{
					...workspace,
					publicationPoint: async (point) => {
						if (point !== "agent:stage:before") return;
						const doc = await harness.snapshot(AgentPublications, context);
						const id = doc?.current.sancho;
						const path = join(workspace.root, "agents/.banda-publications", String(id));
						const attempts = (await readdir(path)).filter((name) => name.startsWith("attempt-"));
						collided = join(path, attempts.at(-1) ?? "missing", "owner");
						if (kind === "file") await writeFile(collided, "unrelated work");
						else await symlink(other, collided);
					},
				},
				"sancho",
				owner,
				before.sha,
				changed,
			);
			expect(rows[0]?.publication?.state).toBe("pending");
			expect((await accepted()).text).toBe(owner);
			expect(await readFile(collided, "utf8")).toBe("unrelated work");
			expect(await readFile(other, "utf8")).toBe("unrelated work");
		} finally {
			await harness.close(context);
		}
	});

	it("preserves a final symlink that replaces the reviewed file and never writes its referent", async () => {
		const { harness, workspace, accepted } = await agentSaveScenario(await tempHome());
		const before = await accepted();
		const target = join(workspace.root, agentPath("sancho"));
		const elsewhere = join(workspace.root, "elsewhere.txt");
		const owner = `${before.text}\nOwner version.\n`;
		await writeFile(elsewhere, "unrelated work");
		try {
			await save(
				harness,
				{
					...workspace,
					publicationPoint: async (point) => {
						if (point !== "agent:retain:before") return;
						await rename(target, `${target}.box-kept`);
						await symlink(elsewhere, target);
					},
				},
				"sancho",
				owner,
				before.sha,
				changed,
			);
			expect(await readFile(elsewhere, "utf8")).toBe("unrelated work");
			expect(await readFile(`${target}.box-kept`, "utf8")).toBe(before.text);
			expect((await agents(harness, workspace))[0]?.publication?.state).toBe("conflict");
		} finally {
			await harness.close(context);
		}
	});

	it("preserves both directories when a writer replaces the parent before displacement", async () => {
		const { harness, workspace, accepted } = await agentSaveScenario(await tempHome());
		const before = await accepted();
		const owner = `${before.text}\nOwner version.\n`;
		const rival = `${before.text}\nNew parent version.\n`;
		try {
			await save(
				harness,
				{
					...workspace,
					publicationPoint: async (point) => {
						if (point !== "agent:retain:before") return;
						await rename(join(workspace.root, "agents"), join(workspace.root, "moved-agents"));
						await mkdir(join(workspace.root, "agents"));
						await writeFile(join(workspace.root, agentPath("sancho")), rival);
					},
				},
				"sancho",
				owner,
				before.sha,
				changed,
			);
			expect(await readFile(join(workspace.root, "moved-agents/sancho.md"), "utf8")).toBe(before.text);
			expect(await readFile(join(workspace.root, agentPath("sancho")), "utf8")).toBe(rival);
			expect((await accepted()).text).toBe(owner);
		} finally {
			await harness.close(context);
		}
	});
});
