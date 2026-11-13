/**
 * A scripted OpenAI-compatible server on loopback, standing in for a local model server (Ollama, LM Studio, llama.cpp,
 * vLLM) or a hosted gateway: `POST <base>/chat/completions`, streamed or not, and `GET <base>/models`. It records each
 * request it answers, so a test can see what banda sent (its headers, its body); it can require a key, redirect, fail,
 * or refuse a field the way a strict server does. No model runs: the answer is scripted.
 *
 * Run by hand: `node test/fixtures/compat-server.ts [port] [key]` serves on 127.0.0.1 until stopped.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type Recorded = {
	readonly method: string;
	readonly path: string;
	readonly headers: Readonly<Record<string, string | string[] | undefined>>;
	readonly body: Record<string, unknown> | undefined;
};

export type CompatOptions = {
	/** The path the API answers under. Default `/v1`. */
	readonly base?: string;
	/** A key the server requires as `Authorization: Bearer <key>`; it answers 401, echoing what it got, without it. */
	readonly key?: string;
	/** The models it has, as each listing route tells them (`GET /models`, Ollama's, LM Studio's…). */
	readonly models?: readonly (string | FixtureModel)[];
	/** Whose `GET /v1/models` shape it answers in. Default OpenAI's. */
	readonly flavor?: "openai" | "anthropic" | "mistral";
	/** The text of an answer, from the request. Default: "OK from <model>". */
	readonly reply?: (body: Record<string, unknown>) => string;
	/** Answer `POST /chat/completions` with a redirect here instead. */
	readonly redirect?: string;
	/** Answer with this status and message instead. */
	readonly fail?: { readonly status: number; readonly message: string };
	/** Fields the server refuses with 400, as a strict one does (`store`, `max_completion_tokens`). */
	readonly refuses?: readonly string[];
	/**
	 * Answer a chat turn as banda's agents speak, when the request offers `message_user`: a call of it with this text,
	 * then, once its result comes back, an empty answer that ends the turn.
	 */
	readonly speak?: string;
	/** Hold each chat completion this long before answering, as a slow model does. */
	readonly delayMs?: number;
};

/** A model as the fixture lists it; each route says of it what its documentation says such a server does. */
export type FixtureModel = {
	readonly id: string;
	/** The most the model was made for (Ollama's `model_info`, LM Studio's `max_context_length`, llama.cpp's own). */
	readonly context?: number;
	/** Ollama: the context it runs the model with, set by `num_ctx` in its parameters. */
	readonly numCtx?: number;
	/** Ollama: loaded now, with this context (`/api/ps`). */
	readonly loaded?: number;
	/** Ollama: the model calls no tools. */
	readonly noTools?: boolean;
	readonly maxTokens?: number;
	readonly vision?: boolean;
	readonly thinking?: boolean;
	readonly embedding?: boolean;
	readonly displayName?: string;
};

export type CompatServer = {
	readonly url: string;
	readonly port: number;
	readonly requests: Recorded[];
	/** Change how it answers from the next request on. */
	set(options: Partial<CompatOptions>): void;
	close(): Promise<void>;
};

async function bodyOf(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	if (chunks.length === 0) return undefined;
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** An answer as Anthropic's Messages API streams one. */
function anthropicAnswer(
	response: import("node:http").ServerResponse,
	body: Record<string, unknown> | undefined,
	options: CompatOptions,
) {
	if (options.fail !== undefined) {
		response.writeHead(options.fail.status, { "content-type": "application/json" });
		return response.end(JSON.stringify({ type: "error", error: { type: "api_error", message: options.fail.message } }));
	}
	const model = String(body?.model ?? "scripted-model");
	const text = options.reply?.(body ?? {}) ?? `OK from ${model}`;
	response.writeHead(200, { "content-type": "text/event-stream" });
	const send = (type: string, data: Record<string, unknown>) =>
		response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	send("message_start", {
		message: {
			id: "msg_scripted",
			type: "message",
			role: "assistant",
			model,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 12, output_tokens: 0 },
		},
	});
	send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	send("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
	send("content_block_stop", { index: 0 });
	send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
	send("message_stop", {});
	response.end();
}

export async function compatServer(initial: CompatOptions = {}, port = 0): Promise<CompatServer> {
	let options: CompatOptions = { ...initial };
	const requests: Recorded[] = [];
	const server: Server = createServer((request, response) => {
		void (async () => {
			const base = options.base ?? "/v1";
			const path = new URL(request.url ?? "/", "http://x").pathname;
			const body = await bodyOf(request);
			requests.push({ method: request.method ?? "GET", path, headers: { ...request.headers }, body });
			const json = (status: number, value: unknown) => {
				response.writeHead(status, { "content-type": "application/json" });
				response.end(JSON.stringify(value));
			};
			const given =
				request.headers.authorization ??
				(request.headers["x-api-key"] ? `Bearer ${request.headers["x-api-key"]}` : undefined);
			if (options.key !== undefined && given !== `Bearer ${options.key}`)
				return json(401, {
					error: {
						message: `Incorrect API key provided: ${given ?? "none"}`,
						type: "invalid_request_error",
					},
				});
			// a listing that redirects, as a misconfigured proxy does
			if (request.method === "GET" && options.redirect !== undefined) {
				response.writeHead(307, { location: options.redirect });
				return response.end();
			}
			const models = (options.models ?? ["scripted-model"]).map((each) =>
				typeof each === "string" ? ({ id: each } as FixtureModel) : each,
			);
			if (request.method === "GET" && path === `${base}/models`) {
				// each as its server documents it
				if (options.flavor === "anthropic")
					return json(200, {
						data: models.map((model) => ({
							type: "model",
							id: model.id,
							display_name: model.displayName ?? model.id,
							created_at: "2026-01-01T00:00:00Z",
							max_input_tokens: model.context ?? null,
							max_tokens: model.maxTokens ?? null,
							capabilities: {
								image_input: { supported: model.vision === true },
								thinking: { supported: model.thinking === true, types: {} },
							},
						})),
						has_more: false,
						first_id: models[0]?.id ?? null,
						last_id: models.at(-1)?.id ?? null,
					});
				if (options.flavor === "mistral")
					return json(
						200,
						models.map((model) => ({
							id: model.id,
							object: "model",
							created: 0,
							owned_by: "scripted",
							capabilities: {
								completion_chat: model.embedding !== true,
								completion_fim: false,
								function_calling: true,
								fine_tuning: false,
								vision: model.vision === true,
								classification: false,
							},
							max_context_length: model.context ?? 32768,
							aliases: [],
							TYPE: "base",
						})),
					);
				return json(200, {
					object: "list",
					data: models.map((model) => ({
						id: model.id,
						object: "model",
						owned_by: "scripted",
						...(model.context === undefined ? {} : { meta: { n_ctx_train: model.context } }),
					})),
				});
			}
			// Ollama's own routes
			if (request.method === "GET" && path === "/api/tags")
				return json(200, {
					models: models.map((model) => ({
						name: model.id,
						model: model.id,
						modified_at: "2026-01-01T00:00:00Z",
						size: 1,
						digest: "0",
						details: { format: "gguf", family: "llama", parameter_size: "8B", quantization_level: "Q4_0" },
					})),
				});
			if (request.method === "POST" && path === "/api/show") {
				const model = models.find((each) => each.id === body?.model);
				if (model === undefined) return json(404, { error: `model '${String(body?.model)}' not found` });
				return json(200, {
					modelfile: "",
					parameters: model.numCtx === undefined ? "temperature 0.6" : `temperature 0.6\nnum_ctx ${model.numCtx}`,
					template: "",
					details: { format: "gguf", family: "llama" },
					model_info: {
						"general.architecture": "llama",
						...(model.context === undefined ? {} : { "llama.context_length": model.context }),
					},
					capabilities:
						model.embedding === true
							? ["embedding"]
							: [
									"completion",
									...(model.noTools ? [] : ["tools"]),
									...(model.thinking ? ["thinking"] : []),
									...(model.vision ? ["vision"] : []),
								],
				});
			}
			if (request.method === "GET" && path === "/api/ps")
				return json(200, {
					models: models.flatMap((model) =>
						model.loaded === undefined
							? []
							: [{ name: model.id, model: model.id, size: 1, digest: "0", context_length: model.loaded }],
					),
				});
			// LM Studio's
			if (request.method === "GET" && path === "/api/v0/models")
				return json(200, {
					object: "list",
					data: models.map((model) => ({
						id: model.id,
						object: "model",
						type: model.embedding ? "embeddings" : model.vision ? "vlm" : "llm",
						publisher: "scripted",
						arch: "llama",
						compatibility_type: "gguf",
						quantization: "Q4_K_M",
						state: "not-loaded",
						...(model.context === undefined ? {} : { max_context_length: model.context }),
					})),
				});
			// llama.cpp's
			if (request.method === "GET" && path === "/props")
				return json(200, { default_generation_settings: { n_ctx: models[0]?.context ?? 4096 } });
			if (request.method === "POST" && path === `${base}/messages` && options.redirect === undefined)
				return anthropicAnswer(response, body, options);
			const generating = [`${base}/chat/completions`, `${base}/messages`, `${base}/responses`];
			if (request.method !== "POST" || !generating.includes(path))
				return json(404, { error: { message: `no route ${request.method} ${path}` } });
			if (path === `${base}/chat/completions` && (options.delayMs ?? 0) > 0) {
				const held = options.delayMs ?? 0;
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, held);
					request.socket.once("close", () => {
						clearTimeout(timer);
						resolve();
					});
				});
				if (request.socket.destroyed) return;
			}
			if (options.redirect !== undefined) {
				response.writeHead(307, { location: options.redirect });
				return response.end();
			}
			if (options.fail !== undefined) return json(options.fail.status, { error: { message: options.fail.message } });
			const refused = (options.refuses ?? []).find((field) => body !== undefined && field in body);
			if (refused !== undefined)
				return json(400, { error: { message: `Unrecognized request argument supplied: ${refused}` } });
			const model = String(body?.model ?? "scripted-model");
			const tools = (body?.tools ?? []) as { function?: { name?: string } }[];
			const messages = (body?.messages ?? []) as { role?: string }[];
			const speaks =
				options.speak !== undefined && tools.some((tool) => tool.function?.name === "message_user")
					? messages.at(-1)?.role === "tool"
						? ""
						: options.speak
					: undefined;
			const text = speaks === undefined ? (options.reply?.(body ?? {}) ?? `OK from ${model}`) : "";
			const usage = { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 };
			const created = Math.floor(Date.now() / 1000);
			if (body?.stream !== true)
				return json(200, {
					id: "chatcmpl-scripted",
					object: "chat.completion",
					created,
					model,
					choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
					usage,
				});
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const chunk = (delta: Record<string, unknown>, finish: string | null, extra: Record<string, unknown> = {}) =>
				response.write(
					`data: ${JSON.stringify({ id: "chatcmpl-scripted", object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`,
				);
			chunk({ role: "assistant", content: "" }, null);
			if (speaks !== undefined && speaks !== "") {
				chunk(
					{
						tool_calls: [
							{
								index: 0,
								id: `call_${requests.length}`,
								type: "function",
								function: { name: "message_user", arguments: JSON.stringify({ text: speaks }) },
							},
						],
					},
					null,
				);
				chunk({}, "tool_calls", { usage });
				return response.end("data: [DONE]\n\n");
			}
			for (const word of text.split(/(?<= )/)) if (word !== "") chunk({ content: word }, null);
			chunk({}, "stop", { usage });
			response.end("data: [DONE]\n\n");
		})().catch((error: unknown) => {
			response.writeHead(500);
			response.end(String(error));
		});
	});
	await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
	const bound = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${bound}${options.base ?? "/v1"}`,
		port: bound,
		requests,
		set: (next) => {
			options = { ...options, ...next };
		},
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

if (import.meta.main) {
	const [port, key] = process.argv.slice(2);
	const server = await compatServer(
		{ ...(key === undefined ? {} : { key }), models: ["scripted-small", "scripted-large"] },
		Number(port ?? 0),
	);
	console.log(`scripted OpenAI-compatible server at ${server.url}${key === undefined ? "" : " (key required)"}`);
}
