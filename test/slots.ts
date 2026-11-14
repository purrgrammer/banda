/**
 * What the machine can only do so much of at once, across every test run on it, whichever checkout it came from. A slot
 * is a loopback port held by the process doing the work: the kernel frees it when that process dies, however it dies,
 * so a killed run leaves nothing to clean up and no one waiting on it.
 */
import { createServer, type Server } from "node:net";
import { availableParallelism } from "node:os";

export type Slots = {
	readonly first: number;
	readonly size: number;
	/** How long a wait may last before it fails: for a slot something outside the tests may hold, never freed. */
	readonly patience?: number;
};

/** A size from the environment when it is a positive whole number, at most `most`; else the machine's. */
function size(name: string, fallback: number, most: number): number {
	const value = Number(process.env[name]);
	return Math.min(Number.isSafeInteger(value) && value > 0 ? value : fallback, most);
}

// a test worker is not told when its run was killed: it exits when its link to the run goes, and its slot with it
if (process.connected) process.once("disconnect", () => process.exit(1));

/** Below the ephemeral ports of macOS and Linux, so no connection the system opens is handed one. */
const FIRST = 31_500;

/** The sign-in flows' callback ports are fixed by pi-ai: a single holder. */
export const SIGN_IN: Slots = { first: FIRST, size: 1, patience: 120_000 };

/**
 * A browser test's page load is the most a test asks of the machine: one Chrome rendering, one Vite compiling, each of
 * several processes, so a slot is four cores. Every run on the machine must work this out alike, so it comes from the
 * machine alone.
 */
export const BROWSERS: Slots = {
	first: FIRST + 10,
	size: size("BANDA_TEST_BROWSERS", Math.max(2, Math.floor(availableParallelism() / 4)), 90),
};

/** Any other test file: as many at once as the machine has cores, whatever each run's own worker count. */
export const FILES: Slots = {
	first: FIRST + 100,
	size: size("BANDA_TEST_FILES", availableParallelism(), 400),
};

function bind(port: number): Promise<Server | undefined> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "EADDRINUSE") resolve(undefined);
			else reject(error);
		});
		server.listen({ port, host: "127.0.0.1", exclusive: true, backlog: 0 }, () => {
			server.removeAllListeners("error");
			// a slot held is no reason to keep the process alive
			server.unref();
			resolve(server);
		});
	});
}

/** Wait for a slot and hold it until the returned function runs or this process ends. */
export async function hold({ first, size, patience = Number.POSITIVE_INFINITY }: Slots): Promise<() => Promise<void>> {
	const started = Date.now();
	const end = started + patience;
	let told = false;
	for (;;) {
		// from a different place each time, so waiters do not all ask for the same port first
		const start = Math.floor(Math.random() * size);
		for (let offset = 0; offset < size; offset++) {
			const server = await bind(first + ((start + offset) % size));
			if (server !== undefined) return () => new Promise((resolve) => server.close(() => resolve()));
		}
		if (!told && Date.now() - started > 60_000) {
			told = true;
			console.error(
				`waiting for a test slot on 127.0.0.1:${first}-${first + size - 1}: other runs on this machine hold them all`,
			);
		}
		if (Date.now() > end)
			throw new Error(
				`no slot came free on 127.0.0.1:${first}-${first + size - 1} in ${patience / 1000} s: is something else listening there?`,
			);
		await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 100));
	}
}
