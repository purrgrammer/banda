import { createModels, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { context, openStore } from "../src/core/store.ts";
import { SystemUsage, usageRecorder } from "../src/core/system-usage.ts";
import { answerJson, INFERENCES, infer, type Read } from "../src/server/inference.ts";
import { said, scripted } from "./fixtures/scripted.ts";
import { tempHome } from "./helpers.ts";

/** A reader that takes a number and refuses anything else. */
const number = (text: string): Read<number> =>
	/^\d+$/.test(text.trim()) ? { ok: true, value: Number(text) } : { ok: false, errors: ["answer with digits alone"] };

const base = {
	system: "Answer with a number.",
	ask: "How many legs has a cat?",
	read: number,
	record: async () => {},
};

const store = () => tempHome().then((home) => openStore(home, { models: createModels(), registry: createRegistry() }));

describe("inference", () => {
	it("asks once with banda's instructions and the request, and reads the answer", async () => {
		const { models, model, asked } = scripted(fauxAssistantMessage("4"));
		expect(await infer({ ...base, models, model })).toEqual({ ok: true, value: 4 });
		expect(asked).toHaveLength(1);
		expect(said(asked[0])).toContain("Answer with a number.");
		expect(said(asked[0])).toContain("How many legs");
	});

	it("tries again with what was refused while attempts remain, then says why", async () => {
		const fixed = scripted(fauxAssistantMessage("four"), fauxAssistantMessage("4"));
		expect(await infer({ ...base, ...fixed, attempts: 2 })).toEqual({ ok: true, value: 4 });
		expect(said(fixed.asked[1])).toContain("answer with digits alone");

		const once = scripted(fauxAssistantMessage("four"), fauxAssistantMessage("4"));
		expect(await infer({ ...base, ...once })).toEqual({
			ok: false,
			why: "The answer didn't come out right (answer with digits alone). Try again.",
		});
		expect(once.asked).toHaveLength(1);
	});

	it("says why when the model fails or throws, the deadline passes or the caller stops", async () => {
		const failed = scripted(fauxAssistantMessage("", { stopReason: "error", errorMessage: "rate limited" }));
		expect(await infer({ ...base, ...failed })).toEqual({ ok: false, why: "The model couldn't answer: rate limited." });
		const { model } = scripted();
		const throwing = { completeSimple: () => Promise.reject(new Error("offline")) };
		expect(await infer({ ...base, models: throwing, model })).toEqual({
			ok: false,
			why: "The model couldn't answer: offline.",
		});
		const hanging = {
			completeSimple: (_: unknown, __: unknown, options?: { signal?: AbortSignal }) =>
				new Promise<never>((_resolve, reject) =>
					options?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
				),
		};
		expect(await infer({ ...base, models: hanging, model, deadlineMs: 30 })).toEqual({
			ok: false,
			why: "It took too long. Try again.",
		});
		const stop = new AbortController();
		const stopping = infer({ ...base, models: hanging, model, signal: stop.signal });
		stop.abort();
		expect(await stopping).toEqual({ ok: false, why: "Stopped." });
	});

	it("runs a few at once, refuses another as busy, and frees each slot as one ends", async () => {
		const { model } = scripted();
		const release: (() => void)[] = [];
		const slow = {
			completeSimple: () =>
				new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) =>
					release.push(() => resolve(fauxAssistantMessage("4"))),
				),
		};
		const running = Array.from({ length: INFERENCES }, () => infer({ ...base, models: slow as never, model }));
		expect(await infer({ ...base, models: slow as never, model })).toMatchObject({
			ok: false,
			why: expect.stringContaining("busy"),
		});
		for (const done of release) done();
		for (const one of await Promise.all(running)) expect(one).toEqual({ ok: true, value: 4 });
		expect(await infer({ ...base, ...scripted(fauxAssistantMessage("4")) })).toEqual({ ok: true, value: 4 });
	});

	it("records every attempt of a retried inference", async () => {
		const harness = await store();
		try {
			const fixed = scripted(fauxAssistantMessage("four"), fauxAssistantMessage("4"));
			const record = usageRecorder(harness, "inference.face");
			expect(await infer({ ...base, ...fixed, record, attempts: 2 })).toEqual({ ok: true, value: 4 });
			const key = `${fixed.model.provider}/${fixed.model.id}`;
			expect((await harness.snapshot(SystemUsage, context))?.systems["inference.face"]?.[key]).toMatchObject({
				requests: 2,
				unreported: 0,
			});
		} finally {
			await harness.close(context);
		}
	});

	it("records an attempt that failed, as a request that reported nothing", async () => {
		const harness = await store();
		try {
			const { model } = scripted();
			const throwing = { completeSimple: () => Promise.reject(new Error("offline")) };
			const record = usageRecorder(harness, "inference.face");
			expect(await infer({ ...base, models: throwing, model, record })).toMatchObject({ ok: false });
			const failed = scripted(fauxAssistantMessage("", { stopReason: "error", errorMessage: "rate limited" }));
			expect(await infer({ ...base, ...failed, record })).toMatchObject({ ok: false });
			const line = (await harness.snapshot(SystemUsage, context))?.systems["inference.face"]?.[
				`${model.provider}/${model.id}`
			];
			expect(line).toMatchObject({ requests: 2, unreported: 1 });
		} finally {
			await harness.close(context);
		}
	});

	it("still answers when the record fails, and says so in the log", async () => {
		const lines: string[] = [];
		const broken = { commit: () => Promise.reject(new Error("store gone")) } as never;
		const record = usageRecorder(broken, "inference.face", (line) => lines.push(line));
		expect(await infer({ ...base, ...scripted(fauxAssistantMessage("4")), record })).toEqual({ ok: true, value: 4 });
		expect(lines).toEqual([expect.stringContaining("store gone")]);
	});

	it("finds a JSON object in an answer", () => {
		expect(answerJson('Here:\n```json\n{"a":{"b":1}}\n```')).toBe('{"a":{"b":1}}');
		expect(answerJson("nothing")).toBeUndefined();
		expect(answerJson("} backwards {")).toBeUndefined();
	});
});
