#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";

export const SOURCE_COMMIT = "5bbeff2c8400ecb951b1b9b97bcb72250ce475fb";
export const VERSION = "0.1.0-alpha.12";
const shipping = fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, "");
const receipt = resolve(shipping, "..", ".github", "public-delivery");
const receiptSha256 = "14787134f3a0070189ae348d3e7fcfb0b2fd8db29fa295832244e396f7d1be46";
const baseUrl = `https://github.com/purrgrammer/banda/releases/download/v${VERSION}/`;
const basenamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const hashPattern = "^[a-f0-9]{64}$";
const maxAssetBytes = 2 * 1024 ** 3;
const deadlineMs = 10 * 60 * 1000;
const maxAttempts = 3;
const redirectHosts = new Set([
	"github.com",
	"release-assets.githubusercontent.com",
	"objects.githubusercontent.com",
	"github-releases.githubusercontent.com",
]);
const expectedKinds = new Map([
	[`banda-${VERSION}-mac-arm64.dmg`, "desktop"],
	[`banda-${VERSION}-mac-arm64.zip`, "desktop"],
	[`banda-cli-${VERSION}-mac-arm64.tar.gz`, "cli"],
	["banda-browser-824b0112077836de25793facc4832c57a1b5d191cfdb4cb0967913ca2d233190.tar", "lazy-browser"],
	...Array.from({ length: 6 }, (_, i) => [`banda-5bbeff2c8400-sources-0${i + 1}.tar`, "source-shard"]),
	["banda-source-controls-5bbeff2c8400.tar.gz", "source-controls"],
	["banda-computer-notice-evidence-5bbeff2c8400.tar.gz", "notice-evidence"],
	["RELEASE-REVIEW.md", "verification-instructions"],
	["computer-distribution.json", "delivery-index"],
]);
const hash = Type.String({ pattern: hashPattern });
const name = Type.String({ pattern: basenamePattern.source });
export const ReferenceSchema = Type.Object(
	{
		status: Type.Literal("accepted-publication-pending"),
		sourceCommit: Type.Literal(SOURCE_COMMIT),
		assets: Type.Array(
			Type.Object(
				{
					file: name,
					kind: Type.Union([...new Set(expectedKinds.values())].map((kind) => Type.Literal(kind))),
					bytes: Type.Integer({ minimum: 1, maximum: maxAssetBytes }),
					sha256: hash,
				},
				{ additionalProperties: false },
			),
			{ minItems: 14, maxItems: 14 },
		),
		sha256sumsSha256: hash,
	},
	{ additionalProperties: false },
);
const attemptSchema = Type.Object(
	{
		attempt: Type.Integer({ minimum: 1, maximum: maxAttempts }),
		passed: Type.Boolean(),
		bytes: Type.Integer({ minimum: 0 }),
		partial: Type.String(),
		sha256: Type.Optional(hash),
		error: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
export const ResultSchema = Type.Object(
	{
		passed: Type.Boolean(),
		sourceCommit: Type.Literal(SOURCE_COMMIT),
		version: Type.Literal(VERSION),
		evidence: Type.Union([Type.Literal("public-get"), Type.Literal("inert-test")]),
		unauthenticatedPublicGet: Type.Boolean(),
		scope: Type.Union([Type.Literal("full"), Type.Literal("selected")]),
		selected: Type.Array(name),
		referenceResultSha256: Type.Optional(hash),
		referenceSha256sumsSha256: Type.Optional(hash),
		records: Type.Array(
			Type.Object(
				{
					file: name,
					passed: Type.Boolean(),
					bytes: Type.Integer({ minimum: 0 }),
					sha256: Type.Optional(hash),
					attempts: Type.Array(attemptSchema),
					error: Type.Optional(Type.String()),
				},
				{ additionalProperties: false },
			),
		),
		errors: Type.Array(Type.String()),
	},
	{ additionalProperties: false },
);

class Failure extends Error {
	constructor(code, retryable = false) {
		super(code);
		this.code = code;
		this.retryable = retryable;
	}
}
const fail = (code) => {
	throw new Failure(code);
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const errorCode = (error) => (error instanceof Failure ? error.code : "local-io-failed");

async function fileHandle(path, maxBytes) {
	let handle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > maxBytes) fail("reference-file-type-or-size");
		return { handle, stat };
	} catch (error) {
		await handle?.close();
		if (error instanceof Failure) throw error;
		fail("reference-file-unavailable");
	}
}

async function smallFile(path, maxBytes) {
	const { handle } = await fileHandle(path, maxBytes);
	try {
		const buffer = Buffer.alloc(maxBytes + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		if (length > maxBytes) fail("reference-file-grew");
		return buffer.subarray(0, length);
	} finally {
		await handle.close();
	}
}

async function verifyLocal(path, expected) {
	const { handle, stat } = await fileHandle(path, expected.bytes);
	try {
		if (stat.size !== expected.bytes) fail("reference-size-mismatch");
		const digest = createHash("sha256");
		let bytes = 0;
		for await (const chunk of handle.createReadStream({ autoClose: false })) {
			bytes += chunk.length;
			if (bytes > expected.bytes) fail("reference-size-mismatch");
			digest.update(chunk);
		}
		if (bytes !== expected.bytes) fail("reference-size-mismatch");
		if (digest.digest("hex") !== expected.sha256) fail("reference-hash-mismatch");
	} finally {
		await handle.close();
	}
}

function selectedNames(only) {
	if (only === undefined) return [...expectedKinds.keys(), "SHA256SUMS"];
	const names = only.split(",");
	if (
		names.length !== 2 ||
		new Set(names).size !== 2 ||
		!names.includes("computer-distribution.json") ||
		!names.includes("SHA256SUMS")
	) {
		fail("only-requires-computer-distribution-and-SHA256SUMS");
	}
	return names;
}

async function referenceRecords(reference, selected, report, receiptOnly) {
	if (!isAbsolute(reference) || resolve(reference) !== reference || (await realpath(reference)) !== reference) {
		fail("reference-must-be-canonical-absolute-directory");
	}
	const assetDir = receiptOnly ? reference : join(reference, "assets");
	const assetStat = await lstat(assetDir);
	if (!assetStat.isDirectory() || assetStat.isSymbolicLink() || (await realpath(assetDir)) !== assetDir) {
		fail("reference-assets-must-be-real-directory");
	}
	const raw = await smallFile(join(reference, "result.json"), 64 * 1024);
	if (report.evidence === "public-get" && sha256(raw) !== receiptSha256) fail("accepted-receipt-hash-mismatch");
	let input;
	try {
		input = JSON.parse(raw.toString("utf8"));
	} catch {
		fail("reference-json-invalid");
	}
	if (!Value.Check(ReferenceSchema, input)) fail("reference-schema-invalid");
	report.referenceResultSha256 = sha256(raw);
	const records = new Map();
	let totalBytes = 0;
	for (const record of input.assets) {
		if (
			!basenamePattern.test(record.file) ||
			records.has(record.file) ||
			expectedKinds.get(record.file) !== record.kind
		) {
			fail("reference-asset-set-invalid");
		}
		if ((record.kind === "delivery-index" || record.kind === "verification-instructions") && record.bytes > 1024 ** 2) {
			fail("reference-metadata-too-large");
		}
		records.set(record.file, record);
		totalBytes += record.bytes;
	}
	if (records.size !== expectedKinds.size || totalBytes > 8 * 1024 ** 3) fail("reference-asset-set-invalid");
	const sums = await smallFile(join(assetDir, "SHA256SUMS"), 64 * 1024);
	const sumsHash = sha256(sums);
	if (sumsHash !== input.sha256sumsSha256) fail("reference-SHA256SUMS-hash-mismatch");
	report.referenceSha256sumsSha256 = sumsHash;
	const text = sums.toString("ascii");
	if (!sums.equals(Buffer.from(text, "ascii")) || !text.endsWith("\n")) fail("reference-SHA256SUMS-format-invalid");
	const sumRecords = new Map();
	for (const line of text.slice(0, -1).split("\n")) {
		const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9][A-Za-z0-9._-]{0,199})$/.exec(line);
		if (!match || sumRecords.has(match[2]) || !records.has(match[2])) fail("reference-SHA256SUMS-entries-invalid");
		sumRecords.set(match[2], match[1]);
	}
	if (sumRecords.size !== records.size) fail("reference-SHA256SUMS-entries-invalid");
	for (const [file, record] of records) {
		if (sumRecords.get(file) !== record.sha256) fail("reference-SHA256SUMS-binding-mismatch");
	}
	records.set("SHA256SUMS", { file: "SHA256SUMS", bytes: sums.length, sha256: sumsHash });
	if (!receiptOnly) for (const file of selected) await verifyLocal(join(assetDir, file), records.get(file));
	return selected.map((file) => records.get(file));
}

function publicUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		fail("redirect-url-invalid");
	}
	if (url.protocol !== "https:" || url.username || url.password || url.port || !redirectHosts.has(url.hostname)) {
		fail("redirect-not-public-release-https");
	}
	return url;
}

async function publicResponse(file, signal, fetchFn) {
	let url = publicUrl(`${baseUrl}${encodeURIComponent(file)}`);
	for (let redirects = 0; redirects <= 5; redirects++) {
		let response;
		try {
			response = await fetchFn(url, {
				method: "GET",
				redirect: "manual",
				credentials: "omit",
				signal,
				headers: { Accept: "application/octet-stream" },
			});
		} catch {
			throw new Failure(signal.aborted ? "download-deadline" : "fetch-failed", true);
		}
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			const location = response.headers.get("location");
			await response.body?.cancel();
			if (!location || redirects === 5) fail("redirect-limit-or-location-invalid");
			url = publicUrl(new URL(location, url).href);
			continue;
		}
		if (response.status !== 200) {
			await response.body?.cancel();
			throw new Failure(
				`http-${response.status}`,
				response.status === 408 || response.status === 429 || response.status >= 500,
			);
		}
		return response;
	}
	fail("redirect-limit-or-location-invalid");
}

async function oneAttempt(record, out, attempt, fetchFn) {
	const partial = join("partials", `${record.file}.attempt-${attempt}.partial`);
	const result = { attempt, passed: false, bytes: 0, partial };
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), deadlineMs);
	const digest = createHash("sha256");
	let handle;
	let response;
	let retryable = false;
	try {
		handle = await open(join(out, partial), "wx", 0o600);
		response = await publicResponse(record.file, controller.signal, fetchFn);
		const length = response.headers.get("content-length");
		if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) !== record.bytes)) {
			fail("download-content-length-mismatch");
		}
		if (!response.body) fail("download-body-missing");
		try {
			for await (const chunk of response.body) {
				result.bytes += chunk.byteLength;
				if (result.bytes > record.bytes) fail("download-size-exceeded");
				digest.update(chunk);
				await handle.writeFile(chunk);
			}
		} catch (error) {
			if (error instanceof Failure) throw error;
			throw new Failure(controller.signal.aborted ? "download-deadline" : "download-stream-failed", true);
		}
		result.sha256 = digest.digest("hex");
		if (result.bytes !== record.bytes) fail("download-size-mismatch");
		if (result.sha256 !== record.sha256) fail("download-hash-mismatch");
		await handle.chmod(0o400);
		await handle.sync();
		await handle.close();
		handle = undefined;
		// link is atomic and refuses an existing destination; rename would overwrite it.
		await link(join(out, partial), join(out, "assets", record.file));
		await unlink(join(out, partial));
		result.passed = true;
	} catch (error) {
		result.error = errorCode(error);
		retryable = error instanceof Failure && error.retryable;
	} finally {
		controller.abort();
		clearTimeout(timer);
		try {
			await response?.body?.cancel();
		} catch {
			/* A consumed/locked body is already finished. */
		}
		try {
			await handle?.close();
		} catch {
			/* The failed attempt remains unverified. */
		}
	}
	return { result, retryable };
}

async function download(record, out, fetchFn) {
	const attempts = [];
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const outcome = await oneAttempt(record, out, attempt, fetchFn);
		attempts.push(outcome.result);
		if (outcome.result.passed || !outcome.retryable) break;
	}
	const final = attempts.at(-1);
	return {
		file: record.file,
		passed: final.passed,
		bytes: final.bytes,
		...(final.sha256 ? { sha256: final.sha256 } : {}),
		attempts,
		...(final.error ? { error: final.error } : {}),
	};
}

async function run(options, fetchFn, evidence, outputParent, receiptOnly = false) {
	if (
		!isAbsolute(options.out) ||
		resolve(options.out) !== options.out ||
		dirname(options.out) !== outputParent ||
		(await realpath(outputParent)) !== outputParent
	) {
		fail("out-must-be-fresh-absolute-child-of-shipping");
	}
	// Exclusive mkdir establishes ownership; no pre-existing output is ever reused.
	await mkdir(options.out, { mode: 0o700 });
	const report = {
		passed: false,
		sourceCommit: SOURCE_COMMIT,
		version: VERSION,
		evidence,
		unauthenticatedPublicGet: evidence === "public-get",
		scope: options.only === undefined ? "full" : "selected",
		selected: [],
		records: [],
		errors: [],
	};
	try {
		report.selected = selectedNames(options.only);
		await mkdir(join(options.out, "assets"), { mode: 0o700 });
		await mkdir(join(options.out, "partials"), { mode: 0o700 });
		const records = await referenceRecords(options.reference, report.selected, report, receiptOnly);
		let next = 0;
		const completed = new Array(records.length);
		await Promise.all(
			Array.from({ length: 2 }, async () => {
				while (next < records.length) {
					const index = next++;
					completed[index] = await download(records[index], options.out, fetchFn);
				}
			}),
		);
		report.records = completed;
		report.passed = completed.every((record) => record.passed);
		if (!report.passed) report.errors.push("one-or-more-downloads-failed");
	} catch (error) {
		report.errors.push(errorCode(error));
	}
	if (!Value.Check(ResultSchema, report)) fail("internal-result-schema-invalid");
	const result = await open(join(options.out, "result.json"), "wx", 0o600);
	try {
		await result.writeFile(`${JSON.stringify(report, null, 2)}\n`);
	} finally {
		await result.close();
	}
	return report;
}

// The test entry point cannot emit public evidence or choose another network host.
export async function runInertVerification(options, fakeFetch, receiptOnly = false) {
	const parent = dirname(options.out);
	if (
		dirname(parent) !== shipping ||
		!/^public-download-inert-tests-[A-Za-z0-9]+$/.test(parent.slice(shipping.length + 1))
	) {
		fail("inert-tests-require-private-fixture-directory");
	}
	return run(options, fakeFetch, "inert-test", parent, receiptOnly);
}

export async function main(argv) {
	if (argv.includes("--help")) {
		process.stdout.write("node scripts/verify-public-delivery.mjs --out /absolute/scripts/fresh-output --run\n");
		return 0;
	}
	if (Number(process.versions.node.split(".")[0]) !== 26) fail("node-26-required");
	const options = {};
	let explicitRun = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--run" && !explicitRun) {
			explicitRun = true;
			continue;
		}
		if (
			arg !== "--out" ||
			options[arg.slice(2)] !== undefined ||
			argv[i + 1] === undefined ||
			argv[i + 1].startsWith("--")
		)
			fail("arguments-invalid");
		options[arg.slice(2)] = argv[++i];
	}
	if (!explicitRun || !options.out) fail("explicit-out-and-run-required");
	const report = await run(
		{ ...options, reference: receipt },
		globalThis.fetch,
		"public-get",
		await realpath(shipping),
		true,
	);
	process.stdout.write(
		`${JSON.stringify({ passed: report.passed, scope: report.scope, files: report.records.length, out: options.out })}\n`,
	);
	return report.passed ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		process.exitCode = await main(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`${JSON.stringify({ passed: false, error: errorCode(error) })}\n`);
		process.exitCode = 1;
	}
}
