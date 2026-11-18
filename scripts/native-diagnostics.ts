import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const fileLimit = 64 << 10;
const unavailable = (error: unknown) => ({ state: "unavailable", error: String(error).slice(0, 4000) }) as const;
const Unavailable = Type.Object({ state: Type.Literal("unavailable"), error: Type.String() });
const BoundedObservation = Type.Union([
	Type.Object({ state: Type.Union([Type.Literal("read"), Type.Literal("truncated")]), text: Type.String() }),
	Unavailable,
]);
const Id = Type.Integer({ minimum: 0, maximum: 4294967295 });
const Capability = Type.String({ pattern: "^[0-9a-fA-F]{16}$" });
const Identity = Type.Object({
	uid: Id,
	euid: Id,
	savedUid: Id,
	fsuid: Id,
	gid: Id,
	egid: Id,
	savedGid: Id,
	fsgid: Id,
	groups: Type.Array(Id),
	capabilities: Type.Object({
		inherited: Capability,
		permitted: Capability,
		effective: Capability,
		bounding: Capability,
		ambient: Capability,
	}),
});
const KvmObservation = Type.Object({
	at: Type.String(),
	status: BoundedObservation,
	identity: Type.Union([Type.Object({ state: Type.Literal("read"), value: Identity }), Unavailable]),
	device: Type.Union([
		Type.Object({
			state: Type.Literal("read"),
			kind: Type.Union([Type.Literal("character"), Type.Literal("symlink"), Type.Literal("other")]),
			uid: Id,
			gid: Id,
			mode: Id,
			inode: Type.Number(),
			dev: Type.Number(),
			rdev: Type.Number(),
		}),
		Unavailable,
	]),
	acl: BoundedObservation,
	open: Type.Union([
		Type.Object({ state: Type.Literal("opened-and-closed") }),
		Type.Object({
			state: Type.Literal("failed"),
			code: Type.Union([Type.String(), Type.Null()]),
			error: Type.String(),
		}),
		Unavailable,
	]),
});

export function parseDiagnosticIdentity(status: unknown) {
	assert.ok(typeof status === "string", "Missing process status.");
	const field = (name: string) => {
		const lines = status.split("\n").filter((line) => line.startsWith(`${name}:`));
		assert.equal(lines.length, 1, `Missing or repeated ${name} in process status.`);
		return lines[0]?.slice(name.length + 1).trim() ?? "";
	};
	const ids = (name: string) => {
		const value = field(name);
		assert.match(value, /^\d+\s+\d+\s+\d+\s+\d+$/);
		return value.split(/\s+/).map(Number);
	};
	const [uid, euid, savedUid, fsuid] = ids("Uid");
	const [gid, egid, savedGid, fsgid] = ids("Gid");
	const groups = field("Groups");
	assert.match(groups, /^(?:\d+(?:\s+\d+)*)?$/);
	const identity = {
		uid,
		euid,
		savedUid,
		fsuid,
		gid,
		egid,
		savedGid,
		fsgid,
		groups: groups ? groups.split(/\s+/).map(Number) : [],
		capabilities: {
			inherited: field("CapInh"),
			permitted: field("CapPrm"),
			effective: field("CapEff"),
			bounding: field("CapBnd"),
			ambient: field("CapAmb"),
		},
	};
	if (!Value.Check(Identity, identity)) throw new Error("Invalid process identity.");
	return identity;
}

export function assertDiagnosticIdentity(actual: unknown, expected: unknown, supplementaryGid?: number) {
	if (!Value.Check(Identity, actual) || !Value.Check(Identity, expected)) throw new Error("Invalid runner identity.");
	assert.ok(expected.uid > 0 && expected.euid === expected.uid && expected.gid > 0 && expected.egid === expected.gid);
	assert.ok(
		expected.savedUid === expected.uid && expected.fsuid === expected.uid,
		"Runner saved and filesystem UIDs must be ordinary.",
	);
	assert.ok(
		expected.savedGid === expected.gid && expected.fsgid === expected.gid,
		"Runner saved and filesystem GIDs must match its primary group.",
	);
	for (const key of ["uid", "euid", "savedUid", "fsuid", "gid", "egid", "savedGid", "fsgid"] as const)
		assert.equal(actual[key], expected[key], `Runner ${key} changed.`);
	for (const key of ["inherited", "permitted", "effective", "ambient"] as const) {
		assert.match(expected.capabilities[key], /^0+$/, `Original runner ${key} capabilities must be empty.`);
		assert.match(actual.capabilities[key], /^0+$/, `Runner ${key} capabilities must be empty.`);
	}
	assert.equal(
		BigInt(`0x${actual.capabilities.bounding}`),
		BigInt(`0x${expected.capabilities.bounding}`),
		"Runner bounding capabilities changed.",
	);
	if (supplementaryGid !== undefined)
		assert.ok(
			Number.isSafeInteger(supplementaryGid) && supplementaryGid > 0 && supplementaryGid <= 4294967295,
			"Invalid KVM supplementary group.",
		);
	const groups = new Set(expected.groups);
	if (supplementaryGid !== undefined) groups.add(supplementaryGid);
	assert.deepEqual(
		[...new Set(actual.groups)].sort((a, b) => a - b),
		[...groups].sort((a, b) => a - b),
		"Runner supplementary groups must equal the original set plus canonical KVM.",
	);
}

export function diagnosticAcl(path: string): Static<typeof BoundedObservation> {
	try {
		const bytes = execFileSync("/usr/bin/getfacl", ["--numeric", "--absolute-names", "--", path], {
			timeout: 5_000,
			killSignal: "SIGKILL",
			maxBuffer: fileLimit,
			stdio: ["ignore", "pipe", "pipe"],
			env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
		});
		return {
			state: bytes.length > fileLimit ? "truncated" : "read",
			text: bytes.subarray(0, fileLimit).toString("utf8"),
		};
	} catch (error) {
		return unavailable(error);
	}
}

export async function kvmDiagnostics(roots = { proc: "/proc", dev: "/dev" }): Promise<Static<typeof KvmObservation>> {
	const status = await diagnosticFile(resolve(roots.proc, "self/status"));
	const identity = (() => {
		try {
			if (status.state !== "read") throw new Error("Process status is unavailable or truncated.");
			return { state: "read", value: parseDiagnosticIdentity(status.text) } as const;
		} catch (error) {
			return unavailable(error);
		}
	})();
	const path = resolve(roots.dev, "kvm");
	const device = await (async () => {
		try {
			const stat = await lstat(path);
			const kind = stat.isSymbolicLink() ? "symlink" : stat.isCharacterDevice() ? "character" : "other";
			return {
				state: "read",
				kind,
				uid: stat.uid,
				gid: stat.gid,
				mode: stat.mode,
				inode: stat.ino,
				dev: stat.dev,
				rdev: stat.rdev,
			} as const;
		} catch (error) {
			return unavailable(error);
		}
	})();
	const safe = device.state === "read" && device.kind === "character";
	const acl = safe
		? diagnosticAcl(path)
		: unavailable("Refusing ACL inspection of a missing or non-character KVM device.");
	const access = await (async (): Promise<Static<typeof KvmObservation>["open"]> => {
		if (!safe) return unavailable("Refusing to open a missing, symlink, or non-character KVM device.");
		let file: Awaited<ReturnType<typeof open>>;
		try {
			file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
		} catch (error) {
			return {
				state: "failed",
				code: error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null,
				error: String(error).slice(0, 4000),
			};
		}
		try {
			try {
				const opened = await file.stat();
				assert.ok(
					opened.isCharacterDevice() &&
						opened.ino === device.inode &&
						opened.dev === device.dev &&
						opened.rdev === device.rdev,
					"KVM device changed before open.",
				);
			} finally {
				await file.close();
			}
			return { state: "opened-and-closed" };
		} catch (error) {
			return unavailable(error);
		}
	})();
	return { at: new Date().toISOString(), status, identity, device, acl, open: access };
}

export function assertKvmGroup(observation: unknown, group: string) {
	if (!Value.Check(KvmObservation, observation)) throw new Error("Invalid KVM observation.");
	const { device, acl } = observation;
	assert.ok(
		device.state === "read" && device.kind === "character" && device.uid === 0,
		"KVM must be a root-owned character device.",
	);
	assert.match(group.trim(), /^kvm:[^:\n]*:[1-9]\d*:[^:\n]*$/);
	const gid = Number(group.trim().split(":")[2]);
	assert.ok(
		Number.isSafeInteger(gid) && gid === device.gid && (device.mode & 0o060) === 0o060 && (device.mode & 0o007) === 0,
		"KVM requires its canonical nonzero group, group read/write, and no world access.",
	);
	assert.equal(acl.state, "read", "KVM ACL must be complete.");
	assert.ok(acl.state === "read");
	const entries = acl.text.split("\n").map((line) => line.split("\t")[0]?.trim());
	assert.equal(entries.filter((line) => line === "group::rw-").length, 1, "KVM owning group requires read/write.");
	assert.equal(entries.filter((line) => line === "other::---").length, 1, "KVM world access must be empty.");
	assert.ok(
		entries.filter((line) => line?.startsWith("mask::")).every((line) => line === "mask::rw-"),
		"KVM ACL mask must retain group read/write.",
	);
	return gid;
}

const HostObservation = Type.Object({ at: Type.String(), kvm: KvmObservation });
const Probe = Type.Union([
	Type.Object({ state: Type.Literal("not-triggered") }),
	Type.Object({ state: Type.Literal("refused-or-failed"), error: Type.String() }),
	Type.Object({ state: Type.Literal("owned-before-probe"), hostAtFailure: HostObservation }),
	Type.Object({
		state: Type.Literal("captured"),
		hostAtFailure: HostObservation,
		capture: Type.Object({
			closed: Type.Boolean(),
			reason: Type.String(),
			bytesObserved: Type.Integer({ minimum: 0 }),
			bytesRetained: Type.Integer({ minimum: 0 }),
			code: Type.Union([Type.Integer(), Type.Null()]),
			signal: Type.Union([Type.String(), Type.Null()]),
			stderr: Type.String(),
			controlError: Type.Optional(Type.String()),
		}),
	}),
]);
const DiagnosticResult = Type.Object({
	qualification: Type.Literal(false),
	sourceCommit: Type.String({ pattern: "^[a-f0-9]{40}$" }),
	runtimeManifestSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
	home: Type.String(),
	cache: Type.String(),
	owner: Type.Object({
		binary: Type.String(),
		home: Type.String(),
		cache: Type.String(),
		name: Type.String(),
		generation: Type.String(),
		imageRef: Type.String(),
		configDigest: Type.String(),
	}),
	hostBefore: HostObservation,
	hostAfter: HostObservation,
	probe: Probe,
	originalFailure: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
	cleanup: Type.Object({
		verified: Type.Literal(true),
		inventory: Type.Tuple([]),
		remaining: Type.Tuple([]),
		children: Type.Array(
			Type.Object({ pid: Type.Optional(Type.Integer({ minimum: 1 })), closed: Type.Literal(true) }),
			{ minItems: 1 },
		),
	}),
});

export function parseDiagnosticResult(
	value: unknown,
	expected: { sourceCommit: string; runtimeManifestSha256: string },
) {
	if (!Value.Check(DiagnosticResult, value))
		throw new Error("Invalid or incomplete diagnostic result or unverified cleanup.");
	assert.equal(value.sourceCommit, expected.sourceCommit, "Diagnostic source differs.");
	assert.equal(value.runtimeManifestSha256, expected.runtimeManifestSha256, "Diagnostic manifest differs.");
	assert.equal(value.owner.home, value.home);
	assert.equal(value.owner.cache, value.cache);
	const startup =
		value.originalFailure !== null ? "failed" : value.probe.state === "not-triggered" ? "started" : "unknown";
	const hosts = [value.hostBefore, value.hostAfter];
	if ("hostAtFailure" in value.probe) hosts.push(value.probe.hostAtFailure);
	const complete = hosts.every(
		({ kvm }) =>
			kvm.status.state === "read" &&
			kvm.identity.state === "read" &&
			kvm.device.state === "read" &&
			kvm.device.kind === "character" &&
			kvm.acl.state === "read" &&
			kvm.open.state !== "unavailable",
	);
	const probeComplete =
		value.probe.state === "not-triggered"
			? startup === "started"
			: value.probe.state === "captured" &&
				value.probe.capture.closed &&
				value.probe.capture.reason === "closed" &&
				value.probe.capture.controlError === undefined &&
				value.probe.capture.bytesObserved === value.probe.capture.bytesRetained &&
				value.probe.capture.bytesRetained <= 1 << 20;
	return { result: value, startup, evidenceComplete: complete && probeComplete && startup !== "unknown" };
}

export async function diagnosticFile(path: string): Promise<Static<typeof BoundedObservation>> {
	try {
		const file = await open(path, "r");
		try {
			const bytes = Buffer.alloc(fileLimit + 1);
			const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
			return {
				state: bytesRead > fileLimit ? "truncated" : "read",
				text: bytes.subarray(0, Math.min(bytesRead, fileLimit)).toString("utf8"),
			};
		} finally {
			await file.close();
		}
	} catch (error) {
		return { state: "unavailable", error: error instanceof Error ? error.message : String(error) };
	}
}

export async function hostDiagnostics(roots = { proc: "/proc", cgroup: "/sys/fs/cgroup", dev: "/dev" }) {
	const membership = await diagnosticFile(resolve(roots.proc, "self/cgroup"));
	const files = {
		meminfo: await diagnosticFile(resolve(roots.proc, "meminfo")),
		limits: await diagnosticFile(resolve(roots.proc, "self/limits")),
		membership,
	};
	const path = (membership.state === "unavailable" ? undefined : membership.text)
		?.split("\n")
		.find((line) => line.startsWith("0::/"))
		?.slice(3);
	const memory = await (async () => {
		try {
			if (path === undefined) throw new Error("No unified cgroup membership is available.");
			const base = await realpath(roots.cgroup);
			const directory = await realpath(resolve(base, `.${path}`));
			const inside = relative(base, directory);
			if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
				throw new Error("The cgroup membership escapes its mount.");
			return {
				state: "located",
				path,
				maximum: await diagnosticFile(resolve(directory, "memory.max")),
				current: await diagnosticFile(resolve(directory, "memory.current")),
				events: await diagnosticFile(resolve(directory, "memory.events")),
			};
		} catch (error) {
			return { state: "unavailable", error: error instanceof Error ? error.message : String(error) };
		}
	})();
	return {
		at: new Date().toISOString(),
		cpus: availableParallelism(),
		files,
		memory,
		kvm: await kvmDiagnostics(roots),
	};
}

export type StartupOwner = {
	readonly binary: string;
	readonly cache: string;
	readonly home: string;
	readonly name: string;
	readonly generation: string;
	readonly imageRef: string;
	readonly configDigest: string;
};

export function diagnosticImage(owner: StartupOwner, value: unknown) {
	const schema = Type.Object({
		digest: Type.String(),
		config: Type.Object({ digest: Type.Literal(owner.configDigest) }),
		architecture: Type.Literal("amd64"),
		os: Type.Literal("linux"),
	});
	if (!Value.Check(schema, value)) throw new Error("The diagnostic image differs from the verified bundle.");
	return value;
}

export function diagnosticInspection(owner: StartupOwner, value: unknown, manifestDigest: string) {
	const schema = Type.Object({
		name: Type.Literal(owner.name),
		status: Type.String(),
		config: Type.Object({
			manifest_digest: Type.Literal(manifestDigest),
			labels: Type.Object({
				"banda.home": Type.Literal(owner.home),
				"banda.runtime": Type.Literal("microvm"),
				"banda.generation": Type.Literal(owner.generation),
			}),
			network: Type.Object({ ports: Type.Tuple([]) }),
		}),
	});
	if (!Value.Check(schema, value)) throw new Error("The diagnostic requires this exact owned command VM.");
	return { canStart: value.status === "Stopped" || value.status === "Crashed", inspection: value };
}

export function ownedCreateInvocation(owner: StartupOwner, file: unknown, args: unknown, options: unknown) {
	if (file !== owner.binary || !Value.Check(Type.Array(Type.String()), args)) return false;
	const environment = Type.Object({ env: Type.Object({ MSB_HOME: Type.Literal(owner.cache) }) });
	if (!Value.Check(environment, options)) return false;
	const labels = args.filter((_, index) => args[index - 1] === "--label");
	const expected = [`banda.home=${owner.home}`, "banda.runtime=microvm", `banda.generation=${owner.generation}`];
	if (
		args[0] !== "create" ||
		args.filter((part) => part === "--name").length !== 1 ||
		args[args.indexOf("--name") + 1] !== owner.name ||
		args.at(-1) !== owner.imageRef ||
		labels.length !== expected.length ||
		!expected.every((label) => labels.includes(label))
	)
		return false;
	return true;
}

export function failedCreateObserver(owner: StartupOwner, diagnose: () => Promise<void>) {
	let used = false;
	return async (file: unknown, args: unknown, options: unknown, error: unknown) => {
		if (!(error instanceof Error) || used || !ownedCreateInvocation(owner, file, args, options)) return;
		used = true;
		await diagnose();
	};
}

export async function deliverCreateResult({
	diagnose,
	recordFailure,
	deliver,
}: {
	diagnose: () => Promise<void>;
	recordFailure: (error: unknown) => Promise<void>;
	deliver: () => void;
}): Promise<void> {
	try {
		await diagnose();
	} catch (error) {
		try {
			await recordFailure(error);
		} catch {}
	} finally {
		deliver();
	}
}
