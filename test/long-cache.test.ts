import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { registerAccount } from "../src/core/account-provider.ts";
import { cacheLong } from "../src/core/long-cache.ts";

function setup() {
	const asked: (string | undefined)[] = [];
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const respond = (_ctx: unknown, options: { cacheRetention?: string } | undefined) => {
		asked.push(options?.cacheRetention);
		return fauxAssistantMessage("ok");
	};
	faux.setResponses(Array.from({ length: 10 }, () => respond as never));
	const models = createModels();
	models.setProvider(faux.provider);
	cacheLong(models);
	return { asked, models };
}

const CONTEXT = { messages: [{ role: "user", content: "hi", timestamp: 0 }] } as never;

describe("the long prompt cache by default", () => {
	it("asks for the long cache when the caller named no retention", async () => {
		const { asked, models } = setup();
		const model = models.getModel("faux", "faux-1")!;
		await models.getProvider("faux")!.streamSimple(model, CONTEXT).result();
		await models.getProvider("faux")!.stream(model, CONTEXT, { maxTokens: 1 }).result();
		expect(asked).toEqual(["long", "long"]);
	});

	it("keeps the retention a caller named, as compaction's none", async () => {
		const { asked, models } = setup();
		const model = models.getModel("faux", "faux-1")!;
		await models.getProvider("faux")!.streamSimple(model, CONTEXT, { cacheRetention: "none" }).result();
		await models.getProvider("faux")!.streamSimple(model, CONTEXT, { cacheRetention: "short" }).result();
		expect(asked).toEqual(["none", "short"]);
	});

	it("reaches an account cloned from the wrapped backend", async () => {
		const { asked, models } = setup();
		expect(registerAccount(models, "faux@work")).toBe(true);
		const model = models.getModel("faux@work", "faux-1")!;
		await models.getProvider("faux@work")!.streamSimple(model, CONTEXT).result();
		expect(asked).toEqual(["long"]);
	});
});
