/** The API's shapes for devices: the owner's phones and computers that reach the daemon over Iroh. Re-exported by `../api.ts`. */
import type { PairingState } from "../../core/devices.ts";

export type { PairingState };

/**
 * Where remote reach stands on this computer: `off` by the config; `unavailable`, Iroh's native addon does not load
 * here; `idle`, on but not bound, since no device is paired and no invite was made since the daemon started; `on`,
 * bound. Reach through n0 binds a public endpoint, so it waits until there is a device to reach it.
 */
export type RemoteState = "off" | "unavailable" | "idle" | "on";

/** A paired device, as the owner's list shows it. `revoked` devices stay listed, refused. */
export type DeviceView = {
	/** Its Iroh endpoint id: 64 hex characters. */
	readonly id: string;
	readonly name: string;
	/** When the owner approved it. */
	readonly paired: number;
	readonly revoked?: number;
	/** It holds a connection to the daemon now. */
	readonly connected: boolean;
};

/** An endpoint asking to be paired, until the owner approves or denies it, or `expires` passes. */
export type PairingRequestView = {
	readonly id: string;
	/** The name it asked for. */
	readonly name: string;
	readonly at: number;
	readonly expires: number;
};

/**
 * `GET /api/devices`, and the `devices` shell event: where remote reach stands, the daemon's own endpoint (null until
 * it is bound), the devices paired, newest first, and the requests waiting, oldest first.
 */
export type DevicesView = {
	readonly remote: RemoteState;
	readonly endpoint: { readonly id: string; readonly reach: "n0" | "loopback" } | null;
	readonly devices: readonly DeviceView[];
	readonly requests: readonly PairingRequestView[];
};

/**
 * `POST /api/devices/invites`: a new invite, single use, live until `expires`. `pairing` is what the QR code carries:
 * `banda://pair?ticket=<ticket>&invite=<secret>`, the daemon's endpoint ticket (its id and how to reach it) and the
 * secret the device presents. The secret is shown once and never stored.
 */
export type InviteView = {
	readonly secret: string;
	readonly ticket: string;
	readonly expires: number;
	readonly pairing: string;
};

/** `GET` and `POST /api/devices/pair`, over Iroh: where the calling endpoint stands. */
export type PairingView = { readonly state: PairingState };

/** The devices, pushed on the shell stream whenever they change. */
export type DevicesShellEvent = { readonly type: "devices"; readonly devices: DevicesView };
