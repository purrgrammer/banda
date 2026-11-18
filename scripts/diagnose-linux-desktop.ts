import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, watch } from "node:fs";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { BrowserPreparation } from "../src/box/browser-preparation.ts";
import { fileSha256 as hash, readMicrovmAssets } from "../src/box/microvm-assets.ts";
import {
	assertDiagnosticIdentity,
	assertKvmGroup,
	kvmDiagnostics,
	parseDiagnosticIdentity,
} from "./native-diagnostics.ts";
import { parseLinuxRunnerAccount } from "./verify-linux-computer.ts";

const limit = 1 << 20;
const executable = "/opt/banda/banda-desktop";
const installed = "/opt/banda/resources/banda";
const now = () => process.hrtime.bigint().toString();
const message = (error: unknown) => String(error).slice(0, 4000);
const Text = Type.String({ maxLength: limit });
const Hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const Ticks = Type.String({ pattern: "^[1-9][0-9]*$" });
const Completion = Type.Object({
	status: Type.Union([Type.Integer(), Type.Null()]),
	signal: Type.Union([Text, Type.Null()]),
	error: Type.Union([Text, Type.Null()]),
	stdout: Text,
	stderr: Text,
});
const Process = Type.Object({
	pid: Type.Integer({ minimum: 1 }),
	startTicks: Ticks,
	status: Text,
	cgroup: Text,
	executable: Text,
	command: Text,
	userns: Text,
	pidns: Text,
	uidMap: Text,
	gidMap: Text,
});
const Unit = Type.Record(Type.String(), Text);
const Identity = Type.Object({
	sourceCommit: Type.String({ pattern: "^[a-f0-9]{40}$" }),
	verifierSha256: Hash,
	version: Text,
	debSha256: Hash,
	asarSha256: Hash,
	executableSha256: Hash,
	runtimeManifestSha256: Hash,
});
const Page = Type.Object({
	width: Type.Integer(),
	height: Type.Integer(),
	origin: Text,
	heading: Text,
	firstRun: Type.Boolean(),
	requireType: Text,
	processType: Text,
	bridgeType: Text,
	bridgeFrozen: Type.Boolean(),
	screenshotSha256: Hash,
});
const VMName = Type.String({ pattern: "^banda-microvm-[a-f0-9]{10}-[a-f0-9]{12}(?:-(?:proxy|browser))?$" });
const ListedVM = Type.Object({
	name: VMName,
	status: Type.Union([
		Type.Literal("Created"),
		Type.Literal("Starting"),
		Type.Literal("Running"),
		Type.Literal("Draining"),
		Type.Literal("Paused"),
		Type.Literal("Stopped"),
		Type.Literal("Crashed"),
	]),
});
const Listing = Type.Array(ListedVM, { maxItems: 3 });
const InspectedVM = Type.Object({
	...ListedVM.properties,
	config: Type.Object({
		labels: Type.Object({
			"banda.home": Text,
			"banda.runtime": Type.Literal("microvm"),
			"banda.generation": Type.String({ pattern: "^[a-f0-9]{12}$" }),
		}),
	}),
});
const Inventory = Type.Array(
	Type.Object({
		listed: ListedVM,
		inspected: InspectedVM,
		inspection: Completion,
		process: Type.Union([Process, Type.Null()]),
	}),
	{ maxItems: 3 },
);
const Computer = Type.Object({
	type: Type.Literal("computer"),
	computer: Type.Object({
		state: Type.Union([
			Type.Literal("starting"),
			Type.Literal("building"),
			Type.Literal("up"),
			Type.Literal("offline"),
		]),
		why: Type.Optional(Text),
		box: Type.Literal("microvm"),
		network: Type.Union([Type.Literal("guarded"), Type.Literal("none")]),
		browser: BrowserPreparation,
	}),
});
const Started = Type.Object({
	shell: Process,
	daemon: Process,
	renderers: Type.Array(Process, { maxItems: 128 }),
	unit: Unit,
	pages: Type.Array(Page, { maxItems: 2 }),
	daemonPort: Type.Integer({ minimum: 1, maximum: 65535 }),
	home: Type.String({ pattern: "^/(?:[A-Za-z0-9._-]+/)*home/[.]banda$", maxLength: 4096 }),
	computer: Type.Object({ atNs: Ticks, value: Computer.properties.computer }),
	inventoryList: Type.Union([
		Type.Object({ kind: Type.Literal("absent") }),
		Type.Object({ kind: Type.Literal("listed"), completion: Completion }),
	]),
	inventory: Inventory,
});
const BeforeRescue = Type.Union([
	Type.Object({
		kind: Type.Literal("observed"),
		atNs: Ticks,
		unit: Unit,
		cgroup: Type.Union([Type.Literal("empty"), Type.Literal("absent")]),
		populated: Type.Union([Type.Literal(0), Type.Null()]),
		members: Type.Array(Type.Integer(), { maxItems: 0 }),
		inventory: Type.Array(Type.Unknown(), { maxItems: 0 }),
		mainAbsent: Type.Literal(true),
		daemonAbsent: Type.Literal(true),
		vmBirthsAbsent: Type.Literal(true),
		listenerClosed: Type.Literal(true),
		action: Type.Literal("native-ctrl-q"),
		input: Completion,
	}),
	Type.Object({ kind: Type.Literal("failed"), error: Text, lastUnit: Type.Union([Unit, Type.Null()]) }),
]);
const Cleanup = Type.Object({
	atNs: Ticks,
	stop: Type.Union([Completion, Type.Null()]),
	empty: Type.Boolean(),
	fixtures: Type.Array(Completion),
	errors: Type.Array(Text),
});
const Result = Type.Object({
	qualification: Type.Literal(false),
	desktopQualified: Type.Literal(false),
	publicDelivery: Type.Literal(false),
	state: Type.Union([Type.Literal("shell-observed"), Type.Literal("failed")]),
	identity: Type.Union([Identity, Type.Null()]),
	original: Type.Union([Process, Type.Null()]),
	kvmGid: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
	unit: Type.String({ pattern: "^banda-shell-[a-f0-9]{24}[.]service$" }),
	started: Type.Union([Started, Type.Null()]),
	beforeRescue: BeforeRescue,
	cleanup: Cleanup,
});
type Result = Static<typeof Result>;
type Process = Static<typeof Process>;
type Completion = Static<typeof Completion>;
const effective = {
	Type: "exec",
	ExitType: "cgroup",
	RemainAfterExit: "yes",
	Restart: "no",
	KillMode: "control-group",
	TimeoutStopUSec: "5s",
	SendSIGKILL: "yes",
	Delegate: "no",
	WorkingDirectory: "/",
	RuntimeMaxUSec: "infinity",
	WatchdogUSec: "0",
	StopWhenUnneeded: "no",
	PAMName: "",
	AmbientCapabilities: "",
	DropInPaths: "",
	NRestarts: "0",
	OnFailure: "",
	OnSuccess: "",
	FailureAction: "none",
	SuccessAction: "none",
	SuccessExitStatus: "",
	RestartForceExitStatus: "",
	RestartPreventExitStatus: "",
};
const commandArrays = ["ExecStartPre", "ExecStartPost", "ExecStop", "ExecStopPost"];
const fields = [
	...Object.keys(effective),
	"Id",
	"LoadState",
	"ActiveState",
	"SubState",
	"Result",
	"ControlGroup",
	"InvocationID",
	"ExecMainPID",
	"ExecMainCode",
	"ExecMainStatus",
	"ExecMainExitTimestampMonotonic",
	"Job",
	"User",
	"Group",
	"SupplementaryGroups",
];
const cgroup = (unit: string) => `/system.slice/${unit}`;
const passed = (completion: Completion) =>
	completion.status === 0 && completion.signal === null && completion.error === null;
function checked<T extends TSchema>(schema: T, value: unknown, context = "diagnostic evidence"): Static<T> {
	if (!Value.Check(schema, value)) {
		const errors = [...Value.Errors(schema, value)].map(({ instancePath, message }) => ({ instancePath, message }));
		throw new Error(`Invalid ${context}: ${JSON.stringify(errors)}`);
	}
	return value;
}
export const linuxDesktopPageExpression = `({ width: innerWidth, height: innerHeight, origin: location.origin, heading: document.querySelector('h1')?.textContent ?? '', firstRun: document.body?.innerText.includes("Pick the model I think with") ?? false, requireType: typeof require, processType: typeof process, bridgeType: typeof window.bandaDesktop?.chooseFolder, bridgeFrozen: Object.isFrozen(window.bandaDesktop) })`;

export function parseLinuxDesktopPage(response: unknown) {
	const evaluated = checked(
		Type.Object({
			result: Type.Object({ value: Type.Optional(Type.Unknown()) }),
			exceptionDetails: Type.Optional(Type.Unknown()),
		}),
		response,
		"Runtime.evaluate response",
	);
	if (evaluated.exceptionDetails !== undefined)
		throw new Error(`Runtime.evaluate threw: ${JSON.stringify(evaluated.exceptionDetails)}`);
	return checked(Type.Omit(Page, ["screenshotSha256"]), evaluated.result.value, "Runtime.evaluate page");
}

function assertUnit(unit: Static<typeof Unit>, result: Result) {
	assert.ok(result.original);
	const original = parseDiagnosticIdentity(result.original.status);
	for (const [key, value] of Object.entries(effective)) assert.equal(unit[key], value, `Unexpected ${key}.`);
	for (const field of commandArrays) assert.equal(unit[field], "a(sasbttttuii) 0", `Missing empty ${field} receipt.`);
	assert.equal(unit.Id, result.unit);
	assert.equal(unit.User, String(original.uid));
	assert.equal(unit.Group, String(original.gid));
	assert.equal(unit.SupplementaryGroups, result.kvmGid === null ? "" : String(result.kvmGid));
	assert.match(unit.InvocationID ?? "", /^[a-f0-9]{32}$/);
}
const vmPrefix = (home: string) => `banda-microvm-${createHash("sha256").update(home).digest("hex").slice(0, 10)}-`;
function vmName(command: string) {
	const args = command.split("\0");
	return args[1] === "machine" && args.includes("--name") ? args[args.indexOf("--name") + 1] : undefined;
}
function assertInventory(started: Static<typeof Started>, unit: string) {
	const listed = started.inventoryList;
	if (listed.kind === "absent") assert.equal(started.inventory.length, 0);
	else {
		assert.ok(passed(listed.completion));
		assert.deepEqual(
			checked(Listing, JSON.parse(listed.completion.stdout)),
			started.inventory.map((vm) => vm.listed),
		);
	}
	const generations = new Set<string>();
	const names = new Set<string>();
	const pids = new Set<number>();
	for (const vm of started.inventory) {
		assert.ok(passed(vm.inspection));
		assert.deepEqual(checked(InspectedVM, JSON.parse(vm.inspection.stdout)), vm.inspected);
		assert.equal(vm.listed.name, vm.inspected.name);
		const labels = vm.inspected.config.labels;
		assert.equal(labels["banda.home"], started.home);
		const name = `${vmPrefix(started.home)}${labels["banda.generation"]}`;
		assert.ok([name, `${name}-proxy`, `${name}-browser`].includes(vm.listed.name));
		generations.add(labels["banda.generation"]);
		names.add(vm.listed.name);
		if (vm.inspected.status === "Running") assert.ok(vm.process, "Missing running VM process birth.");
		if (vm.process) {
			assert.equal(vm.process.executable, `${installed}/app/computer/msb`);
			assertDiagnosticIdentity(
				parseDiagnosticIdentity(vm.process.status),
				parseDiagnosticIdentity(started.daemon.status),
			);
			assert.equal(vmName(vm.process.command), vm.listed.name);
			assert.equal(vm.process.cgroup.trim(), `0::${cgroup(unit)}`, "VM escaped the owned app cgroup.");
			assert.ok(BigInt(vm.process.startTicks) >= BigInt(started.daemon.startTicks));
			assert.ok(![started.shell.pid, started.daemon.pid].includes(vm.process.pid));
			pids.add(vm.process.pid);
		}
	}
	assert.ok(generations.size <= 1, "Multiple VM generations in a fresh home.");
	assert.equal(names.size, started.inventory.length);
	assert.equal(pids.size, started.inventory.filter((vm) => vm.process !== null).length);
}
function assertStarted(result: Result) {
	assert.ok(result.identity && result.original && result.started, "Missing installed startup evidence.");
	const { started } = result;
	assertInventory(started, result.unit);
	assert.ok(
		started.renderers.length > 0 && started.renderers.length <= 8,
		"Missing or unexpected renderer identities.",
	);
	assertUnit(started.unit, result);
	assert.equal(started.unit.LoadState, "loaded");
	assert.equal(started.unit.ActiveState, "active");
	assert.equal(started.unit.ControlGroup, cgroup(result.unit));
	assert.equal(started.unit.ExecMainExitTimestampMonotonic, "0");
	assert.equal(started.unit.ExecMainPID, String(started.shell.pid));
	assert.equal(started.shell.executable, executable);
	assert.equal(started.daemon.executable, `${installed}/node/node`);
	for (const process of [started.shell, started.daemon]) {
		assertDiagnosticIdentity(
			parseDiagnosticIdentity(process.status),
			parseDiagnosticIdentity(result.original.status),
			result.kvmGid ?? undefined,
		);
	}
	for (const process of [started.shell, started.daemon, ...started.renderers]) {
		assert.equal(process.cgroup.trim(), `0::${cgroup(result.unit)}`);
		assert.doesNotMatch(process.command, /--no-sandbox|--disable-setuid-sandbox/);
		assert.notEqual(process.pid, result.original.pid);
		assert.doesNotMatch(process.status, /^State:\s+[ZXx]/m);
		assert.match(process.userns, /^user:\[[0-9]+\]$/);
		assert.match(process.pidns, /^pid:\[[0-9]+\]$/);
	}
	const original = parseDiagnosticIdentity(result.original.status);
	for (const renderer of started.renderers) {
		const reduced = parseDiagnosticIdentity(renderer.status);
		const allowedGroups = new Set([...original.groups, ...(result.kvmGid === null ? [] : [result.kvmGid])]);
		assert.ok(
			reduced.groups.every((gid) => allowedGroups.has(gid)),
			"Renderer added a group.",
		);
		const { bounding, ...active } = reduced.capabilities;
		assert.ok(
			Object.values(active).every((value) => /^0+$/.test(value)),
			"Renderer gained capabilities.",
		);
		assert.equal(BigInt(`0x${bounding}`) & ~BigInt(`0x${original.capabilities.bounding}`), 0n);
		for (const key of ["uid", "euid", "savedUid", "fsuid", "gid", "egid", "savedGid", "fsgid"] as const)
			assert.equal(reduced[key], original[key], `Renderer ${key} changed.`);
		assert.equal(renderer.executable, executable);
		const command = renderer.command.split("\0").filter(Boolean);
		const title = command.length === 1 ? command[0] : undefined;
		const rendererTitle = `${executable} --type=renderer`;
		assert.ok(
			command.includes("--type=renderer") || title === rendererTitle || title?.startsWith(`${rendererTitle} `),
			"Missing renderer argv or Chromium process title.",
		);
		assert.match(renderer.status, /^Seccomp:\s+2$/m);
		assert.match(renderer.status, /^NoNewPrivs:\s+1$/m);
		assert.notEqual(renderer.userns, started.shell.userns);
		assert.notEqual(renderer.pidns, started.shell.pidns);
	}
	assert.deepEqual(
		started.pages.map((page) => page.width),
		[1440, 390],
	);
	for (const page of started.pages) {
		assert.equal(page.origin, `http://127.0.0.1:${started.daemonPort}`);
		assert.equal(page.heading, "Sancho");
		assert.equal(page.firstRun, true);
		assert.equal(page.requireType, "undefined");
		assert.equal(page.processType, "undefined");
		assert.equal(page.bridgeType, "function");
		assert.equal(page.bridgeFrozen, true);
	}
	return started;
}
export function parseLinuxDesktopResult(value: unknown) {
	const result = checked(Result, value);
	if (result.state === "failed") return result;
	const started = assertStarted(result);
	const { beforeRescue, cleanup } = result;
	assert.equal(beforeRescue.kind, "observed", "Missing natural completion before rescue.");
	assert.ok(beforeRescue.kind === "observed");
	assertUnit(beforeRescue.unit, result);
	assert.equal(beforeRescue.populated, beforeRescue.cgroup === "absent" ? null : 0);
	assert.ok(
		beforeRescue.unit.ControlGroup === cgroup(result.unit) ||
			(beforeRescue.cgroup === "absent" && beforeRescue.unit.ControlGroup === ""),
	);
	assert.equal(beforeRescue.unit.SubState, "exited");
	assert.equal(beforeRescue.unit.ActiveState, "active");
	assert.equal(beforeRescue.unit.InvocationID, started.unit.InvocationID);
	assert.equal(beforeRescue.unit.ExecMainPID, String(started.shell.pid));
	assert.equal(beforeRescue.unit.ExecMainCode, "1", "Shell did not exit normally.");
	assert.equal(beforeRescue.unit.ExecMainStatus, "0", "Shell did not exit zero.");
	assert.equal(beforeRescue.unit.Result, "success");
	assert.match(beforeRescue.unit.ExecMainExitTimestampMonotonic ?? "", /^[1-9][0-9]*$/);
	assert.ok(passed(beforeRescue.input));
	assert.ok(BigInt(started.computer.atNs) < BigInt(beforeRescue.atNs));
	assert.ok(BigInt(beforeRescue.atNs) < BigInt(cleanup.atNs), "Original evidence follows rescue.");
	assert.ok(cleanup.stop && passed(cleanup.stop) && cleanup.empty);
	assert.equal(cleanup.errors.length, 0);
	assert.equal(cleanup.fixtures.length, 2);
	for (const fixture of cleanup.fixtures)
		assert.ok(
			fixture.error === null &&
				((fixture.status === 0 && fixture.signal === null) ||
					(fixture.status === null && fixture.signal === "SIGTERM")),
		);
	return result;
}

async function text(path: string) {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		assert.ok((await file.stat()).isFile());
		const bytes = Buffer.alloc(limit + 1);
		const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
		assert.ok(bytesRead <= limit, "Evidence exceeded its byte bound.");
		return bytes.subarray(0, bytesRead).toString("utf8");
	} finally {
		await file.close();
	}
}
async function save(output: string, name: string, value: unknown) {
	await writeFile(join(output, name), JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
}
function missing(error: unknown) {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function command(binary: string, args: string[], timeout = 10000, env: NodeJS.ProcessEnv = {}) {
	return new Promise<Completion>((done) =>
		execFile(
			binary,
			args,
			{
				timeout,
				maxBuffer: limit,
				killSignal: "SIGKILL",
				encoding: "utf8",
				env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", ...env },
			},
			(error, stdout, stderr) =>
				done({
					status: error ? (typeof error.code === "number" ? error.code : null) : 0,
					signal: error?.signal ?? null,
					error: error ? message(error) : null,
					stdout: stdout.slice(0, limit),
					stderr: stderr.slice(0, limit),
				}),
		),
	);
}
async function requireCommand(binary: string, args: string[], timeout = 10000, env: NodeJS.ProcessEnv = {}) {
	const result = await command(binary, args, timeout, env);
	assert.ok(passed(result), JSON.stringify(result));
	return result.stdout.trim();
}
async function snapshot(pid: number): Promise<Process> {
	assert.ok(Number.isSafeInteger(pid) && pid >= 1);
	const root = `/proc/${pid}`;
	const birth = async () => (await text(`${root}/stat`)).split(") ").at(-1)?.split(" ")[19];
	const startTicks = await birth();
	const namespace = (name: string) =>
		requireCommand("/usr/bin/sudo", ["-n", "/usr/bin/readlink", `${root}/ns/${name}`]);
	const value = {
		pid,
		startTicks,
		status: await text(`${root}/status`),
		cgroup: await text(`${root}/cgroup`),
		executable: await requireCommand("/usr/bin/sudo", ["-n", "/usr/bin/readlink", `${root}/exe`]),
		command: await text(`${root}/cmdline`),
		userns: await namespace("user"),
		pidns: await namespace("pid"),
		uidMap: await text(`${root}/uid_map`),
		gidMap: await text(`${root}/gid_map`),
	};
	assert.equal(await birth(), startTicks, "PID birth changed during observation.");
	return checked(Process, value);
}
async function absent(process: Process) {
	const stat = await text(`/proc/${process.pid}/stat`).catch((error) => {
		if (!missing(error)) throw error;
		return null;
	});
	return stat === null || stat.split(") ").at(-1)?.split(" ")[19] !== process.startTicks;
}
async function vmProcesses(home: string, unit: string) {
	const processes: Process[] = [];
	const group = await members(unit);
	for (const pid of group.members) {
		try {
			const command = await text(`/proc/${pid}/cmdline`);
			if (!vmName(command)?.startsWith(vmPrefix(home))) continue;
			processes.push(await snapshot(pid));
			assert.ok(processes.length <= 3, "Unexpected VM process count.");
		} catch (error) {
			if (!missing(error)) throw error;
		}
	}
	return processes;
}
async function computerObservation(port: number, token: string) {
	const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
		headers: { authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(10000),
	});
	assert.ok(response.ok && response.body, "Missing shell event stream.");
	let buffer = "";
	let bytes = 0;
	for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
		bytes += Buffer.byteLength(chunk);
		assert.ok(bytes <= limit, "Shell stream exceeded its byte bound.");
		buffer += chunk;
		for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
			const frame = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			if (!frame.startsWith("data: ")) continue;
			const event = checked(Type.Object({ type: Text }), JSON.parse(frame.slice(6)));
			if (event.type === "computer") return { atNs: now(), value: checked(Computer, event).computer };
		}
	}
	throw new Error("Shell stream ended before a computer observation.");
}
async function unitState(unit: string) {
	const response = await command("/usr/bin/systemctl", [
		"--system",
		"--no-pager",
		"show",
		"--all",
		`--property=${fields.join(",")}`,
		unit,
	]);
	const properties: Record<string, string> = {};
	for (const line of response.stdout.trimEnd().split("\n")) {
		const separator = line.indexOf("=");
		assert.ok(separator > 0);
		const key = line.slice(0, separator);
		assert.ok(fields.includes(key) && !(key in properties));
		properties[key] = line.slice(separator + 1);
	}
	assert.ok(passed(response) || (response.status === 4 && properties.LoadState === "not-found"));
	if (properties.LoadState === "loaded") {
		const path = `/org/freedesktop/systemd1/unit/${unit.replace(/[^A-Za-z0-9]/g, (char) => `_${char.charCodeAt(0).toString(16)}`)}`;
		for (const field of commandArrays)
			properties[field] = await requireCommand("/usr/bin/busctl", [
				"--system",
				"--timeout=5s",
				"get-property",
				"org.freedesktop.systemd1",
				path,
				"org.freedesktop.systemd1.Service",
				field,
			]);
	}
	return properties;
}
async function members(unit: string) {
	const root = `/sys/fs/cgroup${cgroup(unit)}`;
	assert.equal(await realpath(root), root);
	const pids = (await text(`${root}/cgroup.procs`)).trim().split(/\s+/).filter(Boolean).map(Number);
	assert.ok(pids.length <= 128 && pids.every((pid) => Number.isSafeInteger(pid) && pid > 0));
	const populated = [...(await text(`${root}/cgroup.events`)).matchAll(/^populated ([01])$/gm)];
	assert.equal(populated.length, 1);
	return { members: pids, populated: Number(populated[0]?.[1]) };
}
async function emptyGroup(unit: string) {
	try {
		const observed = await members(unit);
		assert.ok(observed.populated === 0 && observed.members.length === 0, "Owned cgroup is populated.");
		return { cgroup: "empty", populated: 0, members: [] } as const;
	} catch (error) {
		if (!missing(error)) throw error;
		const path = `/sys/fs/cgroup${cgroup(unit)}`;
		assert.equal(
			await lstat(path).catch((error) => {
				if (!missing(error)) throw error;
				return null;
			}),
			null,
		);
		return { cgroup: "absent", populated: null, members: [] } as const;
	}
}
async function until<T>(read: () => Promise<T | undefined>, timeout = 30000): Promise<T> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== undefined) return value;
		await delay(100);
	}
	throw new Error("Observation timed out.");
}
function fileReady<T>(directory: string, name: string, parse: (value: string) => T | undefined) {
	const watcher = watch(directory);
	let close = () => {};
	const promise = new Promise<T>((done, fail) => {
		const timer = setTimeout(() => {
			close();
			fail(new Error(`Readiness timed out: ${name}`));
		}, 120000);
		close = () => {
			clearTimeout(timer);
			watcher.close();
		};
		let reading = false;
		let again = false;
		const changed = async () => {
			if (reading) {
				again = true;
				return;
			}
			reading = true;
			try {
				do {
					again = false;
					const value = await text(join(directory, name)).catch((error) => {
						if (!missing(error)) throw error;
						return undefined;
					});
					const parsed = value === undefined ? undefined : parse(value);
					if (parsed !== undefined) {
						close();
						done(parsed);
						return;
					}
				} while (again);
			} catch (error) {
				close();
				fail(error);
			} finally {
				reading = false;
			}
		};
		watcher.on("change", (_event, filename) => {
			if (filename === name) void changed();
		});
		watcher.on("error", (error) => {
			close();
			fail(error);
		});
		void changed();
	});
	void promise.catch(() => {});
	return { promise, close: () => close() };
}
function fixture(binary: string, args: string[], env: NodeJS.ProcessEnv, addressFd: number) {
	const child = spawn(binary, args, { env, stdio: ["ignore", "pipe", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (bytes: Buffer) => {
		stdout = (stdout + bytes).slice(-limit);
	});
	child.stderr?.on("data", (bytes: Buffer) => {
		stderr = (stderr + bytes).slice(-limit);
	});
	let ended = false;
	const completion = new Promise<Completion>((done) => {
		child.once("error", (error) => {
			ended = true;
			done({ status: null, signal: null, error: message(error), stdout, stderr });
		});
		child.once("exit", (status, signal) => {
			ended = true;
			done({ status, signal, error: null, stdout, stderr });
		});
	});
	const address = new Promise<string>((done, fail) => {
		let value = "";
		const timer = setTimeout(() => fail(new Error("Fixture readiness timed out.")), 10000);
		void completion.then(() => {
			clearTimeout(timer);
			fail(new Error("Fixture exited before readiness."));
		});
		const stream = child.stdio[addressFd];
		assert.ok(stream && "on" in stream);
		stream.on("data", (bytes: Buffer) => {
			value += bytes.toString("utf8");
			if (value.length > 4096) {
				clearTimeout(timer);
				fail(new Error("Fixture address exceeded its bound."));
			}
			if (value.includes("\n")) {
				clearTimeout(timer);
				done(value.split("\n")[0] ?? "");
			}
		});
	});
	void address.catch(() => {});
	return {
		child,
		address,
		stop: async () => {
			if (!ended) child.kill("SIGTERM");
			const timer = setTimeout(() => {
				if (!ended) child.kill("SIGKILL");
			}, 5000);
			try {
				return await completion;
			} finally {
				clearTimeout(timer);
			}
		},
	};
}
async function socket(url: string, output: string) {
	assert.match(url, /^ws:\/\/127[.]0[.]0[.]1:[1-9][0-9]*\/devtools\/browser\/[a-f0-9-]+$/);
	const ws = new WebSocket(url);
	await new Promise<void>((done, fail) => {
		const timer = setTimeout(() => {
			ws.close();
			fail(new Error("CDP connection timed out."));
		}, 10000);
		ws.addEventListener(
			"open",
			() => {
				clearTimeout(timer);
				done();
			},
			{ once: true },
		);
		ws.addEventListener(
			"error",
			() => {
				clearTimeout(timer);
				fail(new Error("CDP connection failed."));
			},
			{ once: true },
		);
	});
	let next = 0;
	return {
		close: () => ws.close(),
		send: (method: string, params: object = {}, sessionId?: string) =>
			new Promise<unknown>((done, fail) => {
				const id = ++next;
				const finish = () => {
					clearTimeout(timer);
					ws.removeEventListener("message", receive);
					ws.removeEventListener("close", closed);
				};
				const closed = () => {
					finish();
					fail(new Error("CDP closed."));
				};
				const timer = setTimeout(() => {
					finish();
					fail(new Error(`CDP timed out: ${method}`));
				}, 10000);
				const receive = async (event: MessageEvent) => {
					try {
						assert.ok(typeof event.data === "string" && event.data.length < 16 << 20);
						const response = checked(
							Type.Object({
								id: Type.Optional(Type.Integer()),
								result: Type.Optional(Type.Unknown()),
								error: Type.Optional(Type.Unknown()),
							}),
							JSON.parse(event.data),
							`CDP ${method} envelope`,
						);
						if (response.id !== id) return;
						finish();
						await save(output, `cdp-${id}.json`, { atNs: now(), method, sessionId: sessionId ?? null, response });
						if (response.error) fail(new Error(JSON.stringify(response.error)));
						else done(response.result);
					} catch (error) {
						finish();
						fail(error);
					}
				};
				ws.addEventListener("message", receive);
				ws.addEventListener("close", closed);
				ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
			}),
	};
}

async function install(deb: string, output: string): Promise<Static<typeof Identity>> {
	const sourceCommit = await requireCommand("/usr/bin/git", ["rev-parse", "HEAD"]);
	assert.equal(sourceCommit, process.env.GITHUB_SHA);
	assert.equal(await requireCommand("/usr/bin/git", ["status", "--porcelain", "--untracked-files=no"]), "");
	const committed = await command("/usr/bin/git", ["show", "HEAD:scripts/diagnose-linux-desktop.ts"]);
	assert.ok(passed(committed), "The diagnostic is not part of the producer commit.");
	const verifierSha256 = await hash(fileURLToPath(import.meta.url));
	assert.equal(verifierSha256, createHash("sha256").update(committed.stdout).digest("hex"));
	const root = checked(Type.Object({ version: Text }), JSON.parse(await text(resolve("package.json"))));
	const desktop = checked(Type.Object({ version: Text }), JSON.parse(await text(resolve("desktop/package.json"))));
	assert.equal(root.version, desktop.version);
	const debSha256 = await hash(deb);
	const control = await requireCommand("/usr/bin/dpkg-deb", ["--field", deb]);
	await save(output, "package-control.json", { sourceCommit, debSha256, control });
	assert.match(control, /^Package: banda-desktop$/m);
	assert.match(control, /^Architecture: amd64$/m);
	assert.ok(control.includes(`Version: ${root.version.replace("-", "~")}\n`));
	for (const path of ["/", "/opt"]) {
		const stat = await lstat(path);
		assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && stat.gid === 0);
		assert.equal(await realpath(path), path);
		if (path === "/") assert.equal(stat.mode & 0o022, 0);
	}
	assert.equal(
		await lstat("/opt/banda").catch((error) => {
			if (!missing(error)) throw error;
			return null;
		}),
		null,
	);
	const before = await lstat("/opt");
	assert.ok([0o755, 0o777].includes(before.mode & 0o7777), "Unexpected disposable runner /opt mode.");
	await save(output, "opt-before.json", { uid: before.uid, gid: before.gid, mode: before.mode });
	if ((before.mode & 0o7777) === 0o777) await requireCommand("/usr/bin/sudo", ["-n", "/usr/bin/chmod", "0755", "/opt"]);
	const after = await lstat("/opt");
	assert.ok(
		after.isDirectory() &&
			after.ino === before.ino &&
			after.dev === before.dev &&
			after.uid === 0 &&
			after.gid === 0 &&
			(after.mode & 0o7777) === 0o755,
	);
	await save(output, "opt-after.json", { uid: after.uid, gid: after.gid, mode: after.mode });
	const policy = async () => {
		const values: Record<string, string | null> = {};
		for (const name of [
			"kernel/apparmor_restrict_unprivileged_userns",
			"kernel/apparmor_restrict_unprivileged_unconfined",
			"kernel/unprivileged_userns_clone",
			"user/max_user_namespaces",
		])
			values[name] = await text(`/proc/sys/${name}`).catch((error) => {
				if (!missing(error)) throw error;
				return null;
			});
		return values;
	};
	const policyBefore = await policy();
	await save(output, "policy-before.json", policyBefore);
	for (const [name, args] of [
		["fixture-apt-update", ["update"]],
		["fixture-apt-install", ["install", "--yes", "--no-install-recommends", "xvfb", "xauth", "xdotool", "dbus", "acl"]],
	] as const) {
		const completion = await command("/usr/bin/sudo", ["-n", "/usr/bin/apt-get", ...args], 240000);
		await save(output, `${name}.json`, completion);
		assert.ok(passed(completion), "CI display fixture installation failed.");
	}
	const apt = await command(
		"/usr/bin/sudo",
		["-n", "/usr/bin/apt-get", "install", "--yes", "--no-install-recommends", deb],
		240000,
	);
	await save(output, "apt-install.json", apt);
	const policyAfter = await policy();
	await save(output, "policy-after.json", policyAfter);
	assert.deepEqual(policyAfter, policyBefore, "Installer changed global namespace policy.");
	assert.ok(passed(apt), "APT installation failed.");
	assert.equal(await hash(deb), debSha256);
	const packageFormat = ["$", "{Status}\n", "$", "{Version}\n"].join("");
	assert.equal(
		await requireCommand("/usr/bin/dpkg-query", ["-W", `-f=${packageFormat}`, "banda-desktop"]),
		`install ok installed\n${root.version.replace("-", "~")}`,
	);
	assert.equal(await requireCommand("/usr/bin/dpkg", ["--verify", "banda-desktop"]), "");
	const metadata = [];
	const files = [
		executable,
		"/opt/banda/chrome-sandbox",
		"/opt/banda/resources/app.asar",
		`${installed}/node/node`,
		`${installed}/app/computer/msb`,
	];
	for (const path of [
		"/opt",
		"/opt/banda",
		"/opt/banda/resources",
		installed,
		`${installed}/node`,
		`${installed}/app`,
		`${installed}/app/computer`,
		...files,
	]) {
		const stat = await lstat(path);
		assert.ok(!stat.isSymbolicLink() && stat.uid === 0 && stat.gid === 0 && !(stat.mode & 0o022));
		assert.ok(files.includes(path) ? stat.isFile() : stat.isDirectory());
		assert.ok(
			path === "/opt/banda/chrome-sandbox" ? [0o755, 0o4755].includes(stat.mode & 0o7777) : !(stat.mode & 0o6000),
		);
		assert.equal(await realpath(path), path);
		metadata.push({ path, uid: stat.uid, gid: stat.gid, mode: stat.mode });
	}
	await save(output, "installed-metadata.json", {
		metadata,
		appArmor: await text("/etc/apparmor.d/banda-desktop").catch((error) => {
			if (!missing(error)) throw error;
			return null;
		}),
	});
	const asarSha256 = await hash("/opt/banda/resources/app.asar");
	const executableSha256 = await hash(executable);
	assert.equal(asarSha256, await hash(resolve("release/desktop/linux-unpacked/resources/app.asar")));
	assert.equal(executableSha256, await hash(resolve("release/desktop/linux-unpacked/banda-desktop")));
	const manifestPath = `${installed}/app/computer/manifest.json`;
	assert.ok((await lstat(manifestPath)).size < limit);
	await readMicrovmAssets(`${installed}/app/computer`, "linux-x64");
	const runtimeManifestSha256 = await hash(manifestPath);
	assert.equal(runtimeManifestSha256, await hash(resolve("release/banda/app/computer/manifest.json")));
	return {
		sourceCommit,
		verifierSha256,
		version: root.version,
		debSha256,
		asarSha256,
		executableSha256,
		runtimeManifestSha256,
	};
}

async function main() {
	assert.ok(
		process.platform === "linux" &&
			process.arch === "x64" &&
			process.env.CI === "true" &&
			process.env.GITHUB_ACTIONS === "true" &&
			process.env.RUNNER_ENVIRONMENT === "github-hosted",
		"Only a disposable GitHub-hosted Linux x64 runner may run this diagnostic.",
	);
	assert.ok(process.getuid?.() && process.geteuid?.(), "Refusing root execution.");
	assert.equal(process.argv.length, 4, "Usage: node scripts/diagnose-linux-desktop.ts <actual-deb> <fresh-output>");
	const [deb = "", output = ""] = process.argv.slice(2);
	for (const path of [deb, output]) {
		assert.match(path, /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/);
		assert.equal(resolve(path), path);
		assert.equal(await realpath(dirname(path)), dirname(path));
	}
	assert.equal(await realpath(deb), deb);
	await mkdir(output, { mode: 0o700 });
	const outputStat = await lstat(output);
	assert.ok(outputStat.uid === process.getuid?.() && (outputStat.mode & 0o7777) === 0o700);
	const unit = `banda-shell-${randomBytes(12).toString("hex")}.service`;
	const result: Result = {
		qualification: false,
		desktopQualified: false,
		publicDelivery: false,
		state: "failed",
		identity: null,
		original: null,
		kvmGid: null,
		unit,
		started: null,
		beforeRescue: { kind: "failed", error: "Observation not completed.", lastUnit: null },
		cleanup: { atNs: now(), stop: null, empty: false, fixtures: [], errors: [] },
	};
	const fixtures: ReturnType<typeof fixture>[] = [];
	const watchers: { close: () => void }[] = [];
	let cdp: Awaited<ReturnType<typeof socket>> | undefined;
	let owned = false;
	let lastUnit: Static<typeof Unit> | null = null;
	let phase = "prepare";
	try {
		result.original = await snapshot(process.pid);
		const identity = parseDiagnosticIdentity(result.original.status);
		assertDiagnosticIdentity(identity, identity);
		assert.equal((await text("/proc/1/comm")).trim(), "systemd");
		result.identity = await install(deb, output);
		const kvm = await kvmDiagnostics();
		const kvmGid = assertKvmGroup(kvm, await requireCommand("/usr/bin/getent", ["group", "kvm"]));
		result.kvmGid = identity.groups.includes(kvmGid) ? null : kvmGid;
		await save(output, "kvm-before.json", kvm);
		const account = parseLinuxRunnerAccount(
			await requireCommand("/usr/bin/getent", ["passwd", String(identity.uid)]),
			identity,
		);
		assert.equal((await unitState(unit)).LoadState, "not-found");
		owned = true;
		await save(output, "owner.json", { unit, sourceCommit: result.identity.sourceCommit });
		const home = join(output, "home");
		const runtime = join(output, "runtime");
		const banda = join(home, ".banda");
		const cache = `/tmp/banda-msb-${identity.uid}-${createHash("sha256").update(banda).digest("hex").slice(0, 16)}`;
		assert.equal(
			await lstat(cache).catch((error) => {
				if (!missing(error)) throw error;
				return null;
			}),
			null,
		);
		for (const path of [home, runtime, banda, join(banda, "desktop")]) await mkdir(path, { mode: 0o700 });
		const env = {
			PATH: "/usr/bin:/bin",
			LANG: "C.UTF-8",
			HOME: home,
			USER: account.name,
			LOGNAME: account.name,
			XDG_RUNTIME_DIR: runtime,
			XAUTHORITY: join(runtime, "Xauthority"),
		};
		const cookie = randomBytes(16).toString("hex");
		await writeFile(env.XAUTHORITY, "", { mode: 0o600, flag: "wx" });
		await requireCommand(
			"/usr/bin/xauth",
			["-f", env.XAUTHORITY, "add", ":0", "MIT-MAGIC-COOKIE-1", cookie],
			10000,
			env,
		);
		const x = fixture(
			"/usr/bin/Xvfb",
			["-displayfd", "3", "-screen", "0", "1600x1200x24", "-nolisten", "tcp", "-auth", env.XAUTHORITY],
			env,
			3,
		);
		fixtures.push(x);
		const display = await x.address;
		assert.match(display, /^\d+$/);
		await requireCommand(
			"/usr/bin/xauth",
			["-f", env.XAUTHORITY, "add", `:${display}`, "MIT-MAGIC-COOKIE-1", cookie],
			10000,
			env,
		);
		const busConfig = `<busconfig><type>session</type><listen>unix:path=${runtime}/bus</listen><auth>EXTERNAL</auth><policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>`;
		await writeFile(join(runtime, "dbus.conf"), busConfig, { mode: 0o600, flag: "wx" });
		const bus = fixture(
			"/usr/bin/dbus-daemon",
			[`--config-file=${runtime}/dbus.conf`, "--nofork", "--nopidfile", "--print-address=1"],
			env,
			1,
		);
		fixtures.push(bus);
		const busAddress = await bus.address;
		assert.equal(busAddress.split(",")[0], `unix:path=${runtime}/bus`);
		await save(output, "display-fixtures.json", {
			display,
			busAddress,
			busConfig,
			xAuthorityMode: (await lstat(env.XAUTHORITY)).mode,
		});
		for (const child of fixtures) {
			assert.ok(child.child.pid);
			const observed = await snapshot(child.child.pid);
			assertDiagnosticIdentity(parseDiagnosticIdentity(observed.status), identity);
			assert.notEqual(observed.cgroup.trim(), `0::${cgroup(unit)}`);
			await save(output, `fixture-${child.child.pid}.json`, observed);
		}
		const launchEnv = {
			...env,
			DISPLAY: `:${display}`,
			DBUS_SESSION_BUS_ADDRESS: busAddress,
			BANDA_HOME: banda,
			BANDA_PORT: "0",
		};
		const published = fileReady(banda, "daemon.json", (value) => {
			const receipt = checked(
				Type.Object({
					pid: Type.Integer({ minimum: 2 }),
					port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
					token: Type.Optional(Text),
				}),
				JSON.parse(value),
			);
			return receipt.port && receipt.token ? { pid: receipt.pid, port: receipt.port, token: receipt.token } : undefined;
		});
		const debugging = fileReady(join(banda, "desktop"), "DevToolsActivePort", (value) => {
			const match = /^([1-9][0-9]*)\n(\/devtools\/browser\/[a-f0-9-]{36})\n?$/.exec(value);
			if (!match) return undefined;
			assert.ok(Number(match[1]) <= 65535);
			return `ws://127.0.0.1:${match[1]}${match[2]}`;
		});
		watchers.push(published, debugging);
		const args = [
			"-n",
			"/usr/bin/systemd-run",
			"--system",
			"--no-ask-password",
			`--unit=${unit}`,
			"--property=Type=exec",
			"--property=ExitType=cgroup",
			"--property=RemainAfterExit=yes",
			"--property=Restart=no",
			"--property=KillMode=control-group",
			"--property=TimeoutStopSec=5s",
			"--property=SendSIGKILL=yes",
			"--property=Delegate=no",
			"--property=WorkingDirectory=/",
			...(result.kvmGid === null ? [] : [`--property=SupplementaryGroups=${result.kvmGid}`]),
			`--uid=${identity.uid}`,
			`--gid=${identity.gid}`,
			"/usr/bin/env",
			"-i",
			...Object.entries(launchEnv).map(([key, value]) => `${key}=${value}`),
			executable,
			"--remote-debugging-address=127.0.0.1",
			"--remote-debugging-port=0",
		];
		assert.ok(
			args.every((argument) => !/[$%]/.test(argument)),
			"Systemd expansion character in launch arguments.",
		);
		phase = "launch";
		const startup = await command("/usr/bin/sudo", args);
		await save(output, "startup.json", startup);
		assert.ok(passed(startup));
		lastUnit = await unitState(unit);
		phase = "daemon-ready";
		const daemon = await published.promise;
		const endpoint = await debugging.promise;
		const port = new URL(endpoint).port;
		const listener = await requireCommand("/usr/bin/ss", ["-H", "-ltn", `sport = :${port}`]);
		assert.equal(listener.split("\n").length, 1);
		assert.equal(listener.split(/\s+/)[3], `127.0.0.1:${port}`, "CDP is not loopback-only.");
		await save(output, "debug-listener.json", { endpoint, listener });
		phase = "cdp-connect";
		cdp = await socket(endpoint, output);
		const active = cdp;
		phase = "daemon-status";
		await until(async () => {
			const response = await fetch(`http://127.0.0.1:${daemon.port}/api/status`, {
				headers: { authorization: `Bearer ${daemon.token}` },
				signal: AbortSignal.timeout(2000),
			}).catch(() => undefined);
			return response?.ok ? true : undefined;
		});
		phase = "Target.getTargets";
		const target = await until(async () => {
			const response = checked(
				Type.Object({ targetInfos: Type.Array(Type.Object({ type: Text, targetId: Text, url: Text })) }),
				await active.send("Target.getTargets"),
			);
			return response.targetInfos.find(
				(target) => target.type === "page" && target.url.startsWith(`http://127.0.0.1:${daemon.port}/`),
			);
		});
		phase = "Target.attachToTarget";
		const { sessionId } = checked(
			Type.Object({ sessionId: Text }),
			await active.send("Target.attachToTarget", { targetId: target.targetId, flatten: true }),
		);
		const pages: Static<typeof Page>[] = [];
		for (const width of [1440, 390]) {
			phase = `Emulation.setDeviceMetricsOverride ${width}`;
			await active.send(
				"Emulation.setDeviceMetricsOverride",
				{ width, height: 900, deviceScaleFactor: 1, mobile: false },
				sessionId,
			);
			phase = `Runtime.evaluate ${width}`;
			const page = await until(async () => {
				const value = parseLinuxDesktopPage(
					await active.send(
						"Runtime.evaluate",
						{ expression: linuxDesktopPageExpression, returnByValue: true },
						sessionId,
					),
				);
				return value.heading === "Sancho" && value.firstRun && value.width === width ? value : undefined;
			});
			phase = `Page.captureScreenshot ${width}`;
			const shot = checked(
				Type.Object({ data: Type.String({ maxLength: 12 << 20 }) }),
				await active.send("Page.captureScreenshot", { format: "png" }, sessionId),
			);
			const file = join(output, `first-run-${width}.png`);
			await writeFile(file, Buffer.from(shot.data, "base64"), { mode: 0o600, flag: "wx" });
			pages.push({ ...page, screenshotSha256: await hash(file) });
		}
		phase = "shell-evidence";
		const state = await unitState(unit);
		lastUnit = state;
		const shell = await snapshot(Number(state.ExecMainPID));
		const processes = checked(
			Type.Object({ processInfo: Type.Array(Type.Object({ type: Text, id: Type.Integer() })) }),
			await active.send("SystemInfo.getProcessInfo"),
		);
		const group = await members(unit);
		const renderers = await Promise.all(
			processes.processInfo
				.filter((item) => item.type === "renderer" && group.members.includes(item.id))
				.map((item) => snapshot(item.id)),
		);
		const inventory = async (phase: "before-quit" | "after-quit") => {
			const exists = await lstat(cache).catch((error) => {
				if (!missing(error)) throw error;
				return null;
			});
			if (!exists) return { kind: "absent" as const };
			assert.ok(exists.isDirectory() && exists.uid === identity.uid && !(exists.mode & 0o077));
			const completion = await command(`${installed}/app/computer/msb`, ["list", "--format", "json"], 10000, {
				...env,
				MSB_HOME: cache,
			});
			await save(output, `${phase}-list.json`, completion);
			assert.ok(passed(completion));
			checked(Listing, JSON.parse(completion.stdout));
			return { kind: "listed" as const, completion };
		};
		const computer = await computerObservation(daemon.port, daemon.token);
		await save(output, "computer.json", computer);
		const inventoryList = await inventory("before-quit");
		const vms: Static<typeof Inventory> = [];
		if (inventoryList.kind === "listed") {
			for (const listed of checked(Listing, JSON.parse(inventoryList.completion.stdout))) {
				const inspection = await command(
					`${installed}/app/computer/msb`,
					["inspect", listed.name, "--format", "json"],
					10000,
					{ ...env, MSB_HOME: cache },
				);
				await save(output, `before-quit-inspect-${vms.length}.json`, inspection);
				assert.ok(passed(inspection));
				vms.push({ listed, inspected: checked(InspectedVM, JSON.parse(inspection.stdout)), inspection, process: null });
			}
		}
		const vmBirths = await vmProcesses(banda, unit);
		await save(output, "before-quit-vm-processes.json", vmBirths);
		for (const process of vmBirths) {
			const vm = vms.find((item) => item.listed.name === vmName(process.command));
			assert.ok(vm && vm.process === null, "Unlisted or duplicate VM process.");
			vm.process = process;
		}
		result.started = {
			shell,
			daemon: await snapshot(daemon.pid),
			renderers,
			unit: state,
			pages,
			daemonPort: daemon.port,
			home: banda,
			computer,
			inventoryList,
			inventory: vms,
		};
		await save(output, "started.json", result.started);
		assertStarted(result);
		phase = "native-quit";
		const window = await requireCommand(
			"/usr/bin/xdotool",
			["search", "--onlyvisible", "--pid", String(shell.pid), "--name", "banda"],
			10000,
			launchEnv,
		);
		assert.match(window, /^[1-9][0-9]*$/);
		await requireCommand("/usr/bin/xdotool", ["windowfocus", "--sync", window], 10000, launchEnv);
		assert.equal(await requireCommand("/usr/bin/xdotool", ["getwindowfocus"], 10000, launchEnv), window);
		const input = await command("/usr/bin/xdotool", ["key", "--clearmodifiers", "ctrl+q"], 10000, launchEnv);
		await save(output, "quit-input.json", input);
		assert.ok(passed(input));
		const finished = await until(async () => {
			lastUnit = await unitState(result.unit);
			return lastUnit.ExecMainExitTimestampMonotonic !== "0" && lastUnit.SubState === "exited" ? lastUnit : undefined;
		});
		const empty = await emptyGroup(unit);
		assert.ok(await absent(shell), "Original shell birth remains after Quit.");
		assert.ok(await absent(result.started.daemon), "Original daemon birth remains after Quit.");
		assert.equal(
			await requireCommand("/usr/bin/ss", ["-H", "-ltn", `sport = :${daemon.port}`]),
			"",
			"Daemon listener remains after Quit.",
		);
		for (const process of vmBirths) assert.ok(await absent(process), "Original VM birth remains after Quit.");
		const finalList = await inventory("after-quit");
		if (finalList.kind === "listed") assert.equal(checked(Listing, JSON.parse(finalList.completion.stdout)).length, 0);
		result.beforeRescue = {
			kind: "observed",
			atNs: now(),
			unit: finished,
			cgroup: empty.cgroup,
			populated: empty.populated,
			members: [],
			inventory: [],
			mainAbsent: true,
			daemonAbsent: true,
			vmBirthsAbsent: true,
			listenerClosed: true,
			action: "native-ctrl-q",
			input,
		};
	} catch (error) {
		result.beforeRescue = { kind: "failed", error: `${phase}: ${message(error)}`, lastUnit };
		await save(output, "failure.json", {
			atNs: now(),
			phase,
			error: error instanceof Error ? error.stack : String(error),
		});
	} finally {
		result.cleanup.atNs = now();
		if (owned) {
			result.cleanup.stop = await command(
				"/usr/bin/sudo",
				["-n", "/usr/bin/systemctl", "--system", "--no-ask-password", "stop", unit],
				20000,
			);
			try {
				const state = await unitState(unit);
				assert.ok(["inactive", "failed"].includes(state.ActiveState ?? "") && state.Job === "");
				await emptyGroup(unit);
				result.cleanup.empty = true;
			} catch (error) {
				result.cleanup.errors.push(message(error));
			}
		}
		for (const watcher of watchers) watcher.close();
		try {
			cdp?.close();
		} catch (error) {
			result.cleanup.errors.push(message(error));
		}
		for (const child of fixtures.reverse()) {
			try {
				result.cleanup.fixtures.push(await child.stop());
			} catch (error) {
				result.cleanup.errors.push(message(error));
			}
		}
		if (owned) {
			try {
				await save(
					output,
					"unit-journal.json",
					await command("/usr/bin/journalctl", [
						"--unit",
						unit,
						"--no-pager",
						"--lines=150",
						"--output=short-monotonic",
					]),
				);
			} catch (error) {
				result.cleanup.errors.push(message(error));
			}
		}
	}
	if (result.beforeRescue.kind === "observed") {
		result.state = "shell-observed";
		try {
			parseLinuxDesktopResult(result);
		} catch (error) {
			result.state = "failed";
			result.cleanup.errors.push(message(error));
		}
	}
	await save(output, "result.json", checked(Result, result));
	process.exitCode = result.state === "shell-observed" ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
	await main().catch((error) => {
		console.error(message(error));
		process.exitCode = 1;
	});
