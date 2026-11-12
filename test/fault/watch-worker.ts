/**
 * The process the watch fault suite kills: a watch through one of the scenarios (`watch-scenario.ts`, and Slack's in
 * `slack-world.ts`), under the schedule given. Prints what happened.
 *
 * argv: home, scenario name (`SCENARIOS`, `SLACK_SCENARIOS`), fault schedule JSON (Fault[])
 */
import { type Fault, Faults } from "./faults.ts";
import { SLACK_SCENARIOS } from "./slack-world.ts";
import { SCENARIOS, watchScenario } from "./watch-scenario.ts";

const [home, name, scheduleJson] = process.argv.slice(2) as [string, string, string];
const scenario = { ...SCENARIOS, ...SLACK_SCENARIOS }[name];
if (scenario === undefined) throw new Error(`no watch scenario named ${name}`);
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);
console.log(JSON.stringify(await watchScenario(home, faults, scenario.options)));
