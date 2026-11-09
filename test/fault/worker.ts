/**
 * The process the kill driver ends: the system under fault on `home`, which receives every message (redeliveries,
 * after a restart), waits for their Turns and prints a summary as its last line.
 *
 * argv: home, messages JSON (Inbound[]), fault schedule JSON (Fault[])
 */
import type { Inbound } from "../../src/core/gateway.ts";
import { context } from "../../src/core/store.ts";
import { type Fault, Faults } from "./faults.ts";
import { banda, settle, summarize } from "./sut.ts";

const [home, messagesJson, scheduleJson] = process.argv.slice(2) as [string, string, string];
const messages = JSON.parse(messagesJson) as Inbound[];
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);
const s = banda(home, faults);
const harness = await s.open();
for (const message of messages) await s.core.receive(harness, message);
await settle(harness, messages);
const summary = await summarize(harness, messages);
console.log(JSON.stringify({ summary, commits: faults.hits("commit:after") }));
await harness.close(context);
