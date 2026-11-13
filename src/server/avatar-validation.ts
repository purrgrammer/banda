import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { AvatarDefinition } from "open-bot-avatar";
import { refuseUnbounded } from "../core/avatar-geometry.ts";

export type AvatarValidation = { ok: true; definition: AvatarDefinition } | { ok: false; errors: string[] };

// An eval worker resolves a bare specifier from the process's working directory, which is `/` in the desktop app.
const OPEN_BOT_AVATAR = pathToFileURL(createRequire(import.meta.url).resolve("open-bot-avatar")).href;

// Fixed worker code: only JSON data crosses into it. Geometry validation can be CPU intensive even within the
// library's limits, so it must not block the daemon's event loop or run beyond the caller's deadline.
const VALIDATOR = `
const { parentPort, workerData } = require("node:worker_threads");
import(workerData.validator).then(({ validateAvatar }) => {
  const result = validateAvatar(JSON.parse(workerData.text));
  parentPort.postMessage(result.ok ? { ok: true, definition: result.value } : { ok: false, errors: result.errors });
}, (error) => parentPort.postMessage({ broken: String(error) })).catch(() => parentPort.postMessage({ ok: false, errors: ["Face validation failed."] }));
`;

/** Across all callers, at most two geometry validators run and at most sixteen wait. */
export const AVATAR_VALIDATORS = 2;
export const AVATAR_VALIDATION_QUEUE = 16;
type Waiting = { readonly start: () => void };
const waiting: Waiting[] = [];
let running = 0;

function drain(): void {
	while (running < AVATAR_VALIDATORS && waiting.length > 0) waiting.shift()?.start();
}

/** Validate untrusted geometry off the event loop, with bounded input, concurrency, memory and elapsed time. */
export async function validateAvatarCandidate(
	text: string,
	timeoutMs = 2_000,
	validator = OPEN_BOT_AVATAR,
): Promise<AvatarValidation> {
	if (text.length > 16_384 || new TextEncoder().encode(text).byteLength > 16_384)
		return { ok: false, errors: ["The face definition is too large (16 KB maximum)."] };
	let input: unknown;
	try {
		input = JSON.parse(text);
	} catch {
		return { ok: false, errors: ["A face must be a JSON object."] };
	}
	// The same bounds as reading a face, so a candidate the worker passes is one an agent file can hold.
	const refused = refuseUnbounded(input);
	if (refused) return refused;
	if (running >= AVATAR_VALIDATORS && waiting.length >= AVATAR_VALIDATION_QUEUE)
		return { ok: false, errors: ["Face validation is busy. Try again."] };
	return new Promise((resolve) => {
		let done = false;
		let worker: Worker | undefined;
		const entry: Waiting = {
			start: () => {
				running++;
				try {
					worker = new Worker(VALIDATOR, {
						eval: true,
						workerData: { text, validator },
						resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
					});
					worker.once("message", (result: AvatarValidation | { broken: string }) => {
						if (!("broken" in result)) return finish(result);
						console.error(`face validator did not load: ${result.broken}`);
						finish({
							ok: false,
							errors: ["banda's face validator did not load. Do not change the face; tell the owner."],
						});
					});
					worker.once("error", () => finish({ ok: false, errors: ["Face validation failed."] }));
					worker.once("exit", () => finish({ ok: false, errors: ["Face validation stopped."] }));
				} catch {
					running--;
					finish({ ok: false, errors: ["Face validation failed."] });
					drain();
				}
			},
		};
		const finish = (result: AvatarValidation) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			const index = waiting.indexOf(entry);
			if (index !== -1) waiting.splice(index, 1);
			if (worker !== undefined) {
				// Hold the slot until the thread really stops, including after timeout.
				const released = () => {
					running--;
					drain();
				};
				void worker.terminate().then(released, released);
			} else drain();
			resolve(result);
		};
		// The deadline includes time spent waiting for a worker, not just validation time.
		const timer = setTimeout(() => finish({ ok: false, errors: ["Face validation took too long."] }), timeoutMs);
		waiting.push(entry);
		drain();
	});
}
