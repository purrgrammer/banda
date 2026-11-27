/**
 * Micro-spike: the three recipient rules on banda's real effect machinery (src/core/ask.ts `effect`/`effectRun`, the
 * Wait, the Permissions doc), imported read-only from the repo with pi-ai's faux model, on a temp home.
 *
 *   Ask    = no permission covers the call: the effect opens a draft (approval Wait).
 *   Always = a permission (scope always) binding `to` only, given with the approval.
 *   Deny   = a stored refusal, checked by the tool's `allowed` hook, which effectRun calls in the same commit that
 *            looks for a covering permission (withinPermission) and again in the commit that starts an approved run.
 *
 * Also: the effect is `idempotent` and checkpoints what it would broadcast in a session doc keyed by the effect key,
 * so a second run with the same key reuses the stored bytes.
 *
 * Run: node --experimental-strip-types check.ts <repo>
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.argv[2];
if (repo === undefined) throw new Error("usage: check.ts <repo>");
const load = (path: string) => import(pathToFileURL(join(repo, path)).href);

const { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } = await load(
	"node_modules/@earendil-works/pi-ai/dist/index.js",
);
const { createRegistry, defineDoc, defineExtension } = await load("node_modules/@earendil-works/pi-durable/dist/index.js");
const { BlobStore } = await load("src/core/blobs.ts");
const { OWNER } = await load("src/core/gateway.ts");
const { Permissions } = await load("src/core/permissions.ts");
const { openWaits } = await load("src/core/status.ts");
const { context, openStore } = await load("src/core/store.ts");
const { defineCore } = await load("src/core/turn.ts");
const { answer, WAIT } = await load("src/core/wait.ts");
const { answerNudge, FAUX_MODEL } = await load("test/fixtures/models.ts");

const home = mkdtempSync(join(tmpdir(), "banda-spike-rules-"));
const runs = join(home, "runs.jsonl");

/** The refusals (Deny), by recipient: the spike's stand-in for a wallet's recipient rules. */
const Refusals = defineDoc({
	kind: "spike.refusals",
	version: 1,
	scope: "session",
	initial: () => ({ deny: {} as Record<string, true> }),
	checkpointWhen: () => true,
});
/** What each effect key signed, written before "broadcast": the checkpoint a rerun reuses. */
const Ledger = defineDoc({
	kind: "spike.ledger",
	version: 1,
	scope: "session",
	initial: () => ({ byKey: {} as Record<string, { raw: string; nonce: number }>, next: 0 }),
	checkpointWhen: () => true,
});

const core = defineCore({
	blobs: new BlobStore(join(home, "blobs")),
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
let signings = 0;
const pay = core.effect({
	name: "wallet__send",
	description: "pay",
	parameters: Type.Object({ to: Type.String(), amount: Type.String() }),
	effect: "idempotent",
	describe: (a: { to: string; amount: string }) => `Pay ${a.amount} to ${a.to}`,
	permission: { args: ["to"], lasts: ["always"], what: (a: { to: string }) => `pay ${a.to}, up to what is in the wallet` },
	allowed: async (tx: any, draft: { to: string }) =>
		(await tx.doc(Refusals)).deny[draft.to] === true ? `the owner doesn't pay ${draft.to}` : undefined,
	run: async (a: { to: string; amount: string }, { key, api }: any, ctx: any) => {
		// checkpoint: nonce and signed bytes stored, keyed by the effect key, before anything leaves
		const stored = await api.commit(async (tx: any) => {
			const ledger = await tx.doc(Ledger);
			if (ledger.byKey[key] !== undefined) return ledger.byKey[key];
			signings++;
			const entry = { raw: `0xsigned(${a.to},${a.amount},n=${ledger.next})`, nonce: ledger.next };
			ledger.byKey[key] = entry;
			ledger.next += 1;
			return entry;
		}, ctx);
		appendFileSync(runs, `${JSON.stringify({ ...a, ...stored, key })}\n`);
		return { output: [{ type: "text", text: `broadcast ${stored.raw}` }] };
	},
});

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const respond = (ctx: { messages: readonly { role: string; content: unknown }[] }) => {
	const heed = answerNudge(ctx.messages);
	if (heed !== undefined) return heed;
	const last = ctx.messages.at(-1);
	if (last?.role !== "user") return fauxAssistantMessage("Done.");
	const [, to, amount] = String(last.content).split(" ");
	return fauxAssistantMessage([fauxToolCall("wallet__send", { to, amount }, { id: `c${to}${amount}` })], {
		stopReason: "toolUse",
	});
};
faux.setResponses(Array.from({ length: 100 }, () => respond as never));
const registry = createRegistry();
registry.install(core.extension);
registry.install(defineExtension({ name: "wallet", tools: [pay] }));
const harness = await openStore(home, { models, registry });
harness.resume();
const web = { gateway: "web", peer: OWNER };

/** Say `pay <to> <amount>`; `onAsk` answers each approval as the owner (and may change rules first). */
async function say(text: string, onAsk: (wait: any) => Promise<void>) {
	const received = await core.receive(harness, { id: text, origin: { gateway: "fake", peer: OWNER }, text });
	const ended = harness.waitForTask(received.turn, context).then(() => true);
	let asks = 0;
	while (!(await Promise.race([ended, new Promise<false>((r) => setTimeout(r, 10, false))]))) {
		for (const wait of await openWaits(harness)) {
			if (wait.ask.type !== "approval") continue;
			asks++;
			await onAsk(wait);
		}
	}
	return { chat: received.chat, asks };
}
const deny = (to: string) =>
	harness.commit(async (tx: any) => {
		(await tx.doc(Refusals)).deny[to] = true;
	}, context);
const ran = () =>
	readFileSync(runs, { encoding: "utf8", flag: "a+" })
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
const lastResult = async (chat: number) => {
	const conversation = await harness.conversation(chat, context);
	const page = await conversation.entries({ order: "descending" }, 50, undefined, context);
	const result = page.items.find((e: any) => e.kind === "pi.tool-result" && e.model?.[0]?.toolName === "wallet__send");
	// the WAIT entries after this chat's newest owner message: the asks this message's run opened
	const since = page.items.findIndex((e: any) => e.kind === "banda.inbound");
	const waits = page.items.slice(0, since).filter((e: any) => e.kind === WAIT).length;
	return { text: JSON.stringify(result?.model?.[0]?.content ?? "").slice(0, 160), waits };
};

let failed = 0;
const check = (name: string, ok: boolean, seen: unknown) => {
	if (!ok) failed++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${typeof seen === "string" ? seen : JSON.stringify(seen)}`);
};

try {
	// 1. Ask: first payment to ana asks; the owner answers "Always pay ana"
	const first = await say("pay ana 1", (wait) =>
		answer(harness, wait.key, "approve", web, "bearer", { approving: { permission: { scope: "always" } } }).then(() => {}),
	);
	check("first payment to an unknown recipient asks", first.asks === 1, `asks=${first.asks}`);
	const permissions = Object.values((await harness.snapshot(Permissions, context))?.permissions ?? {}) as any[];
	check("Always stored as a permission binding `to` only", permissions.length === 1 && JSON.stringify(permissions[0].match) === '{"to":"ana"}', permissions.map((p) => ({ match: p.match, scope: p.scope, agent: p.agent })));

	// 2. Always: another amount to ana runs unasked
	const second = await say("pay ana 250", async () => {
		throw new Error("should not ask");
	});
	check("Always pays the same recipient another amount unasked", second.asks === 0 && ran().some((r) => r.to === "ana" && r.amount === "250"), `asks=${second.asks}`);

	// 3. Deny set ahead: refused in words, no Wait opened
	await deny("bob");
	const third = await say("pay bob 3", async () => {
		throw new Error("should not ask");
	});
	const thirdResult = await lastResult(third.chat);
	check("Deny refuses without asking (no Wait)", third.asks === 0 && thirdResult.waits === 0 && !ran().some((r) => r.to === "bob"), thirdResult);

	// 4. Deny set while the draft waits: the owner's approval cannot start it
	const fourth = await say("pay carol 4", async (wait) => {
		await deny("carol");
		await answer(harness, wait.key, "approve", web, "bearer");
	});
	const fourthResult = await lastResult(fourth.chat);
	check("Deny set while a draft waits refuses the approved run at start", fourth.asks === 1 && !ran().some((r) => r.to === "carol"), fourthResult.text);

	// 5. Deny beats an existing Always (allowed runs before covering, in the same commit)
	await deny("ana");
	const fifth = await say("pay ana 5", async () => {
		throw new Error("should not ask");
	});
	const fifthResult = await lastResult(fifth.chat);
	check("Deny overrides an open Always permission", fifth.asks === 0 && !ran().some((r) => r.to === "ana" && r.amount === "5"), fifthResult.text);

	// 6. Checkpoint: one signing per effect key; the ledger's nonces are distinct and gapless for what ran
	const all = ran();
	const nonces = all.map((r) => r.nonce);
	check("one signing per run, distinct sequential nonces", signings === all.length && new Set(nonces).size === nonces.length, { signings, nonces });
} finally {
	await harness.close(context);
	rmSync(home, { recursive: true, force: true });
}
console.log(failed === 0 ? "ALL PASS" : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
