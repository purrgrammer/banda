#!/usr/bin/env node
/**
 * What a provider's prompt cache really does with banda's request shape: three turns of invented filler, each sent with
 * the status line where `src/core/now.ts` puts it and without it. It makes real requests on a fork's sign-ins and spends
 * real tokens, so it runs only when asked, and never on the live home.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Message, MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { registerAccount } from "../src/core/account-provider.ts";
import { nowLine } from "../src/core/now.ts";
import { FileCredentialStore } from "../src/core/provider-credentials.ts";
import { resolveHome } from "../src/home.ts";

const SYSTEM_SENTENCES = 1_800;
const TURN_SENTENCES = 500;
const TURNS = 3;
const SENTENCES = [
	"The harbour keeps its boats in tidy rows along the quiet stone wall.",
	"A baker on the corner opens early and sells warm bread to the neighbours.",
	"The river bends twice before it reaches the old mill near the orchard.",
	"Children walk to school past the market and wave at the fruit sellers.",
	"Autumn rain fills the gutters and the street smells of wet leaves.",
];

/** `none` has no status line; `status` moves it to each turn's input, as today; `kept` leaves each turn's where it was. */
type Variant = "none" | "status" | "kept";
type Result = {
	readonly target: string;
	readonly variant: Variant;
	readonly turn: number;
	readonly uncached: number;
	readonly read: number;
	readonly written: number;
	readonly error?: string;
};

const canonical = (path: string) => realpath(path).catch(() => resolve(path));

const filler = (nonce: string, label: string, count: number) =>
	`${label} ${nonce}\n${Array.from({ length: count }, (_, at) => SENTENCES[at % SENTENCES.length]).join(" ")}`;

const statusMessage = (): Message => ({ role: "system", content: nowLine(Date.now()), timestamp: Date.now() });

/** The status line before the last user message, as `withStatus` places it; the provider's converter does the rest. */
function placed(messages: readonly Message[], variant: Variant): Message[] {
	if (variant !== "status") return [...messages];
	const status = statusMessage();
	const at = messages.map((message) => message.role).lastIndexOf("user");
	return [...messages.slice(0, at), status, ...messages.slice(at)];
}

async function probe(models: MutableModels, target: string, variant: Variant): Promise<Result[]> {
	const [provider, ...rest] = target.split("/");
	const model = models.getModel(provider ?? "", rest.join("/"));
	if (model === undefined) throw new Error(`${target} is not a model here`);
	const nonce = randomBytes(8).toString("hex");
	const sessionId = randomUUID();
	const history: Message[] = [
		{
			role: "system",
			content: `Answer in one word.\n${filler(nonce, "Notes", SYSTEM_SENTENCES)}`,
			timestamp: Date.now(),
		},
	];
	const results: Result[] = [];
	for (let turn = 1; turn <= TURNS; turn++) {
		if (variant === "kept") history.push(statusMessage());
		history.push({
			role: "user",
			content: `${filler(nonce, `Turn ${turn}`, TURN_SENTENCES)}\nSay ok.`,
			timestamp: Date.now(),
		});
		const answer = await models.completeSimple(
			model,
			{ messages: placed(history, variant) },
			{ maxTokens: 64, sessionId },
		);
		results.push({
			target,
			variant,
			turn,
			uncached: answer.usage.input,
			read: answer.usage.cacheRead,
			written: answer.usage.cacheWrite,
			...(answer.stopReason === "error" ? { error: answer.errorMessage ?? "failed" } : {}),
		});
		if (answer.stopReason === "error") break;
		history.push(answer);
	}
	return results;
}

/** Two requests `seconds` apart under each retention: does the cache outlive the gap? */
async function gap(models: MutableModels, target: string, retention: "short" | "long", seconds: number) {
	const [provider, ...rest] = target.split("/");
	const model = models.getModel(provider ?? "", rest.join("/"));
	if (model === undefined) throw new Error(`${target} is not a model here`);
	const nonce = randomBytes(8).toString("hex");
	const sessionId = randomUUID();
	const history: Message[] = [
		{
			role: "system",
			content: `Answer in one word.\n${filler(nonce, "Notes", SYSTEM_SENTENCES)}`,
			timestamp: Date.now(),
		},
	];
	const ask = async (turn: number) => {
		history.push({ role: "user", content: `${filler(nonce, `Turn ${turn}`, 40)}\nSay ok.`, timestamp: Date.now() });
		const answer = await models.completeSimple(
			model,
			{ messages: [...history] },
			{ maxTokens: 64, sessionId, cacheRetention: retention },
		);
		history.push(answer);
		return answer;
	};
	await ask(1);
	await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
	const { usage: after, stopReason, errorMessage } = await ask(2);
	const sent = after.input + after.cacheRead + after.cacheWrite;
	return `${target.padEnd(40)}${retention.padEnd(7)}read ${String(after.cacheRead).padStart(7)}  written ${String(after.cacheWrite).padStart(7)}  uncached ${String(after.input).padStart(7)}  share read ${((after.cacheRead / sent) * 100).toFixed(1)}%${stopReason === "error" ? `  ${(errorMessage ?? "failed").slice(0, 80)}` : ""}`;
}

const usage = `Probe a provider's prompt cache with banda's request shape. Spends real tokens (Node 26)
  node scripts/cache-probe.ts --home <fork> --model <provider/id> [--model ...] [--gap <seconds>]
--home must be a fork: npm run home:fork -- --no-volumes
--gap sends two requests that far apart under the 5-minute and the 1-hour cache, instead of the status comparison.`;

async function main() {
	const { values } = parseArgs({
		options: {
			home: { type: "string" },
			model: { type: "string", multiple: true },
			gap: { type: "string" },
			help: { type: "boolean" },
		},
	});
	if (values.help || values.home === undefined || values.model === undefined) return console.log(usage);
	const target = await canonical(values.home);
	for (const live of [resolveHome(), join(homedir(), ".banda")])
		if (target === (await canonical(live))) throw new Error(`${values.home} is the live home. Pass a fork.`);
	const credentials = new FileCredentialStore(values.home);
	const models = builtinModels({ credentials });
	for (const { providerId } of await credentials.list()) registerAccount(models, providerId);
	if (values.gap !== undefined) {
		const seconds = Number(values.gap);
		const runs = values.model.flatMap((model) =>
			(["short", "long"] as const).map((retention) => gap(models, model, retention, seconds)),
		);
		for (const line of await Promise.all(runs)) console.log(line);
		return;
	}
	console.log("target                                 variant turn  uncached    read written  share read");
	for (const model of values.model)
		for (const variant of ["none", "status", "kept"] as const)
			for (const r of await probe(models, model, variant)) {
				const sent = r.uncached + r.read + r.written;
				const share = sent === 0 ? "n/a" : `${((r.read / sent) * 100).toFixed(1)}%`;
				console.log(
					`${r.target.padEnd(40)}${r.variant.padEnd(8)}${String(r.turn).padEnd(4)}${String(r.uncached).padStart(9)}${String(r.read).padStart(8)}${String(r.written).padStart(8)}  ${share}${r.error === undefined ? "" : `  ${r.error.slice(0, 80)}`}`,
				);
			}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
