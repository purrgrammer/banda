/** Cut pi's search/loading commits and model boundaries; recovery must preserve one usable discovery result. */
import type { Storage } from "@earendil-works/pi-durable";
import { context } from "../../src/core/store.ts";
import { discoveryFixture } from "../fixtures/tool-discovery.ts";
import { type Fault, Faults, InjectedFault } from "./faults.ts";

const [home, schedule] = process.argv.slice(2);
if (!home || !schedule) throw new Error("home and fault schedule required");
const faults = new Faults(JSON.parse(schedule) as Fault[]);
let armed = false;
const wrapStorage = (storage: Storage): Storage => {
	const faulted = faults.storage(storage);
	return new Proxy(storage, {
		get(target, key) {
			if (key === "commit")
				return (...args: Parameters<Storage["commit"]>) => (armed ? faulted : target).commit(...args);
			const value = Reflect.get(target, key, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
};
const setup = () =>
	discoveryFixture(home, wrapStorage, () => {
		if (armed) faults.hit("model");
	});
let fixture = await setup();
armed = true;
let result: Awaited<ReturnType<typeof fixture.run>>;
try {
	result = await fixture.run();
} catch (error) {
	let injected = false;
	for (let current = error; current instanceof Error; current = current.cause)
		if (current instanceof InjectedFault) injected = true;
	if (!injected) throw error;
	armed = false;
	await fixture.harness.close(context).catch(() => {});
	fixture = await setup();
	armed = true;
	result = await fixture.run();
}
armed = false;
console.log(
	JSON.stringify({
		outcome: result.outcome,
		loaded: result.state?.modelTools,
		searches: result.messages.filter((message) => message.role === "toolResult" && message.toolName === "tool_search")
			.length,
		calls: result.messages.filter((message) => message.role === "toolResult" && message.toolName === "lookup").length,
		secret: JSON.stringify(result.messages).includes("SECRET UNAVAILABLE DESCRIPTION"),
		commits: faults.hits("commit:after"),
		models: faults.hits("model"),
	}),
);
await fixture.harness.close(context);
