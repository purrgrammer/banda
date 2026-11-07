/**
 * The band's own file in the app: what is pinned to the top of the band, read when the band first shows and kept live
 * by the `band` shell event; and the owner's pin and unpin, shown at once and answered with the pins as they are after.
 * A pin names an agent by its id or a group as `group:<room>`; the band's rows are `a:<id>` and `g:<room>`.
 */
import { useSyncExternalStore } from "react";
import { api, type BandView } from "../lib/api.ts";
import { attempt } from "../lib/attempt.ts";
import type { ShellHandlers } from "../lib/shell.ts";

let band: BandView | undefined;
const listeners = new Set<() => void>();

function showBand(next: BandView): void {
	band = next;
	for (const listener of listeners) listener();
}

export const shell: ShellHandlers = {
	band: (event) => {
		showBand(event.band);
		return {};
	},
};

function subscribe(listener: () => void) {
	listeners.add(listener);
	if (listeners.size === 1) void api<BandView>("/band").then(showBand, () => {});
	return () => listeners.delete(listener);
}

/** The band's row for a pin, and the pin for a row: `sancho` is `a:sancho`, `group:3` is `g:3`. */
export const rowOfPin = (pin: string): string => (pin.startsWith("group:") ? `g:${pin.slice(6)}` : `a:${pin}`);
export const pinOfRow = (row: string): string => (row.startsWith("g:") ? `group:${row.slice(2)}` : row.slice(2));

/** The pinned rows, in order, once read; Sancho's until then, as a band with no file pins. */
export function usePinnedRows(): readonly string[] {
	const view = useSyncExternalStore(subscribe, () => band);
	return (view?.pinned ?? ["sancho"]).map(rowOfPin);
}

/** Pin a row (to the end of the row of tiles) or unpin it: shown at once, put back if banda refuses. */
export function pinRow(row: string, on: boolean): void {
	const before = band ?? { pinned: ["sancho"] };
	const pin = pinOfRow(row);
	showBand({ pinned: [...before.pinned.filter((each) => each !== pin), ...(on ? [pin] : [])] });
	void attempt(on ? "pin it" : "unpin it", async () => {
		try {
			showBand(await api<BandView>("/band/pin", { method: "POST", body: JSON.stringify({ pin, on }) }));
		} catch (error) {
			showBand(before);
			throw error;
		}
	});
}
