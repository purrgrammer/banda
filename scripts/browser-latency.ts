/**
 * Manual measurement of the owner's typing, clicks and Enter in a taken-over browser, on the bundled computer (a
 * throwaway home, the faux provider, the real VMs): where the time goes between an input and the frame that shows it. It speaks the app's own HTTP
 * API and browser stream, and stamps the daemon's side from outside (the request's arrival, each DevTools command and
 * its answer, each screencast frame, each run of the VM runtime's program), so it measures the code as it ships.
 *
 *   <staged node> scripts/browser-latency.ts [label]
 *
 * It needs `computer/` (AGENTS.md), the built web app (`npm run build:web`), Chrome, the network (the page it types
 * into is public: BANDA_LATENCY_PAGE) and the browser's archive in `release/` or at BANDA_BROWSER_ARCHIVE. The report
 * and the last pictures go to BANDA_LATENCY_OUT. Rows counting runs or bytes print "ms" like the rest: read the name.
 * BANDA_LATENCY_ONLY=sends measures the clicks and Enter alone (G, H). BANDA_LATENCY_STOP=1 ends with the proof that a
 * lost proxy is still repaired (I): the proxy's VM is stopped as scripts/verify-computer.ts stops it (then its process
 * alone is killed), typing then runs nothing and starts nothing, the next click brings the proxy back, and a form's
 * POST goes out as the owner's.
 */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentTools,
	type Message,
} from "@earendil-works/pi-ai";

const label = process.argv[2] ?? "run";
const out = process.env.BANDA_LATENCY_OUT ?? tmpdir();
const PAGE = process.env.BANDA_LATENCY_PAGE ?? "https://httpbingo.org/forms/post";
const now = () => performance.timeOrigin + performance.now();

// ---- the daemon's side, stamped from outside ----
type Stamp = { readonly at: number; readonly what: string; readonly ms?: number };
const stamps: Stamp[] = [];
const realExecFile = childProcess.execFile;
// biome-ignore lint/suspicious/noExplicitAny: a pass-through wrapper
(childProcess as any).execFile = (file: string, args: readonly string[], ...rest: any[]) => {
	const started = now();
	// a command run in a VM is named by what it runs there
	const guest = args[0] === "exec" ? args.slice(args.indexOf("--") + 1).map((arg) => arg.split("/").at(-1)) : [];
	const what = `msb ${(guest.length > 0 ? ["exec", ...guest.slice(0, 3)] : args.slice(0, 2)).join(" ")}`;
	const callback = rest.at(-1);
	if (typeof callback === "function")
		// biome-ignore lint/suspicious/noExplicitAny: a pass-through wrapper
		rest[rest.length - 1] = (...result: any[]) => {
			stamps.push({ at: started, what, ms: now() - started });
			callback(...result);
		};
	// biome-ignore lint/suspicious/noExplicitAny: a pass-through wrapper
	return (realExecFile as any)(file, args, ...rest);
};
syncBuiltinESMExports();
const realEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function (this: http.Server, event: string, ...args: unknown[]) {
	if (event === "request") {
		const request = args[0] as http.IncomingMessage;
		if (request.url?.endsWith("/browser/input")) stamps.push({ at: now(), what: "http input" });
	}
	// biome-ignore lint/suspicious/noExplicitAny: a pass-through wrapper
	return (realEmit as any).call(this, event, ...args);
} as typeof realEmit;

const { Cdp } = await import("../src/box/cdp.ts");
const realSend = Cdp.prototype.send;
/** The page's DevTools session, as the daemon last put an input to it: the script asks it where things are. */
let pageSession: { cdp: InstanceType<typeof Cdp>; id: string } | undefined;
Cdp.prototype.send = function (this: InstanceType<typeof Cdp>, method: string, ...rest: unknown[]) {
	const started = now();
	if (method.startsWith("Input.") && typeof rest[1] === "string") pageSession = { cdp: this, id: rest[1] };
	// biome-ignore lint/suspicious/noExplicitAny: a pass-through wrapper
	const sent = (realSend as any).call(this, method, ...rest) as Promise<unknown>;
	const done = () => stamps.push({ at: started, what: `cdp ${method}`, ms: now() - started });
	sent.then(done, done);
	return sent;
} as typeof realSend;
const realOn = Cdp.prototype.on;
Cdp.prototype.on = function (this: InstanceType<typeof Cdp>, listener: Parameters<typeof realOn>[0]) {
	return realOn.call(this, (event) => {
		if (event.method === "Page.screencastFrame")
			stamps.push({ at: now(), what: "frame", ms: (event.params.data as string).length });
		listener(event);
	});
};

const { startDaemon } = await import("../src/daemon.ts");
const { installedMicrovmAssets } = await import("../src/box/microvm-assets.ts");
const assets = await installedMicrovmAssets();
const archive =
	process.env.BANDA_BROWSER_ARCHIVE ??
	join(import.meta.dirname, "../release", new URL(assets.browser.url).pathname.split("/").at(-1) ?? "");
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
	const url = input instanceof Request ? input.url : String(input);
	if (url !== assets.browser.url) return nativeFetch(input, init);
	return Promise.resolve(
		new Response(Readable.toWeb(createReadStream(archive)) as ReadableStream, {
			headers: { "content-length": String(assets.browser.bytes) },
		}),
	);
};

const models = createModels();
const faux = fauxProvider({ tokensPerSecond: 10_000 });
models.setProvider(faux.provider);
faux.setResponses(
	Array.from({ length: 40 }, () => (request: { messages: Message[] }) => {
		const previous = request.messages.at(-1);
		if (previous?.role === "toolResult" && previous.toolName === "message_user") return fauxAssistantMessage("Done.");
		if (previous?.role === "toolResult" && previous.toolName !== "tool_search")
			return fauxAssistantMessage([fauxToolCall("message_user", { text: "Opened." })], { stopReason: "toolUse" });
		const next = getCurrentTools(request.messages).some((offered) => offered.name === "browser_navigate")
			? fauxToolCall("browser_navigate", { url: PAGE })
			: fauxToolCall("tool_search", { query: "browser_navigate", limit: 1 });
		return fauxAssistantMessage([next], { stopReason: "toolUse" });
	}),
);

const home = await realpath(await mkdtemp(join(tmpdir(), "banda-latency-")));
await writeFile(
	join(home, "config.json"),
	JSON.stringify({ model: { provider: "faux", modelId: "faux-1" }, remote: { reach: "off" } }),
);
const log: string[] = [];
const web = process.env.BANDA_LATENCY_WEB ?? join(import.meta.dirname, "../web/dist");
const daemon = await startDaemon({ home, port: 0, models, boxKind: "microvm", web, log: (line) => log.push(line) });
const quantile = (values: readonly number[], q: number) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
};
const row = (name: string, values: readonly number[]) =>
	`${name.padEnd(46)} n=${String(values.length).padStart(3)}  median ${quantile(values, 0.5).toFixed(1).padStart(8)} ms  p90 ${quantile(values, 0.9).toFixed(1).padStart(8)} ms  max ${Math.max(
		...values,
	)
		.toFixed(1)
		.padStart(8)} ms`;
const report: string[] = [];
const say = (line: string) => {
	report.push(line);
	console.log(line);
};
try {
	const { token } = JSON.parse(await (await import("node:fs/promises")).readFile(join(home, "daemon.json"), "utf8"));
	const origin = `http://127.0.0.1:${daemon.port}`;
	const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
	const api = async (path: string, body?: object, method = "POST") => {
		const response = await nativeFetch(`${origin}/api${path}`, {
			method,
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const text = await response.text();
		assert.ok(response.ok, `${path}: ${response.status}: ${text}`);
		return JSON.parse(text);
	};
	const sse = async (path: string, onEvent: (event: Record<string, unknown>) => void, signal: AbortSignal) => {
		const response = await nativeFetch(`${origin}/api${path}`, { headers, signal });
		assert.ok(response.ok && response.body !== null, `${path}: ${response.status}`);
		let buffer = "";
		try {
			for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
				buffer += chunk;
				for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
					const frame = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					if (frame.startsWith("data: ")) onEvent(JSON.parse(frame.slice(6)));
				}
			}
		} catch (error) {
			if (!signal.aborted) throw error;
		}
	};
	const stop = new AbortController();
	// the computer up
	await new Promise<void>((resolve, reject) => {
		const up = new AbortController();
		const timer = setTimeout(() => reject(new Error(`computer not up: ${log.slice(-5).join(" | ")}`)), 180_000);
		void sse(
			"/events",
			(event) => {
				const computer = event.computer as { state?: string; why?: string } | undefined;
				if (event.type !== "computer" || computer === undefined) return;
				if (computer.state === "offline") reject(new Error(`computer offline: ${computer.why}`));
				if (computer.state === "up") {
					clearTimeout(timer);
					up.abort();
					resolve();
				}
			},
			up.signal,
		).catch(reject);
	});
	console.log("computer up");
	await api("/companion", { name: "Sancho", personality: "Brief." }, "PUT");
	const posted = await api("/messages", { id: randomUUID(), thread: "main", text: "Open the form." });
	const chat = posted.chat as number;
	assert.ok(Number.isSafeInteger(chat), JSON.stringify(posted));
	// the browser's stream, as the app reads it
	const clientFrames: { at: number; bytes: number; data: string }[] = [];
	let view: { running?: boolean; control?: string; url?: string } = {};
	void sse(
		`/chats/${chat}/browser`,
		(event) => {
			if (event.type === "state") view = event.view as typeof view;
			else clientFrames.push({ at: now(), bytes: (event.data as string).length, data: event.data as string });
		},
		stop.signal,
	).catch((error) => console.error("browser stream:", error));
	const until = async (what: string, check: () => boolean | Promise<boolean>, ms = 300_000) => {
		const deadline = Date.now() + ms;
		while (!(await check())) {
			if (Date.now() > deadline) throw new Error(`timed out: ${what}; ${log.slice(-8).join(" | ")}`);
			await delay(50);
		}
	};
	await until("the page open", () => view.running === true && (view.url ?? "").startsWith("http"));
	await until("the run idle", async () =>
		((await api("/status", undefined, "GET")).chats as { state: string }[]).every((each) => each.state === "idle"),
	);
	console.log(`page open: ${view.url}`);
	await until("a frame", () => clientFrames.length > 0, 30_000);
	await api(`/chats/${chat}/browser/control`, { hold: true });
	await until("control", () => view.control === "owner", 10_000);

	type Sample = {
		t0: number;
		t1?: number;
		t2?: number;
		t3?: number;
		t4?: number;
		t5?: number;
		done?: number;
		msb: number;
		msbMs: number;
		cdp: string[];
	};
	const input = (body: object) => api(`/chats/${chat}/browser/input`, body);
	/** One input, sent as the app sends it; its stamps filled in from what the daemon did while it was in flight. */
	const measured = async (body: object, t0 = now()): Promise<Sample> => {
		const sent = now();
		await input(body);
		const done = now();
		const during = stamps.filter((stamp) => stamp.at >= sent && stamp.at <= done);
		const act = during.find((stamp) => /^cdp Input\./.test(stamp.what));
		const sample: Sample = {
			t0,
			done,
			msb: during.filter((stamp) => stamp.what.startsWith("msb")).length,
			msbMs: during.filter((stamp) => stamp.what.startsWith("msb")).reduce((sum, stamp) => sum + (stamp.ms ?? 0), 0),
			cdp: during.filter((stamp) => stamp.what.startsWith("cdp")).map((stamp) => stamp.what.slice(4)),
		};
		const received = during.find((stamp) => stamp.what === "http input");
		if (received !== undefined) sample.t1 = received.at;
		if (act !== undefined) {
			sample.t2 = act.at;
			sample.t3 = act.at + (act.ms ?? 0);
		}
		return sample;
	};
	/** The frame that shows an input: the first the daemon got after the command went, and when the client had it. */
	const framed = async (sample: Sample) => {
		const from = sample.t2 ?? sample.t0;
		await until(
			"the frame after a key",
			() => stamps.some((stamp) => stamp.what === "frame" && stamp.at > from),
			5_000,
		).catch(() => undefined);
		const frame = stamps.find((stamp) => stamp.what === "frame" && stamp.at > from);
		if (frame === undefined) return;
		sample.t4 = frame.at;
		await until("the frame at the client", () => clientFrames.some((each) => each.at >= frame.at), 2_000).catch(
			() => undefined,
		);
		sample.t5 = clientFrames.find((each) => each.at >= frame.at)?.at;
	};
	const table = (title: string, samples: readonly Sample[]) => {
		say(`\n## ${title}`);
		const segment = (name: string, from: keyof Sample, to: keyof Sample) => {
			const values = samples.flatMap((sample) =>
				typeof sample[from] === "number" && typeof sample[to] === "number"
					? [(sample[to] as number) - (sample[from] as number)]
					: [],
			);
			if (values.length > 0) say(row(name, values));
		};
		segment("T0->T1 key sent -> daemon has the request", "t0", "t1");
		segment("T1->T2 request -> DevTools command sent", "t1", "t2");
		segment("T2->T3 DevTools command -> its answer", "t2", "t3");
		segment("T3->T4 answer -> next frame at the daemon", "t3", "t4");
		segment("T2->T4 command sent -> next frame at daemon", "t2", "t4");
		segment("T4->T5 frame at daemon -> at the client", "t4", "t5");
		segment("T0->done key -> its POST answered", "t0", "done");
		segment("T0->T5 key -> frame at the client (total)", "t0", "t5");
		say(
			row(
				"runs of the VM runtime's program per input",
				samples.map((sample) => sample.msb),
			),
		);
		say(
			row(
				"time in them per input",
				samples.map((sample) => sample.msbMs),
			),
		);
		say(`DevTools commands of the last input: ${samples.at(-1)?.cdp.join(", ")}`);
	};

	// focus the first field, then let the page rest
	await measured({ type: "key", key: "Tab" });
	await delay(1500);
	const frameBytes = clientFrames.map((frame) => frame.bytes);
	say(`# ${label}: ${PAGE}`);
	say(row("frame size, base64 bytes", frameBytes));
	const full = process.env.BANDA_LATENCY_ONLY !== "sends";
	/** Where one of the page's elements is, asked of the page itself (outside what is measured). */
	const where = async (selector: string) => {
		assert.ok(pageSession !== undefined, "no input reached the page yet");
		const answered = (await realSend.call(
			pageSession.cdp,
			"Runtime.evaluate",
			{
				expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: "center" }); const b = el.getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); })()`,
				returnByValue: true,
			},
			pageSession.id,
		)) as { result: { value?: string | null } };
		assert.ok(typeof answered.result.value === "string", `${selector} is not on ${PAGE}`);
		return JSON.parse(answered.result.value) as { x: number; y: number };
	};
	/** A click as the app sends it: a press, then its release; the sample is the release's, from the press. */
	const click = async (at: { x: number; y: number }) => {
		const pressed = now();
		const down = await measured({ type: "mouse", action: "down", ...at, button: "left" }, pressed);
		const up = await measured({ type: "mouse", action: "up", ...at, button: "left" }, pressed);
		up.msb += down.msb;
		up.msbMs += down.msbMs;
		up.cdp = [...down.cdp, ...up.cdp];
		return up;
	};
	const sending = (title: string, samples: readonly Sample[]) => {
		say(`\n## ${title}`);
		const spans = (to: "done" | "t5") =>
			samples.flatMap((sample) => (typeof sample[to] === "number" ? [(sample[to] as number) - sample.t0] : []));
		say(row("input -> its (last) POST answered", spans("done")));
		say(row("input -> next frame at the client (total)", spans("t5")));
		say(
			row(
				"runs of the VM runtime's program per input",
				samples.map((sample) => sample.msb),
			),
		);
		say(
			row(
				"time in them per input",
				samples.map((sample) => sample.msbMs),
			),
		);
		say(`DevTools commands of the last input: ${samples.at(-1)?.cdp.join(", ")}`);
	};

	if (full) {
		// A. one key at a time, the page at rest between them
		const alone: Sample[] = [];
		for (let i = 0; i < 30; i++) {
			const sample = await measured({ type: "text", text: "abcdefghij"[i % 10] ?? "a" });
			await framed(sample);
			alone.push(sample);
			await delay(600);
		}
		table("A. 30 keys, one at a time (600 ms apart)", alone);
		say(`first key's DevTools commands: ${alone[0]?.cdp.join(", ")}`);

		/** Keys pressed every `gap` ms, sent one after another as the app's queue sends them. */
		const typing = async (count: number, gap: number) => {
			const samples: Promise<Sample>[] = [];
			let queue: Promise<unknown> = Promise.resolve();
			const started = now();
			for (let i = 0; i < count; i++) {
				const pressed = now();
				const body = { type: "text", text: "0123456789"[i % 10] ?? "0" };
				const next = queue.then(() => measured(body, pressed));
				queue = next.catch(() => undefined);
				samples.push(next);
				if (gap > 0) await delay(gap);
			}
			const all = await Promise.all(samples);
			const took = now() - started;
			for (const sample of all) {
				const frame = stamps.find((stamp) => stamp.what === "frame" && stamp.at > (sample.t2 ?? sample.t0));
				if (frame !== undefined) sample.t4 = frame.at;
			}
			await delay(800);
			for (const sample of all) {
				if (sample.t4 === undefined) await framed(sample);
				else sample.t5 = clientFrames.find((each) => each.at >= (sample.t4 ?? 0))?.at;
			}
			return { all, took };
		};
		// B. typing at a steady pace
		await delay(1000);
		const paced = await typing(30, 120);
		table("B. 30 keys typed 120 ms apart (queued as the app queues them)", paced.all);
		say(`the last key's POST answered ${(paced.took - 29 * 120).toFixed(0)} ms after it was pressed`);
		// C. a burst
		await delay(1000);
		const burst = await typing(20, 0);
		table("C. 20 keys at once (a burst)", burst.all);
		say(`burst of 20 took ${burst.took.toFixed(0)} ms from first key to last POST answered`);
		// D. the pointer hovering
		await delay(1000);
		const moves: Sample[] = [];
		for (let i = 0; i < 30; i++) {
			moves.push(await measured({ type: "mouse", action: "move", x: 300 + i * 5, y: 500 }));
			await delay(80);
		}
		table("D. 30 pointer moves (80 ms apart)", moves);
		// E. clicks on nothing, as the app sends them: a press, then its release
		const clicks: Sample[] = [];
		for (let i = 0; i < 10; i++) {
			const pressed = now();
			await measured({ type: "mouse", action: "down", x: 900, y: 700, button: "left" }, pressed);
			const released = await measured({ type: "mouse", action: "up", x: 900, y: 700, button: "left" }, pressed);
			clicks.push(released);
			await delay(300);
		}
		say("\n## E. 10 clicks (press + release)");
		say(
			row(
				"press -> its release's POST answered",
				clicks.map((sample) => (sample.done ?? 0) - sample.t0),
			),
		);
		const one = stamps.filter((stamp) => stamp.what.startsWith("msb")).slice(-10);
		say(
			`the VM runtime's runs of one repair: ${one.map((stamp) => `${stamp.what.slice(4)} ${stamp.ms?.toFixed(0)}ms`).join(", ")}`,
		);
	}

	// G. clicks that change the picture (a checkbox ticked and unticked): press -> release -> the frame that shows it
	const box = await where("input[type=checkbox]");
	const ticks: Sample[] = [];
	for (let i = 0; i < 30; i++) {
		const sample = await click(box);
		await framed(sample);
		ticks.push(sample);
		await delay(400);
	}
	sending("G. 30 clicks on a checkbox (press + release, 400 ms apart)", ticks);
	// H. Enter in a text area (a new line, nothing submitted): the key -> the frame that shows it
	await click(await where("textarea"));
	await delay(600);
	const enters: Sample[] = [];
	for (let i = 0; i < 30; i++) {
		const sample = await measured({ type: "key", key: "Enter" });
		await framed(sample);
		enters.push(sample);
		await delay(400);
	}
	sending("H. 30 Enter keys in a text area (400 ms apart)", enters);

	// I. the proof that a lost proxy is still repaired before anything is sent
	if (process.env.BANDA_LATENCY_STOP !== undefined) {
		const cache = join(
			process.platform === "darwin" ? "/private/tmp" : "/tmp",
			`banda-msb-${process.getuid?.() ?? 0}-${createHash("sha256").update(home).digest("hex").slice(0, 16)}`,
		);
		const runtime = (args: readonly string[]) =>
			childProcess.execFileSync(assets.msb, [...args], {
				encoding: "utf8",
				env: {
					PATH: "/usr/bin:/bin",
					HOME: home,
					MSB_HOME: cache,
					MSB_PATH: assets.msb,
					MSB_LIBKRUNFW_PATH: assets.firmware,
				},
				timeout: 30_000,
				killSignal: "SIGKILL",
				stdio: ["ignore", "pipe", "pipe"],
			});
		/** This home's proxy VM, and no other's. */
		const proxy = () => {
			const listed = JSON.parse(runtime(["list", "--format", "json"])) as { name: string }[];
			const found = listed.filter((vm) => vm.name.endsWith("-proxy"));
			assert.equal(found.length, 1, "this home owns one proxy VM");
			const vm = JSON.parse(runtime(["inspect", found[0]?.name ?? "", "--format", "json"])) as {
				name: string;
				status: string;
				config: { labels: Record<string, string> };
			};
			assert.equal(vm.config.labels["banda.home"], home, "refusing a VM of another home");
			return vm;
		};
		const listening = (name: string) =>
			runtime(["exec", "--require-running", "--user", "1000:1000", name, "--", "python3", "/banda/ctl.py", "ping"])
				.trim()
				.split("\n")
				.at(-1);
		const runs = () => stamps.filter((stamp) => stamp.what.startsWith("msb"));
		const field = await where("input:not([type=checkbox]):not([type=radio])");
		say("\n## I. the proxy lost, then typing, then a click");
		for (const how of ["vm", "process"]) {
			const before = proxy();
			assert.equal(before.status, "Running");
			const well = await click(field);
			say(`[${how}] a click while all is well: ${well.msb} runs of the runtime`);
			if (how === "vm") runtime(["stop", before.name]);
			else
				runtime([
					"exec",
					"--require-running",
					"--user",
					"1000:1000",
					before.name,
					"--",
					"/usr/local/bin/python3",
					"-c",
					"import os, signal\nfor p in os.listdir('/proc'):\n    try:\n        if p.isdigit() and int(p) != os.getpid() and b'mitmdump' in open(f'/proc/{p}/cmdline', 'rb').read():\n            os.kill(int(p), signal.SIGKILL)\n    except OSError:\n        pass",
				]);
			const lost = now();
			const gone = () => (how === "vm" ? `its VM is ${proxy().status}` : `it answers ${listening(before.name)}`);
			say(`[${how}] the proxy ${how === "vm" ? "VM was stopped" : "process was killed"}: ${gone()}`);
			await delay(Number(process.env.BANDA_LATENCY_STOP_WAIT ?? 300));
			const from = runs().length;
			for (const text of "lost") await measured({ type: "text", text });
			await measured({ type: "key", key: "Tab" });
			await measured({ type: "mouse", action: "move", x: 300, y: 300 });
			const during = runs().slice(from);
			say(
				`[${how}] 4 characters, a Tab and a pointer move with the proxy gone: ${during.length} runs of the runtime; ${gone()}`,
			);
			assert.equal(during.length, 0, "typing ran the runtime");
			if (how === "vm") assert.equal(proxy().status, "Stopped", "typing started the proxy");
			else assert.equal(listening(before.name), '{"up": false}', "typing started the proxy");
			const repairing = await click(box);
			const repair = runs().slice(from);
			say(
				`[${how}] the click ${(repairing.t0 - lost).toFixed(0)} ms after the loss took ${((repairing.done ?? 0) - repairing.t0).toFixed(0)} ms and repaired: ${repair.length} runs (${repair.map((stamp) => `${stamp.what.slice(4)} ${stamp.ms?.toFixed(0)}ms`).join(", ")})`,
			);
			assert.ok(repair.length >= 10, "the click after the loss ran the whole repair");
			assert.ok(
				repair.some((stamp) => stamp.what.startsWith(how === "vm" ? "msb start " : "msb exec ")),
				"the repair brought the proxy back",
			);
			const after = proxy();
			assert.equal(after.name, before.name);
			assert.equal(after.status, "Running");
			assert.equal(listening(after.name), '{"up": true}');
			const again = await click(box);
			say(`[${how}] the proxy is back (${listening(after.name)}); the next click: ${again.msb} runs of the runtime`);
		}
		// the form's POST goes out only through a proxy that was told the owner holds this tab
		const submitted = now();
		await click(field);
		await measured({ type: "key", key: "Enter" });
		await until("the form posted", () => new URL(view.url ?? PAGE).pathname !== new URL(PAGE).pathname, 30_000);
		say(
			`the form's POST went out as the owner's after the repairs: ${view.url} (${(now() - submitted).toFixed(0)} ms)`,
		);
	}

	// F. through the app itself, in Chrome: real key events on the page's picture, to the paint that shows them
	if (full && process.env.BANDA_LATENCY_APP !== "0") {
		const { withPage } = await import("../test/smoke/chrome.ts");
		// the field again: the clicks took the focus from it
		await measured({ type: "key", key: "Tab" });
		for (const width of [1440, 390]) {
			await withPage(`${origin}/#token=${token}`, { width, height: 900 }, async (page) => {
				await page.until("!location.hash.includes('token=') && document.body.innerText.length > 0");
				await page.run("location.hash='#/a/sancho'");
				const open = "[...document.querySelectorAll('button')].find(el => el.textContent.trim() === 'Open')";
				await page.until(open, 30_000);
				await page.click(open);
				const screen = 'document.querySelector(\'[aria-roledescription="remote page"][tabindex="0"]\')';
				await page.until(`${screen}?.querySelector('img')`, 30_000);
				await page.run(`(() => {
					const el = ${screen};
					const at = () => performance.timeOrigin + performance.now();
					window.__lat = { keys: [], paints: [] };
					el.addEventListener('keydown', () => window.__lat.keys.push(at()), true);
					new MutationObserver(() => {
						const set = at();
						const img = el.querySelector('img');
						const decoded = img === null ? Promise.resolve() : img.decode().catch(() => undefined);
						decoded.then(() => { const ready = at(); requestAnimationFrame(() => window.__lat.paints.push({ set, ready, painted: at() })); });
					}).observe(el, { subtree: true, attributes: true, attributeFilter: ['src'] });
					el.focus();
				})()`);
				const press = async (key: string) => {
					await page.input("Input.dispatchKeyEvent", { type: "keyDown", key, text: key, unmodifiedText: key });
					await page.input("Input.dispatchKeyEvent", { type: "keyUp", key });
				};
				const run = async (title: string, count: number, gap: number) => {
					await delay(1200);
					await page.run("window.__lat.keys.length = 0; window.__lat.paints.length = 0; 0");
					const from = now();
					for (let i = 0; i < count; i++) {
						await press("klmnopqrst"[i % 10] ?? "k");
						if (gap > 0) await delay(gap);
					}
					await until(
						"every key sent to the page",
						() => stamps.filter((stamp) => stamp.at > from && stamp.what === "cdp Input.insertText").length >= count,
						60_000,
					);
					await delay(1200);
					const seen = await page.run<{ keys: number[]; paints: { set: number; ready: number; painted: number }[] }>(
						"window.__lat",
					);
					const acts = stamps.filter((stamp) => stamp.at > from && stamp.what === "cdp Input.insertText");
					const requests = stamps.filter((stamp) => stamp.at > from && stamp.what === "http input");
					const frames = stamps.filter((stamp) => stamp.what === "frame");
					assert.equal(seen.keys.length, count);
					const rows: Record<string, number[]> = {};
					const add = (name: string, value: number | undefined) => {
						if (value === undefined || !Number.isFinite(value)) return;
						const values = rows[name] ?? [];
						rows[name] = values;
						values.push(value);
					};
					seen.keys.forEach((key, i) => {
						const act = acts[i];
						const request = requests[i];
						if (act === undefined) return;
						const frame = frames.find((each) => each.at > act.at);
						const paint = frame === undefined ? undefined : seen.paints.find((each) => each.set >= frame.at - 2);
						add("T0->T1 keydown -> daemon has the request", request === undefined ? undefined : request.at - key);
						add("T1->T2 request -> DevTools command sent", request === undefined ? undefined : act.at - request.at);
						add("T2->T3 DevTools command -> its answer", act.ms);
						add(
							"T3->T4 answer -> next frame at the daemon",
							frame === undefined ? undefined : frame.at - act.at - (act.ms ?? 0),
						);
						add(
							"T4->T5 frame at daemon -> set on the image",
							paint === undefined || frame === undefined ? undefined : paint.set - frame.at,
						);
						add("T5->T6 set -> decoded and painted", paint === undefined ? undefined : paint.painted - paint.set);
						add("T0->T6 keydown -> painted (total)", paint === undefined ? undefined : paint.painted - key);
					});
					say(`\n## F. in the app at ${width}px: ${title}`);
					for (const [name, values] of Object.entries(rows)) say(row(name, values));
				};
				await run("30 keys, one at a time (600 ms apart)", 30, 600);
				await run("30 keys typed 120 ms apart", 30, 120);
				await run("20 keys at once (a burst)", 20, 0);
				await page.shoot(join(out, `browser-latency-${label}-app-${width}.png`));
				assert.deepEqual(page.errors(), []);
			});
		}
	}
	await delay(1000);
	const last = clientFrames.at(-1);
	if (last !== undefined) await writeFile(join(out, `browser-latency-${label}.jpg`), Buffer.from(last.data, "base64"));
	const gaps = stamps
		.filter((stamp) => stamp.what === "frame")
		.map((stamp, index, all) => stamp.at - (all[index - 1]?.at ?? stamp.at))
		.slice(1);
	say(row("\ngap between frames at the daemon (whole run)", gaps));
	await writeFile(join(out, `browser-latency-${label}.txt`), `${report.join("\n")}\n`);
	await api(`/chats/${chat}/browser/control`, { hold: false }).catch(() => undefined);
	stop.abort();
} catch (error) {
	console.error(error);
	console.error(log.slice(-30).join("\n"));
	process.exitCode = 1;
} finally {
	globalThis.fetch = nativeFetch;
	await daemon.close();
	await daemon.stopped;
	await rm(home, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
