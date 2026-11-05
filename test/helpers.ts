import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Harness } from "@earendil-works/pi-durable";
import { afterEach, onTestFinished } from "vitest";
import { Accepted, agentPath, shaOf } from "../src/core/agents.ts";
import { BlobStore } from "../src/core/blobs.ts";
import { type Gateway, type Origin, type Outbound, PermanentSendError } from "../src/core/gateway.ts";
import { context } from "../src/core/store.ts";

export { echoModels, FAUX_MODEL } from "./fixtures/models.ts";

const homes: string[] = [];
afterEach(async () => {
	for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/**
 * Wait on state, never on time: poll `check` until it gives a value (anything but undefined, null or false). It has no
 * clock of its own: the test's timeout bounds it, so a loaded machine only makes a test slower, never makes it fail on
 * a deadline a quiet one meets. Once the test ended it stops, so nothing polls a store that was closed under it.
 */
export async function until<T>(
	check: () => T | undefined | null | false | Promise<T | undefined | null | false>,
	every = 10,
): Promise<T> {
	let ended = false;
	try {
		onTestFinished(() => {
			ended = true;
		});
	} catch {
		// outside a test (a hook): the hook's own timeout bounds it
	}
	for (;;) {
		const value = await check();
		if (value !== undefined && value !== null && value !== false) return value;
		if (ended) throw new Error("the test ended while waiting");
		await new Promise((resolve) => setTimeout(resolve, every));
	}
}

export async function tempHome(): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "banda-test-"));
	homes.push(home);
	return home;
}

/** A blob store in a temporary folder of its own, removed after the test. */
export function blobStore(): BlobStore {
	const root = mkdtempSync(join(tmpdir(), "banda-blobs-"));
	homes.push(root);
	return new BlobStore(root);
}

/** Accept the agent `name`'s file as giving it `tools`. */
export async function allowTools(harness: Harness, name: string, tools: readonly string[]): Promise<void> {
	const text = `---\ndescription: ${name}, for a test\ntools: [${tools.join(", ")}]\n---\n`;
	await harness.commit(async (tx) => {
		(await tx.doc(Accepted)).files[agentPath(name)] = { sha: shaOf(text), text, at: 0 };
	}, context);
}

/** A gateway that records what it sends; `fail` decides per attempt whether a send fails, and how. */
export class FakeGateway implements Gateway {
	readonly strength = "bearer";
	readonly can = { buttons: false, files: false, threads: true };
	readonly sent: { to: Origin; out: Outbound; id: string }[] = [];
	attempts = 0;
	fail: (attempt: number, out: Outbound) => "transient" | "permanent" | undefined = () => undefined;
	readonly name: string;
	constructor(name = "fake") {
		this.name = name;
	}
	start() {}
	async send(to: Origin, out: Outbound): Promise<string> {
		const verdict = this.fail(++this.attempts, out);
		if (verdict === "permanent") throw new PermanentSendError("rejected");
		if (verdict === "transient") throw new Error("unreachable");
		const id = `out-${this.attempts}`;
		this.sent.push({ to, out, id });
		return id;
	}
}
