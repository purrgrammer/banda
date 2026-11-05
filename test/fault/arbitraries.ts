import fc from "fast-check";
import { type Inbound, type Origin, OWNER } from "../../src/core/gateway.ts";
import { REACT, SAY } from "../fixtures/models.ts";
import type { Fault, FaultPoint } from "./faults.ts";

export const ORIGINS: readonly Origin[] = [
	{ gateway: "fake", peer: "alice" },
	{ gateway: "fake", peer: "bob" },
	{ gateway: "fake", peer: "alice", thread: "t" },
	// every reply here is refused, so the owner is told on their own origin
	{ gateway: "fake", peer: "gone" },
	// the owner, whose input steers, and whose run's final text is its reply when it said nothing
	{ gateway: "fake", peer: OWNER },
];

/**
 * Messages from a few origins, ids unique, in the order they arrive; some answered with a reaction alone, some in the
 * final text alone.
 */
export const messagesArb = (maxLength = 6): fc.Arbitrary<Inbound[]> =>
	fc
		.array(fc.tuple(fc.integer({ min: 0, max: ORIGINS.length - 1 }), fc.constantFrom("", REACT, SAY)), {
			minLength: 1,
			maxLength,
		})
		.map((picks) => picks.map(([o, how], i) => ({ id: `m${i}`, origin: ORIGINS[o]!, text: `${how}text ${i}` })));

/** What happens after each message arrives: nothing, its redelivery, or a restart of the daemon. */
export type After = "none" | "redeliver" | "restart";
export const afterArb = (length: number): fc.Arbitrary<After[]> =>
	fc.array(fc.constantFrom<After>("none", "redeliver", "restart"), { minLength: length, maxLength: length });

export const faultsArb = (
	points: readonly FaultPoint[],
	kind: Fault["kind"],
	{ maxHit, maxFaults }: { maxHit: number; maxFaults: number },
): fc.Arbitrary<Fault[]> =>
	fc.array(
		fc.record({ point: fc.constantFrom(...points), hit: fc.integer({ min: 1, max: maxHit }), kind: fc.constant(kind) }),
		{ maxLength: maxFaults },
	);
