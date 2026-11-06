import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as iroh from "@number0/iroh";
import { endpointKey } from "../../src/server/remote.ts";
import { type Fault, Faults, InjectedFault } from "./faults.ts";

const [home, schedule] = process.argv.slice(2) as [string, string];
const faults = new Faults(JSON.parse(schedule) as Fault[]);
const before = await readFile(join(home, "auth", "iroh.key")).catch(() => undefined);
const advertised = join(home, "advertised.json");
const previous = JSON.parse(await readFile(advertised, "utf8").catch(() => "[]")) as string[];
for (;;) {
	try {
		const key = await endpointKey(home, iroh, (point) => faults.hit(point));
		const id = key.public().toString();
		previous.push(id);
		await writeFile(advertised, JSON.stringify(previous));
		const stored = await readFile(join(home, "auth", "iroh.key"));
		console.log(
			JSON.stringify({ ids: previous, bytes: stored.length, unchanged: before === undefined || before.equals(stored) }),
		);
		break;
	} catch (error) {
		if (!(error instanceof InjectedFault)) throw error;
	}
}
