/**
 * The band's own file in the app: what is pinned to the top of the band, read when the band first shows and kept live
 * by the `band` shell event; and the owner's pin and unpin and the tiles' alignment, shown at once and answered with
 * the band as it is after.
 * A pin names an agent by its id or a group as `group:<room>`; the band's rows are `a:<id>` and `g:<room>`.
 */
import { useMemo, useSyncExternalStore } from "react";
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

const FIRST: BandView = { pinned: ["sancho"], centred: false };

/**
 * The band as the app shows it, once read (a band with no file until then): the pinned rows in order, and whether
 * their tiles are centred.
 */
export function useBand(): { readonly pinned: readonly string[]; readonly centred: boolean } {
	const view = useSyncExternalStore(subscribe, () => band) ?? FIRST;
	const pinned = useMemo(() => view.pinned.map(rowOfPin), [view.pinned]);
	return { pinned, centred: view.centred };
}

/** Change the band at once and send it; put back if banda refuses. */
function send(next: BandView, what: string, path: string, body: object): void {
	const before = band ?? FIRST;
	showBand(next);
	void attempt(what, async () => {
		try {
			showBand(await api<BandView>(path, { method: "POST", body: JSON.stringify(body) }));
		} catch (error) {
			showBand(before);
			throw error;
		}
	});
}

/** Pin a row (to the end of the row of tiles) or unpin it. */
export function pinRow(row: string, on: boolean): void {
	const now = band ?? FIRST;
	const pin = pinOfRow(row);
	const pinned = [...now.pinned.filter((each) => each !== pin), ...(on ? [pin] : [])];
	send({ ...now, pinned }, on ? "pin it" : "unpin it", "/band/pin", { pin, on });
}

/** Centre the pinned tiles or not (Settings, Appearance). */
export function centreBand(centred: boolean): void {
	send({ ...(band ?? FIRST), centred }, "change the band", "/band", { centred });
}
