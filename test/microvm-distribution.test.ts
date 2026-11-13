import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Value } from "typebox/value";
import { expect, it } from "vitest";
import {
	ComputerDistributionReview,
	computerDistribution,
	readComputerDistribution,
} from "../scripts/microvm-distribution.ts";

async function fixture() {
	const review: unknown = JSON.parse(
		await readFile(new URL("../scripts/computer-distribution.json", import.meta.url), "utf8"),
	);
	assert.ok(Value.Check(ComputerDistributionReview, review));
	return { review, inputs: structuredClone(review.inputs) };
}

it("reviews only the exact accepted Mac release inputs", async () => {
	const { review, inputs } = await fixture();
	expect(inputs.applicationVersion).toBe("0.1.0-alpha.12");
	expect(computerDistribution({ review, inputs })).toBe("reviewed");
	await expect(readComputerDistribution(inputs)).resolves.toBe("reviewed");
});

it("leaves a changed native executable, firmware or vendor input unqualified", async () => {
	const { review, inputs } = await fixture();
	for (const changed of [
		{ ...inputs, msbSha256: "0".repeat(64) },
		{ ...inputs, firmwareSha256: "0".repeat(64) },
		{ ...inputs, vendorArchiveSha256: "0".repeat(64) },
		{ ...inputs, applicationVersion: "0.1.0-alpha.13" },
	])
		expect(computerDistribution({ review, inputs: changed })).toBe("review-required");
});

it("leaves changed source, patch, compiler or build settings unqualified", async () => {
	const { review, inputs } = await fixture();
	for (const runtimeBuild of [
		{ ...inputs.runtimeBuild, source: { ...inputs.runtimeBuild.source, commit: "0".repeat(40) } },
		{ ...inputs.runtimeBuild, source: { ...inputs.runtimeBuild.source, sha256: "0".repeat(64) } },
		{ ...inputs.runtimeBuild, patchSha256: "0".repeat(64) },
		{ ...inputs.runtimeBuild, recipeSha256: "0".repeat(64) },
		{ ...inputs.runtimeBuild, lockSha256: "0".repeat(64) },
		{ ...inputs.runtimeBuild, compiler: { ...inputs.runtimeBuild.compiler, rustc: "0".repeat(64) } },
		{ ...inputs.runtimeBuild, compiler: { ...inputs.runtimeBuild.compiler, version: "1.100.0" } },
		{ ...inputs.runtimeBuild, features: "changed" },
		{ ...inputs.runtimeBuild, environment: { ...inputs.runtimeBuild.environment, minimumVersion: "15.0" } },
		{ ...inputs.runtimeBuild, agentdSha256: "0".repeat(64) },
	])
		expect(computerDistribution({ review, inputs: { ...inputs, runtimeBuild } })).toBe("review-required");
});

it("does not reuse review for different raw images or loaded image identities", async () => {
	const { review, inputs } = await fixture();
	for (const role of ["box", "proxy", "browser"] as const) {
		for (const replacement of [
			{ sha256: "0".repeat(64) },
			{ digest: `sha256:${"0".repeat(64)}` },
			{ ref: `banda-${role}:000000000000` },
		]) {
			const images = structuredClone(inputs.images);
			Object.assign(images[role], replacement);
			expect(computerDistribution({ review, inputs: { ...inputs, images } })).toBe("review-required");
		}
	}
	const images = structuredClone(inputs.images);
	images.browser.bytes++;
	expect(computerDistribution({ review, inputs: { ...inputs, images } })).toBe("review-required");
});

it("cannot clear Linux review from the accepted Mac packet", async () => {
	const { review, inputs } = await fixture();
	for (const target of ["linux-arm64", "linux-x64"] as const)
		expect(computerDistribution({ review, inputs: { ...inputs, target } })).toBe("review-required");
});

it("accepts valid historical facts without treating them as current review", async () => {
	const { review, inputs } = await fixture();
	const older = structuredClone(review);
	older.inputs.runtimeBuild.source.commit = "0".repeat(40);
	older.inputs.runtimeBuild.compiler.version = "1.98.0";
	expect(Value.Check(ComputerDistributionReview, older)).toBe(true);
	expect(computerDistribution({ review: older, inputs })).toBe("review-required");
});

it("rejects malformed or expanded review records instead of assigning a status", async () => {
	const { review, inputs } = await fixture();
	for (const invalid of [
		null,
		{},
		{ ...review, accepted: true },
		{ ...review, catalogSha256: "not a hash" },
		{ ...review, inputs: { ...review.inputs, target: "linux-x64" } },
		{ ...review, inputs: { ...review.inputs, msbSha256: "not a hash" } },
		{ ...review, inputs: { ...review.inputs, runtimeBuild: { ...review.inputs.runtimeBuild, extra: true } } },
		{
			...review,
			inputs: {
				...review.inputs,
				runtimeBuild: {
					...review.inputs.runtimeBuild,
					compiler: { ...review.inputs.runtimeBuild.compiler, version: "not-a-version" },
				},
			},
		},
	])
		expect(() => computerDistribution({ review: invalid, inputs })).toThrow(/review is invalid/);
});
