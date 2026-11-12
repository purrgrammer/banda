/* Remote MCP protocol through pi-mcp. banda still owns sign-in, accepted listings and admission. */
import { McpAuthRequiredError, McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import {
	challengedScopes,
	InsufficientScope,
	type McpResult,
	type McpTool,
	resultText,
	toolOf,
	Unauthorized,
} from "./mcp.ts";
import { RetryLater, retryAtOf } from "./retry-after.ts";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Limit JSON and SSE alike: pi-mcp bounds individual messages, not a response's total bytes. */
async function boundedFetch(
	fetcher: typeof fetch,
	input: Parameters<typeof fetch>[0],
	init: RequestInit,
): Promise<Response> {
	const response = await fetcher(input, init);
	if (response.body === null) return response;
	if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
		await response.body.cancel();
		throw new Error("the MCP server's answer is too large");
	}
	let size = 0;
	const body = response.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				size += chunk.byteLength;
				if (size > MAX_RESPONSE_BYTES) throw new Error("the MCP server's answer is too large");
				controller.enqueue(chunk);
			},
		}),
	);
	return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** A session owns one MCP initialization and is always closed after the operation. */
export async function remoteSession<T>(
	url: string,
	authorization: () => Promise<string | undefined>,
	fetcher: typeof fetch,
	signal: AbortSignal | undefined,
	call: (client: McpClient) => Promise<T>,
): Promise<T> {
	const client = new McpClient({ name: "banda", version: "0.1.0", requestTimeoutMs: 60_000 });
	// a scope challenge, noticed on the response itself: what the transport makes of a 403 says less
	let challenged: readonly string[] | undefined;
	// a refusal for now, noticed on the response: when the server said to ask again
	let retryAt: number | undefined;
	const transport = new StreamableHttpTransport({
		url,
		openGetStream: false, // server notifications are not durable connection events
		// Never forward an Authorization header to a redirect target, including on session cleanup.
		fetch: async (input, init) => {
			const response = await boundedFetch(fetcher, input, {
				...init,
				redirect: "error",
				...(signal === undefined ? {} : { signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal }),
			});
			challenged ??= challengedScopes(response.status, response.headers.get("www-authenticate"));
			retryAt ??= retryAtOf(response.status, response.headers.get("retry-after"));
			return response;
		},
		authProvider: { token: async () => (await authorization())?.replace(/^Bearer /, "") },
	});
	try {
		await client.connect(transport);
		return await call(client);
	} catch (error) {
		if (challenged !== undefined) throw new InsufficientScope(challenged);
		if (error instanceof McpAuthRequiredError) throw new Unauthorized("the server did not take the credentials");
		if (retryAt !== undefined) throw new RetryLater("the server is busy", retryAt);
		throw error;
	} finally {
		await client.close();
	}
}

/** A server's listing: its tools, and the notes it gave when it was initialized, if any. */
export async function remoteListing(
	client: McpClient,
	signal?: AbortSignal,
): Promise<{ readonly tools: McpTool[]; readonly instructions?: string }> {
	const tools = await remoteTools(client, signal);
	const { instructions } = client;
	// as the server gave them: they are scrubbed of credentials before they are bounded (`notesOf`)
	return typeof instructions === "string" ? { tools, instructions } : { tools };
}

/** Limit pagination and validate the shape of a remote listing before it can become tool authority. */
export async function remoteTools(client: McpClient, signal?: AbortSignal): Promise<McpTool[]> {
	const tools: McpTool[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 20; page++) {
		const result = await client.request<{ tools?: unknown; nextCursor?: unknown }>(
			"tools/list",
			cursor === undefined ? {} : { cursor },
			signal === undefined ? {} : { signal },
		);
		for (const raw of Array.isArray(result.tools) ? result.tools : []) {
			const tool = toolOf(raw);
			if (tool !== undefined && !tools.some((known) => known.name === tool.name)) tools.push(tool);
		}
		cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
		if (cursor === undefined) break;
	}
	return tools.slice(0, 200);
}

/** Keep the established result format while pi-mcp handles sessions, framing, and cancellation. */
export async function remoteCall(
	client: McpClient,
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<McpResult> {
	return resultText(await client.callTool(name, args, signal === undefined ? {} : { signal }));
}
