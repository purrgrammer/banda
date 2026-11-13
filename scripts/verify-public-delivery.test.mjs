import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import {
	main,
	ReferenceSchema,
	ResultSchema,
	runInertVerification,
	SOURCE_COMMIT,
	VERSION,
} from "./verify-public-delivery.mjs";

const shipping = dirname(fileURLToPath(import.meta.url));
const root = await mkdtemp(join(shipping, "public-download-inert-tests-"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const entries = [
	[`banda-${VERSION}-mac-arm64.dmg`, "desktop"],
	[`banda-${VERSION}-mac-arm64.zip`, "desktop"],
	[`banda-cli-${VERSION}-mac-arm64.tar.gz`, "cli"],
	["banda-browser-824b0112077836de25793facc4832c57a1b5d191cfdb4cb0967913ca2d233190.tar", "lazy-browser"],
	...Array.from({ length: 6 }, (_, i) => [`banda-5bbeff2c8400-sources-0${i + 1}.tar`, "source-shard"]),
	["banda-source-controls-5bbeff2c8400.tar.gz", "source-controls"],
	["banda-computer-notice-evidence-5bbeff2c8400.tar.gz", "notice-evidence"],
	["RELEASE-REVIEW.md", "verification-instructions"],
	["computer-distribution.json", "delivery-index"],
];
const metadataOnly = "computer-distribution.json,SHA256SUMS";
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
let caseNumber = 0;

async function fixture() {
	const number = ++caseNumber;
	const reference = join(root, `reference-${number}`);
	const out = join(root, `output-${number}`);
	await mkdir(reference);
	await mkdir(join(reference, "assets"));
	const bodies = new Map();
	const assets = [];
	for (const [file, kind] of entries) {
		const bytes = Buffer.from(`inert local fixture for ${file}\n`);
		bodies.set(file, bytes);
		assets.push({ file, kind, bytes: bytes.length, sha256: digest(bytes) });
		await writeFile(join(reference, "assets", file), bytes, { flag: "wx" });
	}
	const sums = Buffer.from(assets.map((r) => `${r.sha256}  ${r.file}\n`).join(""));
	bodies.set("SHA256SUMS", sums);
	await writeFile(join(reference, "assets", "SHA256SUMS"), sums, { flag: "wx" });
	const input = {
		status: "accepted-publication-pending",
		sourceCommit: SOURCE_COMMIT,
		assets,
		sha256sumsSha256: digest(sums),
	};
	assert(Value.Check(ReferenceSchema, input));
	const save = () => writeFile(join(reference, "result.json"), `${JSON.stringify(input)}\n`);
	const sumsReplace = async (text) => {
		const bytes = Buffer.from(text);
		bodies.set("SHA256SUMS", bytes);
		await writeFile(join(reference, "assets", "SHA256SUMS"), bytes);
		input.sha256sumsSha256 = digest(bytes);
		await save();
	};
	await save();
	return { reference, out, bodies, input, save, sumsReplace };
}

function responder(f, override) {
	const seen = [];
	const fake = async (value, init) => {
		const url = new URL(value);
		assert.equal(url.protocol, "https:");
		assert.equal(init.method, "GET");
		assert.equal(init.credentials, "omit");
		assert.equal(init.redirect, "manual");
		assert.deepEqual(Object.keys(init.headers), ["Accept"]);
		assert(init.signal instanceof AbortSignal);
		seen.push(url.href);
		const file = decodeURIComponent(url.pathname.split("/").at(-1));
		if (override) {
			const custom = await override(file, url, init, seen);
			if (custom !== undefined) return custom;
		}
		assert.equal(url.origin, "https://github.com");
		assert(url.pathname.startsWith(`/purrgrammer/banda/releases/download/v${VERSION}/`));
		const body = f.bodies.get(file);
		assert(body, "Only pinned basenames may be fetched");
		return streamed(body);
	};
	return { fake, seen };
}

function streamed(bytes, headers = { "content-length": String(bytes.length) }, hooks = {}) {
	let offset = 0;
	let ended = false;
	const finish = () => {
		if (!ended) {
			ended = true;
			hooks.end?.();
		}
	};
	return new Response(
		new ReadableStream({
			async pull(controller) {
				await Promise.resolve();
				if (offset === bytes.length) {
					controller.close();
					finish();
					return;
				}
				const end = Math.min(offset + 3, bytes.length);
				controller.enqueue(bytes.subarray(offset, end));
				offset = end;
			},
			cancel() {
				finish();
			},
		}),
		{ status: 200, headers },
	);
}

async function readReport(out) {
	const parsed = JSON.parse(await readFile(join(out, "result.json"), "utf8"));
	assert(Value.Check(ResultSchema, parsed), "Every result JSON read is schema checked");
	return parsed;
}

async function run(f, fake, only) {
	const returned = await runInertVerification({ reference: f.reference, out: f.out, ...(only ? { only } : {}) }, fake);
	assert.deepEqual(await readReport(f.out), returned);
	assert.equal(returned.evidence, "inert-test");
	assert.equal(returned.unauthenticatedPublicGet, false);
	return returned;
}

async function preflightFailure(change, code, only) {
	const f = await fixture();
	await change(f);
	const { fake, seen } = responder(f);
	const report = await run(f, fake, only);
	assert.equal(report.passed, false);
	assert.equal(report.records.length, 0);
	assert.equal(seen.length, 0);
	assert(report.errors.includes(code), `${code}: ${JSON.stringify(report.errors)}`);
}

test("full stream verifies all 15 files with at most two concurrent GETs", async () => {
	const f = await fixture();
	let active = 0;
	let peak = 0;
	const { fake, seen } = responder(f, (file) => {
		active++;
		peak = Math.max(peak, active);
		return streamed(f.bodies.get(file), undefined, { end: () => active-- });
	});
	const report = await run(f, fake);
	assert.equal(report.passed, true);
	assert.equal(report.scope, "full");
	assert.equal(report.records.length, 15);
	assert.equal(seen.length, 15);
	assert.equal(peak, 2);
	assert.deepEqual((await readdir(join(f.out, "assets"))).sort(), [...f.bodies.keys()].sort());
	assert.deepEqual(await readdir(join(f.out, "partials")), []);
	for (const record of report.records) {
		assert.equal(record.bytes, f.bodies.get(record.file).length);
		assert.equal(record.sha256, digest(await readFile(join(f.out, "assets", record.file))));
	}
});

test("selected final metadata skips unselected local byte hashing and GETs", async () => {
	const f = await fixture();
	await writeFile(join(f.reference, "assets", entries[0][0]), "changed unselected fixture");
	const { fake, seen } = responder(f);
	const report = await run(f, fake, metadataOnly);
	assert.equal(report.passed, true);
	assert.equal(report.scope, "selected");
	assert.equal(report.records.length, 2);
	assert.equal(seen.length, 2);
});

test("receipt-only mode verifies all public bytes without local reference binaries", async () => {
	const f = await fixture();
	await writeFile(join(f.reference, "SHA256SUMS"), f.bodies.get("SHA256SUMS"));
	await rm(join(f.reference, "assets"), { recursive: true });
	const { fake, seen } = responder(f);
	const report = await runInertVerification({ reference: f.reference, out: f.out }, fake, true);
	assert.equal(report.passed, true);
	assert.equal(report.evidence, "inert-test");
	assert.equal(report.unauthenticatedPublicGet, false);
	assert.equal(seen.length, 15);
});

test("checked-in accepted receipt and checksum bytes remain pinned", async () => {
	const receiptDirectory = resolve(shipping, "..", ".github", "public-delivery");
	const raw = await readFile(join(receiptDirectory, "result.json"));
	assert.equal(digest(raw), "14787134f3a0070189ae348d3e7fcfb0b2fd8db29fa295832244e396f7d1be46");
	const receipt = JSON.parse(raw);
	assert(Value.Check(ReferenceSchema, receipt));
	assert.equal(digest(await readFile(join(receiptDirectory, "SHA256SUMS"))), receipt.sha256sumsSha256);
});

test("wrong source commit fails before GET", () =>
	preflightFailure(async (f) => {
		f.input.sourceCommit = "0".repeat(40);
		await f.save();
	}, "reference-schema-invalid"));
test("closed reference rejects unknown fields", () =>
	preflightFailure(async (f) => {
		f.input.extra = true;
		await f.save();
	}, "reference-schema-invalid"));
test("path basename is rejected", () =>
	preflightFailure(async (f) => {
		f.input.assets[0].file = "../escape";
		await f.save();
	}, "reference-schema-invalid"));
test("duplicate basename is rejected", () =>
	preflightFailure(async (f) => {
		f.input.assets[1].file = f.input.assets[0].file;
		await f.save();
	}, "reference-asset-set-invalid"));
test("unknown basename is rejected", () =>
	preflightFailure(async (f) => {
		f.input.assets[0].file = "extra.tar";
		await f.save();
	}, "reference-asset-set-invalid"));
test("oversize expected bytes are rejected", () =>
	preflightFailure(async (f) => {
		f.input.assets[0].bytes = 2 * 1024 ** 3 + 1;
		await f.save();
	}, "reference-schema-invalid"));
test("zero expected bytes are rejected", () =>
	preflightFailure(async (f) => {
		f.input.assets[0].bytes = 0;
		await f.save();
	}, "reference-schema-invalid"));
test("oversize metadata is rejected", () =>
	preflightFailure(async (f) => {
		f.input.assets.at(-1).bytes = 1024 ** 2 + 1;
		await f.save();
	}, "reference-metadata-too-large"));
test("missing local selected asset is rejected", () =>
	preflightFailure(async (f) => {
		// A fresh fixture path makes this missing without deleting any file.
		const other = join(root, `missing-reference-${caseNumber}`);
		await mkdir(other);
		await mkdir(join(other, "assets"));
		await writeFile(join(other, "result.json"), JSON.stringify(f.input), { flag: "wx" });
		await writeFile(join(other, "assets", "SHA256SUMS"), f.bodies.get("SHA256SUMS"), { flag: "wx" });
		f.reference = other;
	}, "reference-file-unavailable"));
test("same-size local hash mismatch is rejected", () =>
	preflightFailure(async (f) => {
		await writeFile(join(f.reference, "assets", entries[0][0]), Buffer.alloc(f.bodies.get(entries[0][0]).length));
	}, "reference-hash-mismatch"));
test("local size mismatch is rejected", () =>
	preflightFailure(async (f) => {
		await writeFile(join(f.reference, "assets", entries[0][0]), "short");
	}, "reference-size-mismatch"));
test("untrusted changed SHA256SUMS bytes are rejected", () =>
	preflightFailure(async (f) => {
		await writeFile(join(f.reference, "assets", "SHA256SUMS"), "changed\n");
	}, "reference-SHA256SUMS-hash-mismatch"));
test("missing SHA entry is rejected even when sums bytes are trusted", () =>
	preflightFailure(
		(f) => f.sumsReplace(f.bodies.get("SHA256SUMS").toString().split("\n").slice(1).join("\n")),
		"reference-SHA256SUMS-entries-invalid",
	));
test("mismatched SHA entry is rejected", () =>
	preflightFailure(
		(f) =>
			f.sumsReplace(
				f.bodies
					.get("SHA256SUMS")
					.toString()
					.replace(/^[a-f0-9]{64}/, "0".repeat(64)),
			),
		"reference-SHA256SUMS-binding-mismatch",
	));
test("duplicate SHA entry is rejected", () =>
	preflightFailure(
		(f) =>
			f.sumsReplace(
				`${f.bodies.get("SHA256SUMS").toString()}${f.bodies.get("SHA256SUMS").toString().split("\n")[0]}\n`,
			),
		"reference-SHA256SUMS-entries-invalid",
	));
test("path in SHA entry is rejected", () =>
	preflightFailure(
		(f) => f.sumsReplace(f.bodies.get("SHA256SUMS").toString().replace(entries[0][0], "../escape")),
		"reference-SHA256SUMS-entries-invalid",
	));
test("non-ASCII SHA bytes are rejected", () =>
	preflightFailure(
		(f) => f.sumsReplace(f.bodies.get("SHA256SUMS").toString().replace(entries[0][0], "é.tar")),
		"reference-SHA256SUMS-format-invalid",
	));
test("symlinked reference file is rejected", () =>
	preflightFailure(async (f) => {
		const other = join(root, `symlink-reference-${caseNumber}`);
		await mkdir(other);
		await mkdir(join(other, "assets"));
		await writeFile(join(other, "result.json"), JSON.stringify(f.input), { flag: "wx" });
		await writeFile(join(other, "assets", "SHA256SUMS"), f.bodies.get("SHA256SUMS"), { flag: "wx" });
		await symlink(join(f.reference, "assets", entries[0][0]), join(other, "assets", entries[0][0]));
		f.reference = other;
	}, "reference-file-unavailable"));

async function downloadFailure(responseFactory, code) {
	const f = await fixture();
	const { fake } = responder(f, (file) =>
		file === "computer-distribution.json" ? responseFactory(f.bodies.get(file)) : undefined,
	);
	const report = await run(f, fake, metadataOnly);
	assert.equal(report.passed, false);
	const record = report.records.find((r) => r.file === "computer-distribution.json");
	assert.equal(record.error, code);
	assert.equal(record.passed, false);
	assert(!(await readdir(join(f.out, "assets"))).includes(record.file));
	assert((await readdir(join(f.out, "partials"))).some((file) => file.startsWith(record.file)));
}
test("content-length mismatch leaves an unverified partial", () =>
	downloadFailure(
		(body) => streamed(body, { "content-length": String(body.length + 1) }),
		"download-content-length-mismatch",
	));
test("stream cannot exceed the trusted expected size", () =>
	downloadFailure((body) => streamed(Buffer.concat([body, Buffer.from("extra")]), {}), "download-size-exceeded"));
test("short stream cannot become a final file", () =>
	downloadFailure((body) => streamed(body.subarray(1), {}), "download-size-mismatch"));
test("same-size wrong hash cannot become a final file", () =>
	downloadFailure((body) => streamed(Buffer.alloc(body.length)), "download-hash-mismatch"));

test("approved public CDN HTTPS redirects work without recording signed URLs", async () => {
	const f = await fixture();
	const { fake, seen } = responder(f, (file, url) => {
		if (url.hostname === "github.com")
			return new Response(null, {
				status: 302,
				headers: { location: `https://release-assets.githubusercontent.com/inert/${file}?sig=must-not-be-recorded` },
			});
		return streamed(f.bodies.get(file));
	});
	const report = await run(f, fake, metadataOnly);
	assert.equal(report.passed, true);
	assert.equal(seen.length, 4);
	assert(!JSON.stringify(report).includes("must-not-be-recorded"));
});
test("HTTP redirects are refused before following them", () =>
	downloadFailure(
		() =>
			new Response(null, {
				status: 302,
				headers: { location: "http://release-assets.githubusercontent.com/private?sig=secret" },
			}),
		"redirect-not-public-release-https",
	));
test("arbitrary/private redirect hosts are refused", () =>
	downloadFailure(
		() => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/private" } }),
		"redirect-not-public-release-https",
	));

test("transient GET errors retry with fresh owned partials and sanitized errors", async () => {
	const f = await fixture();
	const counts = new Map();
	const { fake } = responder(f, (file) => {
		counts.set(file, (counts.get(file) ?? 0) + 1);
		if (counts.get(file) === 1) throw new Error("https://private.invalid/?sig=must-not-be-recorded");
	});
	const report = await run(f, fake, metadataOnly);
	assert.equal(report.passed, true);
	for (const record of report.records) {
		assert.equal(record.attempts.length, 2);
		assert.equal(record.attempts[0].error, "fetch-failed");
		assert.equal(record.attempts[1].passed, true);
	}
	assert.equal((await readdir(join(f.out, "partials"))).length, 2);
	assert(!JSON.stringify(report).includes("must-not-be-recorded"));
});
test("retries stop after three failed GETs", async () => {
	const f = await fixture();
	const { fake, seen } = responder(f, () => new Response(null, { status: 503 }));
	const report = await run(f, fake, metadataOnly);
	assert.equal(report.passed, false);
	assert.equal(seen.length, 6);
	assert(report.records.every((record) => record.attempts.length === 3 && record.error === "http-503"));
});
test("pre-existing output is never reused or overwritten", async () => {
	const f = await fixture();
	await mkdir(f.out);
	await writeFile(join(f.out, "owner-file"), "keep", { flag: "wx" });
	const { fake, seen } = responder(f);
	await assert.rejects(() => run(f, fake, metadataOnly));
	assert.equal(await readFile(join(f.out, "owner-file"), "utf8"), "keep");
	assert.deepEqual(await readdir(f.out), ["owner-file"]);
	assert.equal(seen.length, 0);
});
test("pre-existing destination is never overwritten", async () => {
	const f = await fixture();
	const { fake } = responder(f, async (file) => {
		if (file === "computer-distribution.json") await writeFile(join(f.out, "assets", file), "keep", { flag: "wx" });
	});
	const report = await run(f, fake, metadataOnly);
	assert.equal(report.passed, false);
	assert.equal(await readFile(join(f.out, "assets", "computer-distribution.json"), "utf8"), "keep");
});
test("selected mode accepts exactly the two final metadata basenames", async () => {
	const f = await fixture();
	const { fake, seen } = responder(f);
	const report = await run(f, fake, "RELEASE-REVIEW.md");
	assert.equal(report.passed, false);
	assert(report.errors.includes("only-requires-computer-distribution-and-SHA256SUMS"));
	assert.equal(seen.length, 0);
});
test("CLI requires explicit run and has no configurable external host", async () => {
	await assert.rejects(() => main(["--out", "/unused"]), /explicit-out-and-run-required/);
	await assert.rejects(
		() => main(["--out", "/unused", "--run", "--base-url", "http://localhost"]),
		/arguments-invalid/,
	);
	await assert.rejects(() => main(["--reference", "/unused", "--out", "/unused", "--run"]), /arguments-invalid/);
});

const results = [];
for (const { name, fn } of tests) {
	try {
		await fn();
		results.push({ name, passed: true });
	} catch (error) {
		results.push({ name, passed: false, error: error instanceof Error ? error.message : "test-failed" });
	}
}
const summary = {
	passed: results.every((r) => r.passed),
	evidence: "inert-local-fake-fetch-only",
	noNetworkRequests: true,
	cases: results.length,
	results,
};
process.stdout.write(
	`${JSON.stringify({ passed: summary.passed, cases: summary.cases, failures: results.filter((r) => !r.passed) }, null, 2)}\n`,
);
process.exitCode = summary.passed ? 0 : 1;
await rm(root, { recursive: true });
