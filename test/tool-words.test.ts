import { expect, it } from "vitest";
import { readOn } from "../src/core/objects.ts";
import { definition, refusal, shippedText } from "./fixtures/shipped.ts";

const gmail = definition("gmail");

it("a definition may word its tools, each in a few words; a tool with none goes by its name", () => {
	const value = JSON.parse(shippedText("gmail"));
	const worded = definition(
		"gmail",
		JSON.stringify({ ...value, words: { get_thread: "Read a conversation", send_message: "Send an email" } }),
	);
	expect(worded.words).toEqual({ get_thread: "Read a conversation", send_message: "Send an email" });
	expect(gmail.words).toBeUndefined();
	expect(
		refusal("gmail", (each) => {
			(each as { words?: unknown }).words = { get_thread: "" };
		}),
	).not.toBe("");
});

it("an approval for a read draws the object it names, and leaves the other arguments listed", () => {
	const args = { thread_id: "18c0ffee", format: "full" };
	expect(readOn("gmail", "get_thread", args, gmail.objects ?? {})).toEqual({
		ref: { connection: "gmail", kind: "thread", values: { id: "18c0ffee" } },
		args: ["thread_id"],
	});
	expect(readOn("gmail", "get_thread", { format: "full" }, gmail.objects ?? {})).toBeUndefined();
	expect(readOn("gmail", "send_message", args, gmail.objects ?? {})).toBeUndefined();
});
