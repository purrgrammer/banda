import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentFileView, AgentView } from "../../../src/server/api.ts";
import { personalityDrafts } from "./personality-drafts.ts";

const file = (sha: string, text: string): AgentFileView => ({ sha, text });
const base = file("base", "Original");
const why = (error: unknown) => (error instanceof Error ? error.message : "Not saved");
const asText = (_agent: string, _file: AgentFileView, words: string) => words.trim();
const saved = (sha: string, text: string) => ({ file: file(sha, text), agents: [] as AgentView[] });
const observed = () => {};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("personality drafts", () => {
	it("keeps a local edit when another tab saves before its debounce, until the owner deliberately chooses it", async () => {
		const save = vi.fn(async () => saved("mine", "My words"));
		const registry = personalityDrafts(save, why, asText);
		const draft = registry.forAgent("reader", base, "Original", observed);
		draft.edit("My words");
		draft.receive(file("remote", "Their words"), "Their words");
		await vi.runAllTimersAsync();
		expect(save).not.toHaveBeenCalled();
		expect(draft.getSnapshot()).toMatchObject({ text: "My words", status: { kind: "failed" } });
		expect(draft.getSnapshot().latest.text).toBe("Their words");
		draft.chooseMine("remote");
		await vi.runAllTimersAsync();
		expect(save).toHaveBeenCalledWith("reader", file("remote", "Their words"), "My words");
		expect(draft.getSnapshot().status.kind).toBe("clean");
	});

	it("refuses a deliberate replacement if the saved version changed after the owner reviewed it", async () => {
		const save = vi.fn();
		const draft = personalityDrafts(save, why, asText).forAgent("reader", base, "Original", observed);
		draft.edit("My words");
		draft.receive(file("reviewed", "Their first words"), "Their first words");
		draft.receive(file("newer", "Their newer words"), "Their newer words");
		draft.chooseMine("reviewed");
		await vi.runAllTimersAsync();
		expect(save).not.toHaveBeenCalled();
		expect(draft.getSnapshot()).toMatchObject({ text: "My words", status: { kind: "failed" } });
	});

	it("serializes typing during a save against its own acknowledged revision, including a streamed acknowledgment", async () => {
		let finish: (value: ReturnType<typeof saved>) => void = () => {};
		const first = new Promise<ReturnType<typeof saved>>((resolve) => {
			finish = resolve;
		});
		const save = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(saved("two", "Second"));
		const draft = personalityDrafts(save, why, asText).forAgent("reader", base, "Original", observed);
		draft.edit(" First ");
		await vi.advanceTimersByTimeAsync(800);
		draft.edit("Second");
		draft.receive(file("one", "First"), "First");
		finish(saved("one", "First"));
		await vi.runAllTimersAsync();
		expect(save.mock.calls).toEqual([
			["reader", base, " First "],
			["reader", file("one", "First"), "Second"],
		]);
		expect(draft.getSnapshot()).toMatchObject({ text: "Second", status: { kind: "clean" } });
	});

	it("keeps failed text and its original base through navigation and retries", async () => {
		const save = vi.fn().mockRejectedValueOnce(new Error("Conflict")).mockResolvedValueOnce(saved("mine", "Keep me"));
		const registry = personalityDrafts(save, why, asText);
		const draft = registry.forAgent("reader", base, "Original", observed);
		draft.edit("Keep me");
		await vi.runAllTimersAsync();
		const reopened = registry.forAgent("reader", file("new", "New"), "New", observed);
		expect(reopened.getSnapshot()).toMatchObject({ text: "Keep me", base: { file: base }, status: { kind: "failed" } });
		reopened.retry();
		await vi.runAllTimersAsync();
		expect(save).toHaveBeenLastCalledWith("reader", base, "Keep me");
	});

	it("refreshes an untouched field without making an owner edit", () => {
		const save = vi.fn();
		const draft = personalityDrafts(save, why, asText).forAgent("reader", base, "Original", observed);
		draft.receive(file("new", "New words"), "New words");
		expect(draft.getSnapshot()).toMatchObject({ text: "New words", base: { file: { sha: "new" } } });
		expect(save).not.toHaveBeenCalled();
	});

	it("does not treat another field changed alongside matching personality words as its own acknowledgment", async () => {
		let finish: (value: ReturnType<typeof saved>) => void = () => {};
		const save = vi.fn(
			() =>
				new Promise<ReturnType<typeof saved>>((resolve) => {
					finish = resolve;
				}),
		);
		const draft = personalityDrafts(save, why, asText).forAgent("reader", base, "Original", observed);
		draft.edit("My words");
		await vi.advanceTimersByTimeAsync(800);
		draft.receive(file("remote", "My words plus another changed field"), "My words");
		finish(saved("mine", "My words"));
		await vi.runAllTimersAsync();
		expect(draft.getSnapshot()).toMatchObject({
			text: "My words",
			latest: { file: { sha: "remote" } },
			status: { kind: "failed" },
		});
	});
});
