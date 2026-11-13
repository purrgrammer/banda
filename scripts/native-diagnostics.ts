import { open, realpath } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";

const fileLimit = 64 << 10;
export async function diagnosticFile(path: string) {
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

export async function hostDiagnostics(roots = { proc: "/proc", cgroup: "/sys/fs/cgroup" }) {
	const membership = await diagnosticFile(resolve(roots.proc, "self/cgroup"));
	const files = {
		meminfo: await diagnosticFile(resolve(roots.proc, "meminfo")),
		limits: await diagnosticFile(resolve(roots.proc, "self/limits")),
		membership,
	};
	const path = membership.text
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
	return { at: new Date().toISOString(), cpus: availableParallelism(), files, memory };
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
