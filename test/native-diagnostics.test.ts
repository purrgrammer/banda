import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	deliverCreateResult,
	diagnosticFile,
	diagnosticImage,
	diagnosticInspection,
	failedCreateObserver,
	hostDiagnostics,
} from "../scripts/native-diagnostics.ts";

const homes: string[] = [];
afterEach(async () => {
	for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function home() {
	const path = await mkdtemp(join(tmpdir(), "banda-native-diagnostics-test-"));
	homes.push(path);
	return path;
}
const owner = {
	binary: "/staged/msb",
	cache: "/tmp/owned-msb",
	home: "/tmp/owned-home",
	name: "banda-microvm-0123456789-0123456789ab",
	generation: "0123456789ab",
	imageRef: "banda-box:fixture",
	configDigest: "sha256:config",
};
const labels = { "banda.home": owner.home, "banda.runtime": "microvm", "banda.generation": owner.generation };
const inspected = {
	name: owner.name,
	status: "Crashed",
	config: { labels, manifest_digest: "sha256:manifest", network: { ports: [] }, cpus: 2, memory: 4096 },
};
const args = [
	"create",
	"--name",
	owner.name,
	...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
	"--memory",
	"4GiB",
	"--pull",
	"never",
	owner.imageRef,
];
const options = { env: { MSB_HOME: owner.cache } };

it("retains full effective config while refusing another owner, image, or active VM", () => {
	expect(diagnosticInspection(owner, inspected, "sha256:manifest")).toEqual({ canStart: true, inspection: inspected });
	for (const status of ["Running", "Starting", "Draining"])
		expect(diagnosticInspection(owner, { ...inspected, status }, "sha256:manifest").canStart).toBe(false);
	for (const value of [
		{ ...inspected, name: `${owner.name}-proxy` },
		{ ...inspected, config: { ...inspected.config, labels: { ...labels, "banda.home": "/other" } } },
		{ ...inspected, config: { ...inspected.config, labels: { ...labels, "banda.generation": "other" } } },
		{ ...inspected, config: { ...inspected.config, manifest_digest: "other" } },
		{ ...inspected, config: { ...inspected.config, network: { ports: [80] } } },
	])
		expect(() => diagnosticInspection(owner, value, "sha256:manifest")).toThrow(/exact owned/);
});

it("admits one diagnostic only for the failed exact owned command create", async () => {
	const diagnose = vi.fn(async () => {});
	const observe = failedCreateObserver(owner, diagnose);
	const failure = new Error("original startup abort");
	for (const invocation of [
		["/other/msb", args, options, failure],
		[owner.binary, args, { env: { MSB_HOME: "/other" } }, failure],
		[owner.binary, args.map((part) => (part === owner.name ? `${owner.name}-proxy` : part)), options, failure],
		[owner.binary, args.map((part) => (part === owner.imageRef ? "other-image" : part)), options, failure],
		[owner.binary, args, options, null],
		[owner.binary, args, options, undefined],
		[owner.binary, args, options, "not an exec error"],
		[owner.binary, ["start", owner.name], options, failure],
		[owner.binary, ["create", "--name", owner.name, owner.imageRef], options, failure],
	])
		await observe(invocation[0], invocation[1], invocation[2], invocation[3]);
	expect(diagnose).not.toHaveBeenCalled();
	await observe(owner.binary, args, options, failure);
	await observe(owner.binary, args, options, failure);
	expect(diagnose).toHaveBeenCalledTimes(1);
});

it("never retries a refused or failed diagnostic", async () => {
	const refusal = new Error("ownership changed before diagnostic");
	const diagnose = vi.fn(async () => {
		throw refusal;
	});
	const observe = failedCreateObserver(owner, diagnose);
	await expect(observe(owner.binary, args, options, new Error("original"))).rejects.toBe(refusal);
	await observe(owner.binary, args, options, new Error("original"));
	expect(diagnose).toHaveBeenCalledTimes(1);
});

it("bounds each host file and records unavailable paths", async () => {
	const root = await home();
	const path = join(root, "large");
	await writeFile(path, "a".repeat(70_000));
	const result = await diagnosticFile(path);
	expect(result.state).toBe("truncated");
	expect(Buffer.byteLength(result.text ?? "")).toBe(64 << 10);
	expect((await diagnosticFile(join(root, "missing"))).state).toBe("unavailable");
	expect((await readFile(path)).length).toBe(70_000);
});

it("reads only the current cgroup beneath the verified mount", async () => {
	const root = await home();
	const proc = join(root, "proc"),
		cgroup = join(root, "cgroup");
	await mkdir(join(proc, "self"), { recursive: true });
	await mkdir(join(cgroup, "current"), { recursive: true });
	await writeFile(join(proc, "self/cgroup"), "0::/current\n");
	await writeFile(join(cgroup, "current/memory.max"), "4294967296\n");
	const result = await hostDiagnostics({ proc, cgroup });
	expect(result.memory).toMatchObject({ state: "located", maximum: { text: "4294967296\n" } });
	await symlink(root, join(cgroup, "escape"));
	await writeFile(join(proc, "self/cgroup"), "0::/escape\n");
	expect((await hostDiagnostics({ proc, cgroup })).memory).toMatchObject({
		state: "unavailable",
		error: expect.stringContaining("escapes"),
	});
});

it("distinguishes the loaded manifest identity from the verified image config", () => {
	const image = {
		digest: "sha256:manifest",
		config: { digest: owner.configDigest },
		architecture: "amd64",
		os: "linux",
	};
	expect(diagnosticImage(owner, image)).toBe(image);
	expect(() => diagnosticImage(owner, { ...image, config: { digest: "other" } })).toThrow(/verified bundle/);
	expect(() => diagnosticInspection(owner, inspected, owner.configDigest)).toThrow(/exact owned/);
});

it("delivers the original callback result after diagnostics, including when recording fails", async () => {
	const original = new Error("original VM abort"),
		stdout = Buffer.from("stdout"),
		stderr = Buffer.from("stderr");
	const callback = vi.fn();
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const held = deliverCreateResult({
		diagnose: () => gate,
		recordFailure: async () => {},
		deliver: () => callback(original, stdout, stderr),
	});
	expect(callback).not.toHaveBeenCalled();
	release?.();
	await held;
	expect(callback).toHaveBeenLastCalledWith(original, stdout, stderr);
	await deliverCreateResult({
		diagnose: async () => {
			throw new Error("probe failed");
		},
		recordFailure: async () => {
			throw new Error("disk failed");
		},
		deliver: () => callback(original, stdout, stderr),
	});
	expect(callback).toHaveBeenCalledTimes(2);
	expect(callback.mock.calls[1]?.[0]).toBe(original);
	expect(callback.mock.calls[1]?.[1]).toBe(stdout);
	expect(callback.mock.calls[1]?.[2]).toBe(stderr);
});
