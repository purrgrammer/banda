/**
 * Settings' devices, live: the devices and the requests waiting, from the daemon and its `devices` events. The invite
 * on screen is this page's alone (its secret is shown once and kept nowhere): it goes once a request it brought is
 * answered, or the owner cancels it.
 */
import { useState } from "react";
import { toast } from "sonner";
import { approveDevice, denyDevice, makeInvite, renameDevice, revokeDevice, useDevices } from "../areas/devices.ts";
import { DevicesSettings, type ShownInvite } from "../chat/Devices.tsx";
import { attempt } from "../lib/attempt.ts";

export function SettingsDevices() {
	const devices = useDevices();
	const [invite, setInvite] = useState<ShownInvite | undefined>(undefined);
	const [making, setMaking] = useState(false);
	return (
		<DevicesSettings
			devices={devices}
			invite={invite}
			making={making}
			onPair={() => {
				setMaking(true);
				void attempt("make a code to pair a phone", makeInvite)
					.then((made) => {
						if (made !== undefined) setInvite({ pairing: made.pairing, expires: made.expires });
					})
					.finally(() => setMaking(false));
			}}
			onCancel={() => setInvite(undefined)}
			onApprove={(id, name) =>
				void attempt("approve the phone", () => approveDevice(id, name)).then((view) => {
					if (view === undefined) return;
					// the invite is spent with its request
					setInvite(undefined);
					toast.success(`${view.devices.find((each) => each.id === id)?.name ?? name} is paired`);
				})
			}
			onDeny={(id) =>
				void attempt("deny the phone", () => denyDevice(id)).then((view) => {
					if (view !== undefined) setInvite(undefined);
				})
			}
			onRename={(id, name) => void attempt("rename the device", () => renameDevice(id, name))}
			onRevoke={(id) => void attempt("revoke the device", () => revokeDevice(id))}
		/>
	);
}
