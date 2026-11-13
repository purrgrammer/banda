/**
 * Who sees a chat (DESIGN.md "Trust"): the model provider every prompt goes to, owner data included, named in
 * plain words, and whether it runs on this computer, so nothing leaves it. Never a model string.
 */
import type { ModelRef } from "@earendil-works/pi-durable";
import { backendOf } from "../core/provider-accounts.ts";
import type { SeenBy } from "./api.ts";

/** Providers by the name their makers go by. */
export const NAMES: { readonly [provider: string]: string } = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	"openai-codex": "OpenAI",
	azure: "Microsoft Azure",
	"azure-openai-responses": "Microsoft Azure",
	meta: "Meta",
	google: "Google",
	"google-vertex": "Google",
	"google-gemini-cli": "Google",
	"amazon-bedrock": "Amazon",
	xai: "xAI",
	mistral: "Mistral",
	groq: "Groq",
	cerebras: "Cerebras",
	openrouter: "OpenRouter",
	deepseek: "DeepSeek",
	"github-copilot": "GitHub",
	huggingface: "Hugging Face",
	zai: "Z.ai",
	moonshotai: "Moonshot AI",
	minimax: "MiniMax",
	ollama: "Ollama",
	lmstudio: "LM Studio",
	faux: "a test model",
};

const LOOPBACK = /^[a-z]+:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i;

/**
 * Who sees a chat run with `model`, whose endpoint is `baseUrl` when known; `own` is the name the owner gave a custom
 * provider, which no list here knows.
 */
export function seenBy(model: ModelRef, baseUrl: string | undefined, own?: string): SeenBy {
	const backend = backendOf(model.provider);
	const name = own ?? NAMES[backend] ?? backend.replace(/[-_]+/g, " ");
	const local = backend === "faux" || (baseUrl !== undefined && LOOPBACK.test(baseUrl));
	return { name, local };
}
