/** Manual native release check, including public networking. Uses only an isolated home and the staged app. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { BROWSERS, hold } from "../test/slots.ts";
import { hasChrome, withPage } from "../test/smoke/chrome.ts";

const root = join(import.meta.dirname, "../release/banda");
const node = join(root, "node/node");
if ((await realpath(process.execPath)) !== (await realpath(node))) {
	const child = spawnSync(node, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
	process.exit(child.status ?? 1);
}
assert.ok(hasChrome(), "Native app verification requires Chrome (set CHROME to its executable).");
const output = process.argv[2] ?? (await mkdtemp(join(tmpdir(), "banda-native-evidence-")));
if (process.argv[2] !== undefined) await mkdir(output);
const app = join(root, "app");
const { startDaemon }: typeof import("../src/daemon.ts") = await import(
	pathToFileURL(join(app, "dist/daemon.js")).href
);
const { installedMicrovmAssets }: typeof import("../src/box/microvm-assets.ts") = await import(
	pathToFileURL(join(app, "dist/box/microvm-assets.js")).href
);
const {
	createModels,
	fauxProvider,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentTools,
}: typeof import("@earendil-works/pi-ai") = await import(
	pathToFileURL(join(app, "node_modules/@earendil-works/pi-ai/dist/index.js")).href
);
const assets = await installedMicrovmAssets();
const archive = join(root, "..", new URL(assets.browser.url).pathname.split("/").at(-1) ?? "missing-browser.tar");
const nativeFetch = globalThis.fetch;
let downloads = 0;
globalThis.fetch = (input, init) => {
	const url = input instanceof Request ? input.url : String(input);
	if (url !== assets.browser.url) return nativeFetch(input, init);
	downloads++;
	return Promise.resolve(
		new Response(Readable.toWeb(createReadStream(archive)), {
			headers: { "content-length": String(assets.browser.bytes) },
		}),
	);
};
const home = await realpath(await mkdtemp(join(tmpdir(), "banda-native-proof-")));
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
faux.setResponses(
	Array.from({ length: 80 }, () => (request) => {
		const previous = request.messages.at(-1);
		if (previous?.role === "toolResult" && previous.toolName === "message_user") return fauxAssistantMessage("Done.");
		if (previous?.role === "toolResult" && previous.toolName !== "tool_search") {
			assert.ok(!previous.isError, JSON.stringify(previous.content));
			return fauxAssistantMessage([fauxToolCall("message_user", { text: JSON.stringify(previous.content) })], {
				stopReason: "toolUse",
			});
		}
		const browse = JSON.stringify(
			request.messages.filter((message) => message.role === "user").at(-1)?.content,
		).includes("Browse");
		const tool = browse ? "browser_navigate" : "bash";
		const next = getCurrentTools(request.messages).some((offered) => offered.name === tool)
			? fauxToolCall(tool, browse ? { url: "https://example.com/" } : { command })
			: fauxToolCall("tool_search", { query: tool, limit: 1 });
		return fauxAssistantMessage([next], { stopReason: "toolUse" });
	}),
);
await writeFile(
	join(home, "config.json"),
	JSON.stringify({ model: { provider: "faux", modelId: "faux-1" }, remote: { enabled: false } }),
);
let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
const log: string[] = [];
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
	const api = async (path: string, body: object, method = "POST") => {
		const response = await fetch(`${origin}/api${path}`, {
			method,
			headers: { authorization: `Bearer ${published.token}`, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		assert.ok(response.ok, `${path}: ${response.status}`);
	};
	await api("/skills/shipped", { add: [] });
	await api("/companion", { name: "Sancho", personality: "Brief." }, "PUT");
	for (const width of [1440, 390]) {
		await withPage(`${origin}/#token=${published.token}`, { width, height: 900 }, async (page) => {
			await page.until("!location.hash.includes('token=') && document.body.innerText.length > 0");
			await page.run("location.hash='#/a/sancho'");
			for (const [text, answer] of [
				["Check the computer.", "native-computer-verified"],
				["Browse the example page.", "Example Domain"],
			]) {
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
				}
			}
			await page.shoot(join(output, `computer-${width}.png`));
			assert.deepEqual(page.errors(), []);
		});
	}
	assert.equal(downloads, 1);
} finally {
	await releaseBrowser();
	globalThis.fetch = nativeFetch;
	await daemon?.close();
	await writeFile(join(output, "daemon.log"), log.join("\n"));
	const cache = join(
		process.platform === "darwin" ? "/private/tmp" : "/tmp",
		`banda-msb-${process.getuid?.() ?? 0}-${createHash("sha256").update(home).digest("hex").slice(0, 16)}`,
	);
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
	await rm(cache, { recursive: true, force: true });
	await rm(home, { recursive: true, force: true });
}
await writeFile(
	join(output, "result.json"),
	JSON.stringify(
		{
			target: assets.target,
			widths: [1440, 390],
			browserDownloads: downloads,
			localArchiveDelivery: true,
			command,
			cleaned: true,
			passed: true,
		},
		null,
		2,
	),
);
console.log(`Native computer verified on ${assets.target}; evidence: ${output}`);
