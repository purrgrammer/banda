import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { type Static, Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { MicrovmImages, MicrovmRuntimeBuild, type MicrovmTarget } from "../src/box/microvm-assets.ts";

const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const version = Type.String({ pattern: "^[A-Za-z0-9._-]+$" });
const runtimeBuild = Type.Object(
	{
		...MicrovmRuntimeBuild.properties,
		source: Type.Object(
			{ commit: Type.String({ pattern: "^[a-f0-9]{40}$" }), sha256: hash },
			{ additionalProperties: false },
		),
		lockSha256: hash,
		environment: Type.Object(
			{
				platform: Type.Literal("darwin"),
				minimumVersion: Type.String({ pattern: "^[0-9]+(?:\\.[0-9]+){1,2}$" }),
			},
			{ additionalProperties: false },
		),
		compiler: Type.Object(
			{
				...MicrovmRuntimeBuild.properties.compiler.properties,
				version: Type.String({ pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$" }),
				target: Type.String({ pattern: "^[A-Za-z0-9_-]+$" }),
			},
			{ additionalProperties: false },
		),
		features: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
export const ComputerDistributionReview = Type.Object(
	{
		catalogSha256: hash,
		inputs: Type.Object(
			{
				applicationVersion: version,
				target: Type.Literal("darwin-arm64"),
				vendorArchiveSha256: hash,
				runtimeBuild,
				msbSha256: hash,
				firmwareSha256: hash,
				images: Type.Object(
					{ ...MicrovmImages.properties, target: Type.Literal("linux-arm64") },
					{ additionalProperties: false },
				),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

type DistributionInputs = Omit<
	Static<typeof ComputerDistributionReview>["inputs"],
	"target" | "images" | "runtimeBuild"
> & {
	target: MicrovmTarget;
	images: MicrovmImages;
	runtimeBuild: MicrovmRuntimeBuild | Static<typeof runtimeBuild>;
};

export function computerDistribution({ review, inputs }: { review: unknown; inputs: DistributionInputs }) {
	if (!Value.Check(ComputerDistributionReview, review)) throw new Error("The computer distribution review is invalid.");
	return isDeepStrictEqual(review.inputs, inputs) ? "reviewed" : "review-required";
}

export async function readComputerDistribution(inputs: DistributionInputs) {
	const review: unknown = JSON.parse(await readFile(new URL("computer-distribution.json", import.meta.url), "utf8"));
	return computerDistribution({ review, inputs });
}
