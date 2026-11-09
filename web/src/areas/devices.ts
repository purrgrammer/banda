/**
 * Devices in the app: the owner's phones that reach banda over Iroh. The devices and the requests waiting, read when a
 * page that shows them opens and kept live by the `devices` shell event; and the owner's calls: make an invite,
 * approve or deny a request, rename or revoke a device. Each call answers the devices as they are after.
 */
import { useSyncExternalStore } from "react";
import { api, type DevicesView, type InviteView } from "../lib/api.ts";
import type { ShellHandlers } from "../lib/shell.ts";

let devices: DevicesView | undefined;
const listeners = new Set<() => void>();

/** Take the devices as an answer or the stream says them. */
export function showDevices(next: DevicesView): void {
	devices = next;
	for (const listener of listeners) listener();
}

export const shell: ShellHandlers = {
	devices: (event) => {
		showDevices(event.devices);
		return {};
	},
};

function subscribe(listener: () => void) {
	listeners.add(listener);
	// read when something shows them: the stream says them on every change, and this covers the first look
	if (listeners.size === 1) void api<DevicesView>("/devices").then(showDevices, () => {});
	return () => listeners.delete(listener);
}

/** The devices and the requests waiting, once read. */
export function useDevices(): DevicesView | undefined {
	return useSyncExternalStore(subscribe, () => devices);
}

const answered = async (call: Promise<DevicesView>) => {
	const view = await call;
	showDevices(view);
	return view;
};

/** A new invite: single use, live for ten minutes; its pairing link is what the QR code carries. */
export const makeInvite = () => api<InviteView>("/devices/invites", { method: "POST" });

/** Let the device asking pair, under `name` if the owner changed it. */
export const approveDevice = (id: string, name?: string) =>
	answered(
		api<DevicesView>(`/devices/requests/${id}/approve`, {
			method: "POST",
			body: JSON.stringify(name === undefined ? {} : { name }),
		}),
	);

export const denyDevice = (id: string) =>
	answered(api<DevicesView>(`/devices/requests/${id}/deny`, { method: "POST" }));

export const renameDevice = (id: string, name: string) =>
	answered(api<DevicesView>(`/devices/${id}`, { method: "PUT", body: JSON.stringify({ name }) }));

/** Revoke a device: its open connections close, and it reaches banda no more. */
export const revokeDevice = (id: string) => answered(api<DevicesView>(`/devices/${id}/revoke`, { method: "POST" }));
