/**
 * Host mode as the daemon serves it (H-064): `serve --box host` runs agents' commands on this computer as the owner,
 * so the daemon it starts takes every wallet offline for agents. A home with a wallet switched on for the lead, served
 * on a host box, refuses the lead's read of it.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Context as ModelContext,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { LEAD } from "../src/core/agents.ts";
import { accountKey, WALLET } from "../src/core/connections.ts";
import { context } from "../src/core/store.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import { checksummed } from "../src/wallet/address.ts";
import { Wallets } from "../src/wallet/docs.ts";
import { openConnected } from "./fixtures/connected.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { DEV0 } from "./helpers/anvil.ts";
import { FauxChain } from "./helpers/faux-chain.ts";
import { tempHome, until } from "./helpers.ts";

const ADDRESS = checksummed(DEV0.address);
const MARKER = "WALLET ADDRESS PLEASE";

const textOf = (content: unknown) =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((part: { text?: string }) => part.text ?? "").join("")
			: "";

function toolsOf(ctx: ModelContext): string[] {
	const tools = new Set<string>();
	for (const message of ctx.messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
	}
	return [...tools];
}

describe("a daemon serving on a host box", () => {
	it("refuses an agent's wallet read: agents run commands on this computer (H-064)", async () => {
		const home = await tempHome();
		// the wallet, made and switched on for the lead before the daemon serves the home
		const seeded = await openConnected({ home, respond: () => fauxAssistantMessage("Done.") });
		try {
			await seeded.harness.commit(async (tx) => {
				(await tx.doc(Wallets)).wallets[ADDRESS] = {
					name: "Groceries",
					network: "base-sepolia",
					state: "ready",
					backup: "saved",
					default: "ask",
					disclosed: false,
					request: "r-1",
					version: 1,
					at: 1,
				};
			}, context);
			await seeded.capabilities.addWallet({
				account: `home/wallet/${ADDRESS}`,
				address: ADDRESS,
				network: "base-sepolia",
			});
			await seeded.capabilities.switchAccount(LEAD, WALLET, accountKey(ADDRESS), true);
		} finally {
			await seeded.close();
		}

		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const web = join(home, "web");
		await mkdir(web, { recursive: true });
		await writeFile(join(web, "index.html"), "<!doctype html><title>banda</title>");
		const answers: string[] = [];
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const respond = (ctx: ModelContext) => {
			const last = ctx.messages.filter((m) => m.role !== "system").at(-1);
			if (last?.role === "toolResult") {
				if (last.toolName === "wallet__address") {
					answers.push(textOf(last.content));
					return fauxAssistantMessage("done");
				}
				if (last.toolName === "message_user") return fauxAssistantMessage("done");
			}
			const input = [...ctx.messages].reverse().find((message) => message.role === "user");
			if (!textOf(input?.content).includes(MARKER) || answers.length > 0) return fauxAssistantMessage("done");
			if (!toolsOf(ctx).includes("wallet__address"))
				return fauxAssistantMessage([fauxToolCall("tool_search", { query: "wallet__address", limit: 1 })], {
					stopReason: "toolUse",
				});
			return fauxAssistantMessage([fauxToolCall("wallet__address", {})], { stopReason: "toolUse" });
		};
		faux.setResponses(Array.from({ length: 200 }, () => respond as never));
		// the wallet's chain is the test's own: nothing leaves the machine
		const chain = new FauxChain(84532);
		const daemon = await startDaemon({
			home,
			port: 0,
			models,
			log: () => {},
			box: hostBox(home),
			web,
			fetch: chain.fetch,
		});
		try {
			const token = (await readDaemonFile(home))?.token;
			const response = await fetch(`http://127.0.0.1:${daemon.port}/api/messages`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}` },
				body: JSON.stringify({ id: randomUUID(), thread: `agent:${LEAD}`, text: MARKER }),
			});
			expect(response.ok, await response.clone().text()).toBe(true);
			const answer = await until(async () => answers[0]);
			expect(answer).toBe(
				"wallet__address did not run: wallets are offline for agents: agents run commands on this computer.",
			);
			expect(answer).not.toContain(ADDRESS);
		} finally {
			await daemon.close();
		}
	});
});
