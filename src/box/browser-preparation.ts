import { type Static, Type } from "typebox";
import type { BrowserSetup } from "./browser.ts";

export const BrowserPreparation = Type.Union([
	Type.Object({ state: Type.Literal("unavailable") }, { additionalProperties: false }),
	Type.Object({ state: Type.Literal("idle") }, { additionalProperties: false }),
	Type.Object(
		{ state: Type.Literal("preparing"), phase: Type.Union([Type.Literal("checking"), Type.Literal("starting")]) },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			state: Type.Literal("preparing"),
			phase: Type.Literal("downloading"),
			received: Type.Integer({ minimum: 0 }),
			total: Type.Integer({ minimum: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object({ state: Type.Literal("ready") }, { additionalProperties: false }),
	Type.Object(
		{
			state: Type.Literal("failed"),
			problem: Type.Union([
				Type.Literal("download-unavailable"),
				Type.Literal("download-failed"),
				Type.Literal("integrity"),
				Type.Literal("startup"),
			]),
		},
		{ additionalProperties: false },
	),
]);
export type BrowserPreparation = Static<typeof BrowserPreparation>;

export type PreparedBrowser = {
	forAgent(agent: string): BrowserSetup;
	prepare(): Promise<void>;
	state(): BrowserPreparation;
	watch(listener: () => void): () => void;
};
