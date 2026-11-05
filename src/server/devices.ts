/**
 * Devices in the app (DESIGN.md "Clients"): the owner makes an invite (`POST /api/devices/invites`), whose pairing
 * link the app shows as a QR code; a device that dials the daemon over Iroh presents it (`POST /api/devices/pair`) and
 * waits, polling the same route, while the owner approves or denies it; the owner lists, renames and revokes devices.
 * Every change is one commit to the `Devices` doc, and reaches the app as the `devices` shell event. Only the computer
 * banda runs on changes them: a device reads the list, so a phone (or a page in its app) cannot mint access that
 * outlives its own revocation.
 */
import type { Harness } from "@earendil-works/pi-durable";
import {
	answerRequest,
	Devices,
	type DevicesValue,
	deviceName,
	ENDPOINT_ID,
	hashOf,
	isPaired,
	makeInvite,
	NOT_LIVE,
	newSecret,
	pairingState,
	Refused,
	renameDevice,
	requestPairing,
	revokeDevice,
} from "../core/devices.ts";
import { context } from "../core/store.ts";
import type { DevicesView, InviteView, PairingView } from "./api.ts";
import { BadRequest, type RemoteGate } from "./http.ts";
import type { Remote, RemoteState } from "./remote.ts";
import type { Area, AreaReply, AreaRequest } from "./routes/area.ts";

export type DevicesDesk = {
	readonly area: Area;
	/** What the HTTP server, and the endpoint, ask of a request that came over Iroh. */
	readonly gate: RemoteGate;
	/**
	 * Whether an endpoint that is not a paired device is let in over Iroh now: while an invite is live, or when the
	 * daemon knows it (a device, revoked too, so it learns it was; or one with a request waiting).
	 */
	readonly admits: (id: string) => Promise<boolean>;
	/** Whether any device is paired and not revoked: the daemon binds its endpoint at start for one. */
	readonly anyPaired: () => Promise<boolean>;
};

/** Why a device is refused what only the owner's computer does. */
const HERE = "devices are paired, renamed and revoked on the computer banda runs on";

/** The pairing link a QR code carries: the daemon's ticket and the invite's secret. */
export const pairingLink = (ticket: string, secret: string) =>
	`banda://pair?ticket=${encodeURIComponent(ticket)}&invite=${encodeURIComponent(secret)}`;

export function openDevices({
	harness,
	remote,
	state = () => (remote() === undefined ? "off" : "on"),
	bind = async () => {
		const bound = remote();
		if (bound === undefined) throw new Error("remote reach is off on this computer");
		return bound;
	},
	changed,
	log = () => {},
	now = Date.now,
}: {
	readonly harness: Harness;
	/** The endpoint, once bound; undefined while it is not. */
	readonly remote: () => Remote | undefined;
	/** Where remote reach stands. */
	readonly state?: () => RemoteState;
	/** Bind the endpoint, if it is not bound: an invite needs it. Rejects when remote reach is off or unavailable. */
	readonly bind?: () => Promise<Remote>;
	readonly changed: () => void;
	/** Where a paired device's requests are logged: which device, the method and the path, never a body. */
	readonly log?: (line: string) => void;
	readonly now?: () => number;
}): DevicesDesk {
	const read = async (): Promise<DevicesValue | undefined> => harness.snapshot(Devices, context);
	const refusing = async <T>(run: () => Promise<T>): Promise<T> => {
		try {
			return await run();
		} catch (error) {
			if (error instanceof Refused) throw new BadRequest(error.message, error.status);
			throw error;
		}
	};

	const view = async (): Promise<DevicesView> => {
		const doc = await read();
		const at = now();
		const reach = remote();
		return {
			remote: state(),
			endpoint: reach === undefined ? null : { id: reach.id, reach: reach.reach },
			devices: Object.entries(doc?.devices ?? {})
				.map(([id, device]) => ({
					id,
					name: device.name,
					paired: device.paired,
					...(device.revoked === undefined ? {} : { revoked: device.revoked }),
					connected: device.revoked === undefined && (reach?.connected(id) ?? false),
				}))
				.sort((a, b) => b.paired - a.paired),
			requests: Object.entries(doc?.requests ?? {})
				.flatMap(([id, request]) => {
					const expires = doc?.invites[request.invite]?.expires ?? 0;
					return expires > at ? [{ id, name: request.name, at: request.at, expires }] : [];
				})
				.sort((a, b) => a.at - b.at),
		};
	};

	const invite = async (): Promise<InviteView> => {
		const at = state();
		if (at === "off") throw new BadRequest("remote reach is off on this computer", 409);
		if (at === "unavailable") throw new BadRequest("remote reach is not available on this computer", 409);
		let reach: Remote;
		try {
			reach = await bind();
		} catch (error) {
			throw new BadRequest(
				`could not start remote reach: ${error instanceof Error ? error.message : String(error)}`,
				503,
			);
		}
		const ticket = await reach.ticket();
		const secret = newSecret();
		const expires = await harness.commit((tx) => makeInvite(tx, hashOf(secret), now()), context);
		return { secret, ticket, expires, pairing: pairingLink(ticket, secret) };
	};

	const endpointId = (id: string | undefined) => {
		if (id === undefined || !ENDPOINT_ID.test(id)) throw new BadRequest("no such device", 404);
		return id;
	};

	const route = async ({ method, path, json, device }: AreaRequest): Promise<AreaReply | undefined> => {
		if (path === "/devices" && method === "GET") return { body: await view() };
		if (device !== undefined && path.startsWith("/devices/") && path !== "/devices/pair")
			throw new BadRequest(HERE, 403);
		if (path === "/devices/invites" && method === "POST") return { body: await invite() };
		// pairing is a device's, over Iroh: the gate answers it before the areas
		if (path === "/devices/pair") throw new BadRequest("a device pairs over Iroh, not on this computer", 400);
		const answering = /^\/devices\/requests\/([^/]+)\/(approve|deny)$/.exec(path);
		if (answering !== null && method === "POST") {
			const id = endpointId(answering[1]);
			const approved = answering[2] === "approve";
			const body = approved ? await json() : {};
			const name = body.name === undefined ? undefined : deviceName(body.name);
			if (body.name !== undefined && name === undefined) throw new BadRequest(`a device's name is 1 to 64 characters`);
			await refusing(() => harness.commit((tx) => answerRequest(tx, id, approved, now(), name), context));
			changed();
			return { body: await view() };
		}
		const revoking = /^\/devices\/([^/]+)\/revoke$/.exec(path);
		if (revoking !== null && method === "POST") {
			const id = endpointId(revoking[1]);
			await refusing(() => harness.commit((tx) => revokeDevice(tx, id, now()), context));
			// committed first, then dropped: a connection the accept loop is checking sees the revoke, or is dropped here
			remote()?.drop(id);
			changed();
			return { body: await view() };
		}
		const renaming = /^\/devices\/([^/]+)$/.exec(path);
		if (renaming !== null && method === "PUT") {
			const id = endpointId(renaming[1]);
			const name = deviceName((await json()).name);
			if (name === undefined) throw new BadRequest(`a device's name is 1 to 64 characters`);
			await refusing(() => harness.commit((tx) => renameDevice(tx, id, name), context));
			changed();
			return { body: await view() };
		}
		return undefined;
	};

	const pair = async (id: string, { method, json }: AreaRequest): Promise<AreaReply> => {
		if (method === "GET") return { body: { state: pairingState(await read(), id, now()) } satisfies PairingView };
		if (method !== "POST") return { status: 405, body: { error: "method not allowed" } };
		const body = await json();
		if (typeof body.invite !== "string" || body.invite.length > 128)
			return { status: 400, body: { error: "invite is the secret the pairing link carries" } };
		const name = body.name === undefined ? "Device" : deviceName(body.name);
		if (name === undefined) return { status: 400, body: { error: "a device's name is 1 to 64 characters" } };
		const secret = body.invite;
		// a secret no live invite has is refused from a read: a stranger's guesses commit nothing
		const known = await read();
		const live = known?.invites[hashOf(secret)];
		const state = pairingState(known, id, now());
		if (
			state !== "paired" &&
			state !== "pending" &&
			state !== "revoked" &&
			(live === undefined || live.expires <= now())
		)
			return { status: 403, body: { error: NOT_LIVE } };
		try {
			const state = await harness.commit((tx) => requestPairing(tx, id, secret, name, now()), context);
			if (state === "pending") changed();
			return { status: state === "pending" ? 202 : 200, body: { state } satisfies PairingView };
		} catch (error) {
			if (error instanceof Refused) return { status: error.status, body: { error: error.message } };
			throw error;
		}
	};

	return {
		area: { watch: [Devices], shell: async () => [{ type: "devices", devices: await view() }], route },
		admits: async (id) => {
			const doc = await read();
			if (doc === undefined) return false;
			if (doc.devices[id] !== undefined || doc.requests[id] !== undefined) return true;
			const at = now();
			return Object.values(doc.invites).some((invite) => invite.spent === undefined && invite.expires > at);
		},
		anyPaired: async () => {
			const doc = await read();
			return Object.keys(doc?.devices ?? {}).some((id) => isPaired(doc, id));
		},
		gate: {
			paired: async (id) => isPaired(await read(), id),
			pair,
			heard: (id, method, path) => {
				void read().then(
					(doc) => log(`remote: ${doc?.devices[id]?.name ?? "device"} (${id.slice(0, 8)}) ${method} ${path}`),
					() => log(`remote: device (${id.slice(0, 8)}) ${method} ${path}`),
				);
			},
		},
	};
}
