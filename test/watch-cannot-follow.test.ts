import { createRegistry } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { GITHUB_OBJECTS } from "../scripts/github-objects.ts";
import { Accepted, shaOf } from "../src/core/agents.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore } from "../src/core/turn.ts";
import { cannotFollow } from "../src/core/watches.ts";
import { blobStore, echoModels, FAUX_MODEL, FakeGateway, tempHome } from "./helpers.ts";

const NOW = new Date(2026, 10, 2, 9, 0).getTime();

/** A GitHub file as one accepted before `follow` existed: the same objects, none of them followable. */
function olderGithubFile(): string {
	const objects = Object.fromEntries(
		// the pull request kind as it was before `follow`: the kinds added since have no older form
		Object.entries(GITHUB_OBJECTS)
			.filter(([kind]) => kind === "pull_request")
			.map(([kind, entry]) => {
				const {
					follow: _,
					reads,
					...rest
				} = entry as { follow?: unknown; reads: { [as: string]: { follow?: unknown } } };
				const plain = Object.fromEntries(
					Object.entries(reads).flatMap(([as, { follow, ...read }]) => (follow === undefined ? [[as, read]] : [])),
				);
				return [kind, { ...rest, reads: plain }];
			}),
	);
	return `---\nservice: GitHub\nurl: https://example.com/mcp\nauth: oauth\naccount: get_me.login\nscopes: [repo]\nreads: [pull_request_read, issue_read, actions_get, get_notification_details]\n---\nGitHub objects.\n\n\`\`\`json\n${JSON.stringify({ objects }, null, 2)}\n\`\`\`\n`;
}

describe("a link that cannot be followed", () => {
	it("says the connection's file is the reason when it recognises the link, and that nothing does otherwise", async () => {
		const core = defineCore({ blobs: blobStore(), gateway: () => new FakeGateway(), model: () => FAUX_MODEL });
		const registry = createRegistry();
		registry.install(core.extension);
		const harness = await openStore(await tempHome(), { models: echoModels().models, registry });
		const file = olderGithubFile();
		const words = await harness.commit(async (tx) => {
			(await tx.doc(Accepted)).files["connections/github.md"] = { sha: shaOf(file), text: file, at: NOW };
			return {
				known: await cannotFollow(tx, "https://github.com/purrgrammer/banda/pull/24"),
				unknown: await cannotFollow(tx, "https://example.org/thing/1"),
			};
		}, context);
		expect(words.known).toBe("GitHub here cannot follow a pull request yet: update GitHub on the Connections page");
		expect(words.unknown).toBe("no connection you have recognises that link");
		await harness.close(context);
	});
});
