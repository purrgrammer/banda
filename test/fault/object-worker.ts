import { type Fault, Faults } from "./faults.ts";
import { type ObjectScenario, objectScenario } from "./object-scenario.ts";

const [home, input, schedule] = process.argv.slice(2) as [string, string, string];
const faults = new Faults(JSON.parse(schedule) as Fault[]);
let last: unknown;
for (let attempt = 0; attempt < 4; attempt++) {
	try {
		last = await objectScenario(home, JSON.parse(input) as ObjectScenario, faults);
		break;
	} catch (error) {
		if (attempt === 3) throw error;
	}
}
console.log(JSON.stringify(last));
