/**
 * The daemon's side of the signer (C20): each call starts src/wallet/signer.ts from `process.execPath`, the daemon's
 * own binary (so macOS sees the code identity its keychain items trust), or from the `node` it is given; under
 * Electron, whose binary would start another app and is not that identity, it is refused unless given one. It hands the
 * child one request over stdin and waits for its answer until a deadline, then SIGKILLs it: a keychain call behind an
 * unanswered prompt ignores its AbortSignal and cannot end its process any other way. One call is in flight per home at
 * a time, so two writes never race on one item (H-036). An answer naming another request, or arriving after its call
 * settled, is dropped (C14, H-035).
 *
 * With an inspector on, or a flag that opens one or dumps the heap, every call is refused as `debugging`: the wallets
 * are offline while anything could read the process (H-012). The child gets no NODE_OPTIONS, and starts with SIGUSR1
 * unable to open an inspector.
 *
 * This module never loads the signing libraries or the native keychain module: those load in the child alone. A call
 * that times out or is stopped is over for the home only once its child has exited, so the home's next child never
 * starts beside a killed one still in a keychain write. A test that sets `BANDA_TEST_KEYSTORE=1` gets the signer in
 * process, on the in-memory keystore (a child's memory ends with it); a call that times out there is cancelled, and the
 * home's next call waits until it has settled, so it makes no effect after its caller gave up and never overlaps the
 * next one.
 *
 * The owner's Restore key is not here: the key it carries never passes through the daemon (C20), so only the host
 * process sends it (src/wallet/signer-host.ts). A reveal is, for the client that made the wallet (C16): the child it
 * starts gets an IPC channel, and once it proved the key and `proven` spent the reveal, the client's connection is
 * handed to it there; the child writes the response with the key onto it, and once it says so the daemon's copy is
 * closed (until then the daemon keeps it, to answer on should the child not have written). In process
 * (`BANDA_TEST_KEYSTORE=1`, tests alone) the response is written from here.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import inspector from "node:inspector";
import type { Socket } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Value } from "typebox/value";
import { keyedSerial } from "../core/keyed-serial.ts";
import { type Address, checksummed } from "./address.ts";
import type { SignerHome } from "./home-id.ts";
import { memoryKeystore, testKeystore } from "./keystore.ts";
import type { Transfer, TransferAuthorization } from "./sign.ts";
import {
	Answer,
	debugging,
	type Op,
	type Outcome,
	RESULTS,
	Request,
	type Results,
	type SignerCode,
} from "./signer-protocol.ts";

/**
 * Node's flags for the child: a SIGUSR1 sent to it never opens an inspector on the process that holds a key (H-012).
 */
export const CHILD_FLAGS = ["--disable-sigusr1"] as const;

/** The child's script beside this module: .ts from the checkout, .js from the build. */
export const SIGNER = fileURLToPath(
	new URL(`./signer${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`, import.meta.url),
);

/**
 * Long enough for the owner to answer a keychain prompt (the spike's took 9 s), short enough to say "waiting for you":
 * a call that reads several items, each of which may prompt, gets this for each (`ITEMS`, or `Steps.items`).
 */
export const DEADLINE = 20_000;

/**
 * The keychain items each op reads, any of which may wait on the owner's answer after an update (H-017): every op held
 * to the lease reads the lease and the home secret first, and an op on a wallet then reads its key (or writes and reads
 * it back, for a creation and a restore); a listing reads the service's items in one answer. A move counts its keys.
 */
export const ITEMS: { readonly [O in Op]: number } = {
	canary: 1,
	lease: 2,
	leased: 2,
	move: 2,
	create: 3,
	restore: 3,
	derive: 3,
	transfer: 3,
	authorization: 3,
	remove: 3,
	reveal: 3,
	confirm: 3,
	export: 3,
	find: 3,
};

export type SignerOptions = {
	/** Milliseconds a call may take for each item it reads, the child's start included. */
	readonly deadline?: number;
	/** The environment the child gets, and the test keystore is read from; this process's by default. */
	readonly env?: NodeJS.ProcessEnv;
	/** Another child script, for tests of this module alone. */
	readonly script?: string;
	/**
	 * The binary the child runs: the daemon's node, which the desktop app's main process passes; this one's by default.
	 */
	readonly node?: string;
};

/** Whether a reveal's response can no longer go onto `connection`, so its one reveal is not spent for nothing. */
const gone = (connection: Socket) => connection.destroyed || !connection.writable;

/** The binary a child runs: the one given, else this process's own unless it is Electron's. */
export function signerNode(given: string | undefined, versions = process.versions, execPath = process.execPath) {
	return given ?? (versions.electron === undefined ? execPath : undefined);
}

type TransferFields = Omit<Transfer, "key">;
type AuthorizationFields = Omit<TransferAuthorization, "key">;

/** Each home's line of calls, in this process: a call waits on the last effect of the one before. */
const lines = keyedSerial();

type Body = Request extends infer R ? (R extends Request ? Omit<R, "id" | "home"> : never) : never;

/**
 * A reveal's client: the connection its response goes onto, what spends the reveal once the key is proven, and what is
 * told once the connection has left this process (handed to the child, or written onto in process).
 */
type Shown = {
	readonly connection: Socket;
	readonly proven: () => Promise<void>;
	readonly handed?: () => void;
	/**
	 * Told as the connection is given to the child, before it says whether it wrote onto it: from then the key may have
	 * left. Never told, the key provably never left, whatever `proven` spent.
	 */
	readonly given?: () => void;
};

/**
 * Sends `connection` to `child` as a socket no server of this process tracks: given one a server accepted, Node makes
 * that server ask the child for its connections when it closes, and a child that has exited never answers, so the
 * server's close would never finish. This process keeps its copy open meanwhile, since a send to a child that just died
 * can still be reported sent: only the child's answer says the response went onto the connection, and then `left`
 * destroys this process's copy, which the server then counts closed; otherwise `kept` gives it back to its server, for
 * the caller to answer on. `failed` hears a send that failed outright.
 */
function handOver(
	child: ChildProcess,
	message: object,
	connection: Socket,
	failed: () => void,
): { readonly left: () => void; readonly kept: () => void } {
	const tracked = connection as Socket & { server: unknown };
	const server = tracked.server;
	tracked.server = null;
	try {
		child.send(message, connection, { keepOpen: true }, (error) => {
			if (error !== null) failed();
		});
	} catch {
		failed();
	}
	return {
		left: () => connection.destroy(),
		kept: () => {
			tracked.server = server;
		},
	};
}

/**
 * What a call hears while it runs: a creation's drawn address, a reveal's proven key; and how many keychain items it
 * reads that may each wait on the owner's answer (one when absent): its deadline is one answer's for each (H-017).
 */
export type Steps = {
	readonly drawn?: (address: Address) => Promise<void>;
	readonly shown?: Shown;
	readonly items?: number;
};

export class Signer {
	readonly #home: SignerHome;
	readonly #deadline: number;
	readonly #env: NodeJS.ProcessEnv;
	readonly #script: string;
	readonly #node: string | undefined;
	readonly #children = new Set<ChildProcess>();
	readonly #cancels = new Set<AbortController>();
	#stopped = false;

	constructor(home: SignerHome, options: SignerOptions = {}) {
		this.#home = home;
		this.#deadline = options.deadline ?? DEADLINE;
		this.#env = options.env ?? process.env;
		this.#script = options.script ?? SIGNER;
		this.#node = options.node;
	}

	/** Whether the keychain answers: sets, reads back and removes the canary. */
	canary() {
		return this.call({ op: "canary" });
	}

	/** Takes the lease by compare-and-set on its epoch: `expected` is the one the store holds, null for none yet. */
	lease(expected: number | null) {
		return this.call({ op: "lease", expected });
	}

	/**
	 * The lease as the keychain holds it, and whether it is this home's: a claim or a move killed after the keychain
	 * took the next epoch and before the store did shows here as a higher epoch that is `mine`, which the store then
	 * catches up to (C15, H-289); another home's shows as not `mine`.
	 */
	leased() {
		return this.call({ op: "leased" });
	}

	/**
	 * Makes a key and keeps it (C15): the child draws it and names its address; `drawn` commits `creating` with that
	 * address; only then does the child check the item is empty, write it and read it back. If `drawn` throws, the child
	 * is killed and nothing was written.
	 */
	create(lease: number, drawn: (address: Address) => Promise<void>) {
		return this.call({ op: "create", lease }, { drawn });
	}

	/**
	 * Shows the wallet's key to the client on `connection` (C16): once the key is proven, `proven` spends the reveal (a
	 * throw stops it, and nothing is written), and the child writes the response onto the connection, which is then this
	 * process's no longer, and `handed` is told so. Unless `handed` was told, the connection is still here, for the
	 * caller to answer on, even when `proven` spent the reveal. `given` is told as the connection goes to the child (or
	 * the response onto it, in process): unless it was told, the key never left, and a spend may be taken back.
	 */
	reveal(
		lease: number,
		address: Address,
		connection: Socket,
		proven: () => Promise<void>,
		handed?: () => void,
		given?: () => void,
	) {
		return this.call(
			{ op: "reveal", lease, address },
			{
				shown: {
					connection,
					proven,
					...(handed === undefined ? {} : { handed }),
					...(given === undefined ? {} : { given }),
				},
			},
		);
	}

	/** Whether the owner's saved copy is the wallet's key, by its SHA-256 (`keyDigest`): the copy never comes here. */
	confirm(lease: number, address: Address, digest: string) {
		return this.call({ op: "confirm", lease, address, digest });
	}

	/** Proves the wallet's key: it derives `address`, and this home holds the lease at `lease` (C16). */
	derive(lease: number, address: Address) {
		return this.call({ op: "derive", lease, address });
	}

	/** Signs an EIP-1559 transfer from `address`, after proving its key; nothing is committed here (C4). */
	transfer(lease: number, address: Address, fields: TransferFields) {
		return this.call({
			op: "transfer",
			lease,
			address,
			fields: {
				chainId: fields.chainId,
				nonce: String(fields.nonce),
				maxFee: String(fields.maxFee),
				tip: String(fields.tip),
				gasLimit: String(fields.gasLimit),
				to: fields.to,
				value: String(fields.value),
				...(fields.token === undefined ? {} : { token: fields.token }),
			},
		});
	}

	/** Signs an EIP-3009 `TransferWithAuthorization` from `address`, after proving its key. */
	authorization(lease: number, address: Address, fields: AuthorizationFields) {
		return this.call({
			op: "authorization",
			lease,
			address,
			fields: {
				chainId: fields.chainId,
				token: { address: fields.token.address, name: fields.token.name, version: fields.token.version },
				to: fields.to,
				value: String(fields.value),
				validAfter: String(fields.validAfter),
				validBefore: String(fields.validBefore),
				nonce: fields.nonce,
			},
		});
	}

	/** Removes the wallet's item; the owner's removal alone calls it (C15, C17). */
	remove(lease: number, address: Address) {
		return this.call({ op: "remove", lease, address });
	}

	/** The addresses this home has items for, to tell orphans from wallets (C15): at this home's lease alone. */
	find(lease: number) {
		return this.call({ op: "find", lease });
	}

	/** Kills any call in flight and refuses every later one: shutdown never waits on the keychain (H-034). */
	stop(): void {
		this.#stopped = true;
		for (const child of this.#children) child.kill("SIGKILL");
		this.#children.clear();
		for (const cancel of this.#cancels) cancel.abort();
		this.#cancels.clear();
	}

	/** How long a call may take: one answer's time for each item it reads. */
	#deadlineOf(request: Request, steps: Steps): number {
		return this.#deadline * Math.max(1, steps.items ?? ITEMS[request.op]);
	}

	/** Sends one request, after the home's calls before it have settled. */
	protected call<B extends Body>(body: B, steps: Steps = {}): Promise<Outcome<Results[B["op"]]>> {
		const request = { ...body, id: randomBytes(16).toString("hex"), home: this.#home } as Request;
		const run = lines(
			this.#home.id,
			() =>
				this.#once(request, steps).catch(() => ({
					outcome: failure("other") as Outcome<unknown>,
					settled: Promise.resolve() as Promise<unknown>,
				})),
			({ settled }) => settled,
		);
		return run.then(({ outcome }) => outcome) as Promise<Outcome<Results[B["op"]]>>;
	}

	/** The call's outcome, and when it has made its last effect: the next call of the home waits on that. */
	async #once(request: Request, steps: Steps): Promise<{ outcome: Outcome<unknown>; settled: Promise<unknown> }> {
		const now = (outcome: Outcome<unknown>) => ({ outcome, settled: Promise.resolve() });
		if (this.#stopped) return now(failure("other"));
		if (debugging(process.execArgv, process.env.NODE_OPTIONS, inspector.url())) return now(failure("debugging"));
		let test: ReturnType<typeof testKeystore>;
		try {
			test = testKeystore(this.#env);
		} catch {
			return now(failure("other"));
		}
		if (test?.kind === "memory") return this.#inProcess(request, steps);
		return this.#child(request, steps);
	}

	/**
	 * The call in this process, against the test's keystore: held to the wire's schemas as the child is, so a request
	 * the shipped child refuses (it exits without an answer) fails here too, and an answer it could not send is none.
	 */
	async #inProcess(request: Request, steps: Steps): Promise<{ outcome: Outcome<unknown>; settled: Promise<unknown> }> {
		if (!Value.Check(Request, request)) return { outcome: failure("other"), settled: Promise.resolve() };
		const { drawn, shown } = steps;
		const { serve, writeOnto } = (await import(pathToFileURL(this.#script).href)) as typeof import("./signer.ts");
		const cancel = new AbortController();
		this.#cancels.add(cancel);
		let timer: NodeJS.Timeout | undefined;
		const late = new Promise<Outcome<unknown>>((resolve) => {
			timer = setTimeout(
				() => {
					resolve(failure("timeout"));
					cancel.abort();
				},
				this.#deadlineOf(request, steps),
			);
		});
		const stopped = new Promise<Outcome<unknown>>((resolve) =>
			cancel.signal.addEventListener("abort", () => resolve(failure("other")), { once: true }),
		);
		const answered = serve(
			request,
			memoryKeystore().until(cancel.signal),
			async (address) => {
				if (cancel.signal.aborted) return false;
				if (drawn === undefined) return false;
				const aborted = new Promise<false>((resolve) =>
					cancel.signal.addEventListener("abort", () => resolve(false), { once: true }),
				);
				try {
					return await Promise.race([drawn(checksummed(address)).then(() => true), aborted]);
				} catch {
					return false;
				}
			},
			async (response) => {
				if (cancel.signal.aborted || shown === undefined || gone(shown.connection)) return false;
				try {
					await shown.proven();
				} catch {
					return false;
				}
				if (cancel.signal.aborted || gone(shown.connection)) return false;
				shown.given?.();
				shown.handed?.();
				return writeOnto(shown.connection, response);
			},
		).then((answer) =>
			Value.Check(Answer, answer) && answer.id === request.id ? outcomeOf(request.op, answer) : failure("other"),
		);
		try {
			return { outcome: await Promise.race([answered, late, stopped]), settled: answered };
		} finally {
			clearTimeout(timer);
			this.#cancels.delete(cancel);
		}
	}

	#child(request: Request, steps: Steps): Promise<{ outcome: Outcome<unknown>; settled: Promise<unknown> }> {
		const { drawn, shown } = steps;
		const node = signerNode(this.#node);
		if (node === undefined) return Promise.resolve({ outcome: failure("other"), settled: Promise.resolve() });
		const env = { ...this.#env };
		delete env.NODE_OPTIONS;
		let child: ChildProcess;
		try {
			child = spawn(node, [...CHILD_FLAGS, this.#script], {
				stdio: shown === undefined ? ["pipe", "pipe", "ignore"] : ["pipe", "pipe", "ignore", "ipc"],
				env,
				windowsHide: true,
			});
		} catch {
			return Promise.resolve({ outcome: failure("other"), settled: Promise.resolve() });
		}
		this.#children.add(child);
		const exited = new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
			child.once("error", () => {
				if (child.pid === undefined) resolve();
			});
		});
		const outcome = new Promise<Outcome<unknown>>((resolve) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			let answers: ReturnType<typeof createInterface> | undefined;
			/** The reveal's connection, sent to the child: it left only if the child answered that it wrote onto it. */
			let sent: ReturnType<typeof handOver> | undefined;
			const finish = (outcome: Outcome<unknown>) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				answers?.close();
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				this.#children.delete(child);
				if (sent !== undefined && outcome.ok) {
					sent.left();
					shown?.handed?.();
				} else sent?.kept();
				resolve(outcome);
			};
			child.on("error", () => finish(failure("other")));
			child.on("close", () => finish(failure("other")));
			const { stdin, stdout } = child;
			if (stdin === null || stdout === null) return finish(failure("other"));
			try {
				timer = setTimeout(() => finish(failure("timeout")), this.#deadlineOf(request, steps));
				answers = createInterface({ input: stdout });
				stdin.on("error", () => {});
				answers.on("line", (line) => {
					let answer: unknown;
					try {
						answer = JSON.parse(line);
					} catch {
						return;
					}
					if (!Value.Check(Answer, answer) || answer.id !== request.id) return;
					if (!("step" in answer)) return finish(outcomeOf(request.op, answer));
					if (answer.step === "proven") {
						if (shown === undefined || settled || gone(shown.connection)) return finish(failure("other"));
						Promise.resolve()
							.then(() => shown.proven())
							.then(
								() => {
									if (settled) return;
									if (gone(shown.connection)) return finish(failure("other"));
									shown.given?.();
									sent = handOver(child, { id: request.id, go: true }, shown.connection, () =>
										finish(failure("other")),
									);
								},
								() => finish(failure("other")),
							);
						return;
					}
					if (drawn === undefined) return finish(failure("other"));
					const address = answer.address;
					Promise.resolve()
						.then(() => drawn(checksummed(address)))
						.then(
							() => {
								if (!settled) stdin.write(`${JSON.stringify({ id: request.id, go: true })}\n`);
							},
							() => finish(failure("other")),
						);
				});
				stdin.write(`${JSON.stringify(request)}\n`);
			} catch {
				finish(failure("other"));
			}
		});
		return outcome.then((outcome) => ({ outcome, settled: exited }));
	}
}

const failure = (code: SignerCode): Outcome<never> => ({ ok: false, code });

function outcomeOf(op: Op, answer: Answer): Outcome<unknown> {
	if ("step" in answer) return failure("other");
	if (!answer.ok) return { ok: false, code: answer.code, ...(answer.why === undefined ? {} : { why: answer.why }) };
	const result = answer.result;
	if (!Value.Check(RESULTS[op], result)) return failure("other");
	return { ok: true, ...(result as object) };
}
