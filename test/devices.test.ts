/** Devices: invites are single use and expire; the owner's answer spends them; a revoked device is refused. */

import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, type Harness } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import {
	answerRequest,
	Devices,
	hashOf,
	INVITE_MS,
	isPaired,
	makeInvite,
	pairingState,
	Refused,
	renameDevice,
	requestPairing,
	revokeDevice,
} from "../src/core/devices.ts";
import { context, openStore } from "../src/core/store.ts";
import { tempHome } from "./helpers.ts";

const PHONE = "a".repeat(64);
const OTHER = "b".repeat(64);

const stores: Harness[] = [];
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close(context);
});

async function store(): Promise<Harness> {
	const harness = await openStore(await tempHome(), { models: createModels(), registry: createRegistry() });
	stores.push(harness);
	return harness;
}

const doc = (harness: Harness) => harness.snapshot(Devices, context);

describe("pairing a device", () => {
	it("takes a live invite once: the endpoint that presents it waits for the owner, any other is refused", async () => {
		const harness = await store();
		await harness.commit((tx) => makeInvite(tx, hashOf("s1"), 1000), context);
		expect(await harness.commit((tx) => requestPairing(tx, PHONE, "s1", "Pixel", 2000), context)).toBe("pending");
		// the same endpoint again is the same request
		expect(await harness.commit((tx) => requestPairing(tx, PHONE, "s1", "Pixel", 3000), context)).toBe("pending");
		await expect(harness.commit((tx) => requestPairing(tx, OTHER, "s1", "Mine", 3000), context)).rejects.toThrow(
			Refused,
		);
		await expect(harness.commit((tx) => requestPairing(tx, OTHER, "nope", "Mine", 3000), context)).rejects.toThrow(
			Refused,
		);
		expect(pairingState(await doc(harness), PHONE, 3000)).toBe("pending");
		expect(pairingState(await doc(harness), OTHER, 3000)).toBe("unpaired");
		expect(isPaired(await doc(harness), PHONE)).toBe(false);

		await harness.commit((tx) => answerRequest(tx, PHONE, true, 4000, "Alex's phone"), context);
		const after = await doc(harness);
		expect(after?.devices[PHONE]).toEqual({ name: "Alex's phone", paired: 4000 });
		expect(after?.requests).toEqual({});
		expect(isPaired(after, PHONE)).toBe(true);
		// spent: approving again is done, and the secret opens nothing more, for anyone
		await harness.commit((tx) => answerRequest(tx, PHONE, true, 5000), context);
		await expect(harness.commit((tx) => requestPairing(tx, OTHER, "s1", "Mine", 5000), context)).rejects.toThrow(
			Refused,
		);
	});

	it("expires an invite after ten minutes, and the request made with it", async () => {
		const harness = await store();
		await harness.commit((tx) => makeInvite(tx, hashOf("late"), 0), context);
		await expect(
			harness.commit((tx) => requestPairing(tx, PHONE, "late", "Pixel", INVITE_MS), context),
		).rejects.toThrow(/no longer valid/);
		await harness.commit((tx) => makeInvite(tx, hashOf("s2"), 0), context);
		await harness.commit((tx) => requestPairing(tx, PHONE, "s2", "Pixel", INVITE_MS - 1), context);
		expect(pairingState(await doc(harness), PHONE, INVITE_MS - 1)).toBe("pending");
		expect(pairingState(await doc(harness), PHONE, INVITE_MS)).toBe("unpaired");
		await expect(harness.commit((tx) => answerRequest(tx, PHONE, true, INVITE_MS), context)).rejects.toThrow(
			/no device is asking/,
		);
		// the next change prunes what expired: the store does not keep them
		await harness.commit((tx) => makeInvite(tx, hashOf("s9"), INVITE_MS), context);
		expect(Object.keys((await doc(harness))?.invites ?? {})).toEqual([hashOf("s9")]);
		expect((await doc(harness))?.requests).toEqual({});
		expect((await doc(harness))?.devices).toEqual({});
	});

	it("spends the invite when the owner denies, and tells the endpoint it was denied", async () => {
		const harness = await store();
		await harness.commit((tx) => makeInvite(tx, hashOf("s3"), 0), context);
		await harness.commit((tx) => requestPairing(tx, PHONE, "s3", "Pixel", 1), context);
		await harness.commit((tx) => answerRequest(tx, PHONE, false, 2), context);
		expect(pairingState(await doc(harness), PHONE, 3)).toBe("denied");
		await expect(harness.commit((tx) => requestPairing(tx, PHONE, "s3", "Pixel", 3), context)).rejects.toThrow(Refused);
		expect((await doc(harness))?.devices).toEqual({});
		// denying again is done; approving what was denied has nothing to approve
		await harness.commit((tx) => answerRequest(tx, PHONE, false, 4), context);
		await expect(harness.commit((tx) => answerRequest(tx, PHONE, true, 4), context)).rejects.toThrow(Refused);
	});

	it("renames and revokes a device: revoked, it stays listed, refused, and pairs no more", async () => {
		const harness = await store();
		await harness.commit((tx) => makeInvite(tx, hashOf("s4"), 0), context);
		await harness.commit((tx) => requestPairing(tx, PHONE, "s4", "Pixel", 1), context);
		await harness.commit((tx) => answerRequest(tx, PHONE, true, 2), context);
		await harness.commit((tx) => renameDevice(tx, PHONE, "Pixel 9"), context);
		await harness.commit((tx) => revokeDevice(tx, PHONE, 3), context);
		await harness.commit((tx) => revokeDevice(tx, PHONE, 9), context);
		const after = await doc(harness);
		expect(after?.devices[PHONE]).toEqual({ name: "Pixel 9", paired: 2, revoked: 3 });
		expect(isPaired(after, PHONE)).toBe(false);
		expect(pairingState(after, PHONE, 4)).toBe("revoked");
		await harness.commit((tx) => makeInvite(tx, hashOf("s5"), 4), context);
		await expect(harness.commit((tx) => requestPairing(tx, PHONE, "s5", "Pixel", 5), context)).rejects.toThrow(
			/removed/,
		);
		await expect(harness.commit((tx) => renameDevice(tx, OTHER, "x"), context)).rejects.toThrow(Refused);
	});

	it("keeps the invite's hash, never its secret", async () => {
		const harness = await store();
		await harness.commit((tx) => makeInvite(tx, hashOf("a-secret"), 0), context);
		expect(JSON.stringify(await doc(harness))).not.toContain("a-secret");
	});
});
