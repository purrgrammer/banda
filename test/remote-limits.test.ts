/**
 * What an endpoint that is not a paired device may hold of the daemon's endpoint (`remote.ts`): any endpoint that
 * knows the daemon's id can dial it, and keys cost nothing, so each such endpoint gets one stream at a time, answered
 * within a deadline, on a connection that lives a short while, and only so many of them at once. A paired device is
 * held to none of it.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openRemote, type Remote, type Unpaired } from "../src/server/remote.ts";
import { testDevice } from "./fixtures/iroh-client.ts";
import { tempHome } from "./helpers.ts";

const LIMITS: Unpaired = { connections: 2, lifeMs: 1500, requestMs: 400 };

async function rig(paired: Set<string>, limits = LIMITS, admits?: (id: string) => Promise<boolean>) {
	// one request a stream, as the daemon's handler answers over Iroh
	const server = createServer((_, res) =>
		res.writeHead(200, { "content-type": "application/json", connection: "close" }).end("{}"),
	);
	const changes: number[] = [];
	const remote: Remote = await openRemote({
		home: await tempHome(),
		settings: { reach: "loopback" },
		server,
		paired: async (id) => paired.has(id),
		...(admits === undefined ? {} : { admits }),
		changed: () => changes.push(Date.now()),
		log: () => {},
		unpaired: limits,
	});
	return { remote, ticket: await remote.ticket(), changes };
}

type Dialed = Awaited<ReturnType<Awaited<ReturnType<typeof testDevice>>["dial"]>>;

/** Send `ask` on a new stream; then its answer, and when it ended (or that it was reset). */
async function send(connection: Dialed, ask: string) {
	const bi = await connection.openBi();
	await bi.send.writeAll(Array.from(Buffer.from(ask)));
	return async () => {
		let text = "";
		try {
			for (;;) {
				const chunk = await bi.recv.read(1 << 16);
				if (chunk.length === 0) break;
				text += Buffer.from(chunk).toString("utf8");
			}
		} catch {
			// reset: the daemon let go of it
		}
		return { text, at: Date.now() };
	};
}

const exchange = async (connection: Dialed, ask: string) => (await send(connection, ask))();

const GET = "GET /api/devices/pair HTTP/1.1\r\nhost: banda.iroh\r\n\r\n";

describe("an endpoint that is not a paired device", () => {
	it("is served one stream at a time, each let go of when it is not answered in time", async () => {
		const { remote, ticket } = await rig(new Set());
		const stranger = await testDevice();
		try {
			const connection = await stranger.dial(ticket);
			const started = Date.now();
			// asks nothing whole: it holds its stream until the deadline lets go of it
			const held = await send(connection, "G");
			const next = await send(connection, GET);
			const [first, second] = await Promise.all([held(), next()]);
			expect(first.text).toBe("");
			expect(first.at - started).toBeGreaterThanOrEqual(LIMITS.requestMs - 50);
			expect(second.text).toMatch(/^HTTP\/1\.1 200 /);
			// served only once the first was let go of (when its reset reaches this side is the network's to say)
			expect(second.at - started).toBeGreaterThanOrEqual(LIMITS.requestMs - 50);
		} finally {
			await stranger.close();
			await remote.close();
		}
	});

	it("holds a connection a short while, and only so many at once, the oldest making room; a paired device is held to neither", async () => {
		const phone = await testDevice();
		const { remote, ticket, changes } = await rig(new Set([phone.id]));
		const strangers = await Promise.all([testDevice(), testDevice(), testDevice()]);
		try {
			// one after the other: the first is the one held longest
			const first = await strangers[0]!.dial(ticket);
			const second = await strangers[1]!.dial(ticket);
			// both held: each answers
			expect((await exchange(first, GET)).text).toMatch(/^HTTP\/1\.1 200 /);
			expect((await exchange(second, GET)).text).toMatch(/^HTTP\/1\.1 200 /);
			expect(changes).toEqual([]);
			// a third gets in, and the one held longest makes room: strangers that keep dialing race a phone, never shut it out
			const third = await strangers[2]!.dial(ticket);
			expect((await exchange(third, GET)).text).toMatch(/^HTTP\/1\.1 200 /);
			expect(await first.closed()).toMatch(/busy/);
			// a paired device still gets in, with streams at once
			const mine = await phone.dial(ticket);
			const [a, b] = await Promise.all([exchange(mine, GET), exchange(mine, GET)]);
			expect([a.text, b.text]).toEqual([
				expect.stringMatching(/^HTTP\/1\.1 200 /),
				expect.stringMatching(/^HTTP\/1\.1 200 /),
			]);
			expect(changes.length).toBeGreaterThan(0);
			// an unpaired connection is let go of once its time is up: the device dials again for its next look
			expect(await second.closed()).toMatch(/again/);
			expect(remote.connected(phone.id)).toBe(true);
		} finally {
			for (const each of strangers) await each.close();
			await phone.close();
			await remote.close();
		}
	});

	it("is let in only while the daemon has a reason to hear it", async () => {
		const known = await testDevice();
		const stranger = await testDevice();
		const { remote, ticket } = await rig(new Set(), LIMITS, async (id) => id === known.id);
		try {
			expect((await exchange(await known.dial(ticket), GET)).text).toMatch(/^HTTP\/1\.1 200 /);
			expect(await (await stranger.dial(ticket)).closed()).toMatch(/again/);
		} finally {
			await known.close();
			await stranger.close();
			await remote.close();
		}
	});

	it("is told the daemon is closing, never refused, when it dials while the daemon stops", async () => {
		const phone = await testDevice();
		const { remote, ticket } = await rig(new Set([phone.id]));
		try {
			const connection = await phone.dial(ticket);
			await exchange(connection, GET);
			await remote.close();
			expect(await connection.closed()).toMatch(/closing/);
		} finally {
			await phone.close();
		}
	});

	it("refuses an endpoint key that is not one, rather than making a new id every phone would lose", async () => {
		const home = await tempHome();
		await mkdir(join(home, "auth"), { recursive: true });
		await writeFile(join(home, "auth", "iroh.key"), "short");
		await expect(
			openRemote({
				home,
				settings: { reach: "loopback" },
				server: createServer(),
				paired: async () => false,
				changed: () => {},
				log: () => {},
			}),
		).rejects.toThrow(/not an endpoint key/);
		expect(await readFile(join(home, "auth", "iroh.key"), "utf8")).toBe("short");
	});
});
