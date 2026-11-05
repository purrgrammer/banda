/**
 * The process the watch fault suite kills: a watch on a pull request through its life (`watch-scenario.ts`), under the
 * schedule given. Prints what happened.
 *
 * argv: home, fault schedule JSON (Fault[])
 */
import { type Fault, Faults } from "./faults.ts";
import { watchScenario } from "./watch-scenario.ts";

const [home, scheduleJson] = process.argv.slice(2) as [string, string];
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);
console.log(JSON.stringify(await watchScenario(home, faults)));
