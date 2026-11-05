/** The enlarged browser's control lifecycle. A close waits for pending take-over and acknowledged hand-back. */
import type { BrowserView } from "../../../src/server/api.ts";

type BrowserEffects = {
	current: () => BrowserView | undefined;
	hold: (hold: boolean) => Promise<BrowserView>;
	show: (view: BrowserView) => void;
	hide: () => void;
};

export class BrowserSession {
	private tail: Promise<void> = Promise.resolve();
	private closing: Promise<void> | undefined;
	private closed = false;
	/** A failed take-over can still have reached the daemon; its lost reply is not proof that we did not take it. */
	private possiblyHeld = false;

	private readonly effects: BrowserEffects;

	constructor(effects: BrowserEffects) {
		this.effects = effects;
	}

	private enqueue(action: () => Promise<void>): Promise<void> {
		const next = this.tail.then(action);
		this.tail = next.catch(() => {});
		return next;
	}

	private async hold(hold: boolean): Promise<void> {
		if (hold) this.possiblyHeld = true;
		const view = await this.effects.hold(hold);
		this.possiblyHeld = view.running && view.control === "owner";
		this.effects.show(view);
	}

	control(hold: boolean): Promise<void> {
		if (this.closing !== undefined || this.closed) return Promise.reject(new Error("The browser view is closing."));
		return this.enqueue(() => this.hold(hold));
	}

	close(): Promise<void> {
		if (this.closed) return Promise.resolve();
		if (this.closing !== undefined) return this.closing;
		this.closing = this.enqueue(async () => {
			// Checked after pending controls settle, not when the owner first pressed Close.
			const view = this.effects.current();
			if (this.possiblyHeld || (view?.running === true && view.control === "owner")) {
				await this.hold(false);
				if (this.possiblyHeld) throw new Error("The browser has not been given back yet.");
			}
			this.closed = true;
			this.effects.hide();
		}).finally(() => {
			this.closing = undefined;
		});
		return this.closing;
	}
}
