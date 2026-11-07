/** Tool exposure is separate from authority: pi owns search, loading and its durable modelTools state. */
import {
	createRegistry,
	defineExtension,
	type Extension,
	type Registry,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createToolSearchExtension, TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search";
import { MESSAGE_GROUP, MESSAGE_USER, TOOLSETS } from "./toolsets.ts";

const CORE = new Set([MESSAGE_USER, MESSAGE_GROUP, TOOL_SEARCH_TOOL_NAME, "read", "write", "edit", "bash"]);

/** Apply the same exposure policy to startup extensions and later connection registrations. */
export function deferredTools(extension: Extension): Extension {
	if (extension.tools === undefined) return extension;
	return {
		...extension,
		tools: extension.tools.map((tool) => (CORE.has(tool.name) ? tool : { ...tool, deferred: true })),
	};
}

function namespace(name: string): string {
	if (name.includes("__")) return name.slice(0, name.indexOf("__"));
	for (const [label, tools] of Object.entries(TOOLSETS)) if (tools.includes(name)) return label;
	return "secondary";
}

/** Only the tools pi says search can load appear here; counts shrink as tools become offered. */
export function discoveryWords(tools: readonly ToolRegistration[]): string | undefined {
	if (tools.length === 0) return undefined;
	const groups = new Map<string, number>();
	for (const tool of tools) {
		const label = namespace(tool.name);
		groups.set(label, (groups.get(label) ?? 0) + 1);
	}
	return (
		"Some tools are available on demand. Use tool_search with a descriptive query and optional limit. " +
		"Matching tools become available on your next model call; call them directly using their exposed schemas. " +
		"For MCP tools, use tool_search to discover them. Tools already offered do not appear in search results. " +
		"The groups below are orientation, not a namespace filter: include a service or capability in the query. " +
		"When an instruction names a tool that is not offered yet, search for it first.\n" +
		[...groups]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, count]) => `${name}: ${count} tools on demand`)
			.join("\n")
	);
}

const search = createToolSearchExtension();
export const toolDiscoveryExtension = defineExtension({
	...search,
	sections: [
		{
			key: "tool_discovery",
			render: ({ agent }) =>
				agent.tools.some((tool) => tool.name === TOOL_SEARCH_TOOL_NAME) ? discoveryWords(agent.deferred) : undefined,
		},
	],
});

/** Every daemon registration, including a connection installed later, follows the same exposure policy. */
export function toolRegistry(): Registry {
	const registry = createRegistry();
	return {
		snapshot: () => registry.snapshot(),
		subscribe: (listener) => registry.subscribe(listener),
		install: (extension) => registry.install(deferredTools(extension)),
		uninstall: (extension) => registry.uninstall(extension),
	};
}
