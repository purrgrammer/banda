/**
 * A fake Docker engine behind a mocked `node:child_process`: it answers what banda asks and records every command, so a
 * test asserts on the commands banda would send. It never starts a process: anything but `docker` through `execFile`
 * throws. It holds no banda logic: which boxes to remove is decided by the real code under test.
 *
 *   vi.mock("node:child_process", async () => (await import("./fixtures/fake-docker.ts")).childProcess);
 */
export const engine = {
	containers: [] as { name: string; home: string }[],
	volumes: [] as string[],
	calls: [] as string[][],
};

export function resetEngine(containers: { name: string; home: string }[], volumes: string[]): void {
	engine.containers = containers;
	engine.volumes = volumes;
	engine.calls = [];
}

function answer(args: string[]): string {
	if (args[0] === "version") return "28.1.1";
	if (args[0] === "ps") return engine.containers.map(({ name, home }) => `${name}\t${home}`).join("\n");
	if (args[0] === "volume" && args[1] === "ls") {
		const filter = args[args.indexOf("--filter") + 1] ?? "";
		const pattern = new RegExp(filter.replace(/^name=/, ""));
		return engine.volumes.filter((volume) => pattern.test(volume)).join("\n");
	}
	return "";
}

/** The commands that delete something: containers, networks, volumes. */
export const deletions = (): string[][] =>
	engine.calls.filter(
		(args) => args[0] === "rm" || (args[1] === "rm" && ["network", "volume"].includes(args[0] ?? "")),
	);

function execFile(file: string, args: readonly string[], _options: unknown, callback: (...a: unknown[]) => void) {
	if (file !== "docker") throw new Error(`fake child_process: refusing to run ${file}`);
	engine.calls.push([...args]);
	queueMicrotask(() => callback(null, answer([...args]), ""));
	return { stdin: { end() {} } };
}

const refuse = (name: string) => () => {
	throw new Error(`fake child_process: refusing ${name}`);
};

export const childProcess = {
	execFile,
	spawn: refuse("spawn"),
	exec: refuse("exec"),
	fork: refuse("fork"),
	execFileSync: refuse("execFileSync"),
	execSync: refuse("execSync"),
	spawnSync: refuse("spawnSync"),
};
