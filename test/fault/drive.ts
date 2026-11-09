/**
 * The in-process driver: runs messages through the system under fault with thrown faults (`error`), reopening the
 * store whenever a storage fault failed it, as a supervisor restarting the daemon would.
 */
import { type Harness, SessionFailed } from "@earendil-works/pi-durable";
import type { Inbound } from "../../src/core/gateway.ts";
import { context } from "../../src/core/store.ts";
import type { After } from "./arbitraries.ts";
import { type Faults, InjectedFault } from "./faults.ts";
import { banda, readSent, type Sent, type Summary, settle, summarize } from "./sut.ts";

export async function drive(
	home: string,
	messages: readonly Inbound[],
	after: readonly After[],
	faults: Faults,
): Promise<{ sent: Sent[]; summary: Summary }> {
	const s = banda(home, faults);
	let harness: Harness | undefined;
	const reopen = async () => {
		await harness?.close(context).catch(() => undefined);
		harness = undefined;
		for (;;) {
			try {
				harness = await s.open();
				return;
			} catch (error) {
				if (!(error instanceof InjectedFault)) throw error;
			}
		}
	};
	/** Run `step` until it gets through: a storage fault fails the store, which is reopened and the step retried. */
	const through = async <T>(step: (h: Harness) => Promise<T>): Promise<T> => {
		for (;;) {
			try {
				return await step(harness!);
			} catch (error) {
				if (!(error instanceof InjectedFault || error instanceof SessionFailed)) throw error;
				await reopen();
			}
		}
	};
	await reopen();
	for (const [i, message] of messages.entries()) {
		await through((h) => s.core.receive(h, message));
		if (after[i] === "redeliver") await through((h) => s.core.receive(h, message));
		if (after[i] === "restart") await reopen();
	}
	await through((h) => settle(h, messages));
	const summary = await through((h) => summarize(h, messages));
	await harness!.close(context);
	return { sent: readSent(home), summary };
}
