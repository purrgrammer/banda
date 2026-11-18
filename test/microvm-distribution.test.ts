import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { expect, it } from "vitest";
import {
	ComputerDistributionReviews,
	computerDistribution,
	distributionNotice,
	readComputerDistribution,
} from "../scripts/microvm-distribution.ts";
import { MICROVM_PLATFORMS, MicrovmRuntimeBuild } from "../src/box/microvm-assets.ts";

type Reviews = Static<typeof ComputerDistributionReviews>;

async function fixture() {
	const reviews: unknown = JSON.parse(
		await readFile(new URL("../scripts/computer-distribution.json", import.meta.url), "utf8"),
	);
	assert.ok(Value.Check(ComputerDistributionReviews, reviews));
	return reviews;
}

function withLinuxReview(reviews: Reviews): Required<Reviews> {
	const mac = reviews["darwin-arm64"];
	return {
		...reviews,
		"linux-x64": {
			catalogSha256: "1".repeat(64),
			inputs: {
				...structuredClone(mac.inputs),
				target: "linux-x64",
				vendorArchiveSha256: MICROVM_PLATFORMS["linux-x64"].sha256,
				runtimeBuild: {
					...structuredClone(mac.inputs.runtimeBuild),
					environment: { platform: "linux", image: MICROVM_PLATFORMS["linux-x64"].manylinux, glibc: "2.28" },
					compiler: { ...mac.inputs.runtimeBuild.compiler, target: "x86_64-unknown-linux-gnu" },
					agentdSha256: MICROVM_PLATFORMS["linux-x64"].agentd.sha256,
				},
				msbSha256: "2".repeat(64),
				firmwareSha256: MICROVM_PLATFORMS["linux-x64"].firmwareSha256,
				images: { ...structuredClone(mac.inputs.images), target: "linux-x64" },
			},
		},
	};
}

it("preserves the complete accepted alpha.12 Mac record and adds no Linux acceptance", async () => {
	const reviews = await fixture();
	const review = reviews["darwin-arm64"];
	expect(Object.keys(reviews)).toEqual(["darwin-arm64"]);
	expect(createHash("sha256").update(JSON.stringify(review)).digest("hex")).toBe(
		"e0c7b9b9c96c7999d16a91d0a73a9ebef1f63a7aa412b743d1a77ad146eac4ae",
	);
	expect(review.inputs.applicationVersion).toBe("0.1.0-alpha.12");
	await expect(readComputerDistribution(review.inputs)).resolves.toBe("reviewed");
	await expect(readComputerDistribution({ ...review.inputs, applicationVersion: "0.1.0-alpha.13" })).resolves.toBe(
		"review-required",
	);
});

it("calls a build reviewed only for the owner's exact record, and says where an unreviewed one's sources are", () => {
	for (const target of ["darwin-arm64", "linux-x64", "linux-arm64"] as const) {
		const pending = distributionNotice("review-required", target);
		expect(pending.title).toBe("distribution review pending");
		expect(pending.note).toMatch(/^No person has reviewed the distribution of this exact build\./);
		expect(pending.note).toContain("release-materials.json");
		expect(pending.note).not.toMatch(/accepted|has been reviewed/);
		expect(distributionNotice("reviewed", target).title).toBe(`${target} distribution reviewed`);
	}
});

it("requires a separate exact Linux x64 record and leaves Linux ARM64 pending", async () => {
	const committed = await fixture();
	const reviews = withLinuxReview(committed);
	const inputs = reviews["linux-x64"].inputs;
	expect(computerDistribution({ reviews: committed, inputs })).toBe("review-required");
	await expect(readComputerDistribution(inputs)).resolves.toBe("review-required");
	expect(computerDistribution({ reviews, inputs })).toBe("reviewed");
	for (const record of [reviews["darwin-arm64"], reviews["linux-x64"]])
		expect(computerDistribution({ reviews, inputs: { ...record.inputs, target: "linux-arm64" } })).toBe(
			"review-required",
		);
	expect(computerDistribution({ reviews, inputs: { ...inputs, target: "darwin-arm64" } })).toBe("review-required");
	expect(computerDistribution({ reviews, inputs: { ...reviews["darwin-arm64"].inputs, target: "linux-x64" } })).toBe(
		"review-required",
	);
});

it.each(["darwin-arm64", "linux-x64"] as const)("reviews only exact %s inputs", async (target) => {
	const reviews = withLinuxReview(await fixture());
	const inputs = reviews[target].inputs;
	expect(computerDistribution({ reviews, inputs })).toBe("reviewed");
	for (const changed of [
		{ ...inputs, msbSha256: "0".repeat(64) },
		{ ...inputs, firmwareSha256: "0".repeat(64) },
		{ ...inputs, vendorArchiveSha256: "0".repeat(64) },
		{ ...inputs, applicationVersion: "0.1.0-alpha.13" },
	])
		expect(computerDistribution({ reviews, inputs: changed })).toBe("review-required");
	for (const runtimeBuild of [
		{ ...inputs.runtimeBuild, source: { ...inputs.runtimeBuild.source, commit: "0".repeat(40) } },
		{ ...inputs.runtimeBuild, source: { ...inputs.runtimeBuild.source, sha256: "0".repeat(64) } },
		{ ...inputs.runtimeBuild, patchSha256: "0".repeat(64) },
		{ ...inputs.runtimeBuild, recipeSha256: "0".repeat(64) },
		{ ...inputs.runtimeBuild, lockSha256: "0".repeat(64) },
		{ ...inputs.runtimeBuild, features: "changed" },
		{ ...inputs.runtimeBuild, agentdSha256: "0".repeat(64) },
	])
		expect(computerDistribution({ reviews, inputs: { ...inputs, runtimeBuild } })).toBe("review-required");
	for (const key of ["rustc", "cargo", "std", "version"] as const) {
		const runtimeBuild = structuredClone(inputs.runtimeBuild);
		runtimeBuild.compiler[key] = key === "version" ? "1.100.0" : "0".repeat(64);
		expect(computerDistribution({ reviews, inputs: { ...inputs, runtimeBuild } })).toBe("review-required");
	}
	for (const role of ["box", "proxy", "browser"] as const) {
		for (const replacement of [
			{ sha256: "0".repeat(64) },
			{ digest: `sha256:${"0".repeat(64)}` },
			{ ref: `banda-${role}:000000000000` },
			{ archive: "changed.tar" },
		]) {
			const images = structuredClone(inputs.images);
			Object.assign(images[role], replacement);
			expect(computerDistribution({ reviews, inputs: { ...inputs, images } })).toBe("review-required");
		}
	}
	const images = structuredClone(inputs.images);
	images.browser.bytes++;
	expect(computerDistribution({ reviews, inputs: { ...inputs, images } })).toBe("review-required");
});

it("leaves changed build environments unqualified", async () => {
	const reviews = withLinuxReview(await fixture());
	const mac = reviews["darwin-arm64"].inputs;
	const linux = reviews["linux-x64"].inputs;
	const runtimeBuild = {
		...mac.runtimeBuild,
		environment: { ...mac.runtimeBuild.environment, minimumVersion: "15.0" },
	};
	expect(computerDistribution({ reviews, inputs: { ...mac, runtimeBuild } })).toBe("review-required");
	for (const environment of [
		{ ...linux.runtimeBuild.environment, image: `quay.io/pypa/manylinux_2_28_x86_64@sha256:${"0".repeat(64)}` },
		{ ...linux.runtimeBuild.environment, glibc: "2.34" },
	])
		expect(
			computerDistribution({ reviews, inputs: { ...linux, runtimeBuild: { ...linux.runtimeBuild, environment } } }),
		).toBe("review-required");
});

it.each(["darwin-arm64", "linux-x64"] as const)(
	"parses historical %s facts without weakening runtime authority",
	async (target) => {
		const reviews = withLinuxReview(await fixture());
		const older = structuredClone(reviews);
		const runtime = older[target].inputs.runtimeBuild;
		runtime.source.commit = "0".repeat(40);
		runtime.source.sha256 = "0".repeat(64);
		runtime.lockSha256 = "0".repeat(64);
		runtime.compiler.version = "1.98.0";
		runtime.features = "historical-features";
		if (runtime.environment.platform === "darwin") runtime.environment.minimumVersion = "13.0";
		else {
			runtime.environment.image = `quay.io/pypa/manylinux_2_17_x86_64@sha256:${"0".repeat(64)}`;
			runtime.environment.glibc = "2.17";
		}
		expect(Value.Check(ComputerDistributionReviews, older)).toBe(true);
		expect(Value.Check(MicrovmRuntimeBuild, runtime)).toBe(false);
		expect(computerDistribution({ reviews: older, inputs: reviews[target].inputs })).toBe("review-required");
	},
);

it("rejects cross-target, environment, compiler and image pairings", async () => {
	const reviews = withLinuxReview(await fixture());
	const mac = reviews["darwin-arm64"];
	const linux = reviews["linux-x64"];
	for (const invalid of [
		{ ...reviews, "darwin-arm64": linux },
		{ ...reviews, "linux-x64": mac },
		{ ...reviews, "linux-arm64": linux },
	])
		expect(() => computerDistribution({ reviews: invalid, inputs: mac.inputs })).toThrow(/review is invalid/);
	for (const [target, record, other] of [
		["darwin-arm64", mac, linux],
		["linux-x64", linux, mac],
	] as const) {
		for (const inputs of [
			{ ...record.inputs, images: other.inputs.images },
			{
				...record.inputs,
				runtimeBuild: { ...record.inputs.runtimeBuild, environment: other.inputs.runtimeBuild.environment },
			},
			{
				...record.inputs,
				runtimeBuild: { ...record.inputs.runtimeBuild, compiler: other.inputs.runtimeBuild.compiler },
			},
		])
			expect(() =>
				computerDistribution({ reviews: { ...reviews, [target]: { ...record, inputs } }, inputs: record.inputs }),
			).toThrow(/review is invalid/);
	}
	const armEnvironment = {
		...linux.inputs.runtimeBuild.environment,
		image: MICROVM_PLATFORMS["linux-arm64"].manylinux,
	};
	const invalid = {
		...reviews,
		"linux-x64": {
			...linux,
			inputs: { ...linux.inputs, runtimeBuild: { ...linux.inputs.runtimeBuild, environment: armEnvironment } },
		},
	};
	expect(() => computerDistribution({ reviews: invalid, inputs: linux.inputs })).toThrow(/review is invalid/);
});

it("rejects malformed or expanded books and records before lookup", async () => {
	const reviews = withLinuxReview(await fixture());
	const inputs = reviews["darwin-arm64"].inputs;
	for (const invalid of [
		null,
		{},
		reviews["darwin-arm64"],
		[reviews["darwin-arm64"]],
		{ "linux-x64": reviews["linux-x64"] },
		{ ...reviews, accepted: true },
	])
		expect(() => computerDistribution({ reviews: invalid, inputs })).toThrow(/review is invalid/);
	for (const target of ["darwin-arm64", "linux-x64"] as const) {
		const record = reviews[target];
		for (const invalid of [
			null,
			{ ...record, accepted: true },
			{ ...record, catalogSha256: "not a hash" },
			{ ...record, inputs: { ...record.inputs, msbSha256: "not a hash" } },
			{ ...record, inputs: { ...record.inputs, extra: true } },
			{ ...record, inputs: { ...record.inputs, runtimeBuild: { ...record.inputs.runtimeBuild, extra: true } } },
			{ ...record, inputs: { ...record.inputs, runtimeBuild: { ...record.inputs.runtimeBuild, execution: "run" } } },
			{
				...record,
				inputs: {
					...record.inputs,
					runtimeBuild: {
						...record.inputs.runtimeBuild,
						compiler: { ...record.inputs.runtimeBuild.compiler, version: "not-a-version" },
					},
				},
			},
		])
			expect(() => computerDistribution({ reviews: { ...reviews, [target]: invalid }, inputs })).toThrow(
				/review is invalid/,
			);
	}
});
