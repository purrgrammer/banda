/**
 * A wallet's life (src/wallet/lifecycle.ts; UC-01, UC-02, UC-04; C15, C16, C17): `walletStep` and `signingStep` hold
 * every row of docs/wallets/model/transitions.json for the events they answer, read from the file and its guards
 * evaluated over every assignment of the machine's atoms; and the lifecycle, on a store and the wallet connection, with
 * the signer in process on the in-memory keystore (never the OS keychain), makes, archives, brings back and removes
 * wallets in the order C15 fixes, settles what a stopped creation left, says why it cannot sign, and lists orphans
 * without touching them. A random run of acts and keychain faults never leaves a ready wallet without its item, an
 * item no wallet names, or a key in the store.
 */
import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { moveSigning, type WalletDeps } from "../desktop/src/wallets.ts";
import { accountKey, Connected, WALLET } from "../src/core/connections.ts";
import { context } from "../src/core/store.ts";
import { installationId } from "../src/home.ts";
import { type Address, checksummed } from "../src/wallet/address.ts";
import { noteReveal, Payments, type PaymentValue, track, type WalletRecord, Wallets } from "../src/wallet/docs.ts";
import {
	claimLease,
	homeSecretAccount,
	leaseAccount,
	type SignerHome,
	signerHome,
	walletAccount,
	walletPrefix,
} from "../src/wallet/home-id.ts";
import { emptyState, memoryKeystore } from "../src/wallet/keystore.ts";
import {
	type Lifecycle,
	type LifecycleOptions,
	type LifecycleSigner,
	modelOf,
	openLifecycle,
	REVEAL_WINDOW,
	revealDigest,
	type SigningAtoms,
	type SigningEvent,
	type SigningState,
	signingStep,
	type WalletAtoms,
	type WalletEvent,
	type WalletModel,
	WalletRefused,
	walletStep,
} from "../src/wallet/lifecycle.ts";
import { addressOf, generateKey, type Key } from "../src/wallet/sign.ts";
import { Signer } from "../src/wallet/signer-client.ts";
import { HostSigner } from "../src/wallet/signer-host.ts";
import type { SignerCode } from "../src/wallet/signer-protocol.ts";
import { type Connected as Opened, openConnected } from "./fixtures/connected.ts";
import { barriered, type powerCut, type Store, storeText } from "./helpers/home-files.ts";
import { tempHome, until } from "./helpers.ts";
import { pbtRuns } from "./pbt.ts";

type Row = {
	machine: string;
	from: string;
	event: string;
	guard: string;
	to: string;
};
type Machine = { states: string[]; atoms: { [atom: string]: (boolean | string)[] }; defs: { [def: string]: string } };
const MODEL = JSON.parse(readFileSync(new URL("../docs/wallets/model/transitions.json", import.meta.url), "utf8")) as {
	machines: { [name: string]: Machine };
	transitions: Row[];
};

/** A guard of the model, Python, as a JavaScript expression. */
const js = (guard: string) =>
	guard
		.replace(/\bTrue\b/g, "true")
		.replace(/\bFalse\b/g, "false")
		.replace(/\band\b/g, "&&")
		.replace(/\bor\b/g, "||")
		.replace(/\bnot\b/g, "!")
		.replace(/([!=])=/g, "$1==");

/** Every assignment of a machine's atoms, with its defs evaluated. */
function assignments(machine: Machine): { [atom: string]: boolean | string }[] {
	let all: { [atom: string]: boolean | string }[] = [{}];
	for (const [atom, domain] of Object.entries(machine.atoms))
		all = all.flatMap((partial) => domain.map((value) => ({ ...partial, [atom]: value })));
	const atoms = Object.keys(machine.atoms);
	const defs = Object.entries(machine.defs).map(
		([name, expression]) => [name, new Function(...atoms, `return ${js(expression)};`)] as const,
	);
	return all.map((assignment) => {
		const values = atoms.map((atom) => assignment[atom]);
		return { ...assignment, ...Object.fromEntries(defs.map(([name, f]) => [name, f(...values)])) };
	});
}

const WALLET_EVENTS: readonly WalletEvent[] = [
	"create",
	"keychain_write",
	"read_back",
	"restart",
	"confirm_saved",
	"skip_save",
	"archive",
	"unarchive",
	"begin_remove",
	"delete_item",
	"item_gone",
];
/**
 * The wallet's events the routes answer (a reveal, Receive, an agent's read, the code warning): not the lifecycle's.
 */
const ROUTES = ["reveal", "show_receive", "agent_reads_address", "acknowledge_code"];
const SIGNING_EVENTS: readonly SigningEvent[] = [
	"unlock_check",
	"keychain_locks",
	"item_lost",
	"restore_key",
	"lease_moved",
];

function holds(
	machine: "wallet" | "signing",
	events: readonly string[],
	step: (from: string, event: string, a: never) => string | undefined,
) {
	const m = MODEL.machines[machine] as Machine;
	const rows = MODEL.transitions.filter((row) => row.machine === machine);
	const every = assignments(m);
	const atoms = [...Object.keys(m.atoms), ...Object.keys(m.defs)];
	const answered = new Set<string>();
	for (const row of rows) {
		if (!events.includes(row.event)) continue;
		answered.add(`${row.from} ${row.event}`);
		const guard = new Function(...atoms, `return ${js(row.guard)};`);
		let matched = 0;
		for (const a of every) {
			if (!guard(...atoms.map((atom) => a[atom]))) continue;
			matched++;
			expect({ row, a, to: step(row.from, row.event, a as never) }).toEqual({ row, a, to: row.to });
		}
		expect(matched, `${row.from} ${row.event} ${row.guard}`).toBeGreaterThan(0);
	}
	// an event the model does not name from a state is not answered there
	for (const from of m.states)
		for (const event of events) {
			if (answered.has(`${from} ${event}`)) continue;
			for (const a of every) expect(step(from, event, a as never), `${from} ${event}`).toBeUndefined();
		}
	return rows;
}

describe("the model's rows", () => {
	it("walletStep answers every row of the wallet machine, under every assignment its guard admits", () => {
		const rows = holds("wallet", WALLET_EVENTS, walletStep as never);
		expect(new Set(rows.map((row) => row.event))).toEqual(new Set([...WALLET_EVENTS, ...ROUTES]));
	});

	it("signingStep answers every row of the signing machine", () => {
		const rows = holds("signing", SIGNING_EVENTS, signingStep as never);
		expect(new Set(rows.map((row) => row.event))).toEqual(new Set(SIGNING_EVENTS));
	});

	it("a walk through either machine stays in its states, and only the model's ways reach a ready or removed wallet", () => {
		const wallet = MODEL.machines.wallet as Machine;
		const signing = MODEL.machines.signing as Machine;
		const atom = (m: Machine) =>
			fc.record(Object.fromEntries(Object.entries(m.atoms).map(([k, d]) => [k, fc.constantFrom(...d)])));
		fc.assert(
			fc.property(
				fc.array(fc.tuple(fc.constantFrom(...WALLET_EVENTS), atom(wallet)), { maxLength: 30 }),
				fc.array(fc.tuple(fc.constantFrom(...SIGNING_EVENTS), atom(signing)), { maxLength: 30 }),
				(walletWalk, signingWalk) => {
					let at: WalletModel = "none";
					for (const [event, a] of walletWalk) {
						const to = walletStep(at, event, a as unknown as WalletAtoms);
						if (to === undefined) continue;
						expect(wallet.states).toContain(to);
						if (to.startsWith("ready_") && !at.startsWith("ready_") && at !== "archived")
							expect([at, (a as unknown as WalletAtoms).item]).toEqual(["creating", "ours"]);
						if (to === "removing" && at !== "removing") {
							const w = a as unknown as WalletAtoms;
							expect(!w.funds && !w.inflight && (w.saved || !w.address_disclosed)).toBe(true);
						}
						if (to === "removed") expect(at).toBe("removing");
						at = to;
						if (at === "removed" || at === "dropped") break;
					}
					let state: SigningState = "online";
					for (const [event, a] of signingWalk) {
						const to = signingStep(state, event, a as unknown as SigningAtoms);
						if (to === undefined) continue;
						expect(signing.states).toContain(to);
						if (to === "online")
							expect((a as unknown as SigningAtoms).host_mode && event === "unlock_check").toBe(false);
						state = to;
					}
				},
			),
			{ numRuns: pbtRuns(200) },
		);
	});
});

// ---- the lifecycle on a store

const opened: Opened[] = [];
const signers: Signer[] = [];
afterEach(async () => {
	for (const signer of signers.splice(0)) signer.stop();
	for (const s of opened.splice(0)) await s.close();
	memoryKeystore().state = emptyState();
	memoryKeystore().hit = undefined;
});

const ENV = { ...process.env, BANDA_TEST_KEYSTORE: "1" };
const keys = () => memoryKeystore().state;

type World = {
	s: Opened;
	id: string;
	signerAt: SignerHome;
	life: Lifecycle;
	funded: { value: boolean | undefined };
	host: { value: boolean };
	open(options?: Opening): Lifecycle;
};

type Opening = {
	binding?: string;
	deadline?: number;
	/** The signer's calls the lifecycle makes, over the real signer's. */
	signer?: (signer: Signer) => Partial<LifecycleSigner>;
	with?: Partial<LifecycleOptions>;
};

const calls = (signer: Signer): LifecycleSigner => ({
	lease: (expected) => signer.lease(expected),
	leased: () => signer.leased(),
	create: (lease, drawn) => signer.create(lease, drawn),
	derive: (lease, address) => signer.derive(lease, address),
	remove: (lease, address) => signer.remove(lease, address),
	find: (lease) => signer.find(lease),
});

async function world(): Promise<World> {
	memoryKeystore().state = emptyState();
	const home = await tempHome();
	const s = await openConnected({ home, respond: () => fauxAssistantMessage("Done.") });
	opened.push(s);
	const id = await installationId(home);
	const signerAt = await signerHome(home);
	const funded = { value: false as boolean | undefined };
	const host = { value: false };
	const open = (options: Opening = {}) => {
		const signer = new Signer(
			{ ...signerAt, ...(options.binding === undefined ? {} : { binding: options.binding }) },
			{ env: ENV, deadline: options.deadline ?? 10_000 },
		);
		signers.push(signer);
		return openLifecycle({
			harness: s.harness,
			signer: { ...calls(signer), ...options.signer?.(signer) },
			home: id,
			accounts: s.capabilities,
			funded: async () => funded.value,
			host: () => host.value,
			context,
			...options.with,
		});
	};
	return { s, id, signerAt, life: open(), funded, host, open };
}

let requests = 0;
const request = () => `request-${process.pid}-${++requests}`;
const make = (w: World, name = "Groceries") => w.life.create({ request: request(), name, network: "base-sepolia" });

const records = async (w: World) => (await w.s.harness.snapshot(Wallets, context))?.wallets ?? {};
const accountsOf = async (w: World) =>
	Object.keys((await w.s.harness.snapshot(Connected, context))?.accounts?.[WALLET] ?? {}).sort();
const items = (w: World) =>
	Object.keys(keys().items)
		.filter((account) => account.startsWith(walletPrefix(w.id)))
		.map((account) => account.slice(walletPrefix(w.id).length))
		.sort();
const refused = async (promise: Promise<unknown>) => {
	const error = await promise.then(
		() => undefined,
		(e: unknown) => e,
	);
	if (!(error instanceof WalletRefused)) throw new Error(`expected a refusal, got ${String(error)}`);
	return error;
};

const locked = (point: "keychain:read" | "keychain:write" | "keychain:delete", times?: number) =>
	keys().faults.push({ point, throw: "keychain is locked", ...(times === undefined ? {} : { times }) });

describe("creating a wallet (UC-01, C15)", () => {
	it("makes a ready wallet, not backed up, with its item read back and an account on for no agent", async () => {
		const w = await world();
		const before = Date.now();
		const { address, record } = await make(w);
		expect(modelOf(record)).toBe("ready_unsaved");
		expect(record.reveal?.expires).toBeGreaterThanOrEqual(before + REVEAL_WINDOW);
		expect(items(w)).toEqual([address]);
		const key = keys().items[walletAccount(w.id, address as Address)] as Key;
		expect(addressOf(key)).toBe(address);
		expect(await accountsOf(w)).toEqual([accountKey(address)]);
		expect((await w.s.harness.snapshot(Connected, context))?.on ?? {}).toEqual({});
		expect((await w.s.harness.snapshot(Wallets, context))?.lease).toBe(1);
		// the order of C15: the item read empty, written, read back; never overwritten
		const calls = keys().calls.filter((call) => call.account === walletAccount(w.id, address as Address));
		expect(calls.slice(0, 3).map((call) => call.op)).toEqual(["read", "write", "read"]);
		expect(calls.filter((call) => call.op === "write")).toHaveLength(1);
		expect(storeText(w.s.home).includes(key.slice(2))).toBe(false);
	});

	it("the same request again is the same wallet, one item (C14, H-007)", async () => {
		const w = await world();
		const asked = { request: request(), name: "Groceries", network: "base-sepolia" as const };
		const [one, two] = await Promise.all([w.life.create(asked), w.life.create(asked)]);
		expect(two.address).toBe(one.address);
		expect((await w.life.create(asked)).address).toBe(one.address);
		expect(items(w)).toEqual([one.address]);
		expect(Object.keys(await records(w))).toEqual([one.address]);
	});

	it("the same request asking another name or network is refused, naming the wallet it made (C14, OD-9, H-040)", async () => {
		const w = await world();
		const asked = { request: request(), name: "Groceries", network: "base-sepolia" as const };
		const [one, racing] = await Promise.all([
			w.life.create(asked),
			w.life.create({ ...asked, network: "base" }).then(
				() => undefined,
				(error: unknown) => error,
			),
		]);
		expect(racing).toMatchObject({ status: 409 });
		for (const other of [
			{ ...asked, network: "base" as const },
			{ ...asked, name: "Travel" },
		]) {
			const refused = await w.life.create(other).then(
				() => undefined,
				(error: unknown) => error as WalletRefused,
			);
			expect(refused).toBeInstanceOf(WalletRefused);
			expect(refused?.status).toBe(409);
			expect(refused?.message).toContain(`Groceries (${one.address.slice(0, 6)}`);
			expect(refused?.message).toContain("Base Sepolia");
		}
		const kept = (await records(w))[one.address];
		expect([kept?.name, kept?.network]).toEqual(["Groceries", "base-sepolia"]);
		expect(items(w)).toEqual([one.address]);
		expect((await w.life.create(asked)).address).toBe(one.address);
	});

	it("the same request again while the first is writing waits on it: one wallet, one item (C14, H-007)", async () => {
		const w = await world();
		const asked = { request: request(), name: "Groceries", network: "base-sepolia" as const };
		let second: Promise<{ address: string }> | undefined;
		const life: Lifecycle = w.open({
			signer: (signer) => ({
				create: (lease, drawn) =>
					signer.create(lease, async (address) => {
						await drawn(address);
						expect(modelOf((await records(w))[address])).toBe("creating");
						expect(items(w)).toEqual([]);
						second = life.create(asked);
					}),
			}),
		});
		const one = await life.create(asked);
		expect((await second)?.address).toBe(one.address);
		expect(items(w)).toEqual([one.address]);
		expect(modelOf((await records(w))[one.address])).toBe("ready_unsaved");
	});

	it("another lifecycle that settles a creation while its write is under way reads it after the write (C15)", async () => {
		const w = await world();
		const asked = { request: request(), name: "Groceries", network: "base-sepolia" as const };
		let derived = false;
		const other = w.open({
			signer: (signer) => ({
				derive: (lease, address) => {
					derived = true;
					return signer.derive(lease, address);
				},
			}),
		});
		let second: Promise<{ address: string }> | undefined;
		const life = w.open({
			signer: (signer) => ({
				create: (lease, drawn) =>
					signer.create(lease, async (address) => {
						await drawn(address);
						second = other.create(asked);
						// the settle's read is asked for before the write: the signer answers it after the write
						await until(() => derived);
						expect(items(w)).toEqual([]);
					}),
			}),
		});
		const one = await life.create(asked);
		expect((await second)?.address).toBe(one.address);
		expect(items(w)).toEqual([one.address]);
		expect(modelOf((await records(w))[one.address])).toBe("ready_unsaved");
	});

	it("two requests make two wallets, two items (UC-01 A2)", async () => {
		const w = await world();
		const [one, two] = await Promise.all([make(w, "One"), make(w, "Two")]);
		expect(one.address).not.toBe(two.address);
		expect(items(w)).toEqual([one.address, two.address].sort());
	});

	it("refuses a nameless wallet, a network banda does not offer, and a request without its id", async () => {
		const w = await world();
		expect((await refused(w.life.create({ request: request(), name: " ​ ", network: "base-sepolia" }))).status).toBe(
			400,
		);
		expect((await refused(w.life.create({ request: request(), name: "A", network: "nowhere" as never }))).status).toBe(
			400,
		);
		expect((await refused(w.life.create({ request: "x", name: "A", network: "base-sepolia" }))).status).toBe(400);
		expect(await records(w)).toEqual({});
	});

	it("stays creating while the keychain cannot write, then is dropped once it answers with nothing (E1, E4)", async () => {
		const w = await world();
		await make(w, "First");
		locked("keychain:write");
		const error = await refused(make(w, "Second"));
		expect([error.status, error.code]).toEqual([503, "locked"]);
		const creating = Object.entries(await records(w)).filter(([, record]) => record.state === "creating");
		expect(creating).toHaveLength(1);
		const [address] = creating[0] as [string, unknown];
		expect(await accountsOf(w)).not.toContain(accountKey(address));
		keys().faults = [];
		await w.life.recover();
		expect((await records(w))[address]).toBeUndefined();
		expect(items(w)).toHaveLength(1);
	});

	it("says nothing was made, never that the keychain failed, when the creating commit fails after the draw", async () => {
		const w = await world();
		const first = await make(w, "First");
		const collides = w.open({
			signer: (signer) => ({
				create: (lease, drawn) => signer.create(lease, () => drawn(first.address as Address)),
			}),
		});
		const error = await refused(collides.create({ request: request(), name: "Second", network: "base-sepolia" }));
		expect([error.status, error.code]).toEqual([503, undefined]);
		expect(error.message).toMatch(/nothing was made, try again/);
		expect(error.message).not.toMatch(/keychain/);
		expect(Object.values(await records(w)).map((record) => record.name)).toEqual(["First"]);
		expect(items(w)).toEqual([checksummed(first.address)]);
	});

	it("drops the record when an item is already there, and never overwrites it (E2, H-024)", async () => {
		const w = await world();
		await make(w, "First");
		keys().faults.push({ point: "keychain:read", account: "/wallet/", answer: generateKey(), times: 1 });
		const before = keys().calls.length;
		expect((await refused(make(w, "Second"))).message).toMatch(/nothing was made/);
		expect(Object.values(await records(w)).map((record) => record.name)).toEqual(["First"]);
		const after = keys().calls.slice(before);
		expect(after.filter((call) => call.op === "write" && call.account.includes("/wallet/"))).toEqual([]);
	});

	it("drops the record when the read-back is not the key, and lists the item as an orphan, never deleted (E3, H-045)", async () => {
		const w = await world();
		keys().faults.push({ point: "keychain:read", account: "/wallet/", answer: null, times: 3 });
		expect((await refused(make(w))).message).toMatch(/nothing was made/);
		expect(await records(w)).toEqual({});
		const orphans = await w.life.orphans();
		expect(orphans).toHaveLength(1);
		expect(items(w)).toEqual(orphans);
		await w.life.recover();
		expect(items(w)).toEqual(orphans);
		expect(keys().calls.some((call) => call.op === "remove" && call.account.includes("/wallet/"))).toBe(false);
	});

	it("answers no listing, never 'no orphan', when the keychain cannot list its items, and recovery deletes nothing (H-045)", async () => {
		const w = await world();
		keys().faults.push({ point: "keychain:read", account: "/wallet/", answer: null, times: 3 });
		await refused(make(w));
		const kept = items(w);
		expect(kept).toHaveLength(1);
		keys().faults.push({ point: "keychain:read", account: walletPrefix(w.id), throw: "keychain is locked", times: 1 });
		const before = keys().calls.length;
		expect(await w.life.orphans()).toBeUndefined();
		// the lease is read first, then the listing: nothing is written or deleted
		expect(
			keys()
				.calls.slice(before)
				.map((call) => call.op)
				.filter((op) => op !== "read"),
		).toEqual(["find"]);
		const life = w.open({ signer: () => ({ find: async () => ({ ok: false as const, code: "locked" as const }) }) });
		expect(await life.orphans()).toBeUndefined();
		await life.recover();
		expect(items(w)).toEqual(kept);
		expect(keys().calls.some((call) => call.op === "remove" && call.account.includes("/wallet/"))).toBe(false);
	});

	it("a ready wallet whose account a kill kept from it joins the wallet connection at recovery", async () => {
		const w = await world();
		const { address } = await make(w);
		expect(await w.s.capabilities.removeWallet(address, async () => true)).toBe(true);
		expect(await accountsOf(w)).toEqual([]);
		await w.life.recover();
		expect(await accountsOf(w)).toEqual([accountKey(address)]);
	});
});

describe("syncing what the owner is told of (C21)", () => {
	it("joins the account of a wallet whose ready commit did not sync, and the same request again carries the secret", async () => {
		const w = await world();
		const asked = { request: request(), name: "Groceries", network: "base-sepolia" as const };
		// the creating commit syncs, the ready one does not
		let calls = 0;
		const first = w.open({
			with: {
				sync: async () => {
					calls++;
					if (calls === 2) throw new Error("busy");
				},
			},
		});
		const error = await refused(first.create(asked));
		expect(error).toMatchObject({ status: 503, code: "unsynced" });
		const [address] = Object.keys(await records(w));
		expect(modelOf((await records(w))[address as string])).toBe("ready_unsaved");
		expect(await accountsOf(w)).toEqual([accountKey(address as string)]);
		// the call that drew the key carried no secret: the same request again, once synced, is the one answer that does
		const again = await first.create(asked);
		expect(again.address).toBe(address);
		expect(again.secret).toEqual(expect.any(String));
		expect((await records(w))[address as string]?.reveal?.digest).toBe(revealDigest(again.secret as string));
		expect((await first.create(asked)).secret).toBeUndefined();
		// a restart cannot tell whether that answer went: its first repeat claims anew, and the secret before stops
		// spending, so still one secret does (C16, H-268); every repeat after it in that process carries none
		const restarted = w.open();
		const anew = await restarted.create(asked);
		expect(anew.secret).toEqual(expect.any(String));
		expect(anew.secret).not.toBe(again.secret);
		expect((await records(w))[address as string]?.reveal?.digest).toBe(revealDigest(anew.secret as string));
		expect((await restarted.create(asked)).secret).toBeUndefined();
	});

	it("claims again after a restart that came between the claim's commit and its answer (C16, H-268)", async () => {
		const w = await world();
		const asked = { request: request(), name: "Groceries", network: "base-sepolia" as const };
		// the third sync, the claim's barrier, never returns: the process is killed there, and its answer never goes
		let calls = 0;
		let parked = false;
		const first = w.open({
			with: {
				sync: async () => {
					calls++;
					if (calls === 3) {
						parked = true;
						await new Promise(() => {});
					}
				},
			},
		});
		void first.create(asked);
		await until(() => parked);
		const [address] = Object.keys(await records(w));
		const left = (await records(w))[address as string]?.reveal?.digest;
		expect(left).toEqual(expect.any(String));
		// the restart: the owner's repeat carries a secret, the one the store now keeps the digest of
		const again = await w.open().create(asked);
		expect(again.secret).toEqual(expect.any(String));
		const digest = (await records(w))[address as string]?.reveal?.digest;
		expect(digest).toBe(revealDigest(again.secret as string));
		expect(digest).not.toBe(left);
	});

	it("carries the secret in the first answer that finds the creation ready, whoever drew its key, and only once (C16)", async () => {
		const w = await world();
		const asked = { request: request(), name: "Groceries", network: "base-sepolia" as const };
		// the keychain kept the key but does not answer the read-back: the creation waits, its answer carries nothing
		keys().faults.push(
			{ point: "keychain:read", account: "/wallet/", answer: null, times: 1 },
			{ point: "keychain:read", account: "/wallet/", throw: "User interaction is not allowed." },
		);
		expect((await refused(w.life.create(asked))).status).toBe(503);
		const [address] = Object.keys(await records(w));
		expect(modelOf((await records(w))[address as string])).toBe("creating");
		// the keychain answers by a restart, which settles it ready: the reveal is still unclaimed
		keys().faults.splice(0);
		await w.open().recover();
		expect((await records(w))[address as string]?.reveal).toEqual({ expires: expect.any(Number) });
		// a paired device's answer claims none; the computer's next one carries it, and no answer after does
		expect((await w.open().create({ ...asked, device: true })).secret).toBeUndefined();
		const settled = w.open();
		const carried = await settled.create(asked);
		expect(carried.secret).toEqual(expect.any(String));
		expect((await settled.create(asked)).secret).toBeUndefined();
		expect((await settled.create({ ...asked, device: true })).secret).toBeUndefined();
	});

	it("grants a paired device's creation no reveal, so no later answer from the computer carries one (H-264)", async () => {
		const w = await world();
		const asked = { request: request(), name: "Groceries", network: "base-sepolia" as const };
		let calls = 0;
		// the ready commit of the phone's creation does not sync
		const life = w.open({
			with: {
				sync: async () => {
					calls++;
					if (calls === 2) throw new Error("busy");
				},
			},
		});
		expect((await refused(life.create({ ...asked, device: true }))).code).toBe("unsynced");
		const [address] = Object.keys(await records(w));
		expect((await records(w))[address as string]).toMatchObject({ state: "ready", device: true });
		expect((await records(w))[address as string]?.reveal).toBeUndefined();
		expect((await life.create(asked)).secret).toBeUndefined();
		expect((await w.open().create(asked)).secret).toBeUndefined();
	});

	it("refuses saving an archived wallet's key, or skipping it, in words that say to bring it back first (H-273)", async () => {
		const w = await world();
		const made = await w.life.create({ request: request(), name: "Groceries", network: "base-sepolia" });
		await w.life.archive(made.address, made.record.version);
		for (const act of [() => w.life.skip(made.address), () => w.life.confirmSaved(made.address, made.address)]) {
			const error = await refused(act());
			expect(error.status).toBe(409);
			expect(error.message).toBe("the wallet is archived: bring it back first, and save its key from there");
		}
		expect((await records(w))[made.address]).toMatchObject({ state: "archived", backup: "unsaved" });
	});

	it("takes the claim back when it could not be synced, so the same request again carries the secret", async () => {
		const w = await world();
		const asked = { request: request(), name: "Groceries", network: "base-sepolia" as const };
		let calls = 0;
		// the creating and ready commits sync, the claim does not
		const life = w.open({
			with: {
				sync: async () => {
					calls++;
					if (calls === 3) throw new Error("busy");
				},
			},
		});
		expect((await refused(life.create(asked))).code).toBe("unsynced");
		const [address] = Object.keys(await records(w));
		expect((await records(w))[address as string]?.reveal?.digest).toBeUndefined();
		expect((await life.create(asked)).secret).toEqual(expect.any(String));
	});

	it("answers an owner's act whose commit did not sync as not yet safe, and its retry done once a barrier passed (C21)", async () => {
		const w = await world();
		const barrier = barriered(w.s.home, w.s.harness);
		/** The n-th sync from now fails; every other is the store's own barrier. */
		let calls = 0;
		let at = 0;
		const fail = (n = 1) => {
			at = calls + n;
		};
		const life = w.open({
			with: {
				sync: async () => {
					calls++;
					if (calls === at) throw new Error("busy");
					await barrier.sync();
				},
			},
		});
		const onDisk = async (address: string) =>
			barrier.cut()(async (store) => (await store.snapshot(Wallets, context))?.wallets[address]);
		const { address, record } = await make(w);
		await barrier.sync();
		// archived, not yet safe: a cut now undoes it, and the retry with the same version is the same act, done
		fail();
		expect(await refused(life.archive(address, record.version))).toMatchObject({ status: 503, code: "unsynced" });
		expect(modelOf(await onDisk(address))).toBe("ready_unsaved");
		const archived = await life.archive(address, record.version);
		expect(modelOf(archived)).toBe("archived");
		expect(modelOf(await onDisk(address))).toBe("archived");
		// the same for bringing it back
		fail();
		expect((await refused(life.unarchive(address, archived.version))).code).toBe("unsynced");
		expect(modelOf(await onDisk(address))).toBe("archived");
		expect(modelOf(await life.unarchive(address, archived.version))).toBe("ready_skipped");
		expect(modelOf(await onDisk(address))).toBe("ready_skipped");
		// a stale version still refuses: only the act's own retry is done
		expect((await refused(life.archive(address, record.version))).status).toBe(409);
		// a retry is the same act whatever moved the version between: here a disclosure (Receive, an agent's read) and a
		// reveal, after the archive's and the unarchive's not-yet-safe answers
		const bump = (change: (wallet: WalletRecord) => void) =>
			w.s.harness.commit(async (tx) => {
				const wallet = (await tx.doc(Wallets)).wallets[address];
				if (wallet === undefined) throw new Error("no wallet");
				change(wallet);
				wallet.version++;
			}, context);
		const ready = (await records(w))[address];
		if (ready === undefined) throw new Error("no wallet");
		fail();
		expect((await refused(life.archive(address, ready.version))).code).toBe("unsynced");
		await bump((wallet) => noteReveal(wallet, 1, "later"));
		expect(modelOf(await life.archive(address, ready.version))).toBe("archived");
		const shelved = (await records(w))[address];
		if (shelved === undefined) throw new Error("no wallet");
		fail();
		expect((await refused(life.unarchive(address, shelved.version))).code).toBe("unsynced");
		await bump((wallet) => {
			wallet.disclosed = true;
		});
		expect(modelOf(await life.unarchive(address, shelved.version))).toBe("ready_skipped");
		expect(modelOf(await onDisk(address))).toBe("ready_skipped");
		// and only that act: the other one, at the version it asked, is still stale
		expect((await refused(life.archive(address, shelved.version))).status).toBe(409);
		// skipping, and confirming the saved copy
		const two = await make(w, "Two");
		await barrier.sync();
		fail();
		expect((await refused(life.skip(two.address))).code).toBe("unsynced");
		expect(modelOf(await life.skip(two.address))).toBe("ready_skipped");
		expect(modelOf(await onDisk(two.address))).toBe("ready_skipped");
		fail();
		expect((await refused(life.confirmSaved(two.address, two.address.toLowerCase()))).code).toBe("unsynced");
		expect(modelOf(await onDisk(two.address))).toBe("ready_skipped");
		expect(modelOf(await life.confirmSaved(two.address, two.address.toLowerCase()))).toBe("ready_saved");
		expect(modelOf(await onDisk(two.address))).toBe("ready_saved");
		// removed, its last commit not yet safe: the retry finds it gone by this act, and is done once on disk
		const now = (await records(w))[two.address] as WalletRecord;
		fail(3);
		expect((await refused(life.remove(two.address, now.version))).code).toBe("unsynced");
		expect((await onDisk(two.address))?.state).toBe("removing");
		await life.remove(two.address, now.version);
		expect(await onDisk(two.address)).toBeUndefined();
		// a wallet no removal took is still no such wallet
		expect((await refused(life.remove(addressOf(generateKey()), 1))).status).toBe(404);
		// the same across a restart: a lifecycle that never saw the removal knows it from the store, and makes it safe
		const three = await make(w, "Three");
		await barrier.sync();
		const before = (await records(w))[three.address] as WalletRecord;
		fail(3);
		expect((await refused(life.remove(three.address, before.version))).code).toBe("unsynced");
		expect((await onDisk(three.address))?.state).toBe("removing");
		const restarted = w.open({ with: { sync: () => barrier.sync() } });
		await restarted.remove(three.address, before.version);
		expect(await onDisk(three.address)).toBeUndefined();
		expect((await records(w))[three.address]).toBeUndefined();
	});

	it("answers a removal its re-check kept as not yet safe until the archive is on disk, never as kept (C21)", async () => {
		const w = await world();
		const { address, record } = await make(w);
		let fail = false;
		const life = w.open({
			with: {
				sync: async () => {
					if (fail) throw new Error("busy");
				},
			},
		});
		// the delete is stopped, so the removal waits `removing`; the re-check then cannot read the balance
		locked("keychain:delete", 1);
		await refused(life.remove(address, record.version));
		const removing = (await records(w))[address] as WalletRecord;
		expect(removing.state).toBe("removing");
		w.funded.value = undefined;
		fail = true;
		expect(await refused(life.remove(address, removing.version))).toMatchObject({ status: 503, code: "unsynced" });
		expect(modelOf((await records(w))[address])).toBe("archived");
		expect(items(w)).toEqual([address]);
		fail = false;
	});

	it("answers a creation the keychain dropped once the drop is on disk (C21)", async () => {
		const w = await world();
		let calls = 0;
		const life = w.open({
			with: {
				sync: async () => {
					calls++;
					if (calls === 2) throw new Error("busy");
				},
			},
		});
		// the read-back finds another key where the wallet's was written: the creation is dropped
		keys().faults.push({ point: "keychain:read", account: "/wallet/", answer: `0x${"11".repeat(32)}`, times: 1 });
		const asked = { request: request(), name: "Groceries", network: "base-sepolia" as const };
		expect(await refused(life.create(asked))).toMatchObject({ status: 503, code: "unsynced" });
		expect(await records(w)).toEqual({});
	});
});

describe("what a power cut leaves on disk (C21)", () => {
	/**
	 * A lifecycle whose sync is the store's own barrier, and the store as a cut at the keychain's `point` on a wallet
	 * leaves it: only what the last barrier before that effect flushed.
	 */
	const cutting = (w: World, point: "keychain:write" | "keychain:delete") => {
		const barrier = barriered(w.s.home, w.s.harness);
		const cuts: ReturnType<typeof powerCut>[] = [];
		memoryKeystore().hit = (at) => {
			const last = keys().calls.at(-1);
			if (at === point && last?.account.startsWith(walletPrefix(w.id))) cuts.push(barrier.cut());
		};
		const life = w.open({ with: { sync: barrier.sync } });
		const after = <T>(read: (store: Store) => Promise<T>) => {
			const cut = cuts[0];
			if (cut === undefined) throw new Error(`no ${point} on a wallet's item`);
			return cut(read);
		};
		return { life, after };
	};
	const onDisk = (address: string) => async (store: Store) =>
		(await store.snapshot(Wallets, context))?.wallets[address];
	afterEach(() => {
		memoryKeystore().hit = undefined;
	});

	it("has the wallet `creating` in the database before its key is written, so a cut leaves no key no wallet names", async () => {
		const w = await world();
		const { life, after } = cutting(w, "keychain:write");
		const { address } = await life.create({ request: request(), name: "Groceries", network: "base-sepolia" });
		expect((await after(onDisk(address)))?.state).toBe("creating");
	});

	it("has the wallet `removing` in the database before its key is deleted, so a cut leaves no wallet without its key", async () => {
		const w = await world();
		const { address, record } = await make(w);
		const { life, after } = cutting(w, "keychain:delete");
		await life.remove(address, record.version);
		expect((await after(onDisk(address)))?.state).toBe("removing");
	});

	it("has what the owner did in the database itself once it is answered: saved, skipped, archived, back", async () => {
		const w = await world();
		const barrier = barriered(w.s.home, w.s.harness);
		const life = w.open({ with: { sync: barrier.sync } });
		// a cut once each is answered keeps only what a barrier flushed before the answer
		const cut = async (address: string) => barrier.cut()(onDisk(address));
		const one = await make(w, "One");
		await life.confirmSaved(one.address, one.address.toLowerCase());
		expect(modelOf(await cut(one.address))).toBe("ready_saved");
		const two = await make(w, "Two");
		await life.skip(two.address);
		expect(modelOf(await cut(two.address))).toBe("ready_skipped");
		const archived = await life.archive(two.address, (await cut(two.address))?.version ?? 0);
		expect(modelOf(await cut(two.address))).toBe("archived");
		await life.unarchive(two.address, archived.version);
		expect(modelOf(await cut(two.address))).toBe("ready_skipped");
	});
});

describe("saving, archiving and bringing back (UC-02, C8, C17)", () => {
	it("skips saving, confirms a key that derives the address, and refuses one that does not", async () => {
		const w = await world();
		const one = await make(w, "One");
		expect((await refused(w.life.confirmSaved(one.address, addressOf(generateKey())))).message).toMatch(
			/does not open/,
		);
		expect(modelOf(await w.life.confirmSaved(one.address, one.address.toLowerCase()))).toBe("ready_saved");
		expect((await refused(w.life.skip(one.address))).status).toBe(409);
		const two = await make(w, "Two");
		expect(modelOf(await w.life.skip(two.address))).toBe("ready_skipped");
	});

	it("backs up a wallet whose save was skipped once a later paste-back matches, and keeps a wrong one Not backed up (H-266)", async () => {
		const w = await world();
		const { address } = await make(w);
		await w.life.skip(address);
		await w.s.harness.commit(async (tx) => {
			const wallet = (await tx.doc(Wallets)).wallets[address];
			if (wallet !== undefined) wallet.disclosed = true;
		}, context);
		expect((await refused(w.life.confirmSaved(address, addressOf(generateKey())))).message).toMatch(/does not open/);
		expect(modelOf((await records(w))[address])).toBe("ready_skipped");
		const saved = await w.life.confirmSaved(address, address.toLowerCase());
		expect(modelOf(saved)).toBe("ready_saved");
		// the address left banda, and the proven copy makes it removable again
		await w.life.remove(address, saved.version);
		expect(items(w)).toEqual([]);
	});

	it("archives on the version the owner saw, refuses a stale one, and comes back backed up or not", async () => {
		const w = await world();
		const { address, record } = await make(w);
		const archived = await w.life.archive(address, record.version);
		expect(modelOf(archived)).toBe("archived");
		expect(archived.reveal).toBeUndefined();
		expect((await refused(w.life.unarchive(address, record.version))).message).toMatch(/changed/);
		expect(modelOf(await w.life.unarchive(address, archived.version))).toBe("ready_skipped");
		const again = (await records(w))[address];
		expect((await refused(w.life.unarchive(address, again?.version ?? 0))).status).toBe(409);
	});

	it("refuses what the wallet had not signed yet in the commit that archives it", async () => {
		const w = await world();
		const { address, record } = await make(w);
		const payment = (state: PaymentValue["state"]): PaymentValue => ({
			by: "owner",
			wallet: address,
			to: `address:base-sepolia:${addressOf(generateKey())}`,
			amount: "1",
			asset: "native",
			reserve: "0",
			state,
			versions: [],
			version: 1,
			at: 1,
		});
		await w.s.harness.commit(async (tx) => {
			const wallets = await tx.doc(Wallets);
			for (const [id, state] of [
				["p1", "Waiting"],
				["p2", "Queued"],
				["p3", "Sent"],
			] as const) {
				await tx.doc(Payments, id, payment(state));
				track(wallets, id, { wallet: address, state }, "new");
			}
		}, context);
		await w.life.archive(address, record.version);
		const states = await Promise.all(
			["p1", "p2", "p3"].map(async (id) => (await w.s.harness.snapshot(Payments, id, context))?.state),
		);
		expect(states).toEqual(["Refused", "Refused", "Sent"]);
		expect((await w.s.harness.snapshot(Wallets, context))?.open[address]).toEqual(["p3"]);
	});
});

describe("removing a wallet (C15, C17)", () => {
	it("removes the item, then the wallet and its account", async () => {
		const w = await world();
		const { address, record } = await make(w);
		await w.life.remove(address, record.version);
		expect(await records(w)).toEqual({});
		expect(items(w)).toEqual([]);
		expect(await accountsOf(w)).toEqual([]);
		expect(await w.life.orphans()).toEqual([]);
	});

	it("refuses while it holds funds, while a payment is open, when the balance cannot be read, or on a stale version", async () => {
		const w = await world();
		const { address, record } = await make(w);
		w.funded.value = true;
		expect((await refused(w.life.remove(address, record.version))).message).toMatch(/funds/);
		w.funded.value = undefined;
		expect((await refused(w.life.remove(address, record.version))).status).toBe(503);
		w.funded.value = false;
		expect((await refused(w.life.remove(address, record.version - 1))).message).toMatch(/changed/);
		await w.s.harness.commit(async (tx) => {
			(await tx.doc(Wallets)).open[address] = ["p1"];
		}, context);
		expect((await refused(w.life.remove(address, record.version))).message).toMatch(/payment/);
		expect(items(w)).toEqual([address]);
	});

	it("refuses an address that left banda while its key was never saved", async () => {
		const w = await world();
		const { address, record } = await make(w);
		await w.s.harness.commit(async (tx) => {
			const wallet = (await tx.doc(Wallets)).wallets[address];
			if (wallet !== undefined) wallet.disclosed = true;
		}, context);
		expect((await refused(w.life.remove(address, record.version))).message).toMatch(/never saved/);
		const saved = await w.life.confirmSaved(address, address);
		await w.life.remove(address, saved.version);
		expect(items(w)).toEqual([]);
	});

	it("rolls back to archived when funds arrive between the check and the delete", async () => {
		const w = await world();
		const { address, record } = await make(w);
		let reads = 0;
		const life = openLifecycle({
			harness: w.s.harness,
			signer: new Signer(w.signerAt, { env: ENV }),
			home: w.id,
			accounts: w.s.capabilities,
			funded: async () => ++reads > 1,
			context,
		});
		expect((await refused(life.remove(address, record.version))).message).toMatch(/not removed/);
		expect(modelOf((await records(w))[address])).toBe("archived");
		expect(items(w)).toEqual([address]);
	});

	it("never deletes an item that holds another key: the removal ends, the key kept and listed (H-045)", async () => {
		const w = await world();
		const { address, record } = await make(w);
		const account = walletAccount(w.id, address as Address);
		let reads = 0;
		const life = w.open({
			with: {
				funded: async () => {
					reads++;
					return false;
				},
			},
		});
		const other = generateKey();
		keys().items[account] = other;
		await life.remove(address, record.version);
		expect(await records(w)).toEqual({});
		expect(await accountsOf(w)).toEqual([]);
		expect(keys().items[account]).toBe(other);
		expect(keys().calls.some((call) => call.op === "remove" && call.account === account)).toBe(false);
		expect(await w.life.orphans()).toEqual([address]);
		// the balance read for the removal was this wallet's, before the item was found to hold another key
		expect(reads).toBe(1);
	});

	it("an item swapped for another key between the proof and the delete is kept, and the removal ends (H-045)", async () => {
		const w = await world();
		const { address, record } = await make(w);
		const account = walletAccount(w.id, address as Address);
		const other = generateKey();
		const life = w.open({
			signer: (signer) => ({
				remove: async (lease, at) => {
					keys().items[account] = other;
					return signer.remove(lease, at);
				},
			}),
		});
		await life.remove(address, record.version);
		expect(await records(w)).toEqual({});
		expect(keys().items[account]).toBe(other);
		expect(await w.life.orphans()).toEqual([address]);
	});

	it("a removing wallet whose item holds another key at recovery is removed, its item kept (H-045)", async () => {
		const w = await world();
		const { address, record } = await make(w);
		const account = walletAccount(w.id, address as Address);
		locked("keychain:delete", 1);
		await refused(w.life.remove(address, record.version));
		const other = generateKey();
		keys().items[account] = other;
		await w.life.recover();
		expect(await records(w)).toEqual({});
		expect(keys().items[account]).toBe(other);
	});

	it("a wallet still being made is refused removal in its state's words, before any balance is read", async () => {
		const w = await world();
		await make(w, "First");
		locked("keychain:write");
		await refused(make(w, "Second"));
		const [address, record] = Object.entries(await records(w)).find(([, record]) => record.state === "creating") as [
			string,
			WalletRecord,
		];
		let reads = 0;
		const life = w.open({
			with: {
				funded: async () => {
					reads++;
					return false;
				},
			},
		});
		const error = await refused(life.remove(address, record.version));
		expect([error.status, error.message]).toEqual([409, "the wallet is still being made: it cannot be removed now"]);
		expect(reads).toBe(0);
	});

	it("stays removing while the keychain cannot delete, and the next try finishes it", async () => {
		const w = await world();
		const { address, record } = await make(w);
		locked("keychain:delete", 1);
		expect((await refused(w.life.remove(address, record.version))).code).toBe("locked");
		const removing = (await records(w))[address];
		expect(modelOf(removing)).toBe("removing");
		expect(await accountsOf(w)).toEqual([accountKey(address)]);
		await w.life.remove(address, removing?.version ?? 0);
		expect(await records(w)).toEqual({});
		expect(items(w)).toEqual([]);
	});

	it("a removal stopped after the delete is finished at recovery", async () => {
		const w = await world();
		const { address, record } = await make(w);
		locked("keychain:delete", 1);
		await refused(w.life.remove(address, record.version));
		delete keys().items[walletAccount(w.id, address as Address)];
		await w.life.recover();
		expect(await records(w)).toEqual({});
		expect(await accountsOf(w)).toEqual([]);
	});
});

describe("the paths around the owner's acts", () => {
	it("a signer that stops before it draws says no key was made, not that the keychain failed (UC-01 E5, H-002)", async () => {
		const w = await world();
		const life = w.open({ signer: () => ({ create: async () => ({ ok: false as const, code: "other" as const }) }) });
		const error = await refused(life.create({ request: request(), name: "Groceries", network: "base-sepolia" }));
		expect([error.status, error.code, error.message]).toEqual([
			503,
			"other",
			"banda could not make a key on this computer: nothing was made",
		]);
		expect(await records(w)).toEqual({});
		expect(items(w)).toEqual([]);
	});

	it("refuses to confirm a saved key from something that is not an address", async () => {
		const w = await world();
		const { address } = await make(w);
		expect((await refused(w.life.confirmSaved(address, "not an address"))).message).toMatch(/does not open/);
		expect(modelOf((await records(w))[address])).toBe("ready_unsaved");
	});

	it("brings an archived wallet back backed up when its key was saved", async () => {
		const w = await world();
		const { address } = await make(w);
		const saved = await w.life.confirmSaved(address, address);
		const archived = await w.life.archive(address, saved.version);
		expect(modelOf(await w.life.unarchive(address, archived.version))).toBe("ready_saved");
	});

	it("removes an archived wallet straight from the archive", async () => {
		const w = await world();
		const { address, record } = await make(w);
		const archived = await w.life.archive(address, record.version);
		await w.life.remove(address, archived.version);
		expect(await records(w)).toEqual({});
		expect(items(w)).toEqual([]);
		expect(await accountsOf(w)).toEqual([]);
	});

	it("tells the lane of each payment the archive refused, in its commit, so a card's Wait ends with it (C17)", async () => {
		const told: [string, string][] = [];
		const w = await world();
		const life = w.open({
			with: {
				refused: async (tx, id, from) => {
					expect((await tx.doc(Payments, id, null)).state).toBe("Refused");
					told.push([id, from]);
				},
			},
		});
		const { address, record } = await life.create({ request: request(), name: "Groceries", network: "base-sepolia" });
		await w.s.harness.commit(async (tx) => {
			const wallets = await tx.doc(Wallets);
			for (const [id, state] of [
				["p1", "Waiting"],
				["p2", "Sent"],
			] as const) {
				await tx.doc(Payments, id, {
					by: "owner",
					wallet: address,
					to: `address:base-sepolia:${addressOf(generateKey())}`,
					amount: "1",
					asset: "native",
					reserve: "0",
					state,
					versions: [],
					version: 1,
					at: 1,
				} satisfies PaymentValue);
				track(wallets, id, { wallet: address, state }, "new");
			}
		}, context);
		await life.archive(address, record.version);
		expect(told).toEqual([["p1", "Waiting"]]);
	});

	it("refuses a removal while an x402 authorization of the wallet is live, at the start and at the re-check", async () => {
		const w = await world();
		const live = { value: true };
		const life = w.open({ with: { authorized: async () => live.value } });
		const { address, record } = await life.create({ request: request(), name: "Groceries", network: "base-sepolia" });
		expect((await refused(life.remove(address, record.version))).message).toMatch(/payment/);
		live.value = false;
		locked("keychain:delete", 1);
		await refused(life.remove(address, record.version));
		const removing = (await records(w))[address];
		expect(modelOf(removing)).toBe("removing");
		live.value = true;
		expect((await refused(life.remove(address, removing?.version ?? 0))).message).toMatch(/not removed/);
		expect(modelOf((await records(w))[address])).toBe("archived");
		expect(items(w)).toEqual([address]);
	});

	it("two removals at once: funds that arrive between them never leave an archived wallet without its key", async () => {
		const w = await world();
		const { address, record } = await make(w);
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reads = 0;
		const life = w.open({
			signer: (signer) => ({
				remove: async (lease, at) => {
					await held;
					return signer.remove(lease, at);
				},
			}),
			// the first removal reads no funds twice (its start and its re-check); funds reach the wallet then
			with: { funded: async () => ++reads > 2 },
		});
		const first = life.remove(address, record.version);
		const second = life.remove(address, record.version + 1);
		await until(() => reads >= 2);
		release();
		await first;
		// the second finds the wallet gone by the first: the same act, done (C21)
		await second;
		expect(await records(w)).toEqual({});
		expect(items(w)).toEqual([]);
		expect(await accountsOf(w)).toEqual([]);
	});

	it("a removal stopped after its delete ends at recovery even once funds reached the address (H-044)", async () => {
		const w = await world();
		const { address, record } = await make(w);
		locked("keychain:delete", 1);
		await refused(w.life.remove(address, record.version));
		delete keys().items[walletAccount(w.id, address as Address)];
		w.funded.value = true;
		await w.life.recover();
		expect(await records(w)).toEqual({});
		expect(await accountsOf(w)).toEqual([]);
	});

	it("a balance that cannot be read at the re-check holds the wallet: archived, its item kept", async () => {
		const w = await world();
		const { address, record } = await make(w);
		locked("keychain:delete", 1);
		await refused(w.life.remove(address, record.version));
		const removing = (await records(w))[address];
		w.funded.value = undefined;
		expect((await refused(w.life.remove(address, removing?.version ?? 0))).message).toMatch(/could not be read/);
		expect(modelOf((await records(w))[address])).toBe("archived");
		expect(items(w)).toEqual([address]);
		expect(await accountsOf(w)).toEqual([accountKey(address)]);
	});

	it("an account the store kept for a record another step left alone stays, credentials and all", async () => {
		const w = await world();
		const { address } = await make(w);
		expect(await w.s.capabilities.removeWallet(address, async () => false)).toBe(false);
		expect(await accountsOf(w)).toEqual([accountKey(address)]);
	});

	it("one wallet that fails at recovery stops none after it", async () => {
		const w = await world();
		const one = await make(w, "One");
		const two = await make(w, "Two");
		for (const { address } of [one, two]) await w.s.capabilities.removeWallet(address, async () => true);
		let failing: string | undefined;
		const life = w.open({
			with: {
				accounts: {
					addWallet: async (wallet, ctx) => {
						failing ??= wallet.address;
						if (wallet.address === failing) throw new Error("the connection could not be changed");
						return w.s.capabilities.addWallet(wallet, ctx);
					},
					removeWallet: (address, removed, ctx) => w.s.capabilities.removeWallet(address, removed, ctx),
					walletKept: (address, ctx) => w.s.capabilities.walletKept(address, ctx),
				},
			},
		});
		await expect(life.recover()).rejects.toThrow(/could not be changed/);
		const other = failing === one.address ? two.address : one.address;
		expect(await accountsOf(w)).toEqual([accountKey(other)]);
	});
});

describe("whether this home can sign (C16)", () => {
	it("is online with the key and the lease, offline in host mode", async () => {
		const w = await world();
		const { address } = await make(w);
		expect(await w.life.unlockCheck(address)).toEqual({ state: "online" });
		w.host.value = true;
		expect(await w.life.unlockCheck(address)).toEqual({ state: "offline_host_mode" });
		expect(w.life.signingOf(address)).toEqual({ state: "offline_host_mode" });
	});

	it("says the key is missing, another key, or the keychain locked, as the model's rows go", async () => {
		const w = await world();
		const { address } = await make(w);
		const account = walletAccount(w.id, address as Address);
		const key = keys().items[account] as string;
		const check = async () => (await w.life.unlockCheck(address))?.state;
		locked("keychain:read", 1);
		expect(await check()).toBe("locked");
		keys().items[account] = generateKey();
		expect(await check()).toBe("wrong_key");
		// a loss seen while offline for another reason shows the loss (H-317)
		delete keys().items[account];
		expect(await check()).toBe("key_missing");
		keys().items[account] = key;
		expect(await check()).toBe("online");
		locked("keychain:read", 1);
		expect(await check()).toBe("locked");
		delete keys().items[account];
		expect(await check()).toBe("key_missing");
	});

	it("keeps the signer's code beside the state, the most specific reason (H-317)", async () => {
		const w = await world();
		const { address } = await make(w);
		const answer: { code: SignerCode | undefined } = { code: undefined };
		const life = w.open({
			signer: (signer) => ({
				derive: async (lease, at) =>
					answer.code === undefined ? signer.derive(lease, at) : { ok: false as const, code: answer.code },
			}),
		});
		const codes = ["locked", "no_keychain", "ambiguous", "debugging", "denied", "timeout", "refused", "other"] as const;
		for (const code of codes) {
			answer.code = code;
			expect(await life.unlockCheck(address)).toEqual({ state: "locked", code });
			expect(life.signingOf(address)).toEqual({ state: "locked", code });
		}
		answer.code = "wrong_key";
		expect(await life.unlockCheck(address)).toEqual({ state: "wrong_key", code: "wrong_key" });
		answer.code = "missing";
		expect(await life.unlockCheck(address)).toEqual({ state: "key_missing", code: "missing" });
		answer.code = "locked";
		expect(await life.unlockCheck(address)).toEqual({ state: "key_missing", code: "locked" });
		answer.code = undefined;
		expect(await life.unlockCheck(address)).toEqual({ state: "online" });
	});

	it("says a home-wide reason for every wallet at once, and one wallet's own reason for it alone", async () => {
		const w = await world();
		const first = (await make(w)).address;
		const second = (await make(w)).address;
		const answer: { code: SignerCode | undefined } = { code: undefined };
		const life = w.open({
			signer: (signer) => ({
				derive: async (lease, at) =>
					answer.code === undefined ? signer.derive(lease, at) : { ok: false as const, code: answer.code },
			}),
		});
		expect(await life.unlockCheck(first)).toEqual({ state: "online" });
		expect(await life.unlockCheck(second)).toEqual({ state: "online" });
		// the keychain, the lease and the debugger are the home's: what one wallet's check found holds for every one
		for (const code of ["locked", "no_keychain", "denied", "timeout", "debugging"] as const) {
			answer.code = code;
			expect(await life.unlockCheck(first)).toEqual({ state: "locked", code });
			expect(life.signingOf(second)).toEqual({ state: "locked", code });
		}
		// the keychain answers again: the check that found it so takes every wallet it held back online
		answer.code = undefined;
		expect(await life.unlockCheck(first)).toEqual({ state: "online" });
		expect(life.signingOf(second)).toEqual({ state: "online" });
		// another key in one wallet's item is that wallet's alone
		answer.code = "wrong_key";
		expect(await life.unlockCheck(first)).toEqual({ state: "wrong_key", code: "wrong_key" });
		expect(life.signingOf(second)).toEqual({ state: "online" });
		// a copy of the home: no wallet of it signs here
		const copy = w.open({ binding: "0".repeat(64) });
		expect((await copy.unlockCheck(first))?.state).toBe("other_home");
		expect(copy.signingOf(second)?.state).toBe("other_home");
	});

	it("tells the lane in a commit of its own when a missing key is back, before the wallet is online (C9, H-290)", async () => {
		const told: string[] = [];
		const failing = { value: true };
		const w = await world();
		const life = w.open({
			with: {
				restored: async (tx, at) => {
					expect((await tx.doc(Wallets)).wallets[at]).toBeDefined();
					if (failing.value) throw new Error("the lane could not answer");
					told.push(at);
				},
			},
		});
		const { address } = await life.create({ request: request(), name: "Groceries", network: "base-sepolia" });
		const account = walletAccount(w.id, address as Address);
		const key = keys().items[account] as string;
		const check = async () => (await life.unlockCheck(address))?.state;
		delete keys().items[account];
		expect(await check()).toBe("key_missing");
		keys().items[account] = generateKey();
		expect(await check()).toBe("key_missing");
		keys().items[account] = key;
		await expect(life.unlockCheck(address)).rejects.toThrow(/could not answer/);
		expect(life.signingOf(address)?.state).toBe("key_missing");
		failing.value = false;
		expect(await check()).toBe("online");
		expect(await check()).toBe("online");
		expect(told).toEqual([address]);
	});

	it("leaves key_missing only by a restore: the key back is restored, then checked as any is (C9, H-290)", async () => {
		const w = await world();
		const { address } = await make(w);
		const account = walletAccount(w.id, address as Address);
		const key = keys().items[account] as string;
		const check = async () => (await w.life.unlockCheck(address))?.state;
		delete keys().items[account];
		expect(await check()).toBe("key_missing");
		locked("keychain:read", 1);
		expect(await check()).toBe("key_missing");
		keys().items[account] = generateKey();
		expect(await check()).toBe("key_missing");
		keys().items[account] = key;
		w.host.value = true;
		expect(await check()).toBe("offline_host_mode");
		w.host.value = false;
		expect(await check()).toBe("online");
	});

	it("is other_home for a copy of the home, and catches the store up to a lease the keychain moved first", async () => {
		const w = await world();
		const { address } = await make(w);
		const copy = w.open({ binding: "0".repeat(64) });
		expect((await copy.unlockCheck(address))?.state).toBe("other_home");
		expect((await refused(copy.create({ request: request(), name: "Copy", network: "base-sepolia" }))).code).toBe(
			"other_home",
		);
		// a claim killed after the keychain took the next epoch and before the store did (H-289)
		expect(await claimLease(memoryKeystore(), w.signerAt, 1)).toBe(2);
		expect((await w.life.unlockCheck(address))?.state).toBe("online");
		expect((await w.s.harness.snapshot(Wallets, context))?.lease).toBe(2);
	});

	/** The desktop's Move signing here on this home: its host signer, the store's epoch and its wallets as the daemon has them. */
	const move = async (w: World) => {
		const wallets = Object.entries(await records(w));
		const deps: WalletDeps = {
			signer: async () => {
				const signer = new HostSigner(w.signerAt, { env: ENV, deadline: 10_000 });
				signers.push(signer);
				return signer;
			},
			reauthenticates: true,
			identityLost: async () => false,
			reauthenticate: async () => true,
			lease: async () => (await w.s.harness.snapshot(Wallets, context))?.lease,
			wallets: async () => wallets.map(([address, record]) => ({ address, state: record.state })),
			tell: async () => true,
			show: async () => {},
		};
		return moveSigning(deps);
	};

	it("makes a wallet once Move signing here replaced a home secret a stopped claim left bound elsewhere (C15)", async () => {
		const w = await world();
		// a first claim stopped between its two writes, then the home's binding changed (a restore's marker, a move)
		keys().items[homeSecretAccount(w.signerAt.id)] = JSON.stringify({
			secret: "a".repeat(64),
			binding: "b".repeat(64),
		});
		expect((await refused(make(w))).code).toBe("other_home");
		expect(await move(w)).toEqual({ ok: true });
		expect(modelOf((await make(w)).record)).toBe("ready_unsaved");
	});

	it("makes a wallet once Move signing here took a lease the keychain held behind the store past the store's (C16)", async () => {
		const w = await world();
		const { address } = await make(w);
		// the keychain's lease item rolled back behind the epoch the store took
		await w.s.harness.commit(async (tx) => {
			(await tx.doc(Wallets)).lease = 3;
		}, context);
		expect((await refused(make(w, "Second"))).code).toBe("other_home");
		expect(await move(w)).toEqual({ ok: true });
		expect(JSON.parse(keys().items[leaseAccount(w.signerAt.id)] as string).epoch).toBe(4);
		expect(modelOf((await make(w, "Second")).record)).toBe("ready_unsaved");
		expect((await w.life.unlockCheck(address))?.state).toBe("online");
	});

	it("says nothing for an address no wallet has", async () => {
		const w = await world();
		expect(await w.life.unlockCheck(checksummed(addressOf(generateKey())))).toBeUndefined();
	});
});

/** The wallets whose item derives their own address. */
const ownKeys = (w: World, wallets: Awaited<ReturnType<typeof records>>): Set<string> =>
	new Set(
		Object.keys(wallets).filter((address) => {
			const item = keys().items[walletAccount(w.id, address as Address)];
			return item !== undefined && /^0x[0-9a-f]{64}$/.test(item) && addressOf(item as Key) === address;
		}),
	);

/**
 * FundsNeverOrphanedByBanda over one step: banda deletes a wallet's own key only while its balance reads empty and
 * its key was saved or its address never left banda; a wallet removed while funds may be there had lost its own key
 * before the step.
 */
const fundsKeptTheirKey = (
	w: World,
	before: Awaited<ReturnType<typeof records>>,
	held: Set<string>,
	after: Awaited<ReturnType<typeof records>>,
) => {
	const still = ownKeys(w, after);
	for (const address of held) {
		const item = keys().items[walletAccount(w.id, address as Address)];
		if (still.has(address) || item !== undefined) continue;
		const record = before[address];
		expect(w.funded.value).toBe(false);
		expect(record?.backup === "saved" || record?.disclosed === false).toBe(true);
	}
	for (const address of Object.keys(before))
		if (after[address] === undefined && w.funded.value !== false) expect(held.has(address)).toBe(false);
};

describe("a random run of acts and keychain faults", () => {
	it("never leaves a ready wallet without its item, an item no wallet names, a deleted key of another, a funded wallet without its key, or a key in the store", async () => {
		const act = fc.oneof(
			fc.constant({ op: "create" as const }),
			fc.record(
				{ op: fc.constantFrom("archive", "unarchive", "skip", "remove", "unlock", "disclose", "saved", "plant") },
				{ requiredKeys: ["op"] },
			),
			fc.record({ op: fc.constant("funds" as const), value: fc.constantFrom(false, true, undefined) }),
			fc.record({
				op: fc.constant("fault" as const),
				point: fc.constantFrom("keychain:read" as const, "keychain:write" as const, "keychain:delete" as const),
				times: fc.integer({ min: 1, max: 3 }),
			}),
			fc.constant({ op: "recover" as const }),
		);
		type Step = [typeof act extends fc.Arbitrary<infer A> ? A : never, number];
		await fc.assert(
			fc.asyncProperty(fc.array(fc.tuple(act, fc.nat()), { minLength: 1, maxLength: 12 }), async (acts) => {
				const w = await world();
				/** Keys put by hand under a wallet's account that do not open it: never deleted. */
				const planted = new Map<string, string>();
				try {
					for (const [step, pick] of acts) {
						const before = await records(w);
						const all = Object.entries(before);
						const [address, record] = all[pick % Math.max(all.length, 1)] ?? [];
						const tried = async () => {
							if (step.op === "create") return make(w);
							if (step.op === "fault") return locked(step.point, step.times);
							if (step.op === "funds") {
								w.funded.value = step.value;
								return undefined;
							}
							if (step.op === "recover") return w.life.recover();
							if (address === undefined || record === undefined) return undefined;
							if (step.op === "archive") return w.life.archive(address, record.version);
							if (step.op === "unarchive") return w.life.unarchive(address, record.version);
							if (step.op === "skip") return w.life.skip(address);
							if (step.op === "remove") return w.life.remove(address, record.version);
							if (step.op === "saved") return w.life.confirmSaved(address, address);
							if (step.op === "disclose")
								return w.s.harness.commit(async (tx) => {
									const wallet = (await tx.doc(Wallets)).wallets[address];
									if (wallet !== undefined) wallet.disclosed = true;
								}, context);
							if (step.op === "plant") {
								const account = walletAccount(w.id, address as Address);
								if (record.state === "creating" || keys().items[account] === undefined) return undefined;
								const other = generateKey();
								keys().items[account] = other;
								planted.set(address, other);
								return undefined;
							}
							return w.life.unlockCheck(address);
						};
						const held = ownKeys(w, before);
						await tried().catch((error: unknown) => {
							if (!(error instanceof WalletRefused)) throw error;
						});
						fundsKeptTheirKey(w, before, held, await records(w));
					}
					keys().faults = [];
					const before = await records(w);
					const held = ownKeys(w, before);
					await w.life.recover();
					fundsKeptTheirKey(w, before, held, await records(w));
					const wallets = await records(w);
					for (const [address, record] of Object.entries(wallets)) {
						expect(record.state === "creating" || record.state === "removing").toBe(false);
						const item = keys().items[walletAccount(w.id, address as Address)] as Key;
						if (!planted.has(address)) expect(addressOf(item)).toBe(address);
					}
					// a key that does not open its wallet is never deleted; once its wallet is removed it is an orphan
					for (const [address, key] of planted) expect(keys().items[walletAccount(w.id, address as Address)]).toBe(key);
					const kept = [...planted.keys()].filter((address) => wallets[address] === undefined);
					expect((await w.life.orphans())?.sort()).toEqual(kept.sort());
					expect(await accountsOf(w)).toEqual(Object.keys(wallets).map(accountKey).sort());
					const text = storeText(w.s.home);
					for (const key of Object.values(keys().items))
						if (/^0x[0-9a-f]{64}$/.test(key)) expect(text).not.toContain(key.slice(2));
				} finally {
					opened.splice(opened.indexOf(w.s), 1);
					await w.s.close();
					memoryKeystore().state = emptyState();
				}
			}),
			{
				numRuns: pbtRuns(8),
				// C17's re-check at the delete: a removal the keychain stopped, then funds (or an unreadable balance)
				// before the removal is tried again or recovered. A run rarely draws this by chance.
				examples: [true, undefined].flatMap((value) =>
					[{ op: "remove" as const }, { op: "recover" as const }].map((last): [Step[]] => [
						[
							[{ op: "create" }, 0],
							[{ op: "fault", point: "keychain:delete", times: 1 }, 0],
							[{ op: "remove" }, 0],
							[{ op: "funds", value }, 0],
							[last, 0],
						],
					]),
				),
			},
		);
	}, 180_000);
});
