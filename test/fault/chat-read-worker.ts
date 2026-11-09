import { chatReadScenario, type Reply } from "./chat-read-scenario.ts";
import { type Fault, Faults } from "./faults.ts";

const [home, replies, schedule] = process.argv.slice(2) as [string, string, string];
const result = await chatReadScenario(
	home,
	new Faults(JSON.parse(schedule) as Fault[]),
	JSON.parse(replies) as Reply[],
);
process.stdout.write(`${JSON.stringify(result)}\n`);
