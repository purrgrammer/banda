/**
 * `node scripts/smoke-release.ts`: the staged release in `release/banda/` starts a daemon on a throwaway home, serves
 * the web UI, answers the launcher's `status`, and stops on a signal. The release workflow runs it on every target
 * before anything is uploaded. It never touches ~/.banda.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const windows = process.platform === "win32";
const root = join(import.meta.dirname, "..", "release", "banda");
const node = join(root, "node", windows ? "node.exe" : "node");
const cli = join(root, "app", "dist", "cli", "index.js");
const home = await mkdtemp(join(tmpdir(), "banda-smoke-"));
const env = { ...process.env, BANDA_HOME: home };

const pinned = execFileSync(node, ["--version"], { encoding: "utf8" }).trim();
console.log(`bundled node ${pinned}`);

// the launcher itself: the same tree a person runs from PATH
const launcher = join(root, "bin", windows ? "banda.cmd" : "banda");
const help = execFileSync(launcher, ["--help"], { encoding: "utf8", env, shell: windows });
if (!help.startsWith("banda ")) throw new Error(`the launcher printed:\n${help}`);

// the daemon is the bundled node directly, so a signal reaches it rather than a launcher's shell. No box is built: host
// mode where there is one, and on Windows (which has none) the container box, offline without a Linux Docker engine
const box = windows ? [] : ["--box", "host"];
const daemon = spawn(node, [cli, "serve", "--port", "0", ...box], {
	env,
	stdio: ["ignore", "inherit", "pipe"],
});
let stderr = "";
daemon.stderr.on("data", (chunk: Buffer) => {
	stderr += chunk.toString();
});
const exited = new Promise<number | null>((resolve) => daemon.once("exit", resolve));

try {
	const { port, token } = await published(home, 60_000);
	const page = await fetch(`http://127.0.0.1:${port}/`);
	const html = await page.text();
	if (!page.ok || !html.includes("<html")) throw new Error(`GET / answered ${page.status}`);
	const status = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { authorization: `Bearer ${token}` } });
	if (!status.ok) throw new Error(`GET /api/status answered ${status.status}`);
	console.log(`daemon served the web UI and its API on port ${port}`);
	// Every supported release target ships Iroh's native addon.
	const devices = await fetch(`http://127.0.0.1:${port}/api/devices`, {
		headers: { authorization: `Bearer ${token}` },
	});
	const { remote } = (await devices.json()) as { remote?: string };
	if (remote !== "idle") throw new Error(`remote reach is ${remote}, not idle, on ${process.platform}-${process.arch}`);
	console.log(`remote reach: ${remote}`);
} catch (error) {
	daemon.kill("SIGKILL");
	console.error(stderr);
	throw error;
}

daemon.kill("SIGTERM");
const code = await exited;
// Windows has no SIGTERM: kill() ends the process outright, which the store survives by design
if (!windows && (code !== 0 || existsSync(join(home, "daemon.json"))))
	throw new Error(`the daemon did not stop cleanly (exit ${code}):\n${stderr}`);
await rm(home, { recursive: true, force: true, maxRetries: 5 });
console.log("smoke run passed");

async function published(home: string, within: number): Promise<{ port: number; token: string }> {
	const deadline = Date.now() + within;
	while (Date.now() < deadline) {
		if (daemon.exitCode !== null) throw new Error(`the daemon exited with ${daemon.exitCode}`);
		const text = await readFile(join(home, "daemon.json"), "utf8").catch(() => undefined);
		if (text !== undefined) {
			const file = JSON.parse(text) as { port?: number; token?: string };
			if (file.port !== undefined && file.token !== undefined) return { port: file.port, token: file.token };
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error("the daemon did not publish its port in time");
}
