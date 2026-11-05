/**
 * Devices (DESIGN.md "Clients"): the owner's phones and other computers that reach the daemon over Iroh, each known by
 * its endpoint id, which the QUIC handshake authenticates. A device is paired by an invite the owner made: a secret,
 * single use, live for ten minutes, that an endpoint presents to ask to be paired; the owner approves or denies the
 * request, and the secret is spent either way. A revoked device stays listed, refused.
 *
 * One bookkeeping doc holds all of it, written in the commit that changes it. The store keeps an invite's hash, never
 * its secret.
 */
import { createHash, randomBytes } from "node:crypto";
import { defineDoc, type Tx } from "@earendil-works/pi-durable";

/** How long an invite is live, and a request made with it waits for the owner. */
export const INVITE_MS = 10 * 60_000;

/** An endpoint id as Iroh writes it: 32 bytes of ed25519 public key, in hex. */
export const ENDPOINT_ID = /^[0-9a-f]{64}$/;

/** The longest name a device may have. */
export const NAME_MAX = 64;

export type Device = {
	readonly name: string;
	/** When the owner approved it. */
	readonly paired: number;
	readonly revoked?: number;
};

export type Invite = {
	readonly made: number;
	readonly expires: number;
	/** The endpoint that presented it, and when: its request, or what the owner did with it. */
	readonly claimed?: { readonly by: string; readonly at: number };
	/** The owner approved or denied the request it was claimed for: it opens nothing again. */
	readonly spent?: { readonly at: number; readonly approved: boolean };
};

/** An endpoint asking to be paired, until the owner answers or its invite expires. */
export type PairingRequest = {
	readonly name: string;
	readonly at: number;
	/** The hash of the invite it presented. */
	readonly invite: string;
};

export type DevicesValue = {
	devices: { [id: string]: Device };
	invites: { [hash: string]: Invite };
	requests: { [id: string]: PairingRequest };
};

export const Devices = defineDoc<DevicesValue>({
	kind: "banda.devices",
	version: 1,
	scope: "session",
	initial: () => ({ devices: {}, invites: {}, requests: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});

/** Where an endpoint stands, as the pairing route tells it. */
export type PairingState = "paired" | "revoked" | "pending" | "denied" | "unpaired";

/** A new invite's secret: 32 random bytes, base64url. */
export const newSecret = () => randomBytes(32).toString("base64url");

export const hashOf = (secret: string) => createHash("sha256").update(secret, "utf8").digest("hex");

/** A device's name as given, trimmed; undefined when it is not one. */
export function deviceName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	// no control characters, nor bidi overrides that reorder what follows: a name reaches the daemon's log and the owner's screen
	const name = value
		.replace(/\s+/g, " ")
		.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, "")
		.trim();
	return name.length > 0 && name.length <= NAME_MAX ? name : undefined;
}

/** Drop what expired: invites past their time, and the requests made with them. */
function prune(doc: DevicesValue, now: number): void {
	for (const [hash, invite] of Object.entries(doc.invites)) if (invite.expires <= now) delete doc.invites[hash];
	for (const [id, request] of Object.entries(doc.requests))
		if (doc.invites[request.invite] === undefined) delete doc.requests[id];
}

/** Whether `id` is a paired device the owner has not revoked: such a device acts as the owner. */
export const isPaired = (doc: DevicesValue | undefined, id: string): boolean => {
	const device = doc?.devices[id];
	return device !== undefined && device.revoked === undefined;
};

/** Where endpoint `id` stands at `now`. */
export function pairingState(doc: DevicesValue | undefined, id: string, now: number): PairingState {
	const device = doc?.devices[id];
	if (device !== undefined) return device.revoked === undefined ? "paired" : "revoked";
	const request = doc?.requests[id];
	if (request !== undefined && (doc?.invites[request.invite]?.expires ?? 0) > now) return "pending";
	const denied = Object.values(doc?.invites ?? {}).some(
		(invite) => invite.claimed?.by === id && invite.spent?.approved === false && invite.expires > now,
	);
	return denied ? "denied" : "unpaired";
}

/** Make an invite for the secret whose hash is `hash`, live from `now` for `INVITE_MS`: when it expires. */
export async function makeInvite(tx: Tx, hash: string, now: number): Promise<number> {
	const doc = await tx.doc(Devices);
	prune(doc, now);
	doc.invites[hash] ??= { made: now, expires: now + INVITE_MS };
	return doc.invites[hash]?.expires ?? now + INVITE_MS;
}

/** What an owner's or a device's pairing act is refused with: why, and its HTTP status. */
export class Refused extends Error {
	readonly status: number;
	constructor(message: string, status = 403) {
		super(message);
		this.status = status;
	}
}

/** Why an invite is refused: unknown, expired, spent or another endpoint's. */
export const NOT_LIVE = "this invite is no longer valid: ask for a new one on the computer banda runs on";

/**
 * Endpoint `id` presents `secret`, asking to be paired as `name`: a live invite no one claimed becomes its pending
 * request, the invite claimed by it. Presenting it again while pending is the same request. Throws `Refused` when the
 * invite is unknown, expired, spent or another endpoint's.
 */
export async function requestPairing(
	tx: Tx,
	id: string,
	secret: string,
	name: string,
	now: number,
): Promise<PairingState> {
	const doc = await tx.doc(Devices);
	prune(doc, now);
	const already = pairingState(doc, id, now);
	if (already === "paired" || already === "pending") return already;
	if (already === "revoked") throw new Refused("this device was removed from banda");
	const hash = hashOf(secret);
	const invite = doc.invites[hash];
	if (invite === undefined || invite.spent !== undefined) throw new Refused(NOT_LIVE);
	if (invite.claimed !== undefined && invite.claimed.by !== id) throw new Refused(NOT_LIVE);
	doc.invites[hash] = { ...invite, claimed: { by: id, at: now } };
	doc.requests[id] = { name, at: now, invite: hash };
	return "pending";
}

/** The owner answers endpoint `id`'s request: approved, it is a device named `name` (or as it asked); its invite is spent either way. */
export async function answerRequest(tx: Tx, id: string, approved: boolean, now: number, name?: string): Promise<void> {
	const doc = await tx.doc(Devices);
	prune(doc, now);
	const request = doc.requests[id];
	if (request === undefined) {
		// answered already: the same answer again is done; anything else has nothing to answer
		if (approved && doc.devices[id] !== undefined) return;
		if (!approved && pairingState(doc, id, now) === "denied") return;
		throw new Refused("no device is asking to be paired with that id: it may have expired", 404);
	}
	const invite = doc.invites[request.invite];
	if (invite !== undefined) doc.invites[request.invite] = { ...invite, spent: { at: now, approved } };
	delete doc.requests[id];
	if (approved) doc.devices[id] = { name: name ?? request.name, paired: now };
}

/** Rename device `id`; throws `Refused` (404) when there is none. */
export async function renameDevice(tx: Tx, id: string, name: string): Promise<void> {
	const doc = await tx.doc(Devices);
	const device = doc.devices[id];
	if (device === undefined) throw new Refused("no such device", 404);
	doc.devices[id] = { ...device, name };
}

/** Revoke device `id` from `now` on: it stays listed, and is refused. Revoking it again changes nothing. */
export async function revokeDevice(tx: Tx, id: string, now: number): Promise<void> {
	const doc = await tx.doc(Devices);
	const device = doc.devices[id];
	if (device === undefined) throw new Refused("no such device", 404);
	if (device.revoked === undefined) doc.devices[id] = { ...device, revoked: now };
}
