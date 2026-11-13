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
import { type Static, Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { nativeComputerReply } from "../test/fixtures/native-computer-model.ts";
import { BROWSERS, hold } from "../test/slots.ts";
import { hasChrome, withPage } from "../test/smoke/chrome.ts";
import { hostDiagnostics } from "./native-diagnostics.ts";

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
		labels: Type.Object({ "banda.home": Type.Literal(home), "banda.runtime": Type.Literal("microvm") }),
	}),
});
let proxyRestarts = 0;
let declinedPosts = 0;
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
const command = `set -eu
test "$PWD" = /workspace
test "$HOME" = /work
test "$(id -u)" = 1000
test ! -w /usr/bin
mkdir -p /tools/bin
printf '#!/bin/sh\\nprintf native-installed\\n' > /tools/bin/native-proof
chmod 755 /tools/bin/native-proof
test "$(native-proof)" = native-installed
curl --fail --silent --show-error --max-time 30 https://example.com/ | grep -q 'Example Domain'
if curl --noproxy '*' --silent --max-time 3 -k https://1.1.1.1 >/dev/null; then exit 1; fi
status=$(curl --silent --show-error --max-time 30 --output /tmp/native-held-response --write-out '%{http_code}' --data-binary banda-native-proof https://httpbingo.org/anything)
test "$status" = 403
test "$(cat /proc/sys/net/ipv6/conf/lo/disable_ipv6)" = 0
/bin/sh /banda/proxy-bridge.sh --check
printf native-computer-verified`;
const models = createModels();
const faux = fauxProvider({ tokensPerSecond: 10_000 });
models.setProvider(faux.provider);
faux.setResponses(Array.from({ length: 80 }, () => (request) => nativeComputerReply(request.messages, command)));
await writeFile(
	join(home, "config.json"),
	JSON.stringify({ model: { provider: "faux", modelId: "faux-1" }, remote: { reach: "off" } }),
);
let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
const log: string[] = [];
let completed = false;
let diagnostics: (() => Promise<unknown>) | undefined;
const releaseBrowser = await hold(BROWSERS);
try {
	daemon = await startDaemon({
		home,
		port: 0,
		models,
		boxKind: "microvm",
		web: join(app, "web/dist"),
		log: (line) => log.push(line),
	});
	const published: unknown = JSON.parse(await readFile(join(home, "daemon.json"), "utf8"));
	const Published = Type.Object({ token: Type.String() });
	assert.ok(Value.Check(Published, published));
	const origin = `http://127.0.0.1:${daemon.port}`;
	const headers = { authorization: `Bearer ${published.token}` };
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
			browser: Type.Object({ state: Type.String() }),
		}),
	});
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
		const response = await fetch(`${origin}/api/events`, { headers, signal: startup.signal });
		assert.ok(response.ok, `/events: ${response.status}: ${response.ok ? "" : await response.text()}`);
		assert.ok(response.body !== null, "Native computer readiness requires the shell event stream.");
		let buffer = "";
		ready: for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
			buffer += chunk;
			for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
				const frame = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				if (!frame.startsWith("data: ")) continue;
				const event: unknown = JSON.parse(frame.slice("data: ".length));
				if (!Value.Check(Event, event) || event.type !== "computer") continue;
				assert.ok(Value.Check(Computer, event), `Invalid native computer event: ${JSON.stringify(event)}`);
				computer = event.computer;
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
					break ready;
				}
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
				await page.until(
					`[...document.querySelectorAll('[data-message-bubble]:not([data-mine])')].some(el=>Number(el.closest('[data-entry]')?.getAttribute('data-entry')??0)>${after} && el.innerText.includes(${JSON.stringify(answer)}))`,
					120_000,
				);
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
					const settled = AbortSignal.timeout(30_000);
					for (;;) {
						settled.throwIfAborted();
						const now = await status();
						if (now.waits.length === 0 && now.chats.every((chat) => chat.state === "idle")) break;
						await delay(20, undefined, { signal: settled });
					}
					declinedPosts++;
				}
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
	completed = true;
} catch (error) {
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
				releaseRoot: root,
				runtimeManifestSha256,
				publicBrowserDelivery,
				error: error instanceof Error ? error.stack : String(error),
				home,
				cache,
				hostBefore,
				hostAfter: process.platform === "linux" ? await hostDiagnostics() : undefined,
				runtimeDiagnostics,
				diagnostics: await diagnostics?.().catch((failure: unknown) => String(failure)),
			},
			null,
			2,
		),
	);
	throw error;
} finally {
	await releaseBrowser();
	globalThis.fetch = nativeFetch;
	await daemon?.close();
	await writeFile(join(output, "daemon.log"), log.join("\n"));
	const listed: unknown = JSON.parse(
		execFileSync(assets.msb, ["list", "--format", "json"], {
			encoding: "utf8",
			env: {
				PATH: "/usr/bin:/bin",
				HOME: home,
				MSB_HOME: cache,
				MSB_PATH: assets.msb,
				MSB_LIBKRUNFW_PATH: assets.firmware,
			},
			timeout: 20_000,
		}),
	);
	assert.deepEqual(listed, []);
	if (completed) {
		await rm(cache, { recursive: true, force: true });
		await rm(home, { recursive: true, force: true });
	}
}
await writeFile(
	join(output, "result.json"),
	JSON.stringify(
		{
			target: assets.target,
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
			cleaned: true,
			passed: true,
		},
		null,
		2,
	),
);
console.log(`Native computer verified on ${assets.target}; evidence: ${output}`);
