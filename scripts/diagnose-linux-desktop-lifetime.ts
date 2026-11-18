import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, watch } from "node:fs";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { assertDiagnosticIdentity, parseDiagnosticIdentity } from "./native-diagnostics.ts";
import { parseLinuxRunnerAccount } from "./verify-linux-computer.ts";

const cases = [
	{ name: "exit-0", exit: 0, inject: false },
	{ name: "exit-23", exit: 23, inject: false },
	{ name: "observation-failure", exit: 0, inject: true },
] as const;
const injectedError = "Injected observer failure after readiness and before release.";
const limit = 64 << 10;
const now = () => process.hrtime.bigint().toString();
const errorText = (error: unknown) => String(error).slice(0, 4000);
const Text = Type.String({ maxLength: limit });
const Ticks = Type.String({ pattern: "^[1-9][0-9]*$" });
const Birth = Type.Object({ pid: Type.Integer({ minimum: 2 }), startTicks: Ticks });
const Process = Type.Object({
	...Birth.properties,
	state: Type.String({ minLength: 1, maxLength: 1 }),
	group: Type.Integer({ minimum: 1 }),
	session: Type.Integer({ minimum: 1 }),
	status: Text,
	cgroup: Text,
});
const Environment = Type.Object({
	ownerHomeAbsent: Type.Literal(true),
	githubTokenAbsent: Type.Literal(true),
	sshAgentAbsent: Type.Literal(true),
	desktopSessionAbsent: Type.Literal(true),
	pythonPathAbsent: Type.Literal(true),
});
const Receipt = Type.Object({ main: Process, descendant: Process, environment: Environment });
const Completion = Type.Object({
	status: Type.Union([Type.Integer(), Type.Null()]),
	signal: Type.Union([Text, Type.Null()]),
	error: Type.Union([Text, Type.Null()]),
	stdout: Text,
	stderr: Text,
});
const Unit = Type.Object({
	atNs: Ticks,
	properties: Type.Record(Type.String(), Text),
	commandArrays: Type.Record(Type.String(), Completion),
});
const Ready = Type.Object({ ...Receipt.properties, unit: Unit, observedAtNs: Ticks });
const BeforeRescue = Type.Union([
	Type.Object({
		kind: Type.Literal("observed"),
		atNs: Ticks,
		unit: Unit,
		descendant: Process,
		mainAbsent: Type.Literal(true),
		populated: Type.Literal(1),
		members: Type.Array(Birth, { maxItems: 64 }),
	}),
	Type.Object({
		kind: Type.Literal("failed"),
		error: Text,
		injected: Type.Boolean(),
		lastUnit: Type.Union([Unit, Type.Null()]),
	}),
]);
const Empty = Type.Object({
	atNs: Ticks,
	unit: Unit,
	cgroup: Type.Union([Type.Literal("empty"), Type.Literal("absent")]),
	populated: Type.Union([Type.Literal(0), Type.Null()]),
	members: Type.Array(Birth, { maxItems: 0 }),
});
const Cleanup = Type.Object({
	rescueAtNs: Ticks,
	stop: Completion,
	kill: Type.Union([Completion, Type.Null()]),
	empty: Type.Union([Empty, Type.Null()]),
	afterRescueMain: Type.Union([Unit, Type.Null()]),
	errors: Type.Array(Text),
});
const Case = Type.Object({
	name: Type.Union([Type.Literal(cases[0].name), Type.Literal(cases[1].name), Type.Literal(cases[2].name)]),
	unit: Type.String({ pattern: "^banda-lifetime-[a-f0-9]{24}-(exit-0|exit-23|observation-failure)[.]service$" }),
	startup: Type.Union([Completion, Type.Null()]),
	ready: Type.Union([Ready, Type.Null()]),
	beforeRescue: BeforeRescue,
	cleanup: Cleanup,
});
const MetadataEntry = Type.Object({
	path: Text,
	canonical: Text,
	uid: Type.Integer(),
	gid: Type.Integer(),
	mode: Type.Integer(),
});
const Result = Type.Object({
	qualification: Type.Literal(false),
	desktopQualified: Type.Literal(false),
	publicDelivery: Type.Literal(false),
	state: Type.Union([Type.Literal("inert-passed"), Type.Literal("failed"), Type.Literal("unsupported")]),
	sourceCommit: Type.Union([Type.String({ pattern: "^[a-f0-9]{40}$" }), Type.Null()]),
	initial: Type.Union([
		Type.Object({ observer: Process, account: Type.Object({ name: Text, home: Text }) }),
		Type.Null(),
	]),
	metadata: Type.Union([
		Type.Object({ systemdVersion: Text, cgroupMount: Text, paths: Type.Array(MetadataEntry) }),
		Type.Null(),
	]),
	cases: Type.Array(Case, { maxItems: 3 }),
	errors: Type.Array(Text),
});
type Result = Static<typeof Result>;
type Process = Static<typeof Process>;
type Unit = Static<typeof Unit>;
type Case = Static<typeof Case>;
type Baseline = NonNullable<Result["initial"]>;
const commandFields = ["ExecStartPre", "ExecStartPost", "ExecStop", "ExecStopPost"] as const;
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
	SuccessExitStatus: "",
	RestartForceExitStatus: "",
	RestartPreventExitStatus: "",
	PAMName: "",
	SupplementaryGroups: "",
	AmbientCapabilities: "",
	...Object.fromEntries(commandFields.map((field) => [field, ""])),
	OnFailure: "",
	OnSuccess: "",
	FailureAction: "none",
	SuccessAction: "none",
	NRestarts: "0",
	DropInPaths: "",
} as const;
const unitFields = [
	...Object.keys(effective),
	"User",
	"Group",
	"Id",
	"LoadState",
	"ActiveState",
	"SubState",
	"Result",
	"InvocationID",
	"ControlGroup",
	"ExecMainPID",
	"ExecMainCode",
	"ExecMainStatus",
	"ExecMainExitTimestampMonotonic",
	"Job",
];
const cgroupOf = (unit: string) => `/system.slice/${unit}`;
const sameBirth = (a: Static<typeof Birth>, b: Static<typeof Birth>) =>
	a.pid === b.pid && a.startTicks === b.startTicks;

function assertProcess(value: Process, baseline: Baseline, unit: string) {
	assertDiagnosticIdentity(parseDiagnosticIdentity(value.status), parseDiagnosticIdentity(baseline.observer.status));
	assert.equal(value.cgroup.trim(), `0::${cgroupOf(unit)}`);
	assert.ok(!["Z", "X", "x"].includes(value.state), "Expected a live process.");
}
function assertUnit(unit: Unit, name: string, baseline: Baseline, invocation?: string) {
	assertCommandArrays(unit);
	const properties = unit.properties;
	for (const [key, value] of Object.entries(effective)) assert.equal(properties[key], value, `Unexpected ${key}.`);
	const identity = parseDiagnosticIdentity(baseline.observer.status);
	assert.equal(properties.User, String(identity.uid));
	assert.equal(properties.Group, String(identity.gid));
	assert.equal(properties.Id, name);
	assert.equal(properties.LoadState, "loaded");
	assert.equal(properties.ControlGroup, cgroupOf(name));
	assert.equal(properties.ActiveState, "active");
	assert.ok(properties.SubState && properties.Result, "Missing service state.");
	assert.match(properties.InvocationID ?? "", /^[a-f0-9]{32}$/);
	if (invocation) assert.equal(properties.InvocationID, invocation, "Service invocation changed.");
}
function assertReady(ready: Static<typeof Ready>, baseline: Baseline, name: string) {
	assertUnit(ready.unit, name, baseline);
	for (const process of [ready.main, ready.descendant]) assertProcess(process, baseline, name);
	assert.notEqual(ready.main.pid, ready.descendant.pid);
	assert.equal(ready.descendant.session, ready.descendant.pid, "Descendant did not detach its session.");
	assert.equal(ready.descendant.group, ready.descendant.pid);
	assert.notEqual(ready.main.session, ready.descendant.session);
	assert.equal(ready.unit.properties.ExecMainPID, String(ready.main.pid));
	assert.equal(ready.unit.properties.ExecMainExitTimestampMonotonic, "0");
	assert.equal(ready.unit.properties.ExecMainCode, "0");
	assert.equal(ready.unit.properties.ExecMainStatus, "0");
	assert.ok(BigInt(ready.unit.atNs) <= BigInt(ready.observedAtNs));
	assert.notEqual(baseline.observer.cgroup.trim(), ready.main.cgroup.trim(), "Observer entered the service.");
}

export function parseLinuxLifetimeResult(value: unknown) {
	if (!Value.Check(Result, value)) throw new Error("Malformed Linux lifetime result.");
	if (value.initial) {
		const identity = parseDiagnosticIdentity(value.initial.observer.status);
		assertDiagnosticIdentity(identity, identity);
		assert.ok(BigInt(`0x${identity.capabilities.bounding}`) > 0n, "Original bounding capabilities must be retained.");
	}
	for (const [index, item] of value.cases.entries()) {
		const selected = cases[index];
		assert.equal(item.name, selected?.name, "Lifetime cases are out of order.");
		assert.ok(item.unit.endsWith(`-${item.name}.service`));
		for (const unit of [
			item.ready?.unit,
			item.beforeRescue.kind === "observed" ? item.beforeRescue.unit : item.beforeRescue.lastUnit,
			item.cleanup.empty?.unit,
			item.cleanup.afterRescueMain,
		]) {
			if (unit?.properties.LoadState === "loaded") assertCommandArrays(unit);
		}
		if (item.ready) {
			assert.ok(value.initial, "Missing original identity.");
			assertReady(item.ready, value.initial, item.unit);
			assert.ok(BigInt(item.cleanup.rescueAtNs) > BigInt(item.ready.observedAtNs));
		}
		if (item.beforeRescue.kind === "observed") {
			assert.ok(item.ready && value.initial, "Missing pre-rescue readiness proof.");
			const before = item.beforeRescue;
			const ready = item.ready;
			assertUnit(before.unit, item.unit, value.initial, item.ready.unit.properties.InvocationID);
			assert.equal(before.unit.properties.ExecMainPID, String(item.ready.main.pid));
			assert.equal(before.unit.properties.ExecMainCode, "1", "Original main did not exit normally.");
			assert.equal(before.unit.properties.ExecMainStatus, String(selected?.exit), "Wrong original main status.");
			assert.match(before.unit.properties.ExecMainExitTimestampMonotonic ?? "", /^[1-9][0-9]*$/);
			assertProcess(before.descendant, value.initial, item.unit);
			assert.ok(sameBirth(before.descendant, item.ready.descendant), "Descendant birth changed.");
			assert.equal(before.descendant.session, item.ready.descendant.session);
			assert.equal(before.descendant.group, item.ready.descendant.group);
			assert.ok(
				before.members.some((member) => sameBirth(member, before.descendant)),
				"Missing live descendant member.",
			);
			assert.ok(!before.members.some((member) => sameBirth(member, ready.main)), "Original main is still a member.");
			assert.ok(BigInt(before.unit.atNs) > BigInt(item.ready.observedAtNs));
			assert.ok(BigInt(before.unit.atNs) <= BigInt(before.atNs));
			assert.ok(BigInt(before.atNs) < BigInt(item.cleanup.rescueAtNs), "Live proof followed rescue.");
		} else if (item.beforeRescue.injected) {
			assert.ok(selected?.inject && item.ready, "Normal failure cannot be labeled injected.");
			assert.equal(item.beforeRescue.error, injectedError);
			assert.deepEqual(item.beforeRescue.lastUnit, item.ready.unit);
		}
		const empty = item.cleanup.empty;
		if (empty) {
			const captured = item.ready?.unit ?? (item.beforeRescue.kind === "failed" ? item.beforeRescue.lastUnit : null);
			assert.ok(captured, "No captured owned cgroup.");
			assert.equal(captured.properties.Id, item.unit);
			assert.equal(captured.properties.ControlGroup, cgroupOf(item.unit));
			assert.match(captured.properties.InvocationID ?? "", /^[a-f0-9]{32}$/);
			assert.deepEqual(item.cleanup.afterRescueMain, empty.unit);
			assert.ok(BigInt(empty.unit.atNs) > BigInt(item.cleanup.rescueAtNs));
			assert.ok(BigInt(empty.unit.atNs) <= BigInt(empty.atNs));
			assert.ok(BigInt(empty.atNs) > BigInt(item.cleanup.rescueAtNs));
			assert.ok(["inactive", "failed"].includes(empty.unit.properties.ActiveState ?? ""), "Unit stop is incomplete.");
			assert.equal(empty.unit.properties.Job, "", "A manager job remains pending.");
			assert.equal(empty.populated, empty.cgroup === "empty" ? 0 : null);
			assert.equal(empty.unit.properties.Id, item.unit);
			if (empty.unit.properties.LoadState !== "not-found")
				assert.equal(empty.unit.properties.InvocationID, captured.properties.InvocationID);
		}
	}
	if (value.state === "inert-passed") {
		assert.ok(
			value.sourceCommit && value.initial && value.metadata && value.errors.length === 0,
			"Incomplete initial evidence.",
		);
		assert.equal(value.cases.length, cases.length);
		for (const [index, item] of value.cases.entries()) {
			assert.ok(item.startup && succeeded(item.startup), "Service startup was not acknowledged.");
			assert.ok(item.ready && item.cleanup.empty && item.cleanup.errors.length === 0, "Cleanup or readiness failed.");
			assert.ok(succeeded(item.cleanup.stop), "Stop submission failed.");
			if (cases[index]?.inject) assert.ok(item.beforeRescue.kind === "failed" && item.beforeRescue.injected);
			else assert.equal(item.beforeRescue.kind, "observed", "Missing pre-rescue live proof.");
		}
	}
	return value;
}

const worker = `
import json, os, pathlib, signal, sys
folder, outcome = pathlib.Path(sys.argv[1]), int(sys.argv[2])
def snapshot(pid):
    base = pathlib.Path('/proc') / str(pid)
    raw = (base / 'stat').read_text()
    fields = raw[raw.rfind(')') + 2:].split()
    return dict(pid=pid, startTicks=fields[19], state=fields[0], group=int(fields[2]), session=int(fields[3]), status=(base / 'status').read_text(), cgroup=(base / 'cgroup').read_text())
os.mkfifo(folder / 'release', 0o600)
release = os.open(folder / 'release', os.O_RDWR | os.O_CLOEXEC)
reader, writer = os.pipe()
intermediate = os.fork()
if intermediate == 0:
    os.close(reader)
    os.close(release)
    os.setsid()
    descendant = os.fork()
    if descendant != 0:
        os._exit(0)
    os.setsid()
    os.write(writer, str(os.getpid()).encode('ascii'))
    os.closerange(0, os.sysconf('SC_OPEN_MAX'))
    while True:
        signal.pause()
os.close(writer)
_, intermediate_status = os.waitpid(intermediate, 0)
assert intermediate_status == 0
with os.fdopen(reader, 'rb') as pipe:
    descendant = int(pipe.read(32))
absent = lambda keys: all(key not in os.environ for key in keys)
receipt = dict(main=snapshot(os.getpid()), descendant=snapshot(descendant), environment=dict(
    ownerHomeAbsent=absent(['BANDA_HOME']), githubTokenAbsent=absent(['GH_TOKEN', 'GITHUB_TOKEN']),
    sshAgentAbsent=absent(['SSH_AUTH_SOCK']), desktopSessionAbsent=absent(['DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']),
    pythonPathAbsent=absent(['PYTHONPATH', 'PYTHONHOME'])))
payload = json.dumps(receipt).encode('utf-8')
assert len(payload) <= 65536
with open(folder / 'ready.tmp', 'xb') as output:
    output.write(payload)
    output.flush()
    os.fsync(output.fileno())
os.replace(folder / 'ready.tmp', folder / 'ready.json')
assert os.read(release, 1) == b'x'
os._exit(outcome)
`;

function command(binary: string, args: string[]): Promise<Static<typeof Completion>> {
	return new Promise((resolve) => {
		execFile(
			binary,
			args,
			{
				encoding: "utf8",
				timeout: 5000,
				killSignal: "SIGKILL",
				maxBuffer: limit,
				env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
			},
			(error, stdout, stderr) =>
				resolve({
					status: error ? (typeof error.code === "number" ? error.code : null) : 0,
					signal: error?.signal ?? null,
					error: error ? errorText(error) : null,
					stdout: stdout.slice(0, limit),
					stderr: stderr.slice(0, limit),
				}),
		);
	});
}
function succeeded(result: Static<typeof Completion>) {
	return result.status === 0 && result.signal === null && result.error === null;
}
function emptyCommandArray(result: Static<typeof Completion> | undefined) {
	return result !== undefined && succeeded(result) && result.stdout.trim() === "a(sasbttttuii) 0";
}
function assertCommandArrays(unit: Unit) {
	for (const field of commandFields)
		assert.ok(emptyCommandArray(unit.commandArrays[field]), `Missing successful empty ${field} array readback.`);
}
async function show(unit: string): Promise<Unit> {
	const result = await command("/usr/bin/systemctl", [
		"--system",
		"--no-pager",
		"show",
		"--all",
		`--property=${unitFields.join(",")}`,
		unit,
	]);
	const properties: Record<string, string> = {};
	for (const line of result.stdout.trimEnd().split("\n")) {
		const separator = line.indexOf("=");
		assert.ok(separator > 0, "Malformed manager properties.");
		const key = line.slice(0, separator);
		assert.ok(unitFields.includes(key) && !(key in properties), "Unexpected manager property.");
		properties[key] = line.slice(separator + 1);
	}
	assert.ok(
		succeeded(result) || (result.status === 4 && properties.LoadState === "not-found"),
		result.error ?? "Manager unavailable.",
	);
	for (const key of ["Id", "LoadState", "ActiveState", "Job"]) assert.ok(key in properties, `Missing ${key}.`);
	const commandArrays: Unit["commandArrays"] = {};
	if (properties.LoadState === "loaded") {
		assert.ok(Value.Check(Case.properties.unit, unit), "Unexpected unit name.");
		const path = `/org/freedesktop/systemd1/unit/${unit.replace(/[^A-Za-z0-9]/g, (char) => `_${char.charCodeAt(0).toString(16)}`)}`;
		for (const field of commandFields) {
			const readback = await command("/usr/bin/busctl", [
				"--system",
				"--no-pager",
				"--timeout=5s",
				"get-property",
				"org.freedesktop.systemd1",
				path,
				"org.freedesktop.systemd1.Service",
				field,
			]);
			commandArrays[field] = readback;
			if (!(field in properties) && emptyCommandArray(readback)) properties[field] = "";
		}
	}
	return { atNs: now(), properties, commandArrays };
}
async function readText(path: string) {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		assert.ok((await file.stat()).isFile(), "Expected a regular evidence file.");
		const bytes = Buffer.alloc(limit + 1);
		let size = 0;
		while (size <= limit) {
			const chunk = await file.read(bytes, size, bytes.length - size, null);
			if (!chunk.bytesRead) break;
			size += chunk.bytesRead;
		}
		assert.ok(size <= limit, "Evidence exceeded its byte bound.");
		return bytes.subarray(0, size).toString("utf8");
	} finally {
		await file.close();
	}
}
async function processSnapshot(pid: number): Promise<Process> {
	const base = `/proc/${pid}`;
	const stat = await readText(`${base}/stat`);
	const fields = stat
		.slice(stat.lastIndexOf(")") + 2)
		.trim()
		.split(/\s+/);
	const value = {
		pid,
		startTicks: fields[19],
		state: fields[0],
		group: Number(fields[2]),
		session: Number(fields[3]),
		status: await readText(`${base}/status`),
		cgroup: await readText(`${base}/cgroup`),
	};
	if (!Value.Check(Process, value)) throw new Error("Malformed process evidence.");
	const after = await readText(`${base}/stat`);
	assert.equal(
		after
			.slice(after.lastIndexOf(")") + 2)
			.trim()
			.split(/\s+/)[19],
		value.startTicks,
		"Process birth changed during observation.",
	);
	return value;
}
async function groupSnapshot(unit: string) {
	const root = `/sys/fs/cgroup${cgroupOf(unit)}`;
	assert.equal(await realpath(root), root);
	const pids = (await readText(join(root, "cgroup.procs"))).trim().split(/\s+/).filter(Boolean);
	assert.ok(pids.length <= 64, "Owned cgroup exceeded its member bound.");
	const members: Static<typeof Birth>[] = [];
	for (const text of pids) {
		assert.match(text, /^[1-9][0-9]*$/);
		const member = await processSnapshot(Number(text));
		members.push({ pid: member.pid, startTicks: member.startTicks });
	}
	const events = await readText(join(root, "cgroup.events"));
	const matches = [...events.matchAll(/^populated ([01])$/gm)];
	assert.equal(matches.length, 1, "Missing recursive cgroup populated evidence.");
	return { members, populated: Number(matches[0]?.[1]) };
}
function readiness(directory: string) {
	const watcher = watch(directory);
	let close = () => {};
	const promise = new Promise<Static<typeof Receipt>>((resolve, reject) => {
		let reading = false;
		const timeout = setTimeout(() => {
			close();
			reject(new Error("Readiness timed out."));
		}, 10000);
		watcher.on("change", (_event, filename) => {
			if (filename !== "ready.json" || reading) return;
			reading = true;
			void readText(join(directory, "ready.json"))
				.then((text) => {
					const value: unknown = JSON.parse(text);
					if (!Value.Check(Receipt, value)) throw new Error("Malformed readiness receipt.");
					close();
					resolve(value);
				})
				.catch((error) => {
					close();
					reject(error);
				});
		});
		close = () => {
			clearTimeout(timeout);
			watcher.close();
		};
		watcher.on("error", (error) => {
			close();
			reject(error);
		});
	});
	void promise.catch(() => {});
	return { promise, close: () => close() };
}
async function save(directory: string, name: string, value: unknown) {
	await writeFile(join(directory, name), JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
}
function missing(error: unknown) {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function inertCase(output: string, baseline: Baseline, selected: (typeof cases)[number]): Promise<Case> {
	const unit = `banda-lifetime-${randomBytes(12).toString("hex")}-${selected.name}.service`;
	const directory = join(output, selected.name);
	assert.equal((await show(unit)).properties.LoadState, "not-found", "Prospective unit already exists.");
	let startup: Case["startup"] = null;
	let ready: Case["ready"] = null;
	let lastUnit: Unit | null = null;
	let beforeRescue: Case["beforeRescue"] = {
		kind: "failed",
		error: "Observation not completed.",
		injected: false,
		lastUnit: null,
	};
	let waiting: ReturnType<typeof readiness> | undefined;
	let cleanup: Case["cleanup"];
	try {
		await mkdir(directory, { mode: 0o700 });
		waiting = readiness(directory);
		await save(directory, "owner.json", { unit });
		const identity = parseDiagnosticIdentity(baseline.observer.status);
		assert.ok(!/[$%]/.test(worker), "Worker source contains manager expansion characters.");
		startup = await command("/usr/bin/sudo", [
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
			`--uid=${identity.uid}`,
			`--gid=${identity.gid}`,
			"/usr/bin/env",
			"-i",
			`HOME=${baseline.account.home}`,
			"PATH=/usr/bin:/bin",
			"LANG=C.UTF-8",
			"/usr/bin/python3",
			"-I",
			"-S",
			"-c",
			worker,
			directory,
			String(selected.exit),
		]);
		assert.ok(succeeded(startup), "Service startup was not acknowledged.");
		const receipt = await waiting.promise;
		lastUnit = await show(unit);
		const main = await processSnapshot(receipt.main.pid);
		const descendant = await processSnapshot(receipt.descendant.pid);
		for (const [observed, declared] of [
			[main, receipt.main],
			[descendant, receipt.descendant],
		]) {
			assert.ok(observed && declared && sameBirth(observed, declared), "Worker receipt birth differs.");
			assertProcess(declared, baseline, unit);
		}
		const observed = { main, descendant, environment: receipt.environment, unit: lastUnit, observedAtNs: now() };
		assertReady(observed, baseline, unit);
		const group = await groupSnapshot(unit);
		assert.equal(group.populated, 1);
		assert.ok(group.members.some((member) => sameBirth(member, descendant)));
		ready = observed;
		await save(directory, "readiness-proof.json", ready);
		if (selected.inject) throw new Error(injectedError);
		const release = await open(
			join(directory, "release"),
			constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
		);
		try {
			assert.ok((await release.stat()).isFIFO(), "Release channel is not a FIFO.");
			assert.equal((await release.write(Buffer.from("x"))).bytesWritten, 1);
		} finally {
			await release.close();
		}
		const deadline = Date.now() + 10000;
		for (;;) {
			lastUnit = await show(unit);
			if (lastUnit.properties.ExecMainExitTimestampMonotonic !== "0") break;
			assert.ok(Date.now() < deadline, "Original main completion timed out.");
			await delay(50);
		}
		const live = await processSnapshot(descendant.pid);
		const after = await groupSnapshot(unit);
		assert.equal(after.populated, 1, "Descendant disappeared before rescue.");
		let mainAbsent = false;
		try {
			mainAbsent = !sameBirth(await processSnapshot(main.pid), main);
		} catch (error) {
			if (!missing(error)) throw error;
			mainAbsent = true;
		}
		assert.ok(mainAbsent, "Original main birth still exists.");
		beforeRescue = {
			kind: "observed",
			atNs: now(),
			unit: lastUnit,
			descendant: live,
			mainAbsent: true,
			populated: 1,
			members: after.members,
		};
	} catch (error) {
		beforeRescue = {
			kind: "failed",
			error: errorText(error),
			injected: selected.inject && error instanceof Error && error.message === injectedError,
			lastUnit,
		};
		if (beforeRescue.injected) beforeRescue.error = injectedError;
	} finally {
		waiting?.close();
		const rescueAtNs = now();
		const errors: string[] = [];
		try {
			await save(directory, "rescue.json", { rescueAtNs, unit });
		} catch (error) {
			errors.push(errorText(error));
		}
		const stop = await command("/usr/bin/sudo", [
			"-n",
			"/usr/bin/systemctl",
			"--system",
			"--no-ask-password",
			"--no-block",
			"stop",
			unit,
		]);
		cleanup = { rescueAtNs, stop, kill: null, empty: null, afterRescueMain: null, errors };
		async function observeEmpty(milliseconds: number) {
			const deadline = Date.now() + milliseconds;
			let failure = "Cleanup deadline expired.";
			do {
				try {
					const snapshot = await show(unit);
					cleanup.afterRescueMain = snapshot;
					assert.ok(
						lastUnit && lastUnit.properties.ControlGroup === cgroupOf(unit),
						"Owned cgroup was never captured.",
					);
					assert.ok(["inactive", "failed"].includes(snapshot.properties.ActiveState ?? ""), "Stop still pending.");
					assert.equal(snapshot.properties.Job, "");
					if (snapshot.properties.LoadState !== "not-found")
						assert.equal(snapshot.properties.InvocationID, lastUnit.properties.InvocationID);
					let state: "empty" | "absent" = "empty";
					try {
						const group = await groupSnapshot(unit);
						assert.equal(group.populated, 0);
						assert.equal(group.members.length, 0);
					} catch (error) {
						if (!missing(error)) throw error;
						assert.ok(
							!(await lstat(`/sys/fs/cgroup${cgroupOf(unit)}`).catch((cause) => {
								if (!missing(cause)) throw cause;
								return null;
							})),
						);
						state = "absent";
					}
					cleanup.empty = {
						atNs: now(),
						unit: snapshot,
						cgroup: state,
						populated: state === "empty" ? 0 : null,
						members: [],
					};
					return;
				} catch (error) {
					failure = errorText(error);
				}
				await delay(100);
			} while (Date.now() < deadline);
			throw new Error(failure);
		}
		try {
			await observeEmpty(10000);
		} catch (error) {
			cleanup.errors.push(errorText(error));
			cleanup.kill = await command("/usr/bin/sudo", [
				"-n",
				"/usr/bin/systemctl",
				"--system",
				"--no-ask-password",
				"kill",
				"--kill-whom=all",
				"--signal=KILL",
				unit,
			]);
			try {
				await observeEmpty(5000);
			} catch (error) {
				cleanup.errors.push(errorText(error));
			}
		}
	}
	return { name: selected.name, unit, startup, ready, beforeRescue, cleanup };
}

async function main() {
	assert.ok(
		process.platform === "linux" && process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true",
		"This inert experiment runs only on native Linux CI.",
	);
	assert.ok(process.getuid?.() !== 0 && process.geteuid?.() !== 0, "Refusing root execution.");
	assert.equal(process.argv.length, 3, "Usage: node scripts/diagnose-linux-desktop-lifetime.ts <fresh-owned-output>");
	const output = process.argv[2] ?? "";
	assert.match(output, /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/);
	assert.equal(resolve(output), output, "Output must be canonical.");
	assert.equal(await realpath(dirname(output)), dirname(output), "Output ancestors must not be symlinks.");
	await mkdir(output, { mode: 0o700 });
	const ownership = await lstat(output);
	assert.ok(
		ownership.uid === process.getuid?.() && ownership.gid === process.getgid?.() && (ownership.mode & 0o777) === 0o700,
	);
	const result: Result = {
		qualification: false,
		desktopQualified: false,
		publicDelivery: false,
		state: "unsupported",
		sourceCommit: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? "") ? (process.env.GITHUB_SHA ?? null) : null,
		initial: null,
		metadata: null,
		cases: [],
		errors: [],
	};
	try {
		assert.ok(result.sourceCommit, "Missing source commit.");
		const status = await readText("/proc/self/status");
		const identity = parseDiagnosticIdentity(status);
		assertDiagnosticIdentity(identity, identity);
		assert.ok(BigInt(`0x${identity.capabilities.bounding}`) > 0n);
		const accountCommand = await command("/usr/bin/getent", ["passwd", String(identity.uid)]);
		assert.ok(succeeded(accountCommand));
		const account = parseLinuxRunnerAccount(accountCommand.stdout, identity);
		assert.match(account.home, /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/);
		assert.equal(await realpath(account.home), account.home);
		const observer = await processSnapshot(process.pid);
		assertDiagnosticIdentity(parseDiagnosticIdentity(observer.status), identity);
		result.initial = { observer: { ...observer, status }, account };
		assert.equal((await readText("/proc/1/comm")).trim(), "systemd", "Native system manager unavailable.");
		const cgroupMount = (await readText("/proc/self/mountinfo"))
			.split("\n")
			.filter((line) => line.includes(" /sys/fs/cgroup ") && line.includes(" - cgroup2 "));
		assert.equal(cgroupMount.length, 1, "Expected unified cgroup v2.");
		const paths: Static<typeof MetadataEntry>[] = [];
		for (const path of [
			"/usr/bin/sudo",
			"/usr/bin/systemd-run",
			"/usr/bin/systemctl",
			"/usr/bin/busctl",
			"/usr/bin/env",
			"/usr/bin/python3",
			"/usr/bin/getent",
			"/opt",
		]) {
			const canonical = await realpath(path);
			const stat = await lstat(canonical);
			paths.push({ path, canonical, uid: stat.uid, gid: stat.gid, mode: stat.mode });
			if (path !== "/opt")
				assert.ok(
					stat.isFile() && stat.uid === 0 && !(stat.mode & 0o022) && stat.mode & 0o111,
					"Unsafe fixed system executable.",
				);
		}
		const version = await command("/usr/bin/systemctl", ["--version"]);
		assert.ok(succeeded(version));
		result.metadata = { systemdVersion: version.stdout, cgroupMount: cgroupMount[0] ?? "", paths };
		result.state = "failed";
		for (const selected of cases) {
			const item = await inertCase(output, result.initial, selected);
			result.cases.push(item);
			await save(output, `${selected.name}.json`, item);
			if (!item.cleanup.empty || item.cleanup.errors.length || !succeeded(item.cleanup.stop)) break;
		}
		result.state = "inert-passed";
		parseLinuxLifetimeResult(result);
	} catch (error) {
		if (result.state === "inert-passed") result.state = "failed";
		result.errors.push(errorText(error));
	} finally {
		assert.ok(Value.Check(Result, result), "Cannot write an untyped lifetime result.");
		await save(output, "result.json", result);
	}
	process.exitCode = result.state === "inert-passed" ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main().catch((error) => {
		console.error(errorText(error));
		process.exitCode = 1;
	});
}
