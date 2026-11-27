/**
 * Micro-spike: a payment effect that checkpoints its signed bytes survives SIGKILL on banda's real effect machinery.
 *
 * The effect (`idempotent`) commits {nonce, raw} to a session doc keyed by its effect key before "broadcasting"
 * (appending the raw bytes to broadcasts.jsonl). A child process is SIGKILLed at a chosen point inside `run`; a second
 * process opens the same home and lets pi-durable resume the tool task. Checked: the owner is not asked again, the
 * bytes broadcast after resuming are the stored ones, one nonce is used, and no second signing happens.
 *
 * Run: node --experimental-strip-types check.ts <repo>
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [repo, role, home, killAt] = process.argv.slice(2) as [string, string?, string?, string?];
if (repo === undefined) throw new Error("usage: check.ts <repo>");

if (role === undefined) {
	// the parent: one scenario per kill point
	let failed = 0;
	for (const point of ["after-checkpoint", "after-broadcast", "after-broadcast-deny"]) {
		const dir = mkdtempSync(join(tmpdir(), "banda-spike-resume-"));
		try {
			const self = fileURLToPath(import.meta.url);
			const flags = ["--experimental-strip-types", "--no-warnings", self, repo];
			const first = spawnSync(process.execPath, [...flags, "first", dir, point], { encoding: "utf8", timeout: 60_000 });
			const second = spawnSync(process.execPath, [...flags, "resume", dir, point], { encoding: "utf8", timeout: 60_000 });
			const summary = JSON.parse(second.stdout.trim().split("\n").at(-1) ?? "{}");
			const raws = summary.broadcasts.map((b: { raw: string }) => b.raw);
			// with a Deny set before resuming, the rerun is refused although the bytes already left: the result says
			// "did not run" for a payment that may land; that is the finding this scenario records
			const ok =
				point === "after-broadcast-deny"
					? first.signal === "SIGKILL" && raws.length === 1 && /did not run/.test(summary.result)
					: first.signal === "SIGKILL" &&
						summary.asks === 0 &&
						summary.ledger.next === 1 &&
						summary.signings === 1 &&
						raws.length === (point === "after-checkpoint" ? 1 : 2) &&
						new Set(raws).size === 1 &&
						raws[0] === summary.ledger.raw;
			if (!ok) failed++;
			console.log(
				`${ok ? "PASS" : "FAIL"} killed ${point}: first exit signal=${first.signal}; after resume ${JSON.stringify({
					asksAfterKill: summary.asks,
					nonceNext: summary.ledger.next,
					signings: summary.signings,
					broadcasts: raws,
					result: summary.result,
				})}`,
			);
			if (!ok) console.log(first.stderr.slice(-800), second.stderr.slice(-800));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
	console.log(failed === 0 ? "ALL PASS" : `${failed} FAILED`);
	process.exit(failed === 0 ? 0 : 1);
}

const load = (path: string) => import(pathToFileURL(join(repo, path)).href);
const { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } = await load(
	"node_modules/@earendil-works/pi-ai/dist/index.js",
);
const { createRegistry, defineDoc, defineExtension } = await load("node_modules/@earendil-works/pi-durable/dist/index.js");
const { BlobStore } = await load("src/core/blobs.ts");
const { OWNER } = await load("src/core/gateway.ts");
const { openWaits, status } = await load("src/core/status.ts");
const { context, openStore } = await load("src/core/store.ts");
const { defineCore, Routes } = await load("src/core/turn.ts");
const { answer, revive } = await load("src/core/wait.ts");
const { answerNudge, FAUX_MODEL } = await load("test/fixtures/models.ts");

const dir = home as string;
const broadcasts = join(dir, "broadcasts.jsonl");
const signings = join(dir, "signings.txt");
const Ledger = defineDoc({
	kind: "spike.ledger",
	version: 1,
	scope: "session",
	initial: () => ({ byKey: {} as Record<string, { raw: string; nonce: number }>, next: 0 }),
	checkpointWhen: () => true,
});
const Refusals = defineDoc({
	kind: "spike.refusals",
	version: 1,
	scope: "session",
	initial: () => ({ deny: {} as Record<string, true> }),
	checkpointWhen: () => true,
});
const core = defineCore({
	blobs: new BlobStore(join(dir, "blobs")),
	gateway: () => ({
		name: "fake",
		strength: "bearer",
		can: { buttons: false, files: false, threads: true },
		start() {},
		async send() {
			return `out-${Math.random()}`;
		},
	}),
	model: () => FAUX_MODEL,
	retryDelay: () => 5,
});
const killOnce = (point: string) => {
	if (role !== "first" || point !== killAt?.replace(/-deny$/, "")) return;
	process.kill(process.pid, "SIGKILL");
};
const pay = core.effect({
	name: "wallet__send",
	description: "pay",
	parameters: Type.Object({ to: Type.String(), amount: Type.String() }),
	effect: "idempotent",
	describe: (a: { to: string; amount: string }) => `Pay ${a.amount} to ${a.to}`,
	permission: { args: ["to"], lasts: ["always"] },
	allowed: async (tx: any, draft: { to: string }) =>
		(await tx.doc(Refusals)).deny[draft.to] === true ? `the owner doesn't pay ${draft.to}` : undefined,
	run: async (a: { to: string; amount: string }, { key, api }: any, ctx: any) => {
		const stored = await api.commit(async (tx: any) => {
			const ledger = await tx.doc(Ledger);
			const kept = ledger.byKey[key];
			// a doc's value is a live overlay that dies with its commit: hand back a copy (as ask.ts:849 does)
			if (kept !== undefined) return JSON.parse(JSON.stringify(kept));
			// signing happens here, once: a real wallet signs outside the commit and stores the bytes first-write-wins
			appendFileSync(signings, "1\n");
			const entry = { raw: `0x02f8…(${a.to},${a.amount},nonce=${ledger.next},${Math.random().toString(16).slice(2, 8)})`, nonce: ledger.next };
			ledger.byKey[key] = entry;
			ledger.next += 1;
			return entry;
		}, ctx);
		killOnce("after-checkpoint");
		appendFileSync(broadcasts, `${JSON.stringify({ raw: stored.raw, key })}\n`);
		killOnce("after-broadcast");
		return { output: [{ type: "text", text: `broadcast ${stored.raw}` }] };
	},
});
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses(
	Array.from({ length: 50 }, () => ((ctx: { messages: readonly { role: string; content: unknown }[] }) => {
		const heed = answerNudge(ctx.messages);
		if (heed !== undefined) return heed;
		const last = ctx.messages.at(-1);
		if (last?.role !== "user") return fauxAssistantMessage("Done.");
		return fauxAssistantMessage([fauxToolCall("wallet__send", { to: "ana", amount: "1" }, { id: "c1" })], {
			stopReason: "toolUse",
		});
	}) as never),
);
const registry = createRegistry();
registry.install(core.extension);
registry.install(defineExtension({ name: "wallet", tools: [pay] }));
const harness = await openStore(dir, { models, registry });
if (role === "resume" && killAt?.endsWith("-deny"))
	await harness.commit(async (tx: any) => {
		(await tx.doc(Refusals)).deny.ana = true;
	}, context);
await revive(harness);
harness.resume();
const web = { gateway: "web", peer: OWNER };
let asks = 0;
const answerAll = async () => {
	for (const wait of await openWaits(harness)) {
		if (wait.ask.type !== "approval") continue;
		asks++;
		await answer(harness, wait.key, "approve", web, "bearer");
	}
};
/** The tool's result entry, once the resumed task settled it. */
const resultText = async () => {
	for (const chat of Object.keys((await harness.snapshot(Routes, context))?.chats ?? {})) {
		const conversation = await harness.conversation(Number(chat), context);
		const page = await conversation.entries({ order: "descending" }, 50, undefined, context);
		const found = page.items.find((e: any) => e.kind === "pi.tool-result" && e.model?.[0]?.toolName === "wallet__send");
		if (found !== undefined) return JSON.stringify(found.model[0].content).slice(0, 120);
	}
	return undefined;
};
const settle = async () => {
	for (let i = 0; i < 2000; i++) {
		await answerAll();
		const { chats } = await status(harness);
		if (role !== "first" && (await resultText()) !== undefined && chats.every((chat: { state: string }) => chat.state === "idle")) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	if (role === "first") process.exit(3); // the kill never landed
};
if (role === "first") {
	await core.receive(harness, { id: "m1", origin: { gateway: "fake", peer: OWNER }, text: "pay ana 1" });
	await settle(); // never returns: the kill lands inside run
} else {
	await settle();
	const ledger = (await harness.snapshot(Ledger, context)) ?? { byKey: {}, next: 0 };
	const [entry] = Object.values(ledger.byKey) as { raw: string }[];
	const lines = existsSync(broadcasts) ? readFileSync(broadcasts, "utf8").split("\n").filter(Boolean) : [];
	const result = (await resultText()) ?? "";
	console.log(
		JSON.stringify({
			asks,
			ledger: { next: ledger.next, raw: entry?.raw },
			signings: existsSync(signings) ? readFileSync(signings, "utf8").split("\n").filter(Boolean).length : 0,
			broadcasts: lines.map((line) => JSON.parse(line)),
			result,
		}),
	);
	await harness.close(context);
}
writeFileSync(join(dir, "done"), "");
