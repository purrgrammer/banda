import { type ReactNode, useContext, useState } from "react";
import type { DevicesView } from "../../../src/server/api.ts";
import { DevicesSettings, type ShownInvite } from "../chat/Devices.tsx";
import { SettingsPage } from "../chat/Settings.tsx";
import { QrCode } from "../components/QrCode.tsx";
import { Section, StageContext } from "./stage.tsx";

const NOW = Date.UTC(2026, 10, 5, 17, 0);
const ENDPOINT = { id: "5f3c9a1be27d48c0a6f1e93b7d20c4a85e6f1b2c3d4e5f60718293a4b5c6d7e8", reach: "n0" } as const;
const PIXEL = "a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f809";
const IPAD = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";
const OLD = "9e8d7c6b5a4938271605f4e3d2c1b0a99e8d7c6b5a4938271605f4e3d2c1b0a9";
const INVITE: ShownInvite = {
	pairing: `banda://pair?ticket=${"endpointa".repeat(12)}&invite=Qm9va3NBbmRUZWFfc2VjcmV0X2ludml0ZQ`,
	expires: NOW + 9 * 60_000 + 41_000,
};

const NONE: DevicesView = { endpoint: ENDPOINT, devices: [], requests: [] };
const ASKING: DevicesView = {
	endpoint: ENDPOINT,
	devices: [],
	requests: [{ id: PIXEL, name: "Pixel 9", at: NOW - 20_000, expires: INVITE.expires }],
};
const PAIRED: DevicesView = {
	endpoint: ENDPOINT,
	devices: [
		{ id: PIXEL, name: "Ana's phone", paired: NOW - 60_000, connected: true },
		{ id: IPAD, name: "Kitchen iPad", paired: NOW - 9 * 86_400_000, connected: false },
		{ id: OLD, name: "Old phone", paired: NOW - 40 * 86_400_000, revoked: NOW - 3 * 86_400_000, connected: false },
	],
	requests: [],
};

/** Pairing as the owner sees it, end to end: pair, a phone asks, approve; rename and revoke. */
function Example() {
	const [view, setView] = useState<DevicesView>(NONE);
	const [invite, setInvite] = useState<ShownInvite | undefined>(undefined);
	return (
		<DevicesSettings
			devices={view}
			invite={invite}
			onPair={() => {
				setInvite({ ...INVITE, expires: Date.now() + 10 * 60_000 });
				// a phone scans it a moment later
				setTimeout(
					() =>
						setView((was) => ({
							...was,
							requests: [{ id: PIXEL, name: "Pixel 9", at: Date.now(), expires: Date.now() + 9 * 60_000 }],
						})),
					2500,
				);
			}}
			onCancel={() => setInvite(undefined)}
			onApprove={(id, name) => {
				setInvite(undefined);
				setView((was) => ({
					...was,
					requests: [],
					devices: [{ id, name, paired: Date.now(), connected: true }, ...was.devices.filter((d) => d.id !== id)],
				}));
			}}
			onDeny={() => {
				setInvite(undefined);
				setView((was) => ({ ...was, requests: [] }));
			}}
			onRename={(id, name) =>
				setView((was) => ({ ...was, devices: was.devices.map((d) => (d.id === id ? { ...d, name } : d)) }))
			}
			onRevoke={(id) =>
				setView((was) => ({
					...was,
					devices: was.devices.map((d) => (d.id === id ? { ...d, revoked: Date.now(), connected: false } : d)),
				}))
			}
		/>
	);
}

export function DevicesSection() {
	const phone = useContext(StageContext).width === "phone";
	const frame = (children: ReactNode) => (
		<div className="overflow-hidden rounded-tile border border-line-soft">
			<SettingsPage title="Settings" phone={phone}>
				{children}
			</SettingsPage>
		</div>
	);
	return (
		<>
			<Section
				id="devices"
				title="Settings, devices"
				note="Interactive: Pair a phone shows a code; a phone asks a moment later; Approve pairs it. Rename in place; Revoke asks first. Endpoint ids and the link stay behind Details."
			>
				{frame(<Example />)}
			</Section>
			<Section
				id="devices-states"
				title="Devices, each state"
				note="Nothing paired; the code, live and counting down; a phone asking; the code expired; devices connected, idle and revoked; reach off on this computer; Details open."
			>
				{frame(<DevicesSettings devices={NONE} now={NOW} />)}
				{frame(<DevicesSettings devices={NONE} invite={INVITE} now={NOW} />)}
				{frame(<DevicesSettings devices={ASKING} invite={INVITE} now={NOW} />)}
				{frame(<DevicesSettings devices={NONE} invite={{ ...INVITE, expires: NOW - 1 }} now={NOW} />)}
				{frame(<DevicesSettings devices={PAIRED} now={NOW} />)}
				{frame(<DevicesSettings devices={{ endpoint: null, devices: [], requests: [] }} now={NOW} />)}
				{frame(<DevicesSettings devices={PAIRED} invite={INVITE} now={NOW} details />)}
				{frame(<DevicesSettings devices={undefined} />)}
			</Section>
			<Section id="qr" title="QR code" note="Dark on a light tile in either theme, so any phone's camera reads it.">
				<QrCode value={INVITE.pairing} label="A pairing code" className="size-44 p-1.5" />
			</Section>
		</>
	);
}
