/**
 * Remote reach, end to end on loopback: a daemon with its Iroh endpoint, and a device that dials it, pairs with an
 * invite the owner made and the owner approves, reaches the API as the owner without the token, and is refused once
 * the owner revokes it.
 */
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { DevicesView, InviteView, ShellEvent } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { events, testDevice } from "./fixtures/iroh-client.ts";
import { echoModels, tempHome } from "./helpers.ts";

/** The owner's call on loopback, with the token: the answer, as the caller reads it. */
type Owner = <T = DevicesView>(method: string, path: string, body?: unknown) => Promise<T>;

async function start(home: string): Promise<{ daemon: Daemon; owner: Owner }> {
	await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
	const daemon = await startDaemon({
		home,
		port: 0,
		models: echoModels().models,
		log: () => {},
		box: hostBox(home),
		remote: { reach: "loopback" },
	});
	const { token } = (await readDaemonFile(home))!;
	const owner: Owner = async <T>(method: string, path: string, body?: unknown) => {
		const response = await fetch(`http://127.0.0.1:${daemon.port}/api${path}`, {
			method,
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const answer = (await response.json()) as T;
		if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(answer)}`);
		return answer;
	};
	return { daemon, owner };
}

describe("remote reach over Iroh", () => {
	it("pairs a device the owner approves, lets it act as the owner, and refuses it once revoked", async () => {
		const home = await tempHome();
		const { daemon, owner } = await start(home);
		const phone = await testDevice();
		const stranger = await testDevice();
		try {
			const invite = await owner<InviteView>("POST", "/devices/invites");
			expect(invite.pairing).toBe(
				`banda://pair?ticket=${encodeURIComponent(invite.ticket)}&invite=${encodeURIComponent(invite.secret)}`,
			);
			expect(invite.expires - Date.now()).toBeGreaterThan(9 * 60_000);

			await phone.dial(invite.ticket);
			// not paired: the API is closed to it, whatever it sends, the owner's token included
			const { token } = (await readDaemonFile(home))!;
			expect(await phone.request("GET", "/api/status", undefined, { authorization: `Bearer ${token}` })).toEqual({
				status: 403,
				body: { error: "this device is not paired" },
			});
			expect((await phone.request("GET", "/")).status).toBe(403);
			expect(await phone.request("GET", "/api/devices/pair")).toEqual({ status: 200, body: { state: "unpaired" } });
			expect((await phone.request("POST", "/api/devices/pair", { invite: "wrong", name: "Pixel" })).status).toBe(403);

			expect(await phone.request("POST", "/api/devices/pair", { invite: invite.secret, name: "Pixel" })).toEqual({
				status: 202,
				body: { state: "pending" },
			});
			// single use: another endpoint presenting the same secret is refused
			await stranger.dial(invite.ticket);
			expect((await stranger.request("POST", "/api/devices/pair", { invite: invite.secret })).status).toBe(403);

			const waiting: DevicesView = await owner("GET", "/devices");
			expect(waiting.endpoint?.reach).toBe("loopback");
			expect(waiting.requests).toEqual([expect.objectContaining({ id: phone.id, name: "Pixel" })]);
			expect(waiting.devices).toEqual([]);

			const approved: DevicesView = await owner("POST", `/devices/requests/${phone.id}/approve`, {
				name: "Alex's phone",
			});
			expect(approved.requests).toEqual([]);
			expect(approved.devices).toEqual([
				expect.objectContaining({ id: phone.id, name: "Alex's phone", connected: true }),
			]);
			expect(await phone.request("GET", "/api/devices/pair")).toEqual({ status: 200, body: { state: "paired" } });

			// the owner now, by its endpoint id alone: no token, a Host loopback would refuse
			const status = await phone.request("GET", "/api/status");
			expect(status.status).toBe(200);
			// the shell stream, devices in it, over a stream that stays open
			const shell = events(await phone.stream("/api/events"));
			const shown = await shell.next<ShellEvent>((event) => event.type === "devices");
			expect(shown).toMatchObject({ type: "devices", devices: { devices: [{ id: phone.id }] } });
			await owner("PUT", `/devices/${phone.id}`, { name: "Pixel 9" });
			await shell.next<ShellEvent>((event) => event.type === "devices" && event.devices.devices[0]?.name === "Pixel 9");

			const connection = await phone.dial(invite.ticket);
			// answered on it: the daemon holds this connection now. A dial returns before the daemon has accepted it, and
			// one it accepts after the revoke is held as any endpoint that is not a device, never closed as revoked
			expect(await phone.request("GET", "/api/devices/pair")).toEqual({ status: 200, body: { state: "paired" } });
			const revoked: DevicesView = await owner("POST", `/devices/${phone.id}/revoke`);
			expect(revoked.devices).toEqual([expect.objectContaining({ id: phone.id, revoked: expect.any(Number) })]);
			// its live connections are closed, and it is told so: the reason is the daemon's word for a revoke
			expect(await connection.closed()).toMatch(/revoked/);
			// dialed again, it is held as any endpoint that is not a device: the API closed, and the pairing route says why
			await phone.dial(invite.ticket);
			expect((await phone.request("GET", "/api/status")).status).toBe(403);
			expect(await phone.request("GET", "/api/devices/pair")).toEqual({ status: 200, body: { state: "revoked" } });
			expect((await phone.request("POST", "/api/devices/pair", { invite: invite.secret })).status).toBe(403);
			expect((await owner("GET", "/devices")).devices[0].connected).toBe(false);
		} finally {
			await phone.close();
			await stranger.close();
			await daemon.close();
		}
	});

	it("lets a paired device read its fellow devices, and leaves pairing, renaming and revoking to the computer", async () => {
		const home = await tempHome();
		const { daemon, owner } = await start(home);
		const phone = await testDevice();
		const other = await testDevice();
		try {
			const invite = await owner<InviteView>("POST", "/devices/invites");
			await phone.dial(invite.ticket);
			await phone.request("POST", "/api/devices/pair", { invite: invite.secret, name: "Pixel" });
			await owner("POST", `/devices/requests/${phone.id}/approve`, {});
			const listed = await phone.request("GET", "/api/devices");
			expect(listed.status).toBe(200);
			expect((listed.body as DevicesView).devices).toEqual([expect.objectContaining({ id: phone.id })]);

			// a device makes no invite: a phone (or a page in its app) cannot mint access that outlives its own
			const here = { error: "devices are paired, renamed and revoked on the computer banda runs on" };
			expect(await phone.request("POST", "/api/devices/invites")).toEqual({ status: 403, body: here });
			const second = await owner<InviteView>("POST", "/devices/invites");
			await other.dial(second.ticket);
			expect((await other.request("POST", "/api/devices/pair", { invite: second.secret, name: "Pixel" })).status).toBe(
				202,
			);
			for (const [method, path, body] of [
				["POST", `/api/devices/requests/${other.id}/approve`, {}],
				["POST", `/api/devices/requests/${other.id}/deny`, undefined],
				["PUT", `/api/devices/${phone.id}`, { name: "Mine" }],
				["POST", `/api/devices/${phone.id}/revoke`, undefined],
			] as const)
				expect(await phone.request(method, path, body)).toEqual({ status: 403, body: here });
			const after = await owner("GET", "/devices");
			expect(after.requests).toEqual([expect.objectContaining({ id: other.id })]);
			expect(after.devices).toEqual([expect.objectContaining({ id: phone.id, name: "Pixel" })]);
			expect(after.devices[0]?.revoked).toBeUndefined();
		} finally {
			await phone.close();
			await other.close();
			await daemon.close();
		}
	});

	it("reads no more of a pairing request than a pairing needs, before it knows who asks", async () => {
		const home = await tempHome();
		const { daemon, owner } = await start(home);
		const stranger = await testDevice();
		try {
			const invite = await owner<InviteView>("POST", "/devices/invites");
			const connection = await stranger.dial(invite.ticket);
			const said = await stranger.request("POST", "/api/devices/pair", {
				invite: invite.secret,
				name: "x".repeat(8192),
			});
			expect(said.status).toBe(413);
			// a body with no length, streamed on and on: let go of long before it ends
			const bi = await connection.openBi();
			await bi.send.writeAll(
				Array.from(
					Buffer.from(
						"POST /api/devices/pair HTTP/1.1\r\nhost: banda.iroh\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n",
					),
				),
			);
			const chunk = Array.from(Buffer.from(`10000\r\n${"a".repeat(0x10000)}\r\n`));
			let sent = 0;
			try {
				for (; sent < 4096; sent++) await bi.send.writeAll(chunk);
			} catch {
				// reset: the daemon stopped reading
			}
			expect(sent).toBeLessThan(4096);
			// neither touched the invite: it still pairs
			expect((await stranger.request("POST", "/api/devices/pair", { invite: invite.secret })).status).toBe(202);
		} finally {
			await stranger.close();
			await daemon.close();
		}
	});

	it("answers a device that finished its side right after asking, and lets go of a stream that asked nothing", async () => {
		const home = await tempHome();
		const { daemon, owner } = await start(home);
		const phone = await testDevice();
		try {
			const invite = await owner<InviteView>("POST", "/devices/invites");
			const connection = await phone.dial(invite.ticket);
			await phone.request("POST", "/api/devices/pair", { invite: invite.secret });
			await owner("POST", `/devices/requests/${phone.id}/approve`, {});
			// asked, then finished at once: the stream of events still comes, and stays open
			const asked = await connection.openBi();
			await asked.send.writeAll(Array.from(Buffer.from("GET /api/events HTTP/1.1\r\nhost: banda.iroh\r\n\r\n")));
			await asked.send.finish();
			let answer = "";
			while (!answer.includes('"type":"devices"')) {
				const chunk = await asked.recv.read(1 << 16);
				if (chunk.length === 0) break;
				answer += Buffer.from(chunk).toString("utf8");
			}
			expect(answer).toMatch(/^HTTP\/1\.1 200 /);
			expect(answer).toContain('"type":"devices"');
			const idle = await connection.openBi();
			await idle.send.writeAll([]);
			await idle.send.finish();
			expect(await idle.recv.readToEnd(1 << 16)).toEqual([]);
		} finally {
			await phone.close();
			await daemon.close();
		}
	});

	it("keeps its endpoint id across a restart, its key owner-only", async () => {
		const home = await tempHome();
		const first = await start(home);
		const id = ((await first.owner("GET", "/devices")) as DevicesView).endpoint?.id;
		await first.daemon.close();
		expect(id).toMatch(/^[0-9a-f]{64}$/);
		expect((await stat(join(home, "auth", "iroh.key"))).mode & 0o777).toBe(0o600);
		const second = await start(home);
		try {
			expect(((await second.owner("GET", "/devices")) as DevicesView).endpoint?.id).toBe(id);
		} finally {
			await second.daemon.close();
		}
	});

	it("binds no endpoint when remote reach is off, and makes no invite", async () => {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const daemon = await startDaemon({
			home,
			port: 0,
			models: echoModels().models,
			log: () => {},
			box: hostBox(home),
			remote: { reach: "off" },
		});
		const { token } = (await readDaemonFile(home))!;
		const owner = (path: string, method = "GET") =>
			fetch(`http://127.0.0.1:${daemon.port}/api${path}`, { method, headers: { authorization: `Bearer ${token}` } });
		try {
			expect(await (await owner("/devices")).json()).toEqual({
				remote: "off",
				endpoint: null,
				devices: [],
				requests: [],
			});
			expect((await owner("/devices/invites", "POST")).status).toBe(409);
		} finally {
			await daemon.close();
		}
	});

	it("binds no public endpoint until a device is paired or an invite is made", async () => {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const daemon = await startDaemon({
			home,
			port: 0,
			models: echoModels().models,
			log: () => {},
			box: hostBox(home),
			remote: { reach: "n0" },
		});
		const { token } = (await readDaemonFile(home))!;
		try {
			const view = await (
				await fetch(`http://127.0.0.1:${daemon.port}/api/devices`, { headers: { authorization: `Bearer ${token}` } })
			).json();
			expect(view).toEqual({ remote: "idle", endpoint: null, devices: [], requests: [] });
			// no endpoint was bound, so no key was made either
			await expect(stat(join(home, "auth", "iroh.key"))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await daemon.close();
		}
	});
});
