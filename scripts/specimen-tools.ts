/** Regenerate the specimen's built-in descriptions and schemas from registrations, without running tools or a daemon. */
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { browserTools } from "../src/box/browser-tools.ts";
import { boxTools } from "../src/box/tools.ts";
import { webFetchTool } from "../src/box/web-fetch.ts";
import { askHostsTool } from "../src/core/ask-hosts.ts";
import { BlobStore } from "../src/core/blobs.ts";
import { memoryExtension } from "../src/core/memory.ts";
import { searchExtension } from "../src/core/search-tools.ts";
import { skillsExtension } from "../src/core/skills.ts";
import { defineCore } from "../src/core/turn.ts";

const unused = () => {
	throw new Error("Schema generation never executes tools");
};
const core = defineCore({ blobs: new BlobStore("/unused"), gateway: unused, model: unused });
const tools = [
	...(core.extension.tools ?? []),
	...(boxTools().tools ?? []),
	...browserTools({ browser: unused, effect: core.effect, ask: unused, keep: unused, giveBack: unused }),
	webFetchTool(),
	core.effect(askHostsTool()),
	...(skillsExtension.tools ?? []),
	...(memoryExtension({} as never).tools ?? []),
	...(searchExtension({} as never).tools ?? []),
];
const catalog = Object.fromEntries(
	tools.map((tool) => [tool.name, { description: tool.description, parameters: tool.parameters }]),
);
await writeFile(
	new URL("../web/src/specimen/agent/tool-schemas.json", import.meta.url),
	`${JSON.stringify(catalog, null, 2)}\n`,
);

execFileSync(fileURLToPath(new URL("../node_modules/.bin/biome", import.meta.url)), [
	"format",
	"--write",
	fileURLToPath(new URL("../web/src/specimen/agent/tool-schemas.json", import.meta.url)),
]);
