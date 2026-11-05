import { readFile } from "node:fs/promises";
import { GITHUB_OBJECTS } from "../../scripts/github-objects.ts";
import { type FakeTool, startFakeMcp } from "./mcp-server.ts";

/** Schemas extracted from upstream snapshots at the exact shipped commit. Responses follow its minimal_types.go. */
export async function githubObjectTools(): Promise<FakeTool[]> {
	const fixture = JSON.parse(await readFile(new URL("./github-object-tools.json", import.meta.url), "utf8")) as {
		tools: {
			name: string;
			description: string;
			inputSchema: Record<string, unknown>;
			annotations: { readOnlyHint?: boolean };
		}[];
	};
	return fixture.tools.map((t) => ({
		name: t.name,
		description: t.description,
		inputSchema: t.inputSchema,
		readOnlyHint: t.annotations.readOnlyHint === true,
	}));
}
export function githubObjectFile(url: string, auth: "none" | "key" | "oauth" = "oauth") {
	return `---\nservice: GitHub\nurl: ${url}\nauth: ${auth}\n${auth === "none" ? "" : "account: get_me.login\n"}${auth === "oauth" ? "scopes: [repo]\n" : ""}reads: [pull_request_read, issue_read, actions_get, get_notification_details]\n---\nGitHub objects.\n\n\`\`\`json\n${JSON.stringify({ objects: GITHUB_OBJECTS }, null, 2)}\n\`\`\`\n`;
}
export async function startGithubObjects({ auth = "oauth" }: { auth?: "none" | "key" | "oauth" } = {}) {
	const fake = await startFakeMcp({ auth, scopes: ["repo"] });
	fake.tools = await githubObjectTools();
	const response = (tool: string, args: Record<string, unknown>) => {
		if (tool === "pull_request_read") {
			if (args.pullNumber === 404) return { text: "Not found", isError: true };
			if (args.method === "get_check_runs")
				return {
					text: JSON.stringify({
						total_count: 3,
						check_runs: [
							{ name: "unit", status: "completed", conclusion: "success" },
							{ name: "lint", status: "completed", conclusion: "success" },
							{ name: "build", status: "in_progress" },
						],
					}),
				};
			if (args.method === "get_reviews")
				return { text: JSON.stringify([{ user: { login: "ana" }, state: "APPROVED" }]) };
			return {
				text: JSON.stringify({
					number: args.pullNumber,
					title: "Keep objects as data",
					state: "open",
					draft: false,
					merged: false,
					user: { login: "ana" },
					head: { ref: "objects" },
					additions: 42,
					deletions: 6,
					html_url: `https://github.com/${args.owner}/${args.repo}/pull/${args.pullNumber}`,
				}),
			};
		}
		if (tool === "issue_read")
			return {
				text: JSON.stringify({
					number: args.issue_number,
					title: "Show an honest reading",
					state: "open",
					user: { login: "ana" },
					labels: ["bug"],
					assignees: ["ana"],
					comments: 2,
					html_url: `https://github.com/${args.owner}/${args.repo}/issues/${args.issue_number}`,
				}),
			};
		if (tool === "actions_get")
			return {
				text: JSON.stringify({
					id: Number(args.resource_id),
					name: "Build",
					status: "completed",
					conclusion: "failure",
					head_branch: "objects",
					steps: [{ name: "Tests", status: "completed", conclusion: "failure" }],
					started_at: "2026-11-04T10:00:00Z",
					completed_at: "2026-11-04T10:01:20Z",
					html_url: `https://github.com/${args.owner}/${args.repo}/actions/runs/20/job/${args.resource_id}`,
				}),
			};
		if (tool === "get_notification_details")
			return {
				text: JSON.stringify({
					id: args.notificationID,
					reason: "review_requested",
					unread: true,
					updated_at: "2026-11-04T10:00:00Z",
					subject: {
						title: "Keep objects as data",
						type: "PullRequest",
						url: "https://api.github.com/repos/acme/banda/pulls/34",
					},
				}),
			};
		return { text: JSON.stringify({ ok: true }) };
	};
	fake.onCall = async (tool, args) => {
		const shape = fake.tools.find((t) => t.name === tool)?.inputSchema;
		const properties = shape?.properties as Record<string, { type?: string; enum?: unknown[] }> | undefined;
		for (const key of (shape?.required ?? []) as string[])
			if (args[key] === undefined) return { text: `missing ${key}`, isError: true };
		for (const [key, value] of Object.entries(args)) {
			const field = properties?.[key];
			if (
				field === undefined ||
				(field.type !== undefined &&
					(field.type === "integer"
						? !(typeof value === "number" && Number.isInteger(value))
						: typeof value !== field.type)) ||
				(field.enum !== undefined && !field.enum.includes(value))
			)
				return { text: `invalid ${key}`, isError: true };
		}
		return response(tool, args);
	};
	return fake;
}
