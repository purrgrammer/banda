/** Read the owner's command search path, as a terminal does, before starting a daemon from a desktop launcher. */
import { spawn } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { delimiter, isAbsolute } from "node:path";

const START = "\0BANDA_PATH\0";
const quote = (text: string) => `'${text.replaceAll("'", `'"'"'`)}'`;

/** Only PATH crosses back: shell startup output and any other exported values are neither imported nor logged. */
export async function shellPath(
	node: string,
	{
		env = process.env,
		shell = userInfo().shell,
		cwd = homedir(),
		timeout = 5000,
	}: { env?: NodeJS.ProcessEnv; shell?: string | null; cwd?: string; timeout?: number } = {},
): Promise<string | undefined> {
	if (process.platform === "win32" || shell == null || !isAbsolute(shell)) return undefined;
	const script = `process.stdout.write(${JSON.stringify(START)} + JSON.stringify(process.env.PATH) + "\\0")`;
	return new Promise((resolve) => {
		let output = "";
		let ended = false;
		// The shell belongs to the owner and starts in their home, never in a folder an agent wrote.
		const child = spawn(shell, ["-ilc", `${quote(node)} -e ${quote(script)}`], {
			cwd,
			env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
			stdio: ["ignore", "pipe", "ignore"],
			detached: true,
		});
		const kill = () => {
			// A startup script can hang or leave a child holding stdout. Bound that whole process group too.
			if (child.pid !== undefined)
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					// It already exited.
				}
		};
		const finish = (path?: string) => {
			if (ended) return;
			ended = true;
			clearTimeout(timer);
			kill();
			resolve(path);
		};
		const timer = setTimeout(() => finish(), timeout);
		child.on("error", () => finish());
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			output += chunk;
			if (Buffer.byteLength(output) > 128 * 1024) finish();
		});
		child.on("exit", kill);
		child.on("close", (code) => {
			if (code !== 0) return finish();
			const start = output.lastIndexOf(START);
			const end = output.indexOf("\0", start + START.length);
			if (start < 0 || end < 0) return finish();
			try {
				const path: unknown = JSON.parse(output.slice(start + START.length, end));
				if (typeof path !== "string") return finish();
				const directories = [...new Set(path.split(delimiter).filter(isAbsolute))];
				finish(directories.length === 0 ? undefined : directories.join(delimiter));
			} catch {
				finish();
			}
		});
	});
}
