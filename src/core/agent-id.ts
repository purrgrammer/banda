/** The stable file name for an agent's display name, shared by proposal writing and its conversation link. */
export const agentId = (name: string): string =>
	name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
