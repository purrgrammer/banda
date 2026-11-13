import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { Accepted, agentPath, shaOf } from "../src/core/agents.ts";
import { context } from "../src/core/store.ts";
import { agentPublicationView, queueAgentPublication } from "../src/server/agent-publication.ts";
import { openConnected } from "./fixtures/connected.ts";
import { tempHome } from "./helpers.ts";

it("recovers an accepted agent publication when connection wiring reopens", async () => {
	const home = await tempHome();
	const before = "---\nname: Reader\ndescription: Reads things\n---\nRead carefully.\n";
	const after = `${before}\nVerify claims.\n`;
	const first = await openConnected({ home, respond: () => fauxAssistantMessage("Done.") });
	const path = join(first.workspace.root, agentPath("reader"));
	try {
		await mkdir(join(first.workspace.root, "agents"), { recursive: true });
		await writeFile(path, before);
		await first.harness.commit(async (tx) => {
			const accepted = await tx.doc(Accepted);
			accepted.files[agentPath("reader")] = { text: before, sha: shaOf(before), at: 1 };
			const file = { text: after, sha: shaOf(after), at: 2 };
			await queueAgentPublication(tx, {
				name: "reader",
				file,
				base: shaOf(before),
				workingBase: shaOf(before),
			});
			accepted.files[agentPath("reader")] = file;
		}, context);
		expect(await readFile(path, "utf8")).toBe(before);
	} finally {
		await first.close();
	}
	const reopened = await openConnected({ home, respond: () => fauxAssistantMessage("Done.") });
	try {
		expect((await reopened.harness.snapshot(Accepted, context))?.files[agentPath("reader")]?.text).toBe(after);
		expect(await readFile(path, "utf8")).toBe(after);
		const publication = await agentPublicationView(reopened.harness, reopened.workspace, "reader");
		expect(publication?.state).toBe("retained");
		expect(publication?.retained).toContainEqual(expect.objectContaining({ kind: "text", text: before }));
	} finally {
		await reopened.close();
	}
});
