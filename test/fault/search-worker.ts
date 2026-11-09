/** Search's derived group/artifact commits: retry thrown faults and rebuild after SIGKILL. */
import { join } from "node:path";
import { Search } from "../../src/core/search.ts";
import { type Fault, Faults } from "./faults.ts";

const [home, countText, schedule] = process.argv.slice(2) as [string, string, string];
const faults = new Faults(JSON.parse(schedule) as Fault[]);
const index = new Search(join(home, "search.db"), { hit: () => faults.hit("index") });
const count = Number(countText);
function populate(search: Search) {
	const steps = [
		() =>
			search.groupLines(
				1,
				Array.from({ length: count }, (_, n) => ({ entry: n + 1, who: "owner", text: `Lisbon ${n}`, at: n })),
			),
		() => search.artifacts([{ id: "a1", title: "Plan", sha: "v1", text: "Lisbon old" }]),
		() => search.artifacts([{ id: "a1", title: "Plan", sha: "v2", text: "Lisbon revised" }]),
		() => search.artifacts([]),
	];
	for (const step of steps) {
		try {
			step();
		} catch {
			step();
		}
	}
}
populate(index);
const rebuilt = new Search(join(home, `fresh-${process.pid}.db`));
populate(rebuilt);
console.log(JSON.stringify({ rows: index.rows(), rebuilt: rebuilt.rows(), indexes: faults.hits("index") }));
rebuilt.close();
index.close();
