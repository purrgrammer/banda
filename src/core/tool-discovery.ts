/** Tool exposure is separate from authority: pi owns search, loading and its durable modelTools state. */
import {
	createRegistry,
	defineExtension,
	type Extension,
	type Registry,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createToolSearchExtension, TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search";
import { CONNECT, EVERY_AGENT, MESSAGE_GROUP, PROPOSE_AVATAR, TOOLSETS } from "./toolsets.ts";

/** Sent from the first step: banda's own base, but the rarer speaking tools. A connection's tools load on demand. */
const CORE = new Set([MESSAGE_GROUP, ...EVERY_AGENT.filter((tool) => tool !== CONNECT && tool !== PROPOSE_AVATAR)]);

/** The rarer speaking tools, loaded on demand, by the group search finds them in. */
const SPEAKING_GROUPS: { readonly [name: string]: string } = { [CONNECT]: "connections", [PROPOSE_AVATAR]: "avatar" };

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
	const speaking = SPEAKING_GROUPS[name];
	if (speaking !== undefined) return speaking;
	for (const [label, tools] of Object.entries(TOOLSETS)) if (tools.includes(name)) return label;
	return "other";
}

/**
 * The groups of tools search can load, by name only: a group leaves once none of its tools is left to load, so the
 * words change only when a whole group does.
 */
export function discoveryWords(tools: readonly ToolRegistration[]): string | undefined {
	if (tools.length === 0) return undefined;
	const groups = [...new Set(tools.map((tool) => namespace(tool.name)))].sort((a, b) => a.localeCompare(b));
	return (
		`More tools load on demand: call \`${TOOL_SEARCH_TOOL_NAME}\` with what you need, naming a service or a capability; ` +
		"what it finds you can call from your next step. When an instruction names a tool you do not have, search for it " +
		`first. On demand: ${groups.join(", ")}.`
	);
}

/** `tool_search` itself: installed first, so it keeps its place among the tools. */
export const toolSearchExtension = createToolSearchExtension();

/** The words about it: installed after the other sections, so the prompt says who the agent is before its tools. */
export const toolDiscoveryExtension = defineExtension({
	name: "banda.tool-discovery",
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
