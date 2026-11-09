import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { shellPath } from "../desktop/src/environment.ts";
import { onPath } from "../src/core/harness-files.ts";

const quote = (text: string) => `'${text.replaceAll("'", `'"'"'`)}'`;
async function home() {
	const path = await mkdtemp(join(tmpdir(), "banda-shell-"));
	onTestFinished(() => rm(path, { recursive: true, force: true }));
	return path;
}

it.skipIf(process.platform === "win32")(
	"finds owner-installed commands outside Finder's PATH and keeps that path for children",
	async () => {
		const cwd = await home();
		const command = join(cwd, "pi");
		await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const shell = join(cwd, "owner-shell");
		await writeFile(
			shell,
			`#!/bin/sh\n[ "$1" = '-ilc' ] || exit 1\nprintf 'startup chatter\\n'\nexport PATH=${quote(cwd)}:/usr/bin:/bin\nexec /bin/sh -c "$2"\n`,
			{ mode: 0o755 },
		);
		const node = join(cwd, "owner's node");
		await symlink(process.execPath, node);
		const env = { PATH: "/usr/bin:/bin" };
		expect(onPath("pi", env.PATH)).toBeUndefined();
		const recovered = await shellPath(node, { shell, cwd, env });
		expect(recovered).toBe(`${cwd}:/usr/bin:/bin`);
		expect(onPath("pi", recovered)).toBe(command);
		// The same search path handed to the daemon is available to the executable's own subprocesses.
		const found = execFileSync("/bin/sh", ["-c", "command -v pi"], { env: { PATH: recovered }, encoding: "utf8" });
		expect(found.trim()).toBe(command);
	},
);

it.skipIf(process.platform === "win32")(
	"bounds failed, noisy and hung shell startup without importing its output",
	async () => {
		const cwd = await home();
		const shell = join(cwd, "shell");
		for (const script of ["exit 1", "printf 'not a path'", "while :; do printf 'lots of chatter'; done", "sleep 30"]) {
			await writeFile(shell, `#!/bin/sh\n${script}\n`);
			await chmod(shell, 0o755);
			const start = Date.now();
			expect(await shellPath(process.execPath, { shell, cwd, timeout: 100 })).toBeUndefined();
			expect(Date.now() - start).toBeLessThan(2000);
		}
		expect(await shellPath(process.execPath, { shell: join(cwd, "absent"), cwd })).toBeUndefined();
	},
);

it.skipIf(process.platform === "win32")(
	"takes only absolute PATH entries and refuses malformed framed values",
	async () => {
		const cwd = await home();
		const shell = join(cwd, "shell");
		for (const [value, expected] of [
			['".:relative::/usr/bin:/bin:/usr/bin"', "/usr/bin:/bin"],
			['".:relative:"', undefined],
			["null", undefined],
			["{}", undefined],
			["not-json", undefined],
		] as const) {
			await writeFile(shell, `#!/bin/sh\nprintf '\\000BANDA_PATH\\000%s\\000' ${quote(value)}\n`, { mode: 0o755 });
			expect(await shellPath(process.execPath, { shell, cwd })).toBe(expected);
		}
	},
);
