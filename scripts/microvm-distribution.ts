import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { type Static, Type } from "typebox";
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
const inputs = {
	applicationVersion: version,
	vendorArchiveSha256: hash,
	msbSha256: hash,
	firmwareSha256: hash,
};
const darwinReview = Type.Object(
	{
		catalogSha256: hash,
		inputs: Type.Object(
			{
				...inputs,
				target: Type.Literal("darwin-arm64"),
				runtimeBuild: Type.Object(
					{
						...runtimeBuild.properties,
						environment: Type.Object(
							{
								platform: Type.Literal("darwin"),
								minimumVersion: Type.String({ pattern: "^[0-9]+(?:\\.[0-9]+){1,2}$" }),
							},
							{ additionalProperties: false },
						),
						compiler: Type.Object(
							{ ...runtimeBuild.properties.compiler.properties, target: Type.Literal("aarch64-apple-darwin") },
							{ additionalProperties: false },
						),
					},
					{ additionalProperties: false },
				),
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
const linuxReview = Type.Object(
	{
		catalogSha256: hash,
		inputs: Type.Object(
			{
				...inputs,
				target: Type.Literal("linux-x64"),
				runtimeBuild: Type.Object(
					{
						...runtimeBuild.properties,
						environment: Type.Object(
							{
								platform: Type.Literal("linux"),
								image: Type.String({ pattern: "^quay\\.io/pypa/manylinux_[A-Za-z0-9_]+_x86_64@sha256:[a-f0-9]{64}$" }),
								glibc: Type.String({ pattern: "^[0-9]+\\.[0-9]+$" }),
							},
							{ additionalProperties: false },
						),
						compiler: Type.Object(
							{ ...runtimeBuild.properties.compiler.properties, target: Type.Literal("x86_64-unknown-linux-gnu") },
							{ additionalProperties: false },
						),
					},
					{ additionalProperties: false },
				),
				images: Type.Object(
					{ ...MicrovmImages.properties, target: Type.Literal("linux-x64") },
					{ additionalProperties: false },
				),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
export const ComputerDistributionReviews = Type.Object(
	{
		"darwin-arm64": darwinReview,
		"linux-x64": Type.Optional(linuxReview),
	},
	{ additionalProperties: false },
);

type DistributionInputs = Omit<Static<typeof darwinReview>["inputs"], "target" | "images" | "runtimeBuild"> & {
	target: MicrovmTarget;
	images: MicrovmImages;
	runtimeBuild:
		| MicrovmRuntimeBuild
		| Static<typeof darwinReview>["inputs"]["runtimeBuild"]
		| Static<typeof linuxReview>["inputs"]["runtimeBuild"];
};

export function computerDistribution({ reviews, inputs }: { reviews: unknown; inputs: DistributionInputs }) {
	if (!Value.Check(ComputerDistributionReviews, reviews))
		throw new Error("The computer distribution review is invalid.");
	if (inputs.target === "linux-arm64") return "review-required";
	const review = reviews[inputs.target];
	return review && isDeepStrictEqual(review.inputs, inputs) ? "reviewed" : "review-required";
}

export async function readComputerDistribution(inputs: DistributionInputs) {
	const reviews: unknown = JSON.parse(await readFile(new URL("computer-distribution.json", import.meta.url), "utf8"));
	return computerDistribution({ reviews, inputs });
}

/**
 * What the installed inventory says about distribution. It is written when the bundle is staged, before anyone could
 * have looked at that build, so it calls a build reviewed only when the owner's record names its exact inputs.
 */
export function distributionNotice(
	redistribution: ReturnType<typeof computerDistribution>,
	target: MicrovmTarget,
): { title: string; note: string } {
	return redistribution === "reviewed"
		? {
				title: `${target} distribution reviewed`,
				note: `The source and third-party notice packet for these exact native and image inputs has been accepted for this ${target} pre-release. Matching corresponding sources and third-party notices ship as release assets. The inventory records selected source and dependency inputs.`,
			}
		: {
				title: "distribution review pending",
				note: "No person has reviewed the distribution of this exact build. A published release that carries it publishes the corresponding sources and third-party notices beside its downloads: release-materials.json there binds them to each download by SHA-256, and RELEASE-SOURCES.md says what they hold and what they leave out. A build that is not a published release has no such set and is for local testing only.",
			};
}
