/**
 * The local notification for an open ask (DESIGN.md "The app"): on the desktop, when an agent starts waiting on the
 * owner while banda is not in front, the device says so; a routine's message only badges. Needs no vendor: the
 * browser's own notifications, allowed per device, and the owner's choice kept on this device.
 */
import { useEffect, useRef, useState } from "react";
import type { BandRow } from "./band.ts";

const KEY = "banda.notify";

export type NotifyState = "on" | "off" | "blocked";

function stateNow(): NotifyState | undefined {
	if (typeof Notification === "undefined") return undefined;
	if (Notification.permission === "denied") return "blocked";
	let wanted: string | null = null;
	try {
		wanted = localStorage.getItem(KEY);
	} catch {}
	return Notification.permission === "granted" && wanted !== "off" ? "on" : "off";
}

/** Whether this device notifies, and a way to turn it on (asking the browser) or off. */
export function useNotify(): [NotifyState | undefined, (on: boolean) => void] {
	const [state, setState] = useState(stateNow);
	const set = (on: boolean) => {
		try {
			localStorage.setItem(KEY, on ? "on" : "off");
		} catch {}
		if (on && Notification.permission === "default")
			void Notification.requestPermission().then(() => setState(stateNow()));
		else setState(stateNow());
	};
	return [state, set];
}

/** Notify for each ask that opened since the band was last seen, while the page is hidden or not focused. */
export function useAskNotifications(rows: readonly BandRow[], on: boolean, open: (row: BandRow) => void) {
	const seen = useRef<Map<string, string> | undefined>(undefined);
	useEffect(() => {
		const asks = new Map(rows.flatMap((row) => (row.ask === undefined ? [] : [[row.id, row.ask] as const])));
		const before = seen.current;
		seen.current = asks;
		// the first look only learns what is open already
		if (before === undefined || !on || (document.visibilityState === "visible" && document.hasFocus())) return;
		for (const [id, ask] of asks) {
			if (before.get(id) === ask) continue;
			const row = rows.find((each) => each.id === id);
			if (row === undefined) continue;
			const notice = new Notification(`${row.name} is waiting on you`, { body: ask, tag: id });
			notice.onclick = () => {
				window.focus();
				open(row);
				notice.close();
			};
		}
	}, [rows, on, open]);
}
