import { type Static, Type } from "typebox";
import type { FaultPoint } from "./faults.ts";

export const SIGNIN_POINTS = [
	"oauth:taken",
	"oauth:exchanged",
	"oauth:kept",
	"account:read",
	"account:added",
	"account:switched",
	"connection:call",
	"connection:answered",
	"answer",
	"model",
] as const satisfies readonly FaultPoint[];

export const SigninScenario = Type.Object({ grant: Type.Boolean() }, { additionalProperties: false });
export type SigninScenario = Static<typeof SigninScenario>;

export const SigninSchedule = Type.Array(
	Type.Object({
		point: Type.Union([...SIGNIN_POINTS, "commit:before", "commit:after"].map((point) => Type.Literal(point))),
		hit: Type.Integer({ minimum: 1 }),
		kind: Type.Union([Type.Literal("error"), Type.Literal("kill")]),
	}),
);

export const SigninSummary = Type.Object({
	oldCompleted: Type.Boolean(),
	freshCompleted: Type.Boolean(),
	proofCompleted: Type.Boolean(),
	matchedGeneration: Type.Boolean(),
	sawUncommittedCredentials: Type.Boolean(),
	open: Type.Integer({ minimum: 0 }),
	parked: Type.Integer({ minimum: 0 }),
	commits: Type.Integer({ minimum: 0 }),
	points: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
});
export type SigninSummary = Static<typeof SigninSummary>;

export function signinProblems(summary: SigninSummary): string[] {
	const errors: string[] = [];
	if (!summary.oldCompleted) errors.push("old draft did not settle");
	if (!summary.freshCompleted) errors.push("fresh draft did not settle");
	if (!summary.proofCompleted) errors.push("owner could not approve new work after recovery");
	if (!summary.matchedGeneration) errors.push("recovered credential and account generations disagree");
	if (summary.open !== 0 || summary.parked !== 0) errors.push("recovery left waiting work");
	return errors;
}
