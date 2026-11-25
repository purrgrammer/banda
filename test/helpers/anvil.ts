/**
 * anvil for the wallet tests (docs/wallets/features/ISOLATION.md section 3): a chain of the test's own, on a port the
 * system assigns at bind. anvil is asked for port 0 and says which port it took, so no port is picked first and lost
 * to another run in between, and no slot is needed. Its accounts are anvil's public dev accounts: no funds anywhere
 * real. Every anvil started here is killed when it fails to start, when `stop` is called, and when the test process
 * exits or is interrupted.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { until } from "../helpers.ts";

/** anvil's public dev account 0 and its key, known to everyone, funded only on anvil. */
export const DEV0 = {
	address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
	key: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
} as const;

export type Anvil = {
	readonly url: string;
	readonly port: number;
	/** A raw JSON-RPC call, for what a test does to the chain itself (`evm_mine`, `anvil_setCode`): its whole reply. */
	raw(method: string, params?: readonly unknown[]): Promise<{ result?: unknown; error?: { message: string } }>;
	stop(): Promise<void>;
};

/** The anvil the repo pins (`mise.toml`); another version's pool wording is not what the spikes measured. */
export const ANVIL_VERSION = "1.9.0";

/** What a suite that needs anvil is titled when it skips. */
export const NO_ANVIL = `anvil ${ANVIL_VERSION} not found (mise install)`;

/** Whether this machine has the pinned anvil; a test that needs it skips without, titled `NO_ANVIL`. */
export const hasAnvil = (): boolean => {
	const run = spawnSync("anvil", ["--version"], { encoding: "utf8" });
	return (
		run.status === 0 && new RegExp(`^anvil Version: ${ANVIL_VERSION.replaceAll(".", "\\.")}\\b`, "m").test(run.stdout)
	);
};

const running = new Set<ChildProcess>();
const killAll = () => {
	for (const child of running) child.kill("SIGKILL");
};
let hooked = false;
/** Kills every anvil still running when the process exits, or on SIGINT or SIGTERM before it exits as it would have. */
const hook = () => {
	if (hooked) return;
	hooked = true;
	process.once("exit", killAll);
	for (const signal of ["SIGINT", "SIGTERM"] as const)
		process.once(signal, () => {
			killAll();
			process.kill(process.pid, signal);
		});
};

const LISTENING = /Listening on 127\.0\.0\.1:(\d+)/;

/** Starts an anvil with `args` (a chain id, `--no-mining`) and waits until it answers. */
export async function startAnvil(args: readonly string[] = []): Promise<Anvil> {
	hook();
	const child: ChildProcess = spawn("anvil", ["--host", "127.0.0.1", "--port", "0", ...args], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	running.add(child);
	child.once("exit", () => running.delete(child));
	try {
		return await started(child);
	} catch (error) {
		child.kill("SIGKILL");
		throw error;
	}
}

async function started(child: ChildProcess): Promise<Anvil> {
	const port = await new Promise<number>((resolve, reject) => {
		let seen = "";
		const timer = setTimeout(() => reject(new Error(`anvil did not start: ${seen.slice(-500)}`)), 20_000);
		const note = (chunk: Buffer) => {
			seen += chunk.toString("utf8");
		};
		const read = (chunk: Buffer) => {
			note(chunk);
			const match = LISTENING.exec(seen);
			if (match?.[1] !== undefined) {
				clearTimeout(timer);
				child.stdout?.off("data", read);
				child.stderr?.off("data", note);
				child.stdout?.resume();
				child.stderr?.resume();
				resolve(Number(match[1]));
			}
		};
		child.stdout?.on("data", read);
		child.stderr?.on("data", note);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`anvil exited with ${code}: ${seen.slice(-500)}`));
		});
	});
	const url = `http://127.0.0.1:${port}`;
	let id = 0;
	const raw: Anvil["raw"] = async (method, params = []) => {
		id += 1;
		const response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
		});
		return (await response.json()) as { result?: unknown; error?: { message: string } };
	};
	// it listens before it answers: the caller's hook or test timeout bounds the wait
	await until(async () => {
		try {
			return (await raw("eth_chainId")).result !== undefined;
		} catch {
			return false;
		}
	});
	return {
		url,
		port,
		raw,
		stop: () =>
			new Promise<void>((resolve) => {
				if (child.exitCode !== null || child.signalCode !== null) return resolve();
				child.once("exit", () => resolve());
				child.kill("SIGKILL");
			}),
	};
}
