/** Manual native release check, including public networking. Uses only an isolated home and the staged app. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { BrowserPreparation } from "../src/box/browser-preparation.ts";
import { nativeComputerReply } from "../test/fixtures/native-computer-model.ts";
import { BROWSERS, hold } from "../test/slots.ts";
import { hasChrome, withPage } from "../test/smoke/chrome.ts";
import { hostDiagnostics } from "./native-diagnostics.ts";

const sourceCommit = process.env.BANDA_VERIFY_SOURCE_COMMIT ?? null;
assert.ok(
	sourceCommit === null || /^[a-f0-9]{40}$/.test(sourceCommit),
	"BANDA_VERIFY_SOURCE_COMMIT must be a full lowercase commit SHA.",
);
const root = process.env.BANDA_RELEASE_ROOT ?? join(import.meta.dirname, "../release/banda");
assert.ok(isAbsolute(root), "BANDA_RELEASE_ROOT must be an absolute path to a staged banda package.");
const node = join(root, "node/node");
if ((await realpath(process.execPath)) !== (await realpath(node))) {
	const child = spawnSync(node, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
	process.exit(child.status ?? 1);
}
assert.ok(hasChrome(), "Native app verification requires Chrome (set CHROME to its executable).");
if (process.platform === "linux") {
	const kvm = await stat("/dev/kvm").catch((error: unknown) => {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			throw new Error(
				"Native Linux verification requires /dev/kvm. This runner has no KVM device; Linux is unqualified.",
				{ cause: error },
			);
		throw error;
	});
	assert.ok(kvm.isCharacterDevice(), "Native Linux verification requires a KVM character device at /dev/kvm.");
	await access("/dev/kvm", constants.R_OK | constants.W_OK).catch(() => {
		throw new Error("Native Linux verification cannot access /dev/kvm. Grant the runner account read/write access.");
	});
}
const output = process.argv[2] ?? (await mkdtemp(join(tmpdir(), "banda-native-evidence-")));
if (process.argv[2] !== undefined) await mkdir(output);
const hostBefore = process.platform === "linux" ? await hostDiagnostics() : undefined;
const app = join(root, "app");
const { startDaemon }: typeof import("../src/daemon.ts") = await import(
	pathToFileURL(join(app, "dist/daemon.js")).href
);
const { installedMicrovmAssets }: typeof import("../src/box/microvm-assets.ts") = await import(
	pathToFileURL(join(app, "dist/box/microvm-assets.js")).href
);
const { createModels, fauxProvider }: typeof import("@earendil-works/pi-ai") = await import(
	pathToFileURL(join(app, "node_modules/@earendil-works/pi-ai/dist/index.js")).href
);
const assets = await installedMicrovmAssets();
const runtimeManifestSha256 = createHash("sha256")
	.update(await readFile(join(app, "computer/manifest.json")))
	.digest("hex");
const publicBrowserDelivery = process.env.BANDA_VERIFY_PUBLIC_BROWSER === "1";
const publicFirstBrowserWaitMs = 15 * 60_000 + 120_000;
const archive = join(root, "..", new URL(assets.browser.url).pathname.split("/").at(-1) ?? "missing-browser.tar");
const nativeFetch = globalThis.fetch;
let downloads = 0;
globalThis.fetch = (input, init) => {
	const url = input instanceof Request ? input.url : String(input);
	if (url !== assets.browser.url) return nativeFetch(input, init);
	downloads++;
	if (publicBrowserDelivery) return nativeFetch(input, init);
	return Promise.resolve(
		new Response(Readable.toWeb(createReadStream(archive)), {
			headers: { "content-length": String(assets.browser.bytes) },
		}),
	);
};
const home = await realpath(await mkdtemp(join(tmpdir(), "banda-native-proof-")));
const cache = join(
	process.platform === "darwin" ? "/private/tmp" : "/tmp",
	`banda-msb-${process.getuid?.() ?? 0}-${createHash("sha256").update(home).digest("hex").slice(0, 16)}`,
);
const runtimeEnv = {
	PATH: "/usr/bin:/bin",
	HOME: home,
	MSB_HOME: cache,
	MSB_PATH: assets.msb,
	MSB_LIBKRUNFW_PATH: assets.firmware,
};
const runtime = (args: readonly string[], timeout = 30_000) =>
	execFileSync(assets.msb, [...args], {
		encoding: "utf8",
		env: runtimeEnv,
		timeout,
		killSignal: "SIGKILL",
		maxBuffer: 1 << 20,
	});
const VMName = Type.String({ pattern: "^banda-microvm-[a-f0-9]{10}-[a-f0-9]{12}(?:-(?:proxy|browser))?$" });
const Listing = Type.Array(Type.Object({ name: VMName }));
const Owned = Type.Object({
	name: VMName,
	config: Type.Object({
		labels: Type.Object({
			"banda.home": Type.Literal(home),
			"banda.runtime": Type.Literal("microvm"),
			"banda.generation": Type.String({ pattern: "^[a-f0-9]{12}$" }),
		}),
	}),
});
const inventory = () => {
	const listed: unknown = JSON.parse(runtime(["list", "--format", "json"]));
	assert.ok(Value.Check(Listing, listed), "Invalid owned VM inventory.");
	assert.ok(listed.length <= 3, "The native proof owns at most one command, proxy and browser VM.");
	return listed.map((vm) => {
		const inspected: unknown = JSON.parse(runtime(["inspect", vm.name, "--format", "json"]));
		assert.ok(Value.Check(Owned, inspected), "Refusing an unowned VM.");
		assert.equal(inspected.name, vm.name);
		assert.ok(vm.name.includes(`-${inspected.config.labels["banda.generation"]}`));
		return inspected;
	});
};
let proxyRestarts = 0;
let declinedPosts = 0;
let daemonRestarts = 0;
const stopProxy = () => {
	const listed: unknown = JSON.parse(runtime(["list", "--format", "json"]));
	assert.ok(Value.Check(Listing, listed));
	const proxy = listed.find((vm) => vm.name.endsWith("-proxy"));
	assert.ok(proxy !== undefined);
	const inspected: unknown = JSON.parse(runtime(["inspect", proxy.name, "--format", "json"]));
	assert.ok(Value.Check(Owned, inspected));
	assert.equal(inspected.name, proxy.name);
	runtime(["stop", proxy.name]);
	proxyRestarts++;
};
const proof = createHash("sha256").update(home).digest("hex").slice(0, 16);
const command = `set -eu
test "$PWD" = /workspace
test "$HOME" = /work
test "$(id -u)" = 1000
test ! -w /usr/bin
mkdir -p /tools/bin
printf '%s\\n' native-workspace-${proof} > /workspace/native-proof
printf '%s\\n' native-work-${proof} > /work/native-proof
printf '%s\\n' native-tools-${proof} > /tools/native-proof
printf '%s\\n' '#!/bin/sh' 'printf native-tool-${proof}' > /tools/bin/native-proof
chmod 755 /tools/bin/native-proof
test "$(native-proof)" = native-tool-${proof}
curl --fail --silent --show-error --max-time 30 https://example.com/ | grep -q 'Example Domain'
if curl --noproxy '*' --silent --max-time 3 -k https://1.1.1.1 >/dev/null; then exit 1; fi
status=$(curl --silent --show-error --max-time 30 --output /tmp/native-held-response --write-out '%{http_code}' --data-binary banda-native-proof https://httpbingo.org/anything)
test "$status" = 403
test "$(cat /proc/sys/net/ipv6/conf/lo/disable_ipv6)" = 0
/bin/sh /banda/proxy-bridge.sh --check
printf native-computer-verified`;
const readOnlyCommand = `set -eu
test "$PWD" = /workspace
test "$HOME" = /work
test "$(cat /workspace/native-proof)" = native-workspace-${proof}
test "$(cat /work/native-proof)" = native-work-${proof}
test "$(cat /tools/native-proof)" = native-tools-${proof}
test -x /tools/bin/native-proof
test "$(native-proof)" = native-tool-${proof}
cat /workspace/native-proof /work/native-proof /tools/native-proof
native-proof
printf '\\nnative-persistence-verified\\n'`;
const persistenceOutput = [
	`native-workspace-${proof}`,
	`native-work-${proof}`,
	`native-tools-${proof}`,
	`native-tool-${proof}`,
	"native-persistence-verified",
].join("\n");
const models = createModels();
const faux = fauxProvider({ tokensPerSecond: 10_000 });
models.setProvider(faux.provider);
faux.setResponses(
	Array.from(
		{ length: 120 },
		() => (request) =>
			nativeComputerReply(request.messages, {
				check: command,
				persistence: { command: readOnlyCommand, output: persistenceOutput },
			}),
	),
);
await writeFile(
	join(home, "config.json"),
	JSON.stringify({ model: { provider: "faux", modelId: "faux-1" }, remote: { reach: "off" } }),
);
let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
const log: string[] = [];
let verification: { state: "running" } | { state: "passed" } | { state: "failed"; error: unknown } = {
	state: "running",
};
const cleanupFailures: unknown[] = [];
let diagnostics: (() => Promise<unknown>) | undefined;
const releaseBrowser = await hold(BROWSERS);
try {
	const start = () =>
		startDaemon({
			home,
			port: 0,
			models,
			boxKind: "microvm",
			web: join(app, "web/dist"),
			log: (line) => log.push(line),
		});
	const Published = Type.Object({
		pid: Type.Literal(process.pid),
		port: Type.Integer({ minimum: 1 }),
		token: Type.String(),
	});
	const publication = async (running: Awaited<ReturnType<typeof startDaemon>>) => {
		const published: unknown = JSON.parse(await readFile(join(home, "daemon.json"), "utf8"));
		assert.ok(Value.Check(Published, published));
		assert.equal(published.port, running.port);
		return published;
	};
	daemon = await start();
	let published = await publication(daemon);
	let origin = `http://127.0.0.1:${daemon.port}`;
	let headers = { authorization: `Bearer ${published.token}` };
	diagnostics = async () => {
		const reads = [];
		for (const path of ["/status", "/chats"]) {
			const response = await fetch(`${origin}/api${path}`, { headers, signal: AbortSignal.timeout(5_000) });
			reads.push({ path, status: response.status, body: await response.text() });
		}
		return reads;
	};
	const Event = Type.Object({ type: Type.String() });
	const Computer = Type.Object({
		type: Type.Literal("computer"),
		computer: Type.Object({
			state: Type.Union([
				Type.Literal("starting"),
				Type.Literal("building"),
				Type.Literal("up"),
				Type.Literal("offline"),
			]),
			why: Type.Optional(Type.String()),
			box: Type.String(),
			network: Type.String(),
			browser: BrowserPreparation,
		}),
	});
	const computers = async function* (signal: AbortSignal) {
		const response = await fetch(`${origin}/api/events`, { headers, signal });
		assert.ok(response.ok, `/events: ${response.status}: ${response.ok ? "" : await response.text()}`);
		assert.ok(response.body !== null, "Native computer readiness requires the shell event stream.");
		let buffer = "";
		for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
			buffer += chunk;
			for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
				const frame = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				if (!frame.startsWith("data: ")) continue;
				const event: unknown = JSON.parse(frame.slice("data: ".length));
				if (!Value.Check(Event, event) || event.type !== "computer") continue;
				assert.ok(Value.Check(Computer, event), `Invalid native computer event: ${JSON.stringify(event)}`);
				yield event.computer;
			}
		}
	};
	const browserProgress: { at: string; computer: Static<typeof Computer>["computer"] }[] = [];
	let received = 0;
	const observeBrowser = async (signal: AbortSignal): Promise<never> => {
		let previousPhase = "";
		let previousAt = 0;
		for await (const computer of computers(signal)) {
			const browser = computer.browser;
			const downloading = browser.state === "preparing" && browser.phase === "downloading";
			if (downloading) {
				assert.equal(browser.total, assets.browser.bytes, "Browser progress must describe the pinned archive.");
				assert.ok(browser.received >= received && browser.received <= browser.total);
				received = browser.received;
			}
			const phase = JSON.stringify([computer.state, browser.state, browser.state === "preparing" && browser.phase]);
			const now = Date.now();
			if (phase !== previousPhase || now - previousAt >= 10_000 || (downloading && received === browser.total)) {
				browserProgress.push({ at: new Date(now).toISOString(), computer });
				if (browserProgress.length > 128) browserProgress.shift();
				await writeFile(join(output, "browser-progress.json"), JSON.stringify(browserProgress, null, 2));
				previousPhase = phase;
				previousAt = now;
			}
			assert.notEqual(browser.state, "failed", `Native browser preparation failed: ${JSON.stringify(browser)}`);
		}
		throw new Error("Native computer event stream ended during the public browser wait.");
	};
	const ready = async () => {
		const startup = new AbortController();
		let computer: Static<typeof Computer>["computer"] | undefined;
		const deadline = setTimeout(
			() =>
				startup.abort(
					new Error(`Native computer did not become ready within 120 seconds; last state: ${JSON.stringify(computer)}`),
				),
			120_000,
		);
		try {
			for await (const current of computers(startup.signal)) {
				computer = current;
				log.push(`qualification: computer ${JSON.stringify(computer)}`);
				assert.notEqual(
					computer.state,
					"offline",
					`Native computer is offline: ${computer.why ?? JSON.stringify(computer)}`,
				);
				assert.equal(computer.box, "microvm");
				assert.equal(computer.network, "guarded");
				if (computer.state === "up") {
					assert.equal(computer.browser.state, "idle");
					break;
				}
			}
			assert.equal(
				computer?.state,
				"up",
				`Native computer event stream ended before readiness: ${JSON.stringify(computer)}`,
			);
		} finally {
			clearTimeout(deadline);
			startup.abort();
		}
	};
	await ready();
	const api = async (path: string, body: object, method = "POST") => {
		const response = await fetch(`${origin}/api${path}`, {
			method,
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		assert.ok(response.ok, `${path}: ${response.status}: ${response.ok ? "" : await response.text()}`);
	};
	const Pending = Type.Object({
		chats: Type.Array(Type.Object({ state: Type.String() })),
		waits: Type.Array(
			Type.Object({
				key: Type.String(),
				ask: Type.Object({
					type: Type.Literal("approval"),
					tool: Type.Literal("propose_send"),
					verb: Type.Optional(Type.String()),
					args: Type.Object({
						method: Type.Literal("POST"),
						address: Type.Literal("https://httpbingo.org/anything"),
						body: Type.Literal("banda-native-proof"),
					}),
				}),
			}),
		),
	});
	const status = async () => {
		const response = await fetch(`${origin}/api/status`, { headers, signal: AbortSignal.timeout(10_000) });
		assert.ok(response.ok);
		const value: unknown = await response.json();
		assert.ok(Value.Check(Pending, value), "Only the deliberately held native test POST may await approval.");
		return value;
	};
	const idle = async () => {
		const settled = AbortSignal.timeout(30_000);
		for (;;) {
			settled.throwIfAborted();
			const now = await status();
			if (now.waits.length === 0 && now.chats.every((chat) => chat.state === "idle")) return;
			await delay(20, undefined, { signal: settled });
		}
	};
	const History = Type.Array(
		Type.Object({ entry: Type.Integer({ minimum: 1 }), mine: Type.Boolean(), text: Type.String() }),
	);
	const history = `[...document.querySelectorAll('[data-entry] [data-message-bubble]')].map(el => ({
		entry: Number(el.closest('[data-entry]')?.getAttribute('data-entry') ?? 0),
		mine: el.hasAttribute('data-mine'), text: el.textContent
	}))`;
	let historyBeforeRestart: Static<typeof History> = [];
	await api("/skills/shipped", { add: [] });
	await api("/companion", { name: "Sancho", personality: "Brief." }, "PUT");
	for (const width of [1440, 390]) {
		await withPage(`${origin}/#token=${published.token}`, { width, height: 900 }, async (page) => {
			await page.until("!location.hash.includes('token=') && document.body.innerText.length > 0");
			await page.run("location.hash='#/settings'");
			await page.until(
				"document.body.innerText.includes('Prepared on first use, or prepare it now.') && document.body.innerText.includes('No browser pages running.')",
			);
			assert.equal(downloads, 0, "Opening General must leave browser preparation lazy.");
			await page.run(
				"[...document.querySelectorAll('h2')].find(el=>el.textContent==='The computer').scrollIntoView({block:'center'})",
			);
			await page.shoot(join(output, `computer-general-idle-${width}.png`));
			assert.deepEqual(page.errors(), []);
		});
	}
	for (const width of [1440, 390]) {
		await withPage(`${origin}/#token=${published.token}`, { width, height: 900 }, async (page) => {
			await page.until("!location.hash.includes('token=') && document.body.innerText.length > 0");
			await page.run("location.hash='#/a/sancho'");
			for (const [text, answer] of [
				["Check the computer.", "native-computer-verified"],
				["Browse the example page.", "Example Domain"],
			]) {
				// Existing command and browser connections must repair their proxy before the next operation.
				if (width === 390) stopProxy();
				const newestOwner =
					"Math.max(0,...[...document.querySelectorAll('[data-message-bubble][data-mine]')].map(el=>Number(el.closest('[data-entry]')?.getAttribute('data-entry')??0)))";
				const before = await page.run<number>(newestOwner);
				await page.until("document.querySelector('textarea[name=message]')");
				await page.run("document.querySelector('textarea[name=message]').focus()");
				await page.input("Input.insertText", { text });
				await page.until("document.querySelector('button[aria-label=Send]:not([disabled])')");
				await page.run("document.querySelector('button[aria-label=Send]').click()");
				await page.until(`${newestOwner} > ${before}`);
				const after = await page.run<number>(newestOwner);
				const publicFirstBrowser = publicBrowserDelivery && width === 1440 && answer === "Example Domain";
				const watching = new AbortController();
				const observed = publicFirstBrowser ? observeBrowser(watching.signal) : undefined;
				try {
					await Promise.race([
						page.until(
							`[...document.querySelectorAll('[data-message-bubble]:not([data-mine])')].some(el=>Number(el.closest('[data-entry]')?.getAttribute('data-entry')??0)>${after} && el.innerText.includes(${JSON.stringify(answer)}))`,
							publicFirstBrowser ? publicFirstBrowserWaitMs : 120_000,
						),
						...(observed === undefined ? [] : [observed]),
					]);
					if (publicFirstBrowser)
						assert.ok(received > 0, "Public browser preparation requires observed byte progress.");
				} finally {
					watching.abort();
					await observed?.catch(() => undefined);
				}
				if (answer === "native-computer-verified") {
					await page.until(
						`[...document.querySelectorAll('[data-message-bubble]:not([data-mine])')].some(el=>Number(el.closest('[data-entry]')?.getAttribute('data-entry')??0)>${after} && el.innerText.includes('Held, not sent: POST'))`,
						30_000,
					);
					await page.until("document.querySelector('[data-open-ask]')", 30_000);
					const { waits } = await status();
					assert.equal(waits.length, 1, "The held test POST must produce one approval.");
					const [wait] = waits;
					assert.ok(wait !== undefined);
					const decline = `Don't ${(wait.ask.verb ?? "Allow").toLowerCase()}`;
					const button = `[...document.querySelectorAll('[data-open-ask] button')].find(el=>el.textContent.trim()===${JSON.stringify(decline)})`;
					await page.until(`${button} && !${button}.disabled`);
					await page.run(`${button}.scrollIntoView({block:'center'})`);
					await page.shoot(join(output, `computer-held-${width}.png`));
					await page.click(button);
					await page.until("!document.querySelector('[data-open-ask]')");
					await idle();
					declinedPosts++;
				}
			}
			await idle();
			if (width === 390) {
				const retained = await page.run<unknown>(history);
				assert.ok(Value.Check(History, retained));
				for (const text of ["Check the computer.", "Browse the example page."])
					assert.equal(retained.filter((message) => message.mine && message.text === text).length, 2);
				for (const text of ["native-computer-verified", "Example Domain"])
					assert.equal(retained.filter((message) => !message.mine && message.text.includes(text)).length, 2);
				historyBeforeRestart = retained;
				await writeFile(join(output, "history-before-restart.json"), JSON.stringify(retained, null, 2));
			}
			await page.shoot(join(output, `computer-${width}.png`));
			await page.run("location.hash='#/settings'");
			await page.until(
				"document.body.innerText.includes('Available when needed.') && document.body.innerText.includes('1 browser page running.')",
			);
			await page.run(
				"[...document.querySelectorAll('h2')].find(el=>el.textContent==='The computer').scrollIntoView({block:'center'})",
			);
			await page.shoot(join(output, `computer-general-ready-${width}.png`));
			assert.deepEqual(page.errors(), []);
		});
	}
	assert.equal(downloads, 1);
	assert.equal(proxyRestarts, 2);
	assert.equal(declinedPosts, 2);
	const beforeRestart = inventory();
	assert.equal(beforeRestart.length, 3, "The completed scenario must own command, proxy and browser VMs.");
	const generationsBefore = new Set(beforeRestart.map((vm) => vm.config.labels["banda.generation"]));
	assert.equal(generationsBefore.size, 1);
	await writeFile(join(output, "vms-before-restart.json"), JSON.stringify(beforeRestart, null, 2));
	const firstPort = daemon.port;
	await daemon.close();
	assert.deepEqual(await daemon.stopped, { failed: false });
	assert.deepEqual(
		log.filter((line) => line.startsWith("close:")),
		[],
		"The first daemon must stop without close failures.",
	);
	assert.deepEqual(inventory(), [], "Stopping the owned daemon must remove its VMs before restarting.");
	await assert.rejects(readFile(join(home, "daemon.json")), { code: "ENOENT" });
	await assert.rejects(fetch(`${origin}/api/status`, { headers, signal: AbortSignal.timeout(5_000) }));
	await writeFile(
		join(output, "daemon-stopped.json"),
		JSON.stringify({ port: firstPort, stopped: true, vms: [] }, null, 2),
	);
	daemon = undefined;
	daemon = await start();
	published = await publication(daemon);
	origin = `http://127.0.0.1:${daemon.port}`;
	headers = { authorization: `Bearer ${published.token}` };
	await ready();
	const afterRestart = inventory();
	assert.equal(afterRestart.length, 2, "A restarted daemon prepares its browser only when the app uses it.");
	const generationsAfter = new Set(afterRestart.map((vm) => vm.config.labels["banda.generation"]));
	assert.equal(generationsAfter.size, 1);
	for (const generation of generationsAfter)
		assert.ok(!generationsBefore.has(generation), "The restarted daemon must own a new VM generation.");
	await writeFile(join(output, "vms-after-restart.json"), JSON.stringify(afterRestart, null, 2));
	daemonRestarts++;
	assert.equal(downloads, 1, "Restarting the daemon must keep the prepared browser archive.");
	assert.ok(historyBeforeRestart.length > 0);
	const retainedHistory = `${JSON.stringify(historyBeforeRestart)}.every(before => (${history}).some(after =>
		after.entry === before.entry && after.mine === before.mine && after.text === before.text))`;
	for (const width of [1440, 390]) {
		await withPage(`${origin}/#token=${published.token}`, { width, height: 900 }, async (page) => {
			try {
				await page.until("!location.hash.includes('token=') && document.body.innerText.length > 0");
				await page.run("location.hash='#/a/sancho'");
				await page.until(retainedHistory);
				await page.shoot(join(output, `computer-restart-history-${width}.png`));
				for (const [text, answer] of [
					["Read the files after restart.", "native-persistence-verified"],
					["Browse the example page.", "Example Domain"],
				]) {
					const newestOwner =
						"Math.max(0,...[...document.querySelectorAll('[data-message-bubble][data-mine]')].map(el=>Number(el.closest('[data-entry]')?.getAttribute('data-entry')??0)))";
					const before = await page.run<number>(newestOwner);
					await page.until("document.querySelector('textarea[name=message]')");
					await page.run("document.querySelector('textarea[name=message]').focus()");
					await page.input("Input.insertText", { text });
					await page.until("document.querySelector('button[aria-label=Send]:not([disabled])')");
					await page.click("document.querySelector('button[aria-label=Send]')");
					await page.until(`${newestOwner} > ${before}`);
					const after = await page.run<number>(newestOwner);
					await page.until(
						`[...document.querySelectorAll('[data-message-bubble]:not([data-mine])')].some(el=>Number(el.closest('[data-entry]')?.getAttribute('data-entry')??0)>${after} && el.innerText.includes(${JSON.stringify(answer)}))`,
						120_000,
					);
					await idle();
				}
				await page.until(retainedHistory);
				await page.shoot(join(output, `computer-restart-${width}.png`));
				await writeFile(
					join(output, `history-after-restart-${width}.json`),
					JSON.stringify(await page.run(history), null, 2),
				);
				await page.run("location.hash='#/settings'");
				await page.until(
					"document.body.innerText.includes('Available when needed.') && document.body.innerText.includes('1 browser page running.')",
				);
				assert.equal(downloads, 1, "Using the prepared browser after restart must not deliver the archive again.");
				await page.run(
					"[...document.querySelectorAll('h2')].find(el=>el.textContent==='The computer').scrollIntoView({block:'center'})",
				);
				await page.shoot(join(output, `computer-restart-general-ready-${width}.png`));
				assert.deepEqual(page.errors(), []);
			} catch (error) {
				await page.shoot(join(output, `computer-restart-failed-${width}.png`)).catch(() => undefined);
				throw error;
			}
		});
	}
	assert.equal(daemonRestarts, 1);
	verification = { state: "passed" };
} catch (error) {
	verification = { state: "failed", error };
	const runtimeDiagnostics: unknown[] = [];
	try {
		const listed: unknown = JSON.parse(runtime(["list", "--format", "json"], 5_000));
		assert.ok(Value.Check(Listing, listed), "Invalid owned VM diagnostic inventory.");
		assert.ok(listed.length <= 3, "The native proof owns at most one command, proxy and browser VM.");
		for (const vm of listed) {
			const inspected: unknown = JSON.parse(runtime(["inspect", vm.name, "--format", "json"], 5_000));
			assert.ok(Value.Check(Owned, inspected), "Refusing diagnostics for an unowned VM.");
			assert.equal(inspected.name, vm.name);
			const captured = spawnSync(assets.msb, ["logs", "--source", "system", "--json", "--tail", "200", vm.name], {
				encoding: "utf8",
				env: runtimeEnv,
				timeout: 5_000,
				killSignal: "SIGKILL",
				maxBuffer: 1 << 20,
			});
			runtimeDiagnostics.push({
				name: vm.name,
				inspection: inspected,
				status: captured.status,
				signal: captured.signal,
				stdout: captured.stdout,
				stderr: captured.stderr,
				error: captured.error?.message,
			});
		}
	} catch (failure) {
		runtimeDiagnostics.push({ error: failure instanceof Error ? failure.stack : String(failure) });
	}
	await writeFile(
		join(output, "failure.json"),
		JSON.stringify(
			{
				passed: false,
				sourceCommit,
				releaseRoot: root,
				runtimeManifestSha256,
				publicBrowserDelivery,
				error: error instanceof Error ? error.stack : String(error),
				home,
				cache,
				hostBefore,
				hostAfter:
					process.platform === "linux"
						? await hostDiagnostics().catch((failure: unknown) => String(failure))
						: undefined,
				runtimeDiagnostics,
				diagnostics: await diagnostics?.().catch((failure: unknown) => String(failure)),
			},
			null,
			2,
		),
	).catch((failure: unknown) => log.push(`qualification: could not save failure diagnostics: ${String(failure)}`));
} finally {
	const cleanup = async (operation: () => unknown) => {
		try {
			await operation();
		} catch (error) {
			cleanupFailures.push(error);
		}
	};
	globalThis.fetch = nativeFetch;
	await cleanup(async () => {
		await daemon?.close();
		if (daemon !== undefined) assert.deepEqual(await daemon.stopped, { failed: false });
		assert.deepEqual(
			log.filter((line) => line.startsWith("close:")),
			[],
			"The owned daemons must close without failures.",
		);
	});
	await cleanup(async () => {
		const remaining = inventory();
		if (remaining.length > 0) {
			cleanupFailures.push(new Error("The owned daemon left VMs after closing."));
			for (const vm of remaining) await cleanup(() => runtime(["remove", "--force", vm.name]));
		}
		assert.deepEqual(inventory(), [], "Final owned VM inventory must be empty.");
	});
	await cleanup(releaseBrowser);
	await cleanup(() => writeFile(join(output, "daemon.log"), log.join("\n")));
	if (verification.state === "passed" && cleanupFailures.length === 0) {
		await cleanup(() => rm(cache, { recursive: true, force: true }));
		await cleanup(() => rm(home, { recursive: true, force: true }));
	}
	await cleanup(() =>
		writeFile(
			join(output, "cleanup.json"),
			JSON.stringify(
				{
					cleaned: cleanupFailures.length === 0,
					errors: cleanupFailures.map((error) => (error instanceof Error ? error.stack : String(error))),
				},
				null,
				2,
			),
		),
	);
}
if (cleanupFailures.length > 0)
	throw new AggregateError(
		verification.state === "failed" ? [verification.error, ...cleanupFailures] : cleanupFailures,
		"Native verification cleanup failed.",
	);
if (verification.state === "failed") throw verification.error;
assert.equal(verification.state, "passed");
await writeFile(
	join(output, "result.json"),
	JSON.stringify(
		{
			target: assets.target,
			sourceCommit,
			releaseRoot: root,
			runtimeManifestSha256,
			widths: [1440, 390],
			proxyRestarts,
			declinedPosts,
			browserDownloads: downloads,
			localArchiveDelivery: !publicBrowserDelivery,
			publicBrowserDelivery,
			browserUrl: assets.browser.url,
			command,
			readOnlyCommand,
			persistence: {
				state: "passed",
				daemonRestarts,
				folders: ["/workspace", "/work", "/tools"],
				readOnlyCheck: true,
				historyRetained: true,
				browserDownloadsAfterRestart: downloads,
			},
			cleaned: true,
			passed: true,
		},
		null,
		2,
	),
);
console.log(`Native computer verified on ${assets.target}; evidence: ${output}`);
