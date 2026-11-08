/**
 * The process the watch fault suite kills: a watch on a pull request through one of the scenarios
 * (`watch-scenario.ts`), under the schedule given. Prints what happened.
 *
 * argv: home, scenario name (`SCENARIOS`), fault schedule JSON (Fault[])
 */
import { type Fault, Faults } from "./faults.ts";
import { SCENARIOS, watchScenario } from "./watch-scenario.ts";

const [home, name, scheduleJson] = process.argv.slice(2) as [string, string, string];
const scenario = SCENARIOS[name];
if (scenario === undefined) throw new Error(`no watch scenario named ${name}`);
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);
console.log(JSON.stringify(await watchScenario(home, faults, scenario.options)));
