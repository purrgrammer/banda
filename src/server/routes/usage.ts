import { context } from "../../core/store.ts";
import { readUsage, usageExtension } from "../../core/usage.ts";
import type { AreaModule } from "./area.ts";

export const usage: AreaModule = {
	install: () => [usageExtension],
	start: ({ harness }) => ({
		route: async ({ method, path }) =>
			method === "GET" && path === "/usage" ? { body: await readUsage(harness, context) } : undefined,
	}),
};
