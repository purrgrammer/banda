/**
 * The process the wallet lifecycle fault suite kills (C15, C21: each of the lifecycle's syncs is a point too). The
 * owner makes the wallet Groceries, which stays, and confirms its saved copy through the signer's `confirm` (a keychain
 * read); and the wallet Travel, skips saving its key, archives it, brings it back, archives it again and removes it.
 * Each step is safe to repeat: every process does them again from the start, finding what is done in the store
 * (Travel's return and removal by their lines in the activity log, which their commits write). The signer runs in this
 * process, over a keystore in a JSON file under the home, so a kill at a keychain point (once the item is written,
 * read or deleted, before anyone hears of it) ends the daemon's side too and loses nothing the keychain kept. Before
 * it does anything, each process checks what the last one left: no wallet ready or archived without its item deriving
 * its address, no item that no wallet names. Every secret a creation's answer carried is kept in a file under the
 * home, so the suite can tell a claimed reveal that some answer carried from one a kill left nobody can spend (C16).
 * Prints a summary as its last line.
 *
 * Funds reach Travel at the balance read numbered `funds` (counted across processes, in a file under the home; 0:
 * never), so a kill also lands around a removal rolled back to archived (C17) and around one that resumes past its
 * delete (H-044); a removal funds refused is left archived.
 *
 * argv: home, funds, fault schedule JSON (Fault[])
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { ActivityLog } from "../../src/core/activity.ts";
import { Connected, WALLET } from "../../src/core/connections.ts";
import { context, syncNow } from "../../src/core/store.ts";
import { installationId } from "../../src/home.ts";
import { type Address, checksummed } from "../../src/wallet/address.ts";
import { Wallets } from "../../src/wallet/docs.ts";
import { signerHome, walletAccount, walletPrefix } from "../../src/wallet/home-id.ts";
import { type FakeState, FileKeystore } from "../../src/wallet/keystore.ts";
import { type LifecycleSigner, openLifecycle, revealDigest, WalletRefused } from "../../src/wallet/lifecycle.ts";
import { addressOf, type Key } from "../../src/wallet/sign.ts";
import { keyDigest, serve } from "../../src/wallet/signer.ts";
import { Request } from "../../src/wallet/signer-protocol.ts";
import { openConnected } from "../fixtures/connected.ts";
import { type Fault, type FaultPoint, Faults } from "./faults.ts";

const [home, fundsAt, scheduleJson] = process.argv.slice(2) as [string, string, string];
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);
const keystorePath = join(home, "keychain.json");
const keystore = new FileKeystore(keystorePath, { hit: (point) => faults.hit(point) });
const violations = join(home, "violations.jsonl");

const s = await openConnected({
	home,
	respond: () => fauxAssistantMessage("Done."),
	wrapStorage: (storage) => faults.storage(storage),
	fault: (point) => faults.hit(point as FaultPoint),
});
const id = await installationId(home);
const at = await signerHome(home);

/** The keychain as the file holds it. */
const items = (): { [account: string]: string } =>
	existsSync(keystorePath) ? (JSON.parse(readFileSync(keystorePath, "utf8")) as FakeState).items : {};
const walletItems = () =>
	Object.entries(items())
		.filter(([account]) => account.startsWith(walletPrefix(id)))
		.map(([account, key]) => ({ address: account.slice(walletPrefix(id).length), key }));
const derives = (key: string, address: string) => {
	try {
		return addressOf(key as Key) === checksummed(address);
	} catch {
		return false;
	}
};

// what the process before this one left
{
	const wallets = (await s.harness.snapshot(Wallets, context))?.wallets ?? {};
	for (const [address, record] of Object.entries(wallets)) {
		if (record.state !== "ready" && record.state !== "archived") continue;
		const key = items()[walletAccount(id, address as Address)];
		if (key === undefined || !derives(key, address))
			appendFileSync(violations, `${JSON.stringify({ ready: address, state: record.state })}\n`);
	}
	for (const item of walletItems())
		if (wallets[item.address] === undefined)
			appendFileSync(violations, `${JSON.stringify({ orphan: item.address })}\n`);
}

/**
 * The signer's calls, run here over the file keystore, as the child would run them. A request the protocol does not
 * accept is this worker's bug, not a refusal: it throws, so a change to the protocol fails the suite loudly instead of
 * every call coming back refused (the child exits on such a request too).
 */
async function ask(body: object, drawn?: (address: Address) => Promise<void>): Promise<never> {
	const request: unknown = { ...body, id: randomBytes(16).toString("hex"), home: at };
	if (!Value.Check(Request, request)) {
		throw new Error(`the worker's signer request does not match the protocol: ${JSON.stringify(body)}`);
	}
	const answer = await serve(request, keystore, async (address) => {
		if (drawn === undefined) return false;
		try {
			await drawn(checksummed(address));
			return true;
		} catch {
			return false;
		}
	});
	if ("step" in answer) return { ok: false, code: "other" } as never;
	return (answer.ok ? { ok: true, ...(answer.result as object) } : { ok: false, code: answer.code }) as never;
}
const signer: LifecycleSigner = {
	lease: (expected) => ask({ op: "lease", expected }),
	leased: () => ask({ op: "leased" }),
	create: (lease, drawn) => ask({ op: "create", lease }, drawn),
	derive: (lease, address) => ask({ op: "derive", lease, address }),
	remove: (lease, address) => ask({ op: "remove", lease, address }),
	find: (lease) => ask({ op: "find", lease }),
};

const life = openLifecycle({
	harness: s.harness,
	signer,
	home: id,
	accounts: s.capabilities,
	funded: async () => {
		const at = Number(fundsAt);
		if (at === 0) return false;
		const reads = join(home, "balance-reads");
		const read = (existsSync(reads) ? Number(readFileSync(reads, "utf8")) : 0) + 1;
		writeFileSync(reads, String(read));
		return read >= at;
	},
	sync: () => syncNow(s.harness, (point) => faults.hit(point)),
	context,
});

/** A step again while the keychain refuses it (a thrown fault there is a keychain that failed once). */
async function retry<T>(step: () => Promise<T>): Promise<T> {
	for (let tries = 0; ; tries++) {
		try {
			return await step();
		} catch (error) {
			if (!(error instanceof WalletRefused) || error.status !== 503 || tries >= 8) throw error;
		}
	}
}
const record = async (address: string) => (await s.harness.snapshot(Wallets, context))?.wallets[address];

await retry(() => life.recover());
/** Every secret an answer to a creation carried, in any process: the client heard it (C16). */
const secretsFile = join(home, "secrets.jsonl");
const heard = <T extends { readonly secret?: string }>(made: T): T => {
	if (made.secret !== undefined) appendFileSync(secretsFile, `${JSON.stringify(made.secret)}\n`);
	return made;
};
const groceries = heard(
	await retry(() => life.create({ request: "request-groceries", name: "Groceries", network: "base-sepolia" })),
);
// the saved copy of Groceries' key, checked by the signer against the keychain's item and confirmed: its retry after
// a refusal not yet safe is the same act, done once on disk (C21)
await retry(async () => {
	if ((await record(groceries.address))?.backup !== "unsaved") return;
	const item = items()[walletAccount(id, groceries.address as Address)];
	if (item === undefined) return;
	const checked = await life.leased<{ matches: boolean }>((lease) =>
		ask({ op: "confirm", lease, address: groceries.address, digest: keyDigest(item) }),
	);
	if (!checked.ok) throw new WalletRefused("the keychain did not answer", 503);
	await life.confirmSaved(groceries.address, checked.matches ? groceries.address : "");
});
const said = async (start: string) =>
	(await s.harness.snapshot(ActivityLog, context))?.events.some((event) => event.what.startsWith(start)) ?? false;
const removed = () => said("You removed the wallet Travel");
if (!(await removed())) {
	const travel = heard(
		await retry(() => life.create({ request: "request-travel", name: "Travel", network: "base-sepolia" })),
	);
	// an act whose commit landed but whose sync failed is refused (C21): its retry is the same act, done
	await retry(async () => {
		if ((await record(travel.address))?.backup === "unsaved") await life.skip(travel.address);
	});
	const archive = () =>
		retry(async () => {
			const ready = await record(travel.address);
			if (ready?.state === "ready") await life.archive(travel.address, ready.version);
		});
	// archived, brought back once, and archived again
	if (!(await said("You brought back the wallet Travel"))) {
		await archive();
		await retry(async () => {
			const archived = await record(travel.address);
			if (archived?.state === "archived") await life.unarchive(travel.address, archived.version);
		});
	}
	await archive();
	const archived = await record(travel.address);
	if (archived !== undefined)
		await retry(async () => life.remove(travel.address, (await record(travel.address))?.version ?? 0)).catch(
			(error: unknown) => {
				if (!(error instanceof WalletRefused) || error.status !== 409 || Number(fundsAt) === 0) throw error;
			},
		);
}

const wallets = (await s.harness.snapshot(Wallets, context))?.wallets ?? {};
const credentials = existsSync(join(home, "auth", "connections", WALLET))
	? readdirSync(join(home, "auth", "connections", WALLET), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort()
	: [];
console.log(
	JSON.stringify({
		groceries: groceries.address,
		wallets: Object.fromEntries(
			Object.entries(wallets).map(([address, r]) => [address, { name: r.name, state: r.state, backup: r.backup }]),
		),
		items: walletItems().map((item) => ({ address: item.address, derives: derives(item.key, item.address) })),
		keys: walletItems().map((item) => item.key),
		accounts: Object.keys((await s.harness.snapshot(Connected, context))?.accounts?.[WALLET] ?? {}).sort(),
		credentials,
		// each wallet's reveal still in its window, claimed or not, and the digests of the secrets any answer carried: a
		// claimed one some answer carried, so a kill between the claim and its answer leaves no reveal nobody can spend
		reveals: Object.fromEntries(
			Object.entries(wallets).flatMap(([address, r]) =>
				r.reveal === undefined ? [] : [[address, { digest: r.reveal.digest ?? null }]],
			),
		),
		heard: existsSync(secretsFile)
			? readFileSync(secretsFile, "utf8")
					.split("\n")
					.filter((line) => line !== "")
					.map((line) => revealDigest(JSON.parse(line) as string))
			: [],
		orphans: (await life.orphans()) ?? (await life.orphans()),
		removed: await removed(),
		violations: existsSync(violations)
			? readFileSync(violations, "utf8")
					.split("\n")
					.filter((line) => line !== "")
					.map((line) => JSON.parse(line) as unknown)
			: [],
		commits: faults.hits("commit:after"),
		points: faults.counts(),
	}),
);
await s.close();
