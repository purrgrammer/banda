/**
 * The process the devices fault suite kills, through the routes the daemon serves (`src/server/devices.ts`): the owner
 * makes an invite and keeps the secret it was shown; a phone presents it and waits; another endpoint presents the same
 * secret; the owner approves the phone, makes a second invite, a tablet presents it and the owner denies it; then the
 * owner revokes the phone. Each step is retried after a restart as a person would, from what they saw: the owner
 * keeps a secret only once its invite was answered, and an approval or a denial is asked again until it was answered.
 *
 * argv: home, fault schedule JSON (Fault[])
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { Devices } from "../../src/core/devices.ts";
import { context, openStore } from "../../src/core/store.ts";
import type { InviteView } from "../../src/server/api.ts";
import { openDevices } from "../../src/server/devices.ts";
import type { Remote } from "../../src/server/remote.ts";
import type { AreaReply, AreaRequest } from "../../src/server/routes/area.ts";
import { type Fault, Faults } from "./faults.ts";

const [home, scheduleJson] = process.argv.slice(2) as [string, string];
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);
const PHONE = "a".repeat(64);
const STRANGER = "b".repeat(64);
const TABLET = "c".repeat(64);
/** One instant for every process: nothing expires while the suite runs. */
const NOW = 1_000_000;

const harness = await openStore(home, {
	models: createModels(),
	registry: createRegistry(),
	wrapStorage: (storage) => faults.storage(storage),
});
const remote: Remote = {
	id: "d".repeat(64),
	reach: "loopback",
	ticket: async () => "endpointticket",
	connected: () => false,
	drop: () => {},
	close: async () => {},
};
const desk = openDevices({ harness, remote: () => remote, changed: () => {}, now: () => NOW });

const request = (method: string, path: string, body: Record<string, unknown> = {}): AreaRequest => ({
	method,
	path,
	url: new URL(`http://local/api${path}`),
	json: async () => body,
	signal: new AbortController().signal,
});
const owner = async (method: string, path: string, body?: Record<string, unknown>) => {
	const reply = (await desk.area.route?.(request(method, path, body))) as Exclude<AreaReply, { file: unknown }>;
	return reply.body;
};
const pair = async (id: string, secret: string) =>
	(await desk.gate.pair(id, request("POST", "/devices/pair", { invite: secret, name: "Device" }))) as {
		status: number;
		body: unknown;
	};

/**
 * One step as a person takes it: what it answered is kept across restarts once they saw it, and a step whose answer
 * they never saw (killed before it came) is taken again.
 */
const kept = join(home, "answers.json");
const answers: Record<string, unknown> = existsSync(kept) ? JSON.parse(readFileSync(kept, "utf8")) : {};
const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
	if (name in answers) return answers[name] as T;
	const answer = await run();
	answers[name] = answer;
	writeFileSync(kept, JSON.stringify(answers));
	return answer;
};
const invite = async () => ((await owner("POST", "/devices/invites")) as InviteView).secret;

const first = await step("secret-1", invite);
await step("phone", () => pair(PHONE, first));
await step("stranger", () => pair(STRANGER, first));
await step("approve", () => owner("POST", `/devices/requests/${PHONE}/approve`, { name: "Pixel" }));
await step("approvedPhone", () => pair(PHONE, first));
const second = await step("secret-2", invite);
await step("tablet", () => pair(TABLET, second));
await step("deny", () => owner("POST", `/devices/requests/${TABLET}/deny`));
await step("deniedTablet", () => pair(TABLET, second));
await step("strangerSecond", () => pair(STRANGER, second));
await step("revoke", () => owner("POST", `/devices/${PHONE}/revoke`));
await step("revokedPhone", () => pair(PHONE, first));

console.log(
	JSON.stringify({
		answers,
		doc: await harness.snapshot(Devices, context),
		states: Object.fromEntries(
			await Promise.all(
				[PHONE, STRANGER, TABLET].map(async (id) => [
					id,
					((await desk.gate.pair(id, request("GET", "/devices/pair"))) as { body: { state: string } }).body.state,
				]),
			),
		),
		paired: { phone: await desk.gate.paired(PHONE), tablet: await desk.gate.paired(TABLET) },
		now: NOW,
		commits: faults.hits("commit:after"),
	}),
);
await harness.close(context);
